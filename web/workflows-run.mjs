/*
 * Canvas runtime for one workflow run.
 *
 * URL carries the run id in the hash. Fetches /api/runs/:id, lays out the
 * graph horizontally, draws edges, renders a left-side plan rail. Listens on
 * /events for 'update' and 'run' broadcasts so a running node fills in as its
 * output arrives.
 */

const ICON = {
  document: svg('<rect x="2" y="1.5" width="10" height="11" rx="1"/><line x1="4" y1="5" x2="10" y2="5"/><line x1="4" y1="7.5" x2="10" y2="7.5"/><line x1="4" y1="10" x2="8" y2="10"/>'),
  report:   svg('<rect x="2" y="2" width="10" height="10" rx="1"/><line x1="4.5" y1="5" x2="10" y2="5"/><line x1="4.5" y1="7.5" x2="10" y2="7.5"/><line x1="4.5" y1="10" x2="8" y2="10"/><circle cx="3.3" cy="5" r="0.5" fill="currentColor"/><circle cx="3.3" cy="7.5" r="0.5" fill="currentColor"/><circle cx="3.3" cy="10" r="0.5" fill="currentColor"/>'),
  mockup:   svg('<rect x="1.5" y="2.5" width="11" height="9" rx="1"/><line x1="1.5" y1="5" x2="12.5" y2="5"/>'),
  diff:     svg('<path d="M3 2 L7 7 L3 12"/><path d="M11 2 L7 7 L11 12"/>'),
  shots:    svg('<rect x="1.5" y="3" width="7" height="8" rx="1"/><rect x="6" y="3" width="7" height="8" rx="1" opacity="0.6"/>'),
  'shots-set': svg('<rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="8" y="1" width="5" height="5" rx="0.5"/><rect x="1" y="8" width="5" height="5" rx="0.5"/><rect x="8" y="8" width="5" height="5" rx="0.5"/>'),
  terminal: svg('<rect x="1" y="2" width="12" height="10" rx="1"/><path d="M3.5 6 L5.5 7.5 L3.5 9"/><line x1="6.5" y1="9.5" x2="10" y2="9.5"/>'),
  ask:      svg('<circle cx="7" cy="7" r="5.5"/><path d="M5.5 5.5 C5.5 4 8.5 4 8.5 5.8 C8.5 6.9 7 7 7 8.2"/><circle cx="7" cy="10.5" r="0.6" fill="currentColor"/>'),
  pr:       svg('<circle cx="3.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="10.5" r="1.5"/><circle cx="10.5" cy="10.5" r="1.5"/><line x1="3.5" y1="5" x2="3.5" y2="9"/><path d="M3.5 5 C3.5 8 10.5 7 10.5 9"/>'),
};
function svg(inner) {
  return `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">${inner}</svg>`;
}

const KIND_LABEL = {
  document: 'Document', report: 'Report', mockup: 'Mockup', diff: 'Diff',
  shots: 'Screenshots', 'shots-set': 'Screenshots', terminal: 'Terminal',
  ask: 'Decision', pr: 'Pull request',
};
const KIND_MODEL = {
  document: 'claude · opus-4-7', report: 'claude · opus-4-7',
  mockup: 'skill · frontend-design', diff: 'claude · acceptEdits',
  shots: 'orderly · capture', 'shots-set': 'orderly · capture',
  terminal: 'bash', ask: 'you', pr: 'github',
};

const runId = (location.hash || '').replace('#', '').trim();
if (!runId) {
  document.getElementById('runStatus').textContent = 'No run id in URL.';
}

let run = null;
let cards = {};

async function load() {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json());
  if (!r.run) {
    document.getElementById('runStatus').textContent = 'Run not found.';
    return;
  }
  run = r.run;
  render();
}

