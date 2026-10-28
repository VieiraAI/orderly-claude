import { createRotation } from './genz.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  sessionId: null, live: true, session: null, activeStep: null,
  tab: 'detail', results: [], sel: 0, run: { status: 'idle', busy: false }, person: null, tabs: [],
  activity: null, devUrl: null, build: null, think: { word: 0, tick: 0, since: null },
  runs: [],
  voice: (() => {
    try { return localStorage.getItem('cz-voice-2') || 'genz'; } catch { return 'genz'; }
  })(),
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

/* ---------- workflow runs in the timeline ---------- */

/**
 * The sessions index tells the backend which runs belong to this session.
 * A run shows up as a highlighted bubble on the turn it kicked off from,
 * and clicking it opens the canvas page scoped to that run id.
 */
async function loadRuns() {
  if (!state.sessionId) return;
  try {
    const r = await api(`/api/runs?session=${state.sessionId}`);
    state.runs = r?.runs || [];
  } catch { state.runs = []; }
}

function workflowBubble(run) {
  const done = run.doneNodes ?? 0;
  const total = run.totalNodes ?? 0;
  const live = run.status === 'running';
  const waiting = run.status === 'awaiting-answer';
  const failed = run.status === 'failed';
  const stopped = run.status === 'stopped';
  const sub = waiting ? `waiting · ${run.askingLabel || 'needs you'}`
    : live     ? (run.runningLabel ? run.runningLabel : `step ${done} of ${total}`)
    : failed   ? 'failed'
    : stopped  ? 'stopped'
    : `done · ${done} of ${total}`;
  const toneCls = waiting ? 'ask' : live ? 'running' : failed ? 'warn' : stopped ? 'warn' : 'done';
  return el('a', {
    class: `bubble workflow tone-${toneCls}`,
    href: `/workflows-run.html#${run.runId}`,
    target: '_blank', rel: 'noopener',
    title: 'Open the canvas for this run',
  }, [
    el('span', { class: `icon t-workflow` }, '◇'),
    el('span', { class: 'label' }, [
      el('span', { class: 'text' }, [
        el('span', { class: 'wf-tag' }, 'workflow'),
        el('span', { class: 'wf-name' }, run.workflowTitle || run.workflowId),
      ]),
      el('span', { class: 'sub' }, sub),
    ]),
    el('span', { class: 'tags' }, el('span', { class: 'tag open-canvas' }, 'open canvas →')),
  ]);
}

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
  // Only a picture worth opening earns a tag. A step that changed nothing
  // visible, or could not have, says so in the panel rather than on the row.
  if (step.hasShots && step.visualChanged) {
    tags.push(el('span', { class: 'tag shot' },
      step.changedPercent ? `before & after · ${step.changedPercent}%` : 'before & after'));
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
  try { localStorage.setItem('cz-voice-2', state.voice); } catch {}
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

    // Any workflow runs that kicked off between this turn's prompt and the
    // next turn's prompt belong to this turn.
    const nextTurnAt = isLast ? Infinity : Date.parse(turns[index + 1].promptAt);
    const turnAt = Date.parse(turn.promptAt || 0) || 0;
    const myRuns = (state.runs || []).filter((r) => {
      const t = Date.parse(r.startedAt);
      return isFinite(t) && t >= turnAt && t < nextTurnAt;
    });

    if (turn.steps.length || (turn.pending || []).length || liveNeedsRow || openAsk || myRuns.length) {
      const list = el('div', { class: 'steps' });
      for (const s of turn.steps) list.append(bubble(s));
      for (const p of turn.pending || []) {
        list.append(el('div', { class: 'bubble pending' }, [
          el('span', { class: 'icon pending' }, ''),
          el('span', { class: 'label' }, el('span', { class: 'text' }, p)),
        ]));
      }
      for (const r of myRuns) list.append(workflowBubble(r));
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

  /*
   * Say when each picture was taken.
   *
   * A pair is only as honest as its "before", which is the shot from the end
   * of the previous change. Showing the clock times — and warning when they
   * are far apart — lets you judge whether the two frames really bracket this
   * one step, instead of trusting a label that cannot know.
   */
  const shotAt = (s) => (s?.at ? new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
  const sbs = el('div', { class: 'sbs' }, [
    el('div', { class: 'shot' }, [
      el('img', { src: src(shots.before) }),
      el('div', { class: 'cap' }, [el('span', {}, 'before'), el('span', { class: 'cap-at' }, shotAt(shots.before))]),
    ]),
    el('div', { class: 'shot' }, [
      el('img', { src: src(shots.after) }),
      el('div', { class: 'cap' }, [el('span', {}, 'after'), el('span', { class: 'cap-at' }, shotAt(shots.after))]),
    ]),
  ]);

  const span = shots.spanMs || 0;
  const WIDE = 90 * 1000;
  if (span >= WIDE) {
    const mins = Math.round(span / 60000);
    wrap.append(el('div', { class: 'pair-note' },
      `These frames are ${mins >= 1 ? `${mins} min` : `${Math.round(span / 1000)}s`} apart, `
      + 'so other work may sit between them.'));
  } else if (!shots.changed) {
    wrap.append(el('div', { class: 'pair-note quiet' },
      'The two frames are identical — this step changed nothing you can see.'));
  }

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

  /*
   * The part that actually moved.
   *
   * Two near-identical full pages side by side is the complaint this answers:
   * when the comparison found a region, both frames are scaled up and shifted
   * so that region fills the frame, and you are looking at the change rather
   * than hunting for it.
   */
  const box = shots.box;
  let zoom = null;
  const placers = [];
  if (box && box.w > 0 && box.h > 0 && !shots.wholePage) {
    const pane = (file, label) => {
      const inner = el('img', { src: src(file), class: 'zoom-img' });
      const frame = el('div', { class: 'zoom-frame' }, inner);
      /*
       * The stored region is in the image's own pixels, so placing it needs
       * both the natural size and the width on screen. Neither is known while
       * the panel is still being assembled — an element not yet in the
       * document measures zero — so this runs again when the view is shown.
       */
      const place = () => {
        if (!inner.naturalWidth) return;
        const width = frame.clientWidth || 280;
        const scale = Math.min(6, Math.max(1, width / box.w));
        inner.style.width = `${inner.naturalWidth * scale}px`;
        inner.style.marginLeft = `${-box.x * scale}px`;
        inner.style.marginTop = `${-box.y * scale}px`;
        frame.style.height = `${Math.min(420, Math.max(80, box.h * scale))}px`;
      };
      inner.onload = place;
      placers.push(place);
      return el('div', { class: 'shot' }, [frame, el('div', { class: 'cap' }, label)]);
    };
    zoom = el('div', { class: 'sbs hidden' }, [pane(shots.before, 'before'), pane(shots.after, 'after')]);
  }

  const show = (which) => {
    sbs.classList.toggle('hidden', which !== 'sbs');
    slider.classList.toggle('hidden', which !== 'swipe');
    if (zoom) zoom.classList.toggle('hidden', which !== 'zoom');
    // Measure once it is on screen and has a width to measure.
    if (which === 'zoom') requestAnimationFrame(() => placers.forEach((p) => p()));
  };

  const controls = [];
  if (zoom) controls.push(el('button', { class: 'btn', onclick: () => show('zoom') }, 'what changed'));
  controls.push(el('button', { class: 'btn', onclick: () => show('sbs') }, 'side by side'));
  controls.push(el('button', { class: 'btn', onclick: () => show('swipe') }, 'swipe'));

  wrap.append(el('div', { class: 'compare-controls' }, controls), sbs, slider);
  if (zoom) wrap.append(zoom);
  // Open on the change itself when there is one to open on.
  show(zoom ? 'zoom' : 'sbs');
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

/**
 * What Claude is waiting for, spelled out.
 *
 * A step marked "needs you" used to open on a summary of commands, which says
 * nothing about the decision being asked for. The question, the choices and
 * what each one means are all in the call; this shows them.
 */
function askView(call) {
  const questions = call.input?.questions || [];
  const result = call.result || '';
  const pending = call.pending;
  const refused = /doesn.t want to proceed|rejected/i.test(result);

  // Answers come back as "<question>"="<choice>" pairs.
  const answers = new Map();
  for (const m of result.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) answers.set(m[1], m[2]);

  const status = pending
    ? { text: 'Waiting for your answer', cls: 'waiting' }
    : refused
      ? { text: 'You asked to clarify instead of choosing', cls: 'waiting' }
      : answers.size
        ? { text: 'You answered', cls: 'settled' }
        : { text: 'Answered', cls: 'settled' };

  /*
   * The ask, in one sentence, before any of the detail.
   *
   * The context below is useful but it buries the point: someone opening this
   * panel wants to know what is being asked of them, not to infer it from a
   * list of options.
   */
  const need = (() => {
    if (pending) {
      if (questions.length === 1) return `Claude needs you to answer: ${questions[0].question}`;
      if (questions.length > 1) return `Claude needs your answer on ${questions.length} questions before it can carry on.`;
      return 'Claude needs a decision from you before it can carry on.';
    }
    if (refused) return 'Claude asked you to choose, and you asked to clarify first.';
    if (questions.length === 1) return `You answered: ${questions[0].question}`;
    return `You answered ${questions.length} questions.`;
  })();

  const box = el('div', { class: `ask-box ${status.cls}` }, [
    el('div', { class: 'ask-need' }, need),
    el('div', { class: 'ask-status' }, [
      el('span', { class: 'ask-dot' }),
      el('span', {}, status.text),
    ]),
  ]);

  for (const q of questions) {
    const chosen = answers.get(q.question);
    box.append(el('div', { class: 'ask-q' }, [
      q.header ? el('div', { class: 'ask-header' }, q.header) : null,
      // With a single question the headline above already says it.
      questions.length > 1 ? el('div', { class: 'ask-text' }, q.question) : null,
      q.multiSelect ? el('div', { class: 'ask-note' }, 'More than one may be chosen') : null,
      el('div', { class: 'ask-options' }, (q.options || []).map((o) => {
        const picked = chosen && chosen.split(', ').some((c) => c.trim() === o.label);
        return el('div', { class: `ask-option${picked ? ' picked' : ''}` }, [
          el('div', { class: 'ask-label' }, [
            el('span', { class: 'ask-mark' }, picked ? '\u2713' : ''),
            o.label,
          ]),
          o.description ? el('div', { class: 'ask-desc' }, o.description) : null,
        ]);
      })),
      chosen && !(q.options || []).some((o) => chosen.split(', ').some((c) => c.trim() === o.label))
        ? el('div', { class: 'ask-own' }, `You answered: ${chosen}`)
        : null,
    ]));
  }

  if (!questions.length) {
    box.append(el('div', { class: 'ask-text' }, 'Claude is waiting on a decision before it can continue.'));
  }
  return box;
}

/** A tool call that was refused, and what it was trying to do. */
function blockedView(call) {
  const input = call.input?.command || call.input?.file_path || call.toolLabel;
  return el('div', { class: 'ask-box waiting' }, [
    el('div', { class: 'ask-need' }, `Claude needs your permission to run ${call.toolLabel}.`),
    el('div', { class: 'ask-status' }, [el('span', { class: 'ask-dot' }), el('span', {}, 'Blocked \u2014 waiting on you')]),
    el('div', { class: 'ask-text' }, 'It tried this and was stopped:'),
    el('pre', { class: 'block cmd' }, String(input).slice(0, 600)),
    call.result ? el('div', { class: 'ask-desc' }, String(call.result).slice(0, 400)) : null,
  ]);
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
      // A decision comes first; everything else about the step can wait.
      const asks = step.calls.filter((c) => c.tool === 'AskUserQuestion' || c.tool === 'ExitPlanMode');
      const blocked = step.calls.filter((c) => c.isError && /permission|approve|denied|rejected/i.test(c.result || ''));
      for (const c of asks) body.append(askView(c));
      for (const c of blocked) if (!asks.length) body.append(blockedView(c));

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
      if (data.shots?.percent) {
        body.append(el('div', { class: 'headline' },
          data.shots.wholePage
            ? `The page changed throughout — ${data.shots.percent}% of it differs.`
            : `${data.shots.percent}% of the page changed.`));
      }
      const v = compareView(data.shots);
      if (v) body.append(v);
      else if (data.step?.noCapture) {
        // Say why rather than leaving an empty panel: a step that could not
        // have changed the picture is an answer, not a gap.
        body.append(el('div', { class: 'headline' }, 'No picture for this step.'));
        body.append(el('div', { class: 'note' }, `Nothing was captured because ${data.step.noCapture}.`));
      } else {
        body.append(el('div', { class: 'note' },
          'No screenshots for this step. Orderly Claude photographs the app around changes that could alter what it draws — start your app and the next such change will have a before and after.'));
      }
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
  restoreDraft(); // whatever was being typed before a reload or a tab switch

  // The UI changed on disk since this page loaded, so it is running code that
  // no longer exists. Reload rather than leave a fixed bug looking unfixed —
  // but never out from under someone mid-sentence.
  if (data.build) {
    if (!state.build) state.build = data.build;
    else if (state.build !== data.build && reloadForBuild()) return;
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
  await loadRuns();
  renderTimeline();
}

/* ---------- prompting Claude from here ---------- */

function paintRun(run) {
  state.run = run || { status: 'idle', busy: false };
  const busy = !!state.run.busy;
  $('composer').classList.toggle('busy', busy);
  /*
   * Sending is never blocked.
   *
   * A run that started a dev server does not finish — the command holds the
   * process open for as long as the server runs — so disabling the button
   * while "working" left no way to say anything ever again. A new prompt
   * replaces the run instead, which is what pressing Enter in a terminal
   * would have done anyway.
   */
  $('sendBtn').disabled = false;
  $('sendBtn').textContent = busy ? 'Stop & send' : 'Send';
  $('sendBtn').title = busy
    ? 'Stops what is running in this session and sends this instead'
    : '';
  $('stopBtn').classList.toggle('hidden', !busy);

  const label = $('runState');
  label.innerHTML = '';
  if (busy) {
    const secs = Math.round((state.run.runningMs || 0) / 1000);
    const forHow = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    label.append(
      el('span', { class: 'spin' }),
      el('span', {}, secs > 2 ? `Claude is working · ${forHow}` : 'Claude is working'),
    );
    // Long enough that it is probably holding a server open rather than thinking.
    if (secs > 120) {
      label.append(el('span', { class: 'run-hint' }, 'still running — sending will replace it'));
    }
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
  // Only an empty box stops a send. A run in progress is replaced, not a reason
  // to refuse — see paintRun.
  if (!text) return;
  if (!state.live) {
    // Prompting resumes whichever session is open here, so follow it first.
    $('runError').textContent = 'Switch to the live session before sending.';
    $('runError').classList.remove('hidden');
    return;
  }
  // Read the attachments before the box is cleared; clearing first meant the
  // list was always empty by the time the request was built, so a file
  // attached in the page never reached Claude.
  const attached = attachments.filter((f) => f.path).map((f) => f.path);
  box.value = '';
  box.style.height = '';
  attachments = [];
  clearDraft();
  renderAttachments();
  updateComposer();
  takeHeldUpdate(); // the message is away; a held update can land now
  updateComposer();
  paintRun({ status: 'running', busy: true });
  const res = await api('/api/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      mode: $('permMode').value,
      sessionId: state.sessionId,
      attachments: attached,
      // Replace whatever is running in this session rather than be refused.
      replace: true,
    }),
  }) || { error: 'Lost connection to Orderly Claude.' };
  if (res.error) { box.value = text; growPrompt(); paintRun({ status: 'failed', busy: false, error: res.error }); }
  else paintRun(res);
}

$('sendBtn').onclick = sendPrompt;
$('stopBtn').onclick = async () => {
  const r = await api('/api/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Stop the session being looked at, not whichever the server last ran.
    body: JSON.stringify({ sessionId: state.sessionId }),
  });
  if (r) paintRun(r.run);
};
/* ---------- attachments ---------- */

let attachments = [];

function renderAttachments() {
  const box = $('attachList');
  box.innerHTML = '';
  box.classList.toggle('hidden', attachments.length === 0);
  for (const f of attachments) {
    box.append(el('span', { class: 'attach-chip', title: f.path }, [
      el('span', { class: 'attach-name' }, f.name),
      el('span', { class: 'attach-size' }, humanSize(f.size)),
      el('button', {
        class: 'attach-drop',
        title: 'Remove',
        onclick: () => { attachments = attachments.filter((x) => x !== f); renderAttachments(); },
      }, '\u00d7'),
    ]));
  }
}

const humanSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/**
 * The file is written beside the session and Claude is told where it is, so
 * it reads it with its own tools. Putting the bytes in the prompt would spend
 * the whole context on the first PDF.
 */
async function uploadFiles(fileList) {
  for (const file of [...fileList]) {
    const chip = { name: file.name, size: file.size, path: '', uploading: true };
    attachments.push(chip);
    renderAttachments();
    try {
      const res = await fetch(
        `/api/upload?name=${encodeURIComponent(file.name)}&session=${encodeURIComponent(state.sessionId)}`,
        { method: 'POST', body: file },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      Object.assign(chip, { name: data.name, path: data.path, size: data.size, uploading: false });
    } catch (e) {
      attachments = attachments.filter((x) => x !== chip);
      alertInline(`Could not attach ${file.name}: ${e.message}`);
    }
    renderAttachments();
  }
}

$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

/* Dropping a file anywhere on the composer attaches it. */
const composerEl = () => $('composer');
['dragenter', 'dragover'].forEach((ev) => composerEl().addEventListener(ev, (e) => {
  e.preventDefault();
  composerEl().classList.add('dropping');
}));
['dragleave', 'drop'].forEach((ev) => composerEl().addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && composerEl().contains(e.relatedTarget)) return;
  composerEl().classList.remove('dropping');
}));
composerEl().addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

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

