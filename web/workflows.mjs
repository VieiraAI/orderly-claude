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

async function loadRuns() {
  const r = await fetch('/api/runs').then((x) => x.json());
  state.runs = r.runs || [];
  renderRuns();
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
  return scope === 'project' ? '<repo>/.claude/workflows/'
       : scope === 'user'    ? '~/.claude/workflows/'
       : 'src/core/workflow-defs/';
}

function tile(w) {
  const cat = CAT_LABEL[w.category] || 'Workflow';
  return `
    <div class="tile" data-id="${w.id}">
      <span class="cat-chip ${w.category || 'builtin'}">${cat}</span>
      <h3>${escapeHtml(w.title)}</h3>
      <p>${escapeHtml(w.desc || '')}</p>
      <div class="foot">
        <span>${w.graph?.nodes?.length ?? 0} nodes · ${w.estimate || '—'}</span>
        <span class="scope-tag">${w.scope}</span>
      </div>
    </div>`;
}

function openSheet(id) {
  const w = state.workflows.find((x) => x.id === id);
  if (!w) return;
  state.open = w;
  document.getElementById('shEyebrow').textContent =
    `${CAT_LABEL[w.category] || 'Workflow'} · ${w.scope}`;
  document.getElementById('shTitle').textContent = w.title;
  document.getElementById('shDesc').textContent  = w.desc || '';
  document.getElementById('shEst').textContent   = w.estimate || '';
  document.getElementById('shInputs').innerHTML = (w.inputs || []).map(inputField).join('')
    || '<div style="color:var(--faint);font-size:13px;">No inputs — it reads from the current repo.</div>';
  document.getElementById('shPlan').innerHTML = (w.graph?.nodes || [])
    .map((n) => `<li style="padding:3px 0;">· <b style="color:var(--text);font-weight:500;">${escapeHtml(n.title)}</b> <span style="color:var(--faint);font-family:var(--f-mono);font-size:11px;">${n.kind}</span></li>`).join('');
  document.getElementById('shRun').onclick = runNow;
  document.getElementById('scrim').classList.add('on');
  document.getElementById('sheet').setAttribute('aria-hidden', 'false');
}

function inputField(f) {
  if (f.textarea) {
    return `<label>${escapeHtml(f.label)}<textarea data-key="${f.key}" placeholder="${escapeHtml(f.placeholder || '')}"></textarea></label>`;
  }
  return `<label>${escapeHtml(f.label)}<input data-key="${f.key}" placeholder="${escapeHtml(f.placeholder || '')}"></label>`;
}

function closeSheet() {
  state.open = null;
  document.getElementById('scrim').classList.remove('on');
  document.getElementById('sheet').setAttribute('aria-hidden', 'true');
}
window.closeSheet = closeSheet;

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
    alert(`Could not start the run: ${e.message}`);
  }
}

/* ------------------------------- Runs view ------------------------------ */

function renderRuns() {
  const mount = document.getElementById('runsBody');
  const anyRunning = state.runs.some((r) => r.status === 'running');
  const bar = `<div class="chips-row">
    ${anyRunning ? `<button class="chip stop-all" id="btnStopAll">■ Stop all running</button>` : ''}
    <span class="chips-count">${state.runs.length} total${anyRunning ? ' · live' : ''}</span>
  </div>`;
  if (!state.runs.length) {
    mount.innerHTML = bar + '<div class="empty">No runs yet. Pick a workflow from the catalog.</div>';
    bindStopAll();
    return;
  }
  const byDay = groupBy(state.runs, (r) => (r.startedAt || '').slice(0, 10));
  const parts = [bar];
  for (const [day, rows] of byDay) {
    parts.push(`<div class="day">${day}</div>`);
    for (const r of rows) parts.push(runRow(r));
  }
  mount.innerHTML = parts.join('');
  bindStopAll();
  for (const el of document.querySelectorAll('.run-row')) {
    el.onclick = (ev) => {
      // Row-level actions handle their own navigation.
      if (ev.target.closest('.row-btn')) return;
      location.href = `/workflows-run.html#${el.dataset.id}`;
    };
  }
  for (const b of document.querySelectorAll('.row-btn')) {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.act === 'rerun')  rerunFromCatalog(id);
      else if (b.dataset.act === 'share')  shareRunRow(id, b);
      else if (b.dataset.act === 'delete') deleteRunRow(id);
    };
  }
}

