/*
 * Claude, the workflow assistant: a chat panel in the editor that helps a
 * person build, change, fix and understand the workflow in front of them.
 *
 * The conversation is drawn exactly as the Sessions page draws one — same
 * messages, same step checklist, same summaries — from the same summariser
 * on the server. What Claude changes never touches the workflow directly: it
 * comes back as a proposal, listed in plain words and highlighted on the
 * canvas, which the person previews, applies or discards. Applying puts the
 * change on the canvas unsaved; Save is still the one way a workflow changes.
 *
 * The editor passes in a small adapter, so this file knows nothing about how
 * the canvas is drawn.
 */
import { el, toneOf, GLYPH, TONE_TITLE, md, initialsOf, clockOf, message } from './chat-view.mjs';
import { createRotation } from './genz.mjs';

const SPARK = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0.8c.5 3.4 1.6 4.6 5 5.2-3.4.6-4.5 1.8-5 5.2-.5-3.4-1.6-4.6-5-5.2 3.4-.6 4.5-1.8 5-5.2z"/><path d="M13 10.2c.2 1.4.7 1.9 2.1 2.2-1.4.2-1.9.7-2.1 2.1-.2-1.4-.7-1.9-2.1-2.1 1.4-.3 1.9-.8 2.1-2.2z" opacity=".7"/></svg>';
const ICON = {
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  fresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
};

export function claudeButtonHtml() {
  return `<span class="disc">${SPARK}</span>Ask Claude<span class="dot" aria-hidden="true"></span>`;
}

