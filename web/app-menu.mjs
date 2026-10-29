/*
 * The one-and-only global navigation. One button at top-left on every page,
 * clicking it opens a dropdown with the app's primary surfaces. Page-specific
 * controls stay in the rest of the top bar.
 *
 * Each page calls `mountAppMenu(container, {here})` and the button + dropdown
 * are injected. `here` lets the current page be marked.
 */
const ITEMS = [
  { key: 'sessions',  label: 'Sessions',  href: '/',                         hint: 'Your live Claude Code terminals' },
  { key: 'workflows', label: 'Workflows', href: '/workflows.html#workflows', hint: 'A job you run the same way every time' },
  { key: 'prompts',   label: 'Prompts',   href: '/workflows.html#prompts',   hint: 'One saved message, with blanks to fill in' },
  { key: 'runs',      label: 'Runs',      href: '/workflows.html#runs',      hint: 'The receipt for every workflow you ran' },
  { key: 'decisions', label: 'Decisions', href: '/workflows.html#decisions', hint: 'Every time you chose a direction' },
  { key: 'skills',    label: 'Skills',    href: '/workflows.html#skills',    hint: 'What Claude knows how to do' },
];

export function mountAppMenu(container, { here = null, theme = false } = {}) {
  if (!container) return;
  container.innerHTML = `
    <button class="app-menu-btn" aria-haspopup="true" aria-expanded="false" title="Menu">
      <span class="app-menu-glyph">◇</span>
      <span class="app-menu-brand">Orderly</span>
      <span class="app-menu-caret">⌄</span>
    </button>
    <div class="app-menu-drop" role="menu" hidden>
      ${ITEMS.map((i) => `
        <a role="menuitem" href="${i.href}" data-key="${i.key}"
           class="app-menu-item${i.key === here ? ' on' : ''}">
          <span class="k">${i.label}</span>
          <span class="h">${i.hint}</span>
        </a>`).join('')}
      ${theme ? `<button role="menuitem" class="app-menu-item app-menu-theme" type="button">
          <span class="k">${themeLabel()}</span>
          <span class="h">Same setting as the session view</span>
        </button>` : ''}
    </div>`;
  container.querySelector('.app-menu-theme')?.addEventListener('click', (e) => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('cz-theme', next); } catch {}
    e.currentTarget.querySelector('.k').textContent = themeLabel();
  });
  const btn  = container.querySelector('.app-menu-btn');
  const drop = container.querySelector('.app-menu-drop');
  const close = () => { drop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open  = () => { drop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.hidden ? open() : close();
  });
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

function themeLabel() {
  return document.documentElement.dataset.theme === 'dark' ? 'Switch to light' : 'Switch to dark';
}
