import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../core/jsonl.mjs';
import { buildSession } from '../core/steps.mjs';
import { buildFileHistory } from '../core/filehistory.mjs';
import { stepChanges } from '../core/changes.mjs';
import { listSessions } from '../core/sessions.mjs';
import { listCommands } from '../core/commands.mjs';
import { listTerminals } from '../core/terminals.mjs';
import { indexSession, search } from '../core/search.mjs';
import { SessionWatcher } from '../core/watcher.mjs';
import { shutdownBrowser } from '../core/capture.mjs';
import { Runner } from '../core/runner.mjs';
import { SHOTS_DIR, INSTANCES_FILE, ensureDirs, transcriptPathFor, uploadsFor } from '../core/paths.mjs';
import { randomUUID } from 'node:crypto';
import { loadShots, attachShots } from '../core/shots.mjs';
import { listDefinitions, getDefinition, startRun, readRun, listRuns, runsForSession, deleteRun, rerunRun, scaffoldWorkflow, writeWorkflow, validateDefinition } from '../core/workflows.mjs';
import { Scheduler } from '../core/workflow-runner.mjs';
import { openBlob } from '../core/blobs.mjs';
import { listSkills } from '../core/skills.mjs';
import { listPrompts, getPrompt, interpolate, scaffoldPrompt, writePrompt, validatePrompt } from '../core/prompts.mjs';
import { listDecisions, markDecision, unmarkDecision } from '../core/decisions.mjs';
import { generateToken, verifyToken, exportSessionHtml, exportRunHtml, exportDecisionHtml } from '../core/share.mjs';

const WEB_DIR = path.resolve(fileURLToPath(new URL('../../web', import.meta.url)));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript',
  '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Loads and caches any session on disk for read-only browsing. */
const SEARCH_BYTE_CAP = 4 * 1024 * 1024;

class SessionStore {
  constructor() { this.cache = new Map(); this.indexes = new Map(); }

  /**
   * Search entries for one session, capped and cached against the file's
   * mtime, so a repeated search costs nothing and a huge transcript cannot
   * stall the request.
   */
  index(meta) {
    const key = `${meta.sessionId}:${meta.updatedAt}`;
    const hit = this.indexes.get(key);
    if (hit) return hit;
    const { records } = readRecords(meta.file, 0, SEARCH_BYTE_CAP);
    const entries = indexSession(buildSession(records, { live: false }),
      { sessionId: meta.sessionId, title: meta.title });
    this.indexes.set(key, entries);
    if (this.indexes.size > 80) this.indexes.delete(this.indexes.keys().next().value);
    return entries;
  }
  load(sessionId) {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId);
    const meta = listSessions().find((s) => s.sessionId === sessionId);
    if (!meta) return null;
    const { records } = readRecords(meta.file);
    const entry = {
      meta,
      records,
      session: attachShots(buildSession(records, { live: false }), loadShots(sessionId)),
      history: buildFileHistory(records),
    };
    this.cache.set(sessionId, entry);
    return entry;
  }
  invalidate(id) { this.cache.delete(id); }
}

function light(session) {
  return {
    ...session,
    turns: (session.turns || []).map((t) => ({
      ...t,
      steps: t.steps.map((s) => ({
        id: s.id, label: s.label, kind: s.kind, status: s.status,
        emergent: s.emergent, declaredLabel: s.declaredLabel, agent: s.agent,
        startedAt: s.startedAt, endedAt: s.endedAt,
        callCount: s.calls.length,
        fileCount: s.files.length,
        hasShots: !!(s.shots?.after),
        visualChanged: !!(s.shots?.changed),
        changedPercent: s.shots?.percent ?? null,
        noCapture: s.noCapture || null,
        needsUser: !!s.needsUser,
        userResolved: !!s.userResolved,
        hasThinking: (s.thinking || []).length > 0,
      })),
    })),
  };
}

let buildCache = { at: 0, id: '' };

/**
 * A stamp for the UI files on disk.
 *
 * A page loaded before an edit keeps running the old script, which looks
 * exactly like a bug that was never fixed. The client compares this and
 * reloads itself when it moves.
 */
