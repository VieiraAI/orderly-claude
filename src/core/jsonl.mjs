import fs from 'node:fs';

/**
 * Read complete JSONL records starting at a byte offset.
 * Returns { records, nextOffset } where nextOffset sits on a line boundary,
 * so a partially-written trailing line is left for the next read.
 */
export function readRecords(file, fromOffset = 0, limitBytes = Infinity) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { records: [], nextOffset: fromOffset }; }
  if (stat.size <= fromOffset) return { records: [], nextOffset: fromOffset };

  const end = Math.min(stat.size, fromOffset + limitBytes);
  const length = end - fromOffset;
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, length, fromOffset); } finally { fs.closeSync(fd); }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { records: [], nextOffset: fromOffset };

  const complete = text.slice(0, lastNl);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1;

  const records = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return { records, nextOffset: fromOffset + consumed };
}

/** Read only the first N bytes worth of records — used for cheap indexing of huge files. */
export function readHead(file, bytes = 256 * 1024) {
  return readRecords(file, 0, bytes).records;
}
