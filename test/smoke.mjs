#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 *   node test/smoke.mjs
 *
 * Boots a real server against a real session on disk, exercises every API
 * route, then loads the page in headless Chrome and checks it rendered with
 * no console errors — in both themes. Exits non-zero on any failure.
 */
import net from 'node:net';
import { startServer } from '../src/server/server.mjs';
import { listSessions } from '../src/core/sessions.mjs';
import { readRecords } from '../src/core/jsonl.mjs';
import { buildSession, classifyBash } from '../src/core/steps.mjs';
import { buildFileHistory } from '../src/core/filehistory.mjs';
import { stepChanges } from '../src/core/changes.mjs';
import { lineDiff, diffStats, hunks } from '../src/core/diff.mjs';
import { indexSession, search } from '../src/core/search.mjs';
import { screenshot, shutdownBrowser, findChrome, listeningServers } from '../src/core/capture.mjs';
import { loadShots } from '../src/core/shots.mjs';
import { SessionWatcher } from '../src/core/watcher.mjs';
import { listTerminals } from '../src/core/terminals.mjs';
import { TERMS, CATEGORIES, createRotation, find, byCategory } from '../web/genz.mjs';
import { CDP, httpJSON } from '../src/core/cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const freePort = (start) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(freePort(start + 1)));
  srv.once('listening', () => srv.close(() => resolve(start)));
  srv.listen(start, '127.0.0.1');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The composer is empty throughout, so a send never actually fires. */
const KEYS_PROBE = `(() => {
  const box = document.getElementById('promptInput');
  if (!box) return JSON.stringify({ error: 'no composer' });
  box.value = '';
  const fire = (init) => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    box.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const plainEnter = fire({});
  const shiftEnter = fire({ shiftKey: true });
  const composing = fire({ isComposing: true });

  const before = box.getBoundingClientRect().height;
  box.value = ['one', 'two', 'three', 'four', 'five'].join(String.fromCharCode(10));
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const after = box.getBoundingClientRect().height;
  box.value = '';
  box.dispatchEvent(new Event('input', { bubbles: true }));

  return JSON.stringify({ plainEnter, shiftEnter, composing, before, after });
})()`;

/* The live row has shipped empty three times when the renderer and the
   repainter drifted apart; assert it renders real text in every voice. */
/* The panel should close on a click away, stay for a click inside, and
   survive clicking another step — which is a switch, not a dismissal. */
const DISMISS_PROBE = `(() => {
  const d = document.getElementById('drawer');
  if (!d) return JSON.stringify({ error: 'no drawer' });
  const hidden = () => d.getAttribute('aria-hidden');
  const fire = (el) => {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  const out = { opened: hidden() };

  fire(d.querySelector('.drawer-body'));
  out.afterInside = hidden();

  fire(document.querySelector('.timeline'));
  out.afterOutside = hidden();

  const bubbles = document.querySelectorAll('.bubble:not(.pending):not(.live)');
  fire(bubbles[0]);
  out.afterBubble = hidden();
  fire(bubbles[1] || bubbles[0]);
  out.afterSecondBubble = hidden();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  out.afterEscape = hidden();
  return JSON.stringify(out);
})()`;

/* Typing a slash should offer the commands, complete one, and say which
   mode you are in — the confusion being that /model and /btw look alike. */
const COMMAND_PROBE = `(() => {
  if (!window.__cz) return JSON.stringify({ error: 'no test seam' });
  const box = document.getElementById('promptInput');
  const typed = (v) => { box.value = v; box.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (k) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    box.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const out = { loaded: window.__cz.commandCount() };

  typed('/');
  out.openedOnSlash = window.__cz.paletteState().open;
  out.offered = document.querySelectorAll('.cmd-row').length;

  typed('/mod');
  out.filtered = [...document.querySelectorAll('.cmd-name')].map((n) => n.textContent);

  out.tabHandled = key('Tab');
  out.afterTab = box.value;
  out.chipShown = !document.getElementById('cmdChip').classList.contains('hidden');
  out.chipText = document.getElementById('cmdChip').textContent.replace(/\s+/g, ' ').trim();

  typed('/compact tidy up');
  out.closedOnArgs = !window.__cz.paletteState().open;
  out.argChip = document.getElementById('cmdChip').textContent.replace(/\s+/g, ' ').trim();

  typed('just a sentence');
  out.chipGoneForProse = document.getElementById('cmdChip').classList.contains('hidden');
  typed('');
  return JSON.stringify(out);
})()`;

