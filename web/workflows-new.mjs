/*
 * Workflow editor. Steps are draggable cards on a dot-grid canvas, joined by
 * connections; the panel on the right is where a workflow is actually made.
 *
 * The people who use this are not the people who wrote Orderly, so the panel
 * is the authoring surface, not a convenience: every field the engine reads
 * has a control here, named for what it does. The file view stays as an
 * escape hatch and as something to diff.
 *
 * Opened as /workflows-new.html for a new workflow, or ?id=<id> to edit one.
 * A built-in opened for editing saves as the person's own copy.
 */
const $ = (id) => document.getElementById(id);
const COL_W = 250, ROW_H = 170, GUTTER = 60, CARD_W = 210;

/* What each kind of step does, said plainly. Order is the order offered. */
const KINDS = {
  agent:    { name: 'Ask Claude',        glyph: '◆', desc: 'Claude does a piece of thinking or writing' },
  script:   { name: 'Run a command',     glyph: '>_', desc: 'A shell command in the project' },
  decision: { name: 'Ask me to choose',  glyph: '◇', desc: 'You pick; only that branch runs' },
  approve:  { name: 'Ask me to approve', glyph: '✓', desc: 'Waits for you; reject ends the run' },
  check:    { name: 'Check',             glyph: '≟', desc: 'Stops the run if something is wrong' },
  loop:     { name: 'Repeat for each',   glyph: '↻', desc: 'Does one thing per item in a list' },
  publish:  { name: 'Save or publish',   glyph: '↑', desc: 'Writes a file, or drafts a PR' },
  display:  { name: 'Show together',     glyph: '▦', desc: 'Gathers earlier results side by side' },
  delay:    { name: 'Wait',              glyph: '◷', desc: 'Pauses for a set time' },
  inputs:   { name: 'Ask for inputs',    glyph: '≡', desc: 'Fields filled in when the run starts' },
};
const LEGACY = { document: 'Document', report: 'Report', mockup: 'Mockup', diff: 'Diff', shots: 'Screenshot',
  'shots-set': 'Screenshots', terminal: 'Terminal', ask: 'Question', pr: 'Pull request' };

/** A freshly added step validates as it is, so Save never starts with errors. */
const STARTER = {
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
};

const SCOPE_HINT = {
  user: 'Saved in your own library at ~/.claude/workflows, so it follows you into every project.',
  project: 'Saved inside this project at .claude/workflows. Commit it to share it with the people who work on the project.',
};

const state = {
  def: null,
  loaded: null,        // { id, scope } once it exists on disk
  builtin: false,
  selectedId: null,
  selectedEdge: null,  // index into graph.edges
  connectFromId: null,
  mode: 'visual',
  dirty: false,
  problems: [],
  warnings: [],
  skills: [],
  refField: null,      // the textarea/input a reference will be inserted into
};

/* ---------------------------------- boot --------------------------------- */

