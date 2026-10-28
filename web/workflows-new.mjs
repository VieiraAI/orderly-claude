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
  document: '📄', report: '✎', mockup: '▦', diff: '±',
  shots: '◫', 'shots-set': '▦▦', terminal: '>_', ask: '?', pr: '↑',
};

const state = {
  def: null,
  selectedId: null,
  connectFromId: null,
  mode: 'visual',
};

/* ---------------------------------- init --------------------------------- */

async function boot() {
  await loadScaffold();
  bindUi();
  render();
}

async function loadScaffold() {
  const slug = $('wfId').value || 'untitled';
  const title = $('wfTitle').value || '';
  const r = await fetch(`/api/workflows/scaffold?id=${encodeURIComponent(slug)}&title=${encodeURIComponent(title)}`).then((x) => x.json());
  state.def = r.def;
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
  $('btnAddNode').addEventListener('click', addNode);
  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnConnect').addEventListener('click', () => {
    state.connectFromId = state.selectedId;
    render();
  });
  $('selId').addEventListener('change', () => renameSelected($('selId').value.trim()));
  $('selTitle').addEventListener('change', () => patchSelected({ title: $('selTitle').value }));
  $('selKind').addEventListener('change', () => patchSelected({ kind: $('selKind').value }));
  $('selCost').addEventListener('change', () => patchSelected({ cost: Number($('selCost').value) || 1 }));
  $('btnValidate').addEventListener('click', validate);
  $('btnSave').addEventListener('click', save);
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
  const idBase = kind.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'n';
  let id = idBase, i = 1;
  while (state.def.graph.nodes.some((n) => n.id === id)) { i++; id = `${idBase}${i}`; }
  const occupiedCols = state.def.graph.nodes.map((n) => n.col || 0);
  const col = occupiedCols.length ? Math.max(...occupiedCols) + 1 : 0;
  state.def.graph.nodes.push({
    id, title: id, kind, col, row: 0, cost: 1,
  });
  state.selectedId = id;
  render();
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
  state.def.graph.edges = (state.def.graph.edges || []).map(([a, b]) =>
    [a === old ? newId : a, b === old ? newId : b]);
  state.selectedId = newId;
  render();
}

function selectNode(id) {
  if (state.connectFromId && state.connectFromId !== id) {
    // Pending connect: wire this one and clear the mode.
    const pair = [state.connectFromId, id];
    const exists = (state.def.graph.edges || []).some(([a, b]) => a === pair[0] && b === pair[1]);
    if (!exists) state.def.graph.edges.push(pair);
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
  if (!ok) return;
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: state.def, scope: $('wfScope').value, overwrite: true }),
    }).then((x) => x.json());
    if (r.saved) {
      $('status').textContent = `Saved → ${r.file}`;
      $('status').className = 'status ok';
      return;
    }
    throw new Error(r.error || 'save failed');
  } catch (e) {
    showProblems([e.message]);
  }
}

function showProblems(list) {
  const panel = $('problems');
  if (!list.length) {
    panel.style.display = 'none';
    $('status').textContent = 'Valid.';
    $('status').className = 'status ok';
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = `<strong>${list.length} problem${list.length === 1 ? '' : 's'}:</strong><ul>${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
  $('status').textContent = `${list.length} problem${list.length === 1 ? '' : 's'}`;
  $('status').className = 'status err';
}

/* --------------------------------- render -------------------------------- */

function render() {
  $('wfId').value = state.def.id || '';
  $('wfTitle').value = state.def.title || '';
  renderCanvas();
  renderSelected();
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
  let dragging = false, startX, startY, startLeft, startTop;
  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = parseFloat(card.style.left); startTop = parseFloat(card.style.top);
    card.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const nx = startLeft + (e.clientX - startX);
    const ny = startTop  + (e.clientY - startY);
    card.style.left = `${Math.max(0, Math.round(nx / 20) * 20)}px`;
    card.style.top  = `${Math.max(0, Math.round(ny / 20) * 20)}px`;
    renderEdges();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    document.body.style.userSelect = '';
    // Snap pixels back to col/row.
    n.col = Math.max(0, Math.round((parseFloat(card.style.left) - GUTTER) / COL_W));
    n.row = Math.max(0, Math.round((parseFloat(card.style.top)  - GUTTER) / ROW_H));
    render();
  });
}

function renderEdges() {
  const svg = $('edEdges');
  const nodes = state.def.graph.nodes;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  // Two paths per edge: the visible one and a fat invisible one that catches
  // clicks without forcing the user to pixel-hunt the 1.4px stroke.
  const parts = [];
  (state.def.graph.edges || []).forEach(([a, b], i) => {
    const na = byId[a], nb = byId[b];
    if (!na || !nb) return;
    const ax = GUTTER + (na.col || 0) * COL_W + 200;         // right edge of source
    const ay = GUTTER + (na.row || 0) * ROW_H + 46;          // mid-height
    const bx = GUTTER + (nb.col || 0) * COL_W;               // left edge of target
    const by = GUTTER + (nb.row || 0) * ROW_H + 46;
    const dx = Math.max(40, (bx - ax) / 2);
    const d = `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
    parts.push(`<path class="edge-hit" data-i="${i}" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>`);
    parts.push(`<path class="edge" data-i="${i}" d="${d}" fill="none" stroke="#efb36c" stroke-width="1.4" opacity="0.7"/>`);
  });
  svg.innerHTML = parts.join('');
  for (const hit of svg.querySelectorAll('.edge-hit')) {
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(hit.dataset.i);
      const edge = state.def.graph.edges[i];
      if (!edge) return;
      if (!confirm(`Remove edge ${edge[0]} → ${edge[1]}?`)) return;
      state.def.graph.edges.splice(i, 1);
      render();
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
}

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

boot();
