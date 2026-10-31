/*
 * Visual workflow editor. Nodes are draggable cards on a dot-grid canvas,
 * edges are SVG curves between card edges. The header holds the workflow's
 * identity, Add node, and save; the sidebar opens for the selected step or
 * for the workflow's settings, and gets out of the way otherwise. A JSON
 * mode swaps the canvas for the raw def as an escape hatch.
 *
 * The people using this did not write Orderly, so every field the engine
 * reads has a control here, named for what it does, and nothing here opens a
 * browser dialog: they block automation and read worse than saying it inline.
 *
 * Node coordinates are stored on the def as `col`/`row`. The editor keeps
 * pixel positions in parallel so dragging is smooth and the saved def
 * reflects what the user placed on screen (snapped to a 20px grid).
 */
import { mountAssistant } from '/assistant.mjs';
import {
  bindRunView, setRun, KIND_LABEL, cardBody, cardClick, cardFootMeta, previewOf, openPreview,
  renderNotice, renderAnswer, renderRetro, renderRunActions, renderTimeline, openDrawer, refreshRedo,
  outOfDate, runSeconds, fmtSeconds, money,
} from '/run-view.mjs';

const $ = (id) => document.getElementById(id);
const COL_W = 240, ROW_H = 180, GUTTER = 60;

const KIND_GLYPH = {
  // legacy
  document: '📄', report: '✎', mockup: '▦', diff: '±',
  shots: '◫', 'shots-set': '▦▦', terminal: '>_', ask: '?', pr: '↑',
  // v2
  agent: '◆', script: '>_', decision: '◇', check: '✓',
  publish: '↑', display: '▦', inputs: '≡',
  loop: '↻', delay: '◷', approve: '✓', workflow: '⧉',
};

/** What each kind does, said plainly. Order is the order offered. */
const KINDS = {
  agent:    { name: 'Ask Claude',        desc: 'Claude does a piece of thinking or writing' },
  script:   { name: 'Run a command',     desc: 'A shell command in the project, or a screenshot' },
  decision: { name: 'Ask me to choose',  desc: 'You pick; only that branch runs' },
  approve:  { name: 'Ask me to approve', desc: 'Waits for you; reject ends the run' },
  check:    { name: 'Check',             desc: 'Stops the run if something is wrong' },
  loop:     { name: 'Repeat for each',   desc: 'Does one thing per item in a list' },
  workflow: { name: 'Run a workflow',    desc: 'Runs another workflow as one step, and hands on what it made' },
  publish:  { name: 'Save or publish',   desc: 'Writes a file, or drafts a PR' },
  display:  { name: 'Show together',     desc: 'Gathers earlier results side by side' },
  delay:    { name: 'Wait',              desc: 'Pauses for a set time' },
  inputs:   { name: 'Ask for inputs',    desc: 'Fields filled in when the run starts' },
};
const LEGACY = { document: 'Document', report: 'Report', mockup: 'Mockup', diff: 'Diff', shots: 'Screenshot',
  'shots-set': 'Screenshots', terminal: 'Terminal', ask: 'Question', pr: 'Pull request' };

/** Starter spec per v2 kind so a freshly-added node is immediately valid. */
const KIND_SPEC_DEFAULT = {
  agent:    () => ({ model: 'sonnet', output: 'markdown', prompt: '' }),
  script:   () => ({ cmd: '' }),
  decision: () => ({ question: 'Which way?', options: [{ label: 'Yes', edgeLabel: 'yes' }, { label: 'No', edgeLabel: 'no' }] }),
  check:    () => ({ assert: { type: 'exit-zero', from: '' } }),
  publish:  () => ({ target: 'file', path: 'outputs/result.md' }),
  display:  () => ({ render: 'markdown', from: [] }),
  inputs:   () => ({ fields: [{ key: 'topic', label: 'Topic', type: 'text' }] }),
  loop:     () => ({ over: '{{inputs.items}}', action: 'agent', prompt: 'Do this for {{item}}.', max: 20, concurrency: 2 }),
  delay:    () => ({ wait: '30s' }),
  approve:  () => ({ question: 'Does this look right?' }),
  workflow: () => ({ workflow: '', inputs: {} }),
};

const CHECK_TYPES = [
  ['exit-zero', 'a command succeeded'],
  ['contains', 'an output contains some text'],
  ['has-pairs', 'screenshots were taken of real pages'],
  ['manual', 'I say it looks right'],
  ['color-in-palette', 'its colours are on brand'],
  ['font-is-brand', 'it uses the brand font'],
  ['contrast-min', 'its text is easy to read (contrast)'],
  ['spacing-on-scale', 'its spacing follows the scale'],
  ['no-raw-hex', 'no colours are typed in by hand'],
];
const BRAND_CHECKS = new Set(['color-in-palette', 'font-is-brand', 'contrast-min', 'spacing-on-scale', 'no-raw-hex']);
// What an Ask Claude step can check about its own result.
const VERIFY_CHECKS = [
  ['color-in-palette', 'Colours are on brand'],
  ['font-is-brand', 'Uses the brand font'],
  ['contrast-min', 'Text is easy to read (contrast 4.5 : 1)'],
  ['spacing-on-scale', 'Spacing follows the scale'],
  ['no-raw-hex', 'No colours typed in by hand'],
];

const SCOPE_HINT = {
  user: 'Kept in your own library (~/.claude/workflows), so it follows you into every project. It runs in whichever project is open when you start it.',
  project: 'Kept inside the project (.claude/workflows), and always runs there. Commit it to share it with whoever works on the project.',
  home: 'This is your home folder, not a project. A workflow kept here runs here, so its commands will not find your project. Pick the project instead.',
};

const state = {
  zoom: 1,
  def: null,
  loaded: null,        // { id, scope } once it exists on disk
  builtin: false,
  selectedId: null,
  connectFromId: null,
  side: null,          // 'settings' when the sidebar shows the workflow
  mode: 'visual',
  dirty: false,
  idTouched: false,
  problems: [],
  warnings: [],
  skills: [],
  refField: null,      // the field a reference will be inserted into
  run: null,           // the run shown on the canvas, if any
  runId: null,
  runMeta: {},
  grid: null,          // column and row starts while a run sizes the cards
  dragging: false,
  expanded: new Set(), // "Run a workflow" steps opened up to show their own steps
  childRuns: {},       // step id → the run it started, while it is opened up
};

/* ---------------------------------- init --------------------------------- */

async function boot() {
  // /workflow-editor.html?from=<id> loads an existing def into the editor so
  // "Edit" on a workflow's preview page lands you in a prefilled editor.
  const q = new URLSearchParams(location.search);
  let from = q.get('from') || q.get('id');
  let scope = q.get('scope'), repo = q.get('repo');
  // ?run=<id> shows that run on its workflow's canvas; alone, it names the workflow too.
  const runId = q.get('run');
  const shown = runId ? await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json()).catch(() => ({})) : null;
  if (runId && !shown?.run) toast('That run is not there any more — it may have been deleted.', 'err', 0);
  if (shown?.run && !from) {
    from = shown.run.workflowId;
    if (shown.run.scope === 'project' && shown.run.repoRoot) { scope = 'project'; repo = shown.run.repoRoot; }
  }
  // scope + repo name a workflow from another project; see refQuery.
  if (from) await loadExisting(from, { scope, repo, quiet: !!shown?.run });
  // A run of a workflow since deleted still shows, on the copy it ran.
  if (shown?.run && !state.def.graph.nodes.length && shown.run.definition) {
    state.def = normalise(structuredClone(shown.run.definition));
    toast('This workflow is not in your library any more. This is the copy the run used; save it to keep it.', '', 0);
  }
  if (from || shown?.run) {
    if (shown?.run) { state.runId = runId; applyRun(shown); followRuns(); }
  } else {
    state.def = blank();
    // Arriving from "start a new workflow called …" on the Workflows page.
    const title = (q.get('title') || '').trim();
    if (title) { state.def.title = title; state.def.id = slug(title); }
    fillStartFrom();
  }
  fetch('/api/skills').then((x) => x.json()).then((r) => { state.skills = r.skills || []; if (state.selectedId) renderSelected(); }).catch(() => {});
  // The workflows a "Run a workflow" step can pick from, kept current: a
  // workflow saved in another tab shows up when you come back to this one.
  loadLibrary();
  addEventListener('focus', loadLibrary);
  fillKindPickers();
  bindUi();
  // ?panel=runs opens straight onto this workflow's past runs.
  if (q.get('panel') === 'runs' && state.loaded) { state.side = 'runs'; loadPastRuns(); }
  render();
  // A graph wider than the screen opens fitted, so no step starts hidden.
  if (state.content && $('edInner').parentElement.clientWidth < state.content.w) fitZoom();
  markSaved(!!state.loaded, state.def.version);
  mountClaude();
  // An id shared with another workflow is said once on opening, not hidden.
  if (state.clash) validate({ announce: true }); else validateSoon();
}

/**
 * New workflows start from an empty canvas. Someone building their own
 * process should not have to delete template steps first; templates come
 * from opening a built-in, which saves as their own copy.
 */
/** The empty canvas offers existing workflows to start from. */
async function fillStartFrom() {
  try {
    const { workflows = [], bootedRepo = null } = await fetch('/api/workflows').then((r) => r.json());
    state.bootedRepo = bootedRepo;
    const list = workflows.filter((w) => !w.invalid).slice(0, 5);
    $('edEmptyList').innerHTML = list.map((w) => `<a href="/workflow-editor.html?from=${encodeURIComponent(w.id)}${refQuery(w)}">${escapeHtml(w.title || w.id)}<span>${w.graph?.nodes?.length || 0} steps</span></a>`).join('');
  } catch { /* the hint above still says how to begin */ }
}

function blank() {
  return normalise({ schemaVersion: 2, id: '', title: '', inputs: [], graph: { nodes: [], edges: [] } });
}

function normalise(def) {
  def.schemaVersion = def.schemaVersion || 2;
  def.inputs = Array.isArray(def.inputs) ? def.inputs : [];
  def.graph = def.graph || {};
  def.graph.nodes = def.graph.nodes || [];
  def.graph.edges = def.graph.edges || [];
  return def;
}

/*
 * Orderly lists workflows from every project, and two may share an id. One
 * in the booted repo, the user library or the built-ins is found by id
 * alone; one from another repo also carries its scope and repo.
 */
function refQuery(w) {
  return w?.scope === 'project' && w.repoRoot && w.repoRoot !== state.bootedRepo
    ? `&scope=project&repo=${encodeURIComponent(w.repoRoot)}` : '';
}

async function loadExisting(id, { scope: wantScope, repo, quiet = false } = {}) {
  const q = wantScope && repo ? `?scope=${encodeURIComponent(wantScope)}&repo=${encodeURIComponent(repo)}` : '';
  const r = await fetch(`/api/workflows/${encodeURIComponent(id)}${q}`).then((x) => x.json()).catch(() => ({}));
  if (!r.workflow) { state.def = blank(); if (!quiet) toast(`There is no workflow called "${id}".`, 'err'); return; }
  state.bootedRepo = r.bootedRepo || null;
  // Drop server-side fields that aren't part of the on-disk def.
  const { scope, source, file, invalid, problems, repoRoot, repoName, key, clash, ...clean } = r.workflow;
  state.def = normalise(clean);
  // Another workflow on disk has this id, from before ids were unique.
  state.clash = clash || null;
  state.builtin = scope === 'builtin';
  // Where it lives, so saving writes back to the same repo.
  state.loaded = state.builtin ? null : { id: clean.id, scope, repoRoot: repoRoot || null };
  // A built-in saves as the person's own copy, in their library.
  $('wfScope').value = state.builtin ? 'user' : scope;
  fillScopes();
  document.title = `${clean.title || clean.id} — workflow editor`;
}

function fillKindPickers() {
  $('newKind').innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.name)}</option>`).join('');
  const showDesc = () => { $('newKindDesc').textContent = KINDS[$('newKind').value]?.desc || ''; };
  $('newKind').addEventListener('change', showDesc);
  showDesc();
  $('selKind').innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.name)}</option>`).join('')
    + `<optgroup label="Older kinds">${Object.entries(LEGACY).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</optgroup>`;
}

function bindUi() {
  $('wfTitle').addEventListener('input', () => {
    state.def.title = $('wfTitle').value;
    // Until it is saved, the short name follows the name.
    if (!state.loaded && !state.idTouched) $('wfId').value = state.def.id = slug(state.def.title);
    changed({ redraw: false });
  });
  $('wfId').addEventListener('input', () => { state.idTouched = true; state.def.id = slug($('wfId').value, true); changed({ redraw: false }); });
  $('wfId').addEventListener('change', () => { $('wfId').value = state.def.id = slug($('wfId').value); changed({ redraw: false }); });
  $('wfScope').addEventListener('change', () => { renderScopeHint(); changed({ redraw: false }); });
  $('wfDesc').addEventListener('input', () => { state.def.desc = $('wfDesc').value; changed({ redraw: false }); });
  $('wfCategory').addEventListener('change', () => { state.def.category = $('wfCategory').value; changed({ redraw: false }); });
  $('wfEstimate').addEventListener('input', () => { state.def.estimate = $('wfEstimate').value; changed({ redraw: false }); });
  $('wfBudget').addEventListener('input', () => {
    const v = $('wfBudget').value.trim();
    if (v === '') delete state.def.budgetUsd; else state.def.budgetUsd = Number(v);
    changed({ redraw: false });
  });
  $('wfConcurrency').addEventListener('change', () => {
    const v = $('wfConcurrency').value;
    if (v === '') delete state.def.concurrency; else state.def.concurrency = Number(v);
    changed({ redraw: false });
  });
  $('wfWhen').addEventListener('input', () => {
    const v = $('wfWhen').value.trim();
    if (v) state.def.whenToUse = $('wfWhen').value; else delete state.def.whenToUse;
    changed({ redraw: false });
  });
  $('wfTags').addEventListener('input', () => {
    const tags = $('wfTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length) state.def.tags = tags; else delete state.def.tags;
    changed({ redraw: false });
  });
  $('wfSandbox').addEventListener('change', () => {
    const v = $('wfSandbox').value;
    if (v) state.def.runtime = { ...(state.def.runtime || {}), sandbox: v };
    else delete state.def.runtime;
    renderSandbox();
    changed({ redraw: false });
  });
  $('wfKeepOnFail').addEventListener('change', () => {
    state.def.runtime = { ...(state.def.runtime || { sandbox: 'worktree' }), keepOnFail: $('wfKeepOnFail').checked };
    changed({ redraw: false });
  });
  $('btnAddInput').addEventListener('click', () => {
    state.def.inputs.push({ key: `input${state.def.inputs.length + 1}`, label: '', placeholder: '' });
    changed();
  });
  $('btnTidy').addEventListener('click', tidy);
  $('zoomIn').addEventListener('click', () => setZoom((state.zoom || 1) + 0.1));
  $('zoomOut').addEventListener('click', () => setZoom((state.zoom || 1) - 0.1));
  $('zoomFit').addEventListener('click', fitZoom);
  window.addEventListener('resize', () => renderCanvas());
  $('btnSettings').addEventListener('click', () => {
    state.side = state.side === 'settings' ? null : 'settings';
    if (state.side) state.selectedId = null;
    render();
  });
  $('btnCloseSettings').addEventListener('click', () => { state.side = null; render(); });
  $('btnRuns').addEventListener('click', () => {
    state.side = state.side === 'runs' ? null : 'runs';
    if (state.side) { state.selectedId = null; loadPastRuns(); }
    render();
  });
  $('btnCloseRuns').addEventListener('click', () => { state.side = null; render(); });
  $('btnExport').addEventListener('click', () => { if (state.loaded) location.href = `/api/workflows/${encodeURIComponent(state.loaded.id)}/export?${refQuery(state.loaded).slice(1)}`; });
  $('importFile').addEventListener('change', importFile);
  $('btnDeleteWf').addEventListener('click', deleteWorkflow);

  // Add-node floater: button opens the popover; the Add inside it drops a node.
  $('btnAddNodeOpen')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('addPop').classList.toggle('on');
  });
  $('btnAddNode').addEventListener('click', (e) => {
    e.stopPropagation();
    addNode();
    $('addPop').classList.remove('on');
  });
  // Click anywhere else closes the popovers.
  document.addEventListener('click', (e) => {
    const pop = $('addPop');
    if (pop?.classList.contains('on') && !e.target.closest('.add-wrap')) pop.classList.remove('on');
    if (!e.target.closest('#refPop') && !e.target.closest('.ref-btn')) closeRefPop();
  });
  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnConnect').addEventListener('click', () => {
    state.connectFromId = state.connectFromId ? null : state.selectedId;
    render();
  });
  $('selId').addEventListener('change', () => renameSelected(slug($('selId').value)));
  $('selTitle').addEventListener('input', () => { const n = selectedNode(); if (!n) return; n.title = $('selTitle').value; changed({ redraw: 'canvas' }); });
  $('selKind').addEventListener('change', () => changeKind($('selKind').value));

  for (const [id, apply] of [
    ['advRetries', (n, v) => { if (Number(v)) n.spec.retry = { ...(n.spec.retry || {}), attempts: Number(v) }; else delete n.spec.retry; }],
    ['advBackoff', (n, v) => { if (n.spec.retry) n.spec.retry.backoffMs = Number(v); }],
    ['advTimeout', (n, v) => { if (v) n.spec.timeoutMs = Number(v); else delete n.spec.timeoutMs; }],
  ]) {
    $(id).addEventListener('change', () => { const n = selectedNode(); if (!n) return; n.spec = n.spec || {}; apply(n, $(id).value); changed({ redraw: 'canvas' }); renderSelected(); });
  }
  $('advIdem').addEventListener('change', () => {
    const n = selectedNode(); if (!n) return; n.spec = n.spec || {};
    if ($('advIdem').checked) delete n.spec.idempotent; else n.spec.idempotent = false;
    changed({ redraw: 'canvas' });
  });
  $('advAllow').addEventListener('change', () => {
    const n = selectedNode(); if (!n) return; n.spec = n.spec || {};
    if ($('advAllow').checked) n.spec.allowFailure = true; else delete n.spec.allowFailure;
    changed({ redraw: 'canvas' });
  });

  $('btnValidate').addEventListener('click', () => validate({ announce: true }));
  $('rbClose').addEventListener('click', closeRun);
  $('rbTimeline').addEventListener('click', () => {
    const wrap = $('rbTimelineWrap');
    wrap.hidden = !wrap.hidden;
    $('rbTimeline').setAttribute('aria-expanded', String(!wrap.hidden));
    $('rbTimeline').classList.toggle('on', !wrap.hidden);
  });
  // The run bar changes height as the run goes; the canvas takes the rest.
  new ResizeObserver(() => fitLayout()).observe($('runBar'));
  $('btnSave').addEventListener('click', save);
  $('btnRun')?.addEventListener('click', saveAndRun);
  $('modeVisual').addEventListener('click', () => setMode('visual'));
  $('modeJson').addEventListener('click', () => setMode('json'));
  $('jsonArea').addEventListener('change', () => {
    try { state.def = normalise(JSON.parse($('jsonArea').value)); changed(); toast('File applied.', 'ok'); }
    catch (e) { toast(`That isn't valid JSON: ${e.message}`, 'err'); }
  });
  // Canvas clicks (background) deselect; keeps the sidebar in sync.
  $('edCanvas').addEventListener('click', (e) => {
    if (e.target.id === 'edCanvas' || e.target.id === 'edInner' || e.target.id === 'edEdges') {
      state.selectedId = null; state.connectFromId = null; render();
    }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      closeRefPop();
      $('addPop').classList.remove('on');
      if (state.connectFromId) { state.connectFromId = null; render(); }
      return;
    }
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); deleteSelected(); }
  });
}

