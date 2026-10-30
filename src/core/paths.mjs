import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
// Tests point these at a scratch folder so they never read or write the person's real ones.
export const CLAUDE_DIR = process.env.ORDERLY_CLAUDE_DIR || path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
export const DATA_DIR = process.env.ORDERLY_DATA_DIR || path.join(HOME, '.orderly-claude');
// Kept so screenshots taken under the previous name are still found.
const LEGACY_DATA_DIR = path.join(HOME, '.claudenized');
export const SHOTS_DIR = path.join(DATA_DIR, 'shots');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const INSTANCES_FILE = path.join(DATA_DIR, 'instances.json');
export const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
export const SCRATCH_RUNS_DIR = path.join(DATA_DIR, 'runs', '_scratch');
export const USER_WORKFLOWS_DIR = path.join(CLAUDE_DIR, 'workflows');
export const USER_SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
export const USER_PROMPTS_DIR = path.join(CLAUDE_DIR, 'prompts');
/** Where the workflow assistant keeps one working folder per conversation. Per call, so tests can move it. */
export const assistantDir = () => process.env.ORDERLY_ASSISTANT_DIR || path.join(DATA_DIR, 'assistant');

/** The workflows and runs directories for a repo. The repo owns both. */
export function repoWorkflowsDir(repoRoot) {
  return path.join(repoRoot, '.claude', 'workflows');
}
export function repoRunsDir(repoRoot) {
  // Tests point this elsewhere so their runs never land in a real project.
  const override = process.env.ORDERLY_RUNS_ROOT;
  if (override) return path.join(override, String(repoRoot).replace(/[\\/:]+/g, '-'));
  return path.join(repoRoot, '.claude', 'workflows', 'runs');
}
export function repoSkillsDir(repoRoot) {
  return path.join(repoRoot, '.claude', 'skills');
}
export function repoPromptsDir(repoRoot) {
  return path.join(repoRoot, '.claude', 'prompts');
}

let migrated = false;

/**
 * Bring screenshots across from the previous name.
 *
 * Folder by folder rather than one rename: if the new directory already
 * exists — and a single run that started before this code was enough to
 * create it — a rename is skipped and the history silently stays behind.
 */
function adoptLegacyData() {
  if (migrated) return;
  migrated = true;
  // A scratch data folder must not pull the person's old screenshots into it.
  if (process.env.ORDERLY_DATA_DIR) return;
  const from = path.join(LEGACY_DATA_DIR, 'shots');
  if (!fs.existsSync(from)) return;
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    for (const session of fs.readdirSync(from)) {
      const src = path.join(from, session);
      const dst = path.join(SHOTS_DIR, session);
      if (!fs.statSync(src).isDirectory()) continue;
      fs.mkdirSync(dst, { recursive: true });

      for (const file of fs.readdirSync(src)) {
        const target = path.join(dst, file);
        if (file === 'index.json') {
          // Two indexes for one session: keep both sets of pairs.
          const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
          const merged = { ...read(path.join(src, file)), ...read(target) };
          fs.writeFileSync(target, JSON.stringify(merged, null, 2));
          continue;
        }
        if (fs.existsSync(target)) continue;
        try { fs.renameSync(path.join(src, file), target); } catch { /* leave it */ }
      }
    }
  } catch { /* nothing to adopt */ }
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SHOTS_DIR, UPLOADS_DIR, BLOBS_DIR]) fs.mkdirSync(d, { recursive: true });
  adoptLegacyData();
}

/**
 * Claude Code stores a project's transcripts under the working directory
 * with every slash turned into a dash, so the path of a session that has not
 * been started yet can be worked out in advance.
 */
export function transcriptPathFor(cwd, sessionId) {
  const folder = String(cwd || '').replace(/\//g, '-');
  return path.join(PROJECTS_DIR, folder, `${sessionId}.jsonl`);
}

/** Where a session's attachments live. */
export function uploadsFor(sessionId) {
  return path.join(UPLOADS_DIR, sessionId);
}

/** Backup file for a file-history entry: ~/.claude/file-history/<session>/<backupFileName> */
export function backupPath(sessionId, backupFileName) {
  return path.join(FILE_HISTORY_DIR, sessionId, backupFileName);
}
