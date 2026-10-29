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
  // v2 vocabulary — pick an icon that reads at a glance.
  agent:    svg('<circle cx="7" cy="7" r="5.5"/><circle cx="5" cy="6" r="0.7" fill="currentColor"/><circle cx="9" cy="6" r="0.7" fill="currentColor"/><path d="M4.5 9.5 Q7 11 9.5 9.5"/>'),
  script:   svg('<rect x="1" y="2" width="12" height="10" rx="1"/><path d="M3.5 6 L5.5 7.5 L3.5 9"/><line x1="6.5" y1="9.5" x2="10" y2="9.5"/>'),
  decision: svg('<circle cx="7" cy="7" r="5.5"/><path d="M5.5 5.5 C5.5 4 8.5 4 8.5 5.8 C8.5 6.9 7 7 7 8.2"/><circle cx="7" cy="10.5" r="0.6" fill="currentColor"/>'),
  check:    svg('<circle cx="7" cy="7" r="5.5"/><path d="M4 7.5 L6 9.5 L10 5"/>'),
  publish:  svg('<circle cx="3.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="10.5" r="1.5"/><circle cx="10.5" cy="10.5" r="1.5"/><line x1="3.5" y1="5" x2="3.5" y2="9"/><path d="M3.5 5 C3.5 8 10.5 7 10.5 9"/>'),
  display:  svg('<rect x="1.5" y="3" width="11" height="8" rx="1"/><line x1="4" y1="6" x2="10" y2="6"/><line x1="4" y1="8" x2="8" y2="8"/>'),
  inputs:   svg('<rect x="2" y="2.5" width="10" height="2.5" rx="0.5"/><rect x="2" y="6" width="10" height="2.5" rx="0.5"/><rect x="2" y="9.5" width="6" height="2" rx="0.5"/>'),
  loop:     svg('<path d="M3 7 A4 4 0 0 1 11 7"/><path d="M11 7 A4 4 0 0 1 3 7"/><path d="M11 4 L11 7 L8 7"/>'),
  delay:    svg('<circle cx="7" cy="7.5" r="4.5"/><path d="M7 5 L7 7.5 L9 8.5"/>'),
  approve:  svg('<path d="M3.5 7 L6 9.5 L10.5 4.5"/>'),
};
function svg(inner) {
  return `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">${inner}</svg>`;
}

const KIND_LABEL = {
  document: 'Document', report: 'Report', mockup: 'Mockup', diff: 'Diff',
  shots: 'Screenshots', 'shots-set': 'Screenshots', terminal: 'Terminal',
  ask: 'Decision', pr: 'Pull request',
  agent: 'Agent', script: 'Script', decision: 'Decision', check: 'Check',
  publish: 'Publish', display: 'Display', inputs: 'Inputs',
  loop: 'Loop', delay: 'Delay', approve: 'Approve',
};
// Shown only until a step has run and reported the model it actually used.
const KIND_MODEL = {
  document: 'claude', report: 'claude',
  mockup: 'claude', diff: 'claude',
  shots: 'orderly · capture', 'shots-set': 'orderly · capture',
  terminal: 'bash', ask: 'you', pr: 'github',
  agent: 'claude · cli', script: 'bash', decision: 'you', check: 'orderly',
  publish: 'github', display: 'orderly', inputs: 'you',
  loop: 'orderly', delay: 'orderly', approve: 'you',
};

/** Map a v2 kind + output shape onto the legacy render case so the body stays
 *  compact. New kinds (check/display/inputs) get their own cases below. */
function effectiveRender(n) {
  const o = n.output || {};
  if (n.kind === 'agent') {
    if (o.findings) return 'report';
    if (o.hunks)    return 'diff';
    if (o.html)     return 'mockup';
    return 'document';
  }
  if (n.kind === 'script') {
    if (o.pairs) return 'shots-set';
    if (o.shot || o.after) return 'shots';
    return 'terminal';
  }
  if (n.kind === 'decision') return 'ask';
  if (n.kind === 'publish') {
    const target = (n.spec?.target) || 'pr';
    if (target === 'pr') return 'pr';
    return 'publish';
  }
  if (n.kind === 'display') {
    // Mockups-grid of upstream agent outputs is the common case.
    const first = (o.sources || [])[0];
    if (first?.kind === 'agent' && first.output?.html) return 'mockup';
    if (first?.output?.pairs) return 'shots-set';
    return 'display';
  }
  return n.kind;
}

