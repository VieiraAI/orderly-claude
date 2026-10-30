/*
 * Workflow definitions and runs.
 *
 * Definitions are discovered from three places, nearest-wins:
 *   1. <repo>/.claude/workflows/*.{json,yaml,yml}          — repo-local
 *   2. ~/.claude/workflows/*.{json,yaml,yml}                — user-global
 *   3. built-ins shipped under src/core/workflow-defs/      — baseline catalog
 *
 * The Workflows page lists project workflows from every known repo, not just
 * the booted one (listAllDefinitions), so a project workflow is addressed by
 * scope + repo + id, never by id alone.
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
import { referenceFields, referencedNodes, ancestorsOf, parseRefs } from './refs.mjs';
import { readSettings } from './settings.mjs';
import { createWorktree } from './worktree.mjs';

const BUILTIN_DIR = fileURLToPath(new URL('./workflow-defs/', import.meta.url));

/* ------------------------------ Definitions ------------------------------ */

/** Return the merged catalog, nearest wins. `repoRoot` is optional. */
export function listDefinitions({ repoRoot } = {}) {
  const seen = new Map();
  const sources = [
    repoRoot ? { scope: 'project', dir: repoWorkflowsDir(repoRoot), root: path.resolve(repoRoot) } : null,
    { scope: 'user',    dir: USER_WORKFLOWS_DIR, root: null },
    { scope: 'builtin', dir: BUILTIN_DIR,        root: null },
  ].filter(Boolean);
  for (const src of sources) {
    for (const entry of readScope(src)) {
      if (seen.has(entry.id)) continue;
      seen.set(entry.id, entry);
    }
  }
  return [...seen.values()];
}

/*
 * The catalog the Workflows page shows. Orderly spans every project, so each
 * repo the sessions index knows about adds its own project workflows, tagged
 * with the repo they live in. The same id in two repos is two workflows.
 * The booted repo keeps its old precedence: its workflows still hide a user
 * or built-in one with the same id, as listDefinitions does. New ids are
 * unique everywhere (freeId, claimId), so only clashes made before that are
 * left, and each is marked with where the other one is.
 */
export function listAllDefinitions({ repoRoot } = {}) {
  const booted = repoRoot ? path.resolve(repoRoot) : null;
  const out = listDefinitions({ repoRoot: booted });
  for (const root of knownRepoRoots()) {
    if (root === booted) continue;
    out.push(...readScope({ scope: 'project', dir: repoWorkflowsDir(root), root }));
  }
  return markClashes(out, booted);
}

/** Every definition in one scope's folder, tagged with where it was found. */
function readScope({ scope, dir, root }) {
  return readDir(dir).map(({ def, problems, file }) => {
    const entry = {
      ...def, scope, source: dir, file,
      repoRoot: root, repoName: root ? path.basename(root) : null,
      // One string that names this workflow and no other, for the client.
      key: `${scope}:${root || ''}:${def.id}`,
    };
    // A definition that stopped validating stays listed, marked, so its
    // owner can open and fix it. Hiding it would look like it was deleted.
    if (problems.length) { entry.invalid = true; entry.problems = problems; }
    return entry;
  });
}

/** Fields that describe where a definition was found, not what it is. */
const RUNTIME_FIELDS = ['scope', 'source', 'file', 'invalid', 'problems', 'repoRoot', 'repoName', 'key', 'clash'];
export function stripRuntime(def) {
  const out = { ...def };
  for (const k of RUNTIME_FIELDS) delete out[k];
  return out;
}

/*
 * Find one definition. With a `scope`, look only in that scope's folder, so
 * a project workflow is found in its own repo and nowhere else. Without one,
 * nearest wins from `repoRoot`, as it always has.
 */
export function getDefinition(id, { repoRoot, scope } = {}) {
  if (scope) {
    const src = scope === 'project' ? (repoRoot ? { dir: repoWorkflowsDir(repoRoot), root: path.resolve(repoRoot) } : null)
      : scope === 'user' ? { dir: USER_WORKFLOWS_DIR, root: null }
      : scope === 'builtin' ? { dir: BUILTIN_DIR, root: null }
      : null;
    if (!src) return null;
    return readScope({ scope, ...src }).find((d) => d.id === id) || null;
  }
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
    if (!d || typeof d.id !== 'string' || !d.id.trim()) {
      console.warn(`[workflows] ${file}: skipped (no id)`);
      continue;
    }
    defs.push({ def: d, problems: validateDefinition(d), file });
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
  'inputs', 'loop', 'delay', 'approve', 'mcp',
]);

