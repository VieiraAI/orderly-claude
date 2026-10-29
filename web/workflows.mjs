/*
 * Catalog + Runs tabs for the workflows surface. One client, two views —
 * swapped on hash change. Catalog fetches /api/workflows, groups by scope,
 * renders tiles. Clicking a tile opens the brief sheet with the workflow's
 * inputs; the Run button posts to /api/workflows/:id/run and sends the user
 * to the canvas page for the new run id.
 */

const scopeTitles = {
  project: 'This project',
  user:    'Your global library',
  builtin: 'Built-in',
};
const CAT_LABEL = { design: 'Design', review: 'Review', ship: 'Ship', plan: 'Plan',
  build: 'Build', content: 'Content', io: 'I/O' };

const state = { workflows: [], runs: [], skills: [], prompts: [], decisions: [],
  open: null, openPrompt: null, liveSessionId: null,
  decisionScope: 'all',    // 'all' or 'session'
  catalogCategory: 'all',  // filter chip for the Workflows tab
};

async function loadCatalog() {
  const r = await fetch('/api/workflows').then((x) => x.json());
  state.workflows = r.workflows || [];
  renderTiles();
}

/*
 * The Runs tab is the control panel: what is running, what is waiting on
 * you, what broke and where, what was cut short, what is scheduled, and what
 * it has all cost. Filters change the list, never the counts above it.
 */
const runsView = { status: '', workflow: '', since: 'week', armed: new Set(), choice: {}, scheduleFormFor: null, msgs: {} };

async function loadRuns() {
  const q = new URLSearchParams();
  if (runsView.status) q.set('status', runsView.status);
  if (runsView.workflow) q.set('workflow', runsView.workflow);
  const since = { today: startOfDay(0), week: startOfDay(6) }[runsView.since];
  if (since) q.set('since', new Date(since).toISOString());
  const [r, sc] = await Promise.all([
    fetch(`/api/runs?${q}`).then((x) => x.json()),
    fetch('/api/schedules').then((x) => x.json()).catch(() => ({ schedules: [] })),
  ]);
  state.runs = r.runs || [];
  state.runCounts = r.counts || {};
  state.runSpend = r.spend || {};
  state.runTotal = r.total || 0;
  state.waiting = r.waiting || [];
  state.cutShort = r.cutShort || [];
  state.schedules = sc;
  if (!state.workflows.length) await loadCatalog();
  renderRuns();
}

function startOfDay(daysAgo) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * 86_400_000;
}

// Live: any change to any run refreshes the panel, at most a few times a second.
let runsRefresh = null;
function refreshRunsSoon() {
  if (document.getElementById('viewRuns').style.display === 'none') return;
  // Don't redraw under someone typing an answer or a schedule.
  if (document.activeElement?.closest?.('#runsBody') && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  clearTimeout(runsRefresh);
  runsRefresh = setTimeout(() => loadRuns().catch(() => {}), 300);
}
if (!new URLSearchParams(location.search).has('snapshot')) {
  const es = new EventSource('/events');
  for (const ev of ['update', 'run-start', 'run-finish', 'schedules']) es.addEventListener(ev, refreshRunsSoon);
}

function renderTiles() {
  renderCatalogChips();
  const cat = state.catalogCategory;
  for (const scope of ['project', 'user', 'builtin']) {
    const list = state.workflows.filter((w) =>
      w.scope === scope && (cat === 'all' || w.category === cat));
    const mount = document.getElementById('tiles' + scope[0].toUpperCase() + scope.slice(1));
    const meta  = document.getElementById('meta'    + scope[0].toUpperCase() + scope.slice(1));
    meta.textContent = list.length
      ? `${list.length} workflow${list.length === 1 ? '' : 's'}`
      : 'none here';
    if (!list.length) {
      mount.innerHTML = `<div class="empty" style="grid-column:1 / -1;background:var(--surface);">
        ${cat === 'all'
          ? `Nothing in <code>${scopeHint(scope)}</code> yet.`
          : `No <strong>${esc(cat)}</strong> workflows in <code>${scopeHint(scope)}</code>.`}
      </div>`;
      continue;
    }
    mount.innerHTML = list.map(tile).join('');
  }
  for (const el of document.querySelectorAll('.tile')) {
    el.onclick = () => openSheet(el.dataset.id);
  }
}

function renderCatalogChips() {
  let bar = document.getElementById('catalogChips');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'catalogChips';
    bar.className = 'chips-row';
    document.getElementById('viewCatalog').prepend(bar);
  }
  const cats = ['all', ...new Set(state.workflows.map((w) => w.category).filter(Boolean))];
  bar.innerHTML = cats.map((c) => {
    const label = c === 'all' ? 'All' : (CAT_LABEL[c] || c);
    return `<button class="chip ${c === state.catalogCategory ? 'on' : ''}" data-cat="${c}">${label}</button>`;
  }).join('') + `<span class="chips-count">${state.workflows.length} total</span>`;
  for (const c of bar.querySelectorAll('.chip')) {
    c.onclick = () => { state.catalogCategory = c.dataset.cat; renderTiles(); };
  }
}

function scopeHint(scope) {
  // Escaped: a bare <repo> is parsed as a tag and vanishes from the page.
  return scope === 'project' ? '&lt;repo&gt;/.claude/workflows/'
       : scope === 'user'    ? '~/.claude/workflows/'
       : 'src/core/workflow-defs/';
}

function tile(w) {
  const cat = CAT_LABEL[w.category] || 'Workflow';
  const badge = w.invalid ? '<span class="tile-flag bad">needs fixing</span>'
    : w.derivedFrom ? '<span class="tile-flag">yours</span>' : '';
  return `
    <div class="tile${w.invalid ? ' invalid' : ''}" data-id="${escapeHtml(w.id)}">
      <span class="cat-chip ${w.category || 'builtin'}">${cat}</span>${badge}
      <h3>${escapeHtml(w.title || w.id)}</h3>
      <p>${escapeHtml(w.desc || '')}</p>
      <div class="foot">
        <span>${w.graph?.nodes?.length ?? 0} steps · ${escapeHtml(w.estimate || '—')}</span>
        <span class="scope-tag">${w.scope === 'builtin' ? 'built-in' : w.scope === 'user' ? 'your library' : 'this project'}</span>
      </div>
    </div>`;
}

