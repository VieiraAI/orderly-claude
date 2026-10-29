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
    const file = path.join(dir, name);
    let d;
    try {
      d = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn(`[workflows] ${file}: invalid JSON (${e.message})`);
      continue;
    }
    const problems = validateDefinition(d);
    if (problems.length) {
      console.warn(`[workflows] ${file}: skipped (${problems.join('; ')})`);
      continue;
    }
    defs.push(d);
  }
  return defs;
}

/**
 * Validate a workflow definition. Returns a list of human-readable problems
 * (empty means OK). Catches the handful of things the scheduler assumes:
 *   - id is a non-empty string
 *   - graph.nodes is a non-empty array of unique-id objects with a kind
 *   - graph.edges is an array of [from, to] (or [from, to, label]) pairs
 *     with both ids present
 *   - the graph is a DAG (no cycles reachable from any root)
 *
 * When `schemaVersion: 2` is set, each kind must be one of the v2 vocabulary
 * (agent, script, decision, check, publish, display, inputs, loop, delay,
 * approve) and the per-kind spec is lightly checked. Legacy definitions
 * (no schemaVersion) accept any string kind, preserving old files on disk.
 */
export const V2_KINDS = new Set([
  'agent', 'script', 'decision', 'check', 'publish', 'display',
  'inputs', 'loop', 'delay', 'approve',
]);

export function validateDefinition(d) {
  const problems = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (typeof d.id !== 'string' || !d.id.trim()) problems.push('missing id');
  const v2 = d.schemaVersion === 2;
  const nodes = d.graph?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    problems.push('graph.nodes is empty');
    return problems; // nothing else to check
  }
  const ids = new Set();
  const byId = {};
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') { problems.push('a node has no id'); continue; }
    if (ids.has(n.id))         problems.push(`duplicate node id: ${n.id}`);
    if (!n.kind)               problems.push(`node ${n.id}: missing kind`);
    if (v2 && n.kind && !V2_KINDS.has(n.kind)) {
      problems.push(`node ${n.id}: unknown kind "${n.kind}" (v2 kinds: ${[...V2_KINDS].join(', ')})`);
    }
    if (v2) {
      const kindProblems = validateV2Node(n);
      for (const p of kindProblems) problems.push(`node ${n.id}: ${p}`);
    }
    ids.add(n.id);
    byId[n.id] = n;
  }
  const edges = d.graph?.edges;
  if (!Array.isArray(edges)) {
    problems.push('graph.edges is not an array');
  } else {
    for (const e of edges) {
      if (!Array.isArray(e) || e.length < 2 || e.length > 3) {
        problems.push(`bad edge: ${JSON.stringify(e)}`); continue;
      }
      const [from, to] = e;
      if (!ids.has(from)) problems.push(`edge from unknown node: ${from}`);
      if (!ids.has(to))   problems.push(`edge to unknown node: ${to}`);
    }
    if (hasCycle(ids, edges)) problems.push('graph has a cycle');
    if (v2) {
      // Decision options must match the labels on its outgoing edges.
      for (const n of nodes) {
        if (n.kind !== 'decision') continue;
        const outgoing = edges.filter((e) => e?.[0] === n.id);
        const labelsOnEdges = new Set(outgoing.map((e) => e[2]).filter(Boolean));
        const labelsInSpec  = new Set((n.spec?.options || []).map((o) => o.edgeLabel).filter(Boolean));
        for (const l of labelsOnEdges) {
          if (!labelsInSpec.has(l)) problems.push(`node ${n.id}: edge label "${l}" is not in spec.options`);
        }
      }
    }
  }
  return problems;
}

/** Lightweight per-kind spec check for v2. One line per missing requirement. */
function validateV2Node(n) {
  const problems = [];
  const spec = n.spec || {};
  switch (n.kind) {
    case 'agent':
      if (!spec.prompt && !spec.promptTemplate) problems.push('spec.prompt is required');
      break;
    case 'script':
      if (!spec.cmd && !spec.op) problems.push('spec.cmd or spec.op is required');
      break;
    case 'decision':
      if (!spec.question) problems.push('spec.question is required');
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        problems.push('spec.options must be a non-empty array');
      }
      break;
    case 'check':
      if (!spec.assert || !spec.assert.type) problems.push('spec.assert.type is required');
      break;
    case 'publish':
      if (!spec.target) problems.push('spec.target is required');
      break;
    case 'display':
      if (!spec.render) problems.push('spec.render is required');
      if (!spec.from)   problems.push('spec.from (upstream node id or ids) is required');
      break;
    case 'inputs':
      if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
        problems.push('spec.fields must be a non-empty array');
      }
      break;
    case 'loop':
      if (!spec.over) problems.push('spec.over (upstream iterable) is required');
      break;
    case 'delay':
      if (!spec.wait) problems.push('spec.wait is required');
      break;
    case 'approve':
      if (!spec.question && !spec.prompt) problems.push('spec.question or spec.prompt is required');
      break;
  }
  return problems;
}