/** Checks an Ask Claude step can run on its own output. */
export const VERIFY_ASSERTS = new Set([
  'color-in-palette', 'font-is-brand', 'contrast-min', 'spacing-on-scale', 'no-raw-hex', 'llm-judge',
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
  if (d.files != null && (typeof d.files !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(d.files))) {
    problems.push('files must be a folder name: lower-case letters, digits and dashes');
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
    const cyclic = hasCycle(ids, edges);
    if (cyclic) problems.push('graph has a cycle');
    if (v2 && !cyclic) problems.push(...referenceProblems(d));
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
  problems.push(...guardrailProblems(d));
  return problems;
}

/**
 * A node may only name nodes upstream of it: anything else has not run yet
 * when it starts, so the reference would resolve to nothing.
 */
function referenceProblems(d) {
  const problems = [];
  const graph = d.graph;
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) {
    const upstream = ancestorsOf(n.id, graph);
    const named = new Set();
    for (const f of referenceFields(n)) for (const id of referencedNodes(f.value)) named.add([id, f.key]);
    if (n.kind === 'check' && n.spec?.assert?.from) named.add([n.spec.assert.from, 'assert.from']);
    if (n.kind === 'display') {
      for (const id of [].concat(n.spec?.from || []).filter(Boolean)) named.add([id, 'from']);
    }
    for (const [id, field] of named) {
      if (!ids.has(id)) problems.push(`node ${n.id}: ${field} names node "${id}", which does not exist`);
      else if (id === n.id) problems.push(`node ${n.id}: ${field} names itself`);
      else if (!upstream.has(id)) problems.push(`node ${n.id}: ${field} names "${id}", which is not upstream of it — connect ${id} → ${n.id} first`);
    }
  }
  return problems;
}

/** Limits that keep a workflow from running away with time or money. */
function guardrailProblems(d) {
  const problems = [];
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (d.budgetUsd != null && !(Number(d.budgetUsd) > 0)) problems.push('budgetUsd must be a positive amount');
  if (d.concurrency != null && !int(d.concurrency, 1, 16)) problems.push('concurrency must be 1–16');
  const keys = new Set();
  for (const f of d.inputs || []) {
    if (!f || !/^[A-Za-z_][\w-]*$/.test(f.key || '')) problems.push(`input "${f?.key ?? ''}": key must be a short name without spaces`);
    else if (keys.has(f.key)) problems.push(`input "${f.key}" is declared twice`);
    keys.add(f?.key);
  }
  for (const n of d.graph?.nodes || []) {
    const s = n.spec || {};
    if (s.timeoutMs != null && !int(s.timeoutMs, 1000, 3_600_000)) problems.push(`node ${n.id}: timeout must be between 1 second and 1 hour`);
    if (s.retry != null) {
      if (!int(s.retry.attempts ?? 0, 0, 5)) problems.push(`node ${n.id}: retries must be 0–5`);
      if (s.retry.backoffMs != null && !int(s.retry.backoffMs, 0, 600_000)) problems.push(`node ${n.id}: retry wait must be under 10 minutes`);
    }
    if (n.kind === 'loop') {
      if (s.max != null && !int(Number(s.max), 1, 500)) problems.push(`node ${n.id}: a loop may run at most 500 items`);
      if (s.concurrency != null && !int(Number(s.concurrency), 1, 8)) problems.push(`node ${n.id}: loop concurrency must be 1–8`);
    }
  }
  return problems;
}

/**
 * Things worth saying that do not stop a workflow from running. The editor
 * shows them; the scheduler ignores them.
 */
export function lintDefinition(d) {
  const warnings = [];
  const declared = new Set((d.inputs || []).map((f) => f.key));
  for (const n of d.graph?.nodes || []) {
    if (n.kind === 'inputs') for (const f of n.spec?.fields || []) declared.add(f.key);
  }
  const nodes = d.graph?.nodes || [];
  const edges = d.graph?.edges || [];
  for (const n of nodes) {
    for (const f of referenceFields(n)) {
      for (const r of parseRefs(f.value)) {
        if (r.kind === 'inputs' && !declared.has(r.key.split('.')[0])) {
          warnings.push(`node ${n.id}: {{inputs.${r.key}}} is not one of the workflow's inputs, so it will be empty unless someone supplies it`);
        }
        if (r.kind === 'item' && n.kind !== 'loop') warnings.push(`node ${n.id}: {{item}} only means something inside a loop`);
        if (r.kind === 'workflow' && !d.files) warnings.push(`node ${n.id}: {{workflow.files}} is empty unless the workflow names its files folder`);
      }
    }
    if (nodes.length > 1 && !edges.some((e) => e[0] === n.id || e[1] === n.id)) {
      warnings.push(`node ${n.id} is not connected to anything, so it runs on its own at the start`);
    }
  }
  return warnings;
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
        const hasRenders = Array.isArray(v.renders) && v.renders.length > 0;
        if (v.renders != null && !Array.isArray(v.renders)) problems.push('spec.verify.renders must be an array of routes');
        if (v.asserts != null && !Array.isArray(v.asserts)) problems.push('spec.verify.asserts must be an array');
        const asserts = Array.isArray(v.asserts) ? v.asserts : [];
        // Renders alone are a valid check: each page must load and not be blank.
        if (!asserts.length && !hasRenders) problems.push('spec.verify needs asserts or renders');
        for (const a of asserts) {
          if (!a || !a.type) { problems.push('spec.verify.asserts[].type is required'); continue; }
          if (!VERIFY_ASSERTS.has(a.type)) problems.push(`unknown verify assert type: ${a.type}`);
          if (a.type === 'llm-judge' && !a.rubric) problems.push('llm-judge needs a rubric');
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
      if (spec.join && !['concat', 'first-match', 'vote'].includes(spec.join)) {
        problems.push('spec.join must be one of: concat, first-match, vote');
      }
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
/*
 * A workflow can ship files its steps use, such as a script, in a folder
 * named by its `files` field beside its JSON. Steps reach it as
 * {{workflow.files}}. A copy saved elsewhere keeps the field, so it falls
 * back to the built-in folder of that name.
 */
export function filesDirOf(def) {
  if (!def?.files) return null;
  const places = [def.file ? path.join(path.dirname(def.file), def.files) : null, path.join(BUILTIN_DIR, def.files)];
  return places.find((p) => p && fs.existsSync(p) && fs.statSync(p).isDirectory()) || null;
}

export function startRun({
  workflowId, inputs = {}, repoRoot, scope = null, sessionId = null, trigger = 'you',
  budgetUsd, scheduleId = null, definition = null,
}) {
  const found = definition || getDefinition(workflowId, { repoRoot, scope });
  if (!found) throw new Error(`workflow not found: ${workflowId}`);
  // A project workflow runs in the repo it lives in, wherever Orderly was
  // started. Its scripts, sandbox and run history all belong to that repo.
  if (found.scope === 'project' && found.repoRoot) repoRoot = found.repoRoot;
  if (found.invalid) throw new Error(`"${found.title || workflowId}" needs fixing before it can run: ${found.problems.join('; ')}`);
  const def = stripRuntime(found);
  const settings = readSettings();
  const runId = randomUUID();
  // Sandbox: a worktree isolates filesystem edits from the main checkout.
  let sandboxPath = null;
  if (def.runtime?.sandbox === 'worktree') {
    if (!repoRoot) throw new Error('worktree sandbox requires a repoRoot');
    sandboxPath = createWorktree({
      repoRoot,
      name: `run-${runId.slice(0, 8)}`,
      baseBranch: def.runtime.baseBranch || null,
    }).path;
  }
  const run = {
    runId,
    workflowId,
    workflowTitle: def.title,
    category: def.category,
    scope: found.scope,
    // Record which schema the def used so the renderer can mark legacy runs.
    schemaVersion: def.schemaVersion || 1,
    // The graph as it was when this run began. Reruns and resumes read this,
    // never the file on disk, so editing a workflow cannot change a run.
    definition: def,
    definitionVersion: def.version || 1,
    status: 'running',
    trigger,
    scheduleId,
    sessionId,
    repoRoot: repoRoot || null,
    cwd: sandboxPath || repoRoot || null,
    filesDir: filesDirOf(found),
    sandboxPath,
    runtime: def.runtime || null,
    // The process driving this run. A run whose owner is gone was cut short.
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    inputs,
    budgetUsd: firstMoney(budgetUsd, def.budgetUsd, settings.budget.perRunUsd),
    concurrency: def.concurrency || settings.concurrency,
    graph: { nodes: withLessons(freshNodes(def), def.lessons), edges: [...(def.graph?.edges || [])] },
    cost: 0,
  };
  writeRun(run);
  return run;
}

/** Prepend live lessons (pinned or down-rated) to each matching node's prompt. */
function withLessons(nodes, lessons) {
  const byNode = groupLiveLessons(lessons || []);
  return nodes.map((n) => {
    // A lesson about the whole workflow goes to every Ask Claude step.
    const ls = [...(byNode[n.id] || []), ...(n.kind === 'agent' ? byNode['*'] || [] : [])];
    if (!ls.length) return n;
    const out = { ...n, lessonsApplied: ls.map((l) => l.id) };
    if (n.prompt) out.prompt = applyLessons(n.prompt, ls);
    if (n.spec?.prompt) out.spec = { ...n.spec, prompt: applyLessons(n.spec.prompt, ls) };
    return out;
  });
}

function firstMoney(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (v != null && v !== '' && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Every authored field on each node, plus the runtime fields, all reset. */
function freshNodes(def) {
  return (def.graph?.nodes || []).map((n) => ({
    ...structuredClone(n),
    status: 'pending', waitsFor: null, output: null,
    startedAt: null, endedAt: null, attempts: 0,
  }));
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
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(def.id)) throw new Error('id must be a short name of letters, numbers and dashes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${def.id}.json`);
  let prior = null;
  if (fs.existsSync(file)) {
    if (!overwrite) throw new Error(`a workflow with id "${def.id}" already exists at ${file}`);
    try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* replace a broken file */ }
  }
  const out = stripRuntime(def);
  // Each save is a new version, so a run can say which one it ran.
  out.version = prior ? Math.max(prior.version || 1, out.version || 1) + 1 : (out.version || 1);
  out.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Append a lesson to a definition. Creates a stable id if the caller did not
 * provide one. Returns { file, lesson }. Rejects for builtin defs — those are
 * read-only; copy them into project or user scope first.
 */
export function addLesson(workflowId, lesson, { repoRoot = null, scope = null } = {}) {
  const def = getDefinition(workflowId, { repoRoot, scope });
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
  const next = { ...stripRuntime(def), lessons };
  // Back into the file it came from, not a copy in whichever repo asked.
  const file = writeWorkflow({ def: next, scope: def.scope, repoRoot: def.repoRoot || repoRoot, overwrite: true });
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

/** Remove a workflow the person owns. Built-ins cannot be deleted. */
export function deleteWorkflow({ id, scope, repoRoot = null }) {
  const dir = scope === 'user' ? USER_WORKFLOWS_DIR
    : scope === 'project' && repoRoot ? repoWorkflowsDir(repoRoot) : null;
  if (!dir) throw new Error(scope === 'builtin' ? 'built-in workflows cannot be deleted' : `unknown scope: ${scope}`);
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/*
 * Every place Orderly lists workflows from, each read in full: every known
 * repo (plus `repoRoot`, which a CLI run may not have registered), the user
 * library and the built-ins. No nearest-wins here, so a workflow hidden by
 * another with its id still counts.
 */
function everyLocation(repoRoot = null) {
  const roots = knownRepoRoots();
  if (repoRoot && !roots.some((r) => sameDir(r, repoRoot))) roots.push(path.resolve(repoRoot));
  return [
    ...roots.map((root) => ({ scope: 'project', dir: repoWorkflowsDir(root), root })),
    { scope: 'user',    dir: USER_WORKFLOWS_DIR, root: null },
    { scope: 'builtin', dir: BUILTIN_DIR,        root: null },
  ];
}

function sameDir(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return !!a && !!b && real(a) === real(b);
}

/*
 * Which ids are in use, and where. A file name counts as well as the id
 * inside it, since a file whose id differs from its name still blocks that
 * name from being written.
 */
function idIndex(repoRoot = null) {
  const byId = new Map();
  const add = (id, loc) => {
    const list = byId.get(id) || [];
    if (!list.some((l) => l.dir === loc.dir)) list.push(loc);
    byId.set(id, list);
  };
  for (const src of everyLocation(repoRoot)) {
    const loc = { scope: src.scope, dir: src.dir, repoRoot: src.root, repoName: src.root ? path.basename(src.root) : null };
    for (const { def } of readDir(src.dir)) add(def.id, loc);
    let names = [];
    try { names = fs.readdirSync(src.dir); } catch { /* no folder, no ids */ }
    for (const n of names) if (n.endsWith('.json')) add(n.slice(0, -5), loc);
  }
  return byId;
}

/** How a location reads in a message: "the shop project", "your library". */
export function whereWord(loc) {
  return loc.scope === 'project' ? `the ${loc.repoName || 'other'} project`
    : loc.scope === 'user' ? 'your library' : 'the built-ins';
}

/** The tail a clashing id gets in a scope: the repo's folder name, or "mine". */
function idSuffix(scope, repoRoot) {
  if (scope === 'user') return 'mine';
  return String(path.basename(repoRoot || '') || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export const cleanId = (base) => String(base || 'workflow').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';

/*
 * An id no workflow anywhere uses yet, built from `base`. Ids are unique
 * across every repo, the user library and the built-ins, so one id always
 * names one workflow. A clash becomes <id>-<repo> in a project, <id>-mine in
 * the user library, then -2, -3 … if that is taken too.
 */
export function freeId(base, { scope = 'user', repoRoot = null, index = null } = {}) {
  const taken = index || idIndex(scope === 'project' ? repoRoot : null);
  const clean = cleanId(base);
  if (!taken.has(clean)) return clean;
  const suffix = idSuffix(scope, repoRoot);
  // A copy of "deploy-shop" made in shop is "deploy-shop-2", not "deploy-shop-shop".
  const stem = clean.endsWith(`-${suffix}`) ? clean : `${clean}-${suffix}`;
  let id = stem, i = 2;
  while (taken.has(id)) id = `${stem}-${i++}`;
  return id;
}

/*
 * Check that `id` can be written to `scope` without two workflows sharing
 * it. Saving a workflow over its own file is always fine, even if an older
 * clash means the id is used elsewhere too. Otherwise any other workflow
 * with the id, anywhere, refuses the write with a free id suggested.
 * Throws an error with status 409, `suggestedId`, `takenBy`, and `own` when
 * the clash is a file of that name in the same folder.
 */
export function claimId(id, { scope = 'project', repoRoot = null, overwrite = false } = {}) {
  const dir = scope === 'user' ? USER_WORKFLOWS_DIR : scope === 'project' && repoRoot ? repoWorkflowsDir(repoRoot) : null;
  if (!dir) return;
  const own = fs.existsSync(path.join(dir, `${id}.json`));
  if (own && overwrite) return;
  const index = idIndex(scope === 'project' ? repoRoot : null);
  const others = (index.get(id) || []).filter((l) => own || !sameDir(l.dir, dir));
  if (!others.length) return;
  const suggestedId = freeId(id, { scope, repoRoot, index });
  const msg = own ? `a workflow with id "${id}" already exists at ${path.join(dir, `${id}.json`)}`
    : `the id "${id}" is already used by a workflow in ${others.map(whereWord).join(' and ')}`;
  throw Object.assign(new Error(msg), { status: 409, own, suggestedId, takenBy: others.map(({ dir: _d, ...l }) => l) });
}

/*
 * Mark workflows that share an id with another one on disk. These clashes
 * come from before ids were unique; both keep working by scope + repo, but
 * each says where the other is and which id it could move to. Nothing is
 * renamed for the person: other repos are theirs to change.
 */
export function markClashes(entries, repoRoot = null) {
  const index = idIndex(repoRoot);
  for (const e of entries) {
    const others = (index.get(e.id) || []).filter((l) => !sameDir(l.dir, e.source));
    if (!others.length) continue;
    // A built-in cannot be renamed; the suggestion goes on the other side.
    const mover = e.scope === 'builtin' ? others.find((o) => o.scope !== 'builtin') : null;
    const suggestedId = e.scope === 'builtin' ? null : freeId(e.id, { scope: e.scope, repoRoot: e.repoRoot, index });
    const rename = suggestedId ? ` Rename this one to "${suggestedId}" so the two cannot be mixed up.`
      : mover ? ` Rename the one in ${whereWord(mover)} to "${freeId(e.id, { scope: mover.scope, repoRoot: mover.repoRoot, index })}" so the two cannot be mixed up.` : '';
    e.clash = {
      with: others.map(({ dir: _d, ...l }) => l),
      suggestedId,
      message: `"${e.id}" is also used by a workflow in ${others.map(whereWord).join(' and ')}.${rename}`,
    };
  }
  return entries;
}

/**
 * Copy any workflow — a built-in included — into the person's own library,
 * where they can change it. This is the easiest way to make one: start from
 * something that works.
 */
export function duplicateWorkflow(id, { repoRoot = null, scope = 'user', fromScope = null } = {}) {
  const src = getDefinition(id, { repoRoot, scope: fromScope });
  if (!src) throw new Error(`workflow not found: ${id}`);
  const copy = stripRuntime(structuredClone(src));
  // A built-in keeps its id as the base, so the copy is <id>-mine or
  // <id>-<repo> and no longer hides the built-in it came from.
  copy.id = freeId(src.scope === 'builtin' ? id : `${id}-copy`, { scope, repoRoot });
  copy.title = src.scope === 'builtin' ? `${src.title} (yours)` : `${src.title} (copy)`;
  copy.version = 1;
  copy.derivedFrom = { id: src.id, scope: src.scope, version: src.version || 1 };
  const file = writeWorkflow({ def: copy, scope, repoRoot, overwrite: false });
  return { def: copy, file };
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
  // The graph this run actually ran. Only runs from before definitions were
  // pinned fall back to the file, which may since have changed.
  const def = prior.definition || getDefinition(prior.workflowId, { repoRoot: prior.repoRoot });
  if (!def) throw new Error(`workflow not found: ${prior.workflowId}`);
  if (def.invalid) throw new Error(`"${def.title || prior.workflowId}" needs fixing before it can run: ${def.problems.join('; ')}`);
  const newRunId = randomUUID();
  const now = new Date().toISOString();
  const preservedIds = fromNodeId
    ? collectAncestors(def.graph, fromNodeId)
    : new Set();
  const nodes = freshNodes(def).map((n) => {
    const prev = prior.graph?.nodes?.find((x) => x.id === n.id);
    const keep = preservedIds.has(n.id) && prev?.status === 'done';
    return keep
      ? { ...n, status: 'done', output: prev.output, startedAt: prev.startedAt, endedAt: prev.endedAt, attempts: prev.attempts || 1 }
      : n;
  });
  const run = {
    runId: newRunId, workflowId: prior.workflowId,
    workflowTitle: def.title, category: def.category, scope: prior.scope,
    schemaVersion: def.schemaVersion || prior.schemaVersion || 1,
    definition: def,
    definitionVersion: def.version || prior.definitionVersion || 1,
    status: 'running', trigger: `rerun of ${runId.slice(0, 8)}`,
    rerunOf: runId,
    sessionId: prior.sessionId, repoRoot: prior.repoRoot,
    ownerPid: process.pid,
    startedAt: now, endedAt: null,
    inputs: { ...(prior.inputs || {}) },
    budgetUsd: prior.budgetUsd ?? null,
    concurrency: prior.concurrency || readSettings().concurrency,
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

/*
 * Parsed run files, keyed by path and invalidated by mtime and size. The Runs
 * page lists every run on every change event, and re-parsing hundreds of
 * files, some holding whole HTML mockups, each time is what would make it
 * slow first. Entries are shared: change one only on the way to writeRun.
 */
const runCache = new Map();

function cachedRun(file) {
  let st;
  try { st = fs.statSync(file); } catch { runCache.delete(file); return null; }
  const hit = runCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.run;
  const run = parse(file);
  if (run) runCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, run });
  return run;
}

function collectRuns(dir, repoRoot, out) {
  let kids;
  try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const k of kids) {
    if (!k.isDirectory()) continue;
    const run = cachedRun(path.join(dir, k.name, 'run.json'));
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
  const all = new Set(extraRoots);
  for (const s of listSessions({ limit: 400 })) {
    if (s.cwd) all.add(path.resolve(s.cwd));
  }
  // One folder can be known by two paths (/tmp and /private/tmp on macOS, or
  // a symlink); read it once, or every run and prompt in it shows twice.
  const byReal = new Map();
  for (const root of all) {
    let real = root;
    try { real = fs.realpathSync(root); } catch { /* gone; keep the path as given */ }
    if (!byReal.has(real)) byReal.set(real, root);
  }
  return [...byReal.values()];
}

/*
 * Folders to search even if Claude Code has never run in them: the project
 * being watched, and the one Orderly was started from. Without this, a run
 * started in a fresh project was written to disk and then never listed, and
 * that project's prompts and skills were invisible.
 */
const extraRoots = new Set();
export function registerRoot(dir) {
  if (dir && typeof dir === 'string') extraRoots.add(path.resolve(dir));
}

/* ------------------------- Interruption and resume ------------------------ */

const LIVE = new Set(['running', 'awaiting-answer']);
/** Statuses a person can pick back up from. */
export const RESUMABLE = new Set(['interrupted', 'stopped', 'failed']);

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Runs marked live whose owning process is gone were cut short — a crash, a
 * closed laptop, a killed terminal. Left alone they say `running` for ever
 * with nothing driving them. Mark them `interrupted`, naming where they
 * stopped, so the Runs page can offer Resume.
 *
 * A run owned by another Orderly that is still alive is left alone: several
 * can run at once, one per session.
 */
export function reconcileRuns({ ownedHere = new Set() } = {}) {
  const fixed = [];
  for (const run of listRuns({ limit: 5000 })) {
    if (!LIVE.has(run.status) || ownedHere.has(run.runId)) continue;
    if (run.ownerPid && run.ownerPid !== process.pid && pidAlive(run.ownerPid)) continue;
    markInterrupted(run, 'Orderly was closed while this was running');
    writeRun(run);
    fixed.push(run.runId);
  }
  return fixed;
}

/** Shared by reconcile and by a clean shutdown. Mutates `run`. */
export function markInterrupted(run, reason) {
  const at = new Date().toISOString();
  const cut = [];
  for (const n of run.graph?.nodes || []) {
    if (n.status === 'running') { n.status = 'interrupted'; n.endedAt = at; n.progress = undefined; cut.push(n.id); }
  }
  run.status = 'interrupted';
  run.endedAt = at;
  run.interruption = { at, reason, nodes: cut };
  return run;
}

/** Nodes that do something it would be wrong to repeat by accident. */
export function repeatRisky(node) {
  return node?.spec?.idempotent === false;
}

/**
 * Put an interrupted, stopped or failed run back into a state the scheduler
 * can carry on from. Finished nodes keep their output and are not run again.
 *
 * A node marked `idempotent: false` that had already started is not decided
 * for the person: `choices[nodeId]` must say `repeat` (run it again) or
 * `assume-done` (it got far enough; carry on after it). Without a choice this
 * returns `needsChoice` and changes nothing.
 */
export function prepareResume(run, { choices = {}, budgetUsd } = {}) {
  if (!RESUMABLE.has(run.status)) throw new Error(`a ${run.status} run cannot be resumed`);
  const needsChoice = [];
  for (const n of run.graph.nodes) {
    const started = !!n.startedAt && !['done', 'skipped', 'pending'].includes(n.status);
    if (started && repeatRisky(n) && !['repeat', 'assume-done'].includes(choices[n.id])) {
      needsChoice.push({ nodeId: n.id, title: n.title, kind: n.kind, command: n.spec?.cmd || null });
    }
  }
  if (needsChoice.length) return { needsChoice };

  const at = new Date().toISOString();
  for (const n of run.graph.nodes) {
    // A failed gate is re-checked rather than waved through on resume.
    const failedGate = n.kind === 'check' && n.status === 'done' && n.output?.pass === false
      && (n.spec?.onFail || 'stop') === 'stop';
    if (choices[n.id] === 'assume-done' && n.status !== 'done') {
      Object.assign(n, { status: 'done', endedAt: at, output: { ...(n.output || {}), note: 'Not repeated on resume — you said it had already happened.' } });
    } else if (failedGate || ['running', 'interrupted', 'failed', 'stopped'].includes(n.status)) {
      // Keep the question a person may already have answered while the run
      // was down; drop everything else the node half-produced.
      const pendingAnswer = n.pendingAnswer;
      Object.assign(n, { status: 'pending', output: null, startedAt: null, endedAt: null, progress: undefined, waitsFor: null });
      if (pendingAnswer !== undefined) n.pendingAnswer = pendingAnswer;
    }
  }
  run.status = 'running';
  run.endedAt = null;
  run.ownerPid = process.pid;
  run.resumes = (run.resumes || 0) + 1;
  run.lastResumedAt = at;
  delete run.halt;
  if (budgetUsd != null) {
    const b = Number(budgetUsd);
    if (!(b > 0)) throw new Error('the new limit must be a positive amount');
    run.budgetUsd = b;
  }
  return { run };
}

/*
 * Redo one step of a run, in the same run.
 *
 *   alone   the step runs again. Later steps that finished keep what they
 *           made (the run page says they are out of date); later steps that
 *           had not finished wait for it again.
 *   onward  the step and every step after it run again.
 *
 * Returns the ids reset to pending. Throws, changing nothing, when the step
 * cannot be redone.
 */
export const REDO_MODES = new Set(['alone', 'onward']);

export function resetForRedo(run, nodeId, mode) {
  if (!REDO_MODES.has(mode)) throw new Error(`mode must be one of: ${[...REDO_MODES].join(', ')}`);
  const nodes = run.graph?.nodes || [];
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) throw new Error(`no step "${nodeId}" in this run`);
  if (target.status === 'pending') throw new Error(`"${target.title || nodeId}" has not run yet`);
  if (target.status === 'skipped') throw new Error(`"${target.title || nodeId}" was skipped: the run took another branch`);
  const later = descendantsOf(run.graph, nodeId);
  const reset = [nodeId, ...nodes
    .filter((n) => later.has(n.id) && (mode === 'onward' || n.status !== 'done'))
    .map((n) => n.id)];
  for (const id of reset) {
    const n = nodes.find((x) => x.id === id);
    for (const k of ['progress', 'pendingAnswer', 'sent', 'lastError', 'durationMs']) delete n[k];
    Object.assign(n, { status: 'pending', waitsFor: null, output: null, startedAt: null, endedAt: null, attempts: 0 });
  }
  return reset;
}

function descendantsOf(graph, nodeId) {
  const seen = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.shift();
    for (const [a, b] of graph?.edges || []) if (a === id && !seen.has(b)) { seen.add(b); queue.push(b); }
  }
  return seen;
}

/**
 * Redo a step of a run nothing is running: reset it as resetForRedo does,
 * then carry on as a resume would. Works on a finished run too. Returns
 * { run } or { needsChoice }, as prepareResume does, without touching `run`
 * when it cannot go ahead.
 */
export function prepareRedo(run, nodeId, mode, { choices = {} } = {}) {
  const copy = structuredClone(run);
  resetForRedo(copy, nodeId, mode);
  // A finished run has nothing left to resume; the reset gave it something.
  if (!RESUMABLE.has(copy.status)) copy.status = 'stopped';
  const prepared = prepareResume(copy, { choices });
  if (prepared.needsChoice) return prepared;
  prepared.run.redos = [...(run.redos || []), { nodeId, mode, at: new Date().toISOString() }];
  return prepared;
}

/** The node currently waiting on a person, if any. */
export function openQuestion(run) {
  const n = (run?.graph?.nodes || []).find((x) =>
    (x.status === 'running' || x.status === 'interrupted') && x.waitsFor === 'you');
  if (!n) return null;
  const o = n.output || {};
  return { nodeId: n.id, title: n.title, kind: n.kind, question: o.question || n.title, choices: o.choices || null };
}

/**
 * Record an answer in the run file, whether or not anything is running it.
 * The scheduler reads it back when the node runs, so a question can be
 * answered after a restart, or tomorrow.
 */
export function recordAnswer(run, nodeId, answer) {
  const n = run.graph.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`no node "${nodeId}" in this run`);
  if (n.waitsFor !== 'you') throw new Error(`"${n.title || nodeId}" is not waiting for an answer`);
  const choices = n.output?.choices;
  if (Array.isArray(choices) && choices.length && !choices.includes(answer)) {
    throw new Error(`answer must be one of: ${choices.join(', ')}`);
  }
  if (answer === undefined || answer === null || String(answer).trim() === '') throw new Error('an answer is required');
  n.pendingAnswer = answer;
  return n;
}
