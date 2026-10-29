/*
 * Visual workflow editor. Nodes are draggable cards on a dot-grid canvas,
 * edges are SVG curves between card edges. A sidebar hosts the add-node
 * picker, the selected-node form, and save/validate controls. A JSON mode
 * swaps the canvas for the raw def as an escape hatch.
 *
 * Node coordinates are stored on the def as `col`/`row`. The editor keeps
 * pixel positions in parallel so dragging is smooth and the saved def
 * reflects what the user placed on screen (snapped to a 20px grid).
 */
const $ = (id) => document.getElementById(id);
const COL_W = 240, ROW_H = 180, GUTTER = 60;

const KIND_GLYPH = {
  // legacy
  document: '📄', report: '✎', mockup: '▦', diff: '±',
  shots: '◫', 'shots-set': '▦▦', terminal: '>_', ask: '?', pr: '↑',
  // v2
  agent: '◆', script: '>_', decision: '◇', check: '✓',
  publish: '↑', display: '▦', inputs: '≡',
  loop: '↻', delay: '◷', approve: '✓',
};

/** Starter spec per v2 kind so a freshly-added node is immediately valid. */
const KIND_SPEC_DEFAULT = {
  agent:    () => ({ model: 'haiku', output: 'markdown', prompt: 'Describe what this agent should do.' }),
  script:   () => ({ cmd: 'echo hello' }),
  decision: () => ({ question: 'Pick one', options: [{ label: 'Yes', edgeLabel: 'yes' }, { label: 'No', edgeLabel: 'no' }] }),
  check:    () => ({ assert: { type: 'exit-zero', from: '' } }),
  publish:  () => ({ target: 'pr' }),
  display:  () => ({ render: 'markdown', from: '' }),
  inputs:   () => ({ fields: [{ key: 'name', label: 'Name', type: 'text' }] }),
  loop:     () => ({ over: '{{upstream.array}}', body: [] }),
  delay:    () => ({ wait: '5s' }),
  approve:  () => ({ question: 'Approve?' }),
};

const state = {
  def: null,
  selectedId: null,
  connectFromId: null,
  mode: 'visual',
};

/* ---------------------------------- init --------------------------------- */

async function boot() {
  // /workflows-new.html?from=<id> loads an existing def into the editor so
  // "Edit" on a workflow's preview page lands you in a prefilled editor.
  const from = new URLSearchParams(location.search).get('from');
  if (from) await loadExisting(from);
  else await loadScaffold();
  bindUi();
  render();
}

async function loadScaffold() {
  const slug = $('wfId').value || 'untitled';
  const title = $('wfTitle').value || '';
  const r = await fetch(`/api/workflows/scaffold?id=${encodeURIComponent(slug)}&title=${encodeURIComponent(title)}`).then((x) => x.json());
  state.def = r.def;
}

