/*
 * The workflow assistant: Claude, inside the editor, helping one person
 * build, change, fix and explain one workflow.
 *
 * Each conversation is an ordinary Claude Code session, run with the
 * person's own Claude login, in a working folder of its own. That has two
 * payoffs. Its transcript is read back through the same summariser the
 * Sessions page uses, so the conversation looks and reads like the rest of
 * Orderly. And it inherits Claude Code's permission system, which is how the
 * assistant is kept to one job:
 *
 *   it can read  — the workflow, its recent runs, the project's files
 *   it can write — one file, draft.json, its proposal
 *   it can run   — one command, `node check.mjs`, Orderly's own validator
 *
 * Anything else is refused without a prompt (`--permission-prompts none`).
 * Nothing it does changes the workflow: a finished turn leaves a proposal,
 * shown as a diff and on the canvas, which the person applies or discards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECTS_DIR, assistantDir } from './paths.mjs';
import { readRecords } from './jsonl.mjs';
import { buildSession } from './steps.mjs';
import { validateDefinition, lintDefinition, stripRuntime, listRuns } from './workflows.mjs';
import { listSkills } from './skills.mjs';
import { runSpend } from './settings.mjs';
import { diffWorkflows, describeDiff } from './workflow-diff.mjs';
import { buildBrief } from './assistant-brief.mjs';

const projectsDir = () => process.env.ORDERLY_ASSISTANT_PROJECTS_DIR || PROJECTS_DIR;
const claudeBin = () => process.env.ORDERLY_CLAUDE_BIN || 'claude';
const WORKFLOWS_MODULE = pathToFileURL(fileURLToPath(new URL('./workflows.mjs', import.meta.url))).href;

/** Several people's editors may each be asking; a machine can only do so much at once. */
export const MAX_AT_ONCE = 3;
/** A turn that has not finished in this long is stopped. */
const TURN_LIMIT_MS = 6 * 60 * 1000;
const MAX_MESSAGE = 8000;

/* The tools it has at all, and the few it may use without asking. */
const TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const ALLOWED = ['Edit(draft.json)', 'Edit(./draft.json)', 'Write(draft.json)', 'Write(./draft.json)', 'Bash(node check.mjs)'];

const CHECK = `// Runs Orderly's own validator on draft.json. The assistant runs this after every edit.
import fs from 'node:fs';
const { validateDefinition, lintDefinition } = await import(${JSON.stringify(WORKFLOWS_MODULE)});
let d;
try { d = JSON.parse(fs.readFileSync(new URL('./draft.json', import.meta.url), 'utf8')); }
catch (e) { console.log('draft.json is not valid JSON: ' + e.message); process.exit(1); }
const problems = validateDefinition(d);
if (problems.length) { console.log('Problems to fix:\\n' + problems.map((p) => '- ' + p).join('\\n')); process.exit(1); }
const warnings = lintDefinition(d);
console.log('Ready to run.' + (warnings.length ? '\\nWorth a look:\\n' + warnings.map((w) => '- ' + w).join('\\n') : ''));
`;

/* ------------------------------ workspaces ------------------------------ */

