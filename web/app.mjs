import { createRotation } from './genz.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  sessionId: null, live: true, session: null, activeStep: null,
  tab: 'detail', results: [], sel: 0, run: { status: 'idle', busy: false }, person: null, tabs: [],
  activity: null, devUrl: null, build: null, think: { word: 0, tick: 0, since: null },
  voice: (() => { try { return localStorage.getItem('cz-voice') || 'genz'; } catch { return 'genz'; } })(),
};

const el = (tag, attrs = {}, kids = []) => {
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
const layoutEl = () => document.querySelector('.layout');

/*
 * Connection state.
 *
 * A viewer that quietly stops updating is worse than one that says it has
 * lost the server: the page looks like the work stopped. Every request goes
 * through here, so one failure shows and one success clears it.
 */
let online = true;
function setConnected(ok, note) {
  const banner = document.getElementById('connBanner');
  if (banner) {
    banner.classList.toggle('hidden', ok);
    const text = document.getElementById('connText');
    if (text && !ok) text.textContent = note || 'Lost connection to Orderly Claude — retrying…';
  }
  document.getElementById('liveDot')?.classList.toggle('offline', !ok);
  if (ok === online) return;
  online = ok;
  if (ok) { refresh(); loadRail(); } // catch up on whatever was missed
}

/** Every call to the server; a failure marks us offline rather than throwing. */
async function api(path, options) {
  try {
    const res = await fetch(path, options);
    if (res.status >= 500) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    setConnected(true);
    return data;
  } catch {
    setConnected(false);
    return null;
  }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

/**
 * What kind of work a step was, which decides its colour.
 * fix = it hit a problem and recovered; visual = it has a before/after.
 */
function toneOf(s) {
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
const GLYPH = {
  done: CHECK, fix: CHECK, visual: CHECK, inspect: CHECK, asked: CHECK,
  failed: '✕', ask: '?', running: '', pending: '',
};

const TONE_TITLE = {
  done: 'done',
  fix: 'hit a problem and fixed it',
  visual: 'done — has a before/after',
  inspect: 'looked, changed nothing',
  failed: 'failed',
  running: 'working on this now',
  ask: 'waiting on you — Claude needs a decision here',
  asked: 'you were asked, and you answered',
};

/*
 * Shown only while work is genuinely in flight.
 *
 * Three voices, cycled by clicking the word:
 *   plain — says what it is
 *   genz  — a plain term and how it is said now
 *   booth — original lines in a hip-hop register (not song lyrics)
 */
const VOICES = {
  plain: [
    'Percolating', 'Noodling', 'Tinkering', 'Simmering', 'Pondering', 'Whirring',
    'Mulling', 'Brewing', 'Puttering', 'Rummaging', 'Cogitating', 'Frolicking',
    'Boogieing', 'Ruminating', 'Beavering', 'Marinating',
  ],
  booth: [
    'Still in the lab', 'Back on the ones and twos', 'Laying it down',
    'Cooking in the booth', 'Running it back', 'Finding the pocket',
    'Chopping it up', 'Letting it ride', 'Warming up the mix',
    'Holding the beat down', 'Threading the verse', 'Keeping time',
  ],
};

/* Works through all 106 terms before any comes round again. */
const genz = createRotation();
let term = genz.next();

const VOICE_ORDER = ['genz', 'plain', 'booth'];

/* ---------- timeline ---------- */

function bubble(step) {
  const tone = toneOf(step);
  const bits = [];
  if (step.callCount > 1) bits.push(`${step.callCount} commands`);
  if (step.fileCount) bits.push(`${step.fileCount} file${step.fileCount > 1 ? 's' : ''}`);
  if (step.startedAt && step.endedAt && tone !== 'running') {
    const ms = Date.parse(step.endedAt) - Date.parse(step.startedAt);
    if (ms > 1500) bits.push(`${(ms / 1000).toFixed(1)}s`);
  }
  const tags = [];
  // A decision is the thing worth seeing first, so it leads the row.
  if (tone === 'ask') tags.push(el('span', { class: 'tag ask' }, 'needs you'));
  else if (tone === 'asked') tags.push(el('span', { class: 'tag asked' }, 'you decided'));
  if (step.hasShots) {
    tags.push(step.visualChanged
      ? el('span', { class: 'tag shot' }, 'before & after')
      : el('span', { class: 'tag' }, 'no visible change'));
  }
  if (step.emergent && step.status === 'warn') tags.push(el('span', { class: 'tag emergent' }, 'unplanned'));

  return el('button', {
    class: `bubble tone-${tone}${state.activeStep === step.id ? ' active' : ''}`,
    title: TONE_TITLE[tone] || '',
    onclick: () => openStep(step.id),
  }, [
    el('span', { class: `icon t-${tone}` }, GLYPH[tone] || ''),
    el('span', { class: 'label' }, [
      el('span', { class: 'text' }, step.label),
      tone === 'running'
        ? el('span', { class: 'sub live' }, vocabNodes())
        : bits.length ? el('span', { class: 'sub' }, bits.join(' \u00b7 ')) : null,
    ]),
    el('span', { class: 'tags' }, tags),
  ]);
}

const VOICE_LABEL = { plain: 'thinking', booth: 'in the booth' };

/**
 * One quiet line: the slang, the plain phrase it stands for, and the clock.
 * The meaning is on hover — a definition set under every row made the
 * checklist heavy, and this row is one item in it, not a panel.
 */
function asVocab({ main, aka, note }) {
  if (!aka) return { term: main, plain: VOICE_LABEL[state.voice] || '', note: '' };
  return { term: aka, plain: main.toLowerCase(), note };
}

function vocabText() {
  return asVocab(thinkingLabel());
}

const VOICE_TAG = { genz: 'gen z', plain: 'thinking', booth: 'booth' };

function vocabNodes() {
  const { term: word, plain } = vocabText();
  return [
    el('span', { class: 'vocab' }, [
      el('span', {
        class: 'vocab-tag', id: 'liveTag', title: 'Click to change voice',
        onclick: (e) => { e.stopPropagation(); cycleVoice(); },
      }, VOICE_TAG[state.voice] || ''),
      el('span', { class: 'vocab-term', id: 'liveTerm' }, word),
      plain ? el('span', { class: 'vocab-plain', id: 'liveDef' }, plain) : null,
      el('span', { class: 'vocab-time', id: 'liveTime' }, elapsedLabel()),
    ]),
  ];
}

/** The meaning belongs in the tooltip, not in the row. */
function liveTitle() {
  const { term: word, plain, note } = vocabText();
  const lead = plain ? `${word} \u2014 ${plain}` : word;
  return `${lead}${note ? `. ${note}.` : '.'} Click to change voice.`;
}

/**
 * The live row, shown as the next item in the checklist of the message it
 * belongs to — never as a message of its own, which read as Claude starting
 * a second reply. Omitted when a step is already spinning in the list,
 * because that step is the live one.
 */
function waitingBubble(label) {
  return el('div', { class: 'bubble live waiting', title: 'Claude is waiting for you' }, [
    el('span', { class: 'icon t-ask' }, '?'),
    el('span', { class: 'label' }, el('span', { class: 'text' }, [
      el('span', { class: 'vocab-term' }, 'Waiting on you'),
      label ? el('span', { class: 'vocab-plain' }, label) : null,
    ])),
  ]);
}

function thinkingBubble() {
  const stalled = state.activity?.quietMs > 45000;
  return el('div', {
    class: `bubble live${stalled ? ' stalled' : ''}`,
    title: liveTitle(),
  }, [
    el('span', { class: 'icon t-running' }),
    el('span', { class: 'label' }, vocabNodes()),
  ]);
}

const isStalled = () => state.activity?.quietMs > 45000;

/** The word for the current voice, whatever else is going on. */
function currentTerm() {
  if (state.voice === 'genz') return { main: term.plain, aka: term.genz, note: term.note };
  const list = VOICES[state.voice] || VOICES.plain;
  return { main: list[state.think.word % list.length], aka: null, note: null };
}

function thinkingLabel() {
  // A stall is reported plainly whatever the voice; it is not a joke.
  if (isStalled()) return { main: 'Still working', aka: null, note: null };
  return currentTerm();
}

/** Move to the next word; the Gen Z rotation has its own order. */
function advanceVoice() {
  if (state.voice === 'genz') term = genz.next();
  else state.think.word++;
}

/* Updates whichever live row is on screen, without redrawing the page. */
function paintLive() {
  const { term: word, plain } = vocabText();
  const termEl = document.getElementById('liveTerm');
  const defEl = document.getElementById('liveDef');
  const timeEl = document.getElementById('liveTime');
  if (termEl) termEl.textContent = word;
  if (defEl) defEl.textContent = plain;
  if (timeEl) timeEl.textContent = elapsedLabel();
  const row = document.querySelector('.bubble.live, .bubble .sub.live');
  if (row) row.title = liveTitle();
}

function elapsedLabel() {
  const act = state.activity;
  if (act?.quietMs > 45000) {
    return `nothing new for ${Math.round(act.quietMs / 1000)}s`;
  }
  if (!state.think.since) return '';
  const secs = Math.round((Date.now() - state.think.since) / 1000);
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

function cycleVoice() {
  const i = VOICE_ORDER.indexOf(state.voice);
  state.voice = VOICE_ORDER[(i + 1) % VOICE_ORDER.length];
  try { localStorage.setItem('cz-voice', state.voice); } catch {}
  advanceVoice();
  paintLive();
}

/*
 * Claude thinking writes nothing to the transcript for seconds at a time, so
 * waiting on file growth leaves the UI looking finished while work goes on.
 * Ask directly, often, and cheaply.
 */
async function pollActivity() {
  if (!state.live) return;
  const data = await api('/api/activity');
  if (!data?.activity) return;

  const was = !!state.activity?.working;
  const now = !!data.activity.working;
  state.activity = data.activity;
  if (data.run) paintRun(data.run);
  if (data.tabs) renderTabs(data.tabs);

  if (now && !was) {
    state.think.since = Date.now();
    advanceVoice();
    renderTimeline();
  } else if (now !== was) {
    state.think.since = null;
    renderTimeline();
  } else {
    paintLive();
  }
}
setInterval(pollActivity, 2500);

/* One ticker: advances the word and the clock without redrawing the page. */
setInterval(() => {
  if (!state.activity?.working) return;
  state.think.tick = (state.think.tick || 0) + 1;
  paintLive();
  if (state.activity) state.activity.quietMs += 1000;
}, 1000);

/** Inline markdown: code, bold, italic, links. Input is already escaped. */
function inlineMd(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Just enough markdown for a chat message to read cleanly. */
function md(text) {
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

const initialsOf = (name = '') =>
  name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'ME';

const clockOf = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

/** One message in the conversation: avatar, name, time, body. */
function message({ initials, name, time, claude = false }, body) {
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

function renderTimeline() {
  const root = $('timeline');
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 180;
  root.innerHTML = '';
  const turns = state.session?.turns || [];
  if (!turns.length) {
    const fresh = state.tabs.find((x) => x.active)?.fresh;
    root.append(el('div', { class: 'empty' }, fresh
      ? 'New session. Type below and Claude starts here \u2014 no terminal needed.'
      : 'Nothing yet.'));
    return;
  }

  const me = state.person || 'You';

  for (const [index, turn] of turns.entries()) {
    const isLast = index === turns.length - 1;
    // Work still in flight belongs to the message it started in.
    const live = isLast && !!state.activity?.working;
    // Claude idle with an unanswered question is not finished; it is your turn.
    const openAsk = isLast && !state.activity?.working
      && [...turn.steps].reverse().find((s) => s.needsUser && !s.userResolved);
    // Read this from the steps being drawn, not from the activity payload:
    // the two are separate requests and can disagree for a moment, which put
    // a live row and a spinning step on screen together.
    const stepRunning = turns.some((t) => t.steps.some((s) => s.status === 'running'));
    const liveNeedsRow = live && !stepRunning;

    if (turn.prompt) {
      root.append(message(
        { initials: initialsOf(me), name: me, time: clockOf(turn.promptAt) },
        el('div', { class: 'msg-text said clamp', id: `turn-${turn.id}` }, turn.prompt),
      ));
    }

    const hasWork = turn.steps.length || (turn.pending || []).length || turn.intro || turn.summary || live;
    if (!hasWork) continue;

    const body = [];
    if (turn.intro) body.push(el('div', { class: 'msg-text md', html: md(turn.intro) }));

    if (turn.steps.length || (turn.pending || []).length || liveNeedsRow || openAsk) {
      const list = el('div', { class: 'steps' });
      for (const s of turn.steps) list.append(bubble(s));
      for (const p of turn.pending || []) {
        list.append(el('div', { class: 'bubble pending' }, [
          el('span', { class: 'icon pending' }, ''),
          el('span', { class: 'label' }, el('span', { class: 'text' }, p)),
        ]));
      }
      if (liveNeedsRow) list.append(thinkingBubble());
      else if (openAsk) list.append(waitingBubble(openAsk.label));
      body.push(list);
    }

    if (turn.summary) body.push(el('div', { class: 'msg-text summary md clamp', html: md(turn.summary) }));

    const last = turn.steps[turn.steps.length - 1];
    root.append(message(
      { initials: 'C', name: 'Claude', time: clockOf(last?.startedAt || turn.promptAt), claude: true },
      body,
    ));
  }
  if (atBottom) root.scrollTop = root.scrollHeight;
}

/* ---------- drawer ---------- */

/**
 * A file's changes.
 *
 * A whole-file write used to render as hundreds of identical green rows with
 * the right-hand side cut off, which tells you nothing and hides the rest. So:
 * a header that says the shape of the change, long lines that wrap instead of
 * disappearing, and anything large folded until asked for.
 */
function diffView(change) {
  const lines = change.hunks.reduce((n, h) => n + h.length, 0);
  const { added, removed } = change.stats;
  const big = lines > 14;

  const bar = (() => {
    const total = Math.max(1, added + removed);
    const wrap = el('span', { class: 'stat-bar', title: `${added} added, ${removed} removed` });
    if (added) wrap.append(el('span', { class: 'bar-add', style: `flex:${added}` }));
    if (removed) wrap.append(el('span', { class: 'bar-del', style: `flex:${removed}` }));
    return total ? wrap : null;
  })();

  const body = el('div', { class: `file-body${big ? ' folded' : ''}` });
  for (const hunk of change.hunks) {
    const h = el('div', { class: 'hunk' });
    for (const op of hunk) {
      const kind = op.t === 'add' ? 'add' : op.t === 'del' ? 'del' : 'same';
      h.append(el('div', { class: `row ${kind}` }, [
        el('span', { class: 'ln' }, String((op.t === 'add' ? op.b : op.a) + 1)),
        el('span', { class: 'sign' }, op.t === 'add' ? '+' : op.t === 'del' ? '\u2212' : ''),
        el('span', { class: 'code' }, op.line === '' ? '\u00a0' : op.line),
      ]));
    }
    body.append(h);
  }

  const file = el('div', { class: 'file' }, [
    el('div', { class: 'file-head' }, [
      el('span', { class: 'fname', title: change.path }, change.name),
      change.isNew ? el('span', { class: 'fbadge' }, 'new file') : null,
      el('span', { class: 'fspace' }),
      bar,
      el('span', { class: 'fstat' }, [
        added ? el('span', { class: 'plus' }, `+${added}`) : null,
        removed ? el('span', { class: 'minus' }, `\u2212${removed}`) : null,
      ]),
    ]),
    body,
  ]);

  if (big) {
    const toggle = el('button', { class: 'file-more' }, `Show all ${lines} lines`);
    toggle.onclick = () => {
      const folded = body.classList.toggle('folded');
      toggle.textContent = folded ? `Show all ${lines} lines` : 'Show less';
    };
    file.append(toggle);
  }
  return file;
}

function compareView(shots) {
  const src = (s) => `/api/shot?f=${encodeURIComponent(s.file)}`;
  const wrap = el('div', { class: 'compare' });
  if (!shots?.before || !shots?.after) {
    const only = shots?.after || shots?.before;
    if (!only) return null;
    wrap.append(el('div', { class: 'shot' }, [
      el('img', { src: src(only) }),
      el('div', { class: 'cap' }, 'after · no baseline captured'),
    ]));
    return wrap;
  }

  const sbs = el('div', { class: 'sbs' }, [
    el('div', { class: 'shot' }, [el('img', { src: src(shots.before) }), el('div', { class: 'cap' }, 'before')]),
    el('div', { class: 'shot' }, [el('img', { src: src(shots.after) }), el('div', { class: 'cap' }, 'after')]),
  ]);

  // The after image sits at full size on top of the before image and is
  // *clipped*, so dragging reveals it. Resizing a wrapper instead would
  // squash the picture and slide it about.
  const beforeImg = el('img', { class: 'shot-before', src: src(shots.before), alt: 'before' });
  const afterImg = el('img', { class: 'shot-after', src: src(shots.after), alt: 'after' });
  const handle = el('div', { class: 'handle' });
  const slider = el('div', {
    class: 'slider hidden', role: 'slider', tabindex: '0',
    'aria-label': 'Compare before and after', 'aria-valuemin': '0', 'aria-valuemax': '100',
  }, [
    beforeImg,
    afterImg,
    el('span', { class: 'swipe-label left' }, 'before'),
    el('span', { class: 'swipe-label right' }, 'after'),
    handle,
  ]);

  let pct = 50;
  const setPos = (value) => {
    pct = Math.max(0, Math.min(100, value));
    afterImg.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = `${pct}%`;
    slider.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const posFrom = (e) => {
    const r = slider.getBoundingClientRect();
    return r.width ? ((e.clientX - r.left) / r.width) * 100 : 50;
  };

  // Pointer capture keeps the drag alive outside the element, and avoids the
  // window listeners that used to pile up every time a step was opened.
  slider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { slider.setPointerCapture(e.pointerId); } catch {}
    setPos(posFrom(e));
  });
  slider.addEventListener('pointermove', (e) => {
    if (e.buttons === 1 || slider.hasPointerCapture(e.pointerId)) setPos(posFrom(e));
  });
  const release = (e) => {
    try { slider.releasePointerCapture(e.pointerId); } catch {}
  };
  slider.addEventListener('pointerup', release);
  slider.addEventListener('pointercancel', release);
  slider.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPos(pct - step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setPos(pct + step); }
  });
  setPos(50);

  const bSbs = el('button', { class: 'btn', onclick: () => { sbs.classList.remove('hidden'); slider.classList.add('hidden'); } }, 'side by side');
  const bSwipe = el('button', { class: 'btn', onclick: () => { sbs.classList.add('hidden'); slider.classList.remove('hidden'); } }, 'swipe');
  wrap.append(el('div', { class: 'compare-controls' }, [bSbs, bSwipe]), sbs, slider);
  return wrap;
}

/**
 * Plain language, for someone who does not want to read commands:
 * what the step did and whether it worked.
 */
function plainSummary(step, changes = []) {
  const calls = step.calls || [];
  const shell = calls.filter((c) => c.tool === 'Bash').length;
  const looked = calls.filter((c) => ['Read', 'Grep', 'Glob'].includes(c.tool)).length;
  const failed = calls.filter((c) => c.isError).length;
  const files = changes.length;
  const added = changes.reduce((n, c) => n + (c.stats?.added || 0), 0);
  const removed = changes.reduce((n, c) => n + (c.stats?.removed || 0), 0);

  let headline;
  if (step.status === 'running') headline = 'Claude is working on this now.';
  else if (step.status === 'failed') headline = 'This did not work.';
  else if (files) {
    headline = `Changed ${files} file${files === 1 ? '' : 's'}.`;
    if (step.status === 'warn') headline = `Changed ${files} file${files === 1 ? '' : 's'}, after fixing a problem along the way.`;
  } else if (step.kind === 'inspect') headline = 'Looked at things. Nothing was changed.';
  else if (step.status === 'warn') headline = 'Hit a problem and worked around it.';
  else headline = 'Ran some work. Nothing changed on disk.';

  const facts = [];
  for (const c of changes.slice(0, 8)) {
    const bits = [];
    if (c.stats?.added) bits.push(`${c.stats.added} line${c.stats.added === 1 ? '' : 's'} added`);
    if (c.stats?.removed) bits.push(`${c.stats.removed} removed`);
    facts.push(`${c.name}${c.isNew ? ' (new file)' : ''}${bits.length ? ` \u2014 ${bits.join(', ')}` : ''}`);
  }
  if (changes.length > 8) facts.push(`\u2026 and ${changes.length - 8} more files`);
  if (files > 1) facts.push(`${added} lines added and ${removed} removed in all`);
  if (shell) facts.push(`${shell} command${shell === 1 ? '' : 's'} run`);
  if (looked) facts.push(`${looked} file${looked === 1 ? '' : 's'} read`);
  if (failed) facts.push(`${failed} step${failed === 1 ? '' : 's'} failed and had to be retried`);
  if (step.shots?.after) {
    facts.push(step.shots.changed
      ? 'The app looks different afterwards \u2014 see Before / after'
      : 'A screenshot was taken; the app looks the same');
  }
  return { headline, facts };
}

async function openStep(id) {
  state.activeStep = id;
  history.replaceState(null, '', `#${state.sessionId}/${id}/${state.tab}`);
  renderTimeline();
  $('drawer').setAttribute('aria-hidden', 'false');
  layoutEl().classList.add('drawer-open');
  $('drawerBody').innerHTML = '<div class="note">Loading…</div>';

  const q = new URLSearchParams({ id, ...(state.live ? {} : { session: state.sessionId }) });
  const data = await api(`/api/step?${q}`);
  if (!data) { $('drawerBody').innerHTML = '<div class="note">Lost connection — reopen when it returns.</div>'; return; }
  if (data.error) { $('drawerBody').innerHTML = `<div class="note">${esc(data.error)}</div>`; return; }

  const step = data.step;
  $('drawerLabel').textContent = step.label;
  $('drawerMeta').textContent = [
    step.status, `${step.calls.length} call${step.calls.length > 1 ? 's' : ''}`,
    step.emergent ? 'unplanned' : 'planned',
    step.startedAt ? new Date(step.startedAt).toLocaleTimeString() : null,
  ].filter(Boolean).join(' · ');

  const tabs = [
    ['detail', 'What happened'],
    ['changes', `Changes${data.changes.length ? ` (${data.changes.length})` : ''}`],
    ['visual', 'Before / after'],
    ['thinking', 'Reasoning'],
  ];
  const tabBar = $('drawerTabs');
  tabBar.innerHTML = '';
  for (const [key, label] of tabs) {
    tabBar.append(el('button', {
      class: `tab${state.tab === key ? ' active' : ''}`,
      onclick: () => { state.tab = key; paint(); },
    }, label));
  }

  function paint() {
    for (const [i, t] of [...tabBar.children].entries()) t.classList.toggle('active', tabs[i][0] === state.tab);
    const body = $('drawerBody');
    body.innerHTML = '';

    if (state.tab === 'detail') {
      const { headline, facts } = plainSummary(step, data.changes);
      body.append(el('div', { class: 'headline' }, headline));
      if (facts.length) {
        body.append(el('ul', { class: 'facts' }, facts.map((f) => el('li', {}, f))));
      }
      for (const note of step.notes || []) {
        body.append(el('div', { class: 'note said md', html: md(note) }));
      }
      body.append(el('div', { class: 'hint-line' }, 'The commands and their output are under Reasoning.'));
    }

    if (state.tab === 'changes') {
      if (!data.changes.length) body.append(el('div', { class: 'note' }, 'No file changes in this step.'));
      for (const ch of data.changes) body.append(diffView(ch));
    }

    if (state.tab === 'visual') {
      const v = compareView(data.shots);
      if (v) body.append(v);
      else body.append(el('div', { class: 'note' },
        'No screenshots for this step. Orderly Claude captures them automatically when a dev server is running — start your app and the next change will have a before/after.'));
    }

    if (state.tab === 'thinking') {
      const th = data.thinking || [];
      if (th.length) {
        body.append(el('h4', {}, 'Claude\u2019s reasoning'));
        for (const t of th) body.append(el('div', { class: 'note md', html: md(t) }));
      }
      if (!step.calls.length) {
        body.append(el('div', { class: 'note' }, 'Nothing was run in this step.'));
      }
      for (const c of step.calls) {
        body.append(el('h4', {}, c.toolLabel + (c.isError ? ' \u2014 failed' : '')));
        const input = c.input.command || c.input.file_path || c.input.pattern || c.input.query
          || JSON.stringify(c.input, null, 2).slice(0, 1200);
        body.append(el('pre', { class: 'block cmd' }, input));
        if (c.result) body.append(el('pre', { class: 'block' }, c.result.slice(0, 6000)));
      }
    }
  }
  paint();
}

/** Open whatever step the URL points at, so a step can be linked to directly. */
async function openFromHash() {
  const m = location.hash.match(/^#([^/]+)\/(s\d+)(?:\/(\w+))?$/);
  if (!m) return false;
  const [, sid, stepId, tab] = m;
  if (tab) state.tab = tab;
  if (sid && sid !== state.sessionId) await switchSession(sid);
  await openStep(stepId);
  return true;
}

function closeDrawer() {
  if ($('drawer').getAttribute('aria-hidden') === 'true') return;
  $('drawer').setAttribute('aria-hidden', 'true');
  layoutEl().classList.remove('drawer-open');
  state.activeStep = null;
  history.replaceState(null, '', location.pathname);
  renderTimeline();
}

$('drawerClose').onclick = closeDrawer;

/*
 * Clicking away closes the panel.
 *
 * Where the press began matters, not where it ended: selecting text inside
 * the panel and releasing past its edge is still reading, not dismissing.
 */
let pressedInsideDrawer = false;
document.addEventListener('pointerdown', (e) => {
  pressedInsideDrawer = !!e.target.closest?.('.drawer');
}, true);

document.addEventListener('click', (e) => {
  if ($('drawer').getAttribute('aria-hidden') === 'true') return;
  if (pressedInsideDrawer) return;
  const t = e.target;
  if (t.closest?.('.drawer')) return;
  if (t.closest?.('.bubble')) return;        // opening another step, not leaving
  if (t.closest?.('.search-overlay')) return;
  closeDrawer();
});

/* ---------- rail ---------- */

async function loadRail() {
  const [inst, sess] = await Promise.all([
    api('/api/instances'),
    api('/api/sessions'),
  ]);
  if (!inst || !sess) return;
  const { instances } = inst;
  const { sessions } = sess;

  // Every terminal on this machine, with the one in front marked.
  const termData = await api('/api/terminals');
  const liveBox = $('liveSessions');
  liveBox.innerHTML = '';
  const openIds = new Set((termData?.tabs || state.tabs || []).map((x) => x.sessionId));
  const terminals = termData?.terminals || [];

  if (!terminals.length) {
    liveBox.append(el('div', { class: 'item' }, el('div', { class: 'l2' }, 'none running')));
  }
  for (const x of terminals) {
    const isOpen = openIds.has(x.sessionId);
    const isFront = x.sessionId === state.sessionId;
    liveBox.append(el('button', {
      class: `item${isFront ? ' active' : ''}`,
      onclick: () => focusTab(x.sessionId),
      title: isFront ? 'Showing now' : isOpen ? 'Open as a tab' : 'Open this terminal as a tab',
    }, [
      el('div', { class: 'l1' }, [
        el('span', { class: `dot live-pip${x.busy ? ' live' : ''}` }),
        String(x.title).slice(0, 34),
      ]),
      el('div', { class: 'l2' }, isFront ? 'showing now' : isOpen ? 'open in a tab' : short(x.cwd)),
    ]));
  }

  // Only worth showing when another Orderly window is actually open.
  const iBox = $('instances');
  iBox.innerHTML = '';
  $('viewersSection').classList.toggle('hidden', instances.length < 2);
  for (const i of instances) {
    iBox.append(el('button', {
      class: `item${i.port === location.port * 1 ? ' active' : ''}`,
      onclick: () => { if (String(i.port) !== location.port) location.href = `http://localhost:${i.port}`; },
    }, [
      el('div', { class: 'l1' }, String(i.title || i.sessionId).slice(0, 40)),
      el('div', { class: 'l2' }, `:${i.port} · ${short(i.cwd)}`),
    ]));
  }

  const sBox = $('sessions');
  const paint = () => {
    const q = $('sessionFilter').value.toLowerCase();
    sBox.innerHTML = '';
    for (const s of sessions) {
      const hay = `${s.title} ${s.cwd}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      sBox.append(el('button', {
        class: `item${s.sessionId === state.sessionId ? ' active' : ''}`,
        onclick: () => switchSession(s.sessionId),
      }, [
        el('div', { class: 'l1' }, String(s.title).slice(0, 44)),
        el('div', { class: 'l2' }, `${s.updatedAt.slice(5, 16).replace('T', ' ')} · ${short(s.cwd)}`),
      ]));
    }
  };
  $('sessionFilter').oninput = paint;
  paint();
}

/** Follow another terminal here: the watcher moves and prompts go to it. */
async function switchLive(sessionId) {
  if (sessionId === state.sessionId) return;
  const res = await api('/api/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res) return;
  if (res.error) { setConnected(true); alertInline(res.error); return; }
  state.sessionId = res.sessionId;
  await refresh();
  loadRail();
}

function alertInline(message) {
  const err = $('runError');
  err.textContent = message;
  err.classList.remove('hidden');
  setTimeout(() => err.classList.add('hidden'), 6000);
}

async function switchSession(id) {
  state.sessionId = id;
  await refresh();
  loadRail();
}

/* ---------- state ---------- */

async function refresh() {
  const q = state.sessionId ? `?session=${state.sessionId}` : '';
  const data = await api(`/api/state${q}`);
  if (!data || data.error) return;
  state.session = data.session;
  state.live = data.live;
  if (!state.sessionId) state.sessionId = data.instance.sessionId;
  state.person = data.person || state.person;
  if (data.tabs) renderTabs(data.tabs);

  // The UI changed on disk since this page loaded, so it is running code that
  // no longer exists. Reload rather than leave a fixed bug looking unfixed.
  if (data.build) {
    if (!state.build) state.build = data.build;
    else if (state.build !== data.build) { location.reload(); return; }
  }

  const wasWorking = !!state.activity?.working;
  state.activity = data.activity || { working: false };
  if (state.activity.working && !wasWorking) {
    state.think.since = Date.now();
      state.think.word = Math.floor(Math.random() * 97);
    term = genz.next();
  }
  if (!state.activity.working) state.think.since = null;
  $('sessionTitle').textContent = data.meta?.title || data.session.title || 'session';
  $('sessionCwd').textContent = short(data.meta?.cwd || data.session.cwd || '');
  $('liveDot').className = `dot${data.live ? ' live' : ''}`;
  $('liveDot').title = data.live ? 'live' : 'archived session';
  if (data.run) paintRun(data.run);
  $('composer').classList.toggle('hidden', !data.live);
  const dev = $('devUrl');
  dev.classList.toggle('hidden', !data.live);
  dev.textContent = data.devUrl
    ? `capturing ${data.devUrl.replace('http://', '')}`
    : 'set capture target';
  state.devUrl = data.devUrl || null;
  renderTimeline();
}

/* ---------- prompting Claude from here ---------- */

function paintRun(run) {
  state.run = run || { status: 'idle', busy: false };
  const busy = !!state.run.busy;
  $('composer').classList.toggle('busy', busy);
  $('sendBtn').disabled = busy;
  $('sendBtn').textContent = busy ? 'Working…' : 'Send';
  $('stopBtn').classList.toggle('hidden', !busy);

  const label = $('runState');
  label.innerHTML = '';
  if (busy) {
    label.append(el('span', { class: 'spin' }), el('span', {}, 'Claude is working'));
  } else if (state.run.status === 'stopped') {
    label.append(el('span', {}, 'stopped'));
  }

  const err = $('runError');
  if (state.run.error) { err.textContent = state.run.error; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
}

async function sendPrompt() {
  const box = $('promptInput');
  const text = box.value.trim();
  if (!text || state.run?.busy) return;
  if (!state.live) {
    // Prompting resumes whichever session is open here, so follow it first.
    $('runError').textContent = 'Switch to the live session before sending.';
    $('runError').classList.remove('hidden');
    return;
  }
  box.value = '';
  box.style.height = '';
  updateComposer();
  updateComposer();
  paintRun({ status: 'running', busy: true });
  const res = await api('/api/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mode: $('permMode').value }),
  }) || { error: 'Lost connection to Orderly Claude.' };
  if (res.error) { box.value = text; growPrompt(); paintRun({ status: 'failed', busy: false, error: res.error }); }
  else paintRun(res);
}

$('sendBtn').onclick = sendPrompt;
$('stopBtn').onclick = async () => {
  const r = await api('/api/stop', { method: 'POST' });
  if (r) paintRun(r.run);
};
/* ---------- tabs, one per terminal ---------- */

function renderTabs(tabs) {
  if (!Array.isArray(tabs)) return;
  state.tabs = tabs;
  const bar = $('tabBar');
  bar.innerHTML = '';

  for (const t of tabs) {
    bar.append(el('button', {
      class: `tab-item${t.active ? ' on' : ''}`,
      title: t.cwd ? short(t.cwd) : '',
      onclick: () => focusTab(t.sessionId),
    }, [
      el('span', { class: `tab-pip${t.working ? ' busy' : ''}` }),
      el('span', { class: 'name' }, t.title),
      t.unread ? el('span', { class: 'tab-unread' }, String(t.unread)) : null,
      el('span', {
        class: 'tab-close',
        title: 'Close this tab',
        onclick: (e) => { e.stopPropagation(); closeTab(t.sessionId); },
      }, '\u00d7'),
    ]));
  }
  bar.append(el('button', { class: 'tab-add', title: 'Open another terminal', onclick: openTerminalPicker }, '+'));
}

async function focusTab(sessionId) {
  if (sessionId === state.sessionId) return;
  const res = await api('/api/tabs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res) return;
  state.sessionId = sessionId;
  renderTabs(res.tabs);
  await refresh();
}

async function closeTab(sessionId) {
  const res = await api('/api/tabs/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res) return;
  if (res.error) return alertInline(res.error);
  renderTabs(res.tabs);
  if (sessionId === state.sessionId) {
    state.sessionId = res.active;
    await refresh();
  }
}

async function newSession(cwd) {
  const res = await api('/api/tabs/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cwd ? { cwd } : {}),
  });
  if (!res) return;
  state.sessionId = res.sessionId;
  renderTabs(res.tabs);
  await refresh();
  loadRail();
  $('promptInput').focus();
}

/** The terminals running on this machine, open or not. */
async function openTerminalPicker() {
  document.querySelector('.term-picker')?.remove();
  const data = await api('/api/terminals');
  if (!data) return;

  const open = new Set((data.tabs || []).map((t) => t.sessionId));
  const picker = el('div', { class: 'term-picker' }, [
    el('div', {
      class: 'term-row new',
      onclick: async () => { picker.remove(); await newSession(); },
    }, [
      el('span', { class: 'tab-pip' }),
      el('span', { class: 'l1' }, 'Start a new Claude session'),
      el('span', { class: 'l2' }, 'here'),
    ]),
    el('h4', {}, `${data.terminals.length} terminal${data.terminals.length === 1 ? '' : 's'} running`),
  ]);

  if (!data.terminals.length) {
    picker.append(el('div', { class: 'term-row disabled' }, el('span', { class: 'l1' }, 'none found')));
  }
  for (const t of data.terminals) {
    const already = open.has(t.sessionId);
    picker.append(el('div', {
      class: `term-row${already ? ' disabled' : ''}`,
      onclick: already ? undefined : async () => { picker.remove(); await focusTab(t.sessionId); },
    }, [
      el('span', { class: `tab-pip${t.busy ? ' busy' : ''}` }),
      el('span', { class: 'l1' }, t.title),
      el('span', { class: 'l2' }, already ? 'open' : short(t.cwd)),
    ]));
  }

  document.body.append(picker);
  setTimeout(() => {
    const away = (e) => {
      if (!e.target.closest('.term-picker') && !e.target.closest('.tab-add')) {
        picker.remove();
        document.removeEventListener('click', away);
      }
    };
    document.addEventListener('click', away);
  }, 0);
}

/* ---------- slash commands ---------- */

let commands = [];
let palette = { open: false, matches: [], sel: 0 };

/**
 * The mode is read back out of the text rather than held beside it, so the
 * chip can never claim a command the message will not actually carry.
 */
function parseCommand(text) {
  const m = String(text).match(/^\/([\w-]*)([\s\S]*)$/);
  if (!m) return null;
  return { typed: m[1], rest: m[2], known: commands.find((c) => c.name === m[1]) || null };
}

function renderPalette() {
  const box = $('cmdPalette');
  box.innerHTML = '';
  box.classList.toggle('hidden', !palette.open || !palette.matches.length);
  if (!palette.open) return;

  palette.matches.forEach((c, i) => {
    box.append(el('div', {
      class: `cmd-row${i === palette.sel ? ' sel' : ''}`,
      onmousedown: (e) => { e.preventDefault(); chooseCommand(c); },
    }, [
      el('span', { class: 'cmd-name' }, `/${c.name}`),
      c.arg ? el('span', { class: 'cmd-arg' }, c.arg) : null,
      el('span', { class: 'cmd-sum' }, c.summary),
      el('span', { class: 'cmd-where' }, c.runsHere ? '' : 'terminal'),
    ]));
  });
}

/** A standing reminder of the mode you are in, and what it wants next. */
function renderChip() {
  const chip = $('cmdChip');
  const parsed = parseCommand($('promptInput').value);
  const cmd = parsed?.known;
  chip.innerHTML = '';
  chip.classList.toggle('hidden', !cmd);
  if (!cmd) return;

  chip.append(el('span', { class: 'tagname' }, `/${cmd.name}`));
  if (cmd.arg) chip.append(el('span', { class: 'expects' }, `expects ${cmd.arg}`));
  chip.append(el('span', { class: 'says' }, cmd.summary));
  if (!cmd.runsHere) {
    chip.append(el('span', { class: 'warn-here' }, 'needs the terminal — it opens a picker here'));
  }
  chip.append(el('button', {
    class: 'btn ghost drop',
    onclick: () => {
      const { rest } = parseCommand($('promptInput').value) || { rest: '' };
      $('promptInput').value = rest.replace(/^\s+/, '');
      updateComposer();
      $('promptInput').focus();
    },
  }, 'clear'));
}

function updateComposer() {
  const text = $('promptInput').value;
  const parsed = parseCommand(text);
  // Only offer the list while the command itself is being typed.
  const choosing = !!parsed && !/\s/.test(parsed.rest) && parsed.rest === '';
  palette.open = choosing && commands.length > 0;
  if (palette.open) {
    const q = parsed.typed.toLowerCase();
    palette.matches = commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
    if (palette.sel >= palette.matches.length) palette.sel = 0;
  } else {
    palette.matches = [];
  }
  renderPalette();
  renderChip();
}

function chooseCommand(c) {
  const parsed = parseCommand($('promptInput').value);
  const rest = (parsed?.rest || '').replace(/^\s+/, '');
  $('promptInput').value = `/${c.name} ${rest}`;
  palette.open = false;
  renderPalette();
  renderChip();
  $('promptInput').focus();
  growPrompt();
}

/** Enter sends, Shift+Enter starts a line — the convention people expect. */
$('promptInput').addEventListener('keydown', (e) => {
  // While the list is up it owns the arrows, Tab, Enter and Escape.
  if (palette.open && palette.matches.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      palette.sel = (palette.sel + step + palette.matches.length) % palette.matches.length;
      renderPalette();
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      chooseCommand(palette.matches[palette.sel]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      palette.open = false;
      renderPalette();
      return;
    }
  }
  if (e.key !== 'Enter') return;
  // Enter also confirms a character mid-composition in Japanese, Chinese and
  // Korean input; sending there would cut the word in half.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey) return;
  e.preventDefault();
  sendPrompt();
});

/* Grow with the text, up to a point, so multi-line prompts stay readable. */
const growPrompt = () => {
  const box = $('promptInput');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
};

$('promptInput').addEventListener('input', () => { growPrompt(); updateComposer(); });

const events = new EventSource('/events');
events.addEventListener('update', () => { if (state.live) refresh(); });
events.addEventListener('open', () => setConnected(true));
events.onopen = () => setConnected(true);
events.onerror = () => setConnected(false);
events.addEventListener('run', (e) => { try { paintRun(JSON.parse(e.data)); } catch {} });
events.addEventListener('tabs', (e) => {
  try { const d = JSON.parse(e.data); renderTabs(d.tabs); } catch {}
});
events.addEventListener('session', (e) => {
  // Claude forked a copy; follow the transcript the work actually went to.
  try {
    const { sessionId } = JSON.parse(e.data);
    if (sessionId) { state.sessionId = sessionId; refresh(); loadRail(); }
  } catch {}
});

/* ---------- search ---------- */

function highlight(text, q) {
  const terms = q.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let out = esc(text);
  for (const t of terms) out = out.replace(new RegExp(`(${t})`, 'ig'), '<mark>$1</mark>');
  return out;
}

async function runSearch() {
  const q = $('searchInput').value;
  const box = $('searchResults');
  if (!q.trim()) { box.innerHTML = ''; state.results = []; return; }
  const params = new URLSearchParams({ q, scope: $('searchAll').checked ? 'all' : 'session' });
  if (state.sessionId) params.set('session', state.sessionId);
  const found = await api(`/api/search?${params}`);
  if (!found) { box.innerHTML = '<div class="note">Lost connection.</div>'; return; }
  const { results } = found;
  state.results = results; state.sel = 0;
  box.innerHTML = '';
  if (!results.length) { box.append(el('div', { class: 'note' }, 'Nothing found.')); return; }

  results.forEach((r, i) => {
    const row = el('div', { class: `result${i === state.sel ? ' sel' : ''}`, onclick: () => jumpTo(r) }, [
      el('div', { class: 'kind' }, r.kind),
      el('div', { class: 'body' }, [
        el('div', { class: 'snip', html: highlight(r.snippet || r.text, q) }),
        el('div', { class: 'where' }, [r.sessionTitle, r.at ? new Date(r.at).toLocaleString() : null].filter(Boolean).join(' · ')),
      ]),
      r.kind === 'prompt'
        ? el('button', {
            class: 'btn ghost copy',
            onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(r.text); e.target.textContent = 'copied'; },
          }, 'copy')
        : null,
    ]);
    box.append(row);
  });
}

async function jumpTo(r) {
  closeSearch();
  if (r.sessionId && r.sessionId !== state.sessionId) await switchSession(r.sessionId);
  if (r.stepId) openStep(r.stepId);
  else if (r.turnId) $(`turn-${r.turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const openSearch = () => {
  $('searchOverlay').classList.remove('hidden');
  $('searchInput').focus();
  $('searchInput').select();
};
const closeSearch = () => $('searchOverlay').classList.add('hidden');

$('newSessionBtn').onclick = () => newSession();

$('railBtn').onclick = () => {
  const open = layoutEl().classList.toggle('rail-open');
  try { localStorage.setItem('cz-rail', open ? '1' : '0'); } catch {}
};
try { if (localStorage.getItem('cz-rail') === '1') layoutEl().classList.add('rail-open'); } catch {}

function applyTheme(mode, remember = true) {
  document.documentElement.setAttribute('data-theme', mode);
  if (remember) { try { localStorage.setItem('cz-theme', mode); } catch {} }
}
let themeMode = 'light';
try { themeMode = localStorage.getItem('cz-theme') || 'light'; } catch {}
// ?theme=dark forces a theme, which makes a shared link look the same for everyone.
// A ?theme= link shows that theme without overwriting what the viewer chose.
const forced = new URLSearchParams(location.search).get('theme');
if (forced === 'dark' || forced === 'light') themeMode = forced;
applyTheme(themeMode, !forced);
$('themeBtn').onclick = () => {
  themeMode = themeMode === 'light' ? 'dark' : 'light';
  applyTheme(themeMode);
  $('themeBtn').title = `Theme: ${themeMode}`;
};

/* The capture target is a guess; let it be corrected. */
$('devUrl').onclick = () => {
  const box = $('devUrlInput');
  box.value = state.devUrl || '';
  box.classList.remove('hidden');
  $('devUrl').classList.add('hidden');
  box.focus();
  box.select();
};
const closeDevUrl = () => {
  $('devUrlInput').classList.add('hidden');
  $('devUrl').classList.remove('hidden');
};
$('devUrlInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') return closeDevUrl();
  if (e.key !== 'Enter') return;
  const url = $('devUrlInput').value.trim();
  await api('/api/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: url || null }),
  });
  closeDevUrl();
  refresh();
});
$('devUrlInput').addEventListener('blur', closeDevUrl);

$('searchBtn').onclick = openSearch;
$('searchClose').onclick = closeSearch;
$('searchInput').oninput = runSearch;
$('searchAll').onchange = runSearch;
$('searchOverlay').onclick = (e) => { if (e.target === $('searchOverlay')) closeSearch(); };

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
  if (e.key === 'Escape') {
    if (!$('searchOverlay').classList.contains('hidden')) closeSearch();
    else closeDrawer();
    return;
  }
  if ($('searchOverlay').classList.contains('hidden') || !state.results.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    state.sel = (state.sel + (e.key === 'ArrowDown' ? 1 : -1) + state.results.length) % state.results.length;
    [...$('searchResults').children].forEach((c, i) => c.classList.toggle('sel', i === state.sel));
    $('searchResults').children[state.sel]?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') { e.preventDefault(); jumpTo(state.results[state.sel]); }
});

await refresh();
await openFromHash();
loadRail();

/* The command list rarely changes; fetch it once and keep it. */
api('/api/commands').then((d) => {
  if (d?.commands) { commands = d.commands; updateComposer(); }
});
setInterval(loadRail, 15000);

/* Test seam: lets the suite assert the live row renders real text. */
window.__cz = {
  vocabText,
  liveTitle,
  isStalled,
  commandCount: () => commands.length,
  paletteState: () => ({ open: palette.open, matches: palette.matches.length }),
  /* The word for a voice, independent of whether a stall is being reported. */
  sample(v) { state.voice = v; advanceVoice(); return asVocab(currentTerm()); },
  setVoice(v) { state.voice = v; advanceVoice(); return vocabText(); },
};
