/*
 * Author a prompt from the browser. Loads a scaffold, lets you edit the .md,
 * validates on demand or on save, writes through POST /api/prompts.
 *
 * The inputs picker above the textarea reads frontmatter inputs on load; each
 * add/remove/edit regenerates the frontmatter block in the .md, keeping the
 * raw .md the single source of truth.
 */
const $ = (id) => document.getElementById(id);
const state = { inputs: [] };

async function scaffold(slug) {
  const r = await fetch(`/api/prompts/scaffold?slug=${encodeURIComponent(slug || 'untitled')}&title=${encodeURIComponent($('pTitle').value || '')}`).then((x) => x.json());
  return r.md;
}

async function load() {
  const md = await scaffold($('pId').value || 'untitled');
  $('pMd').value = md;
  state.inputs = parseInputsFromFrontmatter(md);
  renderInputs();
}

async function validate() {
  const r = await fetch('/api/prompts/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ md: $('pMd').value }),
  }).then((x) => x.json());
  showProblems(r.problems || []);
  return r.ok;
}

async function save() {
  const ok = await validate();
  if (!ok) return;
  const slug = $('pId').value.trim();
  const scope = $('pScope').value;
  try {
    const r = await fetch('/api/prompts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, scope, md: $('pMd').value }),
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
    panel.style.display = 'block';
    panel.innerHTML = '<span class="ok">Looks good.</span>';
    $('status').textContent = 'Valid.';
    $('status').className = 'status ok';
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = `<strong>${list.length} problem${list.length === 1 ? '' : 's'}:</strong><ul>${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
  $('status').textContent = `${list.length} problem${list.length === 1 ? '' : 's'}`;
  $('status').className = 'status err';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------- Inputs ---------------------------------- */

function renderInputs() {
  const mount = $('inputsList');
  mount.innerHTML = '';
  state.inputs.forEach((inp, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1.3fr 1.5fr 32px;gap:6px;align-items:center;';
    row.innerHTML = `
      <input data-k="key"         value="${escapeHtml(inp.key || '')}"         placeholder="key" spellcheck="false">
      <input data-k="label"       value="${escapeHtml(inp.label || '')}"       placeholder="label">
      <input data-k="placeholder" value="${escapeHtml(inp.placeholder || '')}" placeholder="placeholder">
      <button class="btn-ghost" style="padding:4px;font:12px var(--f-mono);">✕</button>`;
    for (const field of row.querySelectorAll('input')) {
      field.oninput = () => { inp[field.dataset.k] = field.value; refreshMd(); };
    }
    row.querySelector('button').onclick = () => {
      state.inputs.splice(i, 1); refreshMd(); renderInputs();
    };
    mount.append(row);
  });
}

function addInput() {
  state.inputs.push({ key: `input${state.inputs.length + 1}`, label: '', placeholder: '' });
  refreshMd();
  renderInputs();
}

function refreshMd() {
  $('pMd').value = rewriteFrontmatterInputs($('pMd').value, state.inputs);
}

/** Parse `inputs:` block out of a .md's frontmatter. */
function parseInputsFromFrontmatter(md) {
  if (!md.startsWith('---')) return [];
  const end = md.indexOf('\n---', 3);
  if (end < 0) return [];
  const lines = md.slice(4, end).split('\n');
  const out = [];
  let inInputs = false;
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent === 0) {
      inInputs = /^inputs\s*:/.test(line) && !line.split(':')[1].trim();
      cur = null;
      continue;
    }
    if (!inInputs) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      cur = {};
      out.push(cur);
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const c = rest.indexOf(':');
        if (c > 0) cur[rest.slice(0, c).trim()] = unquote(rest.slice(c + 1).trim());
      }
    } else if (cur) {
      const c = trimmed.indexOf(':');
      if (c > 0) cur[trimmed.slice(0, c).trim()] = unquote(trimmed.slice(c + 1).trim());
    }
  }
  return out;
}

function unquote(v) {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

/** Rewrite the `inputs:` block in a .md's frontmatter from the picker rows. */
function rewriteFrontmatterInputs(md, inputs) {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end < 0) return md;
  const front = md.slice(4, end);
  const body = md.slice(end);
  const lines = front.split('\n');
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent === 0) skipping = /^inputs\s*:/.test(line);
    if (!skipping) kept.push(line);
  }
  // Drop trailing empties so we don't accumulate blank lines on each rewrite.
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const inputsBlock = inputs.length
    ? ['inputs:', ...inputs.flatMap((i) => [
        `  - key: ${i.key}`,
        i.label       ? `    label: ${i.label}` : null,
        i.placeholder ? `    placeholder: ${i.placeholder}` : null,
      ].filter(Boolean))]
    : [];
  const newFront = [...kept, ...inputsBlock].join('\n');
  return `---\n${newFront}\n${body.slice(1)}`;
}

$('pId').addEventListener('change', load);
$('pTitle').addEventListener('change', load);
$('btnScaffold').addEventListener('click', load);
$('btnValidate').addEventListener('click', validate);
$('btnSave').addEventListener('click', save);
$('btnAddInput').addEventListener('click', addInput);
$('pMd').addEventListener('change', () => {
  state.inputs = parseInputsFromFrontmatter($('pMd').value);
  renderInputs();
});

$('pId').value = 'untitled';
load();
