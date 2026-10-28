/*
 * Author a prompt from the browser. Loads a scaffold, lets you edit the .md,
 * validates on demand or on save, writes through POST /api/prompts.
 */
const $ = (id) => document.getElementById(id);

async function scaffold(slug) {
  const r = await fetch(`/api/prompts/scaffold?slug=${encodeURIComponent(slug || 'untitled')}&title=${encodeURIComponent($('pTitle').value || '')}`).then((x) => x.json());
  return r.md;
}

async function load() {
  const md = await scaffold($('pId').value || 'untitled');
  $('pMd').value = md;
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

$('pId').addEventListener('change', load);
$('pTitle').addEventListener('change', load);
$('btnScaffold').addEventListener('click', load);
$('btnValidate').addEventListener('click', validate);
$('btnSave').addEventListener('click', save);

$('pId').value = 'untitled';
load();
