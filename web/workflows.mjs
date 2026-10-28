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

const state = { workflows: [], runs: [], skills: [], open: null };

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
  for (const scope of ['project', 'user', 'builtin']) {
    const list = state.workflows.filter((w) => w.scope === scope);
    const mount = document.getElementById('tiles' + scope[0].toUpperCase() + scope.slice(1));
    const meta  = document.getElementById('meta'    + scope[0].toUpperCase() + scope.slice(1));
    meta.textContent = list.length
      ? `${list.length} workflow${list.length === 1 ? '' : 's'}`
      : 'none yet';
    if (!list.length) {
      mount.innerHTML = `<div class="empty" style="grid-column:1 / -1;background:var(--surface);">
        Nothing in <code>${scopeHint(scope)}</code> yet.
      </div>`;
      continue;
    }
    mount.innerHTML = list.map(tile).join('');
  }
  for (const el of document.querySelectorAll('.tile')) {
    el.onclick = () => openSheet(el.dataset.id);
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
  if (!state.runs.length) {
    mount.innerHTML = '<div class="empty">No runs yet. Pick a workflow from the catalog.</div>';
    return;
  }
  const byDay = groupBy(state.runs, (r) => (r.startedAt || '').slice(0, 10));
  const parts = [];
  for (const [day, rows] of byDay) {
    parts.push(`<div class="day">${day}</div>`);
    for (const r of rows) parts.push(runRow(r));
  }
  mount.innerHTML = parts.join('');
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
      if (b.dataset.act === 'rerun') rerunFromCatalog(id);
      else if (b.dataset.act === 'delete') deleteRunRow(id);
    };
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
    <span class="state ${stateCls}">${escapeHtml(label)}</span>
    <span class="row-actions">
      <button class="row-btn" data-act="rerun"  data-id="${r.runId}" title="Start a new run from the same def">↻ rerun</button>
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
  catalog: {
    eyebrow: 'Catalog · workflows available in this project',
    title:   'Pick a workflow.',
    desc:    'Every tile is a graph of typed-output cards. Click one for the brief sheet, fill the inputs, and open it on the canvas.',
  },
  runs: {
    eyebrow: 'Runs · every invocation, linked to its session',
    title:   'What ran. Where.',
    desc:    'When a workflow fires, that run shows up here, tied to the session it happened in. Click a row to open the canvas scoped to it.',
  },
  skills: {
    eyebrow: 'Skills · the pieces workflows draw on',
    title:   'What Claude knows how to do.',
    desc:    'Read from the two .claude/skills roots. A workflow node can call a skill by name; this is where you see what is on the shelf.',
  },
};

function switchTab(tab) {
  document.getElementById('viewCatalog').style.display = tab === 'catalog' ? '' : 'none';
  document.getElementById('viewRuns').style.display    = tab === 'runs'    ? '' : 'none';
  document.getElementById('viewSkills').style.display  = tab === 'skills'  ? '' : 'none';
  for (const el of document.querySelectorAll('[data-tab]')) el.classList.toggle('on', el.dataset.tab === tab);
  document.getElementById('hereTab').textContent = tab;
  const copy = TAB_COPY[tab] || TAB_COPY.catalog;
  document.getElementById('heroEyebrow').textContent = copy.eyebrow;
  document.getElementById('heroTitle').textContent   = copy.title;
  document.getElementById('heroDesc').textContent    = copy.desc;
  if (tab === 'runs')   loadRuns();
  if (tab === 'skills') loadSkills();
}
function tabFromHash() {
  const h = (location.hash || '').replace('#', '');
  return h === 'runs' || h === 'skills' ? h : 'catalog';
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
