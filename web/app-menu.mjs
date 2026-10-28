/*
 * The one-and-only global navigation. One button at top-left on every page,
 * clicking it opens a dropdown with the app's primary surfaces. Page-specific
 * controls stay in the rest of the top bar.
 *
 * Each page calls `mountAppMenu(container, {here})` and the button + dropdown
 * are injected. `here` lets the current page be marked.
 */
const ITEMS = [
  { key: 'viewer',  label: 'Viewer',   href: '/',                      hint: 'Live Claude Code sessions' },
  { key: 'catalog', label: 'Catalog',  href: '/workflows.html#catalog', hint: 'Workflows you can run' },
  { key: 'runs',    label: 'Runs',     href: '/workflows.html#runs',    hint: 'Every invocation' },
  { key: 'skills',  label: 'Skills',   href: '/workflows.html#skills',  hint: 'What Claude knows how to do' },
];

export function mountAppMenu(container, { here = null } = {}) {
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
    </div>`;
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
