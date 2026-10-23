import fs from 'node:fs';
import path from 'node:path';
import { lineDiff, hunks, diffStats } from './diff.mjs';
import { resolveChange } from './filehistory.mjs';

function make(absPath, before, after, origin) {
  const ops = lineDiff(before || '', after || '');
  const stats = diffStats(ops);
  if (!stats.changed && origin !== 'write') return null;
  return {
    path: absPath,
    name: path.basename(absPath || ''),
    origin,
    before: before ?? '',
    after: after ?? '',
    stats,
    hunks: hunks(ops, 3).slice(0, 40),
    isNew: !before,
  };
}

/** `cat > file <<'EOF' … EOF` and `… > file` — how shell-written files get caught. */
function fromBash(cmd = '') {
  const out = [];
  const heredoc = /(?:cat|tee)\s*>>?\s*(['"]?)([^\s'"<>|]+)\1\s*<<\s*-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3\n([\s\S]*?)\n\4(?:\n|$)/g;
  let m;
  while ((m = heredoc.exec(cmd))) out.push({ file: m[2], content: m[5] });
  return out;
}

function readDisk(p) {
  try {
    const buf = fs.readFileSync(p);
    return buf.includes(0) ? null : buf.toString('utf8');
  } catch { return null; }
}

function resolvePath(p, cwd) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
}

/** Before/after derived from what the tool was actually asked to do. Always available. */
export function changesFromCalls(step, cwd) {
  const out = [];
  for (const c of step.calls || []) {
    const i = c.input || {};
    if (c.tool === 'Edit' && typeof i.old_string === 'string') {
      const ch = make(resolvePath(i.file_path, cwd), i.old_string, i.new_string ?? '', 'edit');
      if (ch) out.push(ch);
    } else if (c.tool === 'MultiEdit' && Array.isArray(i.edits)) {
      for (const e of i.edits) {
        const ch = make(resolvePath(i.file_path, cwd), e.old_string, e.new_string ?? '', 'edit');
        if (ch) out.push(ch);
      }
    } else if (c.tool === 'Write' && typeof i.content === 'string') {
      const ch = make(resolvePath(i.file_path, cwd), null, i.content, 'write');
      if (ch) out.push(ch);
    } else if (c.tool === 'Bash' && typeof i.command === 'string') {
      for (const h of fromBash(i.command)) {
        const abs = resolvePath(h.file, cwd);
        const ch = make(abs, null, h.content, 'write');
        if (ch) out.push(ch);
      }
    }
  }
  return out;
}

/**
 * All before/after for a step.
 *
 * Tool inputs are authoritative — they say exactly what was asked for.
 * File-history backups only enrich a path when a snapshot genuinely falls
 * inside the step's window, which stops an old backup being misread as a
 * change this step made.
 */
export function stepChanges(history, sessionId, step, cwd) {
  const byPath = new Map();
  for (const ch of changesFromCalls(step, cwd)) {
    const prev = byPath.get(ch.path);
    if (!prev) byPath.set(ch.path, ch);
    else {
      // two edits to the same file in one step: widen the window
      prev.after = ch.after;
      prev.stats = { added: prev.stats.added + ch.stats.added, removed: prev.stats.removed + ch.stats.removed, changed: 0 };
      prev.hunks = [...prev.hunks, ...ch.hunks].slice(0, 40);
    }
  }

  const start = step.startedAt ? Date.parse(step.startedAt) - 2000 : 0;
  const end = step.endedAt ? Date.parse(step.endedAt) + 8000 : Infinity;

  for (const [abs, versions] of history) {
    const inWindow = versions.some((v) => {
      const t = Date.parse(v.at || 0);
      return t >= start && t <= end;
    });
    if (!inWindow) continue;
    const rich = resolveChange(history, sessionId, abs, step.endedAt);
    if (!rich) continue;
    const existing = byPath.get(abs);
    // Prefer the whole-file view when the snapshot really covers this step.
    if (!existing || rich.stats.changed >= existing.stats.changed) byPath.set(abs, { ...rich, origin: 'snapshot' });
  }

  const out = [...byPath.values()];
  for (const ch of out) if (!ch.stats.changed) ch.stats.changed = ch.stats.added + ch.stats.removed;
  return out;
}
