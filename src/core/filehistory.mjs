import fs from 'node:fs';
import path from 'node:path';
import { backupPath } from './paths.mjs';
import { lineDiff, hunks, diffStats } from './diff.mjs';

/**
 * Claude Code snapshots a file *before* each modification, as `<hash>@vN`.
 * So backup@vN is the content before edit N, and the content after edit N is
 * backup@v(N+1) when a later edit exists, otherwise the file on disk now.
 */
export function buildFileHistory(records) {
  const byPath = new Map();
  for (const r of records) {
    if (r.type !== 'file-history-delta' || !r.backup) continue;
    const dir = r.backup.realParentDir || '';
    const abs = dir ? path.join(dir, path.basename(r.trackingPath || '')) : r.trackingPath;
    if (!abs) continue;
    if (!byPath.has(abs)) byPath.set(abs, []);
    byPath.get(abs).push({
      version: r.backup.version ?? 0,
      file: r.backup.backupFileName,
      at: r.backup.backupTime || r.timestamp || null,
    });
  }
  for (const list of byPath.values()) list.sort((a, b) => a.version - b.version);
  return byPath;
}

function readText(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch { return null; }
}

/** Resolve before/after text for one file at one point in time. */
export function resolveChange(history, sessionId, absPath, at) {
  const versions = history.get(absPath);
  if (!versions?.length) return null;

  const t = at ? Date.parse(at) : Infinity;
  let idx = -1;
  for (let i = 0; i < versions.length; i++) {
    const vt = Date.parse(versions[i].at || 0);
    if (vt <= t + 2000) idx = i; else break;
  }
  if (idx === -1) idx = 0;

  // A brand-new file has no prior content, so its backup name is null.
  const read = (v) => (v && v.file ? readText(backupPath(sessionId, v.file)) : null);
  const before = read(versions[idx]);
  const next = versions[idx + 1];
  const after = next ? (read(next) ?? readText(absPath)) : readText(absPath);
  if (before === null && after === null) return null;

  const ops = lineDiff(before || '', after || '');
  return {
    path: absPath,
    name: path.basename(absPath),
    before: before ?? '',
    after: after ?? '',
    stats: diffStats(ops),
    hunks: hunks(ops, 3).slice(0, 40),
    isNew: before === null || before === '',
  };
}