/* -------------------------------- actions -------------------------------- */

/** Record a change: mark unsaved, redraw what's needed, re-check soon. */
function changed({ redraw = true } = {}) {
  state.dirty = true;
  markSaved(false);
  if (redraw === true) render();
  else if (redraw === 'canvas') renderCanvas();
  if (state.mode === 'json') $('jsonArea').value = JSON.stringify(state.def, null, 2);
  validateSoon();
  previewSoon();
}

function addNode() {
  const kind = $('newKind').value;
  const after  = $('newAfter')?.value || '';
  const before = $('newBefore')?.value || '';
  let id = slug(kind), i = 2;
  while (state.def.graph.nodes.some((n) => n.id === id)) id = `${slug(kind)}${i++}`;
  // Pick a column that makes the wiring read left-to-right. If "after" is set,
  // land one column right of it. If "before" is set, land one left of that.
  // If both: land in between (and leave the pre-existing edge alone — the new
  // node sits as a sibling, not an insertion-split, which is simpler and lets
  // the user explicitly delete the old edge if they want that semantic).
  const nodeAt = (nid) => state.def.graph.nodes.find((n) => n.id === nid);
  const na = nodeAt(after), nb = nodeAt(before);
  let col = state.def.graph.nodes.length
    ? Math.max(...state.def.graph.nodes.map((n) => n.col || 0)) + 1 : 1;
  if (na && nb) col = Math.max((na.col || 0) + 1, Math.min((nb.col || 0) - 1, (na.col || 0) + 1));
  else if (na) col = (na.col || 0) + 1;
  else if (nb) col = Math.max(0, (nb.col || 0) - 1);
  let row = na?.row ?? nb?.row ?? 0;
  while (state.def.graph.nodes.some((n) => (n.col || 0) === col && (n.row || 0) === row)) row++;
  const node = { id, title: KINDS[kind]?.name || id, kind, col, row, cost: 1 };
  const starter = KIND_SPEC_DEFAULT[kind];
  if (starter) node.spec = starter();
  state.def.graph.nodes.push(node);
  // Auto-wire the chosen edges. Out of a Decision, the edge takes the first
  // of its choices not yet used; the step's sidebar can change it.
  if (after) state.def.graph.edges.push([after, id, ...autoLabel(na)]);
  if (before) state.def.graph.edges.push([id, before, ...autoLabel(node)]);
  state.selectedId = id;
  state.side = null;
  // Reset the pickers so the next add starts fresh.
  if ($('newAfter'))  $('newAfter').value  = '';
  if ($('newBefore')) $('newBefore').value = '';
  changed();
  if (kind === 'workflow') loadLibrary();
  setTimeout(() => $('selSpec').querySelector('textarea, input')?.focus(), 0);
}

/**
 * Line the steps up in the order they run: each step one column right of the
 * latest step it waits on, and within a column, near the steps that feed it,
 * so connections run left to right and cross as little as they can. Steps
 * added without an "After" otherwise pile up on the far right, and their
 * connections loop backwards across the canvas.
 */
function tidy() {
  const nodes = state.def.graph.nodes;
  if (!nodes.length) return;
  const parents = Object.fromEntries(nodes.map((n) => [n.id, []]));
  for (const [a, b] of state.def.graph.edges) parents[b]?.push(a);
  const depth = {};
  const visit = (id, trail = new Set()) => {
    if (depth[id] != null) return depth[id];
    if (trail.has(id)) return 0; // a loop; check() reports it
    trail.add(id);
    const ps = parents[id] || [];
    depth[id] = ps.length ? 1 + Math.max(...ps.map((p) => visit(p, trail))) : 0;
    return depth[id];
  };
  for (const n of nodes) visit(n.id);
  // A step that waits on nothing sits just before the first step it feeds,
  // not back in the first column with its line running behind other cards.
  const children = Object.fromEntries(nodes.map((n) => [n.id, []]));
  for (const [a, b] of state.def.graph.edges) children[a]?.push(b);
  for (const n of nodes) {
    if (!parents[n.id].length && children[n.id].length) {
      depth[n.id] = Math.max(0, Math.min(...children[n.id].map((c) => depth[c])) - 1);
    }
  }
  const byCol = new Map();
  for (const n of nodes) {
    if (!byCol.has(depth[n.id])) byCol.set(depth[n.id], []);
    byCol.get(depth[n.id]).push(n);
  }
  const row = {};
  for (const col of [...byCol.keys()].sort((a, b) => a - b)) {
    const list = byCol.get(col);
    // Sit each step beside the steps that feed it: order by their mean row.
    const pull = (n) => {
      const ps = (parents[n.id] || []).filter((p) => row[p] != null);
      return ps.length ? ps.reduce((t, p) => t + row[p], 0) / ps.length : nodes.indexOf(n);
    };
    list.sort((a, b) => pull(a) - pull(b) || nodes.indexOf(a) - nodes.indexOf(b));
    list.forEach((n, i) => { n.col = col + 1; n.row = i; row[n.id] = i; });
  }
  changed();
  toast('Lined up in the order they run.', 'ok', 1800);
}

/** A connection out of a Decision takes the first of its options not yet used. */
function autoLabel(src) {
  if (src?.kind !== 'decision') return [];
  const used = new Set(state.def.graph.edges.filter((e) => e[0] === src.id).map((e) => e[2]));
  const free = (src.spec?.options || []).map((o) => o.edgeLabel).find((l) => l && !used.has(l));
  return free ? [free] : [];
}

/** True if `from` already leads to `to`, so an edge to→from would loop. */
function reaches(from, to) {
  const out = {};
  for (const [a, b] of state.def.graph.edges) (out[a] ||= []).push(b);
  const seen = new Set(); const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out[id] || []));
  }
  return false;
}

function addEdge(from, to) {
  if (from === to) return false;
  if (state.def.graph.edges.some(([a, b]) => a === from && b === to)) { toast('Those two are already connected.', ''); return false; }
  if (reaches(to, from)) { toast(`That would make a loop: "${to}" already leads back to "${from}".`, 'err'); return false; }
  const src = state.def.graph.nodes.find((n) => n.id === from);
  state.def.graph.edges.push([from, to, ...autoLabel(src)]);
  return true;
}

/** Fill the after/before pickers with current node ids. Preserves selection. */
function refreshAddPickers() {
  const nodes = state.def.graph.nodes;
  const opts = ['<option value="">— none —</option>']
    .concat(nodes.map((n) => `<option value="${escapeAttr(n.id)}">${escapeHtml(n.title || n.id)}</option>`));
  for (const id of ['newAfter', 'newBefore']) {
    const sel = $(id);
    if (!sel) continue;
    const v = sel.value;
    sel.innerHTML = opts.join('');
    // Only keep the previous value if the node still exists.
    sel.value = nodes.some((n) => n.id === v) ? v : '';
  }
}

function deleteSelected() {
  if (state.selectedId) deleteNode(state.selectedId);
}

function deleteNode(id) {
  state.def.graph.nodes = state.def.graph.nodes.filter((n) => n.id !== id);
  state.def.graph.edges = (state.def.graph.edges || []).filter(([a, b]) => a !== id && b !== id);
  if (state.selectedId === id) state.selectedId = null;
  state.connectFromId = null;
  changed();
}

/*
 * Right-click a step to delete it. A window asks first, and says what else
 * goes with it: its connections, and any steps that use what it makes.
 */
function confirmDelete(n) {
  let d = document.getElementById('delDlg');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'delDlg';
    d.className = 'del-dlg';
    d.innerHTML = `
      <h3 id="delTitle"></h3>
      <p id="delWhat"></p>
      <p class="del-warn" id="delWarn" hidden></p>
      <div class="del-foot">
        <button type="button" class="btn" id="delCancel">Cancel</button>
        <button type="button" class="btn danger" id="delGo">Delete step</button>
      </div>`;
    document.body.append(d);
    d.querySelector('#delCancel').onclick = () => d.close();
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  const links = (state.def.graph.edges || []).filter(([a, b]) => a === n.id || b === n.id).length;
  const users = state.def.graph.nodes.filter((x) => x.id !== n.id && JSON.stringify(x.spec || {}).includes(`${n.id}.`));
  d.querySelector('#delTitle').textContent = `Delete “${n.title || n.id}”?`;
  d.querySelector('#delWhat').textContent = `This removes the step${links ? ` and its ${links} connection${links === 1 ? '' : 's'}` : ''} from the canvas. Nothing is saved until you press Save.`;
  const warn = d.querySelector('#delWarn');
  warn.hidden = !users.length;
  warn.textContent = users.length ? `${users.map((u) => `“${u.title || u.id}”`).join(', ')} ${users.length === 1 ? 'uses' : 'use'} what this step makes and will need fixing.` : '';
  d.querySelector('#delGo').onclick = () => { d.close(); deleteNode(n.id); toast(`Deleted “${n.title || n.id}”. Save to keep the change.`); };
  d.showModal();
  d.querySelector('#delCancel').focus();
}

function patchSelected(fields) {
  const n = selectedNode();
  if (!n) return;
  Object.assign(n, fields);
  changed();
}

function renameSelected(newId) {
  const n = selectedNode();
  if (!n || !newId || newId === n.id) { renderSelected(); return; }
  if (state.def.graph.nodes.some((x) => x.id === newId)) {
    toast(`"${newId}" is already used by another step.`, 'err');
    renderSelected();
    return;
  }
  const old = n.id;
  n.id = newId;
  state.def.graph.edges = (state.def.graph.edges || []).map((e) => {
    const [a, b, l] = e;
    const na = a === old ? newId : a;
    const nb = b === old ? newId : b;
    return l ? [na, nb, l] : [na, nb];
  });
  // Keep references to it working.
  const re = new RegExp(`\\{\\{\\s*nodes\\.${old.replace(/-/g, '\\-')}(?=[.\\s}])`, 'g');
  for (const x of state.def.graph.nodes) {
    for (const k of ['prompt', 'cmd', 'question', 'path', 'content', 'over']) {
      if (typeof x.spec?.[k] === 'string') x.spec[k] = x.spec[k].replace(re, `{{nodes.${newId}`);
    }
    if (x.spec?.assert?.from === old) x.spec.assert.from = newId;
    if (Array.isArray(x.spec?.from)) x.spec.from = x.spec.from.map((f) => (f === old ? newId : f));
    else if (x.spec?.from === old) x.spec.from = newId;
  }
  state.selectedId = newId;
  changed();
}

function changeKind(kind) {
  const n = selectedNode(); if (!n) return;
  const prev = n.spec || {};
  const next = KIND_SPEC_DEFAULT[kind] ? KIND_SPEC_DEFAULT[kind]() : {};
  // Carry across what still means the same thing.
  for (const k of ['prompt', 'cmd', 'question', 'model']) if (prev[k] && k in next) next[k] = prev[k];
  for (const k of ['retry', 'timeoutMs', 'idempotent']) if (prev[k] !== undefined) next[k] = prev[k];
  n.kind = kind;
  n.spec = next;
  changed();
}

/** Fetch the workflows a "Run a workflow" step can pick; redraw the step's form if the list changed. */
async function loadLibrary() {
  const r = await fetch('/api/workflows').then((x) => x.json()).catch(() => null);
  if (!r) return;
  const list = (r.workflows || []).filter((w) => !w.invalid);
  state.bootedRepo = r.bootedRepo || state.bootedRepo;
  state.projects = r.projects || [];
  state.home = r.home || null;
  fillScopes();
  const changed = !state.library || list.map((w) => `${w.key}@${w.version || 0}`).join() !== state.library.map((w) => `${w.key}@${w.version || 0}`).join();
  state.library = list;
  if (changed && selectedNode()?.kind === 'workflow') renderSelected();
}

function selectNode(id) {
  if (state.connectFromId && state.connectFromId !== id) {
    // Pending connect: wire this one and clear the mode.
    if (addEdge(state.connectFromId, id)) changed({ redraw: false });
    state.connectFromId = null;
    state.selectedId = id;
    render();
    return;
  }
  state.selectedId = id;
  state.side = null;
  render();
  if (selectedNode()?.kind === 'workflow') loadLibrary();
}

/* ------------------------------ save & files ----------------------------- */

