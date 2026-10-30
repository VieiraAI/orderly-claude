/*
 * The conversation, drawn: a message with its avatar, name and time; just
 * enough markdown for a reply to read cleanly; and the colour each kind of
 * step takes. Shared by the Sessions page and the workflow assistant, so
 * both read the same way and cannot drift apart.
 */

export const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid != null) n.append(kid);
  return n;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * What kind of work a step was, which decides its colour.
 * fix = it hit a problem and recovered; visual = it has a before/after.
 */
export function toneOf(s) {
  // A decision point outranks everything: it is the one state that will not
  // move on its own, so it must be the one that catches the eye.
  if (s.needsUser && !s.userResolved) return 'ask';
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  if (s.needsUser) return 'asked';
  if (s.status === 'warn') return 'fix';
  if (s.visualChanged) return 'visual';
  if (s.kind === 'inspect') return 'inspect';
  return 'done';
}

const CHECK = '✓';
export const GLYPH = {
  done: CHECK, fix: CHECK, visual: CHECK, inspect: CHECK, asked: CHECK,
  failed: '✕', ask: '?', running: '', pending: '',
};

export const TONE_TITLE = {
  done: 'done',
  fix: 'hit a problem and fixed it',
  visual: 'done — has a before/after',
  inspect: 'looked, changed nothing',
  failed: 'failed',
  running: 'working on this now',
  ask: 'waiting on you — Claude needs a decision here',
  asked: 'you were asked, and you answered',
};

export function inlineMd(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Just enough markdown for a chat message to read cleanly. */
export function md(text) {
  const lines = esc(text).split('\n');
  const out = [];
  let inList = false, inCode = false, code = [];
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push(`<pre class="md-pre">${code.join('\n')}</pre>`); code = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) {
      closeList();
      out.push(`<h${head[1].length + 2} class="md-h">${inlineMd(head[2])}</h${head[1].length + 2}>`);
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre class="md-pre">${code.join('\n')}</pre>`);
  return out.join('');
}

export const initialsOf = (name = '') =>
  name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'ME';

export const clockOf = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

/** One message in the conversation: avatar, name, time, body. */
export function message({ initials, name, time, claude = false }, body) {
  return el('div', { class: 'msg' }, [
    el('div', { class: `avatar${claude ? ' claude' : ''}` }, initials),
    el('div', { class: 'msg-body' }, [
      el('div', { class: 'msg-head' }, [
        el('span', { class: 'name' }, name),
        time ? el('span', { class: 'time' }, time) : null,
      ]),
      ...[].concat(body).filter(Boolean),
    ]),
  ]);
}
