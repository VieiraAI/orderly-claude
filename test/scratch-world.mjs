/**
 * A throwaway world for the smoke suite to run in.
 *
 * Import this before anything from src/: the paths in src/core/paths.mjs are
 * fixed the moment that module loads, so the ORDERLY_* variables have to be
 * set first. ES modules run their imports in order, which is what makes this
 * work; nothing here may import from src/.
 *
 * Everything the suite reads or writes lives under one temp folder:
 *
 *   <home>/project        a git repo with one commit; the booted session's cwd
 *   <home>/other-project  a second project, with a session of its own
 *   <home>/claude         stands in for ~/.claude (transcripts, skills, the
 *                         user workflow library, the terminal registry)
 *   <home>/data           stands in for ~/.orderly-claude (blobs, shots,
 *                         uploads, decisions, share key, scratch runs)
 *   <home>/runs           every repo's workflow runs
 *   <home>/schedules      schedules and settings
 *
 * The transcripts are synthetic. They follow the shape Claude Code writes,
 * with just enough in them for the checks: prompts, a look-only step, an
 * edit, a question that was answered, and reasoning.
 *
 * The folder is deleted when the process exits, however it exits, unless
 * KEEP_SMOKE=1 is set.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// realpath: on macOS /var is /private/var, and the server compares paths.
export const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-smoke-home-')));
export const repo = path.join(home, 'project');
export const otherRepo = path.join(home, 'other-project');
export const claudeDir = path.join(home, 'claude');
export const dataDir = path.join(home, 'data');
export const projectsDir = path.join(claudeDir, 'projects');

/* --------------------------------- cleanup -------------------------------- */

const keep = process.env.KEEP_SMOKE === '1';
const startedIn = process.cwd();
let cleaned = false;
export function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { process.chdir(startedIn); } catch { /* gone; anywhere will do */ }
  if (keep) { console.log(`\nKEEP_SMOKE=1: scratch world left at ${home}`); return; }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir; the OS will clear it */ }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

/* ------------------------------ environment ------------------------------- */

process.env.ORDERLY_CLAUDE_DIR = claudeDir;
process.env.ORDERLY_DATA_DIR = dataDir;
process.env.ORDERLY_RUNS_ROOT = path.join(home, 'runs');
process.env.ORDERLY_SCHEDULES_DIR = path.join(home, 'schedules');
process.env.ORDERLY_SETTINGS_FILE = path.join(home, 'schedules', 'settings.json');
if (process.env.ORDERLY_HANDLER_MODE !== 'real') process.env.ORDERLY_HANDLER_MODE = 'mock';

/* -------------------------------- projects -------------------------------- */

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const git = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(dir, files) {
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Start');
}

const GREET_BEFORE = "export function greet(name) {\n  return 'Hello ' + name;\n}\n";
const GREET_AFTER = "export function greet(name = 'there') {\n  return `Hello, ${name}!`;\n}\n";

// The repo's own starter prompts are tracked content, not anyone's data; the
// prompts check looks for one of them in the booted project.
const prompts = {};
const promptsDir = path.join(SOURCE_REPO, '.claude', 'prompts');
for (const name of fs.existsSync(promptsDir) ? fs.readdirSync(promptsDir) : []) {
  if (name.endsWith('.md')) prompts[`.claude/prompts/${name}`] = fs.readFileSync(path.join(promptsDir, name), 'utf8');
}