function bindStopAll() {
  const btn = document.getElementById('btnStopAll');
  if (!btn) return;
  btn.onclick = async () => {
    if (!confirm('Stop every live scheduler?')) return;
    btn.textContent = 'Stopping…';
    try {
      const r = await fetch('/api/runs/stop-all', { method: 'POST' }).then((x) => x.json());
      btn.textContent = `Stopped ${r.stopped}`;
      setTimeout(loadRuns, 500);
    } catch (e) { alert(`Stop-all failed: ${e.message}`); }
  };
}

async function shareRunRow(runId, btn) {
  const prev = btn.textContent;
  btn.textContent = '…';
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
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

function runRow(r) {
  const time = (r.startedAt || '').slice(11, 16);
  const cat = r.category || 'builtin';
  const stateCls = r.status === 'done' ? 'done'
    : r.status === 'running' ? 'running'
    : r.status === 'failed' ? 'failed' : 'ask';
  const label = r.runningLabel ? `${r.runningLabel}`
    : r.askingLabel  ? `waiting · ${r.askingLabel}`
    : r.status === 'done' ? 'done'
    : r.status === 'failed' ? 'failed'
    : `step ${r.doneNodes} of ${r.totalNodes}`;
  const totalBits = [];
  if (typeof r.totalCost === 'number' && r.totalCost > 0) {
    totalBits.push(r.totalCost < 0.01 ? `$${r.totalCost.toFixed(4)}` : `$${r.totalCost.toFixed(3)}`);
  }
  if (r.totalElapsed) totalBits.push(r.totalElapsed);
  if (r.totalTokens)  totalBits.push(`${r.totalTokens} tok`);
  const totals = totalBits.length ? `<span class="row-totals">${totalBits.join(' · ')}</span>` : '';
  const pipCls = r.status === 'running' ? `${cat} running` : cat;
  return `<div class="run-row" data-id="${r.runId}">
    <span class="time">${time}</span>
    <div class="wf">
      <span class="pip ${pipCls}"></span>
      <div style="min-width:0;">
        <div class="nm">${escapeHtml(r.workflowTitle || r.workflowId)}</div>
        <div class="sess">${r.sessionId ? 'session ' + r.sessionId.slice(0, 8) : (r.repoRoot ? r.repoRoot.split('/').pop() : '—')}</div>
      </div>
    </div>
    <span class="trigger">${escapeHtml(r.trigger || '—')}</span>
    <span class="state ${stateCls}">${escapeHtml(label)}${totals}</span>
    <span class="row-actions">
      <button class="row-btn" data-act="rerun"  data-id="${r.runId}" title="Start a new run from the same def">↻ rerun</button>
      <button class="row-btn" data-act="share"  data-id="${r.runId}" title="Signed URL to a static copy">◎ share</button>
      <button class="row-btn danger" data-act="delete" data-id="${r.runId}" title="Delete this run folder">✕</button>
      <span class="open">open canvas →</span>
    </span>
  </div>`;
}

async function rerunFromCatalog(runId) {
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' }).then((x) => x.json());
    if (r.run?.runId) { location.href = `/workflows-run.html#${r.run.runId}`; return; }
    throw new Error(r.error || 'rerun failed');
  } catch (e) { alert(`Rerun failed: ${e.message}`); }
}

async function deleteRunRow(runId) {
  if (!confirm('Delete this run? The folder and all its outputs will be removed.')) return;
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }).then((x) => x.json());
    if (r.deleted) { loadRuns(); return; }
    throw new Error(r.error || 'delete failed');
  } catch (e) { alert(`Delete failed: ${e.message}`); }
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
    eyebrow: 'Runs · the receipt for every workflow you have run',
    title:   'What ran. Where.',
    desc:    'Each time a workflow fires it leaves a run here, tied to the session it happened in, holding what every step produced. This is where you answer "what did that actually do?" a week later.',
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
loadCatalog();