const runId = (location.hash || '').replace('#', '').trim();
if (!runId) {
  document.getElementById('runStatus').textContent = 'No run id in URL.';
}

let run = null;
let cards = {};
let meta = {};           // currentVersion, question, live, ownedElsewhere
let selectedId = null;
const armed = new Set();

async function load() {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json()).catch(() => ({}));
  if (!r.run) {
    document.getElementById('runStatus').textContent = 'Run not found — it may have been deleted.';
    return;
  }
  run = r.run;
  meta = r;
  render();
}

function money(n) { return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }

function render() {
  document.title = `${run.workflowTitle} — Orderly Claude`;
  document.getElementById('crumbTitle').textContent = run.workflowTitle;
  document.getElementById('runTitle').textContent   = run.workflowTitle;
  document.getElementById('runCatPip').className    = `pip ${run.category || ''}`;
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
  if (totals.elapsedS) totalBits.push(`${totals.elapsedS.toFixed(1)} s`);
  const totalStr = totalBits.length ? ` · <span class="run-totals">${totalBits.join(' · ')}</span>` : '';
  const legacyPill = (run.schemaVersion || 1) < 2
    ? ' · <span class="legacy-pill" title="This run was defined under the pre-v2 schema. Rendered through the compat layer.">legacy</span>'
    : '';
  const word = { running: 'Running', 'awaiting-answer': 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Cut short' }[run.status] || run.status;
  const live = run.status === 'running' || run.status === 'awaiting-answer';
  document.getElementById('runStatus').innerHTML = `${live ? '<span class="live-dot"></span>' : ''}${word} · ${done} of ${nodes.length} done${totalStr}${legacyPill}`;
  const bits = [run.trigger === 'schedule' ? 'on schedule' : run.trigger === 'you' ? 'started by you' : run.trigger];
  if (run.sessionId) bits.push(`session ${run.sessionId.slice(0, 8)}`);
  document.getElementById('runSession').textContent = bits.filter(Boolean).join(' · ');
  renderNotice();
  renderAnswer();
  renderPlanRail();
  layoutCanvas();
  renderTimeline();
  renderRunActions();
  if (selectedId) openDrawer(selectedId, { keepScroll: true });
}

/** Why the run is in the state it is, in a sentence, with what to do next. */
function renderNotice() {
  const out = [];
  if (meta.ownedElsewhere) out.push(['info', 'Another Orderly window is running this one. Answer or stop it there.']);
  if (run.halt?.message) out.push(['warn', run.halt.message]);
  if (run.status === 'interrupted') {
    const at = run.interruption?.nodes?.length ? ` during ${run.interruption.nodes.map((id) => `“${titleOf(id)}”`).join(', ')}` : '';
    out.push(['warn', `Orderly closed while this was running${at}. Finished steps are kept; Resume carries on from there.`]);
  }
  const failed = run.graph.nodes.find((n) => n.status === 'failed');
  if (run.status === 'failed' && !run.halt) {
    out.push(['bad', failed ? `“${failed.title}” failed: ${failed.output?.error || 'no reason given'}` : (run.error || 'This run failed.')]);
  }
  if (meta.currentVersion && run.definitionVersion && meta.currentVersion !== run.definitionVersion) {
    out.push(['info', `This run used version ${run.definitionVersion} of the workflow; it is on version ${meta.currentVersion} now. Repeating this run repeats what it ran.`]);
  }
  document.getElementById('runNotice').innerHTML = out.map(([k, t]) => `<div class="notice ${k}">${esc(t)}</div>`).join('');
}

function titleOf(id) { return run.graph.nodes.find((n) => n.id === id)?.title || id; }

/** Answer here, where the run is waiting, not somewhere else. */
function renderAnswer() {
  const q = meta.question;
  const mount = document.getElementById('answerPanel');
  if (!q || meta.ownedElsewhere) { mount.innerHTML = ''; return; }
  const buttons = q.choices?.length
    ? q.choices.map((c) => `<button class="answer-btn ${/reject|^no$/i.test(c) ? 'neg' : ''}" data-answer="${esc(c)}">${esc(c)}</button>`).join('')
    : '<input class="answer-text" id="answerText" placeholder="Your answer"><button class="answer-btn" id="answerSend">Answer</button>';
  mount.innerHTML = `<div class="answer-panel">
    <div class="ap-eyebrow">Waiting for you · ${esc(q.title)}</div>
    <div class="ap-q">${esc(q.question)}</div>
    <div class="need-actions">${buttons}<span class="need-status" id="apStatus"></span></div>
  </div>`;
  const send = async (answer) => {
    document.getElementById('apStatus').textContent = 'Sending…';
    const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/answer`, { nodeId: q.nodeId, answer });
    if (r.answered) { document.getElementById('apStatus').textContent = 'Answered.'; load(); }
    else { const el = document.getElementById('apStatus'); el.textContent = r.error || 'Could not answer.'; el.classList.add('bad'); }
  };
  mount.querySelectorAll('[data-answer]').forEach((b) => { b.onclick = () => send(b.dataset.answer); });
  const box = mount.querySelector('#answerText');
  if (box) {
    mount.querySelector('#answerSend').onclick = () => send(box.value.trim());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(box.value.trim()); });
  }
}

async function post(url, body = {}, method = 'POST') {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, ...j };
}

function renderRunActions() {
  let bar = document.getElementById('runActions');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'runActions';
    bar.className = 'run-actions';
    document.querySelector('.panel .head').append(bar);
  }
  const live = (run.status === 'running' || run.status === 'awaiting-answer') && !meta.ownedElsewhere;
  const resumable = ['interrupted', 'stopped', 'failed'].includes(run.status);
  const sel = selectedId && run.graph.nodes.find((n) => n.id === selectedId);
  const del = armed.has('delete');
  bar.innerHTML = `
    ${live ? '<button class="run-btn danger" data-act="stop" title="Stop this run now">■ Stop</button>' : ''}
    ${resumable && !run.halt ? '<button class="run-btn" data-act="resume" title="Carry on from where it stopped; finished steps are not repeated">▸ Resume</button>' : ''}
    ${run.halt?.type === 'budget' ? `<span class="raise">Raise the limit to $<input class="raise-in" id="raiseIn" inputmode="decimal" value="${(run.halt.limitUsd * 2).toFixed(2)}"><button class="run-btn" data-act="raise">and resume</button></span>` : ''}
    ${!live ? '<button class="run-btn" data-act="rerun" title="Repeat exactly what this run ran">⟲ Repeat</button>' : ''}
    ${!live && sel ? `<button class="run-btn" data-act="rerun-from" title="Keep everything before this step, run again from it">⟲ Repeat from “${esc(sel.title)}”</button>` : ''}
    ${!live ? `<a class="run-btn" href="/workflows.html?open=${encodeURIComponent(run.workflowId)}&again=${encodeURIComponent(run.runId)}#workflows" title="Run the workflow again with these inputs, editable first">↻ Again with changes</a>` : ''}
    <button class="run-btn" data-act="share" title="Signed link to a static copy of this run">◎ Share</button>
    ${!live ? `<button class="run-btn danger" data-act="delete" title="Delete this run">${del ? 'Click again to delete' : '✕ Delete'}</button>` : ''}
    <div class="choice-slot" id="resumeChoice"></div>
    <span class="need-status" id="actStatus"></span>`;
  const say = (t, bad) => { const el = bar.querySelector('#actStatus'); el.textContent = t; el.classList.toggle('bad', !!bad); };
  const act = (name, fn) => { const b = bar.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
  act('stop', async () => { const r = await post(`/api/runs/${run.runId}/stop`); if (!r.stopped) say(r.error || 'Could not stop it.', true); load(); });
  act('resume', () => resume());
  act('raise', () => resume({ budgetUsd: Number(bar.querySelector('#raiseIn').value) }));
  act('rerun', () => rerunFromCanvas(null));
  act('rerun-from', () => rerunFromCanvas(selectedId));
  act('share', async () => {
    const b = bar.querySelector('[data-act="share"]');
    const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/share`);
    if (!r.url) { say(r.error || 'Could not make a link.', true); return; }
    await navigator.clipboard?.writeText(r.url).catch(() => {});
    b.textContent = '◎ Copied';
    window.open(r.url, '_blank', 'noopener');
  });
  act('delete', async () => {
    if (!armed.has('delete')) {
      armed.add('delete'); renderRunActions();
      setTimeout(() => { if (armed.delete('delete')) renderRunActions(); }, 3000);
      return;
    }
    const r = await post(`/api/runs/${encodeURIComponent(run.runId)}`, {}, 'DELETE');
    if (r.deleted) location.href = '/workflows.html#runs';
    else say(r.error || 'Could not delete it.', true);
  });

  async function resume(extra = {}, choices = {}) {
    say('Resuming…');
    const r = await post(`/api/runs/${run.runId}/resume`, { ...extra, choices });
    if (r.needsChoice) {
      say('');
      const picked = { ...choices };
      bar.querySelector('#resumeChoice').innerHTML = r.needsChoice.map((c) => `<div class="choice">
        <div><b>${esc(c.title)}</b> was running when this stopped${c.command ? ` (<code>${esc(c.command)}</code>)` : ''}, and is marked as not safe to repeat. Did it finish?</div>
        <div class="need-actions">
          <button class="answer-btn" data-node="${esc(c.nodeId)}" data-val="assume-done">It already happened — carry on after it</button>
          <button class="answer-btn neg" data-node="${esc(c.nodeId)}" data-val="repeat">Run it again</button>
        </div></div>`).join('');
      bar.querySelectorAll('#resumeChoice [data-val]').forEach((b) => {
        b.onclick = () => {
          picked[b.dataset.node] = b.dataset.val;
          if (r.needsChoice.every((c) => picked[c.nodeId])) resume(extra, picked);
          else b.closest('.choice').classList.add('chosen');
        };
      });
      return;
    }
    if (r.resumed) { load(); return; }
    say(r.error || 'Could not resume it.', true);
  }
}

