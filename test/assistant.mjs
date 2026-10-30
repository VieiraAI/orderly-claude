/**
 * Workflow assistant checks. Runs against a stand-in for the `claude` CLI
 * (test/fixtures/fake-claude.mjs), so nothing is spent, and keeps every
 * conversation and transcript in a temp directory.
 *
 *   node test/assistant.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = (start) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(freePort(start + 1)));
  srv.once('listening', () => srv.close(() => resolve(start)));
  srv.listen(start, '127.0.0.1');
});

export async function runAssistantChecks({ check, session }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-assist-'));
  const keep = {};
  for (const k of ['ORDERLY_ASSISTANT_DIR', 'ORDERLY_ASSISTANT_PROJECTS_DIR', 'ORDERLY_CLAUDE_BIN', 'ORDERLY_SCHEDULES_DIR', 'ORDERLY_SETTINGS_FILE']) keep[k] = process.env[k];
  process.env.ORDERLY_ASSISTANT_DIR = path.join(tmp, 'assistant');
  process.env.ORDERLY_ASSISTANT_PROJECTS_DIR = path.join(tmp, 'projects');
  process.env.ORDERLY_CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  process.env.ORDERLY_SCHEDULES_DIR = path.join(tmp, 'data');
  process.env.ORDERLY_SETTINGS_FILE = path.join(tmp, 'data', 'settings.json');
  const repo = path.join(tmp, 'project');
  fs.mkdirSync(repo, { recursive: true });

  const { startServer } = await import('../src/server/server.mjs');
  const port = await freePort(7990);
  const server = await startServer({ port, file: session.file, sessionId: session.sessionId, cwd: repo, title: 'assistant checks', capture: false });
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', connection: 'close' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const view = (key) => api(`/api/assistant?key=${encodeURIComponent(key)}`);
  const idle = async (key, ms = 8000) => {
    const end = Date.now() + ms; let v;
    while (Date.now() < end) { v = await view(key); if (!v.state?.busy) return v; await sleep(100); }
    return v;
  };
  const def = { schemaVersion: 2, id: 'ship', title: 'Ship', inputs: [], graph: {
    nodes: [{ id: 'tests', title: 'Tests', kind: 'script', spec: { cmd: 'npm test' } }], edges: [] } };

  try {
    console.log('\nWorkflow assistant\n');

    let r = await api('/api/assistant/message', { key: 'wf:ship', text: 'add a step that tells the team', def, repoRoot: repo });
    check('a message starts Claude working on the workflow', r.status === 200 && r.state?.busy === true, JSON.stringify(r).slice(0, 200));
    let v = await idle('wf:ship');
    const p = v.state.proposal;
    check('a change comes back as a proposal, not an edit', p?.status === 'pending' && p.valid === true, JSON.stringify(p).slice(0, 300));
    check('the proposal says what changed, in words', p?.lines?.some((l) => l.text === 'Added “Tell the team”') && p.lines.some((l) => /Connections: 1 added/.test(l.text)), JSON.stringify(p?.lines));
    check('the proposal carries the whole proposed workflow to preview', p?.draft?.graph?.nodes?.length === 2);
    check('Orderly validated the proposal itself', Array.isArray(p?.problems) && p.problems.length === 0);
    const turns = v.conversation.turns;
    check('the conversation reads through the Sessions summariser', turns.length === 1 && turns[0].prompt === 'add a step that tells the team' && turns[0].steps.length >= 2,
      JSON.stringify(turns.map((t) => [t.prompt, t.steps.map((s) => s.label)])));
    const labels = turns[0].steps.map((s) => s.label);
    check('its steps are named for people, not files', labels.includes('Read the workflow') && labels.includes('Updated the proposal') && labels.includes('Checked the proposal')
      && !labels.some((l) => /\.json|\.mjs/.test(l)), labels.join(' | '));
    check('its reply closes the turn, as in Sessions', /Tell the team/.test(turns[0].summary || turns[0].intro), turns[0].summary);
    check('what it cost is kept', v.state.costUsd === 0.0123 && v.state.turns === 1, `${v.state.costUsd} ${v.state.turns}`);

    const args = JSON.parse(fs.readFileSync(path.join(process.env.ORDERLY_ASSISTANT_DIR, fs.readdirSync(process.env.ORDERLY_ASSISTANT_DIR).find((d) => d !== 'aliases.json'), 'last-args.json'), 'utf8'));
    const after = (flag) => { const i = args.indexOf(flag); return args.slice(i + 1, args.findIndex((a, j) => j > i && a.startsWith('--'))); };
    check('Claude may only edit the proposal and run the checker', JSON.stringify(after('--allowedTools')) === JSON.stringify(['Edit(draft.json)', 'Edit(./draft.json)', 'Write(draft.json)', 'Write(./draft.json)', 'Bash(node check.mjs)']),
      JSON.stringify(after('--allowedTools')));
    check('anything else is refused without asking', args[args.indexOf('--permission-prompts') + 1] === 'none' && args[args.indexOf('--permission-mode') + 1] === 'default');
    check('it may read the project it belongs to', args[args.indexOf('--add-dir') + 1] === repo);

    r = await api('/api/assistant/message', { key: 'wf:ship', text: 'add another', def, repoRoot: '/' });
    check('it is never given a folder Orderly does not know', r.status === 400 && /not a project Orderly knows/.test(r.error), r.error);

    r = await api('/api/assistant/message', { key: 'wf:ship', text: 'explain what this does', def, repoRoot: repo });
    v = await idle('wf:ship');
    check('a follow-up continues the same conversation', v.conversation.turns.length === 2 && v.state.turns === 2);
    check('a question gets an answer and leaves the proposal as it was', v.state.proposal?.status === 'pending' && v.state.proposal.lines.length === p.lines.length);

    r = await api('/api/assistant/resolve', { key: 'wf:ship', action: 'applied' });
    v = await view('wf:ship');
    check('applying closes the proposal', r.resolved === true && v.state.proposal.status === 'applied');

    // The editor changed since: an old proposal must not undo the person's edits.
    await api('/api/assistant/message', { key: 'wf:edit', text: 'add a step', def, repoRoot: repo });
    await idle('wf:edit');
    const edited = structuredClone(def); edited.graph.nodes[0].title = 'Run the tests';
    await api('/api/assistant/message', { key: 'wf:edit', text: 'explain it', def: edited, repoRoot: repo });
    v = await idle('wf:edit');
    check('an edit made since the proposal is never quietly undone', !v.state.proposal || !v.state.proposal.lines.some((l) => /Changed “Run the tests”/.test(l.text)),
      JSON.stringify(v.state.proposal?.lines));

    await api('/api/assistant/message', { key: 'wf:broken', text: 'break it', def, repoRoot: repo });
    v = await idle('wf:broken');
    check('a proposal that would not run is marked, with why', v.state.proposal?.valid === false && v.state.proposal.problems.some((x) => /prompt is required/.test(x)), JSON.stringify(v.state.proposal?.problems));

    await api('/api/assistant/message', { key: 'wf:signin', text: 'signin please', def, repoRoot: repo });
    v = await idle('wf:signin');
    check('a signed-out Claude says what to do about it', /not signed in/.test(v.state.lastError || ''), v.state.lastError);
    check('…and leaves no half-started conversation behind', v.state.hasConversation === false);

    await api('/api/assistant/message', { key: 'wf:slow', text: 'slow one', def, repoRoot: repo });
    r = await api('/api/assistant/message', { key: 'wf:slow', text: 'and another', def, repoRoot: repo });
    check('one message at a time per workflow', r.status === 409 && /still working/.test(r.error), r.error);
    v = await view('wf:slow');
    check('while it works, the panel can say so', v.state.busy === true && typeof v.state.elapsedMs === 'number');
    r = await api('/api/assistant/stop', { key: 'wf:slow' });
    v = await idle('wf:slow');
    check('it can be stopped', r.stopped === true && v.state.busy === false && /Stopped/.test(v.state.lastError || ''), v.state.lastError);

    for (const k of ['a', 'b', 'c']) await api('/api/assistant/message', { key: `wf:cap-${k}`, text: 'slow', def, repoRoot: repo });
    r = await api('/api/assistant/message', { key: 'wf:cap-d', text: 'slow', def, repoRoot: repo });
    check('a machine runs at most three conversations at once, and says so', r.status === 429 && /3 other workflows/.test(r.error), r.error);
    for (const k of ['a', 'b', 'c']) await api('/api/assistant/stop', { key: `wf:cap-${k}` });
    for (const k of ['a', 'b', 'c']) await idle(`wf:cap-${k}`);

    await api('/api/assistant/message', { key: 'new:123', text: 'add a step', def, repoRoot: repo });
    await idle('new:123');
    r = await api('/api/assistant/rekey', { from: 'new:123', to: 'wf:named' });
    v = await view('wf:named');
    check('a workflow saved for the first time keeps its conversation', r.moved === true && v.conversation.turns.length === 1 && v.state.proposal?.status === 'pending');

    r = await api('/api/assistant/reset', { key: 'wf:named' });
    v = await view('wf:named');
    check('a new conversation starts clean, its cost included', r.reset === true && v.conversation.turns.length === 0 && !v.state.proposal && v.state.costUsd === 0);

    r = await api('/api/assistant/message', { key: 'wf:x', text: '   ', def, repoRoot: repo });
    check('an empty message is refused with what to do', r.status === 400 && /Say what you would like/.test(r.error));

    // Its sessions are Claude Code sessions, but they are not the person's.
    const { listSessions } = await import('../src/core/sessions.mjs');
    const real = listSessions({ limit: 50 }).find((s) => s.cwd);
    const was = process.env.ORDERLY_ASSISTANT_DIR;
    process.env.ORDERLY_ASSISTANT_DIR = real.cwd;
    const hidden = !listSessions({ limit: 400 }).some((s) => s.sessionId === real.sessionId);
    process.env.ORDERLY_ASSISTANT_DIR = was;
    check("the assistant's conversations stay out of the Sessions list", hidden && listSessions({ limit: 400 }).some((s) => s.sessionId === real.sessionId));
    await panelChecks({ check, base, repo });
  } finally {
    server.close();
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* -------------------------------- the panel ------------------------------- */

async function panelChecks({ check, base, repo }) {
  const { findChrome } = await import('../src/core/capture.mjs');
  const { CDP, httpJSON } = await import('../src/core/cdp.mjs');
  const { spawn } = await import('node:child_process');
  const chrome = findChrome();
  if (!chrome) { console.log('  (no Chrome — skipping the assistant panel)'); return; }
  console.log('\nWorkflow assistant: the panel\n');

  // A workflow of its own, saved in the throwaway project.
  const def = { schemaVersion: 2, id: 'panel-check', title: 'Panel check', inputs: [], graph: {
    nodes: [{ id: 'tests', title: 'Tests', kind: 'script', col: 1, row: 0, spec: { cmd: 'npm test' } },
            { id: 'pr', title: 'Pull request', kind: 'publish', col: 2, row: 0, spec: { target: 'pr' } }],
    edges: [['tests', 'pr']] } };
  await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ def, scope: 'project', overwrite: true }) });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-assist-ui-'));
  const port = await freePort(9670);
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-component-update',
    '--disable-background-networking', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let ws = null;
    for (let i = 0; i < 80 && !ws; i++) { try { ws = (await httpJSON(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; } catch { await sleep(120); } }
    const cdp = await CDP.attach(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const errors = [];
    cdp.listeners.add((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
      if (m.method === 'Page.javascriptDialogOpening') errors.push(`dialog: ${m.params.message}`);
    });
    const ev = async (body) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await cdp.send('Page.navigate', { url: `${base}/workflow-editor.html?from=panel-check` }, sessionId);
    try { await cdp.once('Page.loadEventFired', sessionId, 9000); } catch { /* streams */ }
    await sleep(900);

    let r = await ev(`document.getElementById('btnClaude').click(); await new Promise((r) => setTimeout(r, 700));
      const a = document.querySelector('.oc-assist');
      return { open: a.classList.contains('open'), docked: document.body.classList.contains('assist-open'), title: a.querySelector('.oa-empty h3')?.textContent,
        ideas: a.querySelectorAll('.oa-suggest button').length, focus: document.activeElement?.id };`);
    check('Ask Claude opens a docked panel and the editor makes room', r.open && r.docked && r.focus === 'oaInput', JSON.stringify(r));
    check('it greets this workflow by name, with ideas for it', /Panel check/.test(r.title || '') && r.ideas >= 3, JSON.stringify(r));

    r = await ev(`const t = document.getElementById('oaInput'); t.value = 'slow add a step that tells the team';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return { msgs: document.querySelectorAll('.oc-assist .msg').length, live: !!document.querySelector('.oc-assist .icon.t-running'), stop: document.getElementById('oaSend').classList.contains('stop') };`);
    check('Enter sends: your message shows at once, Claude visibly working, Send becomes Stop', r.msgs >= 2 && r.live && r.stop, JSON.stringify(r));

    for (let i = 0; i < 80; i++) { await sleep(200); if (await ev(`return !!document.querySelector('.oa-proposal:not([hidden]) .oa-p-lines')`)) break; }
    r = await ev(`const a = document.querySelector('.oc-assist');
      return { steps: [...a.querySelectorAll('.steps .text')].map((x) => x.textContent), lines: [...a.querySelectorAll('.oa-p-lines li')].map((x) => x.textContent),
        ready: a.querySelector('.oa-p-ok')?.textContent, cards: document.querySelectorAll('.n-card').length };`);
    check('the reply reads like Sessions, step by step', r.steps.includes('Read the workflow') && r.steps.includes('Checked the proposal'), r.steps.join(' | '));
    check('the change is a proposal, said in words; the canvas is untouched', r.lines.some((l) => /Added “Tell the team”/.test(l)) && r.ready === 'Ready to run' && r.cards === 2, JSON.stringify(r));

    r = await ev(`[...document.querySelectorAll('.oa-p-actions .oa-btn')].find((b) => /Preview/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 500));
      return { added: [...document.querySelectorAll('.n-card.pv-added')].map((c) => c.dataset.id), banner: !document.getElementById('pvBanner').hidden };`);
    check('Preview marks the new step on the canvas', r.added.includes('notify') && r.banner, JSON.stringify(r));
    r = await ev(`[...document.querySelectorAll('.oa-p-actions .oa-btn')].find((b) => b.textContent === 'Apply').click();
      await new Promise((r) => setTimeout(r, 700));
      return { has: !!document.querySelector('.n-card[data-id="notify"]'), unsaved: /unsaved/.test(document.getElementById('saveLine').textContent),
        previewing: document.body.classList.contains('previewing') };`);
    check('Apply puts it on the canvas, unsaved, and ends the preview', r.has && r.unsaved && !r.previewing, JSON.stringify(r));
    r = await ev(`[...document.querySelectorAll('.oa-note-line .oa-btn')].find((b) => b.textContent === 'Undo').click();
      await new Promise((r) => setTimeout(r, 400));
      return { has: !!document.querySelector('.n-card[data-id="notify"]'), saved: document.getElementById('saveLine').textContent };`);
    check('Undo takes it back to exactly what was saved', !r.has && /^saved/.test(r.saved), JSON.stringify(r));
    r = await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return { open: document.querySelector('.oc-assist').classList.contains('open'), docked: document.body.classList.contains('assist-open') };`);
    check('Esc closes the panel and gives the editor its room back', !r.open && !r.docked, JSON.stringify(r));
    check('the panel raised no errors or browser dialogs', errors.length === 0, errors.join(' | '));
    cdp.close?.();
  } finally {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { listSessions } = await import('../src/core/sessions.mjs');
  const session = listSessions({ limit: 50 }).find((s) => s.file && fs.existsSync(s.file));
  let pass = 0; const fail = [];
  const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  await runAssistantChecks({ check, session });
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