/*
 * Nothing typed is ever lost.
 *
 * The page reloads itself when the UI changes on disk, which used to wipe a
 * half-written message without warning. Two defences: the draft is kept as it
 * is typed and put back afterwards, and a reload waits until the composer is
 * empty and unfocused rather than interrupting.
 */
const draftKey = () => `cz-draft-${state.sessionId || 'current'}`;

function saveDraft() {
  try { localStorage.setItem(draftKey(), $('promptInput').value); } catch {}
}

function restoreDraft() {
  try {
    const kept = localStorage.getItem(draftKey());
    if (kept && !$('promptInput').value) {
      $('promptInput').value = kept;
      growPrompt();
      updateComposer();
    }
  } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch {}
}

let buildPending = false;

/** Returns true when the page is actually going to reload. */
function reloadForBuild() {
  const box = $('promptInput');
  const busy = document.activeElement === box || box.value.trim().length > 0;
  if (busy) {
    // Hold it until they are done, and say an update is waiting.
    buildPending = true;
    $('updateHint')?.classList.remove('hidden');
    return false;
  }
  saveDraft();
  location.reload();
  return true;
}

/* Once the composer is clear, a held update can land. */
function takeHeldUpdate() {
  if (!buildPending) return;
  const box = $('promptInput');
  if (document.activeElement === box || box.value.trim()) return;
  saveDraft();
  location.reload();
}