async function rerunFromCanvas(fromNodeId) {
  const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/rerun`, { fromNodeId });
  if (r.run?.runId) { location.href = `/workflows-run.html#${r.run.runId}`; return; }
  const el = document.getElementById('actStatus');
  if (el) { el.textContent = r.error || 'Could not repeat it.'; el.classList.add('bad'); }
}

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

function layoutCanvas() {
  const canvas = document.getElementById('canvas');
  const edges  = document.getElementById('edges');
  canvas.querySelectorAll('.card').forEach((el) => el.remove());
  cards = {};
  const PAD = 32, CARD_W = 220, COL_GAP = 40, ROW_H = 240;
  // Columns may start at 0 or 1 depending on who placed them; lay out from
  // whichever is leftmost so nothing lands off the canvas.
  const cols = run.graph.nodes.map((n) => n.col || 0);
  const minCol = Math.min(...cols);
  for (const n of run.graph.nodes) {
    const left = PAD + ((n.col || 0) - minCol) * (CARD_W + COL_GAP);
    const top  = PAD + (n.row || 0) * ROW_H;
    cards[n.id] = makeCard(n, { left, top, width: CARD_W }, canvas);
  }
  const maxCol = Math.max(...cols) - minCol + 1;
  const maxRow = Math.max(...run.graph.nodes.map((n) => n.row || 0));
  canvas.style.width  = `${PAD * 2 + maxCol * (CARD_W + COL_GAP)}px`;
  canvas.style.height = `${PAD * 2 + (maxRow + 1) * ROW_H}px`;
  requestAnimationFrame(() => requestAnimationFrame(() => drawEdges(canvas, edges)));
}

