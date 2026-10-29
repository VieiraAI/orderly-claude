import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { readRecords } from './jsonl.mjs';
import { buildSession } from './steps.mjs';
import { buildFileHistory } from './filehistory.mjs';
import { detectDevServer, captureFor, comparePair } from './capture.mjs';
import { loadShots, saveShots, shotsDiffer } from './shots.mjs';
import { shouldCapture, readComparison } from './visual.mjs';

/**
 * Tails one session transcript and keeps a live model of it.
 *
 * Before/after screenshots chain: the shot taken after step N becomes the
 * "before" of step N+1. That way a true before image exists without having to
 * know in advance that a step was about to start.
 */
export class SessionWatcher extends EventEmitter {
  constructor(file, {
    sessionId, capture = true, pollMs = 700, projectDir = null,
    selfPort = null, origin = null,
  } = {}) {
    super();
    this.file = file;
    this.sessionId = sessionId;
    this.capture = capture;
    this.projectDir = projectDir;
    // Our own port, so this viewer is never mistaken for the app under work,
    // and our own origin, which the pixel comparison runs on.
    this.selfPort = selfPort;
    this.origin = origin;
    // stepId -> why no picture was taken, so the panel can say so plainly.
    this.captureSkips = {};
    this.pinnedUrl = null;
    this.pollMs = pollMs;
    this.records = [];
    this.offset = 0;
    this.session = null;
    this.history = new Map();
    this.shots = loadShots(sessionId); // stepId -> { before, after }, restored from disk
    this.lastShot = null;        // most recent screenshot, the next step's "before"
    this.devUrl = null;
    this.capturing = false;
    this.seenSteps = new Set();
    this.timer = null;
    this.lastGrowthAt = Date.now();
    this.unread = 0;
    this.focused = false;
    this.captureQueue = [];
    // Long enough for a dev server to rebuild before the picture is taken.
    this.settleMs = 1200;
  }