let validateTimer = null;
function validateSoon() { clearTimeout(validateTimer); validateTimer = setTimeout(() => validate(), 350); }

/**
 * Check the def. Quietly while editing — problems mark their cards and the
 * header; with `announce` (the check button, save) the toast lists them.
 */
async function validate({ announce = false } = {}) {
  const def = { ...state.def, id: state.def.id || 'untitled' };
  const r = await fetch('/api/workflows/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ def }),
  }).then((x) => x.json()).catch(() => ({ ok: false, problems: ['Orderly is not answering — is it still running?'] }));
  // An empty canvas is not a problem worth shouting about while building.
  // An empty canvas is a draft, not a problem: it saves, and runs once it has a step.
  state.problems = (r.problems || []).filter((p) => !/no steps yet/.test(p));
  state.warnings = r.warnings || [];
  // Renaming it in the editor is how the clash is fixed; until then, say so.
  if (state.clash && state.loaded && state.def.id === state.loaded.id) state.warnings = [state.clash.message, ...state.warnings];
  renderCanvas();
  if (announce) showProblems(state.problems, state.warnings);
  return state.problems.length === 0;
}

async function save() {
  const def = state.def;
  if (!def.title?.trim()) { toast('Give it a name first.', 'err'); $('wfTitle').focus(); return false; }
  if (!def.id) def.id = slug(def.title);
  const ok = await validate();
  if (!ok) { showProblems(state.problems, state.warnings, 'Fix these, then save.'); return false; }
  // Keep it in names the folder: your library, or a project by its path.
  const scope = $('wfScope').value === 'user' ? 'user' : 'project';
  const repoRoot = scope === 'project' ? pickedRepo() : null;
  // Saving over itself is fine; saving a new one over another, or into another project, is not.
  const overwrite = !!state.loaded && state.loaded.id === def.id && state.loaded.scope === scope
    && (scope !== 'project' || (state.loaded.repoRoot || state.bootedRepo) === (repoRoot || state.bootedRepo));
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def, scope, repoRoot, overwrite }),
    }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
    if (r.status === 409) {
      // Ids are unique everywhere. Offer the free one the server suggests.
      toast(`${r.error || `You already have a workflow called "${def.id}"`}. Change the short name, or open that one instead.`, 'err', 0);
      if (r.suggestedId) {
        const btn = document.createElement('button');
        btn.className = 'act';
        btn.textContent = `Save it as "${r.suggestedId}"`;
        btn.onclick = () => { $('wfId').value = state.def.id = r.suggestedId; state.idTouched = true; save(); };
        $('status').append(' ', btn);
      }
      return false;
    }
    if (!r.saved) throw new Error(r.error || 'save failed');
    def.version = r.version;
    // A new id is unique, so any old clash went with the old one.
    if (state.loaded?.id !== r.id) state.clash = null;
    state.loaded = { id: r.id, scope: r.scope, repoRoot: r.repoRoot || null };
    state.bootedRepo = r.bootedRepo || state.bootedRepo;
    state.builtin = false;
    state.dirty = false;
    history.replaceState(null, '', `/workflow-editor.html?from=${encodeURIComponent(r.id)}${refQuery(state.loaded)}`);
    render();
    markSaved(true, r.version);
    // Saved for the first time: the conversation about it follows it.
    state.assistant?.rekey(assistantKey());
    const where = r.scope === 'project' && r.repoRoot ? ` in ${r.repoRoot.split('/').filter(Boolean).pop()}` : ' in your library';
    toast(r.version > 1 ? `Saved${where} as version ${r.version}. Runs already made keep the version they ran.` : `Saved${where}.`, 'ok', 2500);
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

/**
 * Save first, then ask for its inputs on this page and run it here, on the
 * canvas, rather than on a page of its own.
 */
async function saveAndRun() {
  await openRunDialog();
}

async function importFile() {
  const f = $('importFile').files?.[0];
  $('importFile').value = '';
  if (!f) return;
  let def;
  try { def = JSON.parse(await f.text()); } catch { toast(`${f.name} is not a workflow file.`, 'err'); return; }
  const scope = $('wfScope').value === 'user' ? 'user' : 'project';
  const post = (d) => fetch('/api/workflows/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ def: d, scope }),
  }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
  const r = await post(def);
  if (r.status === 409) {
    toast(`${r.error}. `, 'err', 0);
    const btn = document.createElement('button');
    btn.className = 'act';
    btn.textContent = `Import it as "${r.suggestedId}"`;
    btn.onclick = async () => {
      const again = await post({ ...def, id: r.suggestedId });
      if (again.saved) location.href = `/workflow-editor.html?from=${encodeURIComponent(again.id)}`;
      else toast(again.error || 'Import failed.', 'err');
    };
    $('status').append(btn);
    return;
  }
  if (r.saved) { location.href = `/workflow-editor.html?from=${encodeURIComponent(r.id)}`; return; }
  toast(`${r.error || 'Import failed'}${r.problems ? `: ${r.problems.slice(0, 3).join('; ')}` : ''}`, 'err');
}

/** Two clicks, not a dialog: the first arms it, the second deletes. */
async function deleteWorkflow() {
  const btn = $('btnDeleteWf');
  if (!state.loaded) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 3000);
    return;
  }
  const repo = state.loaded.repoRoot ? `&repo=${encodeURIComponent(state.loaded.repoRoot)}` : '';
  const r = await fetch(`/api/workflows/${encodeURIComponent(state.loaded.id)}?scope=${state.loaded.scope}${repo}`, { method: 'DELETE' }).then((x) => x.json());
  if (r.deleted) location.href = '/workflows.html#workflows';
  else toast(r.error || 'Delete failed.', 'err');
}

/* --------------------------------- toast --------------------------------- */

/** Floating feedback at the bottom of the canvas. `ms` 0 keeps it up. */
function toast(text, kind = '', ms = 4000) {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
  $('problems').style.display = 'none';
  $('warnings').style.display = 'none';
  $('edToast').style.display = 'block';
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => { $('edToast').style.display = 'none'; }, ms);
}

function showProblems(problems, warnings = [], lead = null) {
  const list = (el, items, label) => {
    if (!items.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `<strong>${items.length} ${items.length === 1 ? 'thing' : 'things'} ${label}</strong><ul>${items.map((p) => `<li>${escapeHtml(plain(p))}</li>`).join('')}</ul>`;
  };
  $('status').textContent = lead || (problems.length ? 'Not ready to run yet.' : 'Ready to run.');
  $('status').className = `status ${problems.length ? 'err' : 'ok'}`;
  list($('problems'), problems, 'to fix before it can run');
  list($('warnings'), warnings, 'worth a look');
  $('edToast').style.display = 'block';
  clearTimeout(toast._t);
  if (!problems.length && !warnings.length) toast._t = setTimeout(() => { $('edToast').style.display = 'none'; }, 2000);
}

/** Engine messages lead with `node <id>:`; say the step's name instead. */
function plain(p) {
  return p.replace(/^node ([^:]+): /, (_, id) => `${state.def.graph.nodes.find((n) => n.id === id)?.title || id}: `)
    .replace(/spec\.([a-z.]+)/gi, '$1');
}

function problemsFor(id) { return state.problems.filter((p) => p.startsWith(`node ${id}:`)); }

/* -------------------------------- preview -------------------------------- */

let previewTimer = null;
function previewSoon() { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 450); }

/** Show what the focused field will actually send, from the last run. */
async function preview() {
  const n = selectedNode();
  const key = state.refField?.dataset.spec;
  const fields = ['prompt', 'cmd', 'question', 'path', 'content', 'over', 'assert.needle'];
  const value = key && key.split('.').reduce((o, k) => o?.[k], n?.spec);
  if (!n || !fields.includes(key) || !value) { $('preview').classList.add('hidden'); return; }
  const r = await fetch('/api/workflows/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ def: { ...state.def, id: state.def.id || 'untitled' }, nodeId: n.id, field: key }),
  }).then((x) => x.json()).catch(() => null);
  if (!r || r.error) { $('preview').classList.add('hidden'); return; }
  $('preview').classList.remove('hidden');
  $('previewText').textContent = r.text.length > 2000 ? `${r.text.slice(0, 2000)}…` : (r.text || '(empty)');
  $('previewSrc').textContent = r.fromRun ? `from the run of ${when(r.fromRun.startedAt)}` : 'not run yet';
  const nodeHoles = r.missing.filter((m) => /nodes\./.test(m));
  const inputHoles = r.missing.filter((m) => /inputs\./.test(m));
  const bits = [];
  if (nodeHoles.length) bits.push(r.fromRun ? `Empty in the last run: ${nodeHoles.join(', ')}` : `Filled in once the steps it names have run: ${nodeHoles.join(', ')}`);
  if (inputHoles.length) bits.push(`Filled in from what you type when you start it: ${inputHoles.join(', ')}`);
  $('previewMissing').textContent = bits.join(' · ');
}

/* ------------------------------ references ------------------------------- */

function upstream(id) {
  const parents = {};
  for (const [a, b] of state.def.graph.edges) (parents[b] ||= []).push(a);
  const seen = new Set(); const stack = [...(parents[id] || [])];
  while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); stack.push(...(parents[x] || [])); }
  return state.def.graph.nodes.filter((n) => seen.has(n.id));
}

/** The fields worth naming for each kind of output. */
function fieldsOf(n) {
  const k = n.kind, o = n.spec?.output;
  const f = [['output', 'everything it produced']];
  if (k === 'script') f.push(['output.out', 'what the command printed'], ['output.code', 'its exit code']);
  if (k === 'agent' && o === 'json') f.push(['output.data', 'the data it returned']);
  if (k === 'agent' && o === 'json-findings') f.push(['output.findings', 'the findings']);
  if (k === 'agent' && (o === 'html' || o === 'mockup')) f.push(['output.html', 'the web page it made']);
  if (k === 'decision') f.push(['output.answer', 'the choice you made']);
  if (k === 'approve') f.push(['output.approved', 'whether you approved']);
  if (k === 'check') f.push(['output.pass', 'whether it passed'], ['output.reason', 'why']);
  if (k === 'loop') f.push(['output.results', "every item's result"]);
  if (k === 'inputs') for (const x of n.spec?.fields || []) f.push([`output.values.${x.key}`, x.label || x.key]);
  if (k === 'publish') f.push(['output.path', 'the file it wrote']);
  return f;
}

function openRefPop(btn, field) {
  state.refField = field;
  const n = selectedNode();
  const pop = $('refPop');
  const groups = [];
  const inputs = [...state.def.inputs.map((i) => [i.key, i.label]),
    ...state.def.graph.nodes.filter((x) => x.kind === 'inputs').flatMap((x) => (x.spec?.fields || []).map((f) => [f.key, f.label]))];
  if (inputs.length) groups.push(['Inputs', inputs.map(([k, l]) => [`{{inputs.${k}}}`, l || k])]);
  if (n?.kind === 'loop') groups.push(['This item', [['{{item}}', 'the current item in the list']]]);
  const ups = upstream(n?.id);
  for (const u of ups) groups.push([u.title || u.id, fieldsOf(u).map(([p, d]) => [`{{nodes.${u.id}.${p}}}`, d])]);
  if (ups.length > 1) groups.push(['Several', [['{{nodes.*.output}}', 'everything every step just before this one produced']]]);
  pop.innerHTML = groups.length
    ? groups.map(([g, items]) => `<div class="rg">${escapeHtml(g)}</div>${items.map(([t, d]) => `<button type="button" data-ref="${escapeAttr(t)}"><span class="rt">${escapeHtml(t)}</span><span class="rd">${escapeHtml(d)}</span></button>`).join('')}`).join('')
    : '<div class="none">Nothing to use yet. Add an input in ⚙ Settings, or connect a step into this one to use what it produced.</div>';
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 330, r.left - 200))}px`;
  pop.style.top = `${Math.min(window.innerHeight - 350, r.bottom + 4)}px`;
  pop.classList.remove('hidden');
  for (const b of pop.querySelectorAll('button[data-ref]')) b.onclick = () => insertRef(b.dataset.ref);
  pop.querySelector('button')?.focus();
}

function closeRefPop() { $('refPop').classList.add('hidden'); }

function insertRef(text) {
  const el = state.refField;
  closeRefPop();
  if (!el) return;
  const at = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? at;
  el.value = el.value.slice(0, at) + text + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = at + text.length;
  writeSpec(el.dataset.spec, el.value, { silent: true });
}

/* --------------------------------- render -------------------------------- */

/* Past runs of this workflow, newest first, each opening on this canvas. */
const RUN_WORD = { running: 'Running', 'awaiting-answer': 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Cut short' };
async function loadPastRuns() {
  const id = state.loaded?.id;
  if (!id) return;
  $('runsAll').href = `/workflows.html?workflow=${encodeURIComponent(id)}#runs`;
  $('runsList').innerHTML = '<div class="list-empty">Loading…</div>';
  let runs = [];
  try {
    // No limit here: the server limits before it filters by workflow.
    // A project workflow's runs are the ones in its own repo, so an old run
    // of a same-id workflow from another repo does not mix in.
    const where = state.loaded.scope ? `&scope=${encodeURIComponent(state.loaded.scope)}` : '';
    const repo = state.loaded.scope === 'project' && state.loaded.repoRoot ? `&repo=${encodeURIComponent(state.loaded.repoRoot)}` : '';
    const r = await fetch(`/api/runs?workflow=${encodeURIComponent(id)}${where}${repo}`).then((x) => x.json());
    runs = (r.runs || []).filter((x) => x.workflowId === id);
  } catch {
    $('runsList').innerHTML = '<div class="list-empty">Could not load its runs.</div>';
    return;
  }
  $('runsCount').textContent = runs.length ? `· ${runs.length}` : '';
  if (!runs.length) {
    $('runsList').innerHTML = '<div class="list-empty">No runs yet. Press ▶ Run to start one.</div>';
    return;
  }
  const more = runs.length > 30 ? `<div class="list-empty">Showing the latest 30. Open in Runs for all ${runs.length}.</div>` : '';
  runs = runs.slice(0, 30);
  $('runsList').innerHTML = runs.map((r) => {
    const when = new Date(r.startedAt);
    const date = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const took = r.endedAt ? tookText((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000) : '';
    const cost = r.totalCost ? `$${r.totalCost < 0.01 ? r.totalCost.toFixed(4) : r.totalCost.toFixed(2)}` : '';
    const live = r.status === 'running' || r.needsYou;
    const word = r.needsYou ? 'Waiting for you' : RUN_WORD[r.status] || r.status;
    const why = r.status === 'failed' && r.failedNode ? `“${r.failedNode.title}” failed` : '';
    const rated = r.rating ? `<span class="rated ${r.rating}">${r.rating === 'up' ? 'good' : 'not good'}</span>` : '';
    return `<a class="past-run${r.runId === state.runId ? ' on' : ''}" data-run="${escapeAttr(r.runId)}" href="/workflow-editor.html?run=${encodeURIComponent(r.runId)}">
      <span class="pr-when">${escapeHtml(date)} · ${escapeHtml(time)}</span>
      <span class="pr-state s-${live ? 'live' : escapeHtml(r.status)}">${escapeHtml(word)}</span>
      <span class="pr-meta">${[took, cost, r.doneNodes != null ? `${r.doneNodes} of ${r.totalNodes} steps` : ''].filter(Boolean).map(escapeHtml).join(' · ')}${rated}</span>
      ${why ? `<span class="pr-why">${escapeHtml(why)}</span>` : ''}
    </a>`;
  }).join('') + more;
  // Open on this canvas, not another page.
  for (const a of $('runsList').querySelectorAll('[data-run]')) {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      showRun(a.dataset.run);
    });
  }
}

