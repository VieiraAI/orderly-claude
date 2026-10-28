/*
 * Workflow definitions and runs.
 *
 * Definitions are discovered from three places, nearest-wins:
 *   1. <repo>/.claude/workflows/*.{json,yaml,yml}          — repo-local
 *   2. ~/.claude/workflows/*.{json,yaml,yml}                — user-global
 *   3. built-ins shipped under src/core/workflow-defs/      — baseline catalog
 *
 * Runs are the artifacts of invoking a workflow. One run.json per run, stored
 * at <repo>/.claude/workflows/runs/<run-id>/run.json so the repo carries its
 * own history and the local Claude Code sees it. If no repo is around, a
 * fallback dir under ~/.orderly-claude/runs/_scratch/ is used.
 *
 * No YAML parser — definitions are JSON today. YAML can land later without
 * changing the shape on disk; .yaml files are detected and ignored for now.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { USER_WORKFLOWS_DIR, repoWorkflowsDir, repoRunsDir, SCRATCH_RUNS_DIR } from './paths.mjs';
import { listSessions } from './sessions.mjs';

const BUILTIN_DIR = fileURLToPath(new URL('./workflow-defs/', import.meta.url));

/* ------------------------------ Definitions ------------------------------ */

/** Return the merged catalog, nearest wins. `repoRoot` is optional. */
export function listDefinitions({ repoRoot } = {}) {
  const seen = new Map();
  const sources = [
    repoRoot ? { scope: 'project', dir: repoWorkflowsDir(repoRoot) } : null,
    { scope: 'user',    dir: USER_WORKFLOWS_DIR },
    { scope: 'builtin', dir: BUILTIN_DIR },
  ].filter(Boolean);
  for (const src of sources) {
    for (const def of readDir(src.dir)) {
      if (seen.has(def.id)) continue;
      seen.set(def.id, { ...def, scope: src.scope, source: src.dir });
    }
  }
  return [...seen.values()];
}

export function getDefinition(id, { repoRoot } = {}) {
  return listDefinitions({ repoRoot }).find((d) => d.id === id) || null;
}

function readDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const defs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // yaml later
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d.id === 'string') defs.push(d);
    } catch { /* skip bad files */ }
  }
  return defs;
}

/* --------------------------------- Runs --------------------------------- */

/**
 * Start a run. Writes a run.json with every node in `pending`, status
 * `running`, and returns the run.
 */
export function startRun({ workflowId, inputs = {}, repoRoot, sessionId = null, trigger = 'you' }) {
  const def = getDefinition(workflowId, { repoRoot });
  if (!def) throw new Error(`workflow not found: ${workflowId}`);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const nodes = (def.graph?.nodes || []).map((n) => ({
    id: n.id, title: n.title, kind: n.kind,
    col: n.col, row: n.row, cost: n.cost,
    status: 'pending', waitsFor: null, output: null,
    startedAt: null, endedAt: null,
  }));
  const run = {
    runId,
    workflowId,
    workflowTitle: def.title,
    category: def.category,
    scope: def.scope,
    status: 'running',
    trigger,
    sessionId,
    repoRoot: repoRoot || null,
    startedAt: now,
    endedAt: null,
    inputs,
    graph: { nodes, edges: def.graph?.edges || [] },
    cost: 0,
  };
  writeRun(run);
  return run;
}

/** Overwrite a run atomically. `run.runId` + `run.repoRoot` locate the file. */
export function writeRun(run) {
  const dir = runDir(run);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** Patch a run file. `patch` is merged shallowly; node updates live under `nodes`. */
export function updateRun(runId, { repoRoot, patch = {}, nodes = {} }) {
  const run = readRun(runId, { repoRoot });
  if (!run) throw new Error(`run not found: ${runId}`);
  Object.assign(run, patch);
  for (const [nid, np] of Object.entries(nodes)) {
    const n = run.graph.nodes.find((x) => x.id === nid);
    if (n) Object.assign(n, np);
  }
  writeRun(run);
  return run;
}

export function readRun(runId, { repoRoot } = {}) {
  // Known repo: one lookup. Unknown: scan every project we know about.
  if (repoRoot) {
    const file = path.join(repoRunsDir(repoRoot), runId, 'run.json');
    if (fs.existsSync(file)) return parse(file);
  }
  for (const root of knownRepoRoots()) {
    const file = path.join(repoRunsDir(root), runId, 'run.json');
    if (fs.existsSync(file)) return parse(file);
  }
  const scratch = path.join(SCRATCH_RUNS_DIR, runId, 'run.json');
  if (fs.existsSync(scratch)) return parse(scratch);
  return null;
}

/** Every run across every known repo plus _scratch. Reverse-chrono. */
export function listRuns({ limit = 200 } = {}) {
  const out = [];
  for (const root of knownRepoRoots()) collectRuns(repoRunsDir(root), root, out);
  collectRuns(SCRATCH_RUNS_DIR, null, out);
  out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return out.slice(0, limit);
}

/** Runs that happened inside a specific session, in order. */
export function runsForSession(sessionId) {
  return listRuns({ limit: 1000 }).filter((r) => r.sessionId === sessionId);
}

function collectRuns(dir, repoRoot, out) {
  let kids;
  try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const k of kids) {
    if (!k.isDirectory()) continue;
    const file = path.join(dir, k.name, 'run.json');
    if (!fs.existsSync(file)) continue;
    const run = parse(file);
    if (!run) continue;
    if (repoRoot && !run.repoRoot) run.repoRoot = repoRoot;
    out.push(run);
  }
}

function runDir(run) {
  const base = run.repoRoot ? repoRunsDir(run.repoRoot) : SCRATCH_RUNS_DIR;
  return path.join(base, run.runId);
}

function parse(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/* Every repo root the user has run Claude Code inside at least once, from the
 * sessions index. This is the surface across which runs are discovered — any
 * repo not opened in Claude Code lately is simply not scanned, which keeps the
 * list bounded. */
function knownRepoRoots() {
  const roots = new Set();
  for (const s of listSessions({ limit: 400 })) {
    if (s.cwd) roots.add(s.cwd);
  }
  return [...roots];
}
