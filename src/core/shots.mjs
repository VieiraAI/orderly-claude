import fs from 'node:fs';
import path from 'node:path';
import { SHOTS_DIR, ensureDirs } from './paths.mjs';

const indexFile = (sessionId) => path.join(SHOTS_DIR, sessionId, 'index.json');

/** Identical renders produce identical PNGs, so comparing bytes is enough. */
export function shotsDiffer(before, after) {
  if (!before?.file || !after?.file) return false;
  try {
    const a = fs.statSync(before.file);
    const b = fs.statSync(after.file);
    if (a.size !== b.size) return true;
    return !fs.readFileSync(before.file).equals(fs.readFileSync(after.file));
  } catch { return false; }
}

/** Screenshot pairs survive a restart, so an old session keeps its before/afters. */
/**
 * Find a stored image.
 *
 * Paths were written absolute, so anything recorded under an older data
 * directory points nowhere once the files move. Fall back to the file's name
 * inside this session's folder, which survives a move.
 */
function resolveShot(sessionId, shot) {
  if (!shot?.file) return null;
  if (fs.existsSync(shot.file)) return shot;
  const moved = path.join(SHOTS_DIR, sessionId, path.basename(shot.file));
  return fs.existsSync(moved) ? { ...shot, file: moved } : null;
}

export function loadShots(sessionId) {
  if (!sessionId) return {};
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(sessionId), 'utf8'));
    const out = {};
    for (const [stepId, pair] of Object.entries(raw)) {
      const before = resolveShot(sessionId, pair.before);
      const after = resolveShot(sessionId, pair.after);
      if (!before && !after) continue;
      // Pairs stored before this field existed get it computed on the way in.
      const changed = pair.changed ?? shotsDiffer(before, after);
      out[stepId] = { before, after, changed };
    }
    return out;
  } catch { return {}; }
}

export function saveShots(sessionId, pairs) {
  if (!sessionId) return;
  const file = indexFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pairs, null, 2));
}

/** Hang stored pairs off the steps of an already-built session. */
export function attachShots(session, pairs) {
  for (const t of session.turns || []) {
    for (const s of t.steps) s.shots = pairs[s.id] || null;
  }
  return session;
}