function tookText(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function renderSandbox() {
  const rt = state.def.runtime || {};
  $('wfSandbox').value = rt.sandbox === 'worktree' ? 'worktree' : '';
  $('wfKeepOnFail').checked = !!rt.keepOnFail;
  $('wfKeepLine').classList.toggle('hidden', rt.sandbox !== 'worktree');
  $('sandboxHint').textContent = rt.sandbox === 'worktree'
    ? 'Each run gets its own copy of the project at its last commit, in .claude/worktrees/. Uncommitted changes are not in it. The copy is removed when the run ends.'
    : 'Runs read and write your project folder directly, including any uncommitted changes.';
}

function renderLessons() {
  const lessons = state.def.lessons || [];
  $('lessonsCount').textContent = lessons.length ? `· ${lessons.length}` : '';
  const stepName = (id) => state.def.graph.nodes.find((n) => n.id === id)?.title || id;
  $('lessonsList').innerHTML = lessons.length
    ? lessons.map((l, i) => `<div class="lesson-row ${l.pin || l.rating === 'down' ? 'live' : ''}">
        <div class="lesson-text">${escapeHtml(l.note)}<span class="pd">${l.node ? escapeHtml(stepName(l.node)) : 'whole workflow'}${l.rating === 'down' ? ' · run marked not good' : l.rating === 'up' ? ' · run marked good' : ''}</span></div>
        <label class="check-line"><input type="checkbox" data-pin-lesson="${i}" ${l.pin ? 'checked' : ''}> Use next time</label>
        <button class="run-btn danger x" data-rm-lesson="${i}" title="Remove this lesson" aria-label="Remove this lesson">✕</button>
      </div>`).join('')
    : '<div class="list-empty">None yet. Mark a finished run as good or not good, above the canvas while it is shown, to add one.</div>';
  for (const el of $('lessonsList').querySelectorAll('[data-pin-lesson]')) {
    el.onchange = () => { state.def.lessons[Number(el.dataset.pinLesson)].pin = el.checked; renderLessons(); changed({ redraw: false }); };
  }
  for (const b of $('lessonsList').querySelectorAll('[data-rm-lesson]')) {
    b.onclick = () => {
      state.def.lessons.splice(Number(b.dataset.rmLesson), 1);
      if (!state.def.lessons.length) delete state.def.lessons;
      renderLessons(); changed({ redraw: false });
    };
  }
}

function render() {
  const d = state.def;
  $('wfId').value = d.id || '';
  $('wfTitle').value = d.title || '';
  // A saved workflow keeps its short name; runs refer to it.
  $('wfId').readOnly = !!state.loaded;
  $('wfDesc').value = d.desc || '';
  $('wfCategory').value = d.category || 'build';
  $('wfEstimate').value = d.estimate || '';
  $('wfBudget').value = d.budgetUsd ?? '';
  $('wfConcurrency').value = d.concurrency ? String(d.concurrency) : '';
  $('wfWhen').value = d.whenToUse || '';
  $('wfTags').value = (d.tags || []).join(', ');
  renderSandbox();
  renderLessons();
  $('builtinBanner').classList.toggle('hidden', !state.builtin);
  $('btnExport').disabled = !state.loaded;
  $('btnDeleteWf').disabled = !state.loaded;
  $('edEmpty').classList.toggle('hidden', d.graph.nodes.length > 0 || state.mode === 'json');
  renderScopeHint();
  renderInputs();
  refreshAddPickers();
  renderCanvas();
  renderSelected();
  renderRunStep();
  // Sidebar collapses when nothing is selected — the canvas fills the width.
  const layout = $('edLayout');
  if (layout) layout.classList.toggle('no-sel', !state.selectedId && !state.side);
  $('settingsBlock').style.display = state.side === 'settings' ? '' : 'none';
  $('btnSettings').classList.toggle('on', state.side === 'settings');
  $('runsBlock').style.display = state.side === 'runs' ? '' : 'none';
  $('btnRuns').classList.toggle('on', state.side === 'runs');
  // A workflow that has never been saved has no runs to show.
  $('btnRuns').disabled = !state.loaded;
  $('btnRuns').title = state.loaded ? 'Every time this workflow has run' : 'Save it first; then its runs are listed here';
  if (state.mode === 'json') $('jsonArea').value = JSON.stringify(state.def, null, 2);
}

/** The folder the Keep it in picker points at, or null for the library. */
function pickedRepo() {
  const v = $('wfScope').value;
  return v === 'user' ? null : v.startsWith('project:') ? v.slice(8) : state.bootedRepo || null;
}

/*
 * Keep it in: your library, or a project named by its folder, so it is
 * plain which one "this project" is. The project open in Orderly comes
 * first; the home folder is said to be no project.
 */
function fillScopes() {
  const sel = $('wfScope');
  const name = (p) => String(p).split('/').filter(Boolean).pop() || p;
  const note = (p) => (p && p === state.home ? ' (your home folder, not a project)' : '');
  const others = (state.projects || []).filter((p) => p !== state.bootedRepo && p !== state.home);
  const was = sel.value;
  sel.innerHTML = '<option value="user">your library</option>'
    + `<option value="project">${state.bootedRepo ? `${escapeHtml(name(state.bootedRepo))}${note(state.bootedRepo)}` : 'this project'}</option>`
    + others.map((p) => `<option value="project:${escapeAttr(p)}">${escapeHtml(name(p))}</option>`).join('');
  const l = state.loaded;
  const want = state.builtin ? 'user'
    : l?.scope === 'project' && l.repoRoot && l.repoRoot !== state.bootedRepo ? `project:${l.repoRoot}`
    : l ? (l.scope === 'user' ? 'user' : 'project') : was;
  sel.value = [...sel.options].some((o) => o.value === want) ? want : 'project';
  sel.title = pickedRepo() || '~/.claude/workflows';
  renderScopeHint();
}

function renderScopeHint() {
  const v = $('wfScope').value;
  const home = pickedRepo() && pickedRepo() === state.home;
  $('scopeHint').textContent = home ? SCOPE_HINT.home : SCOPE_HINT[v === 'user' ? 'user' : 'project'];
  $('scopeHint').classList.toggle('warn', !!home);
  $('wfScope').classList.toggle('warn', !!home);
  $('wfScope').title = pickedRepo() || '~/.claude/workflows';
}

function markSaved(saved, version) {
  const el = $('saveLine');
  if (saved) { el.textContent = `saved${version ? ` · v${version}` : ''}`; el.className = 'save-line clean'; }
  else if (state.loaded || state.def?.graph?.nodes?.length) { el.textContent = 'unsaved changes'; el.className = 'save-line dirty'; }
  else { el.textContent = 'not saved yet'; el.className = 'save-line'; }
}

function renderInputs() {
  const list = state.def.inputs;
  $('inputsCount').textContent = list.length ? `· ${list.length}` : '';
  $('inputsList').innerHTML = list.length ? list.map((f, i) => `
    <div class="list-row three" data-i="${i}">
      <input data-f="key" value="${escapeAttr(f.key || '')}" placeholder="key" spellcheck="false" aria-label="key">
      <input data-f="label" value="${escapeAttr(f.label || '')}" placeholder="Label people see" aria-label="label">
      <label class="tick"><input type="checkbox" data-f="textarea" ${f.textarea ? 'checked' : ''}> long</label>
      <button class="run-btn danger x" data-rm="${i}" title="Remove">✕</button>
      <input class="wide" data-f="placeholder" value="${escapeAttr(f.placeholder || '')}" placeholder="Example shown in the box (optional)">
    </div>`).join('') : '<div class="list-empty">None. A workflow without inputs works on whatever project it is run in.</div>';
  for (const row of $('inputsList').querySelectorAll('.list-row')) {
    const f = list[Number(row.dataset.i)];
    for (const el of row.querySelectorAll('[data-f]')) {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const k = el.dataset.f;
        if (k === 'textarea') { if (el.checked) f.textarea = true; else delete f.textarea; }
        else f[k] = k === 'key' ? slug(el.value, true).replace(/-/g, '_') : el.value;
        changed({ redraw: false });
      });
    }
  }
  for (const b of $('inputsList').querySelectorAll('[data-rm]')) b.onclick = () => { list.splice(Number(b.dataset.rm), 1); changed(); };
}

function renderCanvas() {
  const inner = $('edInner');
  state.origin = gridOrigin();
  // Keep edges SVG, drop cards.
  for (const el of inner.querySelectorAll('.n-card')) el.remove();
  for (const n of state.def.graph.nodes) {
    inner.append(nodeCard(n));
  }
  // Previewing a proposal: steps it would remove stay visible, faded.
  for (const n of state.previewing?.removed || []) inner.append(nodeCard(n));
  // A run shows the steps it ran that the workflow no longer has, faded.
  for (const n of goneSteps()) inner.append(nodeCard({ ...n, gone: true }));
  // Grow the inner container to contain every absolutely-positioned card.
  // Without this, cards past col 6 land outside .ed-canvas-inner's bounds,
  // the SVG stays width:100% of the (narrower) inner, and edges to those
  // nodes draw outside the SVG viewport and get clipped — invisible.
  const nodes = state.def.graph.nodes;
  const o = state.origin;
  state.content = {
    w: nodes.reduce((m, n) => Math.max(m, GUTTER + ((n.col || 0) - o.col) * COL_W + 220), 0) + GUTTER,
    h: nodes.reduce((m, n) => Math.max(m, GUTTER + ((n.row || 0) - o.row) * ROW_H + 140), 0) + GUTTER,
  };
  state.grid = null;
  if (state.run || state.expanded.size) state.content = reflow(inner);
  const canvas = inner.parentElement;
  const w = Math.max(state.content.w, canvas.clientWidth / (state.zoom || 1));
  const h = Math.max(state.content.h, canvas.clientHeight / (state.zoom || 1));
  inner.style.width  = `${w}px`;
  inner.style.height = `${h}px`;
  applyZoom();
  renderEdges();
}

/*
 * Zoom scales the canvas; the negative margins take the scaled-away space
 * back out of the scroll area, which a transform alone leaves behind.
 */
function applyZoom() {
  const inner = $('edInner');
  const z = state.zoom || 1;
  inner.style.transform = z === 1 ? '' : `scale(${z})`;
  inner.style.transformOrigin = '0 0';
  inner.style.marginRight  = `${(z - 1) * parseFloat(inner.style.width || 0)}px`;
  inner.style.marginBottom = `${(z - 1) * parseFloat(inner.style.height || 0)}px`;
  const label = $('zoomLevel');
  if (label) label.textContent = `${Math.round(z * 100)}%`;
}

function setZoom(z) {
  state.zoom = Math.min(1.5, Math.max(0.3, Math.round(z * 100) / 100));
  renderCanvas();
}

/** Scale so every step is in view, never larger than 100%. */
function fitZoom() {
  const canvas = $('edInner').parentElement;
  if (!state.content?.w) return setZoom(1);
  setZoom(Math.min(1, (canvas.clientWidth - 24) / state.content.w, (canvas.clientHeight - 24) / state.content.h));
}

/** One line on what a step does, for its card. */
function summary(n) {
  const s = n.spec || {};
  switch (n.kind) {
    case 'agent': return `${s.verify ? 'Checks its work · ' : ''}${s.prompt || 'No instructions yet'}`;
    case 'script': return s.op ? ({ 'find-dev-server': 'Find the running dev server', 'capture-shot': 'Screenshot a page', 'capture-shots': 'Screenshot several pages' })[s.op] || s.op : (s.cmd ? `$ ${s.cmd}` : 'No command yet');
    case 'decision': return `${s.question || ''} — ${(s.options || []).map((o) => o.label).join(' / ')}`;
    case 'approve': return s.question || '';
    case 'check': return Object.fromEntries(CHECK_TYPES)[s.assert?.type] || s.assert?.type || '';
    case 'loop': return `for each in ${s.over || '…'}`;
    case 'publish': return s.target === 'pr' ? 'Draft a pull request' : `Write ${s.path || 'a file'}`;
    case 'display': return `show ${[].concat(s.from || []).join(', ') || '…'}`;
    case 'delay': return `wait ${s.wait || ''}`;
    case 'inputs': return (s.fields || []).map((f) => f.label || f.key).join(', ');
    default: return n.prompt || n.command || '';
  }
}

/** The leftmost column and top row in use, drawn at the gutter. */
function gridOrigin() {
  const nodes = [...state.def.graph.nodes, ...goneSteps()];
  if (!nodes.length) return { col: 0, row: 0 };
  return { col: Math.min(...nodes.map((n) => n.col || 0)), row: Math.min(...nodes.map((n) => n.row || 0)) };
}

function nodeCard(n) {
  const o = state.origin || { col: 0, row: 0 };
  const x = GUTTER + ((n.col || 0) - o.col) * COL_W;
  const y = GUTTER + ((n.row || 0) - o.row) * ROW_H;
  const card = document.createElement('div');
  const probs = problemsFor(n.id);
  const cls = ['n-card', `k-${n.kind}`];
  if (n.id === state.selectedId) cls.push('sel');
  if (n.id === state.connectFromId) cls.push('connect-src');
  else if (state.connectFromId) cls.push('connect-target');
  if (probs.length && !state.previewing) cls.push('has-problem');
  const pv = previewMark(n.id);
  if (pv) cls.push(`pv-${pv}`);
  // In the run on the canvas: its state on the border, and what it made inside.
  const rn = n.gone ? n : runNode(n.id);
  const rs = !state.previewing && runState(rn);
  if (rs) cls.push(`rs-${rs}`);
  if (rs && previewOf(rn) && /pictures|pages/.test(previewOf(rn).kind)) cls.push('run-wide');
  if (n.gone) cls.push('rs-gone');
  card.className = cls.join(' ');
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.dataset.id = n.id;
  card.dataset.kind = n.kind;
  card.dataset.c = String((n.col || 0) - o.col);
  card.dataset.r = String((n.row || 0) - o.row);
  if (rs) return runCard(card, n, rn, rs);
  const s = n.spec || {};
  const flags = [];
  if (s.retry?.attempts) flags.push(`↻ ${s.retry.attempts}`);
  if (s.timeoutMs) flags.push(`◷ ${Math.round(s.timeoutMs / 60000) || '<1'}m`);
  if (s.idempotent === false) flags.push('once only');
  if (s.uses?.length) flags.push(`${s.uses.length} skill${s.uses.length === 1 ? '' : 's'}`);
  if (probs.length) flags.push(`<span class="bad">${probs.length} to fix</span>`);
  card.innerHTML = `
    <div class="n-head">
      <span class="n-kind">${KIND_GLYPH[n.kind] || '●'} ${escapeHtml(KINDS[n.kind]?.name || LEGACY[n.kind] || n.kind)}</span>
      <span class="n-id">${escapeHtml(n.id)}</span>
    </div>
    <div class="n-title">${escapeHtml(n.title || n.id)}</div>
    <div class="n-what">${escapeHtml(summary(n))}</div>
    ${flags.length ? `<div class="n-foot"><span class="n-flags">${flags.join(' · ')}</span></div>` : ''}
    ${pv ? `<span class="pv-badge">${{ added: 'new', changed: 'changed', removed: 'removed' }[pv]}</span>` : ''}`;
  card.title = probs.map(plain).join('\n');
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (n.kind === 'workflow' && !e.target.closest('a, button') && secondClick(n.id)) { toggleOpen(n.id); return; }
    if (e.shiftKey && state.selectedId && state.selectedId !== n.id) {
      if (addEdge(state.selectedId, n.id)) changed();
      return;
    }
    selectNode(n.id);
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.previewing || card.classList.contains('pv-removed')) return;
    selectNode(n.id);
    confirmDelete(n);
  });
  attachDrag(card, n);
  if (n.kind === 'workflow') openable(card, n, null);
  return card;
}

/** A card whose step is in the run: selected, dragged and deleted as any other. */
function runCard(card, n, rn, rs) {
  card.innerHTML = runCardHtml(n, rn, rs);
  card.title = '';
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cardClick(rn, e)) return;
    if (e.target.closest('.n-preview')) { openPreview(rn); return; }
    if (n.kind === 'workflow' && !n.gone && !e.target.closest('a, button') && secondClick(n.id)) { toggleOpen(n.id); return; }
    if (!n.gone && e.shiftKey && state.selectedId && state.selectedId !== n.id) {
      if (addEdge(state.selectedId, n.id)) changed();
      return;
    }
    selectNode(n.id);
  });
  if (n.gone) return card;
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectNode(n.id);
    confirmDelete(n);
  });
  attachDrag(card, n);
  if (n.kind === 'workflow') openable(card, n, rn);
  return card;
}

