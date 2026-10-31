/*
 * Canvas runtime for one workflow run.
 *
 * URL carries the run id in the hash. Fetches /api/runs/:id, lays out the
 * graph horizontally, draws edges, renders a left-side plan rail. Listens on
 * /events for 'update' and 'run' broadcasts so a running node fills in as its
 * output arrives. How each step and the run itself look is in run-view.mjs,
 * which the workflow editor shares.
 */

import {
  bindRunView, setRun, ICON, KIND_LABEL, KIND_MODEL, cardBody, cardClick, cardFootMeta, hasPreview, previewOf,
  openPreview, renderNotice, renderAnswer, renderRetro, renderRunActions, renderTimeline, openDrawer,
  refreshRedo, outOfDate, runRef, runSeconds, fmtSeconds, money, dur, esc,
} from '/run-view.mjs';

const rawHash = (location.hash || '').replace('#', '').trim();
const previewMatch = /^def:(.+)$/.exec(rawHash);
const previewDefId = previewMatch ? decodeURIComponent(previewMatch[1]) : null;
const runId = previewDefId ? null : rawHash;
const isPreview = !!previewDefId;
if (!runId && !isPreview) {
  document.getElementById('runStatus').textContent = 'No run id in URL.';
}

let run = null;
let cards = {};
let meta = {};           // currentVersion, question, live, ownedElsewhere
let selectedId = null;

bindRunView({
  reload: () => load(),
  select: (id, opts) => selectNode(id, opts),
  selected: () => selectedId,
  restack: () => stackCards(),
  cardEl: (id) => cards[id],
});

async function load() {
  if (isPreview) {
    // Preview mode: synthesise a run-shaped object from the def so the
    // existing canvas can render the workflow's structure. No scheduler,
    // no outputs; the Run button in the actions bar starts a real run.
    const r = await fetch(`/api/workflows/${encodeURIComponent(previewDefId)}`).then((x) => x.json()).catch(() => ({}));
    if (!r.workflow) {
      document.getElementById('runStatus').textContent = 'Workflow not found.';
      return;
    }
    run = defToPreviewRun(r.workflow);
    meta = {};
    setRun(run, meta, { preview: true });
    render();
    return;
  }
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json()).catch(() => ({}));
  if (!r.run) {
    document.getElementById('runStatus').textContent = 'Run not found — it may have been deleted.';
    return;
  }
  run = r.run;
  meta = r;
  setRun(run, meta);
  render();
}

function defToPreviewRun(def) {
  return {
    runId: null,
    workflowId: def.id,
    workflowTitle: def.title,
    category: def.category,
    scope: def.scope,
    repoRoot: def.repoRoot || null,
    schemaVersion: def.schemaVersion || 1,
    status: 'preview',
    startedAt: null, endedAt: null,
    inputs: {},
    graph: {
      nodes: (def.graph?.nodes || []).map((n) => ({
        id: n.id, title: n.title, kind: n.kind,
        col: n.col, row: n.row, cost: n.cost,
        spec: n.spec,
        status: 'pending', waitsFor: null, output: null,
      })),
      edges: def.graph?.edges || [],
    },
    _def: def, // keep the whole def around so the Run button has inputs
  };
}