/** A folder per conversation key. The key never becomes a path itself. */
function folderFor(key) {
  return path.join(assistantDir(), createHash('sha256').update(String(key)).digest('hex').slice(0, 20));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Keys move when an unsaved workflow is saved; the folder stays put. */
function aliases() { return readJson(path.join(assistantDir(), 'aliases.json'), {}); }
function resolveKey(key) {
  const seen = new Set();
  let k = key;
  const map = aliases();
  while (map[k] && !seen.has(k)) { seen.add(k); k = map[k]; }
  return k;
}

function workspace(key) {
  const dir = folderFor(resolveKey(key));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readMeta(dir) {
  return readJson(path.join(dir, 'meta.json'), {
    sessionId: null, turns: 0, costUsd: 0, createdAt: new Date().toISOString(),
    proposal: null, lastError: null, archived: [],
  });
}
function writeMeta(dir, meta) { writeJson(path.join(dir, 'meta.json'), meta); }

/** What the assistant may want beyond the workflow itself. */
function contextFor(def, { repoRoot }) {
  const runs = listRuns({ limit: 400 }).filter((r) => r.workflowId === def.id).slice(0, 5).map((r) => {
    const failed = r.graph?.nodes?.find((n) => n.status === 'failed');
    return {
      startedAt: r.startedAt, status: r.status, version: r.definitionVersion || null,
      costUsd: Math.round(runSpend(r) * 10000) / 10000,
      failedStep: failed ? { id: failed.id, title: failed.title, error: String(failed.output?.error || '').slice(0, 800) } : null,
      stoppedAtSpendLimit: r.halt?.type === 'budget' || undefined,
      inputs: r.inputs,
    };
  });
  const skills = listSkills().map((k) => ({ slug: k.slug, description: String(k.description || '').slice(0, 160) }));
  return {
    project: repoRoot || null,
    workflow: { id: def.id || null, title: def.title || null, steps: def.graph?.nodes?.length || 0 },
    recentRuns: runs,
    skills: [...new Map(skills.map((k) => [k.slug, k])).values()].slice(0, 80),
  };
}

/** Find a session's transcript by id, wherever Claude Code filed it. */
function transcriptOf(meta) {
  if (!meta.sessionId) return null;
  if (meta.transcript && fs.existsSync(meta.transcript)) return meta.transcript;
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projectsDir(), d.name, `${meta.sessionId}.jsonl`);
    if (fs.existsSync(f)) return (meta.transcript = f);
  }
  return null;
}

/*
 * The steps of the assistant's own work, named for the person rather than
 * the files: "Read the workflow", not "Read current.json".
 */