function attachDrag(card, n) {
  let dragging = false, moved = false, startX, startY, startLeft, startTop;
  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Buttons and links on a card's result are pressed, not dragged.
    if (e.target.closest('button, a, iframe, video')) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    startLeft = parseFloat(card.style.left); startTop = parseFloat(card.style.top);
    card.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const z = state.zoom || 1;
    const dx = (e.clientX - startX) / z, dy = (e.clientY - startY) / z;
    // Treat tiny pointer wobble as a click, not a drag. Without this the
    // mouseup always re-renders and tears the card out of the DOM before
    // the click handler can run, so selection appears broken.
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    state.dragging = true;
    card.style.left = `${Math.max(0, Math.round((startLeft + dx) / 20) * 20)}px`;
    card.style.top  = `${Math.max(0, Math.round((startTop  + dy) / 20) * 20)}px`;
    renderEdges();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    state.dragging = false;
    card.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (!moved) {
      // plain click — let the click handler fire selectNode.
      if (state.redrawAfterDrag) { state.redrawAfterDrag = false; renderCanvas(); }
      return;
    }
    state.redrawAfterDrag = false;
    // Snap pixels back to col/row and re-render. While a run sizes the
    // cards, the grid's columns and rows are not all the same size.
    const o = state.origin || { col: 0, row: 0 };
    const g = state.grid;
    n.col = Math.max(0, gridIndex(parseFloat(card.style.left), g?.colLeft, COL_W) + o.col);
    n.row = Math.max(0, gridIndex(parseFloat(card.style.top), g?.rowTop, ROW_H) + o.row);
    changed();
  });
}

/** A Decision's edges show the choice's label, not its internal key. */
function edgeLabelText(src, label) {
  if (!label) return '';
  if (src?.kind === 'decision') return (src.spec?.options || []).find((o) => o.edgeLabel === label)?.label || label;
  return label;
}

function renderEdges() {
  const svg = $('edEdges');
  const inner = $('edInner');
  if (!inner) return;
  // Size the SVG to the actual canvas-inner area so paths don't get clipped.
  // Without explicit width/height attributes, Firefox and some Chrome paths
  // can lose geometry outside the natural SVG viewport.

  // Size the SVG to the inner container's full extent (which renderCanvas
  // just stretched to contain every card). Both attribute and inline style
  // so paths outside the natural viewport are not clipped by the renderer.
  const w = Math.ceil(parseFloat(inner.style.width) || inner.offsetWidth);
  const h = Math.ceil(parseFloat(inner.style.height) || inner.offsetHeight);
  svg.setAttribute('width',  w);
  svg.setAttribute('height', h);
  svg.style.width  = `${w}px`;
  svg.style.height = `${h}px`;
  svg.setAttribute('pointer-events', 'all');
  // Read each card's real position via its data-id attribute. Falling back
  // to the col/row math breaks the instant the user drags a node, so we
  // measure the DOM instead — same approach as the runtime canvas.
  const cards = {};
  for (const el of inner.querySelectorAll('.n-card')) cards[el.dataset.id] = el;
  const byId = Object.fromEntries(state.def.graph.nodes.map((n) => [n.id, n]));
  // Two paths per edge: visible curve + a fat invisible one for clicks.
  // Clicking an edge opens the step it leads into, where its "Comes after"
  // list can remove it or change a Decision's branch.
  const parts = [];
  // Several branches of one choice can lead to the same step; their lines
  // overlap, so they share one label instead of stacking three on one spot.
  const pairLabels = {}, pairFirst = {};
  (state.def.graph.edges || []).forEach((edge, i) => {
    const t = edgeLabelText(byId[edge[0]], edge[2]);
    if (!t) return;
    const k = `${edge[0]}→${edge[1]}`;
    (pairLabels[k] ||= []).push(t);
    if (pairFirst[k] == null) pairFirst[k] = i;
  });
  (state.def.graph.edges || []).forEach((edge, i) => {
    const [a, b, label] = edge;
    const srcEl = cards[a], dstEl = cards[b];
    if (!srcEl || !dstEl) return;
    // Layout offsets, not screen rectangles: they are the SVG's own
    // coordinates whatever the zoom.
    const ax = srcEl.offsetLeft + srcEl.offsetWidth;
    const ay = srcEl.offsetTop + srcEl.offsetHeight / 2;
    const bx = dstEl.offsetLeft;
    const by = dstEl.offsetTop + dstEl.offsetHeight / 2;
    // Tangent length — bigger for larger horizontal/vertical spans so the
    // curve has room to open up and doesn't fold back on itself.
    // A forward edge bends within the gap between the two columns; letting
    // the tangent outgrow that gap is what made curves loop back behind
    // their own card. Only an edge that runs backwards gets a wide loop.
    const gap = bx - ax;
    const spanY = Math.abs(by - ay);
    const dx = gap > 20 ? Math.min(Math.max(30, gap * 0.5), 200) : Math.max(80, spanY * 0.3);
    const d  = `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
    parts.push(`<path class="edge-hit" data-i="${i}" d="${d}" fill="none" stroke="transparent"/>`);
    const stroke = label ? 'var(--accent)' : 'var(--design)';
    parts.push(`<path class="edge ${label ? 'labeled' : ''}" data-i="${i}" d="${d}" fill="none" style="stroke:${stroke}" stroke-width="1.4" opacity="0.75"/>`);
    // Pinch dots at each end so the curve clearly lands on its node.
    parts.push(`<circle cx="${ax}" cy="${ay}" r="2.5" style="fill:${stroke}" opacity="0.9"/>`);
    parts.push(`<circle cx="${bx}" cy="${by}" r="2.5" style="fill:${stroke}" opacity="0.9"/>`);
    const k = `${a}→${b}`;
    const text = pairFirst[k] === i ? pairLabels[k].join(' / ') : '';
    if (text) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const lw = Math.max(28, text.length * 7 + 10);
      parts.push(
        `<g class="edge-label" data-i="${i}" transform="translate(${mx - lw / 2},${my - 24})" style="cursor:pointer;">
           <rect width="${lw}" height="18" rx="9" style="fill:var(--label-bg);stroke:var(--accent)" stroke-width="1"/>
           <text x="${lw / 2}" y="12" text-anchor="middle"
                 font-family="Geist Mono, monospace" font-size="10"
                 style="fill:var(--accent)">${escapeHtml(text)}</text>
         </g>`);
    }
  });
  svg.innerHTML = parts.join('');
  for (const el of svg.querySelectorAll('.edge-hit, .edge-label')) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const edge = state.def.graph.edges[Number(el.dataset.i)];
      if (!edge) return;
      state.selectedId = edge[1];
      state.side = null;
      render();
      // Point at the row for this connection in the step's "Comes after".
      $('selEdges').querySelector(`.edge-row[data-i="${el.dataset.i}"]`)?.classList.add('flash');
    });
  }
}

function renderSelected() {
  const n = selectedNode();
  const block = $('selBlock');
  if (!n) { block.style.display = 'none'; $('preview').classList.add('hidden'); return; }
  block.style.display = '';
  $('selSummary').textContent = n.title || n.id;
  $('selKindLine').textContent = KINDS[n.kind]?.desc
    || (LEGACY[n.kind] ? 'An older kind of step. It still runs; switching it to one of the kinds above gives you the full form.' : '');
  $('selId').value = n.id;
  $('selTitle').value = n.title || '';
  $('selKind').value = n.kind;
  $('btnConnect').textContent = state.connectFromId ? 'Cancel connecting' : '↝ Connect to…';
  const s = n.spec || {};
  $('advRetries').value = String(s.retry?.attempts || 0);
  $('advBackoff').value = String(s.retry?.backoffMs || 2000);
  $('advBackoff').disabled = !s.retry?.attempts;
  $('advTimeout').value = s.timeoutMs ? String(s.timeoutMs) : '';
  $('advIdem').checked = s.idempotent !== false;
  $('advAllow').checked = !!s.allowFailure;
  $('advIdemLine').style.display = ['script', 'publish', 'loop'].includes(n.kind) ? '' : 'none';
  $('advAllowLine').style.display = n.kind === 'script' && !s.op ? '' : 'none';
  $('advanced').style.display = ['decision', 'approve', 'display', 'inputs', 'delay'].includes(n.kind) ? 'none' : '';
  renderSpecForm(n);
  renderEdgesForm(n);
}

/**
 * Edges editor for the selected node. Lists incoming edges (parents / "comes
 * after") and outgoing edges (children / "goes before"), with remove buttons
 * on each row and dropdowns to add new ones from the pool of other nodes.
 * An edge out of a Decision picks which choice it follows from a list.
 */
function renderEdgesForm(n) {
  const mount = $('selEdges');
  if (!mount) return;
  const nodes  = state.def.graph.nodes;
  const edges  = state.def.graph.edges || [];
  const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
  const incoming = edges.map((e, i) => ({ e, i })).filter(({ e }) => e[1] === n.id);
  const outgoing = edges.map((e, i) => ({ e, i })).filter(({ e }) => e[0] === n.id);
  const incomingSet = new Set(incoming.map(({ e }) => e[0]));
  const outgoingSet = new Set(outgoing.map(({ e }) => e[1]));
  const candIn  = nodes.filter((x) => x.id !== n.id && !incomingSet.has(x.id));
  const candOut = nodes.filter((x) => x.id !== n.id && !outgoingSet.has(x.id));
  const row = ({ e, i }, dir) => {
    const other = dir === 'in' ? e[0] : e[1];
    const src = byId[e[0]];
    const title = byId[other]?.title || other;
    const opts = src?.kind === 'decision' ? src.spec?.options || [] : [];
    const branch = opts.length
      ? `<select class="lbl-pick" data-branch="${i}" title="Which choice leads here">
           <option value="">always</option>${opts.map((o) => `<option value="${escapeAttr(o.edgeLabel)}" ${o.edgeLabel === e[2] ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
         </select>` : '';
    return `
      <div class="edge-row" data-i="${i}">
        <span class="arrow">${dir === 'in' ? '↳' : '↦'}</span>
        <span>${escapeHtml(title)}${branch}</span>
        <button class="run-btn danger" data-act="rm-edge" data-i="${i}" title="Remove this connection">✕</button>
      </div>`;
  };
  const options = (list) => list.map((x) =>
    `<option value="${escapeAttr(x.id)}">${escapeHtml(x.title || x.id)}</option>`).join('');
  mount.innerHTML = `
    <h4>Comes after (${incoming.length})</h4>
    ${incoming.map((r) => row(r, 'in')).join('') || '<div class="status" style="margin:0;">Nothing — it starts the run.</div>'}
    ${candIn.length ? `
      <div class="edge-add">
        <select id="addInSel"><option value="">— pick a step —</option>${options(candIn)}</select>
        <button class="run-btn" id="btnAddIn">+ add</button>
      </div>` : ''}
    <h4>Goes before (${outgoing.length})</h4>
    ${outgoing.map((r) => row(r, 'out')).join('') || '<div class="status" style="margin:0;">Nothing — the run ends here.</div>'}
    ${candOut.length ? `
      <div class="edge-add">
        <select id="addOutSel"><option value="">— pick a step —</option>${options(candOut)}</select>
        <button class="run-btn" id="btnAddOut">+ add</button>
      </div>` : ''}
  `;
  for (const btn of mount.querySelectorAll('[data-act="rm-edge"]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.def.graph.edges.splice(Number(btn.dataset.i), 1);
      changed();
    });
  }
  for (const sel of mount.querySelectorAll('[data-branch]')) {
    sel.addEventListener('change', () => {
      const edge = state.def.graph.edges[Number(sel.dataset.branch)];
      if (!edge) return;
      if (sel.value) edge[2] = sel.value; else edge.length = 2;
      changed();
    });
  }
  mount.querySelector('#btnAddIn')?.addEventListener('click', () => {
    const other = mount.querySelector('#addInSel')?.value;
    if (other && addEdge(other, n.id)) changed();
  });
  mount.querySelector('#btnAddOut')?.addEventListener('click', () => {
    const other = mount.querySelector('#addOutSel')?.value;
    if (other && addEdge(n.id, other)) changed();
  });
}

/**
 * Per-kind spec editor, in plain words. Text fields that can name what
 * earlier steps produced get an "+ insert" button and a live preview.
 */
function renderSpecForm(n) {
  const mount = $('selSpec');
  const s = n.spec || {};
  const ups = upstream(n.id);
  const opt = (v, label, cur) => `<option value="${escapeAttr(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const refHead = (label, key, hint = '') => `<div class="field-head"><label for="sp-${key}">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label><button type="button" class="ref-btn" data-for="sp-${key}">+ insert</button></div>`;
  const ta = (key, val, ph) => `<textarea id="sp-${key}" data-spec="${key}" data-ref="1" placeholder="${escapeAttr(ph)}">${escapeHtml(val || '')}</textarea>`;
  const txt = (key, val, ph, ref = false) => `<input id="sp-${key}" data-spec="${key}" ${ref ? 'data-ref="1"' : ''} value="${escapeAttr(val ?? '')}" placeholder="${escapeAttr(ph)}">`;
  // A value the form has no option for (written by hand, or by a newer
  // version) is kept and shown, not silently replaced by the first option.
  const sel = (key, val, options) => {
    const known = options.some(([v]) => String(v) === String(val ?? ''));
    const extra = !known && val != null && val !== '' ? opt(val, `${val} (set in the file)`, val) : '';
    return `<select id="sp-${key}" data-spec="${key}">${extra}${options.map(([v, l]) => opt(v, l, val)).join('')}</select>`;
  };
  const upSel = (key, val) => ups.length
    ? `<select id="sp-${key}" data-spec="${key}">${opt('', 'Pick a step before this one', val)}${ups.map((u) => opt(u.id, u.title || u.id, val)).join('')}</select>`
    : '<div class="list-empty">Connect a step into this one first.</div>';
  let html = '';
  switch (n.kind) {
    case 'agent':
      html = refHead('What should Claude do?', 'prompt', 'say what to produce')
        + ta('prompt', s.prompt, 'Write a one-page summary of {{nodes.research.output}} for {{inputs.audience}}.')
        + `<div class="row2"><div><label for="sp-model">Model</label>${sel('model', s.model || 'sonnet', [['haiku', 'Haiku — fast'], ['sonnet', 'Sonnet — balanced'], ['opus', 'Opus — most capable']])}</div>`
        + `<div><label for="sp-output">It produces</label>${sel('output', s.output || 'markdown', [['markdown', 'Text'], ['json', 'Data (JSON)'], ['json-findings', 'Review findings'], ['html', 'A web page'], ['json-hunks', 'A code change']])}</div></div>`
        + `<label>Skills to use <span class="hint">named in the prompt; Claude uses one where it applies</span></label>${skillPicker(s.uses || [])}`
        + verifyBox(s.verify);
      break;
    case 'script':
      html = `<label for="sp-op">It does</label>${sel('op', s.op || '', [['', 'Run a command'], ['find-dev-server', 'Find the running dev server'], ['capture-shot', 'Screenshot a page'], ['capture-shots', 'Screenshot several pages']])}`
        + (s.op === 'find-dev-server' ? '<div class="hint block-hint">Stops the run with a clear message if the project\'s dev server is not running, so later screenshots are of your app and not something else.</div>'
          : s.op ? '<div class="hint block-hint">Uses the running app Orderly found for this project, or the page given as an input. Error pages and blank pages are not counted as captured.</div>'
          : refHead('Command', 'cmd', 'runs in the project folder; inserted values are quoted') + ta('cmd', s.cmd, 'npm test')
            + refHead('Show on the run page', 'show', 'pictures or clips it makes; * matches many') + txt('show', s.show, 'out/*.png, out/demo.mp4', true));
      break;
    case 'decision':
      html = refHead('Question', 'question') + txt('question', s.question, 'Which direction wins?', true)
        + '<label>Choices <span class="hint">pick which one each connection follows under Goes before</span></label>'
        + (s.options || []).map((o, i) => `<div class="list-row"><input class="wide" data-opt="${i}" value="${escapeAttr(o.label || '')}" placeholder="Choice"><span></span><button class="run-btn danger x" data-rm-opt="${i}" title="Remove">✕</button></div>`).join('')
        + '<button class="run-btn" data-act="add-opt">+ add choice</button>';
      break;
    case 'workflow': {
      const lib = (state.library || []).filter((w) => w.id !== state.def.id);
      const pick = workflowPicked(s, lib);
      const wfOpt = (w) => `<option value="${escapeAttr(w.key || w.id)}" ${pick && (pick.key || pick.id) === (w.key || w.id) ? 'selected' : ''}>${escapeHtml(w.title || w.id)}${w.scope === 'project' && w.repoName ? ` · ${escapeHtml(w.repoName)}` : w.scope === 'builtin' ? ' · starter' : ''}</option>`;
      html = '<label for="sp-wf">Workflow to run</label>'
        + `<select id="sp-wf" data-wf="1"><option value="">${state.library ? 'Pick a workflow' : 'Loading your workflows…'}</option>`
        + (s.workflow && !pick ? `<option value="" selected>${escapeHtml(s.workflow)} (not found)</option>` : '')
        + `${lib.map(wfOpt).join('')}</select>`;
      if (pick) {
        html += `<div class="hint block-hint">${escapeHtml(pick.description || '')} <a href="/workflow-editor.html?from=${encodeURIComponent(pick.id)}${refQuery(pick)}" target="_blank">Open it ↗</a></div>`;
        const fields = pick.inputs || [];
        html += fields.length
          ? `<h4 class="sub-h">Its inputs</h4><div class="hint block-hint">What this run gives it each time. Type text, or insert an input or a result from an earlier step.</div>`
            + fields.map((f) => refHead(escapeHtml(f.label || f.key), `inputs.${f.key}`) + txt(`inputs.${f.key}`, s.inputs?.[f.key], f.placeholder || '', true)).join('')
          : '<div class="hint block-hint">It asks for nothing, so it runs as it is.</div>';
        const steps = pick.graph?.nodes || [];
        if (steps.length) {
          html += `<h4 class="sub-h">What it hands on</h4><div class="hint block-hint">Later steps can use any of its steps' results, for example <code>{{nodes.${escapeHtml(n.id)}.output.steps.${escapeHtml(steps[steps.length - 1].id)}}}</code>. Its steps: ${steps.map((x) => `<code>${escapeHtml(x.id)}</code>`).join(' ')}</div>`;
        }
      }
      break;
    }
    case 'approve':
      html = refHead('What are you approving?', 'question') + txt('question', s.question, 'Ship {{inputs.version}}?', true);
      break;
    case 'check':
      html = `<label for="sp-assert.type">Passes when</label>${sel('assert.type', s.assert?.type || 'exit-zero', CHECK_TYPES)}`
        + `<label for="sp-assert.from">Looking at</label>${upSel('assert.from', s.assert?.from)}`
        + (s.assert?.type === 'contains' ? refHead('The text', 'assert.needle') + txt('assert.needle', s.assert?.needle, 'All tests passed', true) : '')
        + (s.assert?.type === 'contrast-min' ? `<label for="sp-assert.ratio">At least</label>${sel('assert.ratio', String(s.assert?.ratio || 4.5), [['3', '3 : 1 — large text only'], ['4.5', '4.5 : 1 — normal text (WCAG AA)'], ['7', '7 : 1 — strictest (WCAG AAA)']])}` : '')
        + (s.assert?.type === 'font-is-brand' ? `<label for="sp-assert.role">Font</label>${sel('assert.role', s.assert?.role || 'sans', [['sans', 'Body font'], ['mono', 'Code font']])}` : '')
        + (BRAND_CHECKS.has(s.assert?.type) ? '<div class="hint block-hint">Reads the screenshots or rendered pages of the step it looks at, against the colours and fonts in <code>.claude/brand.json</code> and <code>web/app.css</code>.</div>' : '')
        + `<label for="sp-onFail">If it fails</label>${sel('onFail', s.onFail || 'stop', [['stop', 'Stop the whole run'], ['skip', 'Skip what comes after, finish the rest']])}`;
      break;
    case 'loop':
      html = refHead('For each item in', 'over', 'a list: an input, or something an earlier step made') + txt('over', s.over, '{{inputs.pages}}', true)
        + `<label for="sp-action">Do</label>${sel('action', s.action || 'agent', [['agent', 'Ask Claude'], ['script', 'Run a command']])}`
        + (s.action === 'script'
          ? refHead('Command', 'cmd', 'use {{item}} for the current item') + ta('cmd', s.cmd, 'npx lighthouse {{item}}')
          : refHead('What should Claude do with each?', 'prompt', 'use {{item}} for the current item') + ta('prompt', s.prompt, 'Summarise {{item}} in two sentences.'))
        + `<div class="row2"><div><label for="sp-max">At most</label>${sel('max', String(s.max || 50), [['5', '5 items'], ['20', '20 items'], ['50', '50 items'], ['100', '100 items'], ['500', '500 items']])}</div>`
        + `<div><label for="sp-concurrency">At once</label>${sel('concurrency', String(s.concurrency || 1), [['1', 'One at a time'], ['2', '2'], ['4', '4'], ['8', '8']])}</div></div>`
        + `<label for="sp-join">Hand on</label>${sel('join', s.join || 'concat', [['concat', 'Every result'], ['first-match', 'The first one that worked'], ['vote', 'Pass if most say yes']])}`;
      break;
    case 'publish':
      html = `<label for="sp-target">It</label>${sel('target', s.target || 'file', [['file', 'Writes a file in the project'], ['pr', 'Drafts a pull request']])}`
        + (s.target === 'pr' ? '<div class="hint block-hint">Drafts the title and description from the steps before it. It does not open the PR on GitHub.</div>'
          : refHead('File', 'path', 'inside the project') + txt('path', s.path, 'reports/{{inputs.week}}.md', true)
            + refHead('What goes in it', 'content', 'empty = everything the steps before it produced') + ta('content', s.content, '{{nodes.summary.output}}'));
      break;
    case 'display':
      html = `<label>Show</label>${ups.length ? `<div class="pick-list">${ups.map((u) => `<label><input type="checkbox" data-from="${escapeAttr(u.id)}" ${[].concat(s.from || []).includes(u.id) ? 'checked' : ''}> ${escapeHtml(u.title || u.id)}</label>`).join('')}</div>` : '<div class="list-empty">Connect the steps to show into this one.</div>'}`
        + `<label for="sp-render">As</label>${sel('render', s.render || 'markdown', [['markdown', 'Text'], ['mockups-grid', 'Web pages side by side'], ['shots-set', 'Screenshots'], ['json', 'Data'], ['diff', 'Code changes']])}`;
      break;
    case 'delay':
      html = `<label for="sp-wait">Wait</label>${sel('wait', s.wait || '30s', [['10s', '10 seconds'], ['30s', '30 seconds'], ['2m', '2 minutes'], ['5m', '5 minutes'], ['10m', '10 minutes (the most)']])}`;
      break;
    case 'inputs':
      html = '<label>Fields</label>' + (s.fields || []).map((f, i) => `<div class="list-row"><input data-field="${i}" data-k="key" value="${escapeAttr(f.key || '')}" placeholder="key"><input data-field="${i}" data-k="label" value="${escapeAttr(f.label || '')}" placeholder="Label"><button class="run-btn danger x" data-rm-field="${i}" title="Remove">✕</button></div>`).join('')
        + '<button class="run-btn" data-act="add-field">+ add field</button><div class="hint block-hint">The workflow\'s own Inputs, in ⚙ Settings, usually do this more simply.</div>';
      break;
    default:
      html = `<label for="sp-legacy">Instructions</label><textarea id="sp-legacy" data-legacy="1">${escapeHtml(n.prompt || n.command || '')}</textarea>`;
  }
  mount.innerHTML = html;
  for (const el of mount.querySelectorAll('[data-verify], [data-verify-check]')) {
    const turnsOn = el.dataset.verify === 'on';
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      readVerify(mount);
      changed({ redraw: turnsOn ? true : 'canvas' });
    });
  }

  for (const el of mount.querySelectorAll('[data-spec]')) {
    const key = el.dataset.spec;
    const numeric = ['max', 'concurrency', 'assert.ratio'].includes(key);
    // These change which other fields the form shows.
    const shaping = ['op', 'action', 'target', 'assert.type'].includes(key);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      writeSpec(key, numeric ? Number(el.value) : el.value, { silent: !shaping });
    });
    if (el.dataset.ref) el.addEventListener('focus', () => { state.refField = el; previewSoon(); });
  }
  mount.querySelector('[data-wf]')?.addEventListener('change', (e) => {
    const w = (state.library || []).find((x) => (x.key || x.id) === e.target.value);
    const x = selectedNode(); if (!x) return;
    // Which workflow, and where it lives, so the run finds the same one.
    x.spec = { ...x.spec, workflow: w?.id || '', scope: w?.scope || undefined, repo: w?.scope === 'project' ? w.repoRoot : undefined, inputs: {} };
    if (!w) delete x.spec.workflow;
    changed();
  });
  for (const b of mount.querySelectorAll('.ref-btn')) {
    b.addEventListener('click', (e) => { e.stopPropagation(); openRefPop(b, $(b.dataset.for)); });
  }
  mount.querySelector('[data-legacy]')?.addEventListener('input', (e) => {
    const x = selectedNode(); if (!x) return;
    if ('command' in x && !('prompt' in x)) x.command = e.target.value; else x.prompt = e.target.value;
    changed({ redraw: 'canvas' });
  });
  // Decision choices: the label is what people see; the edge label is fixed
  // when the choice is made, so connections keep pointing at the right one.
  for (const el of mount.querySelectorAll('[data-opt]')) {
    el.addEventListener('input', () => { s.options[Number(el.dataset.opt)].label = el.value; changed({ redraw: 'canvas' }); });
  }
  for (const b of mount.querySelectorAll('[data-rm-opt]')) b.onclick = () => {
    const [gone] = s.options.splice(Number(b.dataset.rmOpt), 1);
    state.def.graph.edges = state.def.graph.edges.filter((e) => !(e[0] === n.id && e[2] === gone.edgeLabel));
    changed();
  };
  mount.querySelector('[data-act="add-opt"]')?.addEventListener('click', () => {
    s.options = s.options || [];
    let k = s.options.length + 1;
    while (s.options.some((o) => o.edgeLabel === `opt${k}`)) k++;
    s.options.push({ label: `Choice ${s.options.length + 1}`, edgeLabel: `opt${k}` });
    changed();
  });
  for (const el of mount.querySelectorAll('[data-field]')) {
    el.addEventListener('input', () => { s.fields[Number(el.dataset.field)][el.dataset.k] = el.value; changed({ redraw: 'canvas' }); });
  }
  for (const b of mount.querySelectorAll('[data-rm-field]')) b.onclick = () => { s.fields.splice(Number(b.dataset.rmField), 1); changed(); };
  mount.querySelector('[data-act="add-field"]')?.addEventListener('click', () => {
    s.fields = s.fields || [];
    s.fields.push({ key: `field${s.fields.length + 1}`, label: '', type: 'text' });
    changed();
  });
  for (const el of mount.querySelectorAll('[data-from]')) {
    el.addEventListener('change', () => {
      const picked = [...mount.querySelectorAll('[data-from]:checked')].map((x) => x.dataset.from);
      writeSpec('from', picked.length ? picked : undefined, { silent: true });
    });
  }
  for (const el of mount.querySelectorAll('[data-skill]')) {
    el.addEventListener('change', () => {
      const picked = [...mount.querySelectorAll('[data-skill]:checked')].map((x) => x.dataset.skill);
      writeSpec('uses', picked.length ? picked : undefined, { silent: true });
    });
  }
  // Preview the main text field without waiting for a focus.
  if (!state.refField || !mount.contains(state.refField)) state.refField = mount.querySelector('[data-ref]');
  previewSoon();
}