const VOCAB_PROBE = `(() => {
  if (!window.__cz) return JSON.stringify({ error: 'no test seam' });
  const out = {};
  for (const v of ['genz', 'plain', 'booth']) out[v] = window.__cz.sample(v);
  window.__cz.setVoice('genz');
  out.title = window.__cz.liveTitle();
  out.stalled = window.__cz.isStalled();
  out.displayed = window.__cz.vocabText();
  return JSON.stringify(out);
})()`;

const DRAWER_PROBE = `(() => {
  const body = document.getElementById('drawerBody');
  if (!body) return JSON.stringify({ error: 'no drawer' });
  const active = document.querySelector('.tab.active');
  return JSON.stringify({
    tab: active ? active.textContent.trim() : null,
    headlines: body.querySelectorAll('.headline').length,
    facts: body.querySelectorAll('.facts li').length,
    codeBlocks: body.querySelectorAll('pre.block').length,
    text: body.textContent.slice(0, 200),
  });
})()`;

const SWIPE_PROBE = `(() => {
  const btn = [...document.querySelectorAll('.compare-controls .btn')]
    .find(b => b.textContent.trim() === 'swipe');
  if (!btn) return JSON.stringify({ error: 'no swipe control' });
  btn.click();
  const slider = document.querySelector('.slider');
  if (!slider || slider.classList.contains('hidden')) return JSON.stringify({ error: 'slider hidden' });

  const after = slider.querySelector('.shot-after');
  const before = slider.querySelector('.shot-before');
  const handle = slider.querySelector('.handle');
  const box = slider.getBoundingClientRect();

  const sample = () => {
    const a = after.getBoundingClientRect();
    const b = before.getBoundingClientRect();
    return {
      afterW: Math.round(a.width), afterL: Math.round(a.left),
      beforeW: Math.round(b.width), beforeL: Math.round(b.left),
      clip: getComputedStyle(after).clipPath,
      handle: handle.style.left,
    };
  };
  const dragTo = (frac) => slider.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: box.left + box.width * frac, clientY: box.top + box.height / 2,
    bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1,
  }));

  dragTo(0.25); const left = sample();
  dragTo(0.75); const right = sample();
  return JSON.stringify({ left, right, sliderW: Math.round(box.width) });
})()`;

