/*
 * Author a workflow from the browser. Loads a scaffold with the id you type,
 * lets you edit the JSON, validates on demand or on save, and writes to the
 * server's chosen scope.
 */
const $ = (id) => document.getElementById(id);

async function scaffold(id) {
  const r = await fetch(`/api/workflows/scaffold?id=${encodeURIComponent(id || 'untitled')}&title=${encodeURIComponent($('wfTitle').value || '')}`).then((x) => x.json());
  return r.def;
}

function setJson(def) {
  $('wfJson').value = JSON.stringify(def, null, 2);
}

async function load() {
  const def = await scaffold($('wfId').value || 'untitled');
  setJson(def);
}

async function validate() {
  const parsed = tryParse();
  if (!parsed.ok) return showProblems([parsed.error]);
  const r = await fetch('/api/workflows/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ def: parsed.def }),
  }).then((x) => x.json());
  showProblems(r.problems || []);
  return r.ok;
}

async function save() {
  const ok = await validate();
  if (!ok) return;
  const parsed = tryParse();
  const scope = $('wfScope').value;
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: parsed.def, scope }),
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

function tryParse() {
  try { return { ok: true, def: JSON.parse($('wfJson').value) }; }
  catch (e) { return { ok: false, error: `JSON parse error: ${e.message}` }; }
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

$('wfId').addEventListener('change', load);
$('wfTitle').addEventListener('change', load);
$('btnScaffold').addEventListener('click', load);
$('btnValidate').addEventListener('click', validate);
$('btnSave').addEventListener('click', save);

$('wfId').value = 'untitled';
load();