async function boot() {
  const q = new URLSearchParams(location.search);
  const id = q.get('id');
  if (id) {
    const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`).then((x) => x.json()).catch(() => ({}));
    if (!r.workflow) { setStatus(`There is no workflow called "${id}".`, 'err'); state.def = blank(); }
    else {
      const { scope, source, file, invalid, problems, ...def } = r.workflow;
      state.def = normalise(def);
      state.builtin = scope === 'builtin';
      state.loaded = state.builtin ? null : { id: def.id, scope };
      $('wfScope').value = state.builtin ? 'user' : scope;
      document.title = `${def.title || def.id} — workflow editor`;
      $('edHere').textContent = state.builtin ? 'make it yours' : 'edit workflow';
    }
  } else {
    // An empty canvas. Someone building their own process should not have to
    // delete template steps first; templates come from "make it yours".
    state.def = blank();
  }
  fetch('/api/skills').then((x) => x.json()).then((r) => { state.skills = r.skills || []; if (state.selectedId) renderSelected(); }).catch(() => {});
  renderKindGrid();
  bindUi();
  render();
  markSaved(!!state.loaded, state.def.version);
  validateSoon();
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

/* --------------------------------- events -------------------------------- */

function bindUi() {
  $('wfTitle').addEventListener('input', () => {
    state.def.title = $('wfTitle').value;
    // Until it has been saved, the short name follows the name.
    if (!state.loaded && !state.idTouched) {
      state.def.id = slug(state.def.title);
      $('wfId').value = state.def.id;
    }
    changed({ redraw: false });
  });
  $('wfId').addEventListener('input', () => { state.idTouched = true; state.def.id = slug($('wfId').value, true); changed({ redraw: false }); });
  $('wfId').addEventListener('change', () => { $('wfId').value = state.def.id = slug($('wfId').value); changed({ redraw: false }); });
  $('wfDesc').addEventListener('input', () => { state.def.desc = $('wfDesc').value; changed({ redraw: false }); });
  $('wfCategory').addEventListener('change', () => { state.def.category = $('wfCategory').value; changed({ redraw: false }); });
  $('wfEstimate').addEventListener('input', () => { state.def.estimate = $('wfEstimate').value; changed({ redraw: false }); });
  $('wfScope').addEventListener('change', () => { $('scopeHint').textContent = SCOPE_HINT[$('wfScope').value]; changed({ redraw: false }); });
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
  $('btnAddInput').addEventListener('click', () => {
    const n = state.def.inputs.length + 1;
    state.def.inputs.push({ key: `input${n}`, label: '', placeholder: '' });
    changed();
  });

  $('selTitle').addEventListener('input', () => { patchNode({ title: $('selTitle').value }, { redraw: 'card' }); });
  $('selId').addEventListener('change', () => renameNode(slug($('selId').value)));
  $('selKind').addEventListener('change', () => changeKind($('selKind').value));
  $('btnConnect').addEventListener('click', () => {
    state.connectFromId = state.connectFromId ? null : state.selectedId;
    render();
  });
  $('btnDelete').addEventListener('click', removeSelected);
  $('btnDeleteEdge').addEventListener('click', removeSelected);
  $('edgeLabel').addEventListener('change', () => {
    const e = state.def.graph.edges[state.selectedEdge];
    if (!e) return;
    const v = $('edgeLabel').value;
    if (v) e[2] = v; else e.length = 2;
    changed();
  });

  for (const [id, apply] of [
    ['advRetries', (n, v) => { n.spec.retry = { ...(n.spec.retry || {}), attempts: Number(v) }; if (!Number(v)) delete n.spec.retry; }],
    ['advBackoff', (n, v) => { if (n.spec.retry) n.spec.retry.backoffMs = Number(v); }],
    ['advTimeout', (n, v) => { if (v) n.spec.timeoutMs = Number(v); else delete n.spec.timeoutMs; }],
  ]) {
    $(id).addEventListener('change', () => { const n = selected(); if (!n) return; n.spec = n.spec || {}; apply(n, $(id).value); changed({ redraw: 'card' }); });
  }
  $('advIdem').addEventListener('change', () => {
    const n = selected(); if (!n) return; n.spec = n.spec || {};
    if ($('advIdem').checked) delete n.spec.idempotent; else n.spec.idempotent = false;
    changed({ redraw: 'card' });
  });
  $('advAllow').addEventListener('change', () => {
    const n = selected(); if (!n) return; n.spec = n.spec || {};
    if ($('advAllow').checked) n.spec.allowFailure = true; else delete n.spec.allowFailure;
    changed({ redraw: 'card' });
  });

  $('btnSave').addEventListener('click', save);
  $('btnExport').addEventListener('click', () => { if (state.loaded) location.href = `/api/workflows/${encodeURIComponent(state.loaded.id)}/export`; });
  $('importFile').addEventListener('change', importFile);
  $('btnDeleteWf').addEventListener('click', deleteWorkflow);
  $('modeVisual').addEventListener('click', () => setMode('visual'));
  $('modeJson').addEventListener('click', () => setMode('json'));
  $('jsonArea').addEventListener('change', () => {
    try { state.def = normalise(JSON.parse($('jsonArea').value)); changed(); setStatus('File applied.', 'ok'); }
    catch (e) { setStatus(`That isn't valid JSON: ${e.message}`, 'err'); }
  });

  $('edCanvas').addEventListener('click', (e) => {
    if (['edCanvas', 'edInner', 'edEdges'].includes(e.target.id)) {
      state.selectedId = null; state.selectedEdge = null; state.connectFromId = null; render();
    }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') { closeRefPop(); if (state.connectFromId) { state.connectFromId = null; render(); } return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && (state.selectedId || state.selectedEdge != null)) {
      e.preventDefault(); removeSelected();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#refPop') && !e.target.closest('.ref-btn')) closeRefPop();
  });
}

/* --------------------------------- edits --------------------------------- */

function selected() { return state.def.graph.nodes.find((n) => n.id === state.selectedId) || null; }

function changed({ redraw = true } = {}) {
  state.dirty = true;
  markSaved(false);
  if (redraw === true) render();
  else if (redraw === 'card') { renderCanvas(); }
  if (state.mode === 'json') $('jsonArea').value = JSON.stringify(state.def, null, 2);
  validateSoon();
  previewSoon();
}

function patchNode(fields, opts) {
  const n = selected(); if (!n) return;
  Object.assign(n, fields);
  changed(opts);
}

function addNode(kind) {
  const nodes = state.def.graph.nodes;
  let id = slug(kind), i = 2;
  while (nodes.some((n) => n.id === id)) id = `${slug(kind)}${i++}`;
  // Place it after the selected step, or after the last one.
  const anchor = selected() || nodes[nodes.length - 1];
  const col = anchor ? (anchor.col || 0) + 1 : 1;
  let row = anchor ? anchor.row || 0 : 0;
  while (nodes.some((n) => (n.col || 0) === col && (n.row || 0) === row)) row++;
  const node = { id, title: KINDS[kind]?.name || kind, kind, col, row, spec: STARTER[kind] ? STARTER[kind]() : {} };
  nodes.push(node);
  // A step added while one is selected usually comes after it.
  if (anchor && selected()) state.def.graph.edges.push([anchor.id, id, ...autoLabel(anchor)]);
  state.selectedId = id;
  state.selectedEdge = null;
  changed();
  setTimeout(() => $('selSpec').querySelector('textarea, input')?.focus(), 0);
}

/** A connection out of a Decision takes the first of its options not yet used. */
function autoLabel(src) {
  if (src?.kind !== 'decision') return [];
  const used = new Set(state.def.graph.edges.filter((e) => e[0] === src.id).map((e) => e[2]));
  const free = (src.spec?.options || []).map((o) => o.edgeLabel).find((l) => l && !used.has(l));
  return free ? [free] : [];
}

function connect(from, to) {
  if (from === to) return;
  const edges = state.def.graph.edges;
  if (edges.some((e) => e[0] === from && e[1] === to)) { setStatus('Those two are already connected.', ''); return; }
  if (reaches(to, from)) { setStatus(`That would make a loop: ${to} already leads back to ${from}.`, 'err'); return; }
  const src = state.def.graph.nodes.find((n) => n.id === from);
  edges.push([from, to, ...autoLabel(src)]);
  state.selectedEdge = edges.length - 1;
  state.selectedId = null;
  state.connectFromId = null;
  changed();
}

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