/** The library entry a Run a workflow step names: same repo first, then by id. */
function workflowPicked(spec, lib) {
  if (!spec.workflow) return null;
  return lib.find((w) => w.id === spec.workflow && (!spec.repo || w.repoRoot === spec.repo) && (!spec.scope || w.scope === spec.scope))
    || lib.find((w) => w.id === spec.workflow) || null;
}

/** Ask Claude: look at the result, and try again with what was wrong. */
function verifyBox(v) {
  const on = !!v;
  const types = new Set((v?.asserts || []).map((a) => a.type));
  const judge = (v?.asserts || []).find((a) => a.type === 'llm-judge');
  const routes = (v?.renders || []).map((r) => (typeof r === 'string' ? r : r.route)).join(', ');
  const o = (val, label, cur) => `<option value="${val}" ${String(cur) === String(val) ? 'selected' : ''}>${label}</option>`;
  return `<div class="verify-box ${on ? 'on' : ''}">
    <label class="check-line"><input type="checkbox" data-verify="on" ${on ? 'checked' : ''}> Check its work before moving on</label>
    ${on ? `<div class="verify-body">
      <label for="vf-routes">Pages to look at <span class="hint">in the running app; comma separated; empty = don't open any</span></label>
      <input id="vf-routes" data-verify="routes" value="${escapeAttr(routes)}" placeholder="/, /pricing">
      <div class="hint block-hint">A page that errors or comes back blank fails the check.</div>
      <label>Checks</label>
      <div class="pick-list">${VERIFY_CHECKS.map(([t, l]) => `<label><input type="checkbox" data-verify-check="${t}" ${types.has(t) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      <label for="vf-rubric">Judge it against <span class="hint">optional; a second model reads the result</span></label>
      <textarea id="vf-rubric" class="short" data-verify="rubric" placeholder="The hero says what the product does in one line, with no placeholder text.">${escapeHtml(judge?.rubric || '')}</textarea>
      <div class="row2">
        <div><label for="vf-retries">If it fails, try again</label><select id="vf-retries" data-verify="retries">${[0, 1, 2, 3].map((n) => o(n, n === 0 ? 'No' : `${n} more time${n > 1 ? 's' : ''}`, v.maxRetries ?? 1)).join('')}</select></div>
        <div><label for="vf-onfail">If it still fails</label><select id="vf-onfail" data-verify="onFail">${o('stop', 'Stop the run', v.onFail || 'stop')}${o('skip', 'Carry on, marked failed', v.onFail || 'stop')}</select></div>
      </div>
    </div>` : ''}
  </div>`;
}

/** Read the verify box back into spec.verify. */
function readVerify(mount) {
  const n = selectedNode(); if (!n) return;
  n.spec = n.spec || {};
  if (!mount.querySelector('[data-verify="on"]')?.checked) { delete n.spec.verify; return; }
  const prev = n.spec.verify || {};
  const routesEl = mount.querySelector('[data-verify="routes"]');
  if (!routesEl) { n.spec.verify = { renders: [], asserts: [], maxRetries: 1, onFail: 'stop', ...prev }; return; }
  const renders = routesEl.value.split(',').map((r) => r.trim()).filter(Boolean);
  const keep = (prev.asserts || []).filter((a) => !VERIFY_CHECKS.some(([t]) => t === a.type) && a.type !== 'llm-judge');
  const asserts = [...keep, ...[...mount.querySelectorAll('[data-verify-check]:checked')].map((el) => (
    el.dataset.verifyCheck === 'contrast-min' ? { type: 'contrast-min', ratio: 4.5 } : { type: el.dataset.verifyCheck }))];
  const rubric = mount.querySelector('[data-verify="rubric"]').value.trim();
  if (rubric) asserts.push({ type: 'llm-judge', rubric });
  n.spec.verify = {
    ...(renders.length ? { renders } : {}),
    ...(asserts.length ? { asserts } : {}),
    maxRetries: Number(mount.querySelector('[data-verify="retries"]').value),
    onFail: mount.querySelector('[data-verify="onFail"]').value,
  };
}

function skillPicker(chosen) {
  const skills = [...new Map(state.skills.map((k) => [k.slug, k])).values()];
  if (!skills.length) return '<div class="list-empty">No skills installed. They live in ~/.claude/skills, or a project\'s .claude/skills.</div>';
  return `<div class="pick-list">${skills.map((k) => `<label><input type="checkbox" data-skill="${escapeAttr(k.slug)}" ${chosen.includes(k.slug) ? 'checked' : ''}> ${escapeHtml(k.slug)} <span class="pd">${escapeHtml((k.description || '').slice(0, 70))}</span></label>`).join('')}</div>`;
}

function selectedNode() {
  return state.def.graph.nodes.find((n) => n.id === state.selectedId) || null;
}

/**
 * Patch `node.spec` with a dot-path key like 'assert.type' or 'prompt'.
 * `silent` keeps the form as it is — for typing, so focus is not lost — and
 * redraws only the cards.
 */
function writeSpec(key, value, { silent = false } = {}) {
  const n = selectedNode(); if (!n) return;
  n.spec = n.spec || {};
  const parts = key.split('.');
  let o = n.spec;
  for (const p of parts.slice(0, -1)) o = (o[p] ||= {});
  const last = parts[parts.length - 1];
  if (value === '' || value === undefined) delete o[last]; else o[last] = value;
  changed({ redraw: silent ? 'canvas' : true });
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('json-mode', mode === 'json');
  $('modeVisual').classList.toggle('on', mode === 'visual');
  $('modeJson').classList.toggle('on', mode === 'json');
  render();
}

/* -------------------------------- Claude --------------------------------- */

/*
 * The assistant's conversation is kept per workflow. A saved one is named by
 * where it lives; one not saved yet gets a name for this tab, which moves to
 * the real one on the first save.
 */
function assistantKey() {
  if (state.loaded) return `wf:${state.loaded.scope}:${state.loaded.repoRoot || ''}:${state.loaded.id}`;
  let k = null;
  try { k = sessionStorage.getItem('oc-assist-new'); } catch { /* private window */ }
  if (!k) {
    k = `new:${crypto.randomUUID()}`;
    try { sessionStorage.setItem('oc-assist-new', k); } catch { /* fine: one per load */ }
  }
  return k;
}

function mountClaude() {
  state.assistant = mountAssistant({
    launcher: $('btnClaude'),
    key: assistantKey,
    // While previewing, Claude still works from what the person has.
    def: () => (state.previewing ? state.previewing.backup : state.def),
    repoRoot: () => state.loaded?.repoRoot || null,
    title: () => (state.previewing ? state.previewing.backup : state.def)?.title || '',
    isPreviewing: () => !!state.previewing,
    preview: startPreview,
    endPreview,
    apply: applyProposal,
    save,
  });
  addEventListener('resize', relayout);
  $('pvStop').addEventListener('click', () => { endPreview(); state.assistant.renderProposal(); });
}

/*
 * The canvas takes whatever room is left under the header, which changes
 * when the assistant docks beside it and the header wraps to two rows.
 */
function relayout() {
  const layout = $('edLayout');
  const top = layout.getBoundingClientRect().top;
  layout.style.height = `${Math.max(320, innerHeight - top)}px`;
  requestAnimationFrame(() => { render(); showAll(); });
}

/** Zoom out just enough that every step is on screen. */
function showAll() {
  const canvas = $('edInner')?.parentElement;
  if (state.content && canvas && (canvas.clientWidth < state.content.w * state.zoom || canvas.clientHeight < state.content.h * state.zoom)) fitZoom();
}

function previewMark(id) {
  const p = state.previewing;
  if (!p) return null;
  if (p.removedIds.has(id)) return 'removed';
  if (p.addedIds.has(id)) return 'added';
  if (p.changedIds.has(id)) return 'changed';
  return null;
}

/** Show a proposal on the canvas without changing the workflow. */
function startPreview(draft, diff) {
  if (state.previewing) endPreview();
  const backup = state.def;
  const next = normalise(structuredClone(draft));
  placeNew(next, backup);
  state.previewing = {
    backup,
    removed: diff.steps.removed.map((r) => backup.graph.nodes.find((n) => n.id === r.id)).filter(Boolean),
    removedIds: new Set(diff.steps.removed.map((x) => x.id)),
    addedIds: new Set(diff.steps.added.map((x) => x.id)),
    changedIds: new Set(diff.steps.changed.map((x) => x.id)),
  };
  state.def = next;
  state.selectedId = null; state.connectFromId = null; state.side = null;
  document.body.classList.add('previewing');
  $('pvBanner').hidden = false;
  render();
  // A proposal shown off the edge of the canvas is not shown at all.
  showAll();
}

function endPreview() {
  if (!state.previewing) return;
  state.def = state.previewing.backup;
  state.previewing = null;
  document.body.classList.remove('previewing');
  $('pvBanner').hidden = true;
  render();
}

/** Put a proposal on the canvas, unsaved. Returns how to take it back. */
function applyProposal(draft) {
  if (state.previewing) endPreview();
  const before = structuredClone(state.def);
  const wasDirty = state.dirty;
  const next = normalise(structuredClone(draft));
  placeNew(next, before);
  // The workflow keeps its identity; Claude does not rename it.
  next.id = before.id || next.id;
  state.def = next;
  changed();
  return () => {
    state.def = before;
    changed();
    if (!wasDirty && state.loaded) { state.dirty = false; markSaved(true, state.def.version); }
  };
}

/*
 * Steps Claude added come without a place on the canvas. Each goes one
 * column right of the latest step it waits on, in the first free row near
 * it; everything the person placed stays where it is.
 */
function placeNew(def, before) {
  const nodes = def.graph.nodes;
  const placed = (n) => Number.isFinite(n.col) && Number.isFinite(n.row);
  const keep = new Map((before?.graph?.nodes || []).map((n) => [n.id, n]));
  for (const n of nodes) {
    const was = keep.get(n.id);
    if (!placed(n) && was && placed(was)) { n.col = was.col; n.row = was.row; }
  }
  const parents = Object.fromEntries(nodes.map((n) => [n.id, []]));
  for (const [a, b] of def.graph.edges) parents[b]?.push(a);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const taken = new Set(nodes.filter(placed).map((n) => `${n.col}:${n.row}`));
  const firstCol = nodes.some(placed) ? Math.min(...nodes.filter(placed).map((n) => n.col)) : 1;
  let guard = nodes.length * nodes.length + 5;
  while (nodes.some((n) => !placed(n)) && guard-- > 0) {
    for (const n of nodes) {
      if (placed(n)) continue;
      const ps = parents[n.id].map((id) => byId[id]).filter(Boolean);
      if (ps.some((p) => !placed(p))) continue; // place its parents first
      n.col = ps.length ? Math.max(...ps.map((p) => p.col)) + 1 : firstCol;
      let row = ps.length ? ps[0].row : 0;
      while (taken.has(`${n.col}:${row}`)) row++;
      n.row = row;
      taken.add(`${n.col}:${n.row}`);
    }
  }
  // Anything left (only possible in a loop) goes at the end of the first column.
  for (const n of nodes) if (!placed(n)) { n.col = firstCol; n.row = Math.max(-1, ...nodes.filter(placed).map((x) => x.row)) + 1; }
  // A step slotted in between two others pushes what follows it one column
  // right, so every connection still reads left to right.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const [a, b] of def.graph.edges) {
      if (byId[a] && byId[b] && byId[b].col <= byId[a].col) { byId[b].col = byId[a].col + 1; moved = true; }
    }
    if (!moved) break;
  }
}

/* --------------------------- a run on the canvas -------------------------- */

/*
 * A run of this workflow is shown on its own canvas: each card keeps its
 * place and fills in with what the step made, and its border says how it is
 * going. A step added since the run, or not reached yet, stays as it is here.
 * The run bar above the canvas has the run's state, question and actions;
 * the sidebar has the selected step's result above its settings. All of it
 * is drawn by run-view.mjs, which the run page uses too.
 */
bindRunView({
  reload: () => refreshRun(),
  select: (id) => selectNode(id),
  selected: () => state.selectedId,
  restack: () => renderCanvas(),
  cardEl: (id) => $('edInner').querySelector(`.n-card[data-id="${CSS.escape(id)}"]`),
  actionsMount: () => $('rbActions'),
  drawerEl: () => $('runStep'),
  runHref: (id) => `/workflow-editor.html?run=${encodeURIComponent(id)}`,
  openRun: (id) => showRun(id),
  afterDelete: () => closeRun(),
  again: (r) => openRunDialog({ prefill: r.inputs || {} }),
  answerHint: '◆ Answer it above the canvas',
  childAnswer: 'Answer it above the canvas, or open its run ↗',
});

function runNode(id) { return state.run?.graph?.nodes?.find((n) => n.id === id) || null; }

/** How a step is doing in the run on the canvas; null until it starts. */
function runState(rn) {
  if (!rn || rn.status === 'pending') return null;
  if (rn.waitsFor) return 'ask';
  return { done: 'done', running: 'running', failed: 'failed', skipped: 'skipped', stopped: 'stopped', interrupted: 'stopped' }[rn.status] || null;
}

const RS_BADGE = {
  done: svgMark('<path d="M3.5 7.2 L6 9.6 L10.5 4.6"/>'),
  failed: svgMark('<path d="M7 2.2 L12.4 11.6 H1.6 Z"/><line x1="7" y1="5.6" x2="7" y2="8.3"/><circle cx="7" cy="10" r="0.4" fill="currentColor"/>', 1.4),
  ask: '?',
};
function svgMark(inner, w = 2) {
  return `<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/** Steps the run had that the workflow does not have any more. */
function goneSteps() {
  if (!state.run) return [];
  const here = new Set(state.def.graph.nodes.map((n) => n.id));
  return state.run.graph.nodes.filter((n) => !here.has(n.id) && n.status !== 'pending');
}

/** True when a step is set up differently now from how the run ran it. */
function changedSinceRun(n) {
  const ran = state.run?.definition?.graph?.nodes?.find((x) => x.id === n.id);
  if (!ran) return !!state.run?.definition;
  return ran.kind !== n.kind || JSON.stringify(ran.spec ?? null) !== JSON.stringify(n.spec ?? null);
}

/** The card's inside while its step is in the run: what it made, as on the run page. */
function runCardHtml(n, rn, rs) {
  const m = rn.output?.meta || {};
  const model = m.model
    ? String(m.model).replace(/^claude-/, '').replace(/^([a-z]+)-(\d+)-(\d+).*$/i, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`)
    : '';
  const foot = [cardFootMeta(rn, m)].filter(Boolean);
  if (outOfDate(rn)) foot.push('<span class="rs-changed" title="An earlier step was redone after this one ran">out of date</span>');
  if (!rn.gone && changedSinceRun(n)) foot.push('<span class="rs-changed" title="You changed this step after the run used it">changed since</span>');
  return `
    <div class="n-head">
      <span class="n-kind">${KIND_GLYPH[n.kind] || '●'} ${escapeHtml(KINDS[n.kind]?.name || LEGACY[n.kind] || KIND_LABEL[n.kind] || n.kind)}</span>
      ${model ? `<span class="n-model">${escapeHtml(model)}</span>` : `<span class="n-id">${escapeHtml(n.id)}</span>`}
    </div>
    <div class="n-title">${escapeHtml(n.title || n.id)}</div>
    ${rn.gone ? '<div class="n-gone">not in the workflow any more</div>' : ''}
    <div class="c-body">${cardBody(rn)}</div>
    ${previewOf(rn) ? '<button type="button" class="n-preview" title="Open what it made, full size">Preview ↗</button>' : ''}
    ${foot.length ? `<div class="n-foot"><span class="n-meta">${foot.join(' · ')}</span></div>` : ''}
    ${RS_BADGE[rs] ? `<span class="rs-badge" aria-label="${{ done: 'done', failed: 'failed', ask: 'waiting for you' }[rs]}">${RS_BADGE[rs]}</span>` : ''}`;
}

/*
 * Cards that show a result are taller, or wider, than the grid allows for.
 * Each column is as wide as its widest card and each row as tall as its
 * tallest, so nothing overlaps; with nothing big the grid is as it was.
 */
function reflow(inner) {
  const cards = [...inner.querySelectorAll('.n-card')];
  const colW = {}, rowH = {};
  for (const el of cards) {
    const c = Number(el.dataset.c), r = Number(el.dataset.r);
    colW[c] = Math.max(colW[c] || 0, el.offsetWidth);
    rowH[r] = Math.max(rowH[r] || 0, el.offsetHeight);
  }
  const maxC = Math.max(0, ...Object.keys(colW).map(Number));
  const maxR = Math.max(0, ...Object.keys(rowH).map(Number));
  const colLeft = [], rowTop = [];
  for (let c = 0, x = GUTTER; c <= maxC + 1; c++) { colLeft[c] = x; x += Math.max(COL_W, (colW[c] || 0) + 40); }
  for (let r = 0, y = GUTTER; r <= maxR + 1; r++) { rowTop[r] = y; y += Math.max(ROW_H, (rowH[r] || 0) + 40); }
  for (const el of cards) {
    el.style.left = `${colLeft[Number(el.dataset.c)]}px`;
    el.style.top = `${rowTop[Number(el.dataset.r)]}px`;
  }
  state.grid = { colLeft, rowTop };
  return {
    w: colLeft[maxC] + (colW[maxC] || 200) + GUTTER,
    h: rowTop[maxR] + (rowH[maxR] || 92) + GUTTER,
  };
}

/** The column or row a dropped card lands in, on a grid whose steps vary. */
function gridIndex(px, starts, step) {
  if (!starts?.length) return Math.round((px - GUTTER) / step);
  const last = starts.length - 1;
  if (px > starts[last]) return last + Math.round((px - starts[last]) / step);
  let best = 0;
  for (let i = 1; i < starts.length; i++) if (Math.abs(starts[i] - px) < Math.abs(starts[best] - px)) best = i;
  return best;
}

/** Show a run on the canvas, and keep it up to date. */
async function showRun(runId) {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json()).catch(() => ({}));
  if (!r.run) { toast('That run is not there any more — it may have been deleted.', 'err'); return false; }
  state.runId = runId;
  applyRun(r);
  const q = new URLSearchParams(location.search);
  q.set('run', runId);
  history.replaceState(null, '', `${location.pathname}?${q}`);
  followRuns();
  if (state.side === 'runs') state.side = null;
  render();
  fitLayout();
  return true;
}

function applyRun(r) {
  state.run = r.run;
  state.runMeta = r;
  setRun(r.run, r);
  document.body.classList.add('has-run');
  renderRunBar();
}

/** Fetch the run again after an update, and redraw only what a run changes. */
async function refreshRun() {
  if (!state.runId) return;
  const r = await fetch(`/api/runs/${encodeURIComponent(state.runId)}`).then((x) => x.json()).catch(() => ({}));
  if (!r.run || r.run.runId !== state.runId) return;
  applyRun(r);
  await refreshChildRuns();
  // A card being dragged is left alone; it redraws when it is let go.
  if (state.dragging) state.redrawAfterDrag = true; else renderCanvas();
  renderRunStep();
  refreshRedo();
}

function closeRun() {
  state.run = null; state.runId = null; state.runMeta = {};
  setRun(null, {});
  document.body.classList.remove('has-run');
  $('runBar').classList.add('hidden');
  const q = new URLSearchParams(location.search);
  q.delete('run');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  render();
  fitLayout();
}

/* Every run's events arrive on one stream; only this run's redraw the canvas. */
let runStream = null;
function followRuns() {
  if (runStream || new URLSearchParams(location.search).has('snapshot')) return;
  runStream = new EventSource('/events');
  let pending = null;
  const mine = (e) => {
    let id = null;
    try { id = JSON.parse(e.data || '{}').runId; } catch { /* no payload */ }
    // A workflow this run runs reports on its own run; its questions show here.
    const children = (state.run?.graph?.nodes || []).map((x) => x.output?.child?.runId).concat(Object.values(state.childRuns).map((x) => x?.runId)).filter(Boolean);
    if (!state.runId || (id && id !== state.runId && !children.includes(id))) return;
    clearTimeout(pending);
    pending = setTimeout(() => refreshRun().catch(() => {}), 120);
  };
  for (const ev of ['update', 'run-start', 'run-finish']) runStream.addEventListener(ev, mine);
  // The stream drops when Orderly restarts. A browser retries some drops and
  // gives up on others; a closed stream is opened again, and the run read
  // afresh, so the page never sits on an old picture.
  runStream.addEventListener('error', () => {
    if (runStream?.readyState !== EventSource.CLOSED) return;
    runStream = null;
    setTimeout(() => { followRuns(); refreshRun().catch(() => {}); }, 2000);
  });
  runStream.addEventListener('open', () => refreshRun().catch(() => {}));
}

/*
 * Belt and braces for a live run: read it again every few seconds while the
 * tab is showing, and as soon as it is shown again, whatever the stream did.
 */
const LIVE = new Set(['running', 'awaiting-answer']);
setInterval(() => {
  if (state.runId && LIVE.has(state.run?.status) && document.visibilityState === 'visible' && !state.dragging) refreshRun().catch(() => {});
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.runId) refreshRun().catch(() => {});
});

const RUN_WORDS = { running: 'Running', 'awaiting-answer': 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Cut short' };

function renderRunBar() {
  const run = state.run;
  $('runBar').classList.toggle('hidden', !run);
  if (!run) return;
  const nodes = run.graph?.nodes || [];
  const done = nodes.filter((n) => n.status === 'done').length;
  const cost = nodes.reduce((t, n) => t + (typeof n.output?.meta?.cost === 'number' ? n.output.meta.cost : 0), 0);
  const live = run.status === 'running' || run.status === 'awaiting-answer';
  const bits = [];
  if (cost) bits.push(money(cost));
  if (run.budgetUsd) bits.push(`limit ${money(run.budgetUsd)}`);
  const took = runSeconds(run);
  if (took != null) bits.push(`took ${fmtSeconds(took)}`);
  const started = run.startedAt ? when(run.startedAt) : '';
  $('rbStatus').innerHTML = `${live ? '<span class="live-dot"></span>' : ''}<b>${escapeHtml(RUN_WORDS[run.status] || run.status)}</b>`
    + ` · ${done} of ${nodes.length} done${bits.length ? ` · <span class="run-totals">${bits.map(escapeHtml).join(' · ')}</span>` : ''}`
    + `${started ? ` · <span class="run-totals">started ${escapeHtml(started)}</span>` : ''}`;
  const up = $('rbParent');
  up.hidden = !run.parent;
  if (run.parent) { up.href = `/workflow-editor.html?run=${encodeURIComponent(run.parent.runId)}`; up.textContent = `↑ Part of ${run.parent.title}`; }
  renderNotice();
  renderAnswer();
  renderRetro();
  renderRunActions();
  renderTimeline();
}

/** The selected step's part in the run, above its settings in the sidebar. */
function renderRunStep() {
  const box = $('runStep');
  const rn = state.selectedId ? runNode(state.selectedId) : null;
  const show = !!rn && rn.status !== 'pending';
  box.classList.toggle('hidden', !show);
  if (!show) { $('runStepMore').innerHTML = ''; return; }
  openDrawer(rn.id, { keepScroll: true });
  const n = selectedNode();
  const run = state.run;
  const live = run.status === 'running' || run.status === 'awaiting-answer';
  // Redo repeats the step as the run ran it. To try a change, start from the
  // step with the workflow as it is now; earlier steps keep what they made.
  const ours = state.loaded && run.workflowId === state.loaded.id;
  const changed = n && changedSinceRun(n);
  $('runStepMore').innerHTML = ours && n && !live ? `<div class="rs-more">
      ${changed ? '<div class="rs-changed-note">You have changed this step since this run. Redo runs it as it was; this uses your changes.</div>' : ''}
      <button class="run-btn" id="rsFromHere" title="A new run of the workflow as it is now, starting from this step">▶ Run from here with the workflow as it is now</button>
      <div class="rs-more-why">Earlier steps keep what they made in this run, unless you changed them. ${state.dirty ? 'Saves your changes first.' : ''}</div>
      <span class="need-status" id="rsFromStatus"></span>
    </div>` : '';
  $('rsFromHere')?.addEventListener('click', (e) => runFromHere(n.id, e.currentTarget));
}

let startingRun = false;
async function runFromHere(nodeId, btn) {
  if (startingRun) return;
  if (state.dirty) { const saved = await save(); if (!saved) return; }
  startingRun = true;
  btn.disabled = true; btn.textContent = 'Starting…';
  const r = await startRunHere({ inputs: state.run.inputs || {}, reuse: { runId: state.run.runId, fromNodeId: nodeId } });
  startingRun = false;
  if (r.run?.runId) { await showRun(r.run.runId); return; }
  btn.disabled = false; btn.textContent = '▶ Run from here with the workflow as it is now';
  const el = $('rsFromStatus');
  if (el) { el.textContent = r.error || 'Could not start it.'; el.classList.add('bad'); }
}

function startRunHere(body) {
  const l = state.loaded;
  return fetch(`/api/workflows/${encodeURIComponent(l.id)}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, scope: l.scope, repo: l.repoRoot || null }),
  }).then((x) => x.json()).catch((e) => ({ error: e.message }));
}