function webBuildId() {
  const now = Date.now();
  if (now - buildCache.at < 1500) return buildCache.id;
  let newest = 0;
  try {
    for (const name of fs.readdirSync(WEB_DIR)) {
      const st = fs.statSync(path.join(WEB_DIR, name));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    }
  } catch { /* fall back to a stable id */ }
  buildCache = { at: now, id: String(Math.round(newest)) };
  return buildCache.id;
}

function personName(cwd) {
  const tries = [
    // The account's full name reads better than a git handle; macOS only.
    () => (process.platform === 'darwin'
      ? execFileSync('id', ['-F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : ''),
    () => execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  ];
  for (const attempt of tries) {
    try {
      const name = attempt().trim().replace(/\s+/g, ' ');
      if (name && name.includes(' ')) return name;
      if (name && !tries[1]) return name;
    } catch {}
  }
  try {
    const git = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git) return git;
  } catch {}
  return os.userInfo().username;
}

function readInstances() {
  try {
    const all = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    return all.filter((i) => { try { process.kill(i.pid, 0); return true; } catch { return false; } });
  } catch { return []; }
}

/** Trim a run down to what a list row renders — the node bodies stay on disk. */
function summariseRun(r) {
  const nodes = r.graph?.nodes || [];
  const done = nodes.filter((n) => n.status === 'done').length;
  const running = nodes.find((n) => n.status === 'running');
  const asking = nodes.find((n) => n.status === 'running' && n.kind === 'ask') || nodes.find((n) => n.kind === 'ask' && n.status !== 'done' && n.status !== 'pending');
  // Roll up per-node meta for a budget-at-a-glance total.
  const totals = { cost: 0, tokens: 0, elapsedS: 0 };
  for (const n of nodes) {
    const m = n.output?.meta;
    if (!m) continue;
    if (typeof m.cost === 'number')   totals.cost += m.cost;
    if (typeof m.tokens === 'number') totals.tokens += m.tokens;
    if (typeof m.elapsed === 'string') {
      const s = parseFloat(m.elapsed);
      if (Number.isFinite(s)) totals.elapsedS += s;
    }
  }
  return {
    runId: r.runId,
    workflowId: r.workflowId,
    workflowTitle: r.workflowTitle,
    category: r.category,
    status: r.status,
    trigger: r.trigger,
    sessionId: r.sessionId,
    repoRoot: r.repoRoot,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    cost: r.cost,
    totalNodes: nodes.length,
    doneNodes: done,
    runningLabel: running ? running.title : null,
    askingLabel: asking ? asking.title : null,
    totalCost:   totals.cost || null,
    totalTokens: totals.tokens || null,
    totalElapsed: totals.elapsedS ? `${totals.elapsedS.toFixed(1)} s` : null,
  };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export async function startServer({ port, file, sessionId, cwd, title, capture = true }) {
  ensureDirs();
  const store = new SessionStore();
  /*
   * One watcher per open tab, all tailing at once. Switching is then instant
   * and a background tab can say how much it has missed — a single watcher
   * being repointed would lose both.
   */
  const watchers = new Map();
  const tabMeta = new Map();
  const freshTabs = new Set(); // started here, no transcript yet
  const watcher = () => watchers.get(liveId);

  async function openTab(id, meta) {
    if (watchers.has(id)) return watchers.get(id);
    const w = new SessionWatcher(meta.file, {
      sessionId: id, capture: capture && id === liveId, projectDir: meta.cwd || cwd,
      // So the viewer is never photographed as though it were the work, and
      // so pixel comparisons can be run on this server's own origin.
      selfPort: port, origin: `http://127.0.0.1:${port}`,
    });
    w.on('update', (d) => broadcast('update', { ...(d || {}), sessionId: id }));
    w.on('log', (m) => broadcast('log', { message: m, sessionId: id }));
    watchers.set(id, w);
    tabMeta.set(id, { title: meta.title, cwd: meta.cwd });
    await w.start();
    return w;
  }

  function closeTab(id) {
    const w = watchers.get(id);
    if (!w) return false;
    w.stop();
    watchers.delete(id);
    tabMeta.delete(id);
    return true;
  }

  /** Look at a tab: it stops counting unread and takes over the camera. */
  async function focusTab(id) {
    if (!watchers.has(id)) return false;
    const previous = watchers.get(liveId);
    if (previous && liveId !== id) {
      previous.focused = false;
      await previous.setCapture(false);
    }
    liveId = id;
    const next = watchers.get(id);
    next.focused = true;
    next.unread = 0;
    const meta = tabMeta.get(id) || {};
    liveTitle = meta.title || liveTitle;
    liveCwd = meta.cwd || liveCwd;
    runnerFor(id).cwd = meta.cwd || runnerFor(id).cwd;
    if (capture) await next.setCapture(true);
    broadcast('tabs', { tabs: tabs(), active: liveId });
    return true;
  }

  function tabs() {
    return [...watchers.entries()].map(([id, w]) => ({
      sessionId: id,
      title: tabMeta.get(id)?.title || id.slice(0, 8),
      cwd: tabMeta.get(id)?.cwd || null,
      fresh: freshTabs.has(id),
      active: id === liveId,
      unread: w.unread,
      working: !!w.activity().working,
      busy: !!runners.get(id)?.busy,
    }));
  }

  /*
   * A runner per session. Sharing one meant a prompt in any tab blocked every
   * other tab, which is not how separate terminals behave and is not how tabs
   * should either.
   */
  const runners = new Map();
  function runnerFor(id) {
    if (runners.has(id)) return runners.get(id);
    const meta = tabMeta.get(id) || {};
    const r = new Runner({ cwd: meta.cwd || cwd });
    r.on('state', (st) => broadcast('run', { ...st, sessionId: id }));
    r.on('session', ({ sessionId: ran }) => followFork(id, ran));
    runners.set(id, r);
    return r;
  }
  const runner = () => runnerFor(liveId);
  let liveId = sessionId;
  let liveTitle = title;
  let liveCwd = cwd;

  // One scheduler per in-flight workflow run; dropped on terminal state.
  const schedulers = new Map();
  function startScheduler(run) {
    const s = new Scheduler(run);
    s.on('update', (e) => broadcast('update', { runId: e.runId, nodeId: e.nodeId || null }));
    s.on('finish', (e) => { broadcast('run-finish', e); schedulers.delete(e.runId); });
    s.on('fail',   (e) => { broadcast('run-finish', { ...e, status: 'failed' }); });
    schedulers.set(run.runId, s);
    s.start();
    return s;
  }

  // Claude forks a copy under a new id when the session is already open
  // elsewhere; follow whichever transcript the run actually went to.
  /*
   * Claude forks a copy under a new id when the session is already open
   * elsewhere. Follow the work by opening the fork as a tab, and only bring
   * it forward if the tab it replaced was the one being looked at — a view
   * that moves on its own while you are reading another tab is worse than a
   * tab you have to click.
   */
  /*
   * Claude forks a copy under a new id when the session is already open
   * elsewhere. Follow the work by opening the fork as a tab, and only bring it
   * forward if the tab it replaced was the one being looked at.
   */
  function followFork(from, ran) {
    if (!ran || ran === from || watchers.has(ran)) return;
    const wasFocused = from === liveId;
    let tries = 0;
    const findIt = async () => {
      const match = listSessions().find((x) => x.sessionId === ran);
      if (match) {
        await openTab(ran, match);
        if (wasFocused) await focusTab(ran);
        broadcast('session', { sessionId: ran, forked: true, from, focused: wasFocused });
      } else if (tries++ < 10) setTimeout(findIt, 600);
    };
    findIt().catch(() => {});
  }

  const clients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); }
      catch { clients.delete(res); } // a dead client should not be kept
    }
  };

  const resolveView = (id) => {
    const wanted = id || liveId;
    if (watchers.has(wanted) && wanted !== liveId) {
      const w = watchers.get(wanted);
      const meta = tabMeta.get(wanted) || {};
      return { session: w.session, history: w.history, sessionId: wanted, live: true, meta };
    }
    if (!id || id === liveId || id === sessionId) {
      return {
        session: watcher().session, history: watcher().history, sessionId: liveId, live: true,
        meta: { title: liveTitle, cwd: liveCwd },
      };
    }
    const e = store.load(id);
    return e ? { session: e.session, history: e.history, sessionId: id, live: false, meta: e.meta } : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      if (url.pathname === '/api/state') {
        const view = resolveView(url.searchParams.get('session'));
        if (!view) return send(404, { error: 'session not found' });
        return send(200, {
          instance: { port, sessionId: liveId, cwd: liveCwd, title: liveTitle, pid: process.pid },
          run: runner().state(),
          activity: view.live ? watcher().activity() : { working: false },
          person: personName(cwd),
          build: webBuildId(),
          live: view.live,
          devUrl: watcher().devUrl,
          tabs: tabs(),
          meta: view.meta,
          session: light(view.session),
        });
      }

      if (url.pathname === '/api/prompt' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          // A prompt may name its tab, so a background tab can be sent work.
          const target = body.sessionId && watchers.has(body.sessionId) ? body.sessionId : liveId;
          // Name the attachments in the prompt so Claude knows to read them.
          const files = Array.isArray(body.attachments) ? body.attachments : [];
          const text = files.length
            ? `${body.text}\n\nAttached ${files.length === 1 ? 'file' : 'files'}:\n`
              + files.map((f) => `- ${f}`).join('\n')
            : body.text;
          /*
           * A run that started a dev server never ends: the command holds the
           * process open, so the run stays "working" for as long as the server
           * lives. Refusing every later prompt because of that leaves the
           * composer dead with no way back, so a new prompt replaces the run
           * instead of being turned away.
           */
          if (runnerFor(target).busy) {
            if (body.replace === false) {
              return send(409, { error: 'Claude is already working in this session' });
            }
            runnerFor(target).stop();
          }

          const started = runnerFor(target).run({
            sessionId: target, text, mode: body.mode, fresh: freshTabs.has(target),
            readDir: files.length ? uploadsFor(target) : null,
          });
          freshTabs.delete(target); // it exists from here on
          return send(200, started);
        } catch (e) {
          return send(409, { error: e.message });
        }
      }

      if (url.pathname === '/api/capture' && req.method === 'POST') {
        const body = await readBody(req);
        watcher().pinCaptureUrl(body.url ? String(body.url).trim() : null);
        return send(200, { devUrl: watcher().devUrl });
      }

      if (url.pathname === '/api/stop' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const which = body.sessionId && runners.has(body.sessionId) ? body.sessionId : liveId;
        return send(200, { stopped: runnerFor(which).stop(), run: runnerFor(which).state() });
      }

      // Polled on its own so the live row stays honest even when the
      // transcript is not growing — Claude thinking writes nothing for a while.
      if (url.pathname === '/api/health') {
        return send(200, { ok: true, build: webBuildId(), pid: process.pid, session: liveId });
      }

      if (url.pathname === '/api/activity') {
        return send(200, { activity: watcher().activity(), run: runner().state(), live: true, tabs: tabs() });
      }

      if (url.pathname === '/api/sessions') return send(200, { sessions: listSessions() });

      if (url.pathname === '/api/terminals') {
        return send(200, { terminals: listTerminals(), tabs: tabs() });
      }

      if (url.pathname === '/api/tabs' && req.method === 'GET') {
        return send(200, { tabs: tabs(), active: liveId });
      }

      // Open a terminal as a tab and look at it. Other tabs keep tailing.
      if (url.pathname === '/api/tabs' && req.method === 'POST') {
        const body = await readBody(req);
        const target = listSessions().find((x) => x.sessionId === body.sessionId);
        if (!target) return send(404, { error: 'session not found' });
        await openTab(target.sessionId, target);
        if (body.focus !== false) await focusTab(target.sessionId);
        return send(200, { tabs: tabs(), active: liveId });
      }

      // Start a Claude session from here. Nothing runs until the first
      // prompt — that is what creates the transcript — so the tab opens empty
      // and the watcher picks it up the moment it appears.
      /*
       * An attachment is written beside the session and its path handed to
       * Claude, which then reads it with its own tools. Uploading the bytes
       * into the prompt would blow the context on the first PDF.
       */
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const target = url.searchParams.get('session') || liveId;
        const raw = url.searchParams.get('name') || 'attachment';
        // Keep the name, lose any path in it.
        const name = path.basename(raw).replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'attachment';
        const dir = uploadsFor(target);
        fs.mkdirSync(dir, { recursive: true });

        const chunks = [];
        let size = 0;
        const LIMIT = 25 * 1024 * 1024;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (d) => {
              size += d.length;
              if (size > LIMIT) { reject(new Error('file is larger than 25MB')); req.destroy(); return; }
              chunks.push(d);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch (e) {
          return send(413, { error: e.message });
        }

        let final = path.join(dir, name);
        let n = 1;
        while (fs.existsSync(final)) {
          const ext = path.extname(name);
          final = path.join(dir, `${path.basename(name, ext)}-${n++}${ext}`);
        }
        fs.writeFileSync(final, Buffer.concat(chunks));
        return send(200, { name: path.basename(final), path: final, size, dir });
      }

      if (url.pathname === '/api/tabs/new' && req.method === 'POST') {
        const body = await readBody(req);
        const where = body.cwd || liveCwd || cwd;
        const id = randomUUID();
        await openTab(id, {
          file: transcriptPathFor(where, id),
          cwd: where,
          title: body.title || 'New session',
        });
        freshTabs.add(id);
        await focusTab(id);
        return send(200, { sessionId: id, cwd: where, tabs: tabs(), active: liveId });
      }

      if (url.pathname === '/api/tabs/close' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.sessionId === liveId && watchers.size === 1) {
          return send(409, { error: 'that is the only tab open' });
        }
        closeTab(body.sessionId);
        freshTabs.delete(body.sessionId);
        if (body.sessionId === liveId) await focusTab([...watchers.keys()][0]);
        return send(200, { tabs: tabs(), active: liveId });
      }

      if (url.pathname === '/api/commands') {
        return send(200, { commands: listCommands(watcher().projectDir || liveCwd) });
      }

      // Follow a different terminal without restarting: the watcher moves,
      // and prompts go to whichever session is being watched.
      if (url.pathname === '/api/watch' && req.method === 'POST') {
        const body = await readBody(req);
        const target = listSessions().find((s) => s.sessionId === body.sessionId);
        if (!target) return send(404, { error: 'session not found' });
        // Watching a session that is working is the normal case — it is the
        // whole point. Each session has its own runner, so nothing is shared
        // and nothing needs stopping first.
        await openTab(target.sessionId, target);
        await focusTab(target.sessionId);
        broadcast('session', { sessionId: target.sessionId, switched: true });
        return send(200, { sessionId: target.sessionId, title: target.title, cwd: target.cwd, tabs: tabs() });
      }
      if (url.pathname === '/api/instances') return send(200, { instances: readInstances() });

      if (url.pathname === '/api/step') {
        const view = resolveView(url.searchParams.get('session'));
        const stepId = url.searchParams.get('id');
        if (!view) return send(404, { error: 'session not found' });
        let found = null;
        for (const t of view.session.turns) {
          const s = t.steps.find((x) => x.id === stepId);
          if (s) { found = { turn: t, step: s }; break; }
        }
        if (!found) return send(404, { error: 'step not found' });
        const changes = stepChanges(view.history, view.sessionId, found.step, view.meta?.cwd || view.session.cwd);
        return send(200, {
          step: { ...found.step, files: undefined },
          turnPrompt: found.turn.prompt,
          changes,
          shots: found.step.shots || null,
          thinking: found.step.thinking || [],
        });
      }

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q') || '';
        const scope = url.searchParams.get('scope') || 'session';
        let entries = [];
        if (scope === 'all') {
          for (const s of listSessions({ limit: 60 })) {
            entries.push(...(s.sessionId === liveId
              ? indexSession(watcher().session, { sessionId: liveId, title: s.title })
              : store.index(s)));
          }
        } else {
          const view = resolveView(url.searchParams.get('session'));
          if (view) entries = indexSession(view.session, { sessionId: view.sessionId, title: view.meta?.title });
        }
        return send(200, { results: search(entries, q) });
      }

      if (url.pathname === '/api/shot') {
        const f = path.resolve(url.searchParams.get('f') || '');
        if (!f.startsWith(SHOTS_DIR) || !fs.existsSync(f)) return send(404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000' });
        return fs.createReadStream(f).pipe(res);
      }

      // Workflow catalog, scoped to the repo this instance was started in so
      // repo-local defs win over user-global ones.
      if (url.pathname === '/api/workflows' && req.method === 'GET') {
        return send(200, { workflows: listDefinitions({ repoRoot: liveCwd }) });
      }

      // Create a workflow — three starter kinds plus a validator for the
      // in-browser editor's "check" button.
      if (url.pathname === '/api/workflows/scaffold' && req.method === 'GET') {
        const id = url.searchParams.get('id') || 'untitled';
        const title = url.searchParams.get('title') || null;
        return send(200, { def: scaffoldWorkflow(id, { title }) });
      }
      if (url.pathname === '/api/workflows/validate' && req.method === 'POST') {
        const body = await readBody(req);
        const problems = validateDefinition(body.def || {});
        return send(200, { ok: problems.length === 0, problems });
      }
      if (url.pathname === '/api/workflows' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const file = writeWorkflow({
            def: body.def, scope: body.scope || 'project',
            repoRoot: body.scope === 'project' ? (body.repoRoot || liveCwd) : null,
            overwrite: !!body.overwrite,
          });
          return send(200, { saved: true, file });
        } catch (e) { return send(400, { error: e.message }); }
      }


      // Skills — the pieces workflows draw on. Walks every repo the sessions
      // index knows about plus the global library.
      if (url.pathname === '/api/skills') {
        return send(200, { skills: listSkills() });
      }

      // Shared session export — signed URL good for one week.
      const shareMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/share$/);
      if (shareMatch && req.method === 'POST') {
        const view = resolveView(shareMatch[1]);
        if (!view) return send(404, { error: 'session not found' });
        const token = generateToken('session', shareMatch[1]);
        const host = req.headers.host || `localhost:${port}`;
        return send(200, { token, url: `http://${host}/share/${token}` });
      }
      // Share a workflow run — same signed-token mechanism.
      const shareRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/share$/);
      if (shareRunMatch && req.method === 'POST') {
        const run = readRun(shareRunMatch[1], { repoRoot: liveCwd });
        if (!run) return send(404, { error: 'run not found' });
        const token = generateToken('run', shareRunMatch[1]);
        const host = req.headers.host || `localhost:${port}`;
        return send(200, { token, url: `http://${host}/share/${token}` });
      }
      // Share a decision — body is {sessionId, stepId} for marked, or just
      // {runId, nodeId} for auto-extracted ones. Encoded into the id so the
      // same /share/:token route can serve it.
      if (url.pathname === '/api/decisions/share' && req.method === 'POST') {
        const body = await readBody(req);
        let id;
        if (body.runId && body.nodeId) id = `auto__${body.runId}__${body.nodeId}`;
        else if (body.sessionId && body.stepId) id = `marked__${body.sessionId}__${body.stepId}`;
        else return send(400, { error: 'need (runId, nodeId) or (sessionId, stepId)' });
        const token = generateToken('decision', id);
        const host = req.headers.host || `localhost:${port}`;
        return send(200, { token, url: `http://${host}/share/${token}` });
      }

      const shareOpenMatch = url.pathname.match(/^\/share\/(.+)$/);
      if (shareOpenMatch && req.method === 'GET') {
        const payload = verifyToken(shareOpenMatch[1]);
        if (!payload) return send(410, 'This link has expired or is not valid.', 'text/plain');
        if (payload.kind === 'session') {
          const view = resolveView(payload.id);
          if (!view) return send(404, 'Session not found.', 'text/plain');
          return send(200, exportSessionHtml({
            session: view.session, meta: view.meta, sessionId: payload.id, shotsDir: SHOTS_DIR,
          }), 'text/html');
        }
        if (payload.kind === 'run') {
          const run = readRun(payload.id, { repoRoot: liveCwd });
          if (!run) return send(404, 'Run not found.', 'text/plain');
          return send(200, exportRunHtml({ run }), 'text/html');
        }
        if (payload.kind === 'decision') {
          const parts = payload.id.split('__');
          const kind = parts[0];
          let decision = null;
          if (kind === 'auto' && parts.length === 3) {
            const [, runId, nodeId] = parts;
            const run = readRun(runId, { repoRoot: liveCwd });
            const n = run?.graph?.nodes?.find((x) => x.id === nodeId);
            if (run && n && n.kind === 'ask') decision = {
              kind: 'auto', at: n.endedAt || run.startedAt,
              workflowTitle: run.workflowTitle, nodeId,
              question: n.output?.question || n.title, answer: n.output?.answer,
            };
          } else if (kind === 'marked' && parts.length === 3) {
            const [, sessionId, stepId] = parts;
            const marks = listDecisions();
            decision = marks.find((d) => d.kind === 'marked' && d.sessionId === sessionId && d.stepId === stepId);
          }
          if (!decision) return send(404, 'Decision not found.', 'text/plain');
          return send(200, exportDecisionHtml({ decision }), 'text/html');
        }
        return send(404, 'Unknown share kind.', 'text/plain');
      }

      // Decisions — auto-extracted from ask-node answers, plus user marks.
      if (url.pathname === '/api/decisions' && req.method === 'GET') {
        return send(200, { decisions: listDecisions() });
      }
      if (url.pathname === '/api/decisions/mark' && req.method === 'POST') {
        const body = await readBody(req);
        try { return send(200, { mark: markDecision(body) }); }
        catch (e) { return send(400, { error: e.message }); }
      }
      if (url.pathname === '/api/decisions/mark' && req.method === 'DELETE') {
        const body = await readBody(req);
        unmarkDecision(body);
        return send(200, { removed: true });
      }

      // Prompts — named templates you can send into a session.
      if (url.pathname === '/api/prompts' && req.method === 'GET') {
        return send(200, { prompts: listPrompts() });
      }
      if (url.pathname === '/api/prompts/scaffold' && req.method === 'GET') {
        const slug = url.searchParams.get('slug') || 'untitled';
        const title = url.searchParams.get('title') || null;
        return send(200, { md: scaffoldPrompt(slug, { title }) });
      }
      if (url.pathname === '/api/prompts/validate' && req.method === 'POST') {
        const body = await readBody(req);
        const problems = validatePrompt(body.md || '');
        return send(200, { ok: problems.length === 0, problems });
      }
      if (url.pathname === '/api/prompts' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const file = writePrompt({
            md: body.md, slug: body.slug, scope: body.scope || 'project',
            repoRoot: body.scope === 'project' ? (body.repoRoot || liveCwd) : null,
            overwrite: !!body.overwrite,
          });
          return send(200, { saved: true, file });
        } catch (e) { return send(400, { error: e.message }); }
      }
      const promptMatch = url.pathname.match(/^\/api\/prompts\/(.+)$/);
      if (promptMatch && req.method === 'GET' && !promptMatch[1].endsWith('/send')) {
        const p = getPrompt(decodeURIComponent(promptMatch[1]));
        return p ? send(200, { prompt: p }) : send(404, { error: 'prompt not found' });
      }
      const promptSendMatch = url.pathname.match(/^\/api\/prompts\/(.+)\/send$/);
      if (promptSendMatch && req.method === 'POST') {
        const p = getPrompt(decodeURIComponent(promptSendMatch[1]));
        if (!p) return send(404, { error: 'prompt not found' });
        const body = await readBody(req);
        const text = interpolate(p.body, body.inputs || {});
        const target = body.sessionId && watchers.has(body.sessionId) ? body.sessionId : liveId;
        if (runnerFor(target).busy) runnerFor(target).stop();
        const started = runnerFor(target).run({
          sessionId: target, text, mode: body.mode || 'acceptEdits', fresh: false,
        });
        return send(200, { sent: true, sessionId: target, text, started });
      }


      const wfMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (wfMatch && req.method === 'GET') {
        const def = getDefinition(wfMatch[1], { repoRoot: liveCwd });
        return def ? send(200, { workflow: def }) : send(404, { error: 'workflow not found' });
      }
      const wfRunMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
      if (wfRunMatch && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const run = startRun({
            workflowId: wfRunMatch[1],
            inputs: body.inputs || {},
            repoRoot: liveCwd,
            sessionId: liveId,
            trigger: body.trigger || 'you',
          });
          startScheduler(run);
          broadcast('run-start', { runId: run.runId, workflowId: run.workflowId });
          return send(200, { run });
        } catch (e) { return send(400, { error: e.message }); }
      }

      const runRerunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/);
      if (runRerunMatch && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        try {
          const run = rerunRun(runRerunMatch[1], { fromNodeId: body.fromNodeId || null });
          startScheduler(run);
          broadcast('run-start', { runId: run.runId, workflowId: run.workflowId });
          return send(200, { run });
        } catch (e) { return send(400, { error: e.message }); }
      }

      const runDeleteMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runDeleteMatch && req.method === 'DELETE') {
        const s = schedulers.get(runDeleteMatch[1]);
        if (s) s.stop();
        const ok = deleteRun(runDeleteMatch[1]);
        if (ok) broadcast('run-finish', { runId: runDeleteMatch[1], status: 'deleted' });
        return ok ? send(200, { deleted: true }) : send(404, { error: 'run not found' });
      }

      if (url.pathname === '/api/runs/stop-all' && req.method === 'POST') {
        let stopped = 0;
        for (const s of schedulers.values()) if (s.stop()) stopped++;
        return send(200, { stopped });
      }

      const runStopMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
      if (runStopMatch && req.method === 'POST') {
        const s = schedulers.get(runStopMatch[1]);
        if (!s) return send(404, { error: 'not running' });
        return send(200, { stopped: s.stop() });
      }

      const runAnswerMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/answer$/);
      if (runAnswerMatch && req.method === 'POST') {
        const s = schedulers.get(runAnswerMatch[1]);
        if (!s) return send(404, { error: 'not running' });
        const body = await readBody(req);
        if (!body.nodeId) return send(400, { error: 'nodeId required' });
        const ok = s.answer(body.nodeId, body.answer);
        return ok ? send(200, { answered: true }) : send(409, { error: 'no answer pending for that node' });
      }

      if (url.pathname === '/api/runs') {
        const sessionFilter = url.searchParams.get('session');
        const runs = sessionFilter ? runsForSession(sessionFilter) : listRuns();
        return send(200, { runs: runs.map(summariseRun) });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && req.method === 'GET') {
        const run = readRun(runMatch[1], { repoRoot: liveCwd });
        return run ? send(200, { run }) : send(404, { error: 'run not found' });
      }

      if (url.pathname === '/api/blob') {
        const sha = url.searchParams.get('sha') || '';
        const b = openBlob(sha);
        if (!b) return send(404, { error: 'blob not found' });
        const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          svg: 'image/svg+xml', webm: 'video/webm', mp4: 'video/mp4',
          txt: 'text/plain', json: 'application/json' }[b.ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' });
        return fs.createReadStream(b.path).pipe(res);
      }

      // static
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const file = path.resolve(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) return send(404, 'Not found', 'text/plain');
      return send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  // listen reports failure as an event, not a rejection, so a port already in
  // use crashed the process with a raw stack instead of saying so.
  await new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onReady); reject(err); };
    const onReady = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onReady);
    server.listen(port, '127.0.0.1');
  });
  // Started only now: detecting dev servers before this port is open would
  // miss our own, and pick whatever unrelated app answered first.
  await openTab(sessionId, { file, cwd, title });
  watcher().focused = true;
  const close = () => {
    for (const r of runners.values()) r.stop();
    for (const s of schedulers.values()) s.stop();
    schedulers.clear();
    for (const w of watchers.values()) w.stop();
    shutdownBrowser(); // otherwise the headless Chrome outlives the CLI
    server.close();
  };

  return { server, watchers, tabs, runners, close };
}
