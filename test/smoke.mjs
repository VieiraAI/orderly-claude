#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 *   node test/smoke.mjs
 *
 * Builds a throwaway world (see scratch-world.mjs), boots a real server on
 * the session in it, exercises every API route, then loads the page in
 * headless Chrome and checks it rendered with no console errors — in both
 * themes. Exits non-zero on any failure. Reads nothing of the person's
 * sessions, repos, runs or workflows, and leaves nothing behind.
 */
// First, so every path is pointed at the scratch world before src/ loads.
import * as world from './scratch-world.mjs';
import net from 'node:net';
import http from 'node:http';
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
import { rendersInto, shouldCapture, readComparison, attribution, NOISE_FLOOR } from '../src/core/visual.mjs';
import { TERMS, CATEGORIES, createRotation, find, byCategory } from '../web/genz.mjs';
import { fileURLToPath } from 'node:url';
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
  // A dev server started by Claude keeps a run open indefinitely; the
  // composer must stay usable through it.
  out.idle = window.__cz.showRun({ status: 'idle', busy: false });
  out.working = window.__cz.showRun({ status: 'running', busy: true, runningMs: 4000 });
  out.longRun = window.__cz.showRun({ status: 'running', busy: true, runningMs: 400000 });
  out.stalled = window.__cz.isStalled();
  out.displayed = window.__cz.vocabText();
  return JSON.stringify(out);
})()`;

/* A diff used to run off the right edge and show every line of a new file
   as an undifferentiated wall. */
/* A step that needs a decision must say which decision. */
const ASK_PROBE = `(() => {
  const box = document.querySelector('.ask-box');
  if (!box) return JSON.stringify({ error: 'no decision panel' });
  return JSON.stringify({
    status: (box.querySelector('.ask-status')?.textContent || '').trim(),
    waiting: box.classList.contains('waiting'),
    questions: [...box.querySelectorAll('.ask-text')].map(n => n.textContent.slice(0, 60)),
    options: box.querySelectorAll('.ask-option').length,
    described: [...box.querySelectorAll('.ask-option')].filter(o => o.querySelector('.ask-desc')).length,
    picked: box.querySelectorAll('.ask-option.picked').length,
    codeBlocks: box.querySelectorAll('pre').length,
  });
})()`;

const DIFF_PROBE = `(() => {
  const file = document.querySelector('.file');
  if (!file) return JSON.stringify({ error: 'no diff on screen' });
  const body = file.querySelector('.file-body');
  const row = file.querySelector('.row .code');
  const out = {
    head: !!file.querySelector('.file-head .fname'),
    stats: (file.querySelector('.fstat')?.textContent || '').trim(),
    bar: !!file.querySelector('.stat-bar'),
    folded: body.classList.contains('folded'),
    wraps: row ? getComputedStyle(row).whiteSpace : null,
    overflowX: Math.max(0, body.scrollWidth - body.clientWidth),
    rows: file.querySelectorAll('.row').length,
  };
  const more = file.querySelector('.file-more');
  out.hasToggle = !!more;
  if (more) {
    more.click();
    out.foldedAfterClick = body.classList.contains('folded');
    out.toggleLabel = more.textContent.trim();
  }
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

    let ask = null;
    if (url.includes('needsyou=1')) { await sleep(700); ask = await evaluate(ASK_PROBE); }

    let diff = null;
    if (url.includes('/changes')) { await sleep(700); diff = await evaluate(DIFF_PROBE); }

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
    return { dom: JSON.parse(result.value), problems, swipe, drawer, keys, vocab, dismiss, cmds, diff, ask };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    fs.rm(profile, { recursive: true, force: true }, () => {});
  }
}