/* Grow with the text, up to a point, so multi-line prompts stay readable. */
const growPrompt = () => {
  const box = $('promptInput');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
};

$('promptInput').addEventListener('input', () => { growPrompt(); updateComposer(); saveDraft(); });
$('promptInput').addEventListener('blur', takeHeldUpdate);

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
// Workflow runs this session is responsible for — pull them again so the
// bubble appears, its status advances, and the "done · N of N" lands.
events.addEventListener('run-start',  () => { loadRuns().then(renderTimeline); });
events.addEventListener('run-finish', () => { loadRuns().then(renderTimeline); });

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

$('updateHint').onclick = () => { saveDraft(); location.reload(); };

$('newSessionBtn').onclick = () => newSession();

$('shareBtn')?.addEventListener('click', async () => {
  if (!state.sessionId) { alert('No session to share yet.'); return; }
  const btn = $('shareBtn');
  const prev = btn.textContent;
  btn.textContent = 'Signing…';
  btn.disabled = true;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((x) => x.json());
    if (!r.url) throw new Error(r.error || 'no url');
    await navigator.clipboard?.writeText(r.url).catch(() => {});
    btn.textContent = '◎ Copied';
    window.open(r.url, '_blank', 'noopener');
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1800);
  } catch (e) {
    btn.textContent = prev;
    btn.disabled = false;
    alert(`Share failed: ${e.message}`);
  }
});

$('railBtn').onclick = () => {
  const open = layoutEl().classList.toggle('rail-open');
  try { localStorage.setItem('cz-rail', open ? '1' : '0'); } catch {}
};
// Rail is open by default so the ☰ affordance isn't a mystery; the user's
// explicit toggle still sticks across reloads.
try {
  const pref = localStorage.getItem('cz-rail');
  if (pref === null || pref === '1') layoutEl().classList.add('rail-open');
} catch { layoutEl().classList.add('rail-open'); }

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
  /* Paint a run state and report what the composer does with it. */
  showRun(run) {
    paintRun(run);
    const out = {
      disabled: $('sendBtn').disabled,
      label: $('sendBtn').textContent,
      note: $('runState').textContent.trim(),
    };
    paintRun({ status: 'idle', busy: false });
    return out;
  },
};