function makeCard(n, pos, parent) {
  const askish = n.kind === 'ask' || n.kind === 'decision' || n.kind === 'approve';
  const kls = ['card', `k-${n.kind}`, n.status].join(' ') + (askish ? ' ask' : '');
  const card = document.createElement('div');
  card.className = kls;
  card.style.cssText = `left:${pos.left}px;top:${pos.top}px;width:${pos.width}px`;
  card.dataset.id = n.id;
  // The model label on the head uses the real model that ran if we have it,
  // otherwise a kind-level default. Same with the credit on the foot.
  const meta = n.output?.meta || {};
  const modelLabel = meta.model
    ? `claude · ${esc(meta.model)}`
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
      <span>${esc(n.title)}</span>
      <span class="credit">${footMeta}</span>
    </div>`;
  card.onclick = () => selectNode(n.id);
  parent.append(card);
  return card;
}

/**
 * The right-side bit on the card footer. When a handler called the CLI it
 * returns `meta` with model, cost, elapsed, tokens; prefer that over the
 * static cost token the def declared. Falls back to the static credit for
 * local kinds (terminal, ask) and placeholder output.
 */
function cardFootMeta(n, meta) {
  const bits = [];
  if (typeof meta.cost === 'number') {
    bits.push(meta.cost < 0.01 ? `$${meta.cost.toFixed(4)}` : `$${meta.cost.toFixed(3)}`);
  }
  if (meta.elapsed) bits.push(esc(String(meta.elapsed)));
  if (typeof meta.tokens === 'number' && meta.tokens > 0) bits.push(`${meta.tokens} tok`);
  if (bits.length) return bits.join(' · ');
  return `⚡ ${n.cost ?? 1}`;
}

function cardBody(n) {
  // `selfProgress` kinds render their own in-progress UI (grids filling, text
  // streaming); the generic running-note short-circuits for everyone else.
  const selfProgress = n.kind === 'shots-set'
    || (n.kind === 'script' && !!n.output?.pairs)
    || (n.kind === 'document' && !!n.output?.body)
    || (n.kind === 'agent' && !!n.output?.body);
  // Before the running check: a step waiting on a person is technically running.
  if (n.waitsFor === 'you') {
    return `<div class="ask-q">${esc(n.output?.question || 'Waiting for you.')}</div><div class="ask-cta">◆ Answer on the left</div>`;
  }
  if (n.status === 'pending') return `<div class="wait-note">Not started</div>`;
  if (n.status === 'running' && !selfProgress) {
    return `<div class="running-note"><span class="dot-pulse"></span>${esc(n.progress || 'Making…')}</div>`;
  }
  if (n.status === 'failed') {
    const msg = n.output?.error || 'Handler threw. Open the run.json for the full trace.';
    return `<div class="fail-note"><span class="fail-tag">failed</span>${esc(msg)}</div>`;
  }
  if (n.status === 'stopped') {
    return `<div class="wait-note">Stopped before it finished.</div>`;
  }
  if (n.status === 'interrupted') {
    return `<div class="wait-note">Cut short when Orderly closed. Resume runs it again.</div>`;
  }
  if (n.status === 'skipped') {
    return `<div class="wait-note">Skipped — a choice earlier took another branch.</div>`;
  }

  const o = n.output || {};
  // v2 kinds that aren't covered by the legacy render switch — handle first.
  if (n.kind === 'check' && typeof o.pass === 'boolean') {
    const cls = o.pass ? 'ok' : 'bad';
    const label = o.pass ? 'pass' : 'fail';
    return `<div class="check-row ${cls}"><span class="check-pill ${cls}">${label}</span><span class="check-reason">${esc(o.reason || '')}</span></div>`;
  }
  if (n.kind === 'inputs' && o.values) {
    const rows = Object.entries(o.values).slice(0, 6)
      .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v).slice(0, 48))}</span></div>`).join('');
    return `<div class="doc-h">${esc(o.title || 'Inputs')}</div><div class="kvs">${rows || '<div class="doc-b">(no values)</div>'}</div>`;
  }
  // Loop/Delay/Approve placeholders — show their note.
  if ((n.kind === 'loop' || n.kind === 'delay') && o.note) {
    return `<div class="wait-note">${esc(o.note)}</div>`;
  }
  // Everything else: fall through the legacy switch, dispatching new kinds
  // (agent/script/decision/publish/display) by output shape.
  switch (effectiveRender(n)) {
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
    case 'shots': {
      const after = o.after?.ref || o.shot?.ref;
      const before = o.before?.ref;
      if (!after) return `<div class="wait-note">${esc(o.note || 'No shot captured.')}</div>`;
      const shotEl = (ref, cap) => ref
        ? `<a class="shot" href="${blobUrl(ref)}" target="_blank" style="background-image:url('${blobUrl(ref)}')"><span class="cap">${esc(cap)}</span></a>`
        : `<div class="shot"><span class="cap">${esc(cap)}</span></div>`;
      return `<div class="shots-pair">${before ? shotEl(before, 'before') : ''}${shotEl(after, before ? 'after' : esc(o.route || '/'))}</div>`;
    }
    case 'shots-set': {
      const pairs = (o.pairs || []).slice(0, 6);
      const hasBaseline = pairs.some((p) => p.before?.ref);
      const rows = pairs.map((p) => {
        const cls = p.status === 'done' ? 'done'
          : p.status === 'running' ? 'running'
          : p.status === 'failed' ? 'failed' : 'waits';
        const label = p.status === 'done' ? 'done'
          : p.status === 'running' ? 'capturing…'
          : p.status === 'failed'  ? 'failed'
          : p.status === 'skipped' ? 'no server' : 'queued';
        const after  = p.after?.ref  || p.shot?.ref;
        const before = p.before?.ref;
        const slot = (ref, title) => ref
          ? `<a class="pair-shot filled real" href="${blobUrl(ref)}" target="_blank"
               style="background-image:url('${blobUrl(ref)}')" title="${esc(title)}"></a>`
          : p.status === 'running' ? '<div class="pair-shot running"></div>'
          : p.status === 'failed'  ? '<div class="pair-shot failed"></div>'
          : '<div class="pair-shot"></div>';
        const content = hasBaseline
          ? `${slot(before, 'before')}${slot(after, 'after')}`
          : (after
             ? `<a class="pair-shot filled real only" href="${blobUrl(after)}" target="_blank"
                  style="background-image:url('${blobUrl(after)}')" title="Open full-size"></a>`
             : slot(null));
        return `<div class="route-row ${cls}">
          <span class="route-label">${esc(p.route)}</span>
          <div class="pair-mini${!hasBaseline && after ? ' solo' : ''}">${content}</div>
          <span class="route-state">${label}</span>
        </div>`;
      }).join('');
      const title = esc(o.title || `${pairs.filter((p) => p.status === 'done').length} of ${pairs.length} captured`);
      const note = o.note ? `<div class="wait-note" style="margin-top:8px;">${esc(o.note)}</div>` : '';
      return `<div class="doc-h">${title}</div><div class="shots-grid">${rows}</div>${note}`;
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
      return o.answer !== undefined
        ? `<div class="ask-q">${esc(o.question || '')}</div><div class="ask-cta answered">You chose: ${esc(String(o.answer))}</div>`
        : `<div class="ask-q">${esc(o.question || 'Decide here.')}</div>`;
    case 'diff': {
      const hunks = (o.hunks || []).slice(0, 3);
      const rows = hunks.map((h) => `<div class="hunk-row ${esc(h.op)}"><span class="sign">${h.op === 'add' ? '+' : h.op === 'del' ? '−' : ' '}</span><span>${esc(h.line)}</span></div>`).join('');
      return `<div class="doc-h">${esc(o.file || 'diff')}</div><div class="hunks">${rows}</div>`;
    }
    case 'display': {
      const sources = o.sources || [];
      if (!sources.length) return `<div class="wait-note">No upstream to display.</div>`;
      const rows = sources.map((s) => `<div class="src-row"><span class="src-kind">${esc(s.kind)}</span><span class="src-id">${esc(s.id)}</span><span class="src-title">${esc(s.title || '')}</span></div>`).join('');
      return `<div class="doc-h">${esc(o.render || 'display')} · ${sources.length}</div>${rows}`;
    }
    case 'publish': {
      // Non-PR publish target (e.g. file write).
      return `<div class="doc-h">${esc(o.target || 'publish')}</div><div class="doc-b">${esc(o.path || '')} ${o.bytes ? `· ${o.bytes} B` : ''}</div>`;
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
  selectedId = id;
  for (const el of document.querySelectorAll('.card.sel, .plan-rail .item.sel')) el.classList.remove('sel');
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('sel');
  document.querySelector(`.plan-rail .item[data-id="${id}"]`)?.classList.add('sel');
  renderRunActions();
  openDrawer(id);
}

function dur(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Everything about one step: what it was set to do, given, made, and why it failed. */
function openDrawer(id, { keepScroll = false } = {}) {
  const n = run.graph.nodes.find((x) => x.id === id);
  if (!n) return;
  const drawer = document.getElementById('drawer');
  const body = document.getElementById('drawerBody');
  const scroll = drawer.scrollTop;
  const o = n.output || {};
  const s = n.spec || {};
  const sec = (h, inner) => inner ? `<div class="dr-sec"><div class="dr-h">${h}</div>${inner}</div>` : '';
  const pre = (t, cls = '') => `<pre class="dr-pre ${cls}">${esc(String(t))}</pre>`;
  const started = n.startedAt ? new Date(n.startedAt).toLocaleTimeString() : null;
  const facts = [
    ['Status', n.waitsFor === 'you' ? 'waiting for you' : n.status],
    ['Started', started],
    ['Took', n.durationMs ? dur(n.durationMs) : n.startedAt && n.endedAt ? dur(Date.parse(n.endedAt) - Date.parse(n.startedAt)) : null],
    ['Tries', n.attempts > 1 ? String(n.attempts) : null],
    ['Model', o.meta?.model || s.model || null],
    ['Cost', typeof o.meta?.cost === 'number' ? money(o.meta.cost) : null],
  ].filter(([, v]) => v);
  const authored = s.prompt || s.cmd || s.question || n.prompt || n.command || null;
  let made = '';
  if (o.body) made = pre(o.body);
  else if (o.out !== undefined) made = pre(`${o.prompt ? `${o.prompt}\n` : ''}${o.out || '(no output)'}${o.code !== undefined ? `\n\nexit ${o.code}` : ''}`, 'term');
  else if (o.findings) made = `<ul class="dr-list">${o.findings.map((f) => `<li><b>${esc(f.tag)}</b> ${esc(f.text)}</li>`).join('')}</ul>`;
  else if (o.answer !== undefined) made = `<div class="dr-answer">${esc(String(o.answer))}</div>`;
  else if (o.pass !== undefined) made = `<div class="dr-answer ${o.pass ? '' : 'bad'}">${o.pass ? 'Passed' : 'Did not pass'} — ${esc(o.reason || '')}</div>`;
  else if (o.results) made = `<ul class="dr-list">${o.results.map((r) => `<li><b>${esc(String(r.item))}</b> ${esc(String(r.error || r.text || r.out || '').slice(0, 300))}</li>`).join('')}</ul>${o.note ? `<div class="dr-note">${esc(o.note)}</div>` : ''}`;
  else if (o.data !== undefined) made = pre(typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2));
  else if (o.html) made = pre(o.html);
  else if (o.path) made = `<div class="dr-answer">Wrote <code>${esc(o.path)}</code>${o.bytes != null ? ` · ${o.bytes} bytes` : ''}</div>${o.body ? pre(o.body) : ''}`;
  else if (o.note) made = `<div class="dr-note">${esc(o.note)}</div>`;
  else if (o.title) made = `<div class="dr-answer">${esc(o.title)}</div>`;
  const terminal = !['running', 'awaiting-answer'].includes(run.status);
  body.innerHTML = `
    <div class="dr-kind">${esc(KIND_LABEL[n.kind] || n.kind)}</div>
    <h3 class="dr-title">${esc(n.title || n.id)}</h3>
    <dl class="dr-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${n.status === 'failed' ? sec('Why it failed', `<div class="fail-note">${esc(o.error || 'No reason was recorded.')}</div>`) : ''}
    ${n.lastError && n.status !== 'failed' ? sec('Earlier try failed', `<div class="dr-note">${esc(n.lastError)}</div>`) : ''}
    ${sec('Set up to', authored ? pre(authored) : '')}
    ${sec('What it was given', n.sent && n.sent.replace(/^\$ /, '') !== authored ? pre(n.sent) : '')}
    ${sec('What it produced', made)}
    ${terminal && n.status !== 'pending' ? `<button class="run-btn" id="drRerun">⟲ Repeat from this step</button>` : ''}`;
  body.querySelector('#drRerun')?.addEventListener('click', () => rerunFromCanvas(n.id));
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('on');
  if (keepScroll) drawer.scrollTop = scroll;
}

document.getElementById('drawerClose').onclick = () => {
  document.getElementById('drawer').classList.remove('on');
  document.getElementById('drawer').setAttribute('aria-hidden', 'true');
  selectedId = null;
  for (const el of document.querySelectorAll('.card.sel, .plan-rail .item.sel')) el.classList.remove('sel');
  renderRunActions();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('drawerClose').click(); });

/** Each step as a bar against the run's clock, so a slow one shows as a long bar. */
function renderTimeline() {
  const el = document.getElementById('timeline');
  const timed = run.graph.nodes.filter((n) => n.startedAt);
  if (!timed.length) { el.classList.add('hidden'); return; }
  const t0 = Math.min(...timed.map((n) => Date.parse(n.startedAt)));
  const now = Date.now();
  const end = (n) => (n.endedAt ? Date.parse(n.endedAt) : now);
  const t1 = Math.max(...timed.map(end), t0 + 1000);
  const span = t1 - t0;
  el.classList.remove('hidden');
  el.innerHTML = `<div class="tl-head"><span>Timeline</span><span>${dur(span)}</span></div>` + timed
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .map((n) => {
      const left = ((Date.parse(n.startedAt) - t0) / span) * 100;
      const width = Math.max(0.6, ((end(n) - Date.parse(n.startedAt)) / span) * 100);
      const st = n.waitsFor === 'you' ? 'ask' : n.status;
      return `<div class="tl-row" data-id="${esc(n.id)}" title="${esc(n.title)} · ${dur(end(n) - Date.parse(n.startedAt))}">
        <span class="tl-name">${esc(n.title)}</span>
        <span class="tl-track"><span class="tl-bar ${st}" style="left:${left}%;width:${width}%"></span></span>
        <span class="tl-dur">${dur(end(n) - Date.parse(n.startedAt))}</span></div>`;
    }).join('');
  el.querySelectorAll('.tl-row').forEach((r) => { r.onclick = () => selectNode(r.dataset.id); });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Resolve a blob ref like `blob:sha256:<hex>:png` to its /api/blob URL. */
function blobUrl(ref) {
  const m = /^blob:sha256:([a-f0-9]{64})/.exec(String(ref || ''));
  return m ? `/api/blob?sha=${m[1]}` : '';
}

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
window.addEventListener('resize', () => run && drawEdges(document.getElementById('canvas'), document.getElementById('edges')));

if (runId) load();