function removeSelected() {
  if (state.selectedEdge != null) {
    state.def.graph.edges.splice(state.selectedEdge, 1);
    state.selectedEdge = null;
    changed();
    return;
  }
  const id = state.selectedId; if (!id) return;
  state.def.graph.nodes = state.def.graph.nodes.filter((n) => n.id !== id);
  state.def.graph.edges = state.def.graph.edges.filter(([a, b]) => a !== id && b !== id);
  state.selectedId = null; state.connectFromId = null;
  changed();
  setStatus(`Removed "${id}".`, '');
}

function renameNode(newId) {
  const n = selected(); if (!n || !newId || newId === n.id) { renderSelected(); return; }
  if (state.def.graph.nodes.some((x) => x.id === newId)) { setStatus(`"${newId}" is already used by another step.`, 'err'); renderSelected(); return; }
  const old = n.id;
  n.id = newId;
  state.def.graph.edges = state.def.graph.edges.map(([a, b, l]) => {
    const e = [a === old ? newId : a, b === old ? newId : b];
    return l ? [...e, l] : e;
  });
  // Keep references pointing at it working.
  const re = new RegExp(`\\{\\{\\s*nodes\\.${old.replace(/[-]/g, '\\-')}(?=[.\\s}])`, 'g');
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
  const n = selected(); if (!n) return;
  const prev = n.spec || {};
  const next = STARTER[kind] ? STARTER[kind]() : {};
  // Carry across what still means the same thing.
  for (const k of ['prompt', 'cmd', 'question', 'model']) if (prev[k] && k in next) next[k] = prev[k];
  for (const k of ['retry', 'timeoutMs', 'idempotent']) if (prev[k] !== undefined) next[k] = prev[k];
  n.kind = kind;
  n.spec = next;
  changed();
}

/** Write a field of the selected step's spec; `path` may be dotted. */
function writeSpec(path, value, { redraw = 'card' } = {}) {
  const n = selected(); if (!n) return;
  n.spec = n.spec || {};
  const parts = path.split('.');
  let o = n.spec;
  for (const p of parts.slice(0, -1)) o = (o[p] ||= {});
  const last = parts[parts.length - 1];
  if (value === '' || value === undefined) delete o[last]; else o[last] = value;
  changed({ redraw });
}

/* ------------------------------ save & files ----------------------------- */

async function save() {
  const def = state.def;
  if (!def.title?.trim()) { setStatus('Give it a name first.', 'err'); $('wfTitle').focus(); return; }
  if (!def.id) def.id = slug(def.title);
  const ok = await validate();
  if (!ok) { setStatus('Fix the problems below, then save.', 'err'); return; }
  const scope = $('wfScope').value;
  // Saving over itself is fine; saving a new one over another is not.
  const overwrite = !!state.loaded && state.loaded.id === def.id && state.loaded.scope === scope;
  $('btnSave').disabled = true;
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def, scope, overwrite }),
    }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
    if (r.status === 409) {
      setStatus(`You already have a workflow called "${def.id}". Change the short name, or open that one instead.`, 'err');
      return;
    }
    if (!r.saved) throw new Error(r.error || 'save failed');
    def.version = r.version;
    state.loaded = { id: r.id, scope: r.scope };
    state.builtin = false;
    state.dirty = false;
    history.replaceState(null, '', `/workflows-new.html?id=${encodeURIComponent(r.id)}`);
    $('edHere').textContent = 'edit workflow';
    render();
    markSaved(true, r.version);
    setStatus(`Saved. ${r.version > 1 ? `This is version ${r.version}; runs already made keep the version they ran.` : ''}`, 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  } finally { $('btnSave').disabled = false; }
}

async function importFile() {
  const f = $('importFile').files?.[0];
  $('importFile').value = '';
  if (!f) return;
  let def;
  try { def = JSON.parse(await f.text()); } catch { setStatus(`${f.name} is not a workflow file.`, 'err'); return; }
  const scope = $('wfScope').value;
  const post = (d) => fetch('/api/workflows/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ def: d, scope }),
  }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
  let r = await post(def);
  if (r.status === 409) {
    setStatus(`${r.error}. `, 'err');
    const btn = document.createElement('button');
    btn.className = 'act';
    btn.textContent = `Import it as "${r.suggestedId}"`;
    btn.onclick = async () => {
      const again = await post({ ...def, id: r.suggestedId });
      if (again.saved) location.href = `/workflows-new.html?id=${encodeURIComponent(again.id)}`;
      else setStatus(again.error || 'import failed', 'err');
    };
    $('status').append(btn);
    return;
  }
  if (r.saved) { location.href = `/workflows-new.html?id=${encodeURIComponent(r.id)}`; return; }
  setStatus(`${r.error || 'import failed'}${r.problems ? `: ${r.problems.slice(0, 3).join('; ')}` : ''}`, 'err');
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
  const r = await fetch(`/api/workflows/${encodeURIComponent(state.loaded.id)}?scope=${state.loaded.scope}`, { method: 'DELETE' }).then((x) => x.json());
  if (r.deleted) location.href = '/workflows.html#workflows';
  else setStatus(r.error || 'delete failed', 'err');
}

/* -------------------------------- validate ------------------------------- */

let validateTimer = null;
function validateSoon() { clearTimeout(validateTimer); validateTimer = setTimeout(validate, 350); }

