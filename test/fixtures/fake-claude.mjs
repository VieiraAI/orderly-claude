#!/usr/bin/env node
/*
 * A stand-in for the `claude` CLI, for the assistant tests: free, fast, and
 * the same every time. It writes a transcript in Claude Code's format, edits
 * draft.json the way the assistant would, runs the real check.mjs, prints the
 * stream-json events Orderly reads, and records the arguments it was given so
 * a test can see the permission lockdown was asked for.
 *
 * What it does depends on the message:
 *   "add …"     adds a step after the last one
 *   "break …"   proposes a step that fails validation
 *   "explain …" answers without changing anything
 *   "slow …"    takes three seconds first, then does the rest
 *   "signin …"  fails as an unsigned-in Claude would
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const sessionId = arg('--session-id') || arg('--resume');
const text = arg('-p') || '';
const cwd = process.cwd();
fs.writeFileSync(path.join(cwd, 'last-args.json'), JSON.stringify(argv));

const dir = path.join(process.env.ORDERLY_ASSISTANT_PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${sessionId}.jsonl`);
const now = () => new Date().toISOString();
const rec = (r) => fs.appendFileSync(file, JSON.stringify({ sessionId, cwd, timestamp: now(), uuid: randomUUID(), ...r }) + '\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out({ type: 'system', subtype: 'init', session_id: sessionId, cwd });
if (/^signin/i.test(text)) {
  out({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0 });
  process.exit(1);
}
if (/^slow/i.test(text)) await sleep(3000);
const ask = text.replace(/^slow\s*/i, '');

rec({ type: 'user', message: { role: 'user', content: text } });
let n = 0;
const tool = (name, input, result) => {
  const id = `toolu_${++n}_${Date.now()}`;
  rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
};
const say = (t) => rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

say('Let me look at the workflow first.');
tool('Read', { file_path: path.join(cwd, 'current.json') }, fs.readFileSync(path.join(cwd, 'current.json'), 'utf8'));
let reply = '';
if (/^(add|break)/i.test(ask)) {
  const draft = JSON.parse(fs.readFileSync(path.join(cwd, 'draft.json'), 'utf8'));
  const last = draft.graph.nodes[draft.graph.nodes.length - 1];
  const node = /^break/i.test(ask)
    ? { id: 'oops', title: 'Broken step', kind: 'agent', spec: {} }
    : { id: 'notify', title: 'Tell the team', kind: 'script', spec: { cmd: 'echo done' } };
  draft.graph.nodes.push(node);
  if (last) draft.graph.edges.push([last.id, node.id]);
  fs.writeFileSync(path.join(cwd, 'draft.json'), JSON.stringify(draft, null, 2));
  tool('Edit', { file_path: path.join(cwd, 'draft.json'), old_string: '', new_string: '' }, 'updated');
  let check;
  try { check = execFileSync('node', ['check.mjs'], { cwd, encoding: 'utf8' }); }
  catch (e) { check = e.stdout || String(e); }
  tool('Bash', { command: 'node check.mjs', description: "Run Orderly's validator on the proposal" }, check);
  reply = /^break/i.test(ask)
    ? 'I added a step, but it still needs instructions.'
    : '- Added **Tell the team** after the last step.\n- It runs `echo done`; change the command to post where your team reads.';
} else {
  reply = 'This workflow runs its steps left to right. Nothing needs changing.';
}
say(reply);
out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.0123, num_turns: 3, session_id: sessionId });
