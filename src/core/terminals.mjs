import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './paths.mjs';
import { listSessions } from './sessions.mjs';

/**
 * Claude Code terminals running right now.
 *
 * Claude Code keeps a file per running process at ~/.claude/sessions/<pid>.json
 * naming the session it is on, so no guessing is needed: no process scan, no
 * matching by working directory, no inferring from how recently a transcript
 * was written. A stale file is one whose process is gone, which `kill(pid, 0)`
 * answers.
 */
const REGISTRY = path.join(CLAUDE_DIR, 'sessions');
const BUSY_MS = 3 * 60 * 1000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function listTerminals() {
  let files = [];
  try { files = fs.readdirSync(REGISTRY).filter((f) => f.endsWith('.json')); } catch { return []; }

  const sessions = new Map(listSessions().map((s) => [s.sessionId, s]));
  const now = Date.now();
  const out = [];
  const seen = new Set();

  for (const name of files) {
    let entry;
    try { entry = JSON.parse(fs.readFileSync(path.join(REGISTRY, name), 'utf8')); }
    catch { continue; }

    const pid = entry.pid ?? Number(name.replace('.json', ''));
    if (!entry.sessionId || !pid || !alive(pid)) continue;
    if (entry.kind && entry.kind !== 'interactive') continue;
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);

    const meta = sessions.get(entry.sessionId);
    out.push({
      sessionId: entry.sessionId,
      pid,
      cwd: entry.cwd || meta?.cwd || null,
      name: entry.name || null,
      startedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
      title: meta?.title || entry.name || entry.sessionId.slice(0, 8),
      file: meta?.file || null,
      updatedAt: meta?.updatedAt || null,
      // Working on something, as opposed to merely open at a prompt.
      busy: meta ? now - meta.mtimeMs < BUSY_MS : false,
      hasTranscript: !!meta,
    });
  }

  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}