async function validate() {
  const def = { ...state.def, id: state.def.id || 'untitled' };
  const r = await fetch('/api/workflows/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ def }),
  }).then((x) => x.json()).catch(() => ({ ok: false, problems: ['Orderly is not answering — is it still running?'] }));
  // An empty workflow is not a problem worth shouting about while building.
  state.problems = (r.problems || []).filter((p) => !(state.def.graph.nodes.length === 0 && /nodes is empty/.test(p)));
  state.warnings = r.warnings || [];
  showList('problems', state.problems, 'needs fixing before it can run');
  showList('warnings', state.warnings, 'worth a look');
  renderCanvas();
  return r.ok;
}

function showList(id, list, label) {
  const el = $(id);
  if (!list.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<strong>${list.length} ${list.length === 1 ? 'thing' : 'things'} ${label}</strong><ul>${list.map((p) => `<li>${esc(plain(p))}</li>`).join('')}</ul>`;
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

async function preview() {
  const n = selected();
  const field = state.refField?.dataset.spec;
  const fieldKey = { prompt: 'prompt', cmd: 'cmd', question: 'question', path: 'path', content: 'content', over: 'over', 'assert.needle': 'assert.needle' }[field];
  if (!n || !fieldKey || !n.spec?.[field.split('.')[0]]) { $('preview').classList.add('hidden'); return; }
  const r = await fetch('/api/workflows/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ def: { ...state.def, id: state.def.id || 'untitled' }, nodeId: n.id, field: fieldKey }),
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
  if (k === 'decision') f.push(['output.answer', 'the choice you made']);
  if (k === 'approve') f.push(['output.approved', 'whether you approved']);
  if (k === 'check') f.push(['output.pass', 'whether it passed'], ['output.reason', 'why']);
  if (k === 'loop') f.push(['output.results', 'every item\'s result']);
  if (k === 'inputs') for (const x of n.spec?.fields || []) f.push([`output.values.${x.key}`, x.label || x.key]);
  if (k === 'publish') f.push(['output.path', 'the file it wrote']);
  return f;
}

function openRefPop(btn, field) {
  state.refField = field;
  const n = selected();
  const pop = $('refPop');
  const groups = [];
  const inputs = [...state.def.inputs.map((i) => [i.key, i.label]),
    ...state.def.graph.nodes.filter((x) => x.kind === 'inputs').flatMap((x) => (x.spec?.fields || []).map((f) => [f.key, f.label]))];
  if (inputs.length) groups.push(['Inputs', inputs.map(([k, l]) => [`{{inputs.${k}}}`, l || k])]);
  if (n?.kind === 'loop') groups.push(['This item', [['{{item}}', 'the current item in the list']]]);
  const ups = upstream(n?.id);
  for (const u of ups) groups.push([`${u.title || u.id}`, fieldsOf(u).map(([p, d]) => [`{{nodes.${u.id}.${p}}}`, d])]);
  if (ups.length > 1) groups.push(['Several', [['{{nodes.*.output}}', 'everything every step just before this one produced']]]);
  pop.innerHTML = groups.length
    ? groups.map(([g, items]) => `<div class="rg">${esc(g)}</div>${items.map(([t, d]) => `<button type="button" data-ref="${esc(t)}"><span class="rt">${esc(t)}</span><span class="rd">${esc(d)}</span></button>`).join('')}`).join('')
    : `<div class="none">Nothing to use yet. Add an input above, or connect a step into this one to use what it produced.</div>`;
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 330, r.left - 200)}px`;
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
  writeSpec(el.dataset.spec, el.value, { redraw: 'card' });
}

/* --------------------------------- render -------------------------------- */

function render() {
  const d = state.def;
  $('wfTitle').value = d.title || '';
  $('wfId').value = d.id || '';
  $('wfId').readOnly = !!state.loaded;
  $('wfId').title = state.loaded ? 'A saved workflow keeps its short name; runs refer to it.' : '';
  $('wfDesc').value = d.desc || '';
  $('wfCategory').value = d.category || 'build';
  $('wfEstimate').value = d.estimate || '';
  $('wfBudget').value = d.budgetUsd ?? '';
  $('wfConcurrency').value = d.concurrency ? String(d.concurrency) : '';
  $('scopeHint').textContent = SCOPE_HINT[$('wfScope').value];
  $('builtinBanner').classList.toggle('hidden', !state.builtin);
  $('btnExport').style.display = state.loaded ? '' : 'none';
  $('btnDeleteWf').style.display = state.loaded ? '' : 'none';
  const runLink = $('btnRun');
  runLink.style.display = state.loaded && !state.dirty ? '' : 'none';
  if (state.loaded) runLink.href = `/workflows.html?open=${encodeURIComponent(state.loaded.id)}#workflows`;
  $('edHint').classList.toggle('hidden', d.graph.nodes.length > 0 && !state.connectFromId);
  if (state.connectFromId) {
    $('edHint').classList.remove('hidden');
    $('edHint').innerHTML = `Click the step that should come after <b>${esc(state.connectFromId)}</b>. Esc to cancel.`;
  } else {
    $('edHint').innerHTML = 'Add a step from the panel on the right. Select a step, then <b>Connect to…</b> and click the step that should come after it.';
  }
  renderInputs();
  renderCanvas();
  renderSelected();
  renderEdgePanel();
  if (state.mode === 'json') $('jsonArea').value = JSON.stringify(state.def, null, 2);
}

function markSaved(saved, version) {
  const el = $('saveLine');
  if (saved) { el.textContent = `Saved${version ? ` · version ${version}` : ''}`; el.className = 'save-line clean'; }
  else if (state.loaded || state.def?.graph?.nodes?.length) { el.textContent = 'Unsaved changes'; el.className = 'save-line dirty'; }
  else { el.textContent = 'Not saved yet'; el.className = 'save-line'; }
  $('btnRun').style.display = state.loaded && saved ? '' : 'none';
}

function renderKindGrid() {
  $('kindGrid').innerHTML = Object.entries(KINDS).map(([k, v]) =>
    `<button class="kind-btn" data-kind="${k}" title="${esc(v.desc)}"><span class="kn"><span class="g">${v.glyph}</span>${esc(v.name)}</span><span class="kd">${esc(v.desc)}</span></button>`).join('');
  for (const b of $('kindGrid').querySelectorAll('.kind-btn')) b.onclick = () => addNode(b.dataset.kind);
  $('selKind').innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')
    + `<optgroup label="Older kinds">${Object.entries(LEGACY).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</optgroup>`;
}

function renderInputs() {
  const list = state.def.inputs;
  $('inputsCount').textContent = list.length ? `· ${list.length}` : '';
  $('inputsList').innerHTML = list.length ? list.map((f, i) => `
    <div class="list-row three" data-i="${i}">
      <input data-f="key" value="${esc(f.key || '')}" placeholder="key" spellcheck="false" aria-label="key">
      <input data-f="label" value="${esc(f.label || '')}" placeholder="Label people see" aria-label="label">
      <label class="tick"><input type="checkbox" data-f="textarea" ${f.textarea ? 'checked' : ''}> long</label>
      <button class="run-btn danger x" data-rm="${i}" title="Remove">✕</button>
      <input class="wide" data-f="placeholder" value="${esc(f.placeholder || '')}" placeholder="Example shown in the box (optional)">
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
  for (const el of inner.querySelectorAll('.n-card')) el.remove();
  for (const n of state.def.graph.nodes) inner.append(nodeCard(n));
  renderEdges();
}

function summary(n) {
  const s = n.spec || {};
  switch (n.kind) {
    case 'agent': return s.prompt || 'No instructions yet';
    case 'script': return s.op ? ({ 'capture-shot': 'Screenshot a page', 'capture-shots': 'Screenshot several pages' })[s.op] : (s.cmd ? `$ ${s.cmd}` : 'No command yet');
    case 'decision': return `${s.question || ''} — ${(s.options || []).map((o) => o.label).join(' / ')}`;
    case 'approve': return s.question || '';
    case 'check': return ({ 'exit-zero': 'the command succeeded', contains: `output contains "${s.assert?.needle || ''}"`, 'has-pairs': 'screenshots were taken', manual: 'you say it looks right' })[s.assert?.type] || '';
    case 'loop': return `for each in ${s.over || '…'}`;
    case 'publish': return s.target === 'pr' ? 'Draft a pull request' : `Write ${s.path || 'a file'}`;
    case 'display': return `show ${[].concat(s.from || []).join(', ') || '…'}`;
    case 'delay': return `wait ${s.wait || ''}`;
    case 'inputs': return (s.fields || []).map((f) => f.label || f.key).join(', ');
    default: return n.prompt || n.command || '';
  }
}

function nodeCard(n) {
  const card = document.createElement('div');
  const probs = problemsFor(n.id);
  const cls = ['n-card', `k-${n.kind}`];
  if (n.id === state.selectedId) cls.push('sel');
  if (n.id === state.connectFromId) cls.push('connect-src');
  else if (state.connectFromId) cls.push('connect-target');
  if (probs.length) cls.push('has-problem');
  card.className = cls.join(' ');
  card.style.left = `${GUTTER + (n.col || 0) * COL_W}px`;
  card.style.top = `${GUTTER + (n.row || 0) * ROW_H}px`;
  card.dataset.id = n.id;
  const s = n.spec || {};
  const flags = [];
  if (s.retry?.attempts) flags.push(`↻ ${s.retry.attempts}`);
  if (s.timeoutMs) flags.push(`◷ ${Math.round(s.timeoutMs / 60000) || '<1'}m`);
  if (s.idempotent === false) flags.push('once only');
  if (s.uses?.length) flags.push(`${s.uses.length} skill${s.uses.length === 1 ? '' : 's'}`);
  if (probs.length) flags.push(`<span class="bad">${probs.length} to fix</span>`);
  card.innerHTML = `
    <div class="n-head"><span class="n-kind">${esc(KINDS[n.kind]?.name || LEGACY[n.kind] || n.kind)}</span><span class="n-id">${esc(n.id)}</span></div>
    <div class="n-title">${esc(n.title || n.id)}</div>
    <div class="n-what">${esc(summary(n))}</div>
    <div class="n-flags">${flags.join(' · ')}</div>`;
  card.title = probs.map(plain).join('\n');
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (card.dataset.dragged) { delete card.dataset.dragged; return; }
    if (state.connectFromId && state.connectFromId !== n.id) { connect(state.connectFromId, n.id); return; }
    if (e.shiftKey && state.selectedId && state.selectedId !== n.id) { connect(state.selectedId, n.id); return; }
    state.selectedId = n.id; state.selectedEdge = null; render();
  });
  attachDrag(card, n);
  return card;
}

function attachDrag(card, n) {
  let start = null;
  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, left: parseFloat(card.style.left), top: parseFloat(card.style.top) };
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!card.classList.contains('dragging') && Math.hypot(dx, dy) < 4) return;
      card.classList.add('dragging');
      document.body.style.userSelect = 'none';
      card.style.left = `${Math.max(0, start.left + dx)}px`;
      card.style.top = `${Math.max(0, start.top + dy)}px`;
      renderEdges(card);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      if (!card.classList.contains('dragging')) return;
      card.classList.remove('dragging');
      card.dataset.dragged = '1';
      const col = Math.max(0, Math.round((parseFloat(card.style.left) - GUTTER) / COL_W));
      const row = Math.max(0, Math.round((parseFloat(card.style.top) - GUTTER) / ROW_H));
      if (col !== (n.col || 0) || row !== (n.row || 0)) { n.col = col; n.row = row; changed({ redraw: 'card' }); }
      else renderCanvas();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function anchorOf(id, side, live) {
  const n = state.def.graph.nodes.find((x) => x.id === id);
  const el = live && live.dataset.id === id ? live : null;
  const left = el ? parseFloat(el.style.left) : GUTTER + (n.col || 0) * COL_W;
  const top = el ? parseFloat(el.style.top) : GUTTER + (n.row || 0) * ROW_H;
  return { x: side === 'out' ? left + CARD_W : left, y: top + 48 };
}

function edgeLabelText(src, label) {
  if (!label) return '';
  if (src?.kind === 'decision') return (src.spec?.options || []).find((o) => o.edgeLabel === label)?.label || label;
  return label;
}

function renderEdges(live = null) {
  const svg = $('edEdges');
  const byId = Object.fromEntries(state.def.graph.nodes.map((n) => [n.id, n]));
  const parts = [];
  state.def.graph.edges.forEach(([a, b, label], i) => {
    if (!byId[a] || !byId[b]) return;
    const p = anchorOf(a, 'out', live), q = anchorOf(b, 'in', live);
    const dx = Math.max(40, (q.x - p.x) / 2);
    const d = `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}`;
    const sel = state.selectedEdge === i;
    const stroke = sel ? 'var(--accent)' : label ? '#a3abff' : '#efb36c';
    parts.push(`<path class="edge-hit" data-i="${i}" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sel ? 2.4 : 1.4}" opacity="${sel ? 1 : 0.7}"/>`);
    parts.push(`<circle cx="${q.x}" cy="${q.y}" r="3" fill="${stroke}"/>`);
    const text = edgeLabelText(byId[a], label);
    if (text) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, w = Math.max(30, text.length * 6.6 + 14);
      parts.push(`<g class="edge-label" data-i="${i}" transform="translate(${mx - w / 2},${my - 10})">
        <rect width="${w}" height="18" rx="9" fill="#131318" stroke="${stroke}" stroke-width="1"/>
        <text x="${w / 2}" y="12.5" text-anchor="middle" font-family="Geist Mono, monospace" font-size="10" fill="${stroke}">${esc(text)}</text></g>`);
    }
  });
  svg.innerHTML = parts.join('');
  for (const el of svg.querySelectorAll('[data-i]')) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedEdge = Number(el.dataset.i); state.selectedId = null; state.connectFromId = null;
      render();
    });
  }
}

