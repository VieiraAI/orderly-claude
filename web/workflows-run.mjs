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
  // The same names the editor uses, so a step is called one thing everywhere.
  agent: 'Ask Claude', script: 'Run a command', decision: 'Ask me to choose', check: 'Check',
  publish: 'Save or publish', display: 'Show together', inputs: 'Ask for inputs',
  loop: 'Repeat for each', delay: 'Wait', approve: 'Ask me to approve', mcp: 'Call a tool',
};
// Shown only until a step has run and reported the model it actually used.
const KIND_MODEL = {
  document: 'claude', report: 'claude',
  mockup: 'claude', diff: 'claude',
  shots: 'orderly · capture', 'shots-set': 'orderly · capture',
  terminal: 'bash', ask: 'you', pr: 'github',
  agent: 'claude · cli', script: 'bash', decision: 'you', check: 'orderly',
  publish: 'orderly', display: 'orderly', inputs: 'you',
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
    if (o.data !== undefined) return 'json';
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
const armed = new Set();

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
  render();
}

/*
 * The query that names this run's workflow. A project workflow is named by
 * its repo as well as its id, since two projects may each have one.
 */
function runRef() {
  return run?.scope === 'project' && run.repoRoot
    ? `&scope=project&repo=${encodeURIComponent(run.repoRoot)}` : '';
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

function runSeconds(r) {
  if (!r.startedAt) return null;
  const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
  const s = (end - Date.parse(r.startedAt)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}
function fmtSeconds(s) {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function money(n) { return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }

function render() {
  document.title = `${run.workflowTitle} — Orderly Claude`;
  document.getElementById('crumbTitle').textContent = run.workflowTitle;
  document.getElementById('runTitle').textContent   = run.workflowTitle;
  document.getElementById('runCatPip').className    = `pip ${run.category || ''}`;
  document.getElementById('backToWf').href = `/workflow-editor.html?from=${encodeURIComponent(run.workflowId)}${runRef()}`;
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

/*
 * How did it go? A finished run can be marked good or not good with a line
 * on why. The line can be kept as a lesson: next time, it is added to the
 * instructions of the step it is about.
 */
let retroDraft = null;
function renderRetro() {
  const mount = document.getElementById('retroPanel');
  const finished = ['done', 'failed', 'stopped'].includes(run.status);
  if (isPreview || !finished) { mount.innerHTML = ''; return; }
  if (!retroDraft || retroDraft.runId !== run.runId) {
    retroDraft = { runId: run.runId, rating: run.rating || null, note: run.retro || '', node: '', keep: run.rating === 'down', saved: !!run.rating };
  }
  const d = retroDraft;
  const steps = run.graph.nodes.filter((n) => n.kind === 'agent' || n.prompt || n.spec?.prompt);
  if (d.saved && !d.editing) {
    mount.innerHTML = `<div class="retro done">
      <span class="retro-mark ${d.rating}">${d.rating === 'up' ? 'Marked good' : 'Marked not good'}</span>
      ${d.note ? `<span class="retro-note">${esc(d.note)}</span>` : ''}
      <button class="link-btn" id="retroEdit">change</button>
      ${d.lessonSaved ? '<span class="retro-sub">Kept as a lesson for next time.</span>' : ''}
    </div>`;
    mount.querySelector('#retroEdit').onclick = () => { d.editing = true; renderRetro(); };
    return;
  }
  mount.innerHTML = `<div class="retro">
    <div class="retro-q">How did it go?</div>
    <div class="retro-choice" role="group" aria-label="Rate this run">
      <button class="run-btn ${d.rating === 'up' ? 'on' : ''}" data-rate="up" aria-pressed="${d.rating === 'up'}">Good</button>
      <button class="run-btn ${d.rating === 'down' ? 'on' : ''}" data-rate="down" aria-pressed="${d.rating === 'down'}">Not good</button>
    </div>
    ${d.rating ? `
      <label class="retro-label" for="retroNote">${d.rating === 'down' ? 'What went wrong?' : 'Anything worth repeating?'} <span class="hint">one line</span></label>
      <input class="retro-in" id="retroNote" maxlength="300" value="${esc(d.note)}" placeholder="${d.rating === 'down' ? 'The mockups ignored the brand colours.' : 'Asking for three directions worked well.'}">
      ${steps.length ? `<label class="retro-label" for="retroNode">About</label>
      <select class="retro-in" id="retroNode"><option value="">The whole workflow</option>${steps.map((n) => `<option value="${esc(n.id)}" ${d.node === n.id ? 'selected' : ''}>${esc(n.title || n.id)}</option>`).join('')}</select>` : ''}
      <label class="retro-check"><input type="checkbox" id="retroKeep" ${d.keep ? 'checked' : ''}> Add this to the step's instructions next time</label>
      <div class="need-actions"><button class="run-btn primary" id="retroSave">Save</button><span class="need-status" id="retroStatus"></span></div>` : ''}
  </div>`;
  mount.querySelectorAll('[data-rate]').forEach((b) => { b.onclick = () => { d.rating = b.dataset.rate; d.keep = d.rating === 'down'; renderRetro(); mount.querySelector('#retroNote')?.focus(); }; });
  const note = mount.querySelector('#retroNote');
  if (note) note.oninput = () => { d.note = note.value; };
  const nodeSel = mount.querySelector('#retroNode');
  if (nodeSel) nodeSel.onchange = () => { d.node = nodeSel.value; };
  const keep = mount.querySelector('#retroKeep');
  if (keep) keep.onchange = () => { d.keep = keep.checked; };
  const save = mount.querySelector('#retroSave');
  if (save) save.onclick = async () => {
    const status = mount.querySelector('#retroStatus');
    status.textContent = 'Saving…'; status.classList.remove('bad');
    const r = await post(`/api/runs/${encodeURIComponent(run.runId)}`, { rating: d.rating, retro: d.note.trim() }, 'PATCH');
    if (r.status >= 400) { status.textContent = r.error || 'Could not save.'; status.classList.add('bad'); return; }
    d.lessonSaved = false;
    if (d.keep && d.note.trim()) {
      const l = await post(`/api/workflows/${encodeURIComponent(run.workflowId)}/lessons`, {
        scope: run.scope || null, repo: run.scope === 'project' ? run.repoRoot : null,
        lesson: { node: d.node || null, note: d.note.trim(), rating: d.rating, pin: true, fromRun: run.runId },
      });
      if (l.status >= 400) {
        status.innerHTML = /builtin/.test(l.error || '')
          ? 'Saved the rating. Lessons go on your own workflows — <a href="/workflows.html#workflows">make a copy of this one</a> to keep them.'
          : esc(l.error || 'Saved the rating, but not the lesson.');
        status.classList.add('bad');
        d.saved = true; return;
      }
      d.lessonSaved = true;
    }
    d.saved = true; d.editing = false;
    renderRetro();
  };
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
  if (isPreview) {
    bar.innerHTML = `
      <a class="run-btn" href="/workflow-editor.html?from=${encodeURIComponent(run.workflowId)}${runRef()}"
         title="Open this workflow in the visual editor">✎ Edit</a>
      <button class="run-btn" data-act="run-preview"
              title="Fill in its inputs and run it">◆ Run</button>`;
    bar.querySelector('[data-act="run-preview"]').onclick = runFromPreview;
    return;
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
    ${!live ? `<a class="run-btn" href="/workflows.html?open=${encodeURIComponent(run.workflowId)}${runRef()}&again=${encodeURIComponent(run.runId)}#workflows" title="Run the workflow again with these inputs, editable first">↻ Again with changes</a>` : ''}
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

/**
 * Preview-mode Run: the workflow's own sheet, which collects every input
 * (including an Inputs step's fields) and reports problems inline, rather
 * than a browser prompt per field.
 */
function runFromPreview() {
  location.href = `/workflows.html?open=${encodeURIComponent(run.workflowId)}${runRef()}#workflows`;
}

// One repeat at a time: a second click while the first is starting would
// start a second copy of the run.
let repeating = false;
async function rerunFromCanvas(fromNodeId) {
  if (repeating) return;
  repeating = true;
  const buttons = [...document.querySelectorAll('[data-act="rerun"], [data-act="rerun-from"]')];
  const labels = buttons.map((b) => b.textContent);
  for (const b of buttons) { b.disabled = true; b.textContent = 'Starting…'; }
  const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/rerun`, { fromNodeId });
  // Only the part after # changes, which a browser does not reload for; the
  // hashchange listener below loads the new run.
  if (r.run?.runId) { location.href = `/workflows-run.html#${r.run.runId}`; return; }
  repeating = false;
  buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
  const why = r.error || 'Could not repeat it.';
  const el = document.getElementById('actStatus');
  if (el) { el.textContent = why; el.classList.add('bad'); }
}

// The page reads its run from the address once, when it loads. A new run
// id after # (a repeat, or back and forward) means a different run: load it.
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
    if (e.target.closest('.pv-img')) return;
    const redo = e.target.closest('[data-redo]');
    if (redo) { openRedo(n, redo.dataset.redo); return; }
    const later = e.target.closest('[data-rerun-from]');
    if (later) { redoStep(later.dataset.rerunFrom, 'onward', later); return; }
    const turn = e.target.closest('[data-pv]');
    if (turn) { turnPictures(n, Number(turn.dataset.pv)); return; }
    if (e.target.closest('.pv-pager')) return;
    // Something to review opens in the preview window; the step's details
    // are one click away from there.
    if (previewOf(n)) { selectNode(n.id, { drawer: false }); openPreview(n); return; }
    selectNode(n.id);
  };
  parent.append(card);
  return card;
}

/**
 * The right-side bit on the card footer. When a handler called the CLI it
 * returns `meta` with model, cost, elapsed, tokens; prefer that over the
 * how long the step took for local kinds (terminal, ask).
 */
function cardFootMeta(n, meta) {
  const bits = [];
  if (typeof meta.cost === 'number') {
    bits.push(meta.cost < 0.01 ? `$${meta.cost.toFixed(4)}` : `$${meta.cost.toFixed(3)}`);
  }
  if (meta.elapsed) bits.push(esc(String(meta.elapsed)));
  if (typeof meta.tokens === 'number' && meta.tokens > 0) bits.push(`${meta.tokens} tok`);
  if (bits.length) return bits.join(' · ');
  // Wall-clock time for steps that did not call a model.
  if (n.startedAt && n.endedAt) {
    const s = (Date.parse(n.endedAt) - Date.parse(n.startedAt)) / 1000;
    if (Number.isFinite(s) && s >= 0) return fmtSeconds(s);
  }
  return '';
}

/** A Run a workflow step: the run it started, followed live, with a way in. */
function workflowCard(n) {
  const c = n.output.child;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const line = n.waitsFor === 'child'
    ? `<div class="ask-q">Waiting for you in ${esc(c.title)}: ${esc(c.waiting?.[0] || 'a question')}</div>`
    : n.status === 'failed' ? `<div class="fail-note"><span class="fail-tag">failed</span>${esc(n.output.error || '')}</div>`
    : `<div class="doc-b">${esc(`${c.done} of ${c.total} steps${c.current && n.status === 'running' ? ` · ${c.current}` : ''}`)}</div>`;
  return `<div class="doc-h">${esc(c.title)}</div>${line}
    <div class="sub-bar"><i style="width:${pct}%"></i></div>
    <a class="sub-open" href="/workflows-run.html#${encodeURIComponent(c.runId)}">${n.waitsFor === 'child' ? 'Answer it there ↗' : 'Open its run ↗'}</a>`;
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
  if (n.kind === 'workflow' && n.output?.child) return workflowCard(n);
  if (n.status === 'pending') return `<div class="wait-note">Not started</div>`;
  // A command step that is drawing pictures shows each one as it lands.
  if (n.status === 'running' && hasPreview(n)) return previewHtml(n);
  if (n.status === 'running' && !selfProgress) {
    return `<div class="running-note"><span class="dot-pulse"></span>${esc(n.progress || 'Making…')}</div>${lastLine(n)}`;
  }
  if (n.status === 'failed') {
    const msg = n.output?.error || 'Handler threw. Open the run.json for the full trace.';
    // A step that failed its checks keeps what it made; show that under the reason.
    return `<div class="fail-note"><span class="fail-tag">failed</span>${esc(msg)}</div>${hasPreview(n) ? previewHtml(n) : ''}`;
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
  if (n.kind === 'publish' && o.path) {
    return `<div class="saved-row"><span class="check-pill ok">saved</span><span class="saved-name" title="${esc(o.path)}">${esc(o.path.split('/').pop())}</span></div>`;
  }
  if (hasPreview(n)) return previewHtml(n);
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
    case 'mockup': {
      // The page itself, shrunk, in a sandbox with no access to this one.
      // Only once the run has stopped changing: every update redraws the
      // cards, and a live page would reload each time.
      const settled = !['running'].includes(run.status);
      const preview = o.html && settled
        ? `<div class="mock-live"><iframe sandbox="allow-scripts" loading="lazy" tabindex="-1" title="${esc(o.name || 'page')}" srcdoc="${esc(o.html)}"></iframe></div>`
        : '<div class="mock-ph"><div class="mini"><div class="bar a"></div><div class="bar b"></div><div class="bar c"></div></div></div>';
      return `${preview}
        <div class="doc-h" style="margin-top:2px;">${esc(o.name || 'mockup.html')}</div>
        <div class="doc-b">${esc(o.note || '')}</div>`;
    }
    case 'json': {
      // Data: name the list it holds and its first entries, not just a file name.
      const d = o.data;
      const list = Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.values(d).find(Array.isArray) : null);
      const listKey = d && !Array.isArray(d) && typeof d === 'object' ? Object.keys(d).find((k) => Array.isArray(d[k])) : null;
      if (list) {
        const label = (x) => (x && typeof x === 'object') ? (x.name ?? x.title ?? x.id ?? Object.values(x)[0]) : x;
        const rows = list.slice(0, 5).map((x) => `<div class="doc-b json-row">${esc(String(label(x) ?? '').slice(0, 60))}</div>`).join('');
        return `<div class="doc-h">${list.length} ${esc(listKey || 'items')}</div>${rows}${list.length > 5 ? `<div class="doc-b">+${list.length - 5} more</div>` : ''}`;
      }
      const text = typeof d === 'string' ? d : JSON.stringify(d, null, 2);
      return `<div class="doc-h">${esc(o.title || 'Data')}</div><pre class="json-pre">${esc(String(text).split('\n').slice(0, 8).join('\n'))}</pre>`;
    }
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
          : p.status === 'failed'  ? (p.error ? 'not counted' : 'failed')
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
          <span class="route-state" ${p.error ? `title="${esc(p.error)}"` : ''}>${label}</span>
          <div class="pair-mini${!hasBaseline && after ? ' solo' : ''}">${content}</div>
          ${p.error ? `<span class="route-why">${esc(p.error)}</span>` : ''}
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
      return `${shownStrip(o.images)}<div class="term"><div class="term-prompt">${prompt}</div><div class="term-out">${lines}</div>${status}</div>`;
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
      // A file write: name the file, then where it went and how big it is.
      if (o.path) {
        const name = o.path.split('/').pop();
        const folder = o.path.slice(0, -name.length) || './';
        const size = o.bytes == null ? '' : o.bytes < 1024 ? `${o.bytes} B` : `${(o.bytes / 1024).toFixed(1)} KB`;
        return `<div class="doc-h">${esc(name)}</div><div class="doc-b">${esc(folder)}${size ? ` · ${size}` : ''}</div>`;
      }
      return `<div class="doc-h">${esc(o.target || 'publish')}</div><div class="doc-b">${esc(o.note || o.reason || '')}</div>`;
    }
    case 'approve': {
      if (o.approved) return `<div class="doc-h">Approved</div><div class="doc-b">${esc(o.question || '')}</div>`;
      if (o.question) return `<div class="doc-h">Waiting for you</div><div class="doc-b">${esc(o.question)}</div>`;
      return '<div class="doc-b">Not reached yet</div>';
    }
    default: return `<div class="doc-b">${n.status === 'done' ? 'Done' : 'Not reached yet'}</div>`;
  }
}

/* ---- Step previews: pages as little book pages, pictures shown large ---- */

/** Pages a step wrote: a list whose entries each carry a passage of text. */
function pagesOf(n) {
  const d = n.output?.data;
  const list = Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.values(d).find((v) => Array.isArray(v) && v.length > 1 && v.every((x) => x && typeof x === 'object')) : null);
  if (!list) return null;
  const key = ['text', 'body', 'content'].find((k) => list.every((x) => typeof x[k] === 'string'));
  if (!key) return null;
  return list.map((x, i) => ({ n: x.page ?? x.number ?? i + 1, text: x[key], note: x.scene || '' }));
}
function hasPreview(n) {
  if (n.status === 'running') return !!n.output?.images?.length;
  if (n.status !== 'done' && n.status !== 'failed') return false;
  return !!(pagesOf(n) || n.output?.images?.length);
}

/** The last line a running command printed, if it printed anything yet. */
function lastLine(n) {
  const line = String(n.output?.out || '').trim().split('\n').pop();
  return line ? `<div class="live-line" title="${esc(line)}">${esc(line)}</div>` : '';
}

// Pictures shown on a card at once, and which one each card starts at. The
// cards are rebuilt on every update, so where each one was turned to is kept
// here, by step id.
const PICS_PER_PAGE = 6;
const picsFrom = {};
// How many pictures each card had when last drawn, so a card left on its
// last page while pictures arrive moves on to show the new ones.
const picsSeen = {};

function previewHtml(n) {
  const pages = pagesOf(n);
  const title = n.output?.data?.title;
  const imgs = n.output?.images || [];
  const label = (m) => esc(String(m.name || '').split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
  let html = '';
  if (pages) {
    const head = `<div class="pv-head"><span class="pv-title">${esc(title || 'Pages')}</span><span class="pv-count">${pages.length} pages</span></div>`;
    const tiles = pages.map((p) => `<div class="pv-page" title="${esc(p.text)}"><div class="pv-text">${esc(p.text)}</div><span class="pv-n">${esc(String(p.n))}</span></div>`).join('');
    html += `${head}<div class="pv-pages">${tiles}</div>`;
  }
  if (imgs.length) {
    const lastPage = (count) => Math.floor(Math.max(0, count - 1) / PICS_PER_PAGE) * PICS_PER_PAGE;
    const live = n.status === 'running';
    // While pictures arrive, follow them onto a new page unless the person
    // turned back to an earlier one.
    if (live && (picsFrom[n.id] === undefined || picsFrom[n.id] >= lastPage(picsSeen[n.id] || 0))) picsFrom[n.id] = lastPage(imgs.length);
    picsSeen[n.id] = imgs.length;
    const from = Math.min(picsFrom[n.id] || 0, lastPage(imgs.length));
    const shown = imgs.slice(from, from + PICS_PER_PAGE);
    const count = imgs.length > PICS_PER_PAGE
      ? `<span class="pv-pager"><button type="button" data-pv="-1" title="Earlier pictures"${from === 0 ? ' disabled' : ''}>‹</button>`
        + `<span class="pv-count">${from + 1}–${from + shown.length} of ${imgs.length}</span>`
        + `<button type="button" data-pv="1" title="Later pictures"${from + PICS_PER_PAGE >= imgs.length ? ' disabled' : ''}>›</button></span>`
      : '';
    const head = live
      ? `<span class="running-note"><span class="dot-pulse"></span>drawing… ${imgs.length} so far</span>`
      : `<span class="pv-title">${imgs.length} ${imgs.length === 1 ? 'picture' : 'pictures'}</span>`;
    html += `<div class="pv-head${pages ? ' pv-gap' : ''}">${head}${count}</div>${live ? lastLine(n) : ''}`;
    html += `<div class="pv-imgs">${shown.map((m) => `<div class="pv-tile"><a class="pv-img" href="${blobUrl(m.ref)}" target="_blank" title="Open full size">${m.kind === 'video'
      ? `<video src="${blobUrl(m.ref)}" muted loop autoplay playsinline></video>`
      : `<img src="${blobUrl(m.ref)}" alt="${label(m)}" loading="lazy">`}<span class="pv-cap">${label(m)}</span></a>${redoMark(n, m)}</div>`).join('')}</div>`;
    html += staleNote(n);
  }
  return html;
}

/** Turn a card's pictures one page on (1) or back (-1), in place. */
function turnPictures(n, by) {
  const total = n.output?.images?.length || 0;
  const last = Math.floor(Math.max(0, total - 1) / PICS_PER_PAGE) * PICS_PER_PAGE;
  picsFrom[n.id] = Math.max(0, Math.min(last, (picsFrom[n.id] || 0) + by * PICS_PER_PAGE));
  const card = cards[n.id];
  if (!card) return;
  card.querySelector('.c-body').innerHTML = cardBody(n);
  // The last page may hold fewer pictures, so the card can change height.
  stackCards();
}

/* ---- Draw one picture again, from its prompt edited by hand ---- */

function canRedo(n) { return (meta.redoSteps || []).includes(n.id); }
function redoState(nodeId, name) { return (meta.redos || []).find((r) => r.nodeId === nodeId && r.name === name); }

/** On a picture: the Redo button, or how its redraw is going. */
function redoMark(n, m) {
  if (m.kind !== 'image' || !canRedo(n) || n.status === 'running') return '';
  const st = redoState(n.id, m.name);
  if (st?.status === 'drawing') return '<span class="pv-redoing"><span class="dot-pulse"></span>drawing again…</span>';
  const failed = st?.status === 'failed';
  return `<button type="button" class="pv-redo${failed ? ' bad' : ''}" data-redo="${esc(m.name)}" title="${failed ? esc(st.error) : 'Edit its prompt and draw this picture again'}">${failed ? 'Redo failed · try again' : 'Redo'}</button>`;
}

/**
 * A step redone, or a picture drawn again, after later steps had used it
 * leaves those steps out of date. Name the first, and offer to redo from it.
 */
function staleNote(n) {
  const drawn = Object.values(n.output?.redone || {}).sort().pop() || '';
  const ended = n.status === 'done' ? n.endedAt || '' : '';
  const last = drawn > ended ? drawn : ended;
  if (!last) return '';
  const after = new Set();
  const queue = [n.id];
  while (queue.length) {
    const id = queue.shift();
    for (const [a, b] of run.graph.edges || []) if (a === id && !after.has(b)) { after.add(b); queue.push(b); }
  }
  const stale = run.graph.nodes.find((x) => after.has(x.id) && x.status === 'done' && x.endedAt && x.endedAt < last);
  if (!stale) return '';
  return `<div class="pv-stale">${last === drawn ? 'Drawn again' : 'Redone'} after “${esc(stale.title || stale.id)}” ran, so it and later steps are out of date.${!meta.ownedElsewhere
    ? ` <button type="button" class="run-btn" data-rerun-from="${esc(stale.id)}">Redo from there</button>` : ''}</div>`;
}

let redoOpen = null;   // { nodeId, name, ref, drawing } while the dialog is open

function redoDialog() {
  let d = document.getElementById('redoDlg');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'redoDlg';
  d.className = 'redo-dlg';
  d.innerHTML = `
    <div class="redo-head">
      <div><div class="dr-kind">Draw one picture again</div><h3 class="dr-title" id="redoName"></h3></div>
      <button type="button" class="x" id="redoClose" title="Close">×</button>
    </div>
    <div class="redo-main">
      <a class="redo-pic" id="redoPicLink" target="_blank" title="Open full size"><img id="redoImg" alt=""></a>
      <label class="redo-edit"><span class="dr-h">Prompt</span><textarea id="redoText" spellcheck="true"></textarea></label>
    </div>
    <div class="redo-foot">
      <span class="redo-note" id="redoNote"></span>
      <button type="button" class="run-btn" id="redoCancel">Close</button>
      <button type="button" class="run-btn go" id="redoGo">Draw again</button>
    </div>`;
  document.body.append(d);
  const close = () => { redoOpen = null; d.close(); };
  d.querySelector('#redoClose').onclick = close;
  d.querySelector('#redoCancel').onclick = close;
  d.addEventListener('close', () => { redoOpen = null; });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.querySelector('#redoGo').onclick = startRedo;
  return d;
}

async function openRedo(n, name) {
  const m = (n.output?.images || []).find((x) => x.name === name);
  if (!m) return;
  const d = redoDialog();
  redoOpen = { nodeId: n.id, name, ref: m.ref, drawing: redoState(n.id, name)?.status === 'drawing' };
  d.querySelector('#redoName').textContent = name.split('/').pop();
  showRedoPicture(m.ref);
  const text = d.querySelector('#redoText');
  text.value = '';
  text.placeholder = 'Loading the prompt that drew it…';
  setRedoNote('');
  syncRedo();
  if (!d.open) d.showModal();
  text.focus();
  const r = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/nodes/${encodeURIComponent(n.id)}/redo?name=${encodeURIComponent(name)}`)
    .then((x) => x.json()).catch(() => ({ error: 'Could not reach Orderly' }));
  if (redoOpen?.name !== name) return;
  if (r.error) { setRedoNote(r.error, true); return; }
  text.value = r.prompt || '';
  text.setSelectionRange(0, 0);
  text.scrollTop = 0;
  text.placeholder = r.prompt ? '' : 'No prompt was kept beside this picture. Write the one to draw it from.';
}

function showRedoPicture(ref) {
  const d = redoDialog();
  d.querySelector('#redoImg').src = blobUrl(ref);
  d.querySelector('#redoPicLink').href = blobUrl(ref);
}

function setRedoNote(text, bad = false) {
  const el = redoDialog().querySelector('#redoNote');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

/** Lock the dialog while its picture is being drawn. */
function syncRedo() {
  const d = redoDialog();
  const busy = !!redoOpen?.drawing;
  d.querySelector('#redoText').disabled = busy;
  d.querySelector('#redoGo').disabled = busy;
  d.querySelector('#redoGo').textContent = busy ? 'Drawing…' : 'Draw again';
  if (busy) setRedoNote('Drawing it again. This can take a few minutes; you can close this and watch the card.');
}

async function startRedo() {
  if (!redoOpen || redoOpen.drawing) return;
  const prompt = redoDialog().querySelector('#redoText').value;
  if (!prompt.trim()) { setRedoNote('Write a prompt first.', true); return; }
  redoOpen.drawing = true;
  syncRedo();
  const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/nodes/${encodeURIComponent(redoOpen.nodeId)}/redo`, { name: redoOpen.name, prompt });
  if (r.error && redoOpen) { redoOpen.drawing = false; syncRedo(); setRedoNote(r.error, true); }
}

/** After each update: show the new picture, or why it failed, in the open dialog. */
function refreshRedo() {
  if (!redoOpen) return;
  const n = run.graph.nodes.find((x) => x.id === redoOpen.nodeId);
  const m = n?.output?.images?.find((x) => x.name === redoOpen.name);
  const st = redoState(redoOpen.nodeId, redoOpen.name);
  if (st?.status === 'drawing') { redoOpen.drawing = true; syncRedo(); return; }
  if (!redoOpen.drawing) return;
  redoOpen.drawing = false;
  syncRedo();
  if (st?.status === 'failed') { setRedoNote(st.error, true); return; }
  if (m && m.ref !== redoOpen.ref) {
    redoOpen.ref = m.ref;
    showRedoPicture(m.ref);
    setRedoNote('Drawn again. Edit the prompt and draw again if it still needs work.');
  }
}

/** What a step made and asked to show — pictures, and clips that play. */
function shownStrip(images) {
  if (!images?.length) return '';
  const tiles = images.slice(0, 4).map((m) => m.kind === 'video'
    ? `<video class="shown" src="${blobUrl(m.ref)}" muted loop autoplay playsinline title="${esc(m.name)}"></video>`
    : `<a class="shown" href="${blobUrl(m.ref)}" target="_blank" style="background-image:url('${blobUrl(m.ref)}')" title="${esc(m.name)}"></a>`).join('');
  const more = images.length > 4 ? `<span class="shown-more">+${images.length - 4}</span>` : '';
  return `<div class="shown-strip">${tiles}${more}</div>`;
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

/* ---- The preview window: what a step made, big enough to review ---- */

/**
 * What a step made that is worth looking at full size: a web page (a mockup,
 * or an .html file it saved), pictures, or pages of writing. Null if nothing.
 */
function previewOf(n) {
  if (isPreview || n.status !== 'done') return null;
  const o = n.output || {};
  if (typeof o.html === 'string' && o.html.trim()) return { kind: 'page', name: o.name || `${n.id}.html` };
  if (typeof o.path === 'string' && /\.html?$/i.test(o.path)) return { kind: 'page', name: o.path };
  if (o.images?.length) return { kind: 'pictures', name: `${o.images.length} ${o.images.length === 1 ? 'picture' : 'pictures'}` };
  if (pagesOf(n)) return { kind: 'pages', name: o.data?.title || 'Pages' };
  return null;
}

const pageUrl = (n) => `/api/runs/${encodeURIComponent(run.runId)}/nodes/${encodeURIComponent(n.id)}/page`;

function previewDialog() {
  let d = document.getElementById('pvwDlg');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'pvwDlg';
  d.className = 'pvw-dlg';
  d.innerHTML = `
    <div class="pvw-head">
      <div class="pvw-name"><div class="dr-kind" id="pvwKind"></div><h3 class="dr-title" id="pvwTitle"></h3><div class="pvw-file" id="pvwFile"></div></div>
      <div class="pvw-tools">
        <div class="pvw-sizes" id="pvwSizes" role="group" aria-label="Preview width">
          <button type="button" data-w="" class="on">Desktop</button><button type="button" data-w="820">Tablet</button><button type="button" data-w="390">Phone</button>
        </div>
        <a class="run-btn" id="pvwOpen" target="_blank" rel="noopener">Open in new tab ↗</a>
        <button type="button" class="run-btn" id="pvwDetails">Step details</button>
        <button type="button" class="x" id="pvwClose" title="Close (Esc)" aria-label="Close">×</button>
      </div>
    </div>
    <div class="pvw-body" id="pvwBody"></div>`;
  document.body.append(d);
  d.querySelector('#pvwClose').onclick = () => d.close();
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.querySelector('#pvwSizes').onclick = (e) => {
    const b = e.target.closest('button[data-w]');
    if (!b) return;
    for (const x of d.querySelectorAll('#pvwSizes button')) x.classList.toggle('on', x === b);
    const frame = d.querySelector('.pvw-frame');
    if (frame) frame.style.width = b.dataset.w ? `${b.dataset.w}px` : '100%';
  };
  return d;
}

function openPreview(n) {
  const pv = previewOf(n);
  if (!pv) return;
  const d = previewDialog();
  const o = n.output || {};
  d.querySelector('#pvwKind').textContent = `${KIND_LABEL[n.kind] || n.kind} · ${{ page: 'web page', pictures: 'pictures', pages: 'pages' }[pv.kind]}`;
  d.querySelector('#pvwTitle').textContent = n.title || n.id;
  d.querySelector('#pvwFile').textContent = pv.name;
  d.querySelector('#pvwSizes').hidden = pv.kind !== 'page';
  for (const x of d.querySelectorAll('#pvwSizes button')) x.classList.toggle('on', !x.dataset.w);
  const open = d.querySelector('#pvwOpen');
  open.hidden = pv.kind !== 'page';
  open.href = pv.kind === 'page' ? pageUrl(n) : '#';
  d.querySelector('#pvwDetails').onclick = () => { d.close(); selectNode(n.id); };
  const body = d.querySelector('#pvwBody');
  if (pv.kind === 'page') {
    // Sandboxed: the page can run its own scripts but cannot reach Orderly.
    body.innerHTML = `<div class="pvw-stage"><iframe class="pvw-frame" sandbox="allow-scripts" title="${esc(pv.name)}" src="${pageUrl(n)}"></iframe></div>`;
  } else if (pv.kind === 'pictures') {
    body.innerHTML = `<div class="pvw-pics">${o.images.map((m) => m.kind === 'video'
      ? `<figure><video src="${blobUrl(m.ref)}" controls muted loop autoplay playsinline></video><figcaption>${esc(m.name)}</figcaption></figure>`
      : `<figure><a href="${blobUrl(m.ref)}" target="_blank" title="Open full size"><img src="${blobUrl(m.ref)}" alt="${esc(m.name)}"></a><figcaption>${esc(m.name)}</figcaption></figure>`).join('')}</div>`;
  } else {
    body.innerHTML = `<div class="pvw-pages">${pagesOf(n).map((p) => `<article><span class="pvw-n">${esc(String(p.n))}</span><p>${esc(p.text)}</p>${p.note ? `<div class="pvw-note">${esc(p.note)}</div>` : ''}</article>`).join('')}</div>`;
  }
  if (!d.open) d.showModal();
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
    ${sec('What it made', o.images?.length ? `<div class="dr-shown">${o.images.map((m) => m.kind === 'video'
      ? `<figure><video src="${blobUrl(m.ref)}" controls muted loop autoplay playsinline></video><figcaption>${esc(m.name)}</figcaption></figure>`
      : `<figure><a href="${blobUrl(m.ref)}" target="_blank"><img src="${blobUrl(m.ref)}" alt="${esc(m.name)}"></a><figcaption>${esc(m.name)}</figcaption>${redoMark(n, m)}</figure>`).join('')}</div>${staleNote(n)}` : '')}
    ${sec('What it produced', made)}
    ${previewOf(n) ? `<button class="run-btn go" id="drPreview">Open preview</button>` : ''}
    ${o.images?.length ? '' : staleNote(n)}
    ${redoable(n) ? `<div class="dr-sec dr-redo"><div class="dr-h">Run it again, in this run</div>
      <div class="dr-redo-row">
        <button class="run-btn" data-redo-step="alone" title="Later steps that finished keep what they made">↻ Redo this step</button>
        <button class="run-btn" data-redo-step="onward" title="Every step after this one runs again too">↻ Redo from here</button>
      </div>
      <div class="dr-redo-why">${esc(redoWhy(n))}</div>
      <span class="need-status" id="drRedoStatus"></span></div>` : ''}`;
  body.querySelector('#drPreview')?.addEventListener('click', () => openPreview(n));
  for (const b of body.querySelectorAll('[data-redo-step]')) b.onclick = () => redoStep(n.id, b.dataset.redoStep, b);
  for (const b of body.querySelectorAll('[data-redo]')) b.onclick = () => openRedo(n, b.dataset.redo);
  for (const b of body.querySelectorAll('[data-rerun-from]')) b.onclick = () => redoStep(b.dataset.rerunFrom, 'onward', b);
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('on');
  if (keepScroll) drawer.scrollTop = scroll;
}

/** A finished step that ran before an earlier step was last redone or redrawn. */
function outOfDate(n) {
  if (n.status !== 'done' || !n.endedAt) return false;
  const before = new Set();
  const stack = [n.id];
  while (stack.length) {
    const id = stack.pop();
    for (const [a, b] of run.graph.edges || []) if (b === id && !before.has(a)) { before.add(a); stack.push(a); }
  }
  return run.graph.nodes.some((x) => before.has(x.id) && x.status === 'done'
    && [x.endedAt, ...Object.values(x.output?.redone || {})].some((t) => t && t > n.endedAt));
}

/** A step that has run, or is running, in a run this window may change. */
function redoable(n) {
  return !meta.ownedElsewhere && !['pending', 'skipped'].includes(n.status);
}

function redoWhy(n) {
  const later = new Set();
  const queue = [n.id];
  while (queue.length) {
    const id = queue.shift();
    for (const [a, b] of run.graph.edges || []) if (a === id && !later.has(b)) { later.add(b); queue.push(b); }
  }
  const done = run.graph.nodes.filter((x) => later.has(x.id) && x.status === 'done').length;
  const what = n.status === 'running' ? 'stops it and starts it again' : 'runs it again';
  if (!later.size) return `Either one ${what}; nothing comes after it.`;
  return `“Redo this step” ${what}${done ? ` and keeps the ${done} later step${done === 1 ? '' : 's'} that finished` : ''}. “Redo from here” also runs the ${later.size} step${later.size === 1 ? '' : 's'} after it again.`;
}

let redoing = false;
async function redoStep(nodeId, mode, button) {
  if (redoing) return;
  redoing = true;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  const r = await post(`/api/runs/${encodeURIComponent(run.runId)}/redo-step`, { nodeId, mode });
  redoing = false;
  if (button) { button.disabled = false; button.textContent = label; }
  if (r.redone) { load(); return; }
  const why = r.needsChoice
    ? `“${r.needsChoice[0].title}” was cut short and is not safe to repeat. Use Resume first and say whether it finished.`
    : r.error || 'Could not redo it.';
  const el = document.getElementById('drRedoStatus') || document.getElementById('actStatus');
  if (el) { el.textContent = why; el.classList.add('bad'); }
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

if (runId || isPreview) load();
