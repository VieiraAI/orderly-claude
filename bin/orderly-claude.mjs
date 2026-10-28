#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { startServer } from '../src/server/server.mjs';
import { listSessions, sessionForCwd } from '../src/core/sessions.mjs';
import { findChrome } from '../src/core/capture.mjs';
import { INSTANCES_FILE, ensureDirs, PROJECTS_DIR, CLAUDE_DIR } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (has('version') || argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

/** What this machine can and cannot do, before anything is blamed on the tool. */
function doctor() {
  const ok = (good) => (good ? '  yes' : '  no ');
  const found = (bin) => {
    try { execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  const chrome = findChrome();
  let sessions = 0;
  try { sessions = listSessions().length; } catch {}

  console.log(`\n  orderly-claude ${pkg.version}  ·  node ${process.version}  ·  ${process.platform}\n`);
  console.log(`${ok(fs.existsSync(CLAUDE_DIR))}  Claude Code directory   ${CLAUDE_DIR.replace(os.homedir(), '~')}`);
  console.log(`${ok(fs.existsSync(PROJECTS_DIR))}  transcripts             ${sessions} session${sessions === 1 ? '' : 's'} found`);
  console.log(`${ok(found('claude'))}  claude on PATH          needed to send prompts from the page`);
  console.log(`${ok(!!chrome)}  Chrome                  ${chrome || 'not found — before/after screenshots will be skipped'}`);
  console.log(`${ok(found('lsof'))}  lsof                    used to find this project's dev server`);
  console.log('');
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log('  Claude Code has not written any transcripts here yet.');
    console.log('  Run `claude` once in a project, then come back.\n');
  }
}

if (has('doctor')) { doctor(); process.exit(0); }

if (argv[0] === 'new-prompt') {
  const slug = argv[1];
  if (!slug) {
    console.error('Usage: orderly-claude new-prompt <slug> [--title "..."] [--category build|design|review|ship|plan] [--scope project|user]');
    process.exit(2);
  }
  const { scaffoldPrompt, writePrompt } = await import('../src/core/prompts.mjs');
  const title = flag('title', null);
  const category = flag('category', 'build');
  const scope = flag('scope', 'project');
  const md = scaffoldPrompt(slug, { title, category });
  try {
    const file = writePrompt({ md, slug, scope, repoRoot: process.cwd() });
    console.log(`wrote ${file}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (argv[0] === 'new-workflow') {
  // Scaffold a starter workflow at <scope>/.claude/workflows/<id>.json.
  const id = argv[1];
  if (!id) {
    console.error('Usage: orderly-claude new-workflow <id> [--title "..."] [--category build|design|review|ship|plan] [--scope project|user]');
    process.exit(2);
  }
  const { scaffoldWorkflow, writeWorkflow } = await import('../src/core/workflows.mjs');
  const title = flag('title', null);
  const category = flag('category', 'build');
  const scope = flag('scope', 'project');
  const def = scaffoldWorkflow(id, { title, category });
  try {
    const file = writeWorkflow({ def, scope, repoRoot: process.cwd() });
    console.log(`wrote ${file}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (has('help')) {
  console.log(`orderly-claude — see what Claude Code is doing, in bubbles

  orderly                              watch the newest session for this directory
  orderly --session <id>               watch a specific session
  orderly --list                       list recent sessions and exit
  orderly --port <n>                   pin a port (default: first free from 7777)
  orderly --no-capture                 skip automatic before/after screenshots
  orderly --no-open                    don't open a browser
  orderly new-workflow <id> [options]  scaffold a starter workflow .json
  orderly new-prompt <slug> [options]  scaffold a starter prompt .md
`);
  process.exit(0);
}

if (has('list')) {
  for (const s of listSessions({ limit: 25 })) {
    console.log(`${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${s.sessionId.slice(0, 8)}  ${String(s.title).slice(0, 60)}`);
  }
  process.exit(0);
}

function freePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(freePort(start + 1)));
    srv.once('listening', () => srv.close(() => resolve(start)));
    srv.listen(start, '127.0.0.1');
  });
}

function register(entry) {
  ensureDirs();
  let all = [];
  try { all = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')); } catch {}
  all = all.filter((i) => {
    if (i.port === entry.port) return false;
    try { process.kill(i.pid, 0); return true; } catch { return false; }
  });
  all.push(entry);
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(all, null, 2));
}

function unregister(port) {
  try {
    const all = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')).filter((i) => i.port !== port);
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(all, null, 2));
  } catch {}
}

const sessionId = flag('session');
const target = sessionId
  ? listSessions().find((s) => s.sessionId.startsWith(sessionId))
  : sessionForCwd(process.cwd());

if (!target) {
  // Tell someone on a fresh machine which of the two things is missing.
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error('\n  No Claude Code transcripts on this machine yet.');
    console.error(`  Looked in ${PROJECTS_DIR.replace(os.homedir(), '~')}.`);
    console.error('  Run `claude` once in a project, then start orderly again.');
    console.error('  `orderly --doctor` shows what else is needed.\n');
  } else {
    console.error('\n  No session found for this directory.');
    console.error('  `orderly --list` shows what is available, and `orderly --session <id>` opens one.\n');
  }
  process.exit(1);
}

const port = Number(flag('port')) || (await freePort(7777));

let started;
try {
  started = await startServer({
    port,
    file: target.file,
    sessionId: target.sessionId,
    cwd: target.cwd,
    title: target.title,
    capture: !has('no-capture'),
  });
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use.`);
    console.error('  Another Orderly Claude may still be running: `orderly --port <n>` picks a different one,');
    console.error(`  or stop the old one with \`lsof -ti:${port} | xargs kill\`.\n`);
  } else {
    console.error(`\n  Could not start: ${err?.message || err}\n`);
  }
  process.exit(1);
}
const { close } = started;

register({ port, pid: process.pid, sessionId: target.sessionId, cwd: target.cwd, title: target.title, startedAt: new Date().toISOString() });

const url = `http://localhost:${port}`;
console.log(`\n  orderly claude  ${url}`);
console.log(`  session      ${String(target.title).slice(0, 60)}`);
console.log(`  watching     ${target.file.replace(process.env.HOME, '~')}\n`);

/** Open a browser on whichever platform this is. */
function openBrowser(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`  Open ${target} in a browser.`));
    child.unref();
  } catch { console.log(`  Open ${target} in a browser.`); }
}

if (!has('no-open')) openBrowser(url);

// A local viewer that dies silently is worse than one that logs and carries
// on; the page would simply look frozen.
process.on('uncaughtException', (e) => console.error('[orderly-claude] uncaught:', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[orderly-claude] unhandled:', e?.stack || e));

const bye = () => { unregister(port); close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