/** Inputs a run asks for: the workflow's own, plus any an Inputs step declares. */
function runInputs(w) {
  const seen = new Set();
  const out = [];
  for (const f of [...(w.inputs || []),
    ...(w.graph?.nodes || []).filter((n) => n.kind === 'inputs').flatMap((n) => (n.spec?.fields || []).map((x) => ({ ...x, textarea: x.type === 'textarea' })))]) {
    if (!f?.key || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

function openSheet(id, prefill = {}) {
  const w = state.workflows.find((x) => x.id === id);
  if (!w) return false;
  state.open = w;
  const $ = (x) => document.getElementById(x);
  $('shEyebrow').textContent = `${CAT_LABEL[w.category] || 'Workflow'} · ${w.scope === 'builtin' ? 'built-in' : w.scope === 'user' ? 'your library' : 'this project'}${w.version ? ` · v${w.version}` : ''}`;
  $('shTitle').textContent = w.title || w.id;
  $('shDesc').textContent  = w.desc || '';
  $('shEst').textContent   = w.estimate || '';
  const fields = runInputs(w);
  $('shInputs').innerHTML = fields.map((f) => inputField(f, prefill[f.key])).join('')
    || '<div style="color:var(--faint);font-size:13px;">Nothing to fill in — it works on the project it is run in.</div>';
  $('shPlan').innerHTML = (w.graph?.nodes || [])
    .map((n) => `<li style="padding:3px 0;">· <b style="color:var(--text);font-weight:500;">${escapeHtml(n.title)}</b> <span style="color:var(--faint);font-family:var(--f-mono);font-size:11px;">${escapeHtml(KIND_WORD[n.kind] || n.kind)}</span></li>`).join('');
  $('shProblems').innerHTML = w.invalid
    ? `<div class="sheet-problems"><b>This workflow needs fixing before it can run.</b><ul>${w.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>` : '';
  $('shRun').disabled = !!w.invalid;
  $('shRun').textContent = '◆ Run';
  $('shRun').onclick = runNow;
  const edit = $('shEdit');
  if (w.scope === 'builtin') {
    edit.textContent = 'Make it yours';
    edit.title = 'Copy it into your library, where you can change it';
    edit.onclick = makeItYours;
  } else {
    edit.textContent = 'Edit';
    edit.title = 'Open it in the editor';
    edit.onclick = () => { location.href = `/workflows-new.html?id=${encodeURIComponent(w.id)}`; };
  }
  $('shSchedule').onclick = () => { closeSheet(); location.hash = 'runs'; setTimeout(() => openScheduleForm(w.id), 60); };
  $('shSchedule').disabled = !!w.invalid;
  $('shExport').href = `/api/workflows/${encodeURIComponent(w.id)}/export`;
  $('shStatus').textContent = '';
  $('scrim').classList.add('on');
  $('sheet').setAttribute('aria-hidden', 'false');
  return true;
}

const KIND_WORD = {
  agent: 'Claude', script: 'command', decision: 'you choose', approve: 'you approve', check: 'check',
  loop: 'for each', publish: 'publish', display: 'show', delay: 'wait', inputs: 'inputs',
};

function inputField(f, value = '') {
  const v = escapeHtml(value ?? '');
  if (f.textarea) {
    return `<label>${escapeHtml(f.label || f.key)}<textarea data-key="${escapeHtml(f.key)}" placeholder="${escapeHtml(f.placeholder || '')}">${v}</textarea></label>`;
  }
  return `<label>${escapeHtml(f.label || f.key)}<input data-key="${escapeHtml(f.key)}" placeholder="${escapeHtml(f.placeholder || '')}" value="${v}"></label>`;
}

function closeSheet() {
  state.open = null;
  document.getElementById('scrim').classList.remove('on');
  document.getElementById('sheet').setAttribute('aria-hidden', 'true');
}
window.closeSheet = closeSheet;

async function makeItYours() {
  const w = state.open;
  const st = document.getElementById('shStatus');
  st.textContent = 'Copying…';
  const r = await fetch(`/api/workflows/${encodeURIComponent(w.id)}/duplicate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'user' }),
  }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.saved) { location.href = `/workflows-new.html?id=${encodeURIComponent(r.id)}`; return; }
  st.textContent = r.error || 'Could not copy it.';
}

async function runNow() {
  const w = state.open;
  if (!w) return;
  const btn = document.getElementById('shRun');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  const inputs = {};
  for (const el of document.querySelectorAll('#shInputs [data-key]')) {
    inputs[el.dataset.key] = el.value.trim();
  }
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(w.id)}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs }),
    }).then((x) => x.json());
    if (r.run?.runId) {
      location.href = `/workflows-run.html#${r.run.runId}`;
      return;
    }
    throw new Error(r.error || 'run did not start');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '◆ Run';
    document.getElementById('shStatus').textContent = `Could not start it: ${e.message}`;
  }
}

/** Import a workflow file someone shared. */
async function importWorkflow(file) {
  const note = document.getElementById('importNote');
  let def;
  try { def = JSON.parse(await file.text()); } catch { note.textContent = `${file.name} is not a workflow file.`; return; }
  const post = (d) => fetch('/api/workflows/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ def: d, scope: 'user' }),
  }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
  const done = (r) => { note.textContent = `Imported "${r.id}" into your library.`; loadCatalog(); };
  let r = await post(def);
  if (r.status === 409) {
    note.innerHTML = `${escapeHtml(r.error)}. <button class="link-btn" id="importAs">Import it as "${escapeHtml(r.suggestedId)}"</button>`;
    document.getElementById('importAs').onclick = async () => {
      const again = await post({ ...def, id: r.suggestedId });
      if (again.saved) done(again); else note.textContent = again.error || 'Import failed.';
    };
    return;
  }
  if (r.saved) done(r);
  else note.textContent = `${r.error || 'Import failed'}${r.problems ? `: ${r.problems.slice(0, 2).join('; ')}` : ''}`;
}

/* ------------------------------- Runs view ------------------------------ */

function money(n) {
  if (!n) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function until(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  const at = new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (s < 0) return `due now · ${at}`;
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min · ${at}`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h · ${at}`;
  return `in ${Math.round(s / 86400)} d · ${at}`;
}

function renderRuns() {
  const mount = document.getElementById('runsBody');
  const c = state.runCounts || {};
  const sp = state.runSpend || {};
  const stat = (n, label, cls, filter) => `<button class="stat ${cls} ${runsView.status === filter ? 'on' : ''}" data-filter="${filter}" ${n ? '' : 'data-zero="1"'}><span class="n">${n}</span><span class="l">${label}</span></button>`;
  // Questions come from every run, not just the filtered page, so one is never hidden.
  const allNeeds = state.waiting || [];
  const interrupted = state.cutShort || [];
  const parts = [];
  parts.push(`<div class="stat-row">
    ${stat(c.running || 0, 'running', 'running', 'running')}
    ${stat(c.needsYou || 0, 'need you', 'ask', 'needs-you')}
    ${stat(c.failed || 0, 'failed', 'failed', 'failed')}
    ${stat(c.interrupted || 0, 'cut short', 'interrupted', 'interrupted')}
    ${stat(c.doneToday || 0, 'done today', 'done', 'done')}
    <div class="stat spend"><span class="n">${money(sp.today || 0)}</span><span class="l">today · ${money(sp.week || 0)} this week</span></div>
  </div>`);

  if (allNeeds.length) {
    parts.push(`<section class="runs-sec"><h3 class="sec-h">Waiting for you</h3>${allNeeds.map(needCard).join('')}</section>`);
  }
  if (interrupted.length && !runsView.status) {
    parts.push(`<section class="runs-sec"><h3 class="sec-h">Cut short</h3>
      <p class="sec-note">These were running when Orderly closed. Nothing resumes on its own — pick up the ones you still want.</p>
      ${interrupted.map(interruptedCard).join('')}</section>`);
  }

  parts.push(schedulesSection());

  const wfOptions = [...new Map(state.workflows.map((w) => [w.id, w.title || w.id])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  parts.push(`<section class="runs-sec">
    <div class="list-head">
      <h3 class="sec-h">All runs</h3>
      <div class="chips-row tight">
        ${[['', 'All'], ['running', 'Running'], ['needs-you', 'Need you'], ['failed', 'Failed'], ['interrupted', 'Cut short'], ['done', 'Done'], ['stopped', 'Stopped']]
          .map(([v, l]) => `<button class="chip ${runsView.status === v ? 'on' : ''}" data-status="${v}">${l}</button>`).join('')}
        <select class="chip-select" id="runsWorkflow" aria-label="Workflow">
          <option value="">Every workflow</option>
          ${wfOptions.map(([id, t]) => `<option value="${escapeHtml(id)}" ${runsView.workflow === id ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
        <select class="chip-select" id="runsSince" aria-label="Period">
          ${[['today', 'Today'], ['week', 'Last 7 days'], ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${runsView.since === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="chips-count">${state.runs.length} shown of ${state.runTotal}</span>
        ${(c.running || c.needsYou) ? `<button class="chip stop-all" id="btnStopAll">■ Stop all running</button>` : ''}
      </div>
    </div>`);
  if (!state.runs.length) {
    parts.push(`<div class="empty">${state.runTotal ? 'Nothing matches these filters.' : 'No runs yet. Pick a workflow from the Workflows tab and press Run.'}</div>`);
  } else {
    const byDay = groupBy(state.runs, (r) => (r.startedAt || '').slice(0, 10));
    for (const [day, rows] of byDay) {
      parts.push(`<div class="day">${dayLabel(day)}</div>`);
      for (const r of rows) parts.push(runRow(r));
    }
  }
  parts.push('</section>');
  parts.push(limitsSection());
  mount.innerHTML = parts.join('');
  bindRuns(mount);
}

function dayLabel(day) {
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return day === today ? 'Today' : day === y ? 'Yesterday' : day;
}

function needCard(r) {
  const q = r.needsYou;
  const choices = q.choices?.length
    ? q.choices.map((ch) => `<button class="answer-btn ${/reject|no/i.test(ch) ? 'neg' : ''}" data-answer-run="${r.runId}" data-node="${escapeHtml(q.nodeId)}" data-answer="${escapeHtml(ch)}">${escapeHtml(ch)}</button>`).join('')
    : `<input class="answer-text" data-free-run="${r.runId}" data-node="${escapeHtml(q.nodeId)}" placeholder="Your answer"><button class="answer-btn" data-free-send="${r.runId}">Answer</button>`;
  return `<div class="need-card">
    <div class="need-top"><span class="pip-ask"></span><a class="need-wf" href="/workflows-run.html#${r.runId}">${escapeHtml(r.workflowTitle || r.workflowId)}</a>
      <span class="need-meta">${escapeHtml(q.title)} · started ${ago(r.startedAt)}${r.status === 'interrupted' ? ' · answering will resume it' : ''}</span></div>
    <div class="need-q">${escapeHtml(q.question)}</div>
    <div class="need-actions">${choices}${msg(`ns-${r.runId}`)}</div>
  </div>`;
}

function interruptedCard(r) {
  const at = r.interruption?.nodes?.length ? `during “${escapeHtml(r.interruption.nodes.join(', '))}”` : '';
  return `<div class="need-card cut">
    <div class="need-top"><span class="pip-cut"></span><a class="need-wf" href="/workflows-run.html#${r.runId}">${escapeHtml(r.workflowTitle || r.workflowId)}</a>
      <span class="need-meta">${r.doneNodes} of ${r.totalNodes} steps done · stopped ${ago(r.interruption?.at || r.endedAt)} ${at}</span></div>
    <div class="need-actions"><button class="answer-btn" data-resume="${r.runId}">Resume</button>${msg(`ns-${r.runId}`)}</div>
    <div class="choice-slot" id="cs-${r.runId}"></div>
  </div>`;
}

function stateLine(r) {
  if (r.needsYou) return { cls: 'ask', text: `waiting for you · ${r.needsYou.title}` };
  if (r.status === 'running') return { cls: 'running', text: r.runningLabel ? `running · ${r.runningLabel}` : `step ${r.doneNodes + 1} of ${r.totalNodes}` };
  if (r.status === 'done') return { cls: 'done', text: `done${r.skippedNodes ? ` · ${r.skippedNodes} skipped` : ''}` };
  if (r.status === 'interrupted') return { cls: 'cut', text: 'cut short — Orderly closed' };
  if (r.status === 'stopped') return { cls: 'stopped', text: 'stopped' };
  if (r.halt?.type === 'budget') return { cls: 'failed', text: `stopped at its ${money(r.halt.limitUsd)} limit` };
  if (r.failedNode) return { cls: 'failed', text: `failed at “${r.failedNode.title}”` };
  return { cls: 'failed', text: r.error ? `failed — ${r.error}` : 'failed' };
}

function trigger(r) {
  if (r.trigger === 'schedule') return 'on schedule';
  if (/^rerun of/.test(r.trigger || '')) return r.trigger;
  return 'by you';
}

function runRow(r) {
  const time = new Date(r.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const cat = r.category || 'builtin';
  const st = stateLine(r);
  const totals = [r.totalCost ? money(r.totalCost) : null, r.totalElapsed].filter(Boolean).join(' · ');
  const drift = r.definitionVersion && r.currentVersion && r.currentVersion !== r.definitionVersion
    ? `<span class="ver-badge" title="This run used version ${r.definitionVersion}. The workflow has been edited since; reruns repeat what this run ran.">v${r.definitionVersion} · now v${r.currentVersion}</span>` : '';
  const detail = r.halt?.message
    ? `<div class="row-detail">${escapeHtml(r.halt.message)} <span class="raise">Raise to $<input class="raise-in" data-raise="${r.runId}" inputmode="decimal" value="${(r.halt.limitUsd * 2).toFixed(2)}"> <button class="row-btn" data-raise-go="${r.runId}">and resume</button></span></div>`
    : r.failedNode?.error ? `<div class="row-detail">${escapeHtml(r.failedNode.error.slice(0, 220))}</div>` : '';
  const live = r.status === 'running' || r.needsYou;
  const del = runsView.armed.has(`del-${r.runId}`);
  return `<div class="run-row v2" data-id="${r.runId}">
    <span class="time">${time}</span>
    <div class="wf">
      <span class="pip ${live ? `${cat} running` : cat}"></span>
      <div style="min-width:0;">
        <div class="nm">${escapeHtml(r.workflowTitle || r.workflowId)} ${drift}</div>
        <div class="sess">${escapeHtml(trigger(r))}${r.sessionId ? ` · session ${r.sessionId.slice(0, 8)}` : ''}${r.repoRoot ? ` · ${escapeHtml(r.repoRoot.split('/').pop())}` : ''}</div>
      </div>
    </div>
    <span class="state ${st.cls}">${escapeHtml(st.text)}${totals ? `<span class="row-totals">${totals}</span>` : ''}</span>
    <span class="row-actions">
      ${r.resumable && !r.halt ? `<button class="row-btn" data-act="resume" data-id="${r.runId}" title="Carry on from where it stopped">▸ resume</button>` : ''}
      ${!live ? `<button class="row-btn" data-act="again" data-id="${r.runId}" title="Run this workflow again, with the same inputs filled in">↻ again</button>` : ''}
      ${!live ? `<button class="row-btn" data-act="rerun" data-id="${r.runId}" title="Repeat exactly what this run ran">⟲ repeat</button>` : ''}
      <button class="row-btn" data-act="share" data-id="${r.runId}" title="Signed link to a static copy">◎</button>
      ${!live ? `<button class="row-btn danger" data-act="delete" data-id="${r.runId}" title="Delete this run">${del ? 'click again' : '✕'}</button>` : ''}
    </span>
    ${detail}
    <div class="choice-slot" id="cs-${r.runId}"></div>
  </div>`;
}

function schedulesSection() {
  const sc = state.schedules || {};
  const list = sc.schedules || [];
  const form = runsView.scheduleFormFor !== null ? scheduleForm(runsView.scheduleFormFor) : '';
  return `<section class="runs-sec" id="schedSec">
    <div class="list-head"><h3 class="sec-h">Schedules</h3>
      ${runsView.scheduleFormFor === null ? '<button class="chip" id="btnNewSchedule">+ Schedule a workflow</button>' : ''}</div>
    <p class="sec-note">${escapeHtml(sc.note || '')}</p>
    ${form}
    ${list.length ? list.map(scheduleRow).join('') : (form ? '' : '<div class="empty slim">Nothing scheduled.</div>')}
  </section>`;
}

function scheduleRow(s) {
  const last = s.lastRun ? `<a href="/workflows-run.html#${s.lastRunId}">${escapeHtml(stateLine(s.lastRun).text)}</a>` : escapeHtml(s.lastStatus || 'not run yet');
  const del = runsView.armed.has(`sdel-${s.id}`);
  return `<div class="sched-row${s.enabled ? '' : ' paused'}">
    <div class="sched-main">
      <div class="nm">${escapeHtml(s.workflowTitle)}${s.workflowMissing ? ' <span class="ver-badge bad">workflow missing</span>' : ''}</div>
      <div class="sess">${escapeHtml(s.describe)} · up to ${money(s.budgetUsd)} a run</div>
    </div>
    <div class="sched-when">${s.enabled ? escapeHtml(until(s.nextDueAt)) : 'paused'}</div>
    <div class="sched-last">last: ${last}${s.missed ? `<div class="missed">${s.missed} missed while Orderly was closed <button class="link-btn" data-clear-missed="${s.id}">clear</button></div>` : ''}</div>
    <span class="row-actions">
      <button class="row-btn" data-sched-toggle="${s.id}" data-on="${s.enabled ? 1 : 0}">${s.enabled ? 'pause' : 'resume'}</button>
      <button class="row-btn danger" data-sched-del="${s.id}">${del ? 'click again' : '✕'}</button>
    </span>
  </div>`;
}

function scheduleForm(workflowId) {
  const runnable = state.workflows.filter((w) => !w.invalid);
  const w = runnable.find((x) => x.id === workflowId) || runnable[0];
  const fields = w ? runInputs(w) : [];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `<div class="sched-form" id="schedForm">
    <div class="sf-grid">
      <label>Workflow<select id="sfWorkflow">${runnable.map((x) => `<option value="${escapeHtml(x.id)}" ${x.id === w?.id ? 'selected' : ''}>${escapeHtml(x.title || x.id)}</option>`).join('')}</select></label>
      <label>Repeat<select id="sfEvery">
        <option value="day">Every day</option><option value="week">Every week</option>
        <option value="hours">Every few hours</option><option value="minutes">Every few minutes</option></select></label>
      <label class="sf-n hidden">Every<input id="sfN" type="number" min="1" value="1"></label>
      <label class="sf-day hidden">On<select id="sfDay">${days.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="sf-at">At<input id="sfAt" type="time" value="09:00"></label>
      <label>Stop a run at<span class="money-in">$<input id="sfBudget" inputmode="decimal" value="1.00"></span></label>
    </div>
    ${fields.length ? `<div class="inputs sf-inputs">${fields.map((f) => inputField(f)).join('')}</div>` : ''}
    <div class="sf-actions"><button class="btn-run sm" id="sfSave">Schedule it</button><button class="btn-ghost" id="sfCancel">Cancel</button>${msg('sfStatus')}</div>
  </div>`;
}

function limitsSection() {
  const st = state.schedules?.settings?.budget || {};
  return `<section class="runs-sec limits">
    <h3 class="sec-h">Spend limits</h3>
    <div class="limits-grid">
      <label>Stop a run I start once it has spent<span class="money-in">$<input id="limPerRun" inputmode="decimal" placeholder="no limit" value="${st.perRunUsd ?? ''}"></span></label>
      <label>All scheduled runs together, per day<span class="money-in">$<input id="limDaily" inputmode="decimal" value="${st.scheduledPerDayUsd ?? ''}"></span></label>
      <label>Steps at once, per run<select id="limConc">${[1, 2, 3, 4, 6, 8].map((n) => `<option ${n === (state.schedules?.settings?.concurrency || 4) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="row-btn" id="limSave">Save limits</button>${msg('limStatus')}
    </div>
    <p class="sec-note">A workflow can set its own limit in the editor. Scheduled runs spent ${money(state.schedules?.scheduledSpendToday || 0)} today.</p>
  </section>`;
}

/* ---- actions ---- */

async function post(url, body = {}, method = 'POST') {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, ...j };
}

/*
 * Status lines outlive a redraw. The panel refreshes itself whenever any run
 * changes, and without this a "Saved." vanished a moment after it appeared.
 */
function say(id, text, bad = false) {
  runsView.msgs[id] = { text, bad, at: Date.now() };
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.classList.toggle('bad', bad); }
}
function msg(id) {
  const m = runsView.msgs[id];
  if (!m || Date.now() - m.at > 6000) return `<span class="need-status" id="${id}"></span>`;
  return `<span class="need-status${m.bad ? ' bad' : ''}" id="${id}">${escapeHtml(m.text)}</span>`;
}

async function resume(runId, extra = {}) {
  say(`ns-${runId}`, 'Resuming…');
  const r = await post(`/api/runs/${runId}/resume`, extra);
  if (r.needsChoice) { showChoice(runId, r.needsChoice); say(`ns-${runId}`, ''); return; }
  if (r.resumed) { location.href = `/workflows-run.html#${runId}`; return; }
  say(`ns-${runId}`, r.error || 'Could not resume it.', true);
}

/** A step that is not safe to repeat was mid-way: ask, inline, what happened. */
function showChoice(runId, list) {
  const slot = document.getElementById(`cs-${runId}`);
  if (!slot) return;
  runsView.choice[runId] = {};
  slot.innerHTML = list.map((c) => `<div class="choice">
    <div><b>${escapeHtml(c.title)}</b> was running when it stopped${c.command ? ` (<code>${escapeHtml(c.command)}</code>)` : ''}, and is marked as not safe to repeat. Did it finish?</div>
    <div class="need-actions">
      <button class="answer-btn" data-choose="${runId}" data-node="${escapeHtml(c.nodeId)}" data-val="assume-done">It already happened — carry on after it</button>
      <button class="answer-btn neg" data-choose="${runId}" data-node="${escapeHtml(c.nodeId)}" data-val="repeat">Run it again</button>
    </div></div>`).join('');
  slot.querySelectorAll('[data-choose]').forEach((b) => {
    b.onclick = () => {
      runsView.choice[runId][b.dataset.node] = b.dataset.val;
      if (Object.keys(runsView.choice[runId]).length === list.length) resume(runId, { choices: runsView.choice[runId] });
      else b.closest('.choice').classList.add('chosen');
    };
  });
}

function armOrDo(key, btn, fn) {
  if (runsView.armed.has(key)) { runsView.armed.delete(key); fn(); return; }
  runsView.armed.add(key);
  btn.textContent = 'click again';
  setTimeout(() => { if (runsView.armed.delete(key)) renderRuns(); }, 3000);
}

function bindRuns(mount) {
  for (const b of mount.querySelectorAll('.stat[data-filter]')) {
    b.onclick = () => { runsView.status = runsView.status === b.dataset.filter ? '' : b.dataset.filter; loadRuns(); };
  }
  for (const b of mount.querySelectorAll('[data-status]')) b.onclick = () => { runsView.status = b.dataset.status; loadRuns(); };
  mount.querySelector('#runsWorkflow')?.addEventListener('change', (e) => { runsView.workflow = e.target.value; loadRuns(); });
  mount.querySelector('#runsSince')?.addEventListener('change', (e) => { runsView.since = e.target.value; loadRuns(); });

  for (const b of mount.querySelectorAll('[data-answer-run]')) {
    b.onclick = async () => {
      const id = b.dataset.answerRun;
      say(`ns-${id}`, 'Sending…');
      const r = await post(`/api/runs/${id}/answer`, { nodeId: b.dataset.node, answer: b.dataset.answer });
      if (r.answered) { say(`ns-${id}`, r.resumed ? 'Answered — carrying on.' : 'Answered.'); if (r.needsChoice) showChoice(id, r.needsChoice); else refreshRunsSoon(); }
      else say(`ns-${id}`, r.error || 'Could not answer.', true);
    };
  }
  for (const b of mount.querySelectorAll('[data-free-send]')) {
    b.onclick = async () => {
      const id = b.dataset.freeSend;
      const box = mount.querySelector(`[data-free-run="${id}"]`);
      const r = await post(`/api/runs/${id}/answer`, { nodeId: box.dataset.node, answer: box.value.trim() });
      if (r.answered) { say(`ns-${id}`, 'Answered.'); refreshRunsSoon(); } else say(`ns-${id}`, r.error || 'Could not answer.', true);
    };
  }
  for (const b of mount.querySelectorAll('[data-resume]')) b.onclick = () => resume(b.dataset.resume);
  for (const b of mount.querySelectorAll('[data-raise-go]')) {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.raiseGo;
      const v = Number(mount.querySelector(`[data-raise="${id}"]`).value);
      resume(id, { budgetUsd: v });
    };
  }
  for (const el of mount.querySelectorAll('.raise-in')) el.onclick = (ev) => ev.stopPropagation();

  for (const el of mount.querySelectorAll('.run-row')) {
    el.onclick = (ev) => {
      if (ev.target.closest('.row-btn, .row-detail, .choice-slot, a')) return;
      location.href = `/workflows-run.html#${el.dataset.id}`;
    };
  }
  for (const b of mount.querySelectorAll('.row-btn[data-act]')) {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.id;
      const r = state.runs.find((x) => x.runId === id);
      if (b.dataset.act === 'resume') resume(id);
      else if (b.dataset.act === 'again') startAgain(r);
      else if (b.dataset.act === 'rerun') rerunFromCatalog(id);
      else if (b.dataset.act === 'share') shareRunRow(id, b);
      else if (b.dataset.act === 'delete') armOrDo(`del-${id}`, b, () => deleteRunRow(id));
    };
  }
  const stopAll = mount.querySelector('#btnStopAll');
  if (stopAll) stopAll.onclick = () => armOrDo('stop-all', stopAll, async () => {
    const r = await post('/api/runs/stop-all');
    stopAll.textContent = `Stopped ${r.stopped ?? 0}`;
    setTimeout(loadRuns, 400);
  });

  // Schedules.
  mount.querySelector('#btnNewSchedule')?.addEventListener('click', () => openScheduleForm(null));
  bindScheduleForm(mount);
  for (const b of mount.querySelectorAll('[data-sched-toggle]')) {
    b.onclick = async () => { await post(`/api/schedules/${b.dataset.schedToggle}`, { enabled: b.dataset.on !== '1' }, 'PATCH'); loadRuns(); };
  }
  for (const b of mount.querySelectorAll('[data-sched-del]')) {
    b.onclick = () => armOrDo(`sdel-${b.dataset.schedDel}`, b, async () => { await post(`/api/schedules/${b.dataset.schedDel}`, {}, 'DELETE'); loadRuns(); });
  }
  for (const b of mount.querySelectorAll('[data-clear-missed]')) {
    b.onclick = async () => { await post(`/api/schedules/${b.dataset.clearMissed}`, { clearMissed: true }, 'PATCH'); loadRuns(); };
  }

  // Limits.
  mount.querySelector('#limSave')?.addEventListener('click', async () => {
    const r = await post('/api/settings', {
      budget: { perRunUsd: mount.querySelector('#limPerRun').value.trim(), scheduledPerDayUsd: mount.querySelector('#limDaily').value.trim() },
      concurrency: Number(mount.querySelector('#limConc').value),
    });
    say('limStatus', r.settings ? 'Saved.' : r.error || 'Could not save.', !r.settings);
  });
}

function openScheduleForm(workflowId) {
  runsView.scheduleFormFor = workflowId || (state.workflows.find((w) => !w.invalid)?.id ?? '');
  renderRuns();
  document.getElementById('schedSec')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function bindScheduleForm(mount) {
  const form = mount.querySelector('#schedForm');
  if (!form) return;
  const $f = (id) => form.querySelector(`#${id}`);
  const shape = () => {
    const every = $f('sfEvery').value;
    form.querySelector('.sf-n').classList.toggle('hidden', !['hours', 'minutes'].includes(every));
    form.querySelector('.sf-day').classList.toggle('hidden', every !== 'week');
    form.querySelector('.sf-at').classList.toggle('hidden', !['day', 'week'].includes(every));
    if (every === 'minutes' && Number($f('sfN').value) < 5) $f('sfN').value = 30;
  };
  $f('sfEvery').onchange = shape;
  shape();
  $f('sfWorkflow').onchange = () => { runsView.scheduleFormFor = $f('sfWorkflow').value; renderRuns(); };
  $f('sfCancel').onclick = () => { runsView.scheduleFormFor = null; renderRuns(); };
  $f('sfSave').onclick = async () => {
    const every = $f('sfEvery').value;
    const rule = every === 'day' ? { every, at: $f('sfAt').value }
      : every === 'week' ? { every, day: Number($f('sfDay').value), at: $f('sfAt').value }
      : { every, n: Number($f('sfN').value) };
    const inputs = {};
    for (const el of form.querySelectorAll('[data-key]')) inputs[el.dataset.key] = el.value.trim();
    const r = await post('/api/schedules', { workflowId: $f('sfWorkflow').value, rule, budgetUsd: $f('sfBudget').value, inputs });
    if (r.schedule) { runsView.scheduleFormFor = null; loadRuns(); }
    else say('sfStatus', r.error || 'Could not schedule it.', true);
  };
}

/** Run the same workflow again with the inputs this run used, editable first. */
function startAgain(r) {
  location.hash = 'workflows';
  setTimeout(() => {
    if (!openSheet(r.workflowId, r.inputs || {})) {
      document.getElementById('importNote').textContent = `"${r.workflowTitle}" is not in the catalog any more.`;
    }
  }, 80);
}

async function shareRunRow(runId, btn) {
  const prev = btn.textContent;
  btn.textContent = '…';
  const r = await post(`/api/runs/${encodeURIComponent(runId)}/share`);
  if (!r.url) { btn.textContent = 'failed'; setTimeout(() => { btn.textContent = prev; }, 1600); return; }
  await navigator.clipboard?.writeText(r.url).catch(() => {});
  btn.textContent = 'copied';
  window.open(r.url, '_blank', 'noopener');
  setTimeout(() => { btn.textContent = prev; }, 1600);
}

async function rerunFromCatalog(runId) {
  const r = await post(`/api/runs/${encodeURIComponent(runId)}/rerun`);
  if (r.run?.runId) { location.href = `/workflows-run.html#${r.run.runId}`; return; }
  say(`ns-${runId}`, r.error || 'Could not repeat it.', true);
}

async function deleteRunRow(runId) {
  const r = await post(`/api/runs/${encodeURIComponent(runId)}`, {}, 'DELETE');
  if (r.deleted) loadRuns();
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x) || 'unknown';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/* -------------------------------- Decisions ------------------------------ */

async function loadDecisions() {
  const r = await fetch('/api/decisions').then((x) => x.json());
  state.decisions = r.decisions || [];
  // Learn the live session so the "this session" chip is accurate.
  if (!state.liveSessionId) {
    try {
      const s = await fetch('/api/state').then((x) => x.json());
      state.liveSessionId = s.instance?.sessionId || null;
    } catch {}
  }
  renderDecisions();
}

function renderDecisions() {
  const mount = document.getElementById('decisionsMount');
  const scope = state.decisionScope;
  const sessionId = state.liveSessionId;
  const chips = `<div class="chips-row">
    <button class="chip ${scope === 'all' ? 'on' : ''}" data-scope="all">All sessions</button>
    <button class="chip ${scope === 'session' ? 'on' : ''}" data-scope="session"
            ${sessionId ? '' : 'disabled title="No live session"'}>
      This session ${sessionId ? `· ${esc(sessionId.slice(0, 8))}` : ''}
    </button>
    <span class="chips-count">${state.decisions.length} total</span>
  </div>`;

  const filtered = scope === 'session' && sessionId
    ? state.decisions.filter((d) => d.sessionId === sessionId)
    : state.decisions;

  if (!filtered.length) {
    mount.innerHTML = chips + `<div class="empty">
      ${scope === 'session'
        ? 'No decisions in this session yet. Mark a step with ⚑ in Sessions, or let a workflow ask-node resolve.'
        : 'Decisions show up here once a workflow asks a question and gets an answer, or once a step is marked as a decision in Sessions.'}
    </div>`;
    bindChips();
    return;
  }
  const byDay = new Map();
  for (const d of filtered) {
    const k = (d.at || '').slice(0, 10) || 'unknown';
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(d);
  }
  const parts = [chips];
  for (const [day, rows] of byDay) {
    parts.push(`<div class="day">${esc(day)}</div>`);
    for (const d of rows) parts.push(decisionRow(d));
  }
  mount.innerHTML = parts.join('');
  bindChips();
  for (const el of document.querySelectorAll('.decision-row')) {
    el.onclick = (ev) => {
      if (ev.target.closest('.row-btn')) return;
      const kind = el.dataset.kind;
      if (kind === 'auto' && el.dataset.runId) {
        location.href = `/workflows-run.html#${el.dataset.runId}`;
      } else if (kind === 'marked' && el.dataset.sessionId) {
        location.href = `/#${el.dataset.sessionId}/${el.dataset.stepId || ''}`;
      }
    };
  }
  for (const b of document.querySelectorAll('.d-share')) {
    b.onclick = (ev) => { ev.stopPropagation(); shareDecisionRow(b.closest('.decision-row'), b); };
  }
}

function bindChips() {
  for (const chip of document.querySelectorAll('#decisionsMount .chip')) {
    chip.onclick = () => {
      state.decisionScope = chip.dataset.scope;
      renderDecisions();
    };
  }
}

function decisionRow(d) {
  const time = (d.at || '').slice(11, 16);
  const where = d.kind === 'auto'
    ? `${esc(d.workflowTitle || 'workflow')} · ${esc(d.nodeId || '')}`
    : `session ${d.sessionId ? d.sessionId.slice(0, 8) : '—'}`;
  const q = d.kind === 'auto' ? esc(d.question) : esc(d.note || '(no note)');
  const a = d.kind === 'auto' ? esc(d.answer)   : 'marked';
  return `<div class="decision-row" data-kind="${d.kind}" data-run-id="${esc(d.runId || '')}"
       data-session-id="${esc(d.sessionId || '')}" data-step-id="${esc(d.stepId || '')}"
       data-node-id="${esc(d.nodeId || '')}">
    <span class="time">${time}</span>
    <span class="d-kind ${d.kind}">${d.kind}</span>
    <div class="d-body">
      <div class="d-q">${q}</div>
      <div class="d-a">${a}</div>
      <div class="d-where">${where}</div>
    </div>
    <button class="row-btn d-share" data-share-kind="${d.kind}" title="Signed URL to this moment">◎ share</button>
    <span class="open">open →</span>
  </div>`;
}

async function shareDecisionRow(row, btn) {
  const prev = btn.textContent;
  btn.textContent = '…';
  const body = row.dataset.kind === 'auto'
    ? { runId: row.dataset.runId, nodeId: row.dataset.nodeId }
    : { sessionId: row.dataset.sessionId, stepId: row.dataset.stepId };
  try {
    const r = await fetch('/api/decisions/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (!r.url) throw new Error(r.error || 'no url');
    await navigator.clipboard?.writeText(r.url).catch(() => {});
    btn.textContent = 'copied';
    window.open(r.url, '_blank', 'noopener');
    setTimeout(() => { btn.textContent = prev; }, 1600);
  } catch (e) {
    btn.textContent = prev;
    alert(`Share failed: ${e.message}`);
  }
}

/* -------------------------------- Prompts -------------------------------- */

async function loadPrompts() {
  const r = await fetch('/api/prompts').then((x) => x.json());
  state.prompts = r.prompts || [];
  // Learn which session this orderly instance is bound to so the "send"
  // action can tell the user where it will land.
  try {
    const s = await fetch('/api/state').then((x) => x.json());
    state.liveSessionId = s.instance?.sessionId || null;
  } catch {}
  renderPrompts();
}

function renderPrompts() {
  const mount = document.getElementById('promptsMount');
  const projects = new Map();
  const global = [];
  for (const p of state.prompts) {
    if (p.scope === 'user') global.push(p);
    else {
      if (!projects.has(p.repoRoot)) projects.set(p.repoRoot, []);
      projects.get(p.repoRoot).push(p);
    }
  }
  const parts = [];
  const sortedProjects = [...projects.entries()].sort(([a], [b]) =>
    (a.split('/').pop() || '').localeCompare(b.split('/').pop() || ''));
  for (const [root, list] of sortedProjects) {
    parts.push(renderPromptSection(root.split('/').pop(), root, list, root));
  }
  if (!sortedProjects.length) {
    parts.push(`<section class="scope">
      <header class="cat-head"><h2>Project libraries</h2><span class="meta">none yet</span></header>
      <div class="empty" style="background:var(--surface);">
        No projects with <code>.claude/prompts/</code> are known yet. Drop a <code>.md</code> in there to add one.
      </div>
    </section>`);
  }
  parts.push(renderPromptSection('Your global library', '~/.claude/prompts/', global));
  mount.innerHTML = parts.join('');
  for (const el of document.querySelectorAll('.prompt-tile')) {
    el.onclick = () => openPromptSheet(el.dataset.id);
  }
}

function renderPromptSection(title, pathLabel, list, repoRoot) {
  const meta = list.length ? `${list.length} prompt${list.length === 1 ? '' : 's'}` : 'none yet';
  const body = list.length
    ? `<div class="tiles">${list.map(promptTile).join('')}</div>`
    : `<div class="empty" style="background:var(--surface);">Nothing in <code>${esc(pathLabel)}</code> yet.</div>`;
  return `<section class="scope"${repoRoot ? ` data-repo="${esc(repoRoot)}"` : ''}>
    <header class="cat-head">
      <h2>${esc(title)}</h2>
      <code class="repo-path" style="font-family:var(--f-mono);font-size:11px;color:var(--faint);margin-left:12px;">${esc(pathLabel)}</code>
      <span class="meta">${meta}</span>
    </header>
    ${body}
  </section>`;
}

function promptTile(p) {
  const cat = CAT_LABEL[p.category] || 'Prompt';
  const vars = (p.inputs || []).map((i) => i.key).join(', ');
  return `<div class="tile prompt-tile" data-id="${esc(p.id)}">
    <span class="cat-chip ${p.category || 'build'}">${cat}</span>
    <h3>${esc(p.title)}</h3>
    <p>${esc(p.description || '')}</p>
    <div class="foot">
      <span>${(p.inputs || []).length ? vars : 'no inputs'}</span>
      <span class="scope-tag">${p.scope}</span>
    </div>
  </div>`;
}

async function openPromptSheet(id) {
  const r = await fetch(`/api/prompts/${encodeURIComponent(id)}`).then((x) => x.json());
  const p = r.prompt;
  if (!p) return;
  state.openPrompt = p;
  document.getElementById('pshEyebrow').textContent = `${CAT_LABEL[p.category] || 'Prompt'} · ${p.scope}`;
  document.getElementById('pshTitle').textContent   = p.title;
  document.getElementById('pshDesc').textContent    = p.description || '';
  document.getElementById('pshInputs').innerHTML    = (p.inputs || []).map(inputField).join('')
    || '<div style="color:var(--faint);font-size:13px;">No inputs — ready as-is.</div>';
  document.getElementById('pshTarget').textContent  = state.liveSessionId
    ? `will land in session ${state.liveSessionId.slice(0, 8)}`
    : 'no live session';
  document.getElementById('pshSend').onclick = sendPromptNow;
  document.getElementById('pshSend').disabled = !state.liveSessionId;
  updatePromptPreview();
  for (const el of document.querySelectorAll('#pshInputs [data-key]')) {
    el.oninput = updatePromptPreview;
  }
  document.getElementById('pScrim').classList.add('on');
  document.getElementById('pSheet').setAttribute('aria-hidden', 'false');
}

function updatePromptPreview() {
  const p = state.openPrompt;
  if (!p) return;
  const inputs = {};
  for (const el of document.querySelectorAll('#pshInputs [data-key]')) inputs[el.dataset.key] = el.value.trim();
  const text = String(p.body || '').replace(/\{\{([^}|]+?)(?:\|([^}]*))?\}\}/g, (_, k, def) => {
    const v = inputs[k.trim()];
    return v && v.trim() !== '' ? v : (def !== undefined ? def : '');
  });
  document.getElementById('pshPreview').textContent = text;
}

function closePromptSheet() {
  state.openPrompt = null;
  document.getElementById('pScrim').classList.remove('on');
  document.getElementById('pSheet').setAttribute('aria-hidden', 'true');
}
window.closePromptSheet = closePromptSheet;

async function sendPromptNow() {
  const p = state.openPrompt;
  if (!p) return;
  const inputs = {};
  for (const el of document.querySelectorAll('#pshInputs [data-key]')) inputs[el.dataset.key] = el.value.trim();
  const btn = document.getElementById('pshSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await fetch(`/api/prompts/${encodeURIComponent(p.id)}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, sessionId: state.liveSessionId }),
    }).then((x) => x.json());
    if (r.sent) { location.href = '/'; return; }
    throw new Error(r.error || 'send failed');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '◆ Send to session';
    alert(`Send failed: ${e.message}`);
  }
}

/* -------------------------------- Skills --------------------------------- */

async function loadSkills() {
  const r = await fetch('/api/skills').then((x) => x.json());
  state.skills = r.skills || [];
  renderSkills();
}

function renderSkills() {
  // Orderly spans every project. Group by repoRoot so each project with a
  // .claude/skills/ folder gets its own section, then the global library.
  const mount = document.getElementById('skillsMount');
  const projects = new Map(); // repoRoot → skills[]
  const global = [];
  for (const s of state.skills) {
    if (s.scope === 'user') global.push(s);
    else {
      if (!projects.has(s.repoRoot)) projects.set(s.repoRoot, []);
      projects.get(s.repoRoot).push(s);
    }
  }
  const parts = [];
  // Projects first, sorted by name for stability.
  const sortedProjects = [...projects.entries()].sort(([a], [b]) =>
    (a.split('/').pop() || '').localeCompare(b.split('/').pop() || ''));
  for (const [root, list] of sortedProjects) {
    parts.push(renderSkillSection(root.split('/').pop(), root.replace(/^.*?\.claude\//, '.claude/') ===
      root ? `${root}/.claude/skills/` : root, list, root));
  }
  if (!sortedProjects.length) {
    parts.push(`<section class="scope">
      <header class="cat-head"><h2>Project libraries</h2><span class="meta">none yet</span></header>
      <div class="empty" style="background:var(--surface);">
        No projects with <code>.claude/skills/</code> are known yet. Open the project in Claude Code once and it will show up.
      </div>
    </section>`);
  }
  // Global library.
  parts.push(renderSkillSection('Your global library', '~/.claude/skills/', global));
  mount.innerHTML = parts.join('');
}

function renderSkillSection(title, pathLabel, list, repoRoot) {
  const meta = list.length ? `${list.length} skill${list.length === 1 ? '' : 's'}` : 'none yet';
  const body = list.length
    ? `<div class="skills">${list.map(skillTile).join('')}</div>`
    : `<div class="empty" style="background:var(--surface);">
         Nothing in <code>${esc(pathLabel)}</code> yet.
       </div>`;
  return `<section class="scope"${repoRoot ? ` data-repo="${esc(repoRoot)}"` : ''}>
    <header class="cat-head">
      <h2>${esc(title)}</h2>
      <code class="repo-path" style="font-family:var(--f-mono);font-size:11px;color:var(--faint);margin-left:12px;">${esc(pathLabel)}</code>
      <span class="meta">${meta}</span>
    </header>
    ${body}
  </section>`;
}

function esc(s) { return escapeHtml(s); }

function skillTile(s) {
  const glyph = (s.slug || s.name || '?').slice(0, 2).toUpperCase();
  const cat = CAT_LABEL[s.category] || 'Build';
  return `
    <div class="skill-tile c-${s.category || 'build'}">
      <div class="top">
        <span class="glyph">${escapeHtml(glyph)}</span>
        <div class="name">
          <div class="n">${escapeHtml(s.name)}</div>
          <div class="slug">${escapeHtml(s.slug)}</div>
        </div>
        <span class="cat-chip ${s.category || 'build'}">${cat}</span>
      </div>
      <p>${escapeHtml((s.description || '').slice(0, 220))}${s.description && s.description.length > 220 ? '…' : ''}</p>
      <div class="foot">
        <span class="path">${escapeHtml(shortenPath(s.path))}</span>
        ${s.version ? `<span class="ver">v${escapeHtml(s.version)}</span>` : ''}
      </div>
    </div>`;
}

function shortenPath(p) {
  if (!p) return '';
  // Hide the user's home prefix on the global library.
  return p.replace(/^.*?\.claude\//, '.claude/');
}

/* --------------------------------- Tabs ---------------------------------- */

const TAB_COPY = {
  workflows: {
    eyebrow: 'Workflows · a job you run the same way every time',
    title:   'Pick a workflow.',
    desc:    'A workflow is a set of steps you would otherwise type out one prompt at a time. Press one button and watch each step finish on the canvas, instead of scrolling a terminal to work out what happened.',
    newHref: '/workflows-new.html',
    newLabel: '+ New workflow',
  },
  runs: {
    eyebrow: 'Runs · everything your workflows are doing, and have done',
    title:   'What ran. What needs you.',
    desc:    'Answer the questions your workflows are waiting on, see where one broke and pick it back up, repeat one, or set one to run on a schedule. Every run keeps what each step produced.',
  },
  skills: {
    eyebrow: 'Skills · what Claude knows how to do on this machine',
    title:   'What Claude knows how to do.',
    desc:    'Every skill installed across your projects, plus your global library, in one list. Worth a look before writing a workflow — the step you need may already exist.',
  },
  prompts: {
    eyebrow: 'Prompts · one saved message, with blanks to fill in',
    title:   'Pick a prompt.',
    desc:    'A prompt is a message you keep instead of retyping it. Fill in the blanks, hit Send, and it goes into the session you are watching. A workflow is many steps; a prompt is one message.',
    newHref: '/prompts-new.html',
    newLabel: '+ New prompt',
  },
  decisions: {
    eyebrow: 'Decisions · every time you chose a direction',
    title:   'What you decided, and why.',
    desc:    'Every question a workflow put to you and what you answered, plus any step you flagged yourself in Sessions. The answer to "why is it built this way?" once you have forgotten.',
  },
};

function switchTab(tab) {
  document.getElementById('viewCatalog').style.display   = tab === 'workflows' ? '' : 'none';
  document.getElementById('viewRuns').style.display      = tab === 'runs'      ? '' : 'none';
  document.getElementById('viewSkills').style.display    = tab === 'skills'    ? '' : 'none';
  document.getElementById('viewPrompts').style.display   = tab === 'prompts'   ? '' : 'none';
  document.getElementById('viewDecisions').style.display = tab === 'decisions' ? '' : 'none';
  for (const el of document.querySelectorAll('[data-tab]')) el.classList.toggle('on', el.dataset.tab === tab);
  document.getElementById('hereTab').textContent = tab;
  const copy = TAB_COPY[tab] || TAB_COPY.workflows;
  document.getElementById('heroEyebrow').textContent = copy.eyebrow;
  document.getElementById('heroTitle').textContent   = copy.title;
  document.getElementById('heroDesc').textContent    = copy.desc;
  document.getElementById('heroImport')?.classList.toggle('hidden', tab !== 'workflows');
  const newBtn = document.getElementById('heroNewBtn');
  if (newBtn) {
    if (copy.newHref) {
      newBtn.href = copy.newHref;
      newBtn.textContent = copy.newLabel || '+ New';
      newBtn.style.display = '';
    } else {
      newBtn.style.display = 'none';
    }
  }
  if (tab === 'runs')      loadRuns();
  if (tab === 'skills')    loadSkills();
  if (tab === 'prompts')   loadPrompts();
  if (tab === 'decisions') loadDecisions();
}
function tabFromHash() {
  const h = (location.hash || '').replace('#', '');
  // Keep #catalog as an alias so earlier links keep working.
  if (h === 'catalog') return 'workflows';
  return ['runs', 'skills', 'prompts', 'decisions'].includes(h) ? h : 'workflows';
}
window.addEventListener('hashchange', () => switchTab(tabFromHash()));

for (const el of document.querySelectorAll('[data-tab]')) {
  el.addEventListener('click', (ev) => { ev.preventDefault(); location.hash = el.dataset.tab; });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Boot */
switchTab(tabFromHash());
loadCatalog().then(async () => {
  const q = new URLSearchParams(location.search);
  const open = q.get('open');
  if (!open || tabFromHash() !== 'workflows') return;
  // "Again with changes" from a run page: the same inputs, ready to edit.
  let prefill = {};
  if (q.get('again')) {
    const r = await fetch(`/api/runs/${encodeURIComponent(q.get('again'))}`).then((x) => x.json()).catch(() => ({}));
    prefill = r.run?.inputs || {};
  }
  if (!openSheet(open, prefill)) document.getElementById('importNote').textContent = `There is no workflow called "${open}" any more.`;
});
document.getElementById('importFile')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) importWorkflow(f);
});