function render() {
  document.title = `${run.workflowTitle} — Orderly Claude`;
  document.getElementById('crumbTitle').textContent = run.workflowTitle;
  document.getElementById('runTitle').textContent   = run.workflowTitle;
  document.getElementById('runCatPip').className    = `pip ${run.category || ''}`;
  // The editor shows this run on the workflow's own canvas.
  document.getElementById('backToWf').href = `/workflow-editor.html?from=${encodeURIComponent(run.workflowId)}${runRef()}${run.runId ? `&run=${encodeURIComponent(run.runId)}` : ''}`;
  const up = document.getElementById('toParent');
  up.hidden = !run.parent;
  if (run.parent) { up.href = `/workflows-run.html#${encodeURIComponent(run.parent.runId)}`; up.textContent = `↑ Part of ${run.parent.title}`; }
  const nodes = run.graph?.nodes || [];
  const done = nodes.filter((n) => n.status === 'done').length;
  const totals = { cost: 0, tokens: 0, elapsedS: 0 };
  for (const n of nodes) {
    const m = n.output?.meta;
    if (!m) continue;
    if (typeof m.cost === 'number') totals.cost += m.cost;
    if (typeof m.tokens === 'number') totals.tokens += m.tokens;
    const s = parseFloat(m.elapsed);
    if (Number.isFinite(s)) totals.elapsedS += s;
  }
  const totalBits = [];
  if (totals.cost) totalBits.push(money(totals.cost));
  if (run.budgetUsd) totalBits.push(`limit ${money(run.budgetUsd)}`);
  // How long the run took on the clock, not the sum of model time: those
  // disagreed, and the clock is what a person waited for.
  const took = runSeconds(run);
  if (took != null) totalBits.push(`took ${fmtSeconds(took)}`);
  const totalStr = totalBits.length ? ` · <span class="run-totals">${totalBits.join(' · ')}</span>` : '';
  const legacyPill = (run.schemaVersion || 1) < 2
    ? ' · <span class="legacy-pill" title="This run was defined under the pre-v2 schema. Rendered through the compat layer.">legacy</span>'
    : '';
  const word = { running: 'Running', 'awaiting-answer': 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Cut short' }[run.status] || run.status;
  const live = run.status === 'running' || run.status === 'awaiting-answer';
  document.getElementById('runStatus').innerHTML = isPreview
    ? `Preview · ${nodes.length} step${nodes.length === 1 ? '' : 's'} · not run yet${legacyPill}`
    : `${live ? '<span class="live-dot"></span>' : ''}${word} · ${done} of ${nodes.length} done${totalStr}${legacyPill}`;
  const bits = isPreview ? [] : [run.trigger === 'schedule' ? 'on schedule' : run.trigger === 'you' ? 'started by you' : run.trigger];
  if (run.sessionId) bits.push(`session ${run.sessionId.slice(0, 8)}`);
  document.getElementById('runSession').textContent = bits.filter(Boolean).join(' · ');
  renderNotice();
  renderAnswer();
  renderRetro();
  renderPlanRail();
  layoutCanvas();
  renderTimeline();
  renderRunActions();
  if (selectedId) openDrawer(selectedId, { keepScroll: true });
  refreshRedo();
}

window.addEventListener('hashchange', () => location.reload());

function renderPlanRail() {
  const mount = document.getElementById('rail');
  mount.innerHTML = '';
  for (const n of run.graph.nodes) {
    const kls = n.waitsFor === 'you' ? 'ask'
      : ['done', 'running', 'failed', 'skipped', 'interrupted', 'stopped'].includes(n.status) ? n.status
      : 'waits';
    const state = n.waitsFor === 'you' ? 'Waiting for you'
      : n.status === 'done' ? (n.durationMs ? `Done · ${dur(n.durationMs)}${n.attempts > 1 ? ` · ${n.attempts} tries` : ''}` : 'Done')
      : n.status === 'running' ? (n.progress || 'Working…')
      : n.status === 'failed' ? 'Failed'
      : n.status === 'skipped' ? 'Skipped — another branch was taken'
      : n.status === 'interrupted' ? 'Cut short'
      : n.status === 'stopped' ? 'Stopped'
      : 'Not started';
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.id = n.id;
    row.innerHTML = `
      <span class="marker ${kls}"></span>
      <div>
        <div class="name">${esc(n.title)}</div>
        <div class="state ${kls}">${esc(state)}</div>
      </div>`;
    row.onclick = () => selectNode(n.id);
    mount.append(row);
  }
}

// Card sizes and gaps on the run canvas, in pixels.
const PAD = 32, CARD_W = 220, WIDE_W = 470, COL_GAP = 40, ROW_H = 240, ROW_GAP = 40;

function layoutCanvas() {
  const canvas = document.getElementById('canvas');
  canvas.querySelectorAll('.card').forEach((el) => el.remove());
  cards = {};
  // Columns may start at 0 or 1 depending on who placed them; lay out from
  // whichever is leftmost so nothing lands off the canvas.
  const cols = run.graph.nodes.map((n) => n.col || 0);
  const minCol = Math.min(...cols);
  // A step with pages or pictures to preview gets a wider card, and its
  // column widens with it so the next column moves over instead of under.
  const widthOf = (n) => (hasPreview(n) ? WIDE_W : CARD_W);
  const colW = {};
  for (const n of run.graph.nodes) { const c = (n.col || 0) - minCol; colW[c] = Math.max(colW[c] || CARD_W, widthOf(n)); }
  const maxCol = Math.max(...cols) - minCol + 1;
  const colLeft = {};
  for (let c = 0, x = PAD; c < maxCol; c++) { colLeft[c] = x; x += (colW[c] || CARD_W) + COL_GAP; }
  for (const n of run.graph.nodes) {
    const left = colLeft[(n.col || 0) - minCol];
    const top  = PAD + (n.row || 0) * ROW_H;
    cards[n.id] = makeCard(n, { left, top, width: widthOf(n) }, canvas);
  }
  canvas.style.width  = `${colLeft[maxCol - 1] + (colW[maxCol - 1] || CARD_W) + PAD}px`;
  stackCards();
}

/**
 * Each card sits just below the card above it in its own column, and never
 * higher than its row's usual place. A tall card pushes down only its own
 * column, so the rest stay compact and rows line up where nothing is tall.
 * Run again whenever a card changes height.
 */
function stackCards() {
  const canvas = document.getElementById('canvas');
  const byCol = {};
  for (const n of run.graph.nodes) (byCol[n.col || 0] ||= []).push(n);
  let bottom = PAD;
  for (const list of Object.values(byCol)) {
    list.sort((a, b) => (a.row || 0) - (b.row || 0));
    let below = 0;
    for (const n of list) {
      const top = Math.max(PAD + (n.row || 0) * ROW_H, below);
      cards[n.id].style.top = `${top}px`;
      below = top + cards[n.id].offsetHeight + ROW_GAP;
      bottom = Math.max(bottom, below - ROW_GAP);
    }
  }
  canvas.style.height = `${bottom + PAD}px`;
  requestAnimationFrame(() => requestAnimationFrame(() => drawEdges(canvas, document.getElementById('edges'))));
}

function makeCard(n, pos, parent) {
  const askish = n.kind === 'ask' || n.kind === 'decision' || n.kind === 'approve';
  const kls = ['card', `k-${n.kind}`, n.status].join(' ') + (askish ? ' ask' : '');
  const card = document.createElement('div');
  card.className = kls + (previewOf(n) ? ' has-pv' : '');
  card.style.cssText = `left:${pos.left}px;top:${pos.top}px;width:${pos.width}px`;
  card.dataset.id = n.id;
  // The model label on the head uses the real model that ran if we have it,
  // otherwise a kind-level default. Same with the credit on the foot.
  const meta = n.output?.meta || {};
  // The model that actually ran, once known; it already says "claude".
  // "claude-sonnet-5-5" → "Sonnet 5.5": short enough to sit beside the kind.
  const modelLabel = meta.model
    ? esc(String(meta.model).replace(/^claude-/, '').replace(/^([a-z]+)-(\d+)-(\d+).*$/i, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`))
    : n.kind === 'publish' ? (n.spec?.target === 'pr' ? 'draft PR' : 'file')
    : (KIND_MODEL[n.kind] || '');
  const footMeta = cardFootMeta(n, meta);
  card.innerHTML = `
    <div class="c-head">
      <span class="k-icon">${ICON[n.kind] || ''}</span>
      <span class="k-name">${KIND_LABEL[n.kind] || n.kind}</span>
      <span class="k-model">${modelLabel}</span>
    </div>
    <div class="c-body">${cardBody(n)}</div>
    <div class="c-foot">
      <span>${esc(n.title)}${outOfDate(n) ? ' <span class="stale-tag" title="An earlier step was redone after this one ran">out of date</span>' : ''}</span>
      <span class="credit">${footMeta}</span>
    </div>
    ${previewOf(n) ? '<span class="pv-open" aria-hidden="true">Preview ↗</span>' : ''}`;
  card.onclick = (e) => {
    // A picture opens full size on its own; the pager turns the pictures
    // over. Neither opens the step drawer.
    if (cardClick(n, e)) return;
    // Something to review opens in the preview window; the step's details
    // are one click away from there.
    if (previewOf(n)) { selectNode(n.id, { drawer: false }); openPreview(n); return; }
    selectNode(n.id);
  };
  parent.append(card);
  return card;
}

function drawEdges(canvas, edges) {
  edges.innerHTML = '';
  const cRect = canvas.getBoundingClientRect();
  edges.setAttribute('width',  canvas.offsetWidth);
  edges.setAttribute('height', canvas.offsetHeight);
  for (const [a, b] of (run.graph.edges || [])) {
    const ra = cards[a]?.getBoundingClientRect();
    const rb = cards[b]?.getBoundingClientRect();
    if (!ra || !rb) continue;
    const x1 = ra.right - cRect.left, y1 = ra.top - cRect.top + ra.height / 2;
    const x2 = rb.left  - cRect.left, y2 = rb.top - cRect.top + rb.height / 2;
    const dx = Math.max(40, (x2 - x1) * 0.55);
    const d  = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    edges.append(
      nse('path', { d, stroke: 'var(--edge-strong)', 'stroke-width': 1.2, fill: 'none' }),
      nse('circle', { cx: x1, cy: y1, r: 2.5, fill: 'var(--gold)' }),
      nse('circle', { cx: x2, cy: y2, r: 2.5, fill: 'var(--gold)' }),
    );
  }
}
function nse(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function selectNode(id, { drawer = true } = {}) {
  selectedId = id;
  for (const el of document.querySelectorAll('.card.sel, .plan-rail .item.sel')) el.classList.remove('sel');
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('sel');
  document.querySelector(`.plan-rail .item[data-id="${id}"]`)?.classList.add('sel');
  renderRunActions();
  if (drawer) openDrawer(id);
}

document.getElementById('drawerClose').onclick = () => {
  document.getElementById('drawer').classList.remove('on');
  document.getElementById('drawer').setAttribute('aria-hidden', 'true');
  selectedId = null;
  for (const el of document.querySelectorAll('.card.sel, .plan-rail .item.sel')) el.classList.remove('sel');
  renderRunActions();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('drawerClose').click(); });

/* Live updates — the broadcast carries no run payload, so refetch on signal.
 * `?snapshot=1` skips the stream so headless screenshotters can finish loading. */
if (!new URLSearchParams(location.search).has('snapshot')) {
  // Every run's events arrive here; reload only for this one, and at most a
  // few times a second while a step streams.
  const src = new EventSource('/events');
  let pending = null;
  const mine = (e) => {
    let id = null;
    try { id = JSON.parse(e.data || '{}').runId; } catch { /* no payload */ }
    if (id && id !== runId) return;
    clearTimeout(pending);
    pending = setTimeout(() => load().catch(() => {}), 120);
  };
  for (const ev of ['update', 'run-start', 'run-finish']) src.addEventListener(ev, mine);
}
// A live run is read again every few seconds and when the tab is shown, in
// case the stream dropped (Orderly restarted) and did not come back.
setInterval(() => {
  if (run && ['running', 'awaiting-answer'].includes(run.status) && document.visibilityState === 'visible') load().catch(() => {});
}, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && run && !isPreview) load().catch(() => {}); });
window.addEventListener('resize', () => run && drawEdges(document.getElementById('canvas'), document.getElementById('edges')));

if (runId || isPreview) load();