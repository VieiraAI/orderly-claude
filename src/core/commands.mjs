import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './paths.mjs';

/**
 * Slash commands offered in the composer.
 *
 * `runsHere` marks the ones that do something useful when sent from a browser.
 * The rest need the terminal: they open a picker or change the session you are
 * sitting in, and sending them from here would appear to do nothing. Saying so
 * up front beats letting someone type into a mode that cannot answer.
 */
const BUILT_INS = [
  { name: 'model', arg: '[name]', runsHere: false, summary: 'Choose the model for the session' },
  { name: 'clear', arg: '', runsHere: false, summary: 'Clear the conversation' },
  { name: 'compact', arg: '[instructions]', runsHere: true, summary: 'Summarise the conversation so far' },
  { name: 'cost', arg: '', runsHere: true, summary: 'Show token spend for this session' },
  { name: 'status', arg: '', runsHere: true, summary: 'Show session and account status' },
  { name: 'config', arg: '', runsHere: false, summary: 'Open settings' },
  { name: 'permissions', arg: '', runsHere: false, summary: 'Review tool permissions' },
  { name: 'memory', arg: '', runsHere: false, summary: 'Edit saved memory' },
  { name: 'init', arg: '', runsHere: true, summary: 'Write a CLAUDE.md for this repo' },
  { name: 'review', arg: '[target]', runsHere: true, summary: 'Review the current diff or a PR' },
  { name: 'security-review', arg: '', runsHere: true, summary: 'Security review of pending changes' },
  { name: 'agents', arg: '', runsHere: false, summary: 'Manage subagents' },
  { name: 'mcp', arg: '', runsHere: false, summary: 'Manage MCP servers' },
  { name: 'doctor', arg: '', runsHere: true, summary: 'Diagnose the installation' },
  { name: 'export', arg: '[file]', runsHere: true, summary: 'Export the conversation' },
  { name: 'add-dir', arg: '<path>', runsHere: true, summary: 'Give Claude another directory' },
  { name: 'help', arg: '', runsHere: true, summary: 'List what Claude Code can do' },
  { name: 'resume', arg: '[session]', runsHere: false, summary: 'Reopen an earlier session' },
  { name: 'bug', arg: '[description]', runsHere: true, summary: 'Report a problem' },
];

function readFrontMatter(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 1200);
    const block = head.match(/^---\n([\s\S]*?)\n---/);
    if (!block) return {};
    const out = {};
    for (const line of block[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return out;
  } catch { return {}; }
}

function fromDir(dir, origin) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const meta = readFrontMatter(path.join(dir, name));
    out.push({
      name: name.replace(/\.md$/, ''),
      arg: meta.argumentHint || meta['argument-hint'] || '[arguments]',
      summary: meta.description || `${origin} command`,
      runsHere: true,
      origin,
    });
  }
  return out;
}

/** Built-ins plus whatever this machine and project add. */
export function listCommands(projectDir) {
  const found = [
    ...BUILT_INS.map((c) => ({ ...c, origin: 'built-in' })),
    ...fromDir(path.join(CLAUDE_DIR, 'commands'), 'personal'),
  ];
  if (projectDir) found.push(...fromDir(path.join(projectDir, '.claude', 'commands'), 'project'));

  const seen = new Set();
  return found
    .filter((c) => (seen.has(c.name) ? false : seen.add(c.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
