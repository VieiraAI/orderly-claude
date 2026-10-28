/*
 * Content-hashed blob store at ~/.orderly-claude/blobs/.
 *
 * Any heavy artifact a workflow run produces — a screenshot, a captured
 * network trace, a screencast — lives here once per sha, keyed by its hash.
 * Run.json carries a `blob:sha256:<hex>` reference instead of the bytes.
 * Clearing the store never damages a run.json; the reference stays valid as
 * soon as the content is captured again.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOBS_DIR } from './paths.mjs';

const PREFIX = 'blob:sha256:';

/** Store bytes (Buffer | string) under their sha256. Returns a blob ref. */
export function putBuffer(data, { ext = '' } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const dir = blobDir(sha);
  const file = blobFile(sha, ext);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return `${PREFIX}${sha}${ext ? ':' + ext.replace(/^\./, '') : ''}`;
}

/** Store a file by path; copies into the store under its sha. */
export function putFile(srcPath) {
  const buf = fs.readFileSync(srcPath);
  const ext = path.extname(srcPath).slice(1);
  return putBuffer(buf, { ext });
}

/** Return { path, sha, ext } for a blob ref, or null if missing. */
export function resolveBlob(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(PREFIX)) return null;
  const rest = ref.slice(PREFIX.length);
  const [sha, ext = ''] = rest.split(':');
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const file = blobFile(sha, ext);
  if (!fs.existsSync(file)) return null;
  return { path: file, sha, ext };
}

/** Open a blob by its sha only (no ref), for the HTTP route. */
export function openBlob(sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const dir = blobDir(sha);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  if (!files.length) return null;
  // Only one file ever lives in a blob dir, under the sha with whatever ext.
  return { path: path.join(dir, files[0]), sha, ext: path.extname(files[0]).slice(1) };
}

function blobDir(sha) {
  return path.join(BLOBS_DIR, sha.slice(0, 2), sha.slice(2));
}
function blobFile(sha, ext) {
  return path.join(blobDir(sha), ext ? `${sha}.${ext.replace(/^\./, '')}` : sha);
}
