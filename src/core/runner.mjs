import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Permission modes this tool is willing to start Claude with.
 *
 * Deliberately narrow. `acceptEdits` lets Claude edit files in the project it
 * is already working in; `plan` lets it think without touching anything.
 * Modes that skip permission checks are not offered: nobody is sitting at a
 * terminal to supervise a run started from a browser tab.
 */
const MODES = new Set(['acceptEdits', 'plan']);
const DEFAULT_MODE = 'acceptEdits';

/**
 * Runs Claude Code against an existing session, so a prompt can be sent from
 * the browser without opening a terminal.
 *
 * `--resume` continues the same session id, and the work lands in the same
 * transcript the watcher is already tailing — so bubbles appear the usual way.
 * If that session is already open elsewhere, Claude forks a copy under a new
 * id; the init event tells us which, and we re-point the watcher at it.
 */
export class Runner extends EventEmitter {
  constructor({ cwd } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.proc = null;
    this.status = 'idle';
    this.lastError = null;
    this.startedAt = null;
    this.prompt = null;
  }

  get busy() { return this.proc !== null; }

  run({ sessionId, text, mode = DEFAULT_MODE, fresh = false, readDir = null }) {
    if (this.busy) throw new Error('Claude is already working on this session');
    if (!text || !text.trim()) throw new Error('empty prompt');
    const permission = MODES.has(mode) ? mode : DEFAULT_MODE;

    const args = [];
    // A session that does not exist yet is named, not resumed.
    if (sessionId) args.push(fresh ? '--session-id' : '--resume', sessionId);
    // Attachments live outside the project, so the directory has to be granted.
    if (readDir) args.push('--add-dir', readDir);
    args.push(
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permission,
      // Nobody is at a terminal to answer, so anything needing a decision is
      // refused rather than left hanging or waved through.
      '--permission-prompts', 'none',
    );

    this.status = 'running';
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    this.prompt = text;
    this.emit('state', this.state());

    const proc = spawn('claude', args, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    let buf = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          this.emit('session', { sessionId: msg.session_id, cwd: msg.cwd });
        }
        if (msg.type === 'result') {
          this.lastError = msg.is_error ? (msg.result || 'run failed') : null;
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString().slice(0, 4000); });

    const tail = () => stderr.trim().split('\n').slice(-3).join(' ');
    const finish = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.status = why === 'stopped' ? 'stopped' : this.lastError ? 'failed' : 'idle';
      this.emit('state', this.state());
    };

    proc.on('error', (e) => { this.lastError = e.message; finish('error'); });
    proc.on('exit', (code) => {
      if (code && code !== 0 && !this.lastError) {
        this.lastError = tail() || `claude exited ${code}`;
      }
      finish(code === 0 ? 'done' : 'error');
    });

    return this.state();
  }

  stop() {
    if (!this.proc) return false;
    const p = this.proc;
    this.proc = null;
    this.status = 'stopped';
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2500).unref?.();
    this.emit('state', this.state());
    return true;
  }

  state() {
    return {
      status: this.status,
      busy: this.busy,
      // How long this run has been going. A run that started a dev server
      // never ends, so the number matters more than the flag.
      runningMs: this.busy && this.startedAt ? Date.now() - Date.parse(this.startedAt) : 0,
      error: this.lastError,
      startedAt: this.startedAt,
      prompt: this.prompt,
      modes: [...MODES],
    };
  }
}