async function loadExisting(id) {
  const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`).then((x) => x.json());
  if (!r.workflow) { await loadScaffold(); return; }
  // Drop server-side fields that aren't part of the on-disk def (scope,
  // source). The editor's save path writes to the chosen scope dropdown
  // so this isn't lost — just not carried as inline state.
  const { scope, source, ...clean } = r.workflow;
  state.def = clean;
  // Reflect the loaded id/title into the sidebar inputs on first render.
  requestAnimationFrame(() => {
    if ($('wfId'))    $('wfId').value    = state.def.id    || '';
    if ($('wfTitle')) $('wfTitle').value = state.def.title || '';
    if ($('wfScope') && scope) $('wfScope').value = scope;
  });
}

function bindUi() {
  $('wfId').addEventListener('change', async () => {
    state.def.id = $('wfId').value.trim();
    render();
  });
  $('wfTitle').addEventListener('change', () => {
    state.def.title = $('wfTitle').value.trim() || state.def.id;
    render();
  });
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
  // Click anywhere else closes the popover.
  document.addEventListener('click', (e) => {
    const pop = $('addPop');
    if (!pop || !pop.classList.contains('on')) return;
    if (e.target.closest('.add-floater')) return;
    pop.classList.remove('on');
  });
  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnConnect').addEventListener('click', () => {
    state.connectFromId = state.selectedId;
    render();
  });
  $('selId').addEventListener('change', () => renameSelected($('selId').value.trim()));
  $('selTitle').addEventListener('change', () => patchSelected({ title: $('selTitle').value }));
  $('selKind').addEventListener('change', () => {
    const kind = $('selKind').value;
    const patch = { kind };
    // Seed a default spec if moving into a v2 kind that has one and the
    // current node doesn't already carry a usable spec.
    const n = state.def.graph.nodes.find((x) => x.id === state.selectedId);
    const starter = KIND_SPEC_DEFAULT[kind];
    if (starter && (!n?.spec || Object.keys(n.spec).length === 0)) {
      patch.spec = starter();
    }
    patchSelected(patch);
  });
  $('selCost').addEventListener('change', () => patchSelected({ cost: Number($('selCost').value) || 1 }));
  $('btnValidate').addEventListener('click', validate);
  $('btnSave').addEventListener('click', save);
  $('btnRun')?.addEventListener('click', saveAndRun);
  $('modeVisual').addEventListener('click', () => setMode('visual'));
  $('modeJson').addEventListener('click', () => setMode('json'));
  $('jsonArea').addEventListener('change', () => {
    try { state.def = JSON.parse($('jsonArea').value); render(); }
    catch (e) { showProblems([`JSON parse: ${e.message}`]); }
  });
  // Canvas clicks (background) deselect; keeps the sidebar in sync.
  $('edCanvas').addEventListener('click', (e) => {
    if (e.target.id === 'edCanvas' || e.target.id === 'edInner' || e.target.id === 'edEdges') {
      state.selectedId = null; state.connectFromId = null; render();
    }
  });
}

/* -------------------------------- actions -------------------------------- */

function addNode() {
  const kind = $('newKind').value;
  const after  = $('newAfter')?.value || '';
  const before = $('newBefore')?.value || '';
  const idBase = kind.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'n';
  let id = idBase, i = 1;
  while (state.def.graph.nodes.some((n) => n.id === id)) { i++; id = `${idBase}${i}`; }
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
  const row = na?.row ?? nb?.row ?? 0;
  const node = { id, title: id, kind, col, row, cost: 1 };
  const starter = KIND_SPEC_DEFAULT[kind];
  if (starter) node.spec = starter();
  state.def.graph.nodes.push(node);
  // Auto-wire the chosen edges. If after is a Decision, prompt for a label.
  if (after) {
    const src = nodeAt(after);
    let label = null;
    if (src?.kind === 'decision' && (src.spec?.options || []).length) {
      const opts = src.spec.options.map((o) => o.edgeLabel).filter(Boolean);
      const picked = window.prompt(
        `Decision "${src.id}" routes down a labeled edge. Which label? (${opts.join(' / ')}; empty = unlabeled default)`,
        opts[0] || '');
      if (picked && picked.trim()) label = picked.trim();
    }
    state.def.graph.edges.push(label ? [after, id, label] : [after, id]);
  }
  if (before) state.def.graph.edges.push([id, before]);
  state.selectedId = id;
  // Reset the pickers so the next add starts fresh.
  if ($('newAfter'))  $('newAfter').value  = '';
  if ($('newBefore')) $('newBefore').value = '';
  render();
}

/** Fill the after/before pickers with current node ids. Preserves selection. */
function refreshAddPickers() {
  const nodes = state.def.graph.nodes;
  const opts = ['<option value="">— none —</option>']
    .concat(nodes.map((n) => `<option value="${escapeAttr(n.id)}">${escapeHtml(n.id)} · ${escapeHtml(n.title || '')}</option>`));
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
  if (!state.selectedId) return;
  const id = state.selectedId;
  state.def.graph.nodes = state.def.graph.nodes.filter((n) => n.id !== id);
  state.def.graph.edges = (state.def.graph.edges || []).filter(([a, b]) => a !== id && b !== id);
  state.selectedId = null;
  state.connectFromId = null;
  render();
}

/** Click handler for an edge label — prompt to rename or clear it. */
function editEdgeLabel(idx) {
  const edge = state.def.graph.edges[idx];
  if (!edge) return;
  const current = edge[2] || '';
  const next = window.prompt(`Edge label for ${edge[0]} → ${edge[1]} (empty = unlabeled)`, current);
  if (next === null) return;
  if (next.trim()) edge[2] = next.trim();
  else { if (edge.length > 2) edge.length = 2; }
  render();
}
window.__editEdgeLabel = editEdgeLabel;

function patchSelected(fields) {
  const n = state.def.graph.nodes.find((x) => x.id === state.selectedId);
  if (!n) return;
  Object.assign(n, fields);
  render();
}

function renameSelected(newId) {
  if (!newId || newId === state.selectedId) return;
  if (state.def.graph.nodes.some((n) => n.id === newId)) {
    showProblems([`id "${newId}" is already taken`]);
    return;
  }
  const old = state.selectedId;
  for (const n of state.def.graph.nodes) if (n.id === old) n.id = newId;
  state.def.graph.edges = (state.def.graph.edges || []).map((e) => {
    const [a, b, l] = e;
    const na = a === old ? newId : a;
    const nb = b === old ? newId : b;
    return l ? [na, nb, l] : [na, nb];
  });
  state.selectedId = newId;
  render();
}

function selectNode(id) {
  if (state.connectFromId && state.connectFromId !== id) {
    const src = state.def.graph.nodes.find((n) => n.id === state.connectFromId);
    // Pending connect: wire this one and clear the mode. If the source is a
    // Decision, offer one of its spec.options as the edge label.
    let label = null;
    if (src?.kind === 'decision' && (src.spec?.options || []).length) {
      const opts = src.spec.options.map((o) => o.edgeLabel).filter(Boolean);
      const picked = window.prompt(
        `Decision "${src.id}" routes down a labeled edge. Which label? (${opts.join(' / ')}; empty = unlabeled default)`,
        opts[0] || '');
      if (picked && picked.trim()) label = picked.trim();
    }
    const edge = label ? [state.connectFromId, id, label] : [state.connectFromId, id];
    const exists = (state.def.graph.edges || []).some(([a, b, l]) =>
      a === edge[0] && b === edge[1] && (l || null) === (edge[2] || null));
    if (!exists) state.def.graph.edges.push(edge);
    state.connectFromId = null;
    state.selectedId = id;
    render();
    return;
  }
  state.selectedId = id;
  render();
}

/* -------------------------------- validate ------------------------------- */

async function validate() {
  const r = await fetch('/api/workflows/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ def: state.def }),
  }).then((x) => x.json());
  showProblems(r.problems || []);
  return r.ok;
}

async function save() {
  const ok = await validate();
  if (!ok) return false;
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: state.def, scope: $('wfScope').value, overwrite: true }),
    }).then((x) => x.json());
    if (r.saved) {
      $('status').textContent = `Saved → ${r.file}`;
      $('status').className = 'status ok';
      $('problems').style.display = 'none';
      $('edToast').style.display = 'block';
      clearTimeout(showProblems._t);
      showProblems._t = setTimeout(() => { $('edToast').style.display = 'none'; }, 2500);
      return true;
    }
    throw new Error(r.error || 'save failed');
  } catch (e) {
    showProblems([e.message]);
    return false;
  }
}

/** Save first, then POST a run with any declared inputs, then jump to its canvas. */
async function saveAndRun() {
  const saved = await save();
  if (!saved) return;
  const fields = Array.isArray(state.def.inputs) ? state.def.inputs : [];
  const inputs = {};
  for (const f of fields) {
    const label = f.label || f.key;
    const val = window.prompt(`${label}${f.placeholder ? ` (e.g. ${f.placeholder})` : ''}`, '');
    if (val === null) return;
    if (val.trim()) inputs[f.key] = val.trim();
  }
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(state.def.id)}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs }),
    }).then((x) => x.json());
    if (!r.run?.runId) throw new Error(r.error || 'run failed to start');
    location.href = `/workflows-run.html#${r.run.runId}`;
  } catch (e) {
    showProblems([e.message]);
  }
}