makeRepo(repo, {
  'package.json': JSON.stringify({ name: 'smoke-project', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  'README.md': '# Smoke project\n\nA throwaway repo for the Orderly Claude smoke suite.\n',
  'src/greet.js': GREET_AFTER,
  '.gitignore': '.claude/worktrees/\n',
  // A brand with a real palette and font, for the verify checks.
  '.claude/brand.json': JSON.stringify({
    name: 'Smoke project',
    palette: { whitelist: ['#15181B', '#FFFFFF', '#415A6B', '#A94E46'], allowGrays: true, grayTolerance: 10 },
    fonts: { sans: { families: ['Inter', 'system-ui', 'sans-serif'] }, mono: { families: ['Menlo', 'monospace'] } },
  }, null, 2) + '\n',
  ...prompts,
});
makeRepo(otherRepo, {
  'README.md': '# Other project\n',
});

/* ------------------------------- transcripts ------------------------------ */

const folderFor = (cwd) => path.join(projectsDir, cwd.replace(/\//g, '-'));

/** Build a transcript from a list of events, a second apart, ending now. */
function transcript({ cwd, sessionId, title, events }) {
  const t0 = Date.now() - events.length * 1000 - 5000;
  let parent = null;
  let n = 0;
  const base = () => ({
    parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli',
    cwd, sessionId, version: '2.1.0', gitBranch: 'main',
  });
  const stamp = () => new Date(t0 + (n++) * 1000).toISOString();
  const lines = [{ type: 'ai-title', title, sessionId }];
  const toolNames = {};
  for (const ev of events) {
    const uuid = randomUUID();
    let rec;
    if (ev.prompt) {
      rec = { ...base(), type: 'user', promptId: randomUUID(), message: { role: 'user', content: ev.prompt } };
    } else if (ev.say || ev.think) {
      const content = [];
      if (ev.think) content.push({ type: 'thinking', thinking: ev.think, signature: 'smoke' });
      if (ev.say) content.push({ type: 'text', text: ev.say });
      rec = { ...base(), type: 'assistant', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-smoke', content, stop_reason: 'end_turn' } };
    } else if (ev.tool) {
      const id = `toolu_${randomUUID().replace(/-/g, '')}`;
      toolNames[ev.tool] = id;
      rec = { ...base(), type: 'assistant', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-smoke',
        content: [{ type: 'tool_use', id, name: ev.tool, input: ev.input }], stop_reason: 'tool_use' } };
      lines.push({ ...rec, uuid, timestamp: stamp() });
      parent = uuid;
      const resultId = randomUUID();
      lines.push({ ...base(), type: 'user', uuid: resultId, timestamp: stamp(), sourceToolAssistantUUID: uuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ev.result, is_error: !!ev.isError }] },
        toolUseResult: ev.toolUseResult || { stdout: ev.result, stderr: '', interrupted: false } });
      parent = resultId;
      continue;
    }
    lines.push({ ...rec, uuid, timestamp: stamp() });
    parent = uuid;
  }
  const file = path.join(folderFor(cwd), `${sessionId}.jsonl`);
  write(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

export const sessionId = randomUUID();
export const otherSessionId = randomUUID();

// Two questions: the decision panel lists each one's text only when there
// is more than one (a single question is shown in the headline instead).
const QUESTIONS = [{
  question: 'Which greeting should the default be?',
  header: 'Greeting',
  multiSelect: false,
  options: [
    { label: 'Hello, there!', description: 'Friendly, and works when no name is given.' },
    { label: 'Hi', description: 'Shorter, but reads oddly with a name after it.' },
  ],
}, {
  question: 'Should the README mention it?',
  header: 'Docs',
  multiSelect: false,
  options: [
    { label: 'Yes', description: 'One line under the title.' },
    { label: 'No', description: 'Leave the README as it is.' },
  ],
}];

export const sessionFile = transcript({
  cwd: repo, sessionId, title: 'Tidy the greeting helper',
  events: [
    { prompt: 'Tidy up the greeting helper in src/greet.js and give it a sensible default.' },
    { think: 'Look at the file first, then make the smallest edit that adds a default name.', say: 'I will read the helper, then edit it.' },
    { tool: 'Bash', input: { command: 'ls src && git log --oneline -1', description: 'List source files and the last commit' },
      result: 'greet.js\nabc1234 Start' },
    { tool: 'Read', input: { file_path: path.join(repo, 'src/greet.js') },
      result: GREET_BEFORE, toolUseResult: { type: 'text', file: { filePath: path.join(repo, 'src/greet.js'), content: GREET_BEFORE } } },
    { tool: 'AskUserQuestion', input: { questions: QUESTIONS },
      result: `User has answered your questions: "${QUESTIONS[0].question}"="Hello, there!", "${QUESTIONS[1].question}"="Yes".`,
      toolUseResult: { questions: QUESTIONS, answers: { [QUESTIONS[0].question]: 'Hello, there!', [QUESTIONS[1].question]: 'Yes' } } },
    { think: 'The person picked the friendly default. Use a template string and a default parameter.' },
    { tool: 'Edit', input: { file_path: path.join(repo, 'src/greet.js'), old_string: GREET_BEFORE, new_string: GREET_AFTER, replace_all: false },
      result: 'The file has been updated.',
      toolUseResult: { filePath: path.join(repo, 'src/greet.js'), oldString: GREET_BEFORE, newString: GREET_AFTER } },
    { tool: 'Bash', input: { command: "node -e \"import('./src/greet.js').then(m => console.log(m.greet()))\"", description: 'Run the helper once' },
      result: 'Hello, there!' },
    { say: 'Done. `greet()` now defaults to "there" and punctuates the greeting.' },
    { prompt: 'Add a line about it to the README.' },
    { tool: 'Edit', input: { file_path: path.join(repo, 'README.md'),
      old_string: 'A throwaway repo for the Orderly Claude smoke suite.\n',
      new_string: 'A throwaway repo for the Orderly Claude smoke suite.\n\n`greet()` says hello to whoever you name.\n' },
      result: 'The file has been updated.' },
    { say: 'Added a line to the README.' },
  ],
});

export const otherSessionFile = transcript({
  cwd: otherRepo, sessionId: otherSessionId, title: 'Look around the other project',
  events: [
    { prompt: 'What is in this project?' },
    { tool: 'Bash', input: { command: 'ls', description: 'List the files' }, result: 'README.md' },
    { say: 'Only a README so far.' },
  ],
});

// The booted session is the most recent one, as the person's would be.
const aMinuteAgo = new Date(Date.now() - 60_000);
fs.utimesSync(otherSessionFile, aMinuteAgo, aMinuteAgo);

/* ------------------------- library, terminals, shots ----------------------- */

// A skill with a folded description, so the frontmatter reader has one to parse.
write(path.join(claudeDir, 'skills', 'smoke-skill', 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: >',
  '  A skill that exists only for the smoke suite, written with a folded',
  '  description so the reader has to join the lines.',
  '---',
  '',
  'Nothing to do.',
  '',
].join('\n'));

// Claude Code registers each running terminal; this process stands in for one.
write(path.join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId, cwd: repo, startedAt: Date.now(), kind: 'interactive',
}));

/** A solid-colour PNG, so the swipe checks have a real before/after to drag. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Store a before/after pair against one step of the booted session. */
export function seedShotPair(stepId) {
  const dir = path.join(dataDir, 'shots', sessionId);
  const before = path.join(dir, `${stepId}-before.png`);
  const after = path.join(dir, `${stepId}-after.png`);
  write(before, png(800, 500, [230, 230, 230]));
  write(after, png(800, 500, [65, 90, 107]));
  const at = Date.now();
  write(path.join(dir, 'index.json'), JSON.stringify({
    [stepId]: {
      before: { file: before, at: new Date(at - 4000).toISOString() },
      after: { file: after, at: new Date(at).toISOString() },
      changed: true, spanMs: 4000,
    },
  }, null, 2));
}

// The server treats the folder it was started from as a known project, so
// start from the scratch repo rather than whichever checkout ran the suite.
process.chdir(repo);