const FRIENDLY = [
  [/^Read current\.json$/, 'Read the workflow'],
  [/^Read draft\.json$/, 'Read its proposal'],
  [/^Read context\.json$/, 'Looked at recent runs and skills'],
  [/^Read BRIEF\.md$/, 'Read the workflow guide'],
  [/^Read check\.mjs$/, 'Looked at the checker'],
  [/^(Edited|Wrote) draft\.json$/, 'Updated the proposal'],
  [/^node check\.mjs$|^Run Orderly'?s? (own )?validator.*$|check\.mjs/i, 'Checked the proposal'],
];
function friendly(label) {
  for (const [re, to] of FRIENDLY) if (re.test(label)) return label.replace(/\s*\(\d+ (steps|commands)\)$/, '').replace(re, to);
  return label;
}

/* ------------------------------ proposals ------------------------------- */

function proposalFrom(dir) {
  const current = readJson(path.join(dir, 'current.json'), null);
  let draft;
  try { draft = JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf8')); }
  catch (e) {
    return { status: 'pending', parseError: `Claude's proposal is not valid JSON (${e.message}).`, lines: [], problems: [], warnings: [], valid: false, createdAt: new Date().toISOString() };
  }
  const diff = diffWorkflows(current, draft);
  if (diff.empty) return null;
  const problems = validateDefinition(draft);
  return {
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff,
    lines: describeDiff(diff),
    problems,
    warnings: problems.length ? [] : lintDefinition(draft),
    valid: problems.length === 0,
    draft: stripRuntime(draft),
  };
}

/* ------------------------------- the runs ------------------------------- */

export class Assistant extends EventEmitter {
  constructor() {
    super();
    this.active = new Map(); // folder → { proc, startedAt, key, timer, progress }
  }

  status(key) {
    const dir = workspace(key);
    const a = this.active.get(dir);
    const meta = readMeta(dir);
    return {
      busy: !!a,
      startedAt: a?.startedAt || null,
      elapsedMs: a ? Date.now() - Date.parse(a.startedAt) : 0,
      progress: a?.progress || null,
      turns: meta.turns,
      costUsd: Math.round((meta.costUsd || 0) * 10000) / 10000,
      lastError: meta.lastError,
      proposal: meta.proposal ? { ...meta.proposal, draft: meta.proposal.draft } : null,
      hasConversation: !!meta.sessionId,
      atCapacity: this.active.size >= MAX_AT_ONCE && !a,
    };
  }

  /** The conversation, read through the same summariser as the Sessions page. */
  conversation(key) {
    const dir = workspace(key);
    const meta = readMeta(dir);
    const file = transcriptOf(meta);
    if (!file) return { turns: [] };
    if (meta.transcript && !readMeta(dir).transcript) writeMeta(dir, { ...readMeta(dir), transcript: meta.transcript });
    let records = [];
    try { ({ records } = readRecords(file)); } catch { return { turns: [] }; }
    const session = buildSession(records, { live: this.active.has(dir) });
    for (const t of session.turns) {
      for (const st of t.steps) {
        st.label = friendly(st.label);
        // Something it is not allowed to do was refused, as designed. Say so
        // plainly instead of showing the raw command it tried.
        const calls = st.calls || [];
        if (calls.length && calls.every((c) => c.isError && /permission|haven.t granted|not allowed|denied/i.test(String(c.result || '')))) {
          st.label = 'Tried something it is not allowed to do, and was stopped';
          st.kind = 'inspect';
          st.status = 'done';
        }
      }
    }
    return { turns: session.turns };
  }

  send({ key, text, def, repoRoot = null, model = 'sonnet' }) {
    const message = String(text || '').trim();
    if (!message) throw Object.assign(new Error('Say what you would like Claude to do.'), { status: 400 });
    if (message.length > MAX_MESSAGE) throw Object.assign(new Error(`Keep it under ${MAX_MESSAGE} characters.`), { status: 400 });
    if (!def || typeof def !== 'object' || !def.graph) throw Object.assign(new Error('No workflow to work on.'), { status: 400 });
    const dir = workspace(key);
    if (this.active.has(dir)) throw Object.assign(new Error('Claude is still working on your last message.'), { status: 409 });
    if (this.active.size >= MAX_AT_ONCE) {
      throw Object.assign(new Error(`Claude is helping with ${this.active.size} other workflows right now. Try again in a moment.`), { status: 429 });
    }

    // What the editor holds now. An unapplied proposal is built on; but if
    // the person edited the workflow since, it is set aside rather than
    // quietly undoing their edits.
    const meta = readMeta(dir);
    const current = stripRuntime(def);
    const before = readJson(path.join(dir, 'current.json'), null);
    const keepDraft = meta.proposal?.status === 'pending' && JSON.stringify(before) === JSON.stringify(current)
      && fs.existsSync(path.join(dir, 'draft.json'));
    writeJson(path.join(dir, 'current.json'), current);
    if (!keepDraft) writeJson(path.join(dir, 'draft.json'), current);
    writeJson(path.join(dir, 'context.json'), contextFor(current, { repoRoot }));
    const brief = buildBrief();
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief);
    fs.writeFileSync(path.join(dir, 'check.mjs'), CHECK);

    const fresh = !meta.sessionId;
    const sessionId = meta.sessionId || randomUUID();
    const args = [
      fresh ? '--session-id' : '--resume', sessionId,
      '-p', message,
      '--model', model,
      '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', brief,
      '--tools', ...TOOLS,
      '--allowedTools', ...ALLOWED,
      '--permission-mode', 'default',
      '--permission-prompts', 'none',
      '--max-turns', '30',
    ];
    if (repoRoot && fs.existsSync(repoRoot) && fs.statSync(repoRoot).isDirectory()) args.push('--add-dir', repoRoot);

    meta.sessionId = sessionId;
    meta.lastError = null;
    writeMeta(dir, meta);

    const proc = spawn(claudeBin(), args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const entry = { proc, startedAt: new Date().toISOString(), key, progress: null, result: null };
    this.active.set(dir, entry);
    entry.timer = setTimeout(() => { entry.timedOut = true; try { proc.kill('SIGTERM'); } catch {} }, TURN_LIMIT_MS);
    this.emit('update', { key });

    let buf = '', stderr = '', lastEmit = 0;
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'result') entry.result = msg;
        if (msg.type === 'assistant') {
          const tool = (msg.message?.content || []).find((b) => b?.type === 'tool_use');
          if (tool) entry.progress = friendly(tool.name === 'Bash' ? (tool.input?.description || tool.input?.command || 'Ran a command')
            : `${tool.name === 'Edit' || tool.name === 'Write' ? 'Edited' : tool.name} ${path.basename(tool.input?.file_path || '')}`.trim());
        }
        // The transcript grows as it works; let the panel re-read it, a few
        // times a second at most.
        if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); this.emit('update', { key }); }
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });

    const finish = (code) => {
      if (this.active.get(dir) !== entry) return;
      clearTimeout(entry.timer);
      this.active.delete(dir);
      const m = readMeta(dir);
      const r = entry.result;
      m.turns = (m.turns || 0) + 1;
      if (typeof r?.total_cost_usd === 'number') m.costUsd = (m.costUsd || 0) + r.total_cost_usd;
      if (entry.stopped) m.lastError = 'Stopped.';
      else if (entry.timedOut) m.lastError = 'That took too long, so it was stopped. Try asking for a smaller change.';
      else if (r?.is_error) m.lastError = humanError(r.result || r.subtype);
      else if (code !== 0 && !r) m.lastError = humanError(stderr.trim().split('\n').slice(-2).join(' ') || `Claude exited ${code}`);
      // A first turn that never started leaves no session to resume.
      if (fresh && !transcriptOf(m) && m.lastError) m.sessionId = null;
      const p = proposalFrom(dir);
      if (p) m.proposal = p;
      else if (m.proposal?.status === 'pending' && !keepDraft) m.proposal = null;
      writeMeta(dir, m);
      this.emit('update', { key, finished: true });
    };
    proc.on('error', (e) => {
      const m = readMeta(dir);
      m.lastError = e.code === 'ENOENT'
        ? 'Claude Code is not installed on this machine, or is not on the PATH Orderly was started with.'
        : e.message;
      writeMeta(dir, m);
      finish(-1);
    });
    proc.on('close', finish);
    return this.status(key);
  }

  stop(key) {
    const dir = workspace(key);
    const a = this.active.get(dir);
    if (!a) return false;
    a.stopped = true;
    try { a.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { a.proc.kill('SIGKILL'); } catch {} }, 2500).unref?.();
    return true;
  }

  /** The proposal was applied or discarded in the editor. */
  resolve(key, action) {
    const dir = workspace(key);
    const m = readMeta(dir);
    if (!m.proposal || m.proposal.status !== 'pending') return false;
    m.proposal = { ...m.proposal, status: action === 'applied' ? 'applied' : 'discarded', resolvedAt: new Date().toISOString(), draft: undefined };
    // The next message starts from what the editor holds, not the old draft.
    try { fs.copyFileSync(path.join(dir, 'current.json'), path.join(dir, 'draft.json')); } catch {}
    writeMeta(dir, m);
    this.emit('update', { key });
    return true;
  }

  /** Start a new conversation. The old transcript stays on disk. */
  reset(key) {
    const dir = workspace(key);
    this.stop(key);
    const m = readMeta(dir);
    if (m.sessionId) m.archived = [...(m.archived || []), { sessionId: m.sessionId, endedAt: new Date().toISOString() }];
    // "This conversation" starts again at nothing; the lifetime total is kept.
    writeMeta(dir, { ...m, sessionId: null, transcript: null, turns: 0, costUsd: 0,
      lifetimeCostUsd: (m.lifetimeCostUsd || 0) + (m.costUsd || 0), proposal: null, lastError: null });
    try { fs.copyFileSync(path.join(dir, 'current.json'), path.join(dir, 'draft.json')); } catch {}
    this.emit('update', { key });
    return true;
  }

  /** An unsaved workflow got its name: its conversation follows it. */
  rekey(from, to) {
    if (!from || !to || from === to) return false;
    const file = path.join(assistantDir(), 'aliases.json');
    fs.mkdirSync(assistantDir(), { recursive: true });
    const map = aliases();
    if (fs.existsSync(folderFor(resolveKey(to)))) return false; // it already has one
    map[to] = resolveKey(from);
    writeJson(file, map);
    return true;
  }

  stopAll() { for (const a of this.active.values()) { a.stopped = true; try { a.proc.kill('SIGTERM'); } catch {} } }
}

/** What Claude Code said went wrong, in words that say what to do. */
function humanError(text) {
  const t = String(text || '');
  if (/not logged in|authenticat|login|401/i.test(t)) return 'Claude Code is not signed in on this machine. Run `claude` in a terminal once to sign in, then try again.';
  if (/rate.?limit|429|overloaded|529/i.test(t)) return 'Claude is busy right now. Wait a moment and try again.';
  if (/max.?turns/i.test(t)) return 'Claude ran out of steps before finishing. Try asking for a smaller change.';
  if (/credit|billing|quota/i.test(t)) return 'Your Claude plan has run out of usage for now.';
  return t.slice(0, 300) || 'Something went wrong. Try again.';
}
