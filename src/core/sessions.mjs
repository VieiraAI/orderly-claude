import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './paths.mjs';
import { readHead } from './jsonl.mjs';

function firstPrompt(records) {
  for (const r of records) {
    if (r.type !== 'user' || r.isMeta || r.sourceToolUseID || r.isSidechain) continue;
    const c = r.message?.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '';
    const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (clean) return clean.slice(0, 120);
  }
  return null;
}

const headCache = new Map(); // file -> { key, entry }

/** Index every session on disk, newest first. Reads only the head of each file. */
export function listSessions({ limit = 400 } = {}) {
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return []; }

  const out = [];
  for (const d of projectDirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.size < 64) continue;

      const key = `${st.mtimeMs}:${st.size}`;
      const cached = headCache.get(file);
      if (cached && cached.key === key) { out.push(cached.entry); continue; }

      const head = readHead(file, 256 * 1024);
      const pick = (k) => head.find((r) => r[k])?.[k] || null;
      const titleRec = head.find((r) => r.type === 'ai-title');
      const entry = {
        sessionId: f.replace(/\.jsonl$/, ''),
        file,
        project: d.name,
        cwd: pick('cwd'),
        gitBranch: pick('gitBranch'),
        title: titleRec?.title || titleRec?.aiTitle || firstPrompt(head)
          || head.find((r) => r.type === 'last-prompt')?.lastPrompt?.slice(0, 120)
          || d.name.replace(/^-/, '/').replace(/-/g, '/'),
        startedAt: pick('timestamp'),
        updatedAt: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
        bytes: st.size,
      };
      headCache.set(file, { key, entry });
      out.push(entry);
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // A transcript touched in the last few minutes means a terminal is open on it.
  const now = Date.now();
  for (const s of out) s.active = now - s.mtimeMs < 3 * 60 * 1000;
  return out.slice(0, limit);
}

/** The most recently touched session whose cwd matches (or sits under) a directory. */
export function sessionForCwd(cwd) {
  const all = listSessions();
  const exact = all.find((s) => s.cwd === cwd);
  if (exact) return exact;
  return all.find((s) => s.cwd && cwd.startsWith(s.cwd)) || all[0] || null;
}