function hasCycle(ids, edges) {
  const out = Object.fromEntries([...ids].map((id) => [id, []]));
  for (const [a, b] of edges) if (out[a] && out[b]) out[a].push(b);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = Object.fromEntries([...ids].map((id) => [id, WHITE]));
  const dfs = (u) => {
    color[u] = GRAY;
    for (const v of out[u] || []) {
      if (color[v] === GRAY) return true;
      if (color[v] === WHITE && dfs(v)) return true;
    }
    color[u] = BLACK;
    return false;
  };
  for (const id of ids) if (color[id] === WHITE && dfs(id)) return true;
  return false;
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
    // Carry per-kind config through to the run copy so handlers can read it.
    spec: n.spec,
    model: n.model, prompt: n.prompt, command: n.command,
    question: n.question, choices: n.choices, route: n.route,
    status: 'pending', waitsFor: null, output: null,
    startedAt: null, endedAt: null,
  }));
  const run = {
    runId,
    workflowId,
    workflowTitle: def.title,
    category: def.category,
    scope: def.scope,
    // Record which schema the def used so the renderer can mark legacy runs.
    schemaVersion: def.schemaVersion || 1,
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

/* ---------------------------- Authoring --------------------------------- */

/**
 * A starter definition for `id`, ready to tweak. Three nodes wired in a line
 * so the file is immediately runnable and shows how edges work. Everything
 * downstream of the scaffold reads the same shape as a hand-written def.
 */
export function scaffoldWorkflow(id, { title, category = 'build', estimate = '~1 min' } = {}) {
  return {
    schemaVersion: 2,
    id,
    title: title || id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    category,
    estimate,
    desc: 'Describe what this workflow is for in one line.',
    inputs: [],
    graph: {
      nodes: [
        { id: 'brief',  title: 'Brief',  kind: 'agent',   col: 1, row: 0, cost: 1,
          spec: { model: 'haiku', output: 'markdown', prompt: 'Draft a brief for this workflow in Markdown.' } },
        { id: 'review', title: 'Review', kind: 'agent',   col: 2, row: 0, cost: 2,
          spec: { model: 'sonnet', output: 'json-findings', prompt: 'Review the brief for correctness, readability, architecture, security, performance.' } },
        { id: 'ship',   title: 'Ship',   kind: 'publish', col: 3, row: 0, cost: 1,
          spec: { target: 'pr' } },
      ],
      edges: [['brief', 'review'], ['review', 'ship']],
    },
  };
}

/**
 * Write a definition to disk at the right scope. Validates first; refuses to
 * overwrite an existing file unless `overwrite: true`. Returns the final path.
 */
export function writeWorkflow({ def, scope = 'project', repoRoot = null, overwrite = false }) {
  const problems = validateDefinition(def);
  if (problems.length) throw new Error(`workflow invalid: ${problems.join('; ')}`);
  const dir = scope === 'user' ? USER_WORKFLOWS_DIR
    : scope === 'project' ? (repoRoot ? repoWorkflowsDir(repoRoot) : null)
    : null;
  if (!dir) throw new Error(`unknown scope: ${scope}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${def.id}.json`);
  if (fs.existsSync(file) && !overwrite) {
    throw new Error(`a workflow with id "${def.id}" already exists at ${file}`);
  }
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
  return file;
}

/** Delete a run folder. Returns true if the folder existed. */
export function deleteRun(runId) {
  for (const base of [...knownRepoRoots().map(repoRunsDir), SCRATCH_RUNS_DIR]) {
    const dir = path.join(base, runId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
  }
  return false;
}

/**
 * Clone a finished run and start a new one. If `fromNodeId` is given, every
 * node upstream of it keeps its output and is marked done; the fromNode and
 * everything downstream start pending. Without a fromNodeId the whole graph
 * resets to pending — a full rerun with the same inputs.
 */
export function rerunRun(runId, { fromNodeId = null } = {}) {
  const prior = readRun(runId);
  if (!prior) throw new Error(`run not found: ${runId}`);
  const def = getDefinition(prior.workflowId, { repoRoot: prior.repoRoot });
  if (!def) throw new Error(`workflow not found: ${prior.workflowId}`);
  const newRunId = randomUUID();
  const now = new Date().toISOString();
  const preservedIds = fromNodeId
    ? collectAncestors(def.graph, fromNodeId)
    : new Set();
  const nodes = (def.graph.nodes || []).map((n) => {
    const prev = prior.graph?.nodes?.find((x) => x.id === n.id);
    const keep = preservedIds.has(n.id) && prev?.status === 'done';
    return {
      id: n.id, title: n.title, kind: n.kind,
      col: n.col, row: n.row, cost: n.cost,
      spec: n.spec,
      model: n.model, prompt: n.prompt, command: n.command,
      question: n.question, choices: n.choices, route: n.route,
      status: keep ? 'done' : 'pending',
      waitsFor: null,
      output: keep ? prev.output : null,
      startedAt: keep ? prev.startedAt : null,
      endedAt:   keep ? prev.endedAt   : null,
    };
  });
  const run = {
    runId: newRunId, workflowId: prior.workflowId,
    workflowTitle: def.title, category: def.category, scope: prior.scope,
    schemaVersion: def.schemaVersion || prior.schemaVersion || 1,
    status: 'running', trigger: `rerun of ${runId.slice(0, 8)}`,
    sessionId: prior.sessionId, repoRoot: prior.repoRoot,
    startedAt: now, endedAt: null,
    inputs: { ...(prior.inputs || {}) },
    graph: { nodes, edges: [...(def.graph.edges || [])] },
  };
  writeRun(run);
  return run;
}

function collectAncestors(graph, nodeId) {
  const parents = {};
  for (const n of graph.nodes || []) parents[n.id] = [];
  for (const [a, b] of graph.edges || []) if (parents[b]) parents[b].push(a);
  const seen = new Set();
  const walk = (id) => {
    for (const p of parents[id] || []) {
      if (seen.has(p)) continue;
      seen.add(p);
      walk(p);
    }
  };
  walk(nodeId);
  return seen;
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
export function knownRepoRoots() {
  const roots = new Set();
  for (const s of listSessions({ limit: 400 })) {
    if (s.cwd) roots.add(s.cwd);
  }
  return [...roots];
}