/** Inputs a run asks for: the workflow's own, plus any an Inputs step declares. */
function runInputs(def) {
  const seen = new Set();
  const out = [];
  for (const f of [...(def.inputs || []),
    ...(def.graph?.nodes || []).filter((n) => n.kind === 'inputs').flatMap((n) => (n.spec?.fields || []).map((x) => ({ ...x, textarea: x.type === 'textarea' })))]) {
    if (!f?.key || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

/**
 * Start a run from the editor. A workflow that asks for inputs asks for them
 * here, in a window on this page, filled in from the run on the canvas.
 */
async function openRunDialog({ prefill } = {}) {
  if (state.dirty || !state.loaded) { const saved = await save(); if (!saved) return; }
  if (!state.def.graph.nodes.length) { toast('Saved. Add a step with + Add step, then run it.', '', 4000); return; }
  const fields = runInputs(state.def);
  const values = prefill || (state.run?.workflowId === state.loaded.id ? state.run.inputs : null) || {};
  if (!fields.length) { await go({}); return; }
  let d = $('runDlg');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'runDlg';
    d.className = 'run-dlg';
    document.body.append(d);
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  d.innerHTML = `<form method="dialog" id="rdForm">
      <h3>Run ${escapeHtml(state.def.title || state.def.id)}</h3>
      <div class="rd-sub">It runs here, on this canvas. Each step fills in as it goes.</div>
      ${fields.map((f) => `<label for="rd-${escapeAttr(f.key)}">${escapeHtml(f.label || f.key)}</label>${f.textarea
        ? `<textarea id="rd-${escapeAttr(f.key)}" data-key="${escapeAttr(f.key)}" placeholder="${escapeAttr(f.placeholder || '')}">${escapeHtml(values[f.key] ?? '')}</textarea>`
        : `<input id="rd-${escapeAttr(f.key)}" data-key="${escapeAttr(f.key)}" placeholder="${escapeAttr(f.placeholder || '')}" value="${escapeAttr(values[f.key] ?? '')}">`}`).join('')}
      <div class="rd-foot"><span class="rd-status" id="rdStatus"></span>
        <button type="button" class="run-btn" id="rdCancel">Cancel</button>
        <button type="submit" class="run-btn go" id="rdGo">▶ Run</button></div>
    </form>`;
  d.querySelector('#rdCancel').onclick = () => d.close();
  d.querySelector('#rdForm').onsubmit = async (e) => {
    e.preventDefault();
    const inputs = {};
    for (const el of d.querySelectorAll('[data-key]')) inputs[el.dataset.key] = el.value.trim();
    const okRun = await go(inputs, d);
    if (okRun) d.close();
  };
  if (!d.open) d.showModal();
  d.querySelector('[data-key]')?.focus();
}

async function go(inputs, dlg = null) {
  if (startingRun) return false;
  startingRun = true;
  const btn = dlg?.querySelector('#rdGo') || $('btnRun');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Starting…';
  const r = await startRunHere({ inputs });
  startingRun = false;
  btn.disabled = false; btn.textContent = label;
  if (r.run?.runId) { await showRun(r.run.runId); return true; }
  if (dlg) { const st = dlg.querySelector('#rdStatus'); st.textContent = r.error || 'Could not start it.'; st.classList.add('bad'); }
  else toast(`Could not start it: ${r.error || 'no reason given'}`, 'err', 0);
  return false;
}

/* The canvas takes the room left under the run bar, which grows and shrinks. */
function fitLayout() {
  const layout = $('edLayout');
  const top = layout.getBoundingClientRect().top;
  layout.style.height = `${Math.max(320, innerHeight - top)}px`;
}

/* -------------------- a workflow step, opened up -------------------- */

/*
 * Double-click a "Run a workflow" step (or press its ⤢) to open it up on the
 * canvas: every step of the workflow it runs, laid out as in its own editor.
 * With a run shown, each inner step wears the same state as the cards here,
 * from the run that step started, and follows it live.
 */
const MINI_W = 150, MINI_H = 50, MINI_COL = 172, MINI_ROW = 66;

function openable(card, n, rn) {
  const open = state.expanded.has(n.id);
  const head = card.querySelector('.n-head');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'n-open';
  btn.title = open ? 'Close it (or double-click)' : 'Open it up to see its steps (or double-click)';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '⤡' : '⤢';
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(n.id); });
  // Beside the kind, where it stays in view however wide the card opens.
  const kind = head?.querySelector('.n-kind');
  if (kind) kind.after(btn); else head?.append(btn);
  if (!open) return;
  card.classList.add('opened');
  const inner = innerOf(n, rn);
  const box = document.createElement('div');
  box.className = 'n-inner';
  box.innerHTML = inner ? innerHtml(inner) : '<div class="n-inner-none">Pick the workflow it runs, in the panel on the right.</div>';
  box.addEventListener('mousedown', (e) => { if (e.target.closest('a, .mini[data-pv]')) e.stopPropagation(); });
  // An inner step that made something to look at opens it here, full size.
  const show = (e) => {
    const m = e.target.closest('.mini[data-pv]');
    if (!m || !inner?.child) return;
    e.stopPropagation();
    openPreview(inner.nodes.find((x) => x.id === m.dataset.pv), inner.child.runId);
  };
  box.addEventListener('click', show);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(e); });
  const foot = card.querySelector('.n-foot');
  if (foot) card.insertBefore(box, foot); else card.append(box);
  if (inner) card.style.width = `${Math.max(320, inner.w + 24)}px`;
}