function renderEdgePanel() {
  const e = state.def.graph.edges[state.selectedEdge];
  $('edgeBlock').style.display = e ? '' : 'none';
  if (!e) return;
  const byId = Object.fromEntries(state.def.graph.nodes.map((n) => [n.id, n]));
  const src = byId[e[0]];
  $('edgeLine').textContent = `${src?.title || e[0]}  →  ${byId[e[1]]?.title || e[1]}`;
  const opts = src?.kind === 'decision' ? src.spec?.options || [] : [];
  $('edgeLabelWrap').style.display = opts.length ? '' : 'none';
  $('edgeLabel').innerHTML = `<option value="">Always</option>${opts.map((o) => `<option value="${esc(o.edgeLabel)}" ${o.edgeLabel === e[2] ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}`;
}

/* ---------------------------- selected step ------------------------------ */

function renderSelected() {
  const n = selected();
  $('selBlock').style.display = n ? '' : 'none';
  if (!n) { $('preview').classList.add('hidden'); return; }
  $('selSummary').textContent = n.title || n.id;
  $('selKindLine').textContent = KINDS[n.kind]?.desc || (LEGACY[n.kind] ? 'An older kind of step. It still runs; switching it to one of the kinds above gives you the full form.' : '');
  $('selTitle').value = n.title || '';
  $('selId').value = n.id;
  $('selKind').value = n.kind;
  $('btnConnect').textContent = state.connectFromId ? 'Cancel connecting' : '↝ Connect to…';
  const s = n.spec || {};
  $('advRetries').value = String(s.retry?.attempts || 0);
  $('advBackoff').value = String(s.retry?.backoffMs || 2000);
  $('advBackoff').disabled = !s.retry?.attempts;
  $('advTimeout').value = s.timeoutMs ? String(s.timeoutMs) : '';
  $('advIdem').checked = s.idempotent !== false;
  $('advAllow').checked = !!s.allowFailure;
  const commandish = n.kind === 'script' || n.kind === 'publish' || n.kind === 'loop';
  $('advIdemLine').style.display = commandish ? '' : 'none';
  $('advAllowLine').style.display = n.kind === 'script' && !s.op ? '' : 'none';
  $('advanced').style.display = ['decision', 'approve', 'display', 'inputs', 'delay'].includes(n.kind) ? 'none' : '';
  renderSpecForm(n);
}

function renderSpecForm(n) {
  const mount = $('selSpec');
  const s = n.spec || {};
  const ups = upstream(n.id);
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const refHead = (label, key, hint = '') => `<div class="field-head"><label for="sp-${key}">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label><button type="button" class="ref-btn" data-for="sp-${key}">+ insert</button></div>`;
  const ta = (key, val, ph) => `<textarea id="sp-${key}" data-spec="${key}" data-ref="1" placeholder="${esc(ph)}">${esc(val || '')}</textarea>`;
  const txt = (key, val, ph, ref = false) => `<input id="sp-${key}" data-spec="${key}" ${ref ? 'data-ref="1"' : ''} value="${esc(val ?? '')}" placeholder="${esc(ph)}">`;
  const sel = (key, val, options) => `<select id="sp-${key}" data-spec="${key}">${options.map(([v, l]) => opt(v, l, val)).join('')}</select>`;
  const upSel = (key, val) => ups.length
    ? `<select id="sp-${key}" data-spec="${key}">${opt('', 'Pick a step before this one', val)}${ups.map((u) => opt(u.id, u.title || u.id, val)).join('')}</select>`
    : `<div class="list-empty">Connect a step into this one first.</div>`;
  let html = '';
  switch (n.kind) {
    case 'agent':
      html = refHead('What should Claude do?', 'prompt', 'say what to produce; insert anything earlier steps made')
        + ta('prompt', s.prompt, 'Write a one-page summary of {{nodes.research.output}} for {{inputs.audience}}.')
        + `<div class="row2"><div><label for="sp-model">Model</label>${sel('model', s.model || 'sonnet', [['haiku', 'Haiku — fast, cheap'], ['sonnet', 'Sonnet — balanced'], ['opus', 'Opus — most capable']])}</div>`
        + `<div><label for="sp-output">It produces</label>${sel('output', s.output || 'markdown', [['markdown', 'Text'], ['json', 'Data (JSON)'], ['json-findings', 'Review findings'], ['html', 'A web page'], ['json-hunks', 'A code change']])}</div></div>`
        + `<label>Skills to use <span class="hint">named in the prompt; Claude uses one where it applies</span></label>${skillPicker(s.uses || [])}`;
      break;
    case 'script':
      html = `<label for="sp-op">It does</label>${sel('op', s.op || '', [['', 'Run a command'], ['capture-shot', 'Screenshot a page'], ['capture-shots', 'Screenshot several pages']])}`
        + (s.op ? '<div class="hint block-hint">Uses the running app Orderly found for this project, or the page given as an input.</div>'
          : refHead('Command', 'cmd', 'runs in the project folder; inserted values are quoted') + ta('cmd', s.cmd, 'npm test'));
      break;
    case 'decision':
      html = refHead('Question', 'question') + txt('question', s.question, 'Which direction wins?', true)
        + `<label>Choices <span class="hint">connect each to the step it leads to</span></label>`
        + (s.options || []).map((o, i) => `<div class="list-row"><input class="wide" data-opt="${i}" value="${esc(o.label || '')}" placeholder="Choice"><span></span><button class="run-btn danger x" data-rm-opt="${i}">✕</button></div>`).join('')
        + '<button class="run-btn" data-act="add-opt">+ add choice</button>';
      break;
    case 'approve':
      html = refHead('What are you approving?', 'question') + txt('question', s.question, 'Ship {{inputs.version}}?', true);
      break;
    case 'check':
      html = `<label for="sp-assert.type">Passes when</label>${sel('assert.type', s.assert?.type || 'exit-zero', [['exit-zero', 'a command succeeded'], ['contains', 'an output contains some text'], ['has-pairs', 'screenshots were taken'], ['manual', 'I say it looks right']])}`
        + `<label for="sp-assert.from">Looking at</label>${upSel('assert.from', s.assert?.from)}`
        + (s.assert?.type === 'contains' ? refHead('The text', 'assert.needle') + txt('assert.needle', s.assert?.needle, 'All tests passed', true) : '')
        + `<label for="sp-onFail">If it fails</label>${sel('onFail', s.onFail || 'stop', [['stop', 'Stop the whole run'], ['skip', 'Skip what comes after, finish the rest']])}`;
      break;
    case 'loop':
      html = refHead('For each item in', 'over', 'a list: an input, or something an earlier step made') + txt('over', s.over, '{{inputs.pages}}', true)
        + `<label for="sp-action">Do</label>${sel('action', s.action || 'agent', [['agent', 'Ask Claude'], ['script', 'Run a command']])}`
        + (s.action === 'script'
          ? refHead('Command', 'cmd', 'use {{item}} for the current item') + ta('cmd', s.cmd, 'npx lighthouse {{item}}')
          : refHead('What should Claude do with each?', 'prompt', 'use {{item}} for the current item') + ta('prompt', s.prompt, 'Summarise {{item}} in two sentences.'))
        + `<div class="row2"><div><label for="sp-max">At most</label>${sel('max', String(s.max || 50), [['5', '5 items'], ['20', '20 items'], ['50', '50 items'], ['100', '100 items'], ['500', '500 items']])}</div>`
        + `<div><label for="sp-concurrency">At once</label>${sel('concurrency', String(s.concurrency || 1), [['1', 'One at a time'], ['2', '2'], ['4', '4'], ['8', '8']])}</div></div>`;
      break;
    case 'publish':
      html = `<label for="sp-target">It</label>${sel('target', s.target || 'file', [['file', 'Writes a file in the project'], ['pr', 'Drafts a pull request']])}`
        + (s.target === 'pr' ? '<div class="hint block-hint">Drafts the title and description from the steps before it. It does not open the PR on GitHub.</div>'
          : refHead('File', 'path', 'inside the project') + txt('path', s.path, 'reports/{{inputs.week}}.md', true)
            + refHead('What goes in it', 'content', 'empty = everything the steps before it produced') + ta('content', s.content, '{{nodes.summary.output}}'));
      break;
    case 'display':
      html = `<label>Show</label>${ups.length ? `<div class="pick-list">${ups.map((u) => `<label><input type="checkbox" data-from="${esc(u.id)}" ${[].concat(s.from || []).includes(u.id) ? 'checked' : ''}> ${esc(u.title || u.id)}</label>`).join('')}</div>` : '<div class="list-empty">Connect the steps to show into this one.</div>'}`
        + `<label for="sp-render">As</label>${sel('render', s.render || 'markdown', [['markdown', 'Text'], ['mockups-grid', 'Web pages side by side'], ['shots-set', 'Screenshots'], ['json', 'Data'], ['diff', 'Code changes']])}`;
      break;
    case 'delay':
      html = `<label for="sp-wait">Wait</label>${sel('wait', s.wait || '30s', [['10s', '10 seconds'], ['30s', '30 seconds'], ['2m', '2 minutes'], ['5m', '5 minutes'], ['10m', '10 minutes (the most)']])}`;
      break;
    case 'inputs':
      html = '<label>Fields</label>' + (s.fields || []).map((f, i) => `<div class="list-row"><input data-field="${i}" data-k="key" value="${esc(f.key || '')}" placeholder="key"><input data-field="${i}" data-k="label" value="${esc(f.label || '')}" placeholder="Label"><button class="run-btn danger x" data-rm-field="${i}">✕</button></div>`).join('')
        + '<button class="run-btn" data-act="add-field">+ add field</button><div class="hint block-hint">The workflow-wide Inputs above usually do this more simply.</div>';
      break;
    default:
      html = `<label for="sp-legacy">Instructions</label><textarea id="sp-legacy" data-legacy="1">${esc(n.prompt || n.command || '')}</textarea>`;
  }
  mount.innerHTML = html;

  for (const el of mount.querySelectorAll('[data-spec]')) {
    const key = el.dataset.spec;
    const numeric = ['max', 'concurrency'].includes(key);
    const kindShaping = ['op', 'action', 'target', 'assert.type', 'output'].includes(key);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      writeSpec(key, numeric ? Number(el.value) : el.value, { redraw: kindShaping ? true : 'card' });
    });
    if (el.dataset.ref) el.addEventListener('focus', () => { state.refField = el; previewSoon(); });
  }
  for (const b of mount.querySelectorAll('.ref-btn')) {
    b.addEventListener('click', (e) => { e.stopPropagation(); openRefPop(b, $(b.dataset.for)); });
  }
  mount.querySelector('[data-legacy]')?.addEventListener('input', (e) => {
    const n2 = selected(); if (!n2) return;
    if ('command' in n2 && !('prompt' in n2)) n2.command = e.target.value; else n2.prompt = e.target.value;
    changed({ redraw: 'card' });
  });
  // Decision choices: the label is what people see; the edge label is fixed
  // at creation so connections keep pointing at the right choice.
  for (const el of mount.querySelectorAll('[data-opt]')) {
    el.addEventListener('input', () => { s.options[Number(el.dataset.opt)].label = el.value; changed({ redraw: 'card' }); });
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
    el.addEventListener('input', () => { s.fields[Number(el.dataset.field)][el.dataset.k] = el.value; changed({ redraw: 'card' }); });
  }
  for (const b of mount.querySelectorAll('[data-rm-field]')) b.onclick = () => { s.fields.splice(Number(b.dataset.rmField), 1); changed(); };
  mount.querySelector('[data-act="add-field"]')?.addEventListener('click', () => {
    s.fields = s.fields || []; s.fields.push({ key: `field${s.fields.length + 1}`, label: '', type: 'text' }); changed();
  });
  for (const el of mount.querySelectorAll('[data-from]')) {
    el.addEventListener('change', () => {
      const picked = [...mount.querySelectorAll('[data-from]:checked')].map((x) => x.dataset.from);
      writeSpec('from', picked.length ? picked : undefined, { redraw: 'card' });
    });
  }
  for (const el of mount.querySelectorAll('[data-skill]')) {
    el.addEventListener('change', () => {
      const picked = [...mount.querySelectorAll('[data-skill]:checked')].map((x) => x.dataset.skill);
      writeSpec('uses', picked.length ? picked : undefined, { redraw: 'card' });
    });
  }
  // Show the preview for the main text field without waiting for a focus.
  if (!state.refField || !mount.contains(state.refField)) state.refField = mount.querySelector('[data-ref]');
  previewSoon();
}

function skillPicker(chosen) {
  const names = [...new Map(state.skills.map((k) => [k.slug, k])).values()];
  if (!names.length) return '<div class="list-empty">No skills installed. They live in ~/.claude/skills or a project\'s .claude/skills.</div>';
  return `<div class="pick-list">${names.map((k) => `<label><input type="checkbox" data-skill="${esc(k.slug)}" ${chosen.includes(k.slug) ? 'checked' : ''}> ${esc(k.slug)} <span class="pd">${esc((k.description || '').slice(0, 70))}</span></label>`).join('')}</div>`;
}

/* --------------------------------- misc ---------------------------------- */

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('json-mode', mode === 'json');
  $('modeVisual').classList.toggle('on', mode === 'visual');
  $('modeJson').classList.toggle('on', mode === 'json');
  render();
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function slug(s, live = false) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '');
  return live ? out : out.replace(/-+$/, '');
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