function showProblems(list) {
  const panel = $('problems');
  const toast = $('edToast');
  if (!list.length) {
    panel.style.display = 'none';
    $('status').textContent = 'Valid.';
    $('status').className = 'status ok';
    toast.style.display = 'block';
    // Auto-fade the success state after a short beat so it doesn't linger.
    clearTimeout(showProblems._t);
    showProblems._t = setTimeout(() => { toast.style.display = 'none'; }, 2000);
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = `<strong>${list.length} problem${list.length === 1 ? '' : 's'}:</strong><ul>${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
  $('status').textContent = `${list.length} problem${list.length === 1 ? '' : 's'}`;
  $('status').className = 'status err';
  toast.style.display = 'block';
  clearTimeout(showProblems._t);
}

/* --------------------------------- render -------------------------------- */

function render() {
  $('wfId').value = state.def.id || '';
  $('wfTitle').value = state.def.title || '';
  refreshAddPickers();
  renderCanvas();
  renderSelected();
  // Sidebar collapses when nothing is selected — the canvas fills the width.
  const layout = $('edLayout');
  if (layout) layout.classList.toggle('no-sel', !state.selectedId);
  if (state.mode === 'json') $('jsonArea').value = JSON.stringify(state.def, null, 2);
}

function renderCanvas() {
  const inner = $('edInner');
  // Keep edges SVG, drop cards.
  for (const el of inner.querySelectorAll('.n-card')) el.remove();
  for (const n of state.def.graph.nodes) {
    inner.append(nodeCard(n));
  }
  renderEdges();
}

function nodeCard(n) {
  const x = GUTTER + (n.col || 0) * COL_W;
  const y = GUTTER + (n.row || 0) * ROW_H;
  const card = document.createElement('div');
  const cls = ['n-card', `k-${n.kind}`];
  if (n.id === state.selectedId) cls.push('sel');
  if (n.id === state.connectFromId) cls.push('connect-src');
  card.className = cls.join(' ');
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.dataset.id = n.id;
  card.innerHTML = `
    <div class="n-head">
      <span class="n-kind">${KIND_GLYPH[n.kind] || '●'} ${escapeHtml(n.kind)}</span>
      <span class="n-id">${escapeHtml(n.id)}</span>
    </div>
    <div class="n-title">${escapeHtml(n.title || n.id)}</div>
    <div class="n-foot"><span>⚡ ${n.cost ?? 1}</span><span>col ${n.col || 0} · row ${n.row || 0}</span></div>`;
  card.addEventListener('click', (e) => { e.stopPropagation(); selectNode(n.id); });
  attachDrag(card, n);
  return card;
}

function attachDrag(card, n) {
  let dragging = false, moved = false, startX, startY, startLeft, startTop;
  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    startLeft = parseFloat(card.style.left); startTop = parseFloat(card.style.top);
    card.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    // Treat tiny pointer wobble as a click, not a drag. Without this the
    // mouseup always re-renders and tears the card out of the DOM before
    // the click handler can run, so selection appears broken.
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    card.style.left = `${Math.max(0, Math.round((startLeft + dx) / 20) * 20)}px`;
    card.style.top  = `${Math.max(0, Math.round((startTop  + dy) / 20) * 20)}px`;
    renderEdges();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (!moved) return; // plain click — let the click handler fire selectNode.
    // Snap pixels back to col/row and re-render.
    n.col = Math.max(0, Math.round((parseFloat(card.style.left) - GUTTER) / COL_W));
    n.row = Math.max(0, Math.round((parseFloat(card.style.top)  - GUTTER) / ROW_H));
    render();
  });
}

function renderEdges() {
  const svg = $('edEdges');
  svg.setAttribute('pointer-events', 'all');
  const nodes = state.def.graph.nodes;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  // Two paths per edge: the visible one and a fat invisible one that catches
  // clicks. A labeled edge gets a small pill badge at the midpoint; clicking
  // the badge opens the label prompt instead of removing the edge.
  const parts = [];
  (state.def.graph.edges || []).forEach((edge, i) => {
    const [a, b, label] = edge;
    const na = byId[a], nb = byId[b];
    if (!na || !nb) return;
    const ax = GUTTER + (na.col || 0) * COL_W + 200;         // right edge of source
    const ay = GUTTER + (na.row || 0) * ROW_H + 46;          // mid-height
    const bx = GUTTER + (nb.col || 0) * COL_W;               // left edge of target
    const by = GUTTER + (nb.row || 0) * ROW_H + 46;
    const dx = Math.max(40, (bx - ax) / 2);
    const d = `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
    parts.push(`<path class="edge-hit" data-i="${i}" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>`);
    const stroke = label ? '#a3abff' : '#efb36c';
    parts.push(`<path class="edge ${label ? 'labeled' : ''}" data-i="${i}" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4" opacity="0.7"/>`);
    if (label) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const w = Math.max(28, label.length * 7 + 10);
      parts.push(
        `<g class="edge-label" data-i="${i}" transform="translate(${mx - w / 2},${my - 10})" style="cursor:pointer;">
           <rect width="${w}" height="18" rx="9" fill="#131318" stroke="#a3abff" stroke-width="1"/>
           <text x="${w / 2}" y="12" text-anchor="middle"
                 font-family="Geist Mono, monospace" font-size="10"
                 fill="#a3abff">${escapeHtml(label)}</text>
         </g>`);
    }
  });
  svg.innerHTML = parts.join('');
  for (const hit of svg.querySelectorAll('.edge-hit')) {
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(hit.dataset.i);
      const edge = state.def.graph.edges[i];
      if (!edge) return;
      // Shift-click to edit the label; plain click still removes.
      if (e.shiftKey) { editEdgeLabel(i); return; }
      if (!confirm(`Remove edge ${edge[0]} → ${edge[1]}${edge[2] ? ` (${edge[2]})` : ''}?`)) return;
      state.def.graph.edges.splice(i, 1);
      render();
    });
  }
  for (const badge of svg.querySelectorAll('.edge-label')) {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      editEdgeLabel(Number(badge.dataset.i));
    });
  }
}