/*
 * Two clicks on the same step close together. Not the dblclick event: the
 * first click selects the step and redraws the canvas, so the second lands
 * on a new card and the browser never pairs them.
 */
let lastClick = { id: null, at: 0 };
function secondClick(id) {
  const now = Date.now();
  const again = lastClick.id === id && now - lastClick.at < 450;
  lastClick = again ? { id: null, at: 0 } : { id, at: now };
  return again;
}

async function toggleOpen(id) {
  if (state.expanded.has(id)) { state.expanded.delete(id); delete state.childRuns[id]; }
  else {
    state.expanded.add(id);
    await loadLibrary();
    await refreshChildRuns();
  }
  renderCanvas();
}

/** The run each opened step started, fetched again on every update. */
async function refreshChildRuns() {
  await Promise.all([...state.expanded].map(async (id) => {
    const childId = runNode(id)?.output?.child?.runId;
    if (!childId) { delete state.childRuns[id]; return; }
    const r = await fetch(`/api/runs/${encodeURIComponent(childId)}`).then((x) => x.json()).catch(() => ({}));
    if (r.run) state.childRuns[id] = r.run;
  }));
}

/** What to draw inside: the run the step started if there is one, else the workflow it names. */
function innerOf(n, rn) {
  const child = state.childRuns[n.id];
  const def = child?.definition || workflowPicked(n.spec || {}, state.library || []);
  const graph = child?.graph || def?.graph;
  if (!graph?.nodes?.length) return null;
  const nodes = graph.nodes;
  const minC = Math.min(...nodes.map((x) => x.col || 0)), minR = Math.min(...nodes.map((x) => x.row || 0));
  const pos = Object.fromEntries(nodes.map((x) => [x.id, { x: ((x.col || 0) - minC) * MINI_COL, y: ((x.row || 0) - minR) * MINI_ROW }]));
  const w = Math.max(...Object.values(pos).map((p) => p.x)) + MINI_W;
  const h = Math.max(...Object.values(pos).map((p) => p.y)) + MINI_H;
  return { title: def?.title || child?.workflowTitle || n.spec?.workflow, nodes, edges: graph.edges || [], pos, w, h, child, def, live: !!rn };
}

function innerHtml(i) {
  const done = i.child ? i.nodes.filter((x) => x.status === 'done').length : 0;
  const href = i.child
    ? `/workflow-editor.html?run=${encodeURIComponent(i.child.runId)}`
    : i.def ? `/workflow-editor.html?from=${encodeURIComponent(i.def.id)}${refQuery(i.def)}` : '';
  const state_ = i.child ? `${RUN_WORDS[i.child.status] || i.child.status} · ${done} of ${i.nodes.length} done` : `${i.nodes.length} steps${i.live ? ' · not started' : ''}`;
  const edges = i.edges.map(([a, b]) => {
    const p = i.pos[a], q = i.pos[b];
    if (!p || !q) return '';
    const x1 = p.x + MINI_W, y1 = p.y + MINI_H / 2, x2 = q.x, y2 = q.y + MINI_H / 2;
    const dx = Math.max(12, (x2 - x1) / 2);
    return `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
  }).join('');
  const minis = i.nodes.map((x) => {
    const rs = i.child ? runState(x) : null;
    const label = KINDS[x.kind]?.name || LEGACY[x.kind] || x.kind;
    const pv = i.child && previewOf(x);
    return `<div class="mini k-${escapeAttr(x.kind)}${rs ? ` rs-${rs}` : ''}${pv ? ' has-pv' : ''}"${pv ? ` data-pv="${escapeAttr(x.id)}" role="button" tabindex="0"` : ''} style="left:${i.pos[x.id].x}px;top:${i.pos[x.id].y}px" title="${escapeAttr(`${x.title || x.id} · ${label}${rs ? ` · ${{ done: 'done', failed: 'failed', ask: 'waiting for you', running: 'working', skipped: 'skipped', stopped: 'stopped' }[rs]}` : ''}`)}">
      <span class="mini-kind">${KIND_GLYPH[x.kind] || '●'} ${escapeHtml(label)}</span>
      <span class="mini-title">${escapeHtml(x.title || x.id)}</span>
      ${pv ? '<span class="mini-pv">Preview ↗</span>' : ''}
      ${RS_BADGE[rs] ? `<span class="rs-badge">${RS_BADGE[rs]}</span>` : ''}
    </div>`;
  }).join('');
  const pct = i.child && i.nodes.length ? Math.round((done / i.nodes.length) * 100) : 0;
  return `<div class="n-inner-head"><span class="n-inner-title">${escapeHtml(i.title || '')}</span><span class="n-inner-state">${escapeHtml(state_)}</span>
      ${href ? `<a class="n-inner-open" href="${href}" target="_blank" rel="noopener" title="${i.child ? 'Open this run on its own canvas' : 'Open the workflow in the editor'}">Open ↗</a>` : ''}</div>
    ${i.child ? `<div class="n-inner-bar"><i style="width:${pct}%"></i></div>` : ''}
    <div class="n-inner-canvas" style="width:${i.w}px;height:${i.h}px"><svg width="${i.w}" height="${i.h}">${edges}</svg>${minis}</div>`;
}

function slug(s, live = false) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '');
  return live ? out : out.replace(/-+$/, '');
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

boot();