/** Load a URL in headless Chrome and report what rendered and what broke. */
async function inspectPage(url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-smoke-'));
  const port = await freePort(9500);
  const proc = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-component-update',
    '--disable-background-networking', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = null;
    for (let i = 0; i < 50 && !ws; i++) {
      try { ws = (await httpJSON(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; }
      catch { await sleep(120); }
    }
    if (!ws) throw new Error('Chrome never exposed a debugging port');

    const cdp = await CDP.attach(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const problems = [];
    cdp.listeners.add((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        problems.push(d.exception?.description || d.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        problems.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
      }
    });

    await cdp.send('Page.navigate', { url }, sessionId);
    await cdp.once('Page.loadEventFired', sessionId, 7000);
    await sleep(2200);

    // Probe each tone's computed colour directly, so the check does not
    // depend on the session happening to contain that kind of step.
    const expr = `(() => {
      const tones = ['done','fix','visual','inspect','failed','running','pending','ask','asked'];
      const colors = {};
      for (const t of tones) {
        const probe = document.createElement('span');
        probe.className = 'icon t-' + t;
        document.body.append(probe);
        const cs = getComputedStyle(probe);
        colors[t] = { bg: cs.backgroundColor, border: cs.borderTopColor, anim: cs.animationName };
        probe.remove();
      }
      return JSON.stringify({
      messages: document.querySelectorAll('.msg').length,
      bubbles: document.querySelectorAll('.bubble').length,
      avatars: document.querySelectorAll('.avatar').length,
      composer: !!document.getElementById('composer'),
      theme: document.documentElement.getAttribute('data-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      timelineWidth: document.getElementById('timeline').getBoundingClientRect().width,
      headerBg: getComputedStyle(document.querySelector('.top')).backgroundColor,
      toneColors: colors,
      tabsShown: document.querySelectorAll('.tab-item').length,
      tabAdd: !!document.querySelector('.tab-add'),
      standaloneThinking: document.querySelectorAll('.msg.thinking').length,
      liveRows: document.querySelectorAll('.bubble.live').length,
      runningBubbles: document.querySelectorAll('.bubble:not(.live) .icon.t-running').length,
      liveOutsideList: [...document.querySelectorAll('.bubble.live, .icon.t-running')]
        .filter(n => !n.closest('.steps')).length,
      claudeMessages: [...document.querySelectorAll('.msg')]
        .filter(m => m.querySelector('.avatar.claude')).length
    });
    })()`;
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);

    const evaluate = async (expression) => {
      const got = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      if (got.exceptionDetails) return { error: got.exceptionDetails.text };
      try { return JSON.parse(got.result.value); }
      catch { return { error: `probe returned ${typeof got.result.value}` }; }
    };

    let keys = null;
    if (url.includes('keys=1')) keys = await evaluate(KEYS_PROBE);

    let vocab = null;
    if (url.includes('vocab=1')) vocab = await evaluate(VOCAB_PROBE);

    let cmds = null;
    if (url.includes('cmds=1')) cmds = await evaluate(COMMAND_PROBE);

    let dismiss = null;
    if (url.includes('dismiss=1')) { await sleep(700); dismiss = await evaluate(DISMISS_PROBE); }

    let drawer = null;
    if (url.includes('/detail') || url.includes('/thinking')) {
      await sleep(600);
      drawer = await evaluate(DRAWER_PROBE);
    }

    let swipe = null;
    if (url.includes('/visual')) {
      await sleep(600);
      swipe = await evaluate(SWIPE_PROBE);
    }
    cdp.close();
    return { dom: JSON.parse(result.value), problems, swipe, drawer, keys, vocab, dismiss, cmds };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    fs.rm(profile, { recursive: true, force: true }, () => {});
  }
}

async function main() {
  console.log('\nCore\n');

  const ops = lineDiff('a\nb\nc', 'a\nX\nc');
  check('diff finds one changed line', diffStats(ops).added === 1 && diffStats(ops).removed === 1);
  check('diff groups into hunks', hunks(ops, 1).length === 1);
  check('diff of identical text is empty', diffStats(lineDiff('same', 'same')).changed === 0);

  check('read-only command classified as inspect', classifyBash('ls -la && git log') === 'inspect');
  check('mutating command classified as change', classifyBash('git clone https://x.git') === 'change');
  check('piped read-only stays inspect', classifyBash('cat f | grep x | sort') === 'inspect');
  check('npm install is a change', classifyBash('npm install') === 'change');

  const sessions = listSessions();
  check('sessions indexed from disk', sessions.length > 0, `${sessions.length} found`);
  check('sessions carry a title', sessions.every((s) => !!s.title));

  // Prefer a session that has a stored before/after pair, so the swipe
  // checks have something real to work on.
  const hasPair = (id) => Object.values(loadShots(id)).some((p) => p.before && p.after);
  const ordered = [...sessions.slice(0, 25)].sort((a, b) => hasPair(b.sessionId) - hasPair(a.sessionId));

  let target = null;
  for (const s of ordered) {
    const { records } = readRecords(s.file, 0, 6 * 1024 * 1024);
    const built = buildSession(records, { live: false });
    const steps = built.turns.flatMap((t) => t.steps);
    if (steps.length >= 3) { target = { meta: s, records, session: built, steps }; break; }
  }
  check('found a session with real work in it', !!target);
  if (!target) return;

  check('turns have prompts', target.session.turns.some((t) => t.prompt));
  check('steps have labels', target.steps.every((s) => s.label && s.label.length > 0));
  check('steps have a known status',
    target.steps.every((s) => ['done', 'warn', 'failed', 'running', 'pending'].includes(s.status)));
  check('no step label is a raw tool name only',
    target.steps.filter((s) => s.label === 'Bash').length === 0);

  const history = buildFileHistory(target.records);
  const withChanges = target.steps.filter((s) => stepChanges(history, target.meta.sessionId, s, target.meta.cwd).length);
  check('file changes resolve for at least one step', withChanges.length > 0, `${withChanges.length} steps`);

  // Steps where Claude stopped and needed the person are the ones that will
  // not move on their own, so they have to be recognisable.
  let decision = null;
  for (const s of sessions.slice(0, 12)) {
    const { records } = readRecords(s.file, 0, 6 * 1024 * 1024);
    const found = buildSession(records, { live: false })
      .turns.flatMap((t) => t.steps).find((x) => x.needsUser);
    if (found) { decision = found; break; }
  }
  check('a decision point is recognised', !!decision, decision ? decision.label : 'none found');
  if (decision) {
    check('a decision point says whether it was settled', typeof decision.userResolved === 'boolean');
    check('an ordinary step is not marked a decision',
      target.steps.some((s) => !s.needsUser));
  }

  const entries = indexSession(target.session, { sessionId: target.meta.sessionId, title: target.meta.title });
  check('search index built', entries.length > 0, `${entries.length} entries`);
  check('search index includes prompts', entries.some((e) => e.kind === 'prompt'));
  const firstStep = entries.find((e) => e.kind === 'step');
  const hits = search(entries, firstStep.text.split(/\s+/)[0]);
  check('search finds a known step', hits.length > 0);
  check('search of nonsense finds nothing', search(entries, 'zzzzqqqxnotathing').length === 0);

  console.log('\nRunning terminals\n');

  // Claude Code writes ~/.claude/sessions/<pid>.json per running process, so
  // this needs no process scan and no guessing from file timestamps.
  const terms = listTerminals();
  check('terminals are discoverable', Array.isArray(terms), `${terms.length} found`);
  check('every terminal names its session and process',
    terms.every((t) => /^[0-9a-f-]{36}$/.test(t.sessionId) && t.pid > 0));
  check('every terminal has a title', terms.every((t) => !!t.title));
  check('terminal pids are alive', terms.every((t) => {
    try { process.kill(t.pid, 0); return true; } catch { return false; }
  }));
  check('no terminal is listed twice',
    new Set(terms.map((t) => t.sessionId)).size === terms.length);

  console.log('\nWorking detection\n');

  // A tool call and its result are written together once the tool finishes,
  // so an unfinished call is invisible. The signal is an api-request that is
  // newer than anything Claude has said.
  const probeActivity = (records) => {
    const w = new SessionWatcher('/dev/null', { sessionId: 'test', capture: false });
    w.records = records;
    w.session = { turns: [] };
    w.lastGrowthAt = Date.now();
    return w.activity();
  };
  const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

  check('request newer than output reads as working',
    probeActivity([
      { type: 'assistant', timestamp: at(10) },
      { type: 'user', timestamp: at(9) },
      { type: 'api-request', timestamp: at(8) },
    ]).working === true);

  check('output newer than request reads as idle',
    probeActivity([
      { type: 'api-request', timestamp: at(10) },
      { type: 'assistant', timestamp: at(8) },
    ]).working === false);

  check('a finished turn is not working',
    probeActivity([
      { type: 'api-request', timestamp: at(30) },
      { type: 'assistant', timestamp: at(29) },
      { type: 'user', timestamp: at(28) },
      { type: 'api-request', timestamp: at(27) },
      { type: 'assistant', timestamp: at(25) },
    ]).working === false);

  check('an abandoned request stops reading as working',
    probeActivity([
      { type: 'assistant', timestamp: at(60 * 60) },
      { type: 'api-request', timestamp: at(60 * 59) },
    ]).working === false);

  check('no records at all is idle', probeActivity([]).working === false);
  check('activity reports how long it has been quiet',
    typeof probeActivity([{ type: 'api-request', timestamp: at(5) }]).quietMs === 'number');

  console.log('\nGen Z library\n');

  check('library is substantial', TERMS.length >= 100, `${TERMS.length} terms`);
  check('library is grouped', CATEGORIES.length >= 6, `${CATEGORIES.length} categories`);
  check('every category has entries', CATEGORIES.every((c) => byCategory(c).length > 0));
  check('every term has all three parts',
    TERMS.every((x) => x.plain && x.genz && x.note && x.tag));
  check('notes actually explain', TERMS.every((x) => x.note.length > 8));
  const plains = TERMS.map((x) => x.plain);
  check('no duplicate plain terms', new Set(plains).size === plains.length,
    plains.filter((v, i) => plains.indexOf(v) !== i).join(', '));
  check('plain terms are not the slang', TERMS.every((x) => x.plain.toLowerCase() !== x.genz.toLowerCase()));

  const rot = createRotation();
  const seen = new Set();
  for (let i = 0; i < TERMS.length; i++) seen.add(rot.next().plain);
  check('rotation shows every term before repeating', seen.size === TERMS.length,
    `${seen.size}/${TERMS.length}`);
  check('rotation keeps going past a full pass', !!rot.next()?.plain);
  check('lookup finds by slang', find('goated').length > 0);
  check('lookup finds by plain phrase', find('Excellent').length > 0);
  check('lookup finds by meaning', find('greatest of all time').length > 0);
  check('lookup of nonsense finds nothing', find('zzzqqqnothing').length === 0);

  console.log('\nCapture targeting\n');

  const listening = listeningServers();
  check('listening ports are discoverable', listening.length > 0, `${listening.length} found`);
  check('every row names its process', listening.every((l) => l.pid > 0 && typeof l.command === 'string'));
  check('browsers are excluded as capture targets',
    !listening.some((l) => /chrome|chromium|firefox|safari/i.test(l.command)),
    listening.filter((l) => /chrome/i.test(l.command)).map((l) => l.port).join(', '));

  console.log('\nServer\n');

  const port = await freePort(7900);
  const { close } = await startServer({
    port,
    file: target.meta.file,
    sessionId: target.meta.sessionId,
    cwd: target.meta.cwd || process.cwd(),
    title: target.meta.title,
    capture: false,
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p).then((r) => r.json());

  try {
    const state = await get('/api/state');
    check('GET /api/state returns a session', !!state.session);
    check('state reports the person', !!state.person, String(state.person));
    check('state reports run status', state.run?.status === 'idle');
    check('steps are summarised, not dumped', state.session.turns.every(
      (t) => t.steps.every((s) => s.callCount !== undefined && s.calls === undefined)));

    const list = await get('/api/sessions');
    check('GET /api/sessions lists sessions', list.sessions.length > 0);

    const inst = await get('/api/instances');
    check('GET /api/instances responds', Array.isArray(inst.instances));

    const anyStep = state.session.turns.flatMap((t) => t.steps)[0];
    const detail = await get(`/api/step?id=${anyStep.id}`);
    check('GET /api/step returns detail', detail.step?.id === anyStep.id);
    check('step detail includes calls', Array.isArray(detail.step.calls));
    check('step detail includes changes', Array.isArray(detail.changes));

    const missing = await get('/api/step?id=s999999');
    check('unknown step is a clean 404', !!missing.error);

    const found = await get(`/api/search?q=${encodeURIComponent(firstStep.text.split(/\s+/)[0])}`);
    check('GET /api/search returns results', found.results.length > 0);

    const t0 = Date.now();
    const all = await get('/api/search?q=the&scope=all');
    const elapsed = Date.now() - t0;
    check('search across all sessions responds', Array.isArray(all.results));
    check('search across all sessions is not slow', elapsed < 25000, `${elapsed}ms`);

    const empty = await fetch(`${base}/api/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    });
    check('empty prompt is refused', empty.status === 409);

    const notFound = await fetch(`${base}/nope.txt`);
    check('unknown path is 404', notFound.status === 404);

    const page = await fetch(base + '/');
    check('GET / serves the page', page.status === 200 && (await page.text()).includes('Orderly Claude'));

    const cmdList = await get('/api/commands');
    check('GET /api/commands lists commands', cmdList.commands?.length >= 15, `${cmdList.commands?.length}`);
    check('every command is described',
      cmdList.commands.every((c) => c.name && c.summary && typeof c.runsHere === 'boolean'));
    check('commands needing the terminal are flagged',
      cmdList.commands.find((c) => c.name === 'model')?.runsHere === false);
    check('commands usable from here are flagged',
      cmdList.commands.find((c) => c.name === 'compact')?.runsHere === true);

    const sessionList = await get('/api/sessions');
    check('sessions say which are running now',
      sessionList.sessions.every((x) => typeof x.active === 'boolean'));

    const other = sessionList.sessions.find((x) => x.sessionId !== state.instance.sessionId);
    if (other) {
      const moved = await fetch(`${base}/api/watch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: other.sessionId }),
      }).then((r) => r.json());
      check('can follow another terminal', moved.sessionId === other.sessionId, JSON.stringify(moved));
      const after = await get('/api/state');
      check('the header follows the switch', after.meta?.title === other.title,
        `${after.meta?.title} vs ${other.title}`);
      check('the switched session is still live', after.live === true);

      await fetch(`${base}/api/watch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.instance.sessionId }),
      });
      const back = await get('/api/state');
      check('and can switch back', back.instance.sessionId === state.instance.sessionId);
    }

    const unknownSession = await fetch(`${base}/api/watch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    });
    check('following an unknown session is refused', unknownSession.status === 404);

    const termList = await get('/api/terminals');
    check('GET /api/terminals answers', Array.isArray(termList.terminals));
    check('the watched session is open as a tab', termList.tabs?.length >= 1);

    const spare = sessionList.sessions.find((x) => x.sessionId !== state.instance.sessionId);
    if (spare) {
      const opened = await fetch(`${base}/api/tabs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: spare.sessionId, focus: false }),
      }).then((r) => r.json());
      check('a second tab opens', opened.tabs?.length === 2, JSON.stringify(opened.tabs?.length));
      check('opening without focus leaves the first tab active',
        opened.active === state.instance.sessionId);

      const background = await get(`/api/state?session=${spare.sessionId}`);
      check('a background tab is readable live', background.live === true);

      const focused = await fetch(`${base}/api/tabs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: spare.sessionId }),
      }).then((r) => r.json());
      check('a tab can be brought forward', focused.active === spare.sessionId);
      check('the other tab stays open', focused.tabs?.length === 2);

      await fetch(`${base}/api/tabs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.instance.sessionId }),
      });
      const closed = await fetch(`${base}/api/tabs/close`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: spare.sessionId }),
      }).then((r) => r.json());
      check('a tab closes', closed.tabs?.length === 1);

        // Starting a session from here: the tab exists before any transcript does.
      const made = await fetch(`${base}/api/tabs/new`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      }).then((r) => r.json());
      check('a new session can be started here', /^[0-9a-f-]{36}$/.test(made.sessionId || ''), made.sessionId);
      check('the new session opens as a tab', made.tabs?.some((x) => x.sessionId === made.sessionId));
      check('the new tab is brought forward', made.active === made.sessionId);
      check('the new tab is marked as not yet started',
        made.tabs?.find((x) => x.sessionId === made.sessionId)?.fresh === true);

      const emptyView = await get(`/api/state?session=${made.sessionId}`);
      check('an unstarted session reads as empty, not broken',
        emptyView.session?.turns?.length === 0, JSON.stringify(emptyView.session?.turns?.length));

      await fetch(`${base}/api/tabs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.instance.sessionId }),
      });
      await fetch(`${base}/api/tabs/close`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: made.sessionId }),
      });

    const lastOne = await fetch(`${base}/api/tabs/close`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.instance.sessionId }),
      });
      check('closing the last tab is refused', lastOne.status === 409);
    }

    const lib = await fetch(base + '/genz.mjs');
    check('the library is served to the page', lib.status === 200
      && (lib.headers.get('content-type') || '').includes('javascript'));

    console.log('\nBrowser\n');

    if (!findChrome()) {
      check('Chrome available for rendering checks', false, 'no Chrome found');
    } else {
      for (const theme of ['light', 'dark']) {
        const { dom, problems } = await inspectPage(`${base}/?theme=${theme}`);
        check(`${theme}: no console errors`, problems.length === 0, problems[0] || '');
        check(`${theme}: messages rendered`, dom.messages > 0, `${dom.messages} messages`);
        check(`${theme}: bubbles rendered`, dom.bubbles > 0, `${dom.bubbles} bubbles`);
        check(`${theme}: avatars rendered`, dom.avatars === dom.messages);
        check(`${theme}: composer present`, dom.composer === true);
        check(`${theme}: a tab is shown per open session`, dom.tabsShown >= 1, String(dom.tabsShown));
        check(`${theme}: terminals can be added`, dom.tabAdd === true);
        // Work in flight belongs to the message it started in, not a new one.
        check(`${theme}: no standalone thinking message`, dom.standaloneThinking === 0, String(dom.standaloneThinking));
        check(`${theme}: live row sits inside a checklist`, dom.liveOutsideList === 0, String(dom.liveOutsideList));
        check(`${theme}: live row never doubles a running step`,
          !(dom.liveRows > 0 && dom.runningBubbles > 0),
          `${dom.liveRows} live / ${dom.runningBubbles} running`);
        check(`${theme}: at most one live indicator`, dom.liveRows + dom.runningBubbles <= 1,
          `${dom.liveRows + dom.runningBubbles}`);
        check(`${theme}: theme applied`, dom.theme === theme, String(dom.theme));
        check(`${theme}: conversation column has width`, dom.timelineWidth > 400, `${Math.round(dom.timelineWidth)}px`);
        check(`${theme}: header bar is dark`, dom.headerBg === 'rgb(10, 10, 10)', dom.headerBg);
        const tc = dom.toneColors;
        check(`${theme}: finished steps are filled`, tc.done.bg !== 'rgba(0, 0, 0, 0)', tc.done.bg);
        check(`${theme}: a fix is its own colour`, tc.fix.bg !== tc.done.bg, `${tc.fix.bg} vs ${tc.done.bg}`);
        check(`${theme}: a before/after is its own colour`, tc.visual.bg !== tc.done.bg, tc.visual.bg);
        check(`${theme}: a look-only step is its own colour`, tc.inspect.bg !== tc.done.bg, tc.inspect.bg);
        check(`${theme}: a failure is its own colour`, tc.failed.bg !== tc.done.bg, tc.failed.bg);
        check(`${theme}: in-flight steps are hollow, not filled`, tc.running.bg === 'rgba(0, 0, 0, 0)', tc.running.bg);
        check(`${theme}: in-flight steps spin`, tc.running.anim === 'spin', tc.running.anim);
        check(`${theme}: pending steps neither fill nor spin`,
          tc.pending.bg === 'rgba(0, 0, 0, 0)' && tc.pending.anim === 'none');

        // A decision must not be mistaken for any other state.
        const others = ['done', 'fix', 'visual', 'inspect', 'failed', 'asked'];
        check(`${theme}: waiting on you is its own colour`,
          others.every((k) => tc.ask.bg !== tc[k].bg), tc.ask.bg);
        check(`${theme}: waiting on you draws the eye`, tc.ask.anim === 'askPulse', tc.ask.anim);
        check(`${theme}: an answered question is its own colour`,
          tc.asked.bg !== tc.done.bg && tc.asked.bg !== tc.ask.bg, tc.asked.bg);
        check(`${theme}: an answered question does not keep pulsing`, tc.asked.anim === 'none', tc.asked.anim);

        if (theme === 'light') {
          check('light: page background is white', dom.bodyBg === 'rgb(255, 255, 255)', dom.bodyBg);
          check('light: a fix is the tan tone', tc.fix.bg === 'rgb(199, 169, 138)', tc.fix.bg);
          check('light: finished work is near-black', tc.done.bg === 'rgb(26, 29, 33)', tc.done.bg);
        }
      }

      // The swipe must reveal the after image, never move or resize it.
      const shotStep = state.session.turns.flatMap((t) => t.steps).find((s) => s.hasShots);
      if (!shotStep) {
        console.log('  skip swipe checks — no step in this session has a before/after');
      } else {
        const link = `${base}/?theme=light#${state.instance.sessionId}/${shotStep.id}/visual`;
        const { swipe, problems } = await inspectPage(link);
        check('swipe: no console errors', problems.length === 0, problems[0] || '');
        check('swipe: slider is reachable', !!swipe && !swipe.error, swipe?.error || '');
        if (swipe && !swipe.error) {
          const { left, right } = swipe;
          check('swipe: after image keeps its width', left.afterW === right.afterW, `${left.afterW} vs ${right.afterW}`);
          check('swipe: after image does not slide', left.afterL === right.afterL, `${left.afterL} vs ${right.afterL}`);
          check('swipe: after image fills the frame', left.afterW === swipe.sliderW - 2 || left.afterW >= swipe.sliderW - 4,
            `${left.afterW} in ${swipe.sliderW}`);
          check('swipe: before image stays put', left.beforeW === right.beforeW && left.beforeL === right.beforeL);
          check('swipe: the clip actually moves', left.clip !== right.clip, `${left.clip} / ${right.clip}`);
          check('swipe: handle follows the drag', left.handle !== right.handle, `${left.handle} / ${right.handle}`);
        }
      }

      // What happened should read plainly; the detail belongs under Reasoning.
      const anyStepId = state.session.turns.flatMap((t) => t.steps).find((s) => s.callCount > 0)?.id;
      if (anyStepId) {
        const sid = state.instance.sessionId;
        const plain = await inspectPage(`${base}/?theme=light#${sid}/${anyStepId}/detail`);
        check('what happened: opens', !!plain.drawer && !plain.drawer.error, plain.drawer?.error || '');
        check('what happened: leads with a plain headline', plain.drawer?.headlines === 1,
          String(plain.drawer?.headlines));
        check('what happened: shows no raw command blocks', plain.drawer?.codeBlocks === 0,
          String(plain.drawer?.codeBlocks));
        check('what happened: no console errors', plain.problems.length === 0, plain.problems[0] || '');

        const deep = await inspectPage(`${base}/?theme=light#${sid}/${anyStepId}/thinking`);
        check('reasoning: carries the detail', deep.drawer?.codeBlocks > 0, String(deep.drawer?.codeBlocks));
        check('reasoning: no console errors', deep.problems.length === 0, deep.problems[0] || '');
      }

      if (anyStepId) {
        const { dismiss } = await inspectPage(
          `${base}/?theme=light&dismiss=1#${state.instance.sessionId}/${anyStepId}/detail`);
        check('panel: opens from a link', dismiss?.opened === 'false', JSON.stringify(dismiss));
        check('panel: a click inside keeps it open', dismiss?.afterInside === 'false');
        check('panel: a click outside closes it', dismiss?.afterOutside === 'true');
        check('panel: clicking a step reopens it', dismiss?.afterBubble === 'false');
        check('panel: clicking another step keeps it open', dismiss?.afterSecondBubble === 'false');
        check('panel: Escape closes it', dismiss?.afterEscape === 'true');
      }

      const { cmds } = await inspectPage(`${base}/?theme=light&cmds=1`);
      check('commands: list reaches the page', cmds?.loaded >= 15, JSON.stringify(cmds?.loaded));
      check('commands: typing / offers them', cmds?.openedOnSlash === true);
      check('commands: the list is populated', cmds?.offered > 0, String(cmds?.offered));
      check('commands: typing narrows it', cmds?.filtered?.includes('/model'), JSON.stringify(cmds?.filtered));
      check('commands: Tab completes', cmds?.tabHandled === true && cmds?.afterTab === '/model ', cmds?.afterTab);
      check('commands: the mode is named', cmds?.chipShown === true && /\/model/.test(cmds?.chipText || ''), cmds?.chipText);
      check('commands: terminal-only is said plainly', /terminal/i.test(cmds?.chipText || ''), cmds?.chipText);
      check('commands: the list closes once arguments start', cmds?.closedOnArgs === true);
      check('commands: the mode stays named while typing arguments',
        /\/compact/.test(cmds?.argChip || ''), cmds?.argChip);
      check('commands: prose is not a command', cmds?.chipGoneForProse === true);

      const { vocab } = await inspectPage(`${base}/?theme=light&vocab=1`);
      check('live row: seam reachable', !!vocab && !vocab.error, vocab?.error || '');
      if (vocab && !vocab.error) {
        for (const v of ['genz', 'plain', 'booth']) {
          check(`live row: ${v} renders a term`, !!vocab[v]?.term, JSON.stringify(vocab[v]));
        }
        check('live row: a translation has both halves',
          !!vocab.genz?.term && !!vocab.genz?.plain && vocab.genz.term !== vocab.genz.plain,
          JSON.stringify(vocab.genz));
        check('live row: a translation carries its meaning', (vocab.genz?.note || '').length > 8);
        check('live row: tooltip is written out', (vocab.title || '').length > 20, vocab.title);
        check('live row: a stall is reported plainly, not as slang',
          !vocab.stalled || vocab.displayed?.term === 'Still working',
          JSON.stringify(vocab.displayed));
      }

      const { keys, problems: keyProblems } = await inspectPage(`${base}/?theme=light&keys=1`);
      check('composer: Enter sends', keys?.plainEnter === true, JSON.stringify(keys));
      check('composer: Shift+Enter makes a new line', keys?.shiftEnter === false);
      check('composer: Enter mid-composition does not send', keys?.composing === false);
      check('composer: grows with the text', keys && keys.after > keys.before,
        `${keys?.before} -> ${keys?.after}`);
      check('composer: no console errors', keyProblems.length === 0, keyProblems[0] || '');

      const shot = path.join(os.tmpdir(), `cz-smoke-${Date.now()}.png`);
      const res = await screenshot(`${base}/`, shot, { width: 1100, height: 700 });
      check('screenshot captured despite live SSE connection', res.ok, res.error || '');
      if (res.ok) {
        check('screenshot is a real image', fs.statSync(shot).size > 10000);
        fs.rmSync(shot, { force: true });
      }
      shutdownBrowser();
    }
  } finally {
    close();
  }

  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\nsmoke test crashed:', e.stack || e.message);
  process.exit(1);
});