  async start() {
    this.read();
    if (this.capture) {
      this.devUrl = await detectDevServer(this.projectDir, { selfPort: this.selfPort });
      if (this.devUrl) {
        this.emit('log', `watching ${this.devUrl} for visual before/after`);
        this.lastShot = await captureFor(this.sessionId, 'baseline', 'after', this.devUrl);
      }
      this.rescanTimer = setInterval(() => {
        this.rescanDev().catch((e) => this.emit('log', `dev scan failed: ${e.message}`));
      }, 20000);
    }
    this.markSeen();
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.emit('log', `read failed: ${e.message}`));
    }, this.pollMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.rescanTimer);
  }

  /** Follow a different transcript, keeping the same poll loop and capture state. */
  repoint(file, sessionId) {
    this.file = file;
    this.sessionId = sessionId;
    this.offset = 0;
    this.records = [];
    this.session = null;
    this.shots = loadShots(sessionId);
    this.seenSteps = new Set();
    this.read();
    this.markSeen();
    this.emit('update', { repointed: sessionId });
  }

  /** Only the tab being looked at takes screenshots; one browser, one target. */
  async setCapture(on) {
    this.capture = on;
    if (!on) { this.devUrl = null; return; }
    if (!this.devUrl) this.devUrl = this.pinnedUrl || await detectDevServer(this.projectDir, { selfPort: this.selfPort });
  }

  /** Point captures at a chosen URL, and stop rescanning away from it. */
  pinCaptureUrl(url) {
    this.pinnedUrl = url || null;
    this.devUrl = url || null;
    this.lastShot = null; // the next shot starts a fresh before/after chain
    this.emit('log', url ? `capturing ${url}` : 'capture target cleared');
  }

  /**
   * Re-check periodically and move to a better match, not only when the
   * current target dies — a dev server started after us should be picked up.
   */
  async rescanDev() {
    if (this.pinnedUrl) return;
    const found = await detectDevServer(this.projectDir, { selfPort: this.selfPort });
    if (found === this.devUrl) return;

    if (this.devUrl && !found) {
      try {
        const res = await fetch(this.devUrl, { signal: AbortSignal.timeout(400) });
        if (res.status < 500) return; // still serving; keep it
      } catch { /* gone */ }
    }
    this.devUrl = found;
    this.lastShot = null; // a new target starts a fresh before/after chain
    this.emit('log', found ? `capturing ${found}` : 'no dev server found');
  }

  read() {
    let records = [];
    let nextOffset = this.offset;
    try { ({ records, nextOffset } = readRecords(this.file, this.offset)); }
    catch (e) { this.emit('log', `transcript unreadable: ${e.message}`); return false; }
    if (!records.length && this.session) return false;
    this.records.push(...records);
    if (records.length) this.lastGrowthAt = Date.now();
    this.offset = nextOffset;
    this.session = buildSession(this.records, { live: true });
    this.history = buildFileHistory(this.records);
    this.attachShots();
    return true;
  }

  attachShots() {
    for (const t of this.session.turns) {
      for (const s of t.steps) {
        s.shots = this.shots[s.id] || null;
        // Why there is no picture matters as much as the picture: "a test"
        // is an answer, an empty panel is not.
        s.noCapture = s.shots ? null : (this.captureSkips[s.id] || null);
      }
    }
  }

  markSeen() {
    for (const t of this.session?.turns || []) for (const s of t.steps) this.seenSteps.add(s.id);
  }

  allSteps() {
    return (this.session?.turns || []).flatMap((t) => t.steps);
  }

  /**
   * Whether Claude is working right now.
   *
   * A tool call and its result are written to the transcript together, once
   * the tool has finished — so an unfinished call is invisible and "a
   * tool_use with no result" never fires. What does get written the moment
   * Claude starts thinking is an `api-request`. If the newest one of those
   * is newer than the newest thing Claude has said or received, a request is
   * in flight and Claude is working.
   */
  activity() {
    let lastRequest = 0;
    let lastOutput = 0;
    for (const r of this.records) {
      const t = Date.parse(r.timestamp || '') || 0;
      if (!t) continue;
      if (r.type === 'api-request') lastRequest = Math.max(lastRequest, t);
      else if (r.type === 'assistant' || r.type === 'user') lastOutput = Math.max(lastOutput, t);
    }

    const requestPending = lastRequest > 0 && lastRequest > lastOutput;
    // Rare, but when a call is caught mid-flight it names the step.
    const running = this.allSteps().find((s) => s.status === 'running');
    // Judge staleness by what the records say, not by when the file last
    // grew; growth can be unrelated writes.
    const newest = Math.max(lastRequest, lastOutput) || this.lastGrowthAt;
    const quietMs = Date.now() - newest;

    return {
      working: (requestPending || !!running) && quietMs < 15 * 60 * 1000,
      inFlight: !!running,
      step: running?.label || null,
      quietMs,
      since: lastRequest ? new Date(lastRequest).toISOString() : null,
    };
  }

  async tick() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size === this.offset) return;

    this.read();
    const fresh = this.allSteps().filter((s) => !this.seenSteps.has(s.id));
    if (!fresh.length) { this.emit('update', { quiet: true }); return; }

    for (const s of fresh) this.seenSteps.add(s.id);
    if (!this.focused) this.unread += fresh.length;
    this.emit('update', { newSteps: fresh.map((s) => s.id), sessionId: this.sessionId });

    // Every change that could have altered the picture gets its own pair.
    // Photographing the rest produced pairs that showed nothing and buried
    // the ones that did.
    for (const s of fresh) {
      if (s.status === 'failed') continue;
      // Deciding must never cost a step. If the rule throws, fall back to the
      // old behaviour — photograph the change — rather than skip it silently.
      let verdict;
      try {
        verdict = shouldCapture(s, {
          projectDir: this.projectDir,
          devUrl: this.devUrl,
          selfPort: this.selfPort,
        });
      } catch (e) {
        this.emit('log', `capture rule failed: ${e.message}`);
        verdict = { capture: s.kind === 'change' };
      }
      if (verdict.capture) this.enqueueCapture(s);
      else this.captureSkips[s.id] = verdict.reason;
    }
    this.attachShots();
  }

  /**
   * Queue a capture rather than drop it.
   *
   * Dropping while another was in flight left most steps with no shot at all,
   * and the chain then paired a change against a picture from long before it.
   * A burst is trimmed to the most recent few so a flurry of edits cannot put
   * the camera minutes behind the work.
   */
  enqueueCapture(step) {
    if (!this.capture) return;
    this.captureQueue.push(step);
    if (this.captureQueue.length > 3) {
      this.captureQueue.splice(0, this.captureQueue.length - 3);
    }
    this.drainCaptures().catch((e) => this.emit('log', `capture failed: ${e.message}`));
  }

  async drainCaptures() {
    if (this.capturing) return;
    this.capturing = true;
    try {
      while (this.captureQueue.length && this.devUrl) {
        await this.captureStep(this.captureQueue.shift());
      }
    } finally {
      this.capturing = false;
    }
  }

  /** One pair: the previous shot, and this step's, taken once a rebuild lands. */
  async captureStep(step) {
    try {
      // A dev server rebuilds after the edit. Shooting the instant the step
      // appears photographed the old page, so the pair looked unchanged.
      await new Promise((r) => setTimeout(r, this.settleMs));
      const after = await captureFor(this.sessionId, step.id, 'after', this.devUrl);
      if (after) {
        const before = this.lastShot || null;
        const spanMs = before ? Date.parse(after.at) - Date.parse(before.at) : 0;

        // Count pixels rather than bytes, and keep where they moved so the
        // panel can show the part that changed instead of the whole page.
        let diff = null;
        if (before && this.origin) {
          const raw = await comparePair(this.origin, before.file, after.file);
          if (raw) diff = readComparison(raw);
        }

        this.shots[step.id] = {
          before,
          after,
          // Fall back to the byte check only when pixels could not be read,
          // so a failed comparison is never reported as "no change".
          changed: diff ? diff.changed : shotsDiffer(before, after),
          ratio: diff?.ratio ?? null,
          percent: diff?.percent ?? null,
          box: diff?.box ?? null,
          wholePage: diff?.wholePage ?? false,
          compared: !!diff,
          // How much work sits between the two pictures, so the panel can say
          // when a pair covers more than the one step.
          spanMs: spanMs > 0 ? spanMs : 0,
        };
        saveShots(this.sessionId, this.shots);
        this.lastShot = after;
        this.attachShots();
        this.emit('update', { shot: step.id });
      }
    } catch (e) {
      // One failed shot must not end the drain; the queue owns the lock.
      this.emit('log', `capture failed: ${e.message}`);
    }
  }
}
