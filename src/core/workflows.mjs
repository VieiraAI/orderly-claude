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
import { createWorktree } from './worktree.mjs';

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
  'inputs', 'loop', 'delay', 'approve', 'fanOut', 'mcp',
]);

export function validateDefinition(d) {
  const problems = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (typeof d.id !== 'string' || !d.id.trim()) problems.push('missing id');
  if (d.lessons != null) {
    if (!Array.isArray(d.lessons)) problems.push('lessons must be an array');
    else for (const [i, l] of d.lessons.entries()) {
      if (!l || typeof l !== 'object') { problems.push(`lessons[${i}] not an object`); continue; }
      if (typeof l.note !== 'string' || !l.note.trim()) problems.push(`lessons[${i}].note is required`);
      if (l.rating && l.rating !== 'up' && l.rating !== 'down') problems.push(`lessons[${i}].rating must be up|down`);
    }
  }
  if (d.tags != null) {
    if (!Array.isArray(d.tags) || !d.tags.every((t) => typeof t === 'string')) {
      problems.push('tags must be an array of strings');
    }
  }
  if (d.whenToUse != null && typeof d.whenToUse !== 'string') {
    problems.push('whenToUse must be a string');
  }
  if (d.runtime != null) {
    if (typeof d.runtime !== 'object') problems.push('runtime must be an object');
    else {
      const sandboxes = new Set(['inplace', 'worktree']);
      if (d.runtime.sandbox && !sandboxes.has(d.runtime.sandbox)) {
        problems.push(`runtime.sandbox must be one of: ${[...sandboxes].join(', ')}`);
      }
      if (d.runtime.keepOnFail != null && typeof d.runtime.keepOnFail !== 'boolean') {
        problems.push('runtime.keepOnFail must be a boolean');
      }
      if (d.runtime.baseBranch != null && typeof d.runtime.baseBranch !== 'string') {
        problems.push('runtime.baseBranch must be a string');
      }
    }
  }
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
    case 'agent': {
      if (!spec.prompt && !spec.promptTemplate) problems.push('spec.prompt is required');
      if (spec.verify) {
        const v = spec.verify;
        if (!Array.isArray(v.asserts) || v.asserts.length === 0) {
          problems.push('spec.verify.asserts must be a non-empty array');
        } else {
          const knownAssert = new Set([
            'exit-zero', 'has-pairs', 'contains', 'manual',
            'color-in-palette', 'font-is-brand', 'contrast-min', 'spacing-on-scale', 'no-raw-hex', 'llm-judge',
          ]);
          for (const a of v.asserts) {
            if (!a || !a.type) { problems.push('spec.verify.asserts[].type is required'); continue; }
            if (!knownAssert.has(a.type)) problems.push(`unknown verify assert type: ${a.type}`);
          }
        }
        if (v.maxRetries != null && (!Number.isInteger(v.maxRetries) || v.maxRetries < 0)) {
          problems.push('spec.verify.maxRetries must be a non-negative integer');
        }
      }
      break;
    }
    case 'script':
      if (!spec.cmd && !spec.op) problems.push('spec.cmd or spec.op is required');
      break;
    case 'decision':
      if (!spec.question) problems.push('spec.question is required');
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        problems.push('spec.options must be a non-empty array');
      }
      break;
    case 'check': {
      if (!spec.assert || !spec.assert.type) { problems.push('spec.assert.type is required'); break; }
      const t = spec.assert.type;
      const known = new Set([
        'exit-zero', 'has-pairs', 'contains', 'manual',
        'color-in-palette', 'font-is-brand', 'contrast-min', 'spacing-on-scale', 'no-raw-hex',
      ]);
      if (!known.has(t)) problems.push(`unknown assert type: ${t}`);
      if (t === 'contains' && !spec.assert.needle) problems.push('spec.assert.needle is required for contains');
      if (t === 'contrast-min' && spec.assert.ratio != null && !(spec.assert.ratio > 0)) {
        problems.push('spec.assert.ratio must be positive');
      }
      break;
    }
    case 'publish': {
      if (!spec.target) problems.push('spec.target is required');
      const known = new Set(['pr', 'file', 'linear-issue', 'notion-page', 'figma-comment', 'github-issue']);
      if (spec.target && !known.has(spec.target)) {
        problems.push(`unknown publish target: ${spec.target}`);
      }
      break;
    }
    case 'mcp':
      if (!spec.server) problems.push('spec.server is required');
      if (!spec.tool) problems.push('spec.tool is required');
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
    case 'fanOut': {
      if (!spec.over) problems.push('spec.over (upstream iterable) is required');
      const action = spec.action || (spec.body?.cmd ? 'script' : (spec.body?.prompt ? 'agent' : null));
      if (!action) problems.push('spec.action (script|agent) or spec.body.{cmd|prompt} is required');
      if (action === 'script' && !spec.body?.cmd && !spec.cmd) problems.push('fanOut script needs spec.body.cmd');
      if (action === 'agent'  && !spec.body?.prompt && !spec.prompt) problems.push('fanOut agent needs spec.body.prompt');
      const joins = new Set(['concat', 'first-match', 'vote']);
      if (spec.join && !joins.has(spec.join)) problems.push(`spec.join must be one of: ${[...joins].join(', ')}`);
      if (spec.concurrency != null && (!Number.isInteger(spec.concurrency) || spec.concurrency < 1)) {
        problems.push('spec.concurrency must be a positive integer');
      }
      break;
    }
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
  // Sandbox: a worktree isolates filesystem edits from the main checkout.
  let sandboxPath = null;
  if (def.runtime?.sandbox === 'worktree') {
    if (!repoRoot) throw new Error('worktree sandbox requires a repoRoot');
    const { path: p } = createWorktree({
      repoRoot,
      name: `run-${runId.slice(0, 8)}`,
      baseBranch: def.runtime.baseBranch || null,
    });
    sandboxPath = p;
  }
  // Live lessons are those pinned or down-rated. Pre-group them by target
  // node id so each node's prompt only grows by its own history.
  const liveLessonsByNode = groupLiveLessons(def.lessons || []);
  const nodes = (def.graph?.nodes || []).map((n) => {
    const lessons = liveLessonsByNode[n.id] || [];
    const prompt = lessons.length ? applyLessons(n.prompt, lessons) : n.prompt;
    const spec = lessons.length && n.spec && n.spec.prompt
      ? { ...n.spec, prompt: applyLessons(n.spec.prompt, lessons) }
      : n.spec;
    return {
      id: n.id, title: n.title, kind: n.kind,
      col: n.col, row: n.row, cost: n.cost,
      spec,
      model: n.model, prompt, command: n.command,
      question: n.question, choices: n.choices, route: n.route,
      status: 'pending', waitsFor: null, output: null,
      startedAt: null, endedAt: null,
      lessonsApplied: lessons.length ? lessons.map((l) => l.id) : undefined,
    };
  });
  const run = {
    runId,
    workflowId,
    workflowTitle: def.title,
    category: def.category,
    scope: def.scope,
    schemaVersion: def.schemaVersion || 1,
    status: 'running',
    trigger,
    sessionId,
    repoRoot: repoRoot || null,
    cwd: sandboxPath || repoRoot || null,
    sandboxPath,
    runtime: def.runtime || null,
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

/**
 * Append a lesson to a definition. Creates a stable id if the caller did not
 * provide one. Returns { file, lesson }. Rejects for builtin defs — those are
 * read-only; copy them into project or user scope first.
 */
export function addLesson(workflowId, lesson, { repoRoot = null } = {}) {
  const def = getDefinition(workflowId, { repoRoot });
  if (!def) throw new Error(`workflow not found: ${workflowId}`);
  if (def.scope === 'builtin') throw new Error('cannot add lesson to a builtin workflow; save it to project scope first');
  const l = {
    id: lesson.id || `ls_${randomUUID().slice(0, 8)}`,
    node: lesson.node || null,
    note: String(lesson.note || '').trim(),
    rating: lesson.rating === 'up' || lesson.rating === 'down' ? lesson.rating : null,
    pin: !!lesson.pin,
    fromRun: lesson.fromRun || null,
    at: new Date().toISOString(),
  };
  if (!l.note) throw new Error('lesson.note is required');
  const lessons = Array.isArray(def.lessons) ? [...def.lessons] : [];
  lessons.push(l);
  const next = { ...def, lessons };
  delete next.scope; delete next.source; // these are runtime annotations, not fields on disk
  const file = writeWorkflow({ def: next, scope: def.scope, repoRoot, overwrite: true });
  return { file, lesson: l };
}

/** Lessons that influence the next run: pinned, or rated down. */
function groupLiveLessons(lessons) {
  const by = {};
  for (const l of lessons || []) {
    if (!l || !l.note) continue;
    if (!l.pin && l.rating !== 'down') continue;
    const key = l.node || '*';
    (by[key] = by[key] || []).push(l);
  }
  return by;
}

/** Prepend a Prior lessons block to a prompt. Idempotent per lesson id. */
function applyLessons(prompt, lessons) {
  if (!lessons?.length) return prompt;
  const header = '# Prior lessons';
  const body = lessons.map((l) => `- (${l.rating || 'note'}) ${l.note}`).join('\n');
  return `${header}\n${body}\n\n${prompt || ''}`.trim();
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