async function main() {
  // Schedules, settings, runs, sessions and workflows all live in the
  // scratch world, so the schedule ticker the server runs fires nothing real.
  console.log(`\nCore (scratch world: ${world.home})\n`);

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
  // A stored before/after on the edit, so the swipe checks have one to drag.
  if (withChanges.length) world.seedShotPair(withChanges[0].id);

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

  console.log('\nNaming\n');

  /*
   * The project was renamed, and a stray old name in anything a person reads
   * is the sort of thing that survives for years. Two mentions are deliberate:
   * the previous data directory, so old screenshots are still found, and the
   * mod's previous tool name, so older transcripts still read.
   */
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ALLOWED = new Set(['src/core/paths.mjs', 'src/core/steps.mjs']);
  const walk = (dir) => {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (name.name === '.git' || name.name === 'node_modules') continue;
      const full = path.join(dir, name.name);
      if (name.isDirectory()) out.push(...walk(full));
      else if (/\.(mjs|js|tsx|ts|json|html|css|md)$/.test(name.name)) out.push(full);
    }
    return out;
  };

  const stale = [];
  for (const file of walk(repoRoot)) {
    const rel = path.relative(repoRoot, file);
    if (ALLOWED.has(rel) || rel.startsWith('test/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/claudenized/i.test(text)) stale.push(rel);
  }
  check('no stray mentions of the old name', stale.length === 0, stale.join(', '));
  check('the deliberate ones are still there, and explained',
    /Kept so screenshots taken under the previous name/.test(fs.readFileSync(path.join(repoRoot, 'src/core/paths.mjs'), 'utf8'))
    && /mcp__claudenized__plan/.test(fs.readFileSync(path.join(repoRoot, 'src/core/steps.mjs'), 'utf8')));

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  check('the package is named for the project', manifest.name === 'orderly-claude', manifest.name);
  check('the command is on the package', !!manifest.bin?.orderly, JSON.stringify(manifest.bin));
  check('the entry point exists', fs.existsSync(path.join(repoRoot, manifest.bin.orderly)));

  console.log('\nWhat deserves a picture\n');

  /*
   * Measured on 509 real captures: 382 photographed this viewer's own page,
   * which redraws as the conversation grows, so a byte comparison called 71%
   * of pairs "changed" while almost none showed anything. These checks hold
   * the rules that replaced that.
   */
  const APP = '/work/site';
  const draws = (f) => rendersInto(f, APP).renders;

  check('a stylesheet draws', draws(`${APP}/src/app.css`));
  check('a component draws', draws(`${APP}/src/Hero.tsx`));
  check('markup draws', draws(`${APP}/index.html`));
  check('an image draws', draws(`${APP}/public/logo.png`));
  check('build configuration draws', draws(`${APP}/vite.config.ts`));
  check('a test does not draw', !draws(`${APP}/src/Hero.test.tsx`));
  check('a test folder does not draw', !draws(`${APP}/tests/e2e/home.ts`));
  check('a readme does not draw', !draws(`${APP}/README.md`));
  check('a lockfile does not draw', !draws(`${APP}/package-lock.json`));
  check('vendored code does not draw', !draws(`${APP}/node_modules/x/index.js`));
  check('build output does not draw', !draws(`${APP}/dist/bundle.js`));
  check('a file outside the app does not draw', !draws('/elsewhere/other.css'));
  check('prose in a content folder does draw', draws(`${APP}/src/content/post.md`));
  check('prose outside one does not', !draws(`${APP}/notes.md`));
  check('a refusal explains itself',
    (rendersInto(`${APP}/README.md`, APP).reason || '').length > 3,
    rendersInto(`${APP}/README.md`, APP).reason);

  const stepWith = (files, kind = 'change') => ({ kind, files: files.map((path) => ({ path })) });
  const DEV = 'http://localhost:3000';

  check('a step touching the stylesheet is photographed',
    shouldCapture(stepWith([`${APP}/src/app.css`]), { projectDir: APP, devUrl: DEV, selfPort: 7788 }).capture);
  check('a step touching only tests is not',
    !shouldCapture(stepWith([`${APP}/src/a.test.ts`]), { projectDir: APP, devUrl: DEV, selfPort: 7788 }).capture);
  check('a step that wrote nothing is not',
    !shouldCapture(stepWith([]), { projectDir: APP, devUrl: DEV, selfPort: 7788 }).capture);
  check('a look-only step is not',
    !shouldCapture(stepWith([`${APP}/src/app.css`], 'inspect'), { projectDir: APP, devUrl: DEV, selfPort: 7788 }).capture);
  check('nothing is photographed when no app is running',
    !shouldCapture(stepWith([`${APP}/src/app.css`]), { projectDir: APP, devUrl: null, selfPort: 7788 }).capture);
  // The failure that produced three quarters of the useless pairs.
  check('this viewer never photographs itself',
    !shouldCapture(stepWith([`${APP}/src/app.css`]),
      { projectDir: APP, devUrl: 'http://localhost:7788', selfPort: 7788 }).capture);
  check('a refusal to photograph says why',
    (shouldCapture(stepWith([`${APP}/README.md`]), { projectDir: APP, devUrl: DEV }).reason || '').length > 3);

  const comparison = (ratio, box) => readComparison({ ratio, box, width: 1000, height: 1000 });
  check('a pair below the noise floor is not a change', !comparison(NOISE_FLOOR / 2, { x: 1, y: 1, w: 2, h: 2 }).changed);
  check('a real difference is a change', comparison(0.08, { x: 100, y: 100, w: 200, h: 120 }).changed);
  check('a change reports how much moved', comparison(0.08, { x: 100, y: 100, w: 200, h: 120 }).percent === 8);
  check('a change keeps the region, padded', (() => {
    const r = comparison(0.08, { x: 100, y: 100, w: 200, h: 120 });
    return r.box && r.box.x < 100 && r.box.w > 200;
  })());
  check('a change covering everything is not offered as a crop',
    comparison(0.95, { x: 0, y: 0, w: 1000, h: 1000 }).wholePage === true);
  check('an unreadable comparison is not called unchanged',
    readComparison(null).changed === false && /could not/.test(readComparison(null).reason));

  check('a tight pair is trusted', attribution(5000).level === 'tight');
  check('a wide pair is flagged', attribution(5 * 60 * 1000).level === 'weak');
  check('a flagged pair says how far apart', !!attribution(5 * 60 * 1000).note);

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

  // A listener of the suite's own, so this does not lean on whatever else
  // happens to be running on the machine.
  const ownListener = net.createServer();
  await new Promise((r) => ownListener.listen(0, '127.0.0.1', r));
  const ownPort = ownListener.address().port;
  const listening = listeningServers();
  ownListener.close();
  check('listening ports are discoverable',
    listening.some((l) => l.port === ownPort), `${listening.length} found`);
  check('every row names its process', listening.every((l) => l.pid > 0 && typeof l.command === 'string'));
  check('browsers are excluded as capture targets',
    !listening.some((l) => /chrome|chromium|firefox|safari/i.test(l.command)),
    listening.filter((l) => /chrome/i.test(l.command)).map((l) => l.port).join(', '));

  console.log('\nServer\n');

  // Keep smoke runs free and fast: force mock handlers unless the caller
  // explicitly asked for the real CLI with ORDERLY_HANDLER_MODE=real.
  if (process.env.ORDERLY_HANDLER_MODE !== 'real') process.env.ORDERLY_HANDLER_MODE = 'mock';

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
  // Runs land in the scratch world, but remove them through the API anyway,
  // which exercises DELETE; remember when the suite began.
  const suiteStartedAt = new Date(Date.now() - 1000).toISOString();
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

    const wfs = await get('/api/workflows');
    check('GET /api/workflows lists built-in defs',
      Array.isArray(wfs.workflows) && wfs.workflows.length >= 3,
      `${wfs.workflows?.length}`);
    check('every workflow has a graph',
      wfs.workflows.every((w) => w.graph?.nodes?.length > 0 && Array.isArray(w.graph.edges)));
    // The list spans every known repo, so each entry says where it lives.
    check('every workflow carries its scope and key; project ones their repo',
      wfs.workflows.every((w) => w.scope && w.key
        && (w.scope !== 'project' || (w.repoRoot && w.repoName))),
      wfs.workflows.filter((w) => !w.key || (w.scope === 'project' && !w.repoRoot)).map((w) => w.id).join(', '));
    check('the list names the booted repo', typeof wfs.bootedRepo === 'string' && wfs.bootedRepo.length > 0, `${wfs.bootedRepo}`);
    const one = await get('/api/workflows/redesign-page');
    check('GET /api/workflows/:id returns the def', one.workflow?.id === 'redesign-page');

    // A small app to photograph: four real pages and one that 404s. The
    // starter has to count only the real ones.
    const appServer = http.createServer((req, res) => {
      const page = { '/': 'Home', '/blog': 'Blog', '/about': 'About', '/pricing': 'Pricing' }[req.url];
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      res.end(page ? `<html><body style="font-family:Inter;padding:16px"><h1>${page}</h1><p>Some text.</p></body></html>` : '<h1>Not found</h1>');
    });
    await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
    const appUrl = `http://127.0.0.1:${appServer.address().port}`;
    const started = await fetch(`${base}/api/workflows/visual-regression/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { baseline: 'main', devUrl: appUrl } }),
    }).then((r) => r.json());
    check('POST /api/workflows/:id/run starts a run', !!started.run?.runId);
    // The scheduler kicks in immediately, so the first node may already be
    // past pending by the time this response lands. Assert the graph was
    // seeded with the right shape instead.
    const vrDef = (await get('/api/workflows/visual-regression')).workflow;
    check('a run carries every node from the def',
      started.run.graph.nodes.length === vrDef.graph.nodes.length,
      `${started.run.graph.nodes.length} vs ${vrDef.graph.nodes.length}`);

    const runs = await get('/api/runs');
    check('GET /api/runs lists the new run',
      runs.runs.some((r) => r.runId === started.run?.runId));
    check('run summaries carry progress fields',
      runs.runs.every((r) => typeof r.totalNodes === 'number' && typeof r.doneNodes === 'number'));

    const one2 = await get(`/api/runs/${started.run?.runId}`);
    check('GET /api/runs/:id reads the full run back', one2.run?.runId === started.run?.runId);

    // Scheduler should march the graph without any client help. Poll until the
    // run reaches a terminal state or the budget elapses.
    let finished = null;
    // Mock handlers finish in under a second; a wider budget just absorbs
    // the occasional cold-start spawn delay on CI.
    const budget = Date.now() + 15000;
    while (Date.now() < budget) {
      await sleep(200);
      const r = (await get(`/api/runs/${started.run?.runId}`)).run;
      if (r && (r.status === 'done' || r.status === 'failed' || r.status === 'stopped')) {
        finished = r; break;
      }
    }
    check('scheduler finishes the run on its own', finished?.status === 'done',
      finished?.status || 'timed out');
    check('every node reached done', !!finished
      && finished.graph.nodes.every((n) => n.status === 'done'),
      finished?.graph.nodes.map((n) => `${n.id}=${n.status}`).join(' '));
    check('dev server step reports the app it found',
      finished?.graph.nodes.find((n) => n.id === 'server')?.output?.origin === appUrl,
      finished?.graph.nodes.find((n) => n.id === 'server')?.output?.out?.slice(0, 60));
    const vrPairs = finished?.graph.nodes.find((n) => n.id === 'shots')?.output?.pairs || [];
    check('capture-shots script produced a per-route grid', vrPairs.length === 5, String(vrPairs.length));
    check('a page that 404s is not counted as captured',
      vrPairs.find((p) => p.route === '/contact')?.status === 'failed'
      && /404/.test(vrPairs.find((p) => p.route === '/contact')?.error || ''),
      JSON.stringify(vrPairs.find((p) => p.route === '/contact')));
    check('real pages are captured', vrPairs.filter((p) => p.status === 'done').length === 4,
      vrPairs.map((p) => `${p.route}=${p.status}`).join(' '));
    const vrCheck = finished?.graph.nodes.find((n) => n.id === 'ok')?.output;
    check('check counts real captures and names the broken one',
      vrCheck?.pass === true && /4 of 5/.test(vrCheck?.reason || '') && /contact/.test(vrCheck?.reason || ''),
      vrCheck?.reason);
    appServer.close();

    // Pages that are errors or blank are recognised.
    const { pageProblem } = await import('../src/core/capture.mjs');
    check('pageProblem: 404 status', /404/.test(pageProblem({ status: 404, textLength: 9, elements: 1, images: 0 }) || ''));
    check('pageProblem: blank page', /blank/.test(pageProblem({ status: 200, textLength: 0, elements: 0, images: 0 }) || ''));
    check('pageProblem: a real page is fine', pageProblem({ status: 200, textLength: 120, elements: 12, images: 1 }) === null);

    // POST /stop on a finished run is a no-op; use it just to assert the route is wired.
    const stopResp = await fetch(`${base}/api/runs/${started.run?.runId}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    check('POST /api/runs/:id/stop returns 404 once the scheduler is gone', stopResp.status === 404);

    // Share — signed URL round-trip. Token has three dot-separated parts; the
    // /share/<token> route returns HTML; a tampered token comes back as 410.
    const shareResp = await fetch(`${base}/api/sessions/${state.instance.sessionId}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    check('POST /api/sessions/:id/share returns a token and url',
      typeof shareResp.token === 'string' && shareResp.token.split('.').length === 3
      && typeof shareResp.url === 'string' && shareResp.url.includes('/share/'),
      shareResp.error);
    const shareHtml = await fetch(`${base}/share/${shareResp.token}`);
    check('/share/:token serves HTML', shareHtml.status === 200
      && (shareHtml.headers.get('content-type') || '').includes('text/html'),
      `${shareHtml.status} ${shareHtml.headers.get('content-type')}`);
    const tampered = await fetch(`${base}/share/${shareResp.token.slice(0, -2)}aa`);
    check('tampered token is rejected', tampered.status === 410, String(tampered.status));

    // Share a run — same signed-token mechanism.
    const shareRun = await fetch(`${base}/api/runs/${started.run?.runId}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    check('POST /api/runs/:id/share returns a run token',
      typeof shareRun.token === 'string' && shareRun.token.startsWith('run:'),
      shareRun.token?.slice(0, 20));
    const runPage = await fetch(`${base}/share/${shareRun.token}`);
    check('/share/<run-token> serves HTML',
      runPage.status === 200 && (runPage.headers.get('content-type') || '').includes('text/html'),
      `${runPage.status}`);

    // Share a decision — mark one first, then share.
    await fetch(`${base}/api/decisions/mark`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'share-sess', stepId: 'share-step', note: 'shared' }),
    });
    const shareDec = await fetch(`${base}/api/decisions/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'share-sess', stepId: 'share-step' }),
    }).then((r) => r.json());
    check('POST /api/decisions/share returns a decision token',
      typeof shareDec.token === 'string' && shareDec.token.startsWith('decision:'),
      shareDec.token?.slice(0, 20));
    const decPage = await fetch(`${base}/share/${shareDec.token}`);
    check('/share/<decision-token> serves HTML',
      decPage.status === 200 && (decPage.headers.get('content-type') || '').includes('text/html'),
      `${decPage.status}`);
    await fetch(`${base}/api/decisions/mark`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'share-sess', stepId: 'share-step' }),
    });

    // Decisions — auto from ask-node answers, plus a mark round-trip.
    const dResp = await get('/api/decisions');
    check('GET /api/decisions returns an array',
      Array.isArray(dResp.decisions), typeof dResp.decisions);
    const mark = await fetch(`${base}/api/decisions/mark`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-sess', stepId: 'test-step', note: 'smoke' }),
    }).then((r) => r.json());
    check('POST /api/decisions/mark returns the row', mark.mark?.sessionId === 'test-sess');
    const after = await get('/api/decisions');
    check('mark shows up on next list', after.decisions.some((d) => d.sessionId === 'test-sess'));
    await fetch(`${base}/api/decisions/mark`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-sess', stepId: 'test-step' }),
    });
    const cleaned = await get('/api/decisions');
    check('DELETE removes the mark', !cleaned.decisions.some((d) => d.sessionId === 'test-sess'));

    // Prompts — one Markdown file per prompt, grouped by repo + global.
    const promptsResp = await get('/api/prompts');
    check('GET /api/prompts returns an array',
      Array.isArray(promptsResp.prompts), `${typeof promptsResp.prompts}`);
    const starter = promptsResp.prompts.find((p) => p.slug === 'review-diff');
    check('starter prompt review-diff is picked up',
      !!starter && starter.inputs?.length >= 2, starter ? `${starter.inputs?.length} inputs` : 'missing');
    const promptMod = await import('../src/core/prompts.mjs');
    const interp = promptMod.interpolate('a {{x}} b {{y|default}} c', { x: 'X' });
    check('interpolate fills vars and defaults', interp === 'a X b default c', JSON.stringify(interp));

    // Authoring: scaffold a def, validate it, write it, confirm it's listed.
    const sc = await get('/api/workflows/scaffold?id=smoke-authored');
    check('GET /api/workflows/scaffold returns a starter def',
      sc.def?.id === 'smoke-authored' && (sc.def?.graph?.nodes?.length || 0) >= 2);
    const vd = await fetch(`${base}/api/workflows/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: sc.def }),
    }).then((r) => r.json());
    check('POST /api/workflows/validate approves the scaffold', vd.ok === true,
      vd.problems?.join('; '));
    const saved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: sc.def, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    check('POST /api/workflows writes to .claude/workflows/',
      saved.saved === true && typeof saved.file === 'string' && saved.file.endsWith('smoke-authored.json'),
      saved.error);
    const roundTrip = await get('/api/workflows');
    check('new workflow shows up in the catalog',
      roundTrip.workflows.some((w) => w.id === 'smoke-authored'));
    // Clean up so the file doesn't drift between runs.
    try { fs.unlinkSync(saved.file); } catch {}

    // Workflow validator — accept good shapes, reject bad ones with a reason.
    const wfMod = await import('../src/core/workflows.mjs');
    const goodDef = { id: 'x', graph: {
      nodes: [{ id: 'a', kind: 'terminal' }, { id: 'b', kind: 'document' }],
      edges: [['a', 'b']],
    } };
    check('validator accepts a good def', wfMod.validateDefinition(goodDef).length === 0);
    const noId  = wfMod.validateDefinition({ graph: { nodes: [{ id: 'a', kind: 'terminal' }], edges: [] } });
    check('validator flags missing id', noId.some((p) => /id/i.test(p)), noId.join('; '));
    const dupId = wfMod.validateDefinition({ id: 'x', graph: {
      nodes: [{ id: 'a', kind: 't' }, { id: 'a', kind: 't' }], edges: [],
    } });
    check('validator flags duplicate node id', dupId.some((p) => /duplicate/i.test(p)), dupId.join('; '));
    const danglingEdge = wfMod.validateDefinition({ id: 'x', graph: {
      nodes: [{ id: 'a', kind: 't' }], edges: [['a', 'z']],
    } });
    check('validator flags edge to unknown node', danglingEdge.some((p) => /unknown node/i.test(p)),
      danglingEdge.join('; '));
    const cyclic = wfMod.validateDefinition({ id: 'x', graph: {
      nodes: [{ id: 'a', kind: 't' }, { id: 'b', kind: 't' }],
      edges: [['a', 'b'], ['b', 'a']],
    } });
    check('validator flags cycles', cyclic.some((p) => /cycle/i.test(p)), cyclic.join('; '));

    // v2 validator — accept the migrated starters and the scaffold; reject
    // unknown kinds, missing per-kind spec, and decision/edge-label drift.
    const v2Good = { schemaVersion: 2, id: 'v2', graph: {
      nodes: [
        { id: 'a', kind: 'agent',   spec: { prompt: 'write' } },
        { id: 'b', kind: 'publish', spec: { target: 'pr' } },
      ],
      edges: [['a', 'b']],
    } };
    check('v2 validator accepts a good def',
      wfMod.validateDefinition(v2Good).length === 0,
      wfMod.validateDefinition(v2Good).join('; '));
    const v2BadKind = wfMod.validateDefinition({ schemaVersion: 2, id: 'x', graph: {
      nodes: [{ id: 'a', kind: 'frobnicate', spec: {} }], edges: [],
    } });
    check('v2 validator flags unknown kind',
      v2BadKind.some((p) => /unknown kind/i.test(p)), v2BadKind.join('; '));
    const v2NoPrompt = wfMod.validateDefinition({ schemaVersion: 2, id: 'x', graph: {
      nodes: [{ id: 'a', kind: 'agent', spec: {} }], edges: [],
    } });
    check('v2 validator flags agent without a prompt',
      v2NoPrompt.some((p) => /prompt/i.test(p)), v2NoPrompt.join('; '));
    const v2EdgeDrift = wfMod.validateDefinition({ schemaVersion: 2, id: 'x', graph: {
      nodes: [
        { id: 'p', kind: 'decision', spec: { question: 'q', options: [
          { label: 'A', edgeLabel: 'a' }, { label: 'B', edgeLabel: 'b' },
        ] } },
        { id: 'x', kind: 'agent', spec: { prompt: 'ok' } },
      ],
      edges: [['p', 'x', 'c']],
    } });
    check('v2 validator flags edge label not in decision.options',
      v2EdgeDrift.some((p) => /edge label/i.test(p)), v2EdgeDrift.join('; '));
    // Migrated starters all validate.
    const starters = (await get('/api/workflows')).workflows.filter((w) => w.scope === 'builtin');
    const starterProblems = starters.flatMap((w) => wfMod.validateDefinition(w).map((p) => `${w.id}: ${p}`));
    check('migrated starters pass v2 validation',
      starterProblems.length === 0, starterProblems.join(' | '));

    // Brand pack: primitives are unit-testable without a run.
    const brandMod = await import('../src/core/brand.mjs');
    const brand = {
      colors: {},
      palette: { whitelist: ['#415A6B', '#A94E46', '#FFFFFF'], allowGrays: true, grayTolerance: 10 },
      fonts: { sans: { families: ['Inter', 'system-ui'] }, mono: { families: ['Menlo'] } },
      spacing: { unit: 4, scale: [0, 4, 8, 12, 16, 24, 32], tolerance: 1 },
      contrast: { min: 4.5 },
    };
    const inPal = brandMod.colorsInPalette(['#415A6B', '#A94E46'], brand, { ignoreGrays: false, tolerance: 2 });
    check('colorsInPalette passes exact matches', inPal.ok === true, JSON.stringify(inPal.offenders));
    const offPal = brandMod.colorsInPalette(['#FF00FF'], brand, { ignoreGrays: false, tolerance: 2 });
    check('colorsInPalette flags off-palette color',
      offPal.ok === false && offPal.offenders.length === 1,
      JSON.stringify(offPal));
    const grayIgnore = brandMod.colorsInPalette(['#808080'], brand, { ignoreGrays: true, tolerance: 2 });
    check('colorsInPalette ignores grays when asked', grayIgnore.ok === true,
      JSON.stringify(grayIgnore.offenders));

    const fBrand = brandMod.fontIsBrand('Inter, system-ui, sans-serif', brand, { role: 'sans' });
    check('fontIsBrand recognizes the brand sans', fBrand.ok === true, JSON.stringify(fBrand));
    const fWrong = brandMod.fontIsBrand('Comic Sans MS, cursive', brand, { role: 'sans' });
    check('fontIsBrand flags a non-brand family', fWrong.ok === false);

    const highRatio = brandMod.contrastRatio('#000000', '#FFFFFF');
    check('contrastRatio black/white ≈ 21', Math.round(highRatio) === 21, `got ${highRatio}`);
    const cPairs = brandMod.contrastPassesAll(
      [{ label: 'body', fg: '#1A1D21', bg: '#FFFFFF' }, { label: 'faint', fg: '#D0D0D0', bg: '#FFFFFF' }],
      brand,
    );
    check('contrastPassesAll flags only the failing pair',
      cPairs.ok === false && cPairs.failures.length === 1 && cPairs.failures[0].label === 'faint',
      JSON.stringify(cPairs.failures.map((f) => f.label)));

    const spc = brandMod.spacingOnScale([4, 8, 12, 10], brand);
    check('spacingOnScale flags 10 as off-scale',
      spc.ok === false && spc.offenders.length === 1 && spc.offenders[0].value === 10,
      JSON.stringify(spc.offenders));

    const hex = brandMod.scanRawHex('color: #ff00ff; border: 1px solid #A94E46;', brand, { ignoreGrays: true });
    check('scanRawHex flags off-palette raw hex',
      hex.ok === false && hex.offenders.length === 1 && hex.offenders[0].hex === '#FF00FF',
      JSON.stringify(hex.offenders));

    // Validator: new assert types are known; unknown ones are flagged.
    const checkDef = (assertSpec) => ({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [
          { id: 'a', kind: 'agent', spec: { prompt: 'p' } },
          { id: 'c', kind: 'check', spec: { assert: { from: 'a', ...assertSpec } } },
        ],
        edges: [['a', 'c']],
      },
    });
    check('validator accepts color-in-palette assert',
      wfMod.validateDefinition(checkDef({ type: 'color-in-palette' })).length === 0);
    check('validator accepts font-is-brand assert',
      wfMod.validateDefinition(checkDef({ type: 'font-is-brand', role: 'sans' })).length === 0);
    check('validator accepts contrast-min assert',
      wfMod.validateDefinition(checkDef({ type: 'contrast-min', ratio: 4.5 })).length === 0);
    const unknownAssert = wfMod.validateDefinition(checkDef({ type: 'wut' }));
    check('validator flags unknown assert type',
      unknownAssert.some((p) => /unknown assert type/i.test(p)), unknownAssert.join('; '));
    const badRatio = wfMod.validateDefinition(checkDef({ type: 'contrast-min', ratio: -1 }));
    check('validator flags negative contrast ratio',
      badRatio.some((p) => /ratio/i.test(p)), badRatio.join('; '));

    // Scheduler: Decision routes via labeled edges. Build a workflow where
    // one of two branches is picked; only that branch should reach done,
    // the other should be marked skipped.
    const routeDef = {
      schemaVersion: 2, id: 'smoke-route', title: 'Route smoke',
      graph: {
        nodes: [
          { id: 'pick', title: 'Pick', kind: 'decision', col: 1, row: 0,
            spec: { question: 'go?', options: [
              { label: 'yes', edgeLabel: 'y' }, { label: 'no', edgeLabel: 'n' },
            ] } },
          { id: 'y',    title: 'Yes branch', kind: 'script', col: 2, row: 0,
            spec: { cmd: 'echo yes' } },
          { id: 'n',    title: 'No branch',  kind: 'script', col: 2, row: 1,
            spec: { cmd: 'echo no' } },
        ],
        edges: [['pick', 'y', 'y'], ['pick', 'n', 'n']],
      },
    };
    const routeSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: routeDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    check('route-smoke def saved', routeSaved.saved === true, routeSaved.error);
    const routeStart = await fetch(`${base}/api/workflows/smoke-route/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    // Wait for the Decision to open, then answer with 'yes'.
    let askReady = null;
    const askBudget = Date.now() + 5000;
    while (Date.now() < askBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${routeStart.run?.runId}`)).run;
      if (r?.status === 'awaiting-answer') { askReady = r; break; }
    }
    check('decision opens an awaiting-answer slot', !!askReady, askReady?.status);
    await fetch(`${base}/api/runs/${routeStart.run?.runId}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'pick', answer: 'yes' }),
    });
    let routed = null;
    const routedBudget = Date.now() + 5000;
    while (Date.now() < routedBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${routeStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { routed = r; break; }
    }
    check('routed run finishes done', routed?.status === 'done',
      routed?.graph.nodes.map((n) => `${n.id}=${n.status}`).join(' '));
    const yes = routed?.graph.nodes.find((n) => n.id === 'y');
    const no  = routed?.graph.nodes.find((n) => n.id === 'n');
    check('picked branch ran', yes?.status === 'done', yes?.status);
    check('unpicked branch was skipped', no?.status === 'skipped', no?.status);
    try { fs.unlinkSync(routeSaved.file); } catch {}

    // Scheduler: Check gating stops the run with status failed by default.
    const gateDef = {
      schemaVersion: 2, id: 'smoke-gate', title: 'Gate smoke',
      graph: {
        nodes: [
          { id: 'cmd',  title: 'Cmd',   kind: 'script', col: 1, row: 0, spec: { cmd: 'echo nope' } },
          { id: 'need', title: 'Need?', kind: 'check',  col: 2, row: 0,
            spec: { assert: { type: 'contains', from: 'cmd', needle: 'IMPOSSIBLE' } } },
          { id: 'tail', title: 'Tail',  kind: 'script', col: 3, row: 0, spec: { cmd: 'echo tail' } },
        ],
        edges: [['cmd', 'need'], ['need', 'tail']],
      },
    };
    const gateSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: gateDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const gateStart = await fetch(`${base}/api/workflows/smoke-gate/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let gated = null;
    const gateBudget = Date.now() + 5000;
    while (Date.now() < gateBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${gateStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { gated = r; break; }
    }
    check('failing check stops the run as failed', gated?.status === 'failed',
      gated?.status || 'timed out');
    const needNode = gated?.graph.nodes.find((n) => n.id === 'need');
    check('the check node itself finished (pass: false)',
      needNode?.status === 'done' && needNode?.output?.pass === false,
      `${needNode?.status} / pass=${needNode?.output?.pass}`);
    try { fs.unlinkSync(gateSaved.file); } catch {}

    // MCP kind + publish shorthands.
    const mcpMod = await import('../src/core/mcp.mjs');
    check('resolveTool returns string template',
      mcpMod.resolveTool({ foo: { bar: 'echo {{x}}' } }, 'foo', 'bar') === 'echo {{x}}');
    check('resolveTool returns object.command form',
      mcpMod.resolveTool({ foo: { bar: { command: 'echo {{x}}' } } }, 'foo', 'bar') === 'echo {{x}}');
    check('resolveTool returns null when missing',
      mcpMod.resolveTool({}, 'foo', 'bar') === null);
    check('interpolate substitutes and shell-quotes',
      mcpMod.interpolate('echo {{t}} to {{team}}', { t: 'hello world', team: 'ENG' })
        === `echo 'hello world' to ENG`);
    check('interpolate blanks missing keys',
      mcpMod.interpolate('{{missing}}:done', {}) === ':done');

    const mcpValidator = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'm', kind: 'mcp', spec: {} }],
        edges: [],
      },
    });
    check('validator flags mcp without server+tool',
      mcpValidator.filter((p) => /spec\.(server|tool)/.test(p)).length === 2, mcpValidator.join('; '));
    const pubBad = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'p', kind: 'publish', spec: { target: 'slack-dm' } }],
        edges: [],
      },
    });
    check('validator flags unknown publish target',
      pubBad.some((p) => /unknown publish target/.test(p)), pubBad.join('; '));
    const pubGood = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'p', kind: 'publish', spec: { target: 'linear-issue' } }],
        edges: [],
      },
    });
    check('validator accepts linear-issue publish target',
      pubGood.length === 0, pubGood.join('; '));

    // End-to-end: an mcp call with a configured command runs and returns stdout.
    // The server reads .claude/mcp.json from the project it was booted on.
    const mcpFile = path.join(world.repo, '.claude', 'mcp.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({
      test: { echo: 'echo tool={{tool}} name={{name}}' },
    }, null, 2));
    const mcpRunDef = {
      schemaVersion: 2, id: 'smoke-mcp', title: 'MCP',
      graph: {
        nodes: [{ id: 'call', title: 'Call', kind: 'mcp', col: 1, row: 0,
          spec: { server: 'test', tool: 'echo', args: { tool: 'echo', name: 'smoke' } } }],
        edges: [],
      },
    };
    const mcpSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: mcpRunDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const mcpStart = await fetch(`${base}/api/workflows/smoke-mcp/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let mcpDone = null;
    const mcpBudget = Date.now() + 4000;
    while (Date.now() < mcpBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${mcpStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { mcpDone = r; break; }
    }
    check('mcp run finishes done', mcpDone?.status === 'done', mcpDone?.status);
    const mcpOut = mcpDone?.graph.nodes.find((n) => n.id === 'call')?.output;
    check('mcp invokes the configured command',
      mcpOut?.ok === true && /tool=echo name=smoke/.test(mcpOut?.out || ''),
      JSON.stringify(mcpOut).slice(0, 200));
    try { fs.unlinkSync(mcpFile); } catch {}
    try { fs.unlinkSync(mcpSaved.file); } catch {}

    // Unconfigured mcp call returns ok:false with a reason, not a crash.
    const mcpMissingDef = {
      schemaVersion: 2, id: 'smoke-mcp-missing', title: 'MCP missing',
      graph: {
        nodes: [{ id: 'call', title: 'Call', kind: 'mcp', col: 1, row: 0,
          spec: { server: 'nope', tool: 'nothing', args: {} } }],
        edges: [],
      },
    };
    const mmSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: mcpMissingDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const mmStart = await fetch(`${base}/api/workflows/smoke-mcp-missing/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let mmDone = null;
    const mmBudget = Date.now() + 3000;
    while (Date.now() < mmBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${mmStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { mmDone = r; break; }
    }
    const mmOut = mmDone?.graph.nodes.find((n) => n.id === 'call')?.output;
    check('unconfigured mcp returns ok:false with reason',
      mmOut?.ok === false && /not configured/.test(mmOut?.reason || ''),
      JSON.stringify(mmOut));
    try { fs.unlinkSync(mmSaved.file); } catch {}

    // Suggester: tokenize + score are pure, test directly.
    const suggMod = await import('../src/core/workflow-suggest.mjs');
    check('tokenize strips stop words and short tokens',
      JSON.stringify(suggMod.tokenize('redesign the hero page')) === JSON.stringify(['redesign', 'hero', 'page']));
    check('tokenize handles punctuation and case',
      JSON.stringify(suggMod.tokenize('Redesign-the-Hero,Page!')) === JSON.stringify(['redesign', 'hero', 'page']));

    const sampleDefs = [
      { id: 'redesign-page', title: 'Redesign a page',
        whenToUse: 'User wants to try visual variations for a specific route.',
        tags: ['design', 'visual', 'iterate'] },
      { id: 'visual-regression', title: 'Visual regression',
        whenToUse: 'Compare before/after captures for a diff.',
        tags: ['visual', 'check'] },
      { id: 'ship-pr', title: 'Ship a PR',
        whenToUse: 'Run tests, draft the body, open the PR.',
        tags: ['ship', 'review'] },
    ];
    const sug1 = suggMod.suggestWorkflows({ query: 'redesign the pricing page', defs: sampleDefs });
    check('suggestWorkflows picks redesign-page first',
      sug1[0]?.id === 'redesign-page', JSON.stringify(sug1.map((s) => s.id)));
    const sug2 = suggMod.suggestWorkflows({ query: 'open a pull request', defs: sampleDefs });
    check('suggestWorkflows includes ship-pr for "pull request"',
      sug2.some((s) => s.id === 'ship-pr'), JSON.stringify(sug2.map((s) => s.id)));
    const sug3 = suggMod.suggestWorkflows({ query: 'cucumber', defs: sampleDefs });
    check('suggestWorkflows returns empty when nothing matches',
      sug3.length === 0, JSON.stringify(sug3));

    // Validator: tags[] and whenToUse accepted.
    const defWithMeta = {
      schemaVersion: 2, id: 'x', title: 'X',
      tags: ['one', 'two'],
      whenToUse: 'When you need an x.',
      graph: { nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p' } }], edges: [] },
    };
    check('validator accepts tags + whenToUse',
      wfMod.validateDefinition(defWithMeta).length === 0,
      wfMod.validateDefinition(defWithMeta).join('; '));
    const badTags = wfMod.validateDefinition({ ...defWithMeta, tags: [1, 2] });
    check('validator flags non-string tags',
      badTags.some((p) => /tags/.test(p)), badTags.join('; '));

    // API: POST /api/workflows/suggest returns ranked matches.
    const sugResp = await fetch(`${base}/api/workflows/suggest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'ship a pr' }),
    }).then((r) => r.json());
    check('POST /api/workflows/suggest returns matches',
      Array.isArray(sugResp.matches), JSON.stringify(sugResp).slice(0, 100));
    check('each match says which workflow it is, by key and scope',
      sugResp.matches?.length > 0 && sugResp.matches.every((m) => m.key && m.scope), JSON.stringify(sugResp.matches?.[0] || {}));
    const sugEmpty = await fetch(`${base}/api/workflows/suggest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '' }),
    }).then((r) => r.json());
    check('empty query returns empty matches',
      Array.isArray(sugEmpty.matches) && sugEmpty.matches.length === 0,
      JSON.stringify(sugEmpty));

    // fanOut is gone: Repeat for each runs items in parallel and joins them.
    const fanGone = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: { nodes: [{ id: 'f', kind: 'fanOut', spec: { over: 'inputs.items' } }], edges: [] },
    });
    check('fanOut is no longer a step kind', fanGone.some((p) => /unknown kind/i.test(p)), fanGone.join('; '));
    const loopBadJoin = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'l', kind: 'loop', spec: { over: 'inputs.items', action: 'script', cmd: 'echo', join: 'first' } }],
        edges: [],
      },
    });
    check('validator flags unknown loop join', loopBadJoin.some((p) => /join must be/.test(p)), loopBadJoin.join('; '));

    const runLoop = async (id, spec, items) => {
      const def = { schemaVersion: 2, id, title: id, graph: { nodes: [{ id: 'l', title: 'L', kind: 'loop', col: 1, row: 0, spec }], edges: [] } };
      const saved = await fetch(`${base}/api/workflows`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ def, scope: 'project', overwrite: true }),
      }).then((r) => r.json());
      const started = await fetch(`${base}/api/workflows/${id}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: { items } }),
      }).then((r) => r.json());
      let finished = null;
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        await sleep(100);
        const r = (await get(`/api/runs/${started.run?.runId}`)).run;
        if (r && ['done', 'failed', 'stopped'].includes(r.status)) { finished = r; break; }
      }
      try { fs.unlinkSync(saved.file); } catch {}
      return finished?.graph.nodes.find((n) => n.id === 'l')?.output;
    };
    const firstOut = await runLoop('smoke-loop-first',
      { over: 'inputs.items', action: 'script', cmd: 'test {{item}} = b && echo hit={{item}}', concurrency: 3, join: 'first-match' }, 'a,b,c');
    check('loop first-match hands on the item that worked',
      firstOut?.joined?.item === 'b' && /hit=b/.test(firstOut?.joined?.out || ''), JSON.stringify(firstOut?.joined));
    const voteOut = await runLoop('smoke-loop-vote',
      { over: 'inputs.items', action: 'script', cmd: 'echo {{item}}', concurrency: 2, join: 'vote' }, 'yes,yes,no');
    check('loop vote passes when most items say yes',
      voteOut?.joined?.pass === true && voteOut?.joined?.yes === 2, JSON.stringify(voteOut?.joined));

    // Worktree sandbox: validator accepts/rejects runtime block.
    const defWithRuntime = {
      schemaVersion: 2, id: 'smoke-rt', title: 'Rt',
      runtime: { sandbox: 'worktree', keepOnFail: true, baseBranch: 'main' },
      graph: { nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p' } }], edges: [] },
    };
    check('validator accepts runtime block',
      wfMod.validateDefinition(defWithRuntime).length === 0,
      wfMod.validateDefinition(defWithRuntime).join('; '));
    const badSandbox = wfMod.validateDefinition({ ...defWithRuntime, runtime: { sandbox: 'docker' } });
    check('validator flags unknown sandbox',
      badSandbox.some((p) => /sandbox must be one of/.test(p)), badSandbox.join('; '));
    const badKeep = wfMod.validateDefinition({ ...defWithRuntime, runtime: { sandbox: 'worktree', keepOnFail: 'yes' } });
    check('validator flags non-boolean keepOnFail',
      badKeep.some((p) => /keepOnFail/.test(p)), badKeep.join('; '));

    // Worktree helper: round-trip create+remove.
    const { createWorktree, removeWorktree } = await import('../src/core/worktree.mjs');
    const repoRoot = world.repo;
    const wt = createWorktree({ repoRoot, name: `smoke-${Date.now()}` });
    check('worktree directory exists after create',
      fs.existsSync(wt.path) && fs.statSync(wt.path).isDirectory(), wt.path);
    check('worktree is a real checkout',
      fs.existsSync(path.join(wt.path, 'package.json')), 'no package.json');
    removeWorktree(wt.path, repoRoot);
    check('worktree gone after remove', !fs.existsSync(wt.path));

    // End-to-end: a script run with sandbox: worktree executes inside the worktree.
    const wtRunDef = {
      schemaVersion: 2, id: 'smoke-worktree-run', title: 'Worktree run',
      runtime: { sandbox: 'worktree' },
      graph: {
        nodes: [{ id: 'where', title: 'Where', kind: 'script', col: 1, row: 0, spec: { cmd: 'pwd' } }],
        edges: [],
      },
    };
    const wtRunSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: wtRunDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const wtRunStart = await fetch(`${base}/api/workflows/smoke-worktree-run/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let wtRunDone = null;
    const wtRunBudget = Date.now() + 8000;
    while (Date.now() < wtRunBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${wtRunStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { wtRunDone = r; break; }
    }
    check('worktree run finishes done', wtRunDone?.status === 'done', wtRunDone?.status);
    const whereOut = wtRunDone?.graph.nodes.find((n) => n.id === 'where')?.output?.out || '';
    check('script executed inside the worktree',
      /\.claude\/worktrees\/run-/.test(whereOut), whereOut.trim().slice(0, 120));
    check('sandbox cleaned up after success',
      wtRunDone?.sandboxPath == null, String(wtRunDone?.sandboxPath));
    try { fs.unlinkSync(wtRunSaved.file); } catch {}

    // Lessons: validator accepts a well-formed lessons[], rejects a malformed one.
    const defWithLessons = {
      schemaVersion: 2, id: 'smoke-lessons', title: 'With lessons',
      lessons: [
        { id: 'ls_1', node: 'draft', note: 'Avoid raw hex.', rating: 'down', pin: false, at: '2026-10-29T10:00:00Z' },
      ],
      graph: {
        nodes: [{ id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
          spec: { prompt: 'write x', output: 'markdown' } }],
        edges: [],
      },
    };
    check('validator accepts lessons[]',
      wfMod.validateDefinition(defWithLessons).length === 0,
      wfMod.validateDefinition(defWithLessons).join('; '));
    const defBadLesson = { ...defWithLessons, lessons: [{ rating: 'maybe' }] };
    const badLessonProblems = wfMod.validateDefinition(defBadLesson);
    check('validator flags lesson without note',
      badLessonProblems.some((p) => /note is required/.test(p)), badLessonProblems.join('; '));
    check('validator flags unknown lesson rating',
      badLessonProblems.some((p) => /rating must be up\|down/.test(p)), badLessonProblems.join('; '));

    // Lessons injection: a down-rated lesson on a node prepends to its prompt.
    const injDef = {
      schemaVersion: 2, id: 'smoke-lesson-inject', title: 'Lesson inject',
      lessons: [
        { id: 'ls_a', node: 'draft', note: 'Always start with H1.', rating: 'down', at: '2026-10-29T10:00:00Z' },
      ],
      graph: {
        nodes: [{ id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
          spec: { prompt: 'write something', output: 'markdown' } }],
        edges: [],
      },
    };
    const injSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: injDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const injStart = await fetch(`${base}/api/workflows/smoke-lesson-inject/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    const injRun = (await get(`/api/runs/${injStart.run?.runId}`)).run;
    const draftNode = injRun?.graph.nodes.find((n) => n.id === 'draft');
    check('lesson prepended to node prompt',
      /Prior lessons[\s\S]*Always start with H1/.test(draftNode?.spec?.prompt || ''),
      draftNode?.spec?.prompt?.slice(0, 80));
    check('lessonsApplied recorded on the node',
      Array.isArray(draftNode?.lessonsApplied) && draftNode.lessonsApplied.includes('ls_a'),
      JSON.stringify(draftNode?.lessonsApplied));
    try { fs.unlinkSync(injSaved.file); } catch {}

    // Lessons API: addLesson appends to project def; builtin is rejected.
    const anchorDef = {
      schemaVersion: 2, id: 'smoke-lesson-add', title: 'Lesson add',
      graph: {
        nodes: [{ id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
          spec: { prompt: 'write', output: 'markdown' } }],
        edges: [],
      },
    };
    const anchorSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: anchorDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const addResp = await fetch(`${base}/api/workflows/smoke-lesson-add/lessons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lesson: { node: 'draft', note: 'Return only Markdown.', rating: 'down', pin: true } }),
    }).then((r) => r.json());
    check('addLesson returns a lesson with an id',
      typeof addResp.lesson?.id === 'string' && addResp.lesson.id.length > 2, JSON.stringify(addResp));
    // Reload the def and confirm it has the lesson.
    const defAfter = (await get('/api/workflows/smoke-lesson-add')).workflow;
    check('appended lesson persisted on disk',
      Array.isArray(defAfter.lessons) && defAfter.lessons.length === 1 &&
      defAfter.lessons[0].note === 'Return only Markdown.',
      JSON.stringify(defAfter.lessons));
    const builtinReject = await fetch(`${base}/api/workflows/ship-pr/lessons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lesson: { note: 'nope' } }),
    });
    check('addLesson rejects builtin workflow',
      builtinReject.status === 400,
      String(builtinReject.status));
    try { fs.unlinkSync(anchorSaved.file); } catch {}

    // PATCH /api/runs/:id writes rating + retro.
    const retroDef = {
      schemaVersion: 2, id: 'smoke-retro', title: 'Retro', graph: {
        nodes: [{ id: 'cmd', title: 'Cmd', kind: 'script', col: 1, row: 0, spec: { cmd: 'echo ok' } }],
        edges: [],
      },
    };
    const retroSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: retroDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const retroStart = await fetch(`${base}/api/workflows/smoke-retro/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let retroDone = null;
    const retroBudget = Date.now() + 3000;
    while (Date.now() < retroBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${retroStart.run?.runId}`)).run;
      if (r?.status === 'done') { retroDone = r; break; }
    }
    check('retro run finishes', retroDone?.status === 'done', retroDone?.status);
    const patched = await fetch(`${base}/api/runs/${retroStart.run?.runId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 'up', retro: 'Worked first try.' }),
    }).then((r) => r.json());
    check('PATCH /api/runs/:id writes rating + retro',
      patched.run?.rating === 'up' && patched.run?.retro === 'Worked first try.',
      `${patched.run?.rating} / ${patched.run?.retro}`);
    try { fs.unlinkSync(retroSaved.file); } catch {}

    // Agent spec.verify: validator rejects malformed verify blocks.
    const badVerifyEmpty = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p', verify: { asserts: [] } } }],
        edges: [],
      },
    });
    check('validator flags empty verify.asserts',
      badVerifyEmpty.some((p) => /asserts/i.test(p)), badVerifyEmpty.join('; '));
    const badVerifyType = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p', verify: { asserts: [{ type: 'wut' }] } } }],
        edges: [],
      },
    });
    check('validator flags unknown verify assert type',
      badVerifyType.some((p) => /unknown verify assert type/i.test(p)), badVerifyType.join('; '));
    const badVerifyRetries = wfMod.validateDefinition({
      schemaVersion: 2, id: 'x', graph: {
        nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p', verify: { asserts: [{ type: 'no-raw-hex' }], maxRetries: -1 } } }],
        edges: [],
      },
    });
    check('validator flags negative maxRetries',
      badVerifyRetries.some((p) => /maxRetries/i.test(p)), badVerifyRetries.join('; '));

    // Agent spec.verify: happy path — mock agent output is clean, no-raw-hex passes.
    const verifyPassDef = {
      schemaVersion: 2, id: 'smoke-verify-pass', title: 'Verify pass',
      graph: {
        nodes: [
          { id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
            spec: { prompt: 'draft something', output: 'markdown',
              verify: { asserts: [{ type: 'no-raw-hex' }], maxRetries: 0 } } },
        ],
        edges: [],
      },
    };
    const vpSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: verifyPassDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const vpStart = await fetch(`${base}/api/workflows/smoke-verify-pass/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let vpDone = null;
    const vpBudget = Date.now() + 5000;
    while (Date.now() < vpBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${vpStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { vpDone = r; break; }
    }
    check('verify pass: run finishes done', vpDone?.status === 'done', vpDone?.status);
    const vpOut = vpDone?.graph.nodes.find((n) => n.id === 'draft')?.output;
    check('verify pass: output.verify.pass === true',
      vpOut?.verify?.pass === true, JSON.stringify(vpOut?.verify));
    try { fs.unlinkSync(vpSaved.file); } catch {}

    // Agent spec.verify: fail path with onFail:skip — retries exhaust and the
    // run finishes done with pass:false recorded.
    const verifyFailDef = {
      schemaVersion: 2, id: 'smoke-verify-fail', title: 'Verify fail',
      graph: {
        nodes: [
          { id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
            spec: { prompt: 'draft', output: 'markdown',
              verify: {
                asserts: [{ type: 'color-in-palette', colors: ['#FF00FF'], ignoreGrays: false, tolerance: 2 }],
                maxRetries: 2, onFail: 'skip',
              } } },
        ],
        edges: [],
      },
    };
    const vfSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: verifyFailDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const vfStart = await fetch(`${base}/api/workflows/smoke-verify-fail/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let vfDone = null;
    const vfBudget = Date.now() + 5000;
    while (Date.now() < vfBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${vfStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { vfDone = r; break; }
    }
    check('verify fail (skip): run finishes done', vfDone?.status === 'done', vfDone?.status);
    const vfOut = vfDone?.graph.nodes.find((n) => n.id === 'draft')?.output;
    check('verify fail: pass is false after retries',
      vfOut?.verify?.pass === false, JSON.stringify(vfOut?.verify?.pass));
    check('verify fail: attempts === maxRetries + 1',
      vfOut?.verify?.attempts?.length === 3,
      `attempts=${vfOut?.verify?.attempts?.length}`);
    try { fs.unlinkSync(vfSaved.file); } catch {}

    // Agent spec.verify: fail path with onFail:stop (default) — run fails.
    const verifyStopDef = {
      schemaVersion: 2, id: 'smoke-verify-stop', title: 'Verify stop',
      graph: {
        nodes: [
          { id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0,
            spec: { prompt: 'draft', output: 'markdown',
              verify: {
                asserts: [{ type: 'color-in-palette', colors: ['#FF00FF'], ignoreGrays: false, tolerance: 2 }],
                maxRetries: 0,
              } } },
        ],
        edges: [],
      },
    };
    const vsSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: verifyStopDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const vsStart = await fetch(`${base}/api/workflows/smoke-verify-stop/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let vsDone = null;
    const vsBudget = Date.now() + 5000;
    while (Date.now() < vsBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${vsStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { vsDone = r; break; }
    }
    check('verify fail (stop): run status is failed',
      vsDone?.status === 'failed', vsDone?.status);
    try { fs.unlinkSync(vsSaved.file); } catch {}

    // Agent spec.verify looks at real pages and judges with a rubric.
    const verifyApp = http.createServer((req, res) => {
      const ok = req.url === '/';
      res.writeHead(ok ? 200 : 404, { 'content-type': 'text/html' });
      res.end(ok ? '<html><body style="font-family:Inter;color:#15181B;background:#FFFFFF;padding:16px"><h1>Hi</h1><p style="color:#ff00ff">Off brand</p></body></html>' : '<h1>Not found</h1>');
    });
    await new Promise((r) => verifyApp.listen(0, '127.0.0.1', r));
    const verifyUrl = `http://127.0.0.1:${verifyApp.address().port}`;
    const runVerifyDef = async (id, verify) => {
      const def = { schemaVersion: 2, id, title: id, graph: { nodes: [
        { id: 'draft', title: 'Draft', kind: 'agent', col: 1, row: 0, spec: { prompt: 'draft', output: 'markdown', verify } },
      ], edges: [] } };
      const saved = await fetch(`${base}/api/workflows`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ def, scope: 'project', overwrite: true }),
      }).then((r) => r.json());
      const st = await fetch(`${base}/api/workflows/${id}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: { devUrl: verifyUrl } }),
      }).then((r) => r.json());
      let fin = null;
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        await sleep(150);
        const r = (await get(`/api/runs/${st.run?.runId}`)).run;
        if (r && ['done', 'failed', 'stopped'].includes(r.status)) { fin = r; break; }
      }
      try { fs.unlinkSync(saved.file); } catch {}
      return fin?.graph.nodes.find((n) => n.id === 'draft')?.output;
    };
    const v404 = await runVerifyDef('smoke-verify-404', { renders: ['/missing'], maxRetries: 0, onFail: 'skip' });
    check('verify fails a page that 404s',
      v404?.verify?.pass === false && v404.verify.results.some((r) => r.type === 'render' && /404/.test(r.reason)),
      JSON.stringify(v404?.verify?.results));
    const vBrand = await runVerifyDef('smoke-verify-brand', {
      renders: ['/'], asserts: [{ type: 'color-in-palette', ignoreGrays: false, tolerance: 2 }, { type: 'font-is-brand' }],
      maxRetries: 0, onFail: 'skip',
    });
    const vPal = vBrand?.verify?.results?.find((r) => r.type === 'color-in-palette');
    check('verify reads colours from the rendered page',
      vPal?.pass === false && vPal.offenders?.some((o) => o.color === '#FF00FF'), JSON.stringify(vPal));
    check('verify reads the font from the rendered page',
      vBrand?.verify?.results?.find((r) => r.type === 'font-is-brand')?.pass === true,
      JSON.stringify(vBrand?.verify?.results?.find((r) => r.type === 'font-is-brand')));
    const vJudgeFail = await runVerifyDef('smoke-verify-judge', {
      asserts: [{ type: 'llm-judge', rubric: 'MOCK_FAIL must read well' }], maxRetries: 1, onFail: 'skip',
    });
    check('llm-judge can fail the work',
      vJudgeFail?.verify?.pass === false && vJudgeFail.verify.attempts.length === 2
      && vJudgeFail.verify.results.some((r) => r.type === 'llm-judge' && /mock judge failed/.test(r.reason)),
      JSON.stringify(vJudgeFail?.verify));
    const vJudgePass = await runVerifyDef('smoke-verify-judge-ok', {
      asserts: [{ type: 'llm-judge', rubric: 'reads well' }], maxRetries: 0,
    });
    check('llm-judge can pass the work', vJudgePass?.verify?.pass === true, JSON.stringify(vJudgePass?.verify));
    verifyApp.close();
    const judgeNoRubric = wfMod.validateDefinition({ schemaVersion: 2, id: 'x', graph: {
      nodes: [{ id: 'a', kind: 'agent', spec: { prompt: 'p', verify: { asserts: [{ type: 'llm-judge' }] } } }], edges: [] } });
    check('validator wants a rubric for llm-judge', judgeNoRubric.some((p) => /rubric/.test(p)), judgeNoRubric.join('; '));

    // Control-flow kinds: Loop (map over an inputs array), Delay (short),
    // Approve (user clicks approve → run finishes done).
    const loopDef = {
      schemaVersion: 2, id: 'smoke-loop', title: 'Loop smoke',
      graph: {
        nodes: [
          { id: 'map', title: 'Map', kind: 'loop', col: 1, row: 0,
            spec: { over: 'inputs.items', action: 'script', cmd: 'echo item={{item}}' } },
        ],
        edges: [],
      },
    };
    const loopSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: loopDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    check('loop def saved', loopSaved.saved === true, loopSaved.error);
    const loopStart = await fetch(`${base}/api/workflows/smoke-loop/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: { items: 'a,b,c' } }),
    }).then((r) => r.json());
    let looped = null;
    const loopBudget = Date.now() + 8000;
    while (Date.now() < loopBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${loopStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { looped = r; break; }
    }
    check('loop run finishes done', looped?.status === 'done', looped?.status);
    const mapOut = looped?.graph.nodes.find((n) => n.id === 'map')?.output;
    check('loop ran once per item', mapOut?.count === 3 && mapOut?.results?.length === 3,
      `count=${mapOut?.count} len=${mapOut?.results?.length}`);
    check('loop results carry per-item output',
      /item=a/.test(mapOut?.results?.[0]?.out || ''),
      mapOut?.results?.[0]?.out);
    try { fs.unlinkSync(loopSaved.file); } catch {}

    // Delay: 100ms wait finishes done without blocking the test too long.
    const delayDef = {
      schemaVersion: 2, id: 'smoke-delay', title: 'Delay smoke',
      graph: {
        nodes: [{ id: 'wait', title: 'Wait', kind: 'delay', col: 1, row: 0,
                 spec: { wait: '100ms' } }],
        edges: [],
      },
    };
    const delaySaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: delayDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const delayStart = await fetch(`${base}/api/workflows/smoke-delay/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    let delayed = null;
    const delayBudget = Date.now() + 3000;
    while (Date.now() < delayBudget) {
      await sleep(50);
      const r = (await get(`/api/runs/${delayStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { delayed = r; break; }
    }
    check('delay run finishes done', delayed?.status === 'done', delayed?.status);
    const waitOut = delayed?.graph.nodes.find((n) => n.id === 'wait')?.output;
    check('delay recorded its wait', waitOut?.ms >= 90 && typeof waitOut?.waited === 'string',
      `ms=${waitOut?.ms} waited=${waitOut?.waited}`);
    try { fs.unlinkSync(delaySaved.file); } catch {}

    // Approve: open-ended wait → user clicks approve → done.
    const approveDef = {
      schemaVersion: 2, id: 'smoke-approve', title: 'Approve smoke',
      graph: {
        nodes: [{ id: 'ok', title: 'OK?', kind: 'approve', col: 1, row: 0,
                 spec: { question: 'Approve smoke?' } }],
        edges: [],
      },
    };
    const approveSaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: approveDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const approveStart = await fetch(`${base}/api/workflows/smoke-approve/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    // Wait for the approve to open.
    let approveReady = null;
    const approveBudget = Date.now() + 3000;
    while (Date.now() < approveBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${approveStart.run?.runId}`)).run;
      if (r?.status === 'awaiting-answer') { approveReady = r; break; }
    }
    check('approve opens awaiting-answer', !!approveReady, approveReady?.status);
    await fetch(`${base}/api/runs/${approveStart.run?.runId}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'ok', answer: 'approve' }),
    });
    let approved = null;
    const settledBudget = Date.now() + 3000;
    while (Date.now() < settledBudget) {
      await sleep(100);
      const r = (await get(`/api/runs/${approveStart.run?.runId}`)).run;
      if (r && ['done', 'failed', 'stopped'].includes(r.status)) { approved = r; break; }
    }
    check('approve finishes done when the user approves',
      approved?.status === 'done' && approved?.graph.nodes[0]?.output?.approved === true,
      `${approved?.status} / approved=${approved?.graph.nodes[0]?.output?.approved}`);
    check('an approval keeps the question it asked',
      typeof approved?.graph.nodes[0]?.output?.question === 'string' && approved.graph.nodes[0].output.question.length > 0,
      JSON.stringify(approved?.graph.nodes[0]?.output));
    try { fs.unlinkSync(approveSaved.file); } catch {}

    // A prompt that names its inputs gets only those, not every input pasted
    // below it; one that names none still gets them all.
    const runPromptCheck = async (id, prompt) => {
      const def = { schemaVersion: 2, id, title: id, graph: { nodes: [
        { id: 'a', title: 'A', kind: 'agent', col: 1, row: 0, spec: { prompt, output: 'html' } }], edges: [] } };
      const saved = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ def, scope: 'project', overwrite: true }) }).then((r) => r.json());
      const st = await fetch(`${base}/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: { look: 'teal', roster: 'SECRET-ROSTER' } }) }).then((r) => r.json());
      let fin = null;
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        await sleep(100);
        const r = (await get(`/api/runs/${st.run?.runId}`)).run;
        if (r && ['done', 'failed'].includes(r.status)) { fin = r; break; }
      }
      try { fs.unlinkSync(saved.file); } catch {}
      return fin?.graph.nodes[0]?.sent || '';
    };
    const named = await runPromptCheck('smoke-prompt-named', 'Design a card. The look: {{inputs.look}}');
    check('a prompt naming its inputs is not handed the others',
      /teal/.test(named) && !/SECRET-ROSTER/.test(named), named.slice(0, 200));
    check('a web page step may use JavaScript and has no line cap',
      /JavaScript/.test(named) && !/200 lines/.test(named), named.slice(-200));
    const unnamed = await runPromptCheck('smoke-prompt-unnamed', 'Design a card.');
    check('a prompt naming no inputs still gets them all', /SECRET-ROSTER/.test(unnamed), unnamed.slice(0, 200));

    // A command that crashes says why, and keeps what it printed.
    const crashDef = { schemaVersion: 2, id: 'smoke-crash', title: 'Crash', graph: { nodes: [
      { id: 'c', title: 'C', kind: 'script', col: 1, row: 0,
        spec: { cmd: "node -e \"console.log('step one done'); throw new TypeError('the roster is empty')\"" } }], edges: [] } };
    const crashSaved = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: crashDef, scope: 'project', overwrite: true }) }).then((r) => r.json());
    const crashSt = await fetch(`${base}/api/workflows/smoke-crash/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    let crashed = null;
    const crashUntil = Date.now() + 5000;
    while (Date.now() < crashUntil) {
      await sleep(100);
      const r = (await get(`/api/runs/${crashSt.run?.runId}`)).run;
      if (r && ['done', 'failed'].includes(r.status)) { crashed = r; break; }
    }
    const crashOut = crashed?.graph.nodes[0]?.output || {};
    check('a crashed command names the error, not the stack dump',
      /TypeError: the roster is empty/.test(crashOut.error || ''), crashOut.error);
    check('a failed command keeps what it printed', /step one done/.test(crashOut.out || ''), String(crashOut.out).slice(0, 120));
    try { fs.unlinkSync(crashSaved.file); } catch {}

    // Legacy compat: a workflow without schemaVersion still runs; the resulting
    // run records schemaVersion: 1 so the canvas can badge it.
    const legacyDef = {
      id: 'smoke-legacy', title: 'Legacy smoke',
      graph: {
        nodes: [{ id: 'go', title: 'Go', kind: 'terminal', col: 1, row: 0, command: 'echo legacy' }],
        edges: [],
      },
    };
    const legacySaved = await fetch(`${base}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ def: legacyDef, scope: 'project', overwrite: true }),
    }).then((r) => r.json());
    const legacyStart = await fetch(`${base}/api/workflows/smoke-legacy/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    check('legacy run records schemaVersion: 1',
      legacyStart.run?.schemaVersion === 1,
      `schemaVersion=${legacyStart.run?.schemaVersion}`);
    try { fs.unlinkSync(legacySaved.file); } catch {}

    // Rerun & delete.
    const rerunResp = await fetch(`${base}/api/runs/${started.run?.runId}/rerun`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    check('POST /api/runs/:id/rerun returns a new run', !!rerunResp.run?.runId
      && rerunResp.run?.runId !== started.run?.runId, rerunResp.error);
    check('the rerun carries the same inputs', JSON.stringify(rerunResp.run.inputs) ===
      JSON.stringify(started.run.inputs));

    // Rerun from a specific node: clone and keep upstream outputs. Wait for
    // the fresh rerun to settle so we can target one of its done nodes.
    let settled = null;
    const budget2 = Date.now() + 8000;
    while (Date.now() < budget2) {
      await sleep(200);
      const r2 = (await get(`/api/runs/${rerunResp.run?.runId}`)).run;
      if (r2 && ['done', 'failed', 'stopped'].includes(r2.status)) { settled = r2; break; }
    }
    if (settled) {
      const target = settled.graph.nodes[settled.graph.nodes.length - 1];
      const partial = await fetch(`${base}/api/runs/${settled.runId}/rerun`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromNodeId: target.id }),
      }).then((r) => r.json());
      check('rerun from node keeps upstream outputs',
        partial.run?.graph?.nodes?.some((n) => n.id !== target.id && n.status === 'done'),
        partial.error);
    }

    const delResp = await fetch(`${base}/api/runs/${rerunResp.run?.runId}`, { method: 'DELETE' }).then((r) => r.json());
    check('DELETE /api/runs/:id removes the folder', delResp.deleted === true, JSON.stringify(delResp));
    const delMissing = await fetch(`${base}/api/runs/${rerunResp.run?.runId}`).then((r) => r.status);
    check('deleted run returns 404', delMissing === 404, String(delMissing));

    // Skills — read from the two .claude/skills roots.
    const skillsResp = await get('/api/skills');
    check('GET /api/skills returns an array',
      Array.isArray(skillsResp.skills), `${typeof skillsResp.skills}`);
    if (skillsResp.skills.length) {
      const s = skillsResp.skills[0];
      check('a skill carries slug, scope, name, category, path',
        !!s.slug && !!s.scope && !!s.name && !!s.category && !!s.path,
        JSON.stringify({ slug: s.slug, scope: s.scope, cat: s.category }));
      check('skill scope is project or user',
        skillsResp.skills.every((x) => x.scope === 'project' || x.scope === 'user'),
        [...new Set(skillsResp.skills.map((x) => x.scope))].join(','));
      // Hand-exercise the YAML reader: the global library almost always has
      // at least one skill with a `description: >` folded block; a working
      // reader produces a non-trivial description, a broken one yields ">".
      const broken = skillsResp.skills.filter((x) => (x.description || '').length <= 2);
      check('skills with folded descriptions parsed cleanly',
        broken.length === 0,
        broken.length ? broken[0].slug : 'ok');
    }

    // Blob store round-trip through the module directly.
    const blobs = await import('../src/core/blobs.mjs');
    const ref = blobs.putBuffer(Buffer.from('hello orderly'), { ext: 'txt' });
    check('blob round-trip returns a ref', typeof ref === 'string' && ref.startsWith('blob:sha256:'));
    const sha = ref.slice('blob:sha256:'.length).split(':')[0];
    const got = await fetch(`${base}/api/blob?sha=${sha}`).then((r) => r.text());
    check('GET /api/blob?sha=... serves the content', got === 'hello orderly', got.slice(0, 32));

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

    // Attachments: written beside the session, path handed to Claude.
    const body = Buffer.from('codeword SMOKE-TEST\n');
    const up = await fetch(`${base}/api/upload?name=notes.txt&session=${state.instance.sessionId}`, {
      method: 'POST', body,
    }).then((r) => r.json());
    check('a file can be attached', !!up.path && up.size === body.length, JSON.stringify(up));
    check('the file is written where it says', up.path && fs.existsSync(up.path));
    check('its contents survive', fs.readFileSync(up.path, 'utf8').includes('SMOKE-TEST'));

    const again = await fetch(`${base}/api/upload?name=notes.txt&session=${state.instance.sessionId}`, {
      method: 'POST', body,
    }).then((r) => r.json());
    check('a second file of the same name does not overwrite', again.path !== up.path, again.path);

    const nasty = await fetch(
      `${base}/api/upload?name=${encodeURIComponent('../../escape.txt')}&session=${state.instance.sessionId}`,
      { method: 'POST', body },
    ).then((r) => r.json());
    check('a path in the filename cannot escape the folder',
      nasty.path && path.dirname(nasty.path) === path.dirname(up.path) && !nasty.path.includes('..'),
      nasty.path);
    for (const f of [up.path, again.path, nasty.path]) { try { fs.rmSync(f); } catch {} }

    // Each session runs on its own, rather than queueing behind the others.
    const tabState = await get('/api/tabs');
    check('each tab reports whether it is busy',
      tabState.tabs.every((x) => typeof x.busy === 'boolean'), JSON.stringify(tabState.tabs));
    const refusedEmpty = await fetch(`${base}/api/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  ', sessionId: state.instance.sessionId }),
    });
    check('an empty prompt is still refused per session', refusedEmpty.status === 409);

    /*
     * A run that started a dev server never ends, so "busy" is not a reason to
     * refuse the next message — the composer used to disable itself forever.
     */
    const anotherTab = sessionList.sessions.find((x) => x.sessionId !== state.instance.sessionId);
    if (anotherTab) {
      const stillSwitches = await fetch(`${base}/api/watch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: anotherTab.sessionId }),
      });
      check('a session can be watched whatever it is doing', stillSwitches.status === 200);
      await fetch(`${base}/api/watch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.instance.sessionId }),
      });
    }
    check('a run reports how long it has been going',
      typeof (await get('/api/activity')).run?.runningMs === 'number');

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

        const asked = state.session.turns.flatMap((t) => t.steps).find((s) => s.needsUser);
        if (asked) {
          const { ask, problems } = await inspectPage(
            `${base}/?theme=light&needsyou=1#${sid}/${asked.id}/detail`);
          check('decision: the panel opens', !!ask && !ask.error, ask?.error || '');
          if (ask && !ask.error) {
            check('decision: it says what state the decision is in', (ask.status || '').length > 3, ask.status);
            check('decision: the question is shown', ask.questions?.length > 0, JSON.stringify(ask.questions));
            check('decision: the choices are shown', ask.options > 0, String(ask.options));
            check('decision: each choice explains itself', ask.described === ask.options,
              `${ask.described}/${ask.options}`);
            check('decision: no raw commands in it', ask.codeBlocks === 0, String(ask.codeBlocks));
          }
          check('decision: no console errors', problems.length === 0, problems[0] || '');
        }

        const withFiles = state.session.turns.flatMap((t) => t.steps).find((s) => s.fileCount > 0);
        if (withFiles) {
          const { diff, problems } = await inspectPage(`${base}/?theme=light#${sid}/${withFiles.id}/changes`);
          check('diff: renders', !!diff && !diff.error, diff?.error || '');
          check('diff: no console errors', problems.length === 0, problems[0] || '');
          if (diff && !diff.error) {
            check('diff: names the file and its size', diff.head === true && /[+\u2212]\d/.test(diff.stats), diff.stats);
            check('diff: shows the shape of the change', diff.bar === true);
            check('diff: long lines wrap rather than run off', diff.wraps === 'pre-wrap', diff.wraps);
            check('diff: nothing is cut off horizontally', diff.overflowX === 0, `${diff.overflowX}px hidden`);
            if (diff.hasToggle) {
              check('diff: a large change starts folded', diff.folded === true);
              check('diff: it can be opened', diff.foldedAfterClick === false);
              check('diff: the toggle says what it does', /show less/i.test(diff.toggleLabel || ''), diff.toggleLabel);
            }
          }
        }

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

        // The bug this guards: a run that never ends disabled the composer
        // for good, leaving no way to say anything.
        check('composer: sending is never disabled',
          vocab.idle?.disabled === false && vocab.working?.disabled === false
          && vocab.longRun?.disabled === false,
          JSON.stringify([vocab.idle?.disabled, vocab.working?.disabled, vocab.longRun?.disabled]));
        check('composer: a busy send says it will replace the run',
          /stop & send/i.test(vocab.working?.label || ''), vocab.working?.label);
        check('composer: an idle send just sends', vocab.idle?.label === 'Send', vocab.idle?.label);
        check('composer: a long run says how long it has gone',
          /\d+m/.test(vocab.longRun?.note || ''), vocab.longRun?.note);
        check('composer: a long run warns it will be replaced',
          /replace/i.test(vocab.longRun?.note || ''), vocab.longRun?.note);
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
    // Leave nothing behind on the Runs page of the machine the suite ran on:
    // every smoke-* workflow's runs, and the built-in runs this session
    // started while the suite was running.
    try {
      const { runs = [] } = await fetch(`${base}/api/runs?limit=5000&since=${encodeURIComponent(suiteStartedAt)}`).then((r) => r.json());
      for (const r of runs) {
        const ours = r.workflowId.startsWith('smoke-')
          || (r.sessionId === target.meta.sessionId && (r.workflowId === 'visual-regression'));
        if (ours) await fetch(`${base}/api/runs/${r.runId}`, { method: 'DELETE' });
      }
    } catch { /* the server may already be gone */ }
    close();
  }

  // Workflows: references, limits, durability, schedules and the three pages,
  // each against throwaway servers in a temp project.
  const { runWorkflowEngineChecks } = await import('./workflow-engine.mjs');
  try { await runWorkflowEngineChecks({ check, session: target.meta }); }
  catch (e) { check('workflow checks ran to the end', false, e.stack || e.message); }
  // The scratch world is removed when the process exits (scratch-world.mjs).

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