function renderSelected() {
  const n = state.def.graph.nodes.find((x) => x.id === state.selectedId);
  const block = $('selBlock');
  if (!n) { block.style.display = 'none'; return; }
  block.style.display = '';
  $('selId').value = n.id;
  $('selTitle').value = n.title || '';
  $('selKind').value = n.kind;
  $('selCost').value = n.cost ?? 1;
  $('btnConnect').textContent = state.connectFromId
    ? '↝ click a target card…'
    : '↝ connect to…';
  renderSpecForm(n);
}

/**
 * Per-kind spec editor. Each kind renders a different set of fields; writes
 * flow through writeSpec() which patches node.spec and re-renders.
 */
function renderSpecForm(n) {
  const mount = $('selSpec');
  mount.innerHTML = '';
  const spec = n.spec || {};
  const row = (label, control) => `<label>${label}</label>${control}`;
  const ta = (key, val, ph = '') =>
    `<textarea data-spec="${key}" placeholder="${escapeAttr(ph)}">${escapeHtml(val || '')}</textarea>`;
  const txt = (key, val, ph = '') =>
    `<input data-spec="${key}" value="${escapeAttr(val || '')}" placeholder="${escapeAttr(ph)}">`;
  const sel = (key, val, opts) =>
    `<select data-spec="${key}">${opts.map((o) => `<option ${val === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  let html = '';
  switch (n.kind) {
    case 'agent':
      html = row('model',  sel('model',  spec.model  || 'haiku',  ['haiku', 'sonnet', 'opus']))
           + row('output', sel('output', spec.output || 'markdown',
             ['markdown', 'json-findings', 'html', 'json-hunks', 'json']))
           + row('prompt', ta('prompt', spec.prompt, 'What should this agent do? Reads upstream outputs automatically.'));
      break;
    case 'script':
      html = row('op (optional)', sel('op', spec.op || '', ['', 'capture-shot', 'capture-shots']))
           + row('cmd', ta('cmd', spec.cmd, 'npm test'));
      break;
    case 'decision':
      html = row('question', txt('question', spec.question, 'Which direction?'))
           + '<label>options</label>' + renderOptions(spec.options || [])
           + '<button class="run-btn" data-act="add-option" style="margin-top:4px;">+ add option</button>';
      break;
    case 'check':
      html = row('assert.type', sel('assert.type', spec.assert?.type || 'exit-zero',
             ['exit-zero', 'contains', 'has-pairs', 'manual']))
           + row('assert.from (node id)', txt('assert.from', spec.assert?.from, 'tests'))
           + (spec.assert?.type === 'contains'
              ? row('assert.needle', txt('assert.needle', spec.assert?.needle, 'OK'))
              : '')
           + (spec.assert?.type === 'has-pairs'
              ? row('assert.min', txt('assert.min', spec.assert?.min ?? 1, '1'))
              : '')
           + row('on fail', sel('onFail', spec.onFail || 'stop', ['stop', 'skip']));
      break;
    case 'publish':
      html = row('target', sel('target', spec.target || 'pr', ['pr', 'file']))
           + (spec.target === 'file' ? row('path', txt('path', spec.path, '.orderly-claude/outputs/out.md')) : '');
      break;
    case 'display':
      html = row('render', sel('render', spec.render || 'markdown',
             ['markdown', 'json', 'shots-set', 'mockups-grid', 'diff']))
           + row('from (node id, comma-separated for multi)', txt('from', Array.isArray(spec.from) ? spec.from.join(',') : spec.from, 'dir-a,dir-b,dir-c'));
      break;
    case 'inputs':
      html = '<label>fields</label>' + renderInputFields(spec.fields || [])
           + '<button class="run-btn" data-act="add-field" style="margin-top:4px;">+ add field</button>';
      break;
    case 'loop':
      html = row('over', txt('over', spec.over, '{{upstream.array}}'))
           + row('body (comma-separated node ids)', txt('body', (spec.body || []).join(','), 'child-a,child-b'));
      break;
    case 'delay':
      html = row('wait', txt('wait', spec.wait, '5s or 2026-01-01T00:00:00Z'));
      break;
    case 'approve':
      html = row('question', txt('question', spec.question, 'Ship it?'));
      break;
    default:
      // Legacy kinds have no spec editor; show a note so authors are nudged
      // toward the v2 vocabulary.
      html = `<div class="status" style="margin:4px 0 0;">Legacy kind — no spec form. Switch to a v2 kind for structured editing.</div>`;
  }
  mount.innerHTML = html;
  // Wire inputs to writeSpec.
  for (const el of mount.querySelectorAll('[data-spec]')) {
    el.addEventListener('change', () => writeSpec(el.dataset.spec, el.value));
    el.addEventListener('input',  () => writeSpec(el.dataset.spec, el.value, { silent: true }));
  }
  mount.querySelector('[data-act="add-option"]')?.addEventListener('click', () => {
    const n = selectedNode(); if (!n) return;
    n.spec = n.spec || {};
    n.spec.options = n.spec.options || [];
    const i = n.spec.options.length + 1;
    n.spec.options.push({ label: `Option ${i}`, edgeLabel: `opt${i}` });
    render();
  });
  mount.querySelector('[data-act="add-field"]')?.addEventListener('click', () => {
    const n = selectedNode(); if (!n) return;
    n.spec = n.spec || {};
    n.spec.fields = n.spec.fields || [];
    n.spec.fields.push({ key: `f${n.spec.fields.length + 1}`, label: '', type: 'text' });
    render();
  });
  // Row-level removes.
  for (const btn of mount.querySelectorAll('[data-act="rm-option"]')) {
    btn.addEventListener('click', () => {
      const n = selectedNode(); if (!n) return;
      const i = Number(btn.dataset.i);
      n.spec.options.splice(i, 1);
      render();
    });
  }
  for (const btn of mount.querySelectorAll('[data-act="rm-field"]')) {
    btn.addEventListener('click', () => {
      const n = selectedNode(); if (!n) return;
      const i = Number(btn.dataset.i);
      n.spec.fields.splice(i, 1);
      render();
    });
  }
}

function selectedNode() {
  return state.def.graph.nodes.find((n) => n.id === state.selectedId) || null;
}

/** Patch `node.spec` with a dot-path key like 'assert.type' or 'prompt'. */
function writeSpec(key, value, { silent = false } = {}) {
  const n = selectedNode(); if (!n) return;
  n.spec = n.spec || {};
  // Comma-separated lists for structured fields.
  if (n.kind === 'display' && key === 'from') {
    const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    n.spec.from = list.length <= 1 ? (list[0] || '') : list;
  } else if (n.kind === 'loop' && key === 'body') {
    n.spec.body = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (key.includes('.')) {
    const [head, tail] = key.split('.');
    n.spec[head] = n.spec[head] || {};
    n.spec[head][tail] = value;
  } else {
    n.spec[key] = value;
  }
  if (!silent) render();
}

function renderOptions(options) {
  if (!options.length) return '<div class="status" style="margin:0 0 4px;">No options yet.</div>';
  return options.map((o, i) => `
    <div class="opt-row" data-i="${i}">
      <input class="opt-label" placeholder="label" value="${escapeAttr(o.label || '')}"
             onchange="window.__editOpt(${i}, 'label', this.value)">
      <input class="opt-edge"  placeholder="edgeLabel" value="${escapeAttr(o.edgeLabel || '')}"
             onchange="window.__editOpt(${i}, 'edgeLabel', this.value)">
      <button class="run-btn danger" data-act="rm-option" data-i="${i}" title="Remove">✕</button>
    </div>
  `).join('');
}

function renderInputFields(fields) {
  if (!fields.length) return '<div class="status" style="margin:0 0 4px;">No fields yet.</div>';
  return fields.map((f, i) => `
    <div class="opt-row" data-i="${i}">
      <input class="opt-label" placeholder="key" value="${escapeAttr(f.key || '')}"
             onchange="window.__editField(${i}, 'key', this.value)">
      <input class="opt-edge"  placeholder="label" value="${escapeAttr(f.label || '')}"
             onchange="window.__editField(${i}, 'label', this.value)">
      <select class="opt-type" onchange="window.__editField(${i}, 'type', this.value)">
        ${['text', 'textarea', 'select'].map((t) => `<option ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <button class="run-btn danger" data-act="rm-field" data-i="${i}" title="Remove">✕</button>
    </div>
  `).join('');
}

// Globals used by the inline onchange handlers in option/field rows.
window.__editOpt = (i, key, value) => {
  const n = selectedNode(); if (!n) return;
  n.spec.options = n.spec.options || [];
  if (n.spec.options[i]) n.spec.options[i][key] = value;
  render();
};
window.__editField = (i, key, value) => {
  const n = selectedNode(); if (!n) return;
  n.spec.fields = n.spec.fields || [];
  if (n.spec.fields[i]) n.spec.fields[i][key] = value;
  render();
};

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('json-mode', mode === 'json');
  $('modeVisual').classList.toggle('on', mode === 'visual');
  $('modeJson').classList.toggle('on', mode === 'json');
  render();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

boot();