function render() {
  document.title = `${run.workflowTitle} — Orderly Claude`;
  document.getElementById('crumbTitle').textContent = run.workflowTitle;
  document.getElementById('runTitle').textContent   = run.workflowTitle;
  document.getElementById('runCatPip').className    = `pip ${run.category || ''}`;
  const nodes = run.graph?.nodes || [];
  const done = nodes.filter((n) => n.status === 'done').length;
  document.getElementById('runStatus').innerHTML = run.status === 'running'
    ? `<span class="live-dot"></span>Running · ${done} of ${nodes.length} done`
    : `${run.status} · ${done} of ${nodes.length} done`;
  if (run.sessionId) {
    document.getElementById('runSession').textContent = `session ${run.sessionId.slice(0, 8)}`;
  }
  renderPlanRail();
  layoutCanvas();
}

function renderPlanRail() {
  const mount = document.getElementById('rail');
  mount.innerHTML = '';
  for (const n of run.graph.nodes) {
    const kls = n.status === 'done' ? 'done'
      : n.status === 'running' ? 'running'
      : n.kind === 'ask' ? 'ask'
      : 'waits';
    const state = n.status === 'done' ? 'Done'
      : n.status === 'running' ? (n.progress || 'Making…')
      : n.waitsFor ? `Waits for ${n.waitsFor}` : 'Pending';
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

function layoutCanvas() {
  const canvas = document.getElementById('canvas');
  const edges  = document.getElementById('edges');
  canvas.querySelectorAll('.card').forEach((el) => el.remove());
  cards = {};
  const PAD = 32, CARD_W = 220, COL_GAP = 40, ROW_H = 240;
  for (const n of run.graph.nodes) {
    const left = PAD + (n.col - 1) * (CARD_W + COL_GAP);
    const top  = PAD + n.row * ROW_H;
    cards[n.id] = makeCard(n, { left, top, width: CARD_W }, canvas);
  }
  const maxCol = Math.max(...run.graph.nodes.map((n) => n.col));
  const maxRow = Math.max(...run.graph.nodes.map((n) => n.row));
  canvas.style.width  = `${PAD * 2 + maxCol * (CARD_W + COL_GAP)}px`;
  canvas.style.height = `${PAD * 2 + (maxRow + 1) * ROW_H}px`;
  requestAnimationFrame(() => requestAnimationFrame(() => drawEdges(canvas, edges)));
}

function makeCard(n, pos, parent) {
  const kls = ['card', `k-${n.kind}`, n.status].join(' ') + (n.kind === 'ask' ? ' ask' : '');
  const card = document.createElement('div');
  card.className = kls;
  card.style.cssText = `left:${pos.left}px;top:${pos.top}px;width:${pos.width}px`;
  card.dataset.id = n.id;
  card.innerHTML = `
    <div class="c-head">
      <span class="k-icon">${ICON[n.kind] || ''}</span>
      <span class="k-name">${KIND_LABEL[n.kind] || n.kind}</span>
      <span class="k-model">${KIND_MODEL[n.kind] || ''}</span>
    </div>
    <div class="c-body">${cardBody(n)}</div>
    <div class="c-foot">
      <span>${esc(n.title)}</span>
      <span class="credit">⚡ ${n.cost ?? 1}</span>
    </div>`;
  card.onclick = () => selectNode(n.id);
  parent.append(card);
  return card;
}

function cardBody(n) {
  const selfProgress = n.kind === 'shots-set';
  if (n.status === 'waits')   return `<div class="wait-note">Waits for ${esc(n.waitsFor || 'upstream nodes')}</div>`;
  if (n.status === 'pending') return `<div class="wait-note">Pending</div>`;
  if (n.status === 'running' && !selfProgress) {
    return `<div class="running-note"><span class="dot-pulse"></span>${esc(n.progress || 'Making…')}</div>`;
  }
  const o = n.output || {};
  switch (n.kind) {
    case 'document': {
      const body = (o.body || '').split('\n').filter(Boolean).slice(0, 6)
        .map((l) => esc(l).replace(/^## (.*)$/, '<span style="color:var(--text);font-weight:500;">$1</span>'))
        .join('<br>');
      return `<div class="doc-h">${esc(o.title || 'Document')}</div><div class="doc-b">${body}</div>`;
    }
    case 'report': {
      const items = (o.findings || []).slice(0, 4)
        .map((f) => `<div class="finding"><span class="tag">${esc(f.tag)}</span><span class="txt">${esc(f.text)}</span></div>`).join('');
      return `<div class="doc-h">${esc(o.title || 'Findings')}</div>${items}`;
    }
    case 'mockup':
      return `
        <div class="mock-ph"><div class="mini"><div class="bar a"></div><div class="bar b"></div><div class="bar c"></div></div></div>
        <div class="doc-h" style="margin-top:2px;">${esc(o.name || 'mockup.html')}</div>
        <div class="doc-b">${esc(o.note || '')}</div>`;
    case 'shots':
      return `<div class="shots-pair"><div class="shot"><span class="cap">before</span></div><div class="shot"><span class="cap">after</span></div></div>`;
    case 'shots-set': {
      const pairs = (o.pairs || []).slice(0, 6);
      const rows = pairs.map((p) => {
        const cls = p.status === 'done' ? 'done' : p.status === 'running' ? 'running' : 'waits';
        const label = p.status === 'done' ? 'done' : p.status === 'running' ? 'capturing…' : 'queued';
        const shot = (st) => st === 'done' ? '<div class="pair-shot filled"></div>'
          : st === 'running' ? '<div class="pair-shot running"></div>' : '<div class="pair-shot"></div>';
        return `<div class="route-row ${cls}">
          <span class="route-label">${esc(p.route)}</span>
          <div class="pair-mini">${shot(p.status)}${shot(p.status)}</div>
          <span class="route-state">${label}</span>
        </div>`;
      }).join('');
      const title = esc(o.title || `${pairs.filter((p) => p.status === 'done').length} of ${pairs.length} captured`);
      return `<div class="doc-h">${title}</div><div class="shots-grid">${rows}</div>`;
    }
    case 'terminal': {
      const prompt = esc(o.prompt || '$ (command)');
      const lines = (o.out || '').split('\n').slice(0, 6).map((l) => esc(l) || '&nbsp;').join('<br>');
      const status = o.status ? `<div class="term-status">${esc(o.status)}</div>` : '';
      return `<div class="term"><div class="term-prompt">${prompt}</div><div class="term-out">${lines}</div>${status}</div>`;
    }
    case 'pr':
      return `
        <div class="pr-head">
          <span class="pr-badge ${esc(o.state || 'open')}">${esc(o.state || 'open')}</span>
          <span class="pr-num">${esc(o.number || '#—')}</span>
        </div>
        <div class="doc-h" style="margin-top:4px;">${esc(o.title || 'Pull request')}</div>
        <div class="pr-body">${esc(o.bodyPreview || '').replace(/\n/g, '<br>')}</div>
        ${o.url ? `<a class="pr-url">${esc(o.url)} →</a>` : ''}`;
    case 'ask':
      return `<div class="ask-q">${esc(o.question || 'Decide here.')}</div><div class="ask-cta">◆ Open to answer →</div>`;
    case 'diff': {
      const hunks = (o.hunks || []).slice(0, 3);
      const rows = hunks.map((h) => `<div class="hunk-row ${esc(h.op)}"><span class="sign">${h.op === 'add' ? '+' : h.op === 'del' ? '−' : ' '}</span><span>${esc(h.line)}</span></div>`).join('');
      return `<div class="doc-h">${esc(o.file || 'diff')}</div><div class="hunks">${rows}</div>`;
    }
    default: return `<div class="doc-b">output ready</div>`;
  }
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

function selectNode(id) {
  for (const el of document.querySelectorAll('.card.sel, .plan-rail .item.sel')) el.classList.remove('sel');
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('sel');
  document.querySelector(`.plan-rail .item[data-id="${id}"]`)?.classList.add('sel');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Live updates — the broadcast carries no run payload, so refetch on signal. */
const src = new EventSource('/events');
src.addEventListener('update',    () => load().catch(() => {}));
src.addEventListener('run-start', () => load().catch(() => {}));
window.addEventListener('resize', () => run && drawEdges(document.getElementById('canvas'), document.getElementById('edges')));

if (runId) load();