export function mountAssistant(ed) {
  const s = {
    open: false, key: ed.key(), data: null, pendingText: null, sendError: null,
    applied: null, armedReset: false, refreshTimer: null, poll: null, lastFailed: false,
    term: null, rotation: createRotation(),
  };

  const panel = el('aside', { class: 'oc-assist', role: 'dialog', 'aria-label': 'Claude, workflow assistant', 'aria-hidden': 'true' });
  panel.innerHTML = `
    <header class="oa-head">
      <div class="avatar claude">${SPARK}</div>
      <div class="oa-title"><div class="oa-name">Claude</div><div class="oa-sub" id="oaSub">Workflow assistant</div></div>
      <button class="oa-icon" id="oaNew" type="button" title="New conversation" aria-label="New conversation">${ICON.fresh}</button>
      <button class="oa-icon" id="oaClose" type="button" title="Close (Esc)" aria-label="Close">${ICON.close}</button>
    </header>
    <div class="oa-scroll" id="oaScroll"></div>
    <div class="oa-proposal" id="oaProposal" hidden></div>
    <div class="oa-error" id="oaError" role="alert" hidden></div>
    <form class="oa-composer" id="oaForm">
      <textarea id="oaInput" rows="1" placeholder="Ask Claude to build, change or explain this workflow" aria-label="Message Claude"></textarea>
      <div class="oa-row">
        <span class="oa-hint" id="oaHint">Claude reads this workflow, its runs and your project. Nothing changes until you apply it.</span>
        <button class="oa-send" id="oaSend" type="submit" aria-label="Send">${ICON.send}</button>
      </div>
    </form>`;
  document.body.append(panel);
  const $ = (id) => panel.querySelector(`#${id}`);
  const launcher = ed.launcher;
  launcher.innerHTML = claudeButtonHtml();

  /* ------------------------------ talking ------------------------------ */

  const keyQ = () => `key=${encodeURIComponent(s.key)}`;
  async function post(path, body) {
    const r = await fetch(`/api/assistant${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: s.key, ...body }) });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { ok: r.ok, status: r.status, ...j };
  }

  async function refresh() {
    clearTimeout(s.refreshTimer);
    let data;
    try { data = await fetch(`/api/assistant?${keyQ()}`).then((r) => r.json()); }
    catch { return; }
    if (!data?.state) return;
    s.data = data;
    // The message just sent is shown at once, until the transcript has it.
    const turns = data.conversation.turns;
    if (s.pendingText && turns.some((t) => (t.prompt || '').trim() === s.pendingText.trim())) s.pendingText = null;
    if (s.pendingText && !data.state.busy && data.state.lastError) s.pendingText = null;
    // A proposal applied elsewhere, or replaced, ends any preview of it.
    if (ed.isPreviewing() && data.state.proposal?.status !== 'pending') ed.endPreview();
    render();
    clearInterval(s.poll);
    // The event stream is the fast path; this keeps a busy panel honest if
    // the stream drops.
    if (data.state.busy) s.poll = setInterval(refresh, 1500);
  }
  const refreshSoon = () => { clearTimeout(s.refreshTimer); s.refreshTimer = setTimeout(refresh, 150); };

  async function send(text) {
    const t = String(text || '').trim();
    if (!t || s.data?.state?.busy) return;
    s.sendError = null;
    s.applied = null;
    s.pendingText = t;
    s.term = s.rotation.next();
    $('oaInput').value = '';
    grow();
    render();
    const r = await post('/message', { text: t, def: ed.def(), repoRoot: ed.repoRoot() });
    if (!r.ok) { s.pendingText = null; s.sendError = r.error || 'Claude could not start. Try again.'; $('oaInput').value = t; grow(); }
    refresh();
  }

  /* ------------------------------ drawing ------------------------------ */

  function bubble(step) {
    const tone = toneOf(step);
    const bits = [];
    if (step.callCount > 1) bits.push(`${step.callCount} times`);
    return el('div', { class: `bubble tone-${tone}`, title: TONE_TITLE[tone] || '' }, [
      el('span', { class: `icon t-${tone}` }, GLYPH[tone] || ''),
      el('span', { class: 'label' }, [
        el('span', { class: 'text' }, step.label),
        bits.length ? el('span', { class: 'sub' }, bits.join(' · ')) : null,
      ]),
    ]);
  }

  /* The live row: what Claude is doing, in the voice the Sessions page uses. */
  function liveBubble() {
    const st = s.data?.state || {};
    const term = s.term || (s.term = s.rotation.next());
    const secs = Math.max(0, Math.round((st.elapsedMs || 0) / 1000));
    return el('div', { class: 'bubble tone-running', title: term.note || '' }, [
      el('span', { class: 'icon t-running' }),
      el('span', { class: 'label' }, [
        el('span', { class: 'text' }, [el('span', { class: 'vocab-term' }, term.genz), el('span', { class: 'vocab-plain' }, term.plain)]),
        el('span', { class: 'sub' }, [st.progress, secs ? `${secs}s` : null].filter(Boolean).join(' · ') || 'Reading the workflow'),
      ]),
    ]);
  }

  function render() {
    const st = s.data?.state || {};
    $('oaSub').textContent = `Workflow assistant · ${ed.title() || 'new workflow'}`;
    const busy = !!st.busy;
    const sendBtn = $('oaSend');
    sendBtn.classList.toggle('stop', busy);
    sendBtn.innerHTML = busy ? ICON.stop : ICON.send;
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.disabled = !busy && !$('oaInput').value.trim();
    $('oaHint').textContent = st.costUsd > 0
      ? `Nothing changes until you apply it · this conversation $${st.costUsd.toFixed(st.costUsd < 0.1 ? 3 : 2)}`
      : 'Claude reads this workflow, its runs and your project. Nothing changes until you apply it.';
    const err = s.sendError || (!busy && st.lastError && st.lastError !== 'Stopped.' ? st.lastError : null);
    $('oaError').hidden = !err;
    $('oaError').textContent = err || '';
    launcher.classList.toggle('on', s.open);
    launcher.classList.toggle('has-proposal', !s.open && st.proposal?.status === 'pending');
    // Follow the conversation if you were at its end. Measured before drawing
    // and applied after the proposal card, which takes room from the thread.
    const root = $('oaScroll');
    const follow = s.follow || s.pendingText || root.scrollHeight - root.scrollTop - root.clientHeight < 140;
    s.follow = false;
    renderThread();
    renderProposal();
    if (follow) root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
  }

  function renderThread() {
    const root = $('oaScroll');
    root.innerHTML = '';
    const turns = s.data?.conversation?.turns || [];
    const busy = !!s.data?.state?.busy;
    if (!turns.length && !s.pendingText) { root.append(emptyState()); return; }
    const me = s.data?.person || 'You';
    for (const [i, t] of turns.entries()) {
      const last = i === turns.length - 1 && !s.pendingText;
      if (t.prompt) root.append(message({ initials: initialsOf(me), name: me, time: clockOf(t.promptAt) }, el('div', { class: 'msg-text' }, t.prompt)));
      const body = [];
      if (t.intro) body.push(el('div', { class: 'msg-text md', html: md(t.intro) }));
      const running = t.steps.some((x) => x.status === 'running');
      if (t.steps.length || (last && busy && !running)) {
        const list = el('div', { class: 'steps' }, t.steps.map(bubble));
        if (last && busy && !running) list.append(liveBubble());
        body.push(list);
      }
      if (t.summary) body.push(el('div', { class: 'msg-text md summary', html: md(t.summary) }));
      if (body.length) root.append(message({ initials: '', name: 'Claude', time: clockOf(t.steps[t.steps.length - 1]?.startedAt || t.promptAt), claude: true }, body));
    }
    if (s.pendingText) {
      const m = message({ initials: initialsOf(me), name: me, time: clockOf(new Date().toISOString()) }, el('div', { class: 'msg-text' }, s.pendingText));
      root.append(m);
      root.append(message({ initials: '', name: 'Claude', claude: true }, el('div', { class: 'steps' }, liveBubble())));
    }
    // Claude's avatar is the spark, not initials.
    for (const a of root.querySelectorAll('.avatar.claude')) a.innerHTML = SPARK;
  }

  function emptyState() {
    const steps = ed.def()?.graph?.nodes?.length || 0;
    const wrap = el('div', { class: 'oa-empty' });
    const fresh = steps === 0;
    const ideas = fresh ? [
      ['Turn a merged pull request into release notes', 'Reads the PR, drafts the notes, waits for your OK, saves them', false],
      ['Check every page of my site for broken links', 'Visits each page, lists what is broken, saves a report', false],
      ['Every Monday, summarise last week’s commits for the team', 'Reads git history, writes a short summary, asks before posting', false],
    ] : [
      ['Explain what this workflow does, step by step', null, true],
      ...(s.lastFailed ? [['Why did the last run fail, and how do I fix it?', null, true]] : []),
      ['Make it cheaper to run without making it worse', null, true],
      ['Add an approval before anything is published or saved', null, true],
      ['Add retries to steps that might fail for a moment', null, true],
    ];
    wrap.innerHTML = `<div class="avatar claude">${SPARK}</div>
      <h3>${fresh ? 'What should this workflow do?' : `How can I help with “${escapeText(ed.title() || 'this workflow')}”?`}</h3>
      <p>${fresh
        ? 'Describe the job in a sentence or two. Claude drafts the steps, and you review them on the canvas before anything changes.'
        : 'Claude can explain it, change it, or work out why a run went wrong. You review every change before it touches the workflow.'}</p>`;
    const list = el('div', { class: 'oa-suggest' });
    for (const [text, sub, go] of ideas) {
      list.append(el('button', { type: 'button', onclick: () => {
        if (go) send(text);
        else { $('oaInput').value = text; grow(); $('oaInput').focus(); render(); }
      } }, [text, sub ? el('span', {}, sub) : null]));
    }
    wrap.append(list);
    return wrap;
  }

  function renderProposal() {
    const box = $('oaProposal');
    const p = s.data?.state?.proposal;
    if (s.applied) {
      box.hidden = false;
      box.innerHTML = '';
      box.append(el('div', { class: 'oa-note-line' }, [
        el('span', { html: '<b>Applied to the canvas.</b> Save when you are happy with it.' }),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'oa-btn', type: 'button', onclick: undo }, 'Undo'),
        el('button', { class: 'oa-btn primary', type: 'button', onclick: async () => { await ed.save(); s.applied = null; render(); } }, 'Save'),
      ]));
      return;
    }
    if (!p || p.status !== 'pending') { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const previewing = ed.isPreviewing();
    const G = { added: '+', changed: '~', removed: '−' };
    box.innerHTML = '';
    box.append(el('div', { class: 'oa-p-head' }, [
      el('span', { class: 'oa-p-title' }, p.parseError ? 'Claude’s proposal' : `Proposed change${p.lines.length === 1 ? '' : 's'}`),
      el('span', { class: `oa-p-ok${p.valid ? '' : ' bad'}` }, p.valid ? 'Ready to run' : 'Needs fixing'),
    ]));
    if (p.lines?.length) box.append(el('ul', { class: 'oa-p-lines' }, p.lines.map((l) => el('li', { class: l.kind }, [el('span', { class: 'g' }, G[l.kind] || '·'), el('span', {}, l.text)]))));
    const issues = p.parseError ? [p.parseError] : p.problems || [];
    if (issues.length) {
      box.append(el('div', { class: 'oa-p-problems' }, [
        el('span', {}, 'It would not run yet:'),
        el('ul', {}, issues.slice(0, 4).map((x) => el('li', {}, x))),
      ]));
    }
    const actions = el('div', { class: 'oa-p-actions' });
    if (!p.parseError) {
      actions.append(el('button', { class: `oa-btn${previewing ? ' on' : ''}`, type: 'button', onclick: togglePreview },
        previewing ? 'Stop previewing' : 'Preview on canvas'));
    }
    actions.append(el('span', { class: 'spacer' }));
    if (issues.length) actions.append(el('button', { class: 'oa-btn', type: 'button', onclick: () => send(`Please fix these problems with your proposal:\n${issues.map((x) => `- ${x}`).join('\n')}`) }, 'Ask Claude to fix'));
    actions.append(el('button', { class: 'oa-btn', type: 'button', onclick: discard }, 'Discard'));
    actions.append(el('button', { class: 'oa-btn primary', type: 'button', disabled: p.valid ? null : '', onclick: apply,
      title: p.valid ? 'Put these changes on the canvas, unsaved' : 'Fix the problems first' }, 'Apply'));
    box.append(actions);
  }

  /* ----------------------------- proposals ----------------------------- */

  function togglePreview() {
    const p = s.data?.state?.proposal;
    if (!p?.draft) return;
    if (ed.isPreviewing()) ed.endPreview();
    else ed.preview(p.draft, p.diff);
    renderProposal();
  }
  async function apply() {
    const p = s.data?.state?.proposal;
    if (!p?.draft || !p.valid) return;
    if (ed.isPreviewing()) ed.endPreview();
    const undoFn = ed.apply(p.draft, p.diff);
    s.applied = { undo: undoFn };
    await post('/resolve', { action: 'applied' });
    refresh();
  }
  function undo() {
    s.applied?.undo?.();
    s.applied = null;
    render();
  }
  async function discard() {
    if (ed.isPreviewing()) ed.endPreview();
    await post('/resolve', { action: 'discarded' });
    refresh();
  }

  /* ------------------------------ controls ----------------------------- */

  function grow() {
    const t = $('oaInput');
    t.style.height = 'auto';
    t.style.height = `${Math.min(180, t.scrollHeight)}px`;
  }

  async function open() {
    if (s.open) return;
    s.open = true;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('assist-open');
    s.follow = true; // opening shows the latest of the conversation
    const id = ed.def()?.id;
    if (id) {
      fetch(`/api/runs?workflow=${encodeURIComponent(id)}&limit=5`).then((r) => r.json())
        .then((r) => { s.lastFailed = r.runs?.[0]?.status === 'failed'; if (!s.data?.conversation?.turns?.length) render(); })
        .catch(() => {});
    }
    await refresh();
    setTimeout(() => $('oaInput').focus(), 60);
  }
  function close() {
    if (!s.open) return;
    if (ed.isPreviewing()) ed.endPreview();
    s.open = false;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('assist-open');
    clearInterval(s.poll);
    render();
    launcher.focus();
  }

  launcher.addEventListener('click', () => (s.open ? close() : open()));
  $('oaClose').addEventListener('click', close);
  $('oaNew').addEventListener('click', async () => {
    const b = $('oaNew');
    // Two presses, not a dialog: the first arms it.
    if (!s.armedReset) {
      s.armedReset = true;
      b.title = 'Press again to start a new conversation';
      b.style.color = 'var(--t-ask)';
      setTimeout(() => { s.armedReset = false; b.title = 'New conversation'; b.style.color = ''; }, 3000);
      return;
    }
    s.armedReset = false; b.style.color = ''; b.title = 'New conversation';
    if (ed.isPreviewing()) ed.endPreview();
    s.applied = null; s.pendingText = null; s.sendError = null;
    await post('/reset', {});
    refresh();
  });
  $('oaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (s.data?.state?.busy) { post('/stop', {}).then(refresh); return; }
    send($('oaInput').value);
  });
  $('oaInput').addEventListener('input', () => { grow(); $('oaSend').disabled = !s.data?.state?.busy && !$('oaInput').value.trim(); });
  $('oaInput').addEventListener('keydown', (e) => {
    // Enter sends and Shift+Enter starts a new line, as in the Sessions composer.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('oaForm').requestSubmit(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); s.open ? close() : open(); return; }
    if (e.key === 'Escape' && s.open) {
      // Step back one thing at a time: the preview first, then the panel.
      if (ed.isPreviewing()) { ed.endPreview(); renderProposal(); return; }
      close();
    }
  });

  if (!new URLSearchParams(location.search).has('snapshot')) {
    const es = new EventSource('/events');
    es.addEventListener('assistant', (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch { /* none */ }
      if (!d.key || d.key === s.key) refreshSoon();
    });
  }
  // A proposal waiting from an earlier visit shows on the launcher.
  refresh();

  return {
    open, close,
    /** The workflow was saved for the first time: its conversation follows. */
    async rekey(next) {
      if (!next || next === s.key) return;
      const prev = s.key;
      s.key = next;
      if (prev.startsWith('new:')) await fetch('/api/assistant/rekey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: prev, to: next }) }).catch(() => {});
      refresh();
    },
    renderProposal,
  };
}

function escapeText(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
