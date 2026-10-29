/*
 * Per-run worktree sandboxes.
 *
 * A workflow run that declares `runtime.sandbox: "worktree"` wants a disposable
 * copy of the repo it can edit without touching the main checkout. Here we
 * stand up a git worktree at `<repoRoot>/.claude/worktrees/run-<name>/`, hand
 * back the path, and expose a matching remove helper the scheduler calls on
 * finish.
 *
 * These wrap `git worktree add/remove` and tolerate the common failure modes:
 *   - detached HEAD is fine; the worktree inherits whatever is at HEAD
 *   - a leftover dir from a crashed run is cleaned up before re-adding
 *   - .claude/worktrees/ is in .gitignore so an orphan never shows up in diff
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Create a worktree for a run. Returns { path }.
 *
 * `name` is the subdir under .claude/worktrees/. `baseBranch` names a branch
 * to base from; if omitted, uses the current HEAD so uncommitted work is not
 * required (and is not carried over — a worktree starts from a commit, not
 * the index).
 */
export function createWorktree({ repoRoot, name, baseBranch = null }) {
  if (!repoRoot) throw new Error('createWorktree: repoRoot is required');
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('createWorktree: name must be [A-Za-z0-9_.-]+');
  const base = path.join(repoRoot, '.claude', 'worktrees');
  fs.mkdirSync(base, { recursive: true });
  const dest = path.join(base, name);
  // A stale dir from a crashed run would block `git worktree add`. Prune
  // first, then force-remove if git refuses, then add fresh.
  if (fs.existsSync(dest)) {
    try { gitQuiet(['worktree', 'remove', '--force', dest], repoRoot); } catch { /* fall through */ }
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
  }
  gitQuiet(['worktree', 'prune'], repoRoot);
  const ref = baseBranch || resolveHead(repoRoot);
  gitQuiet(['worktree', 'add', '--detach', dest, ref], repoRoot);
  return { path: dest };
}

/** Remove a worktree. Safe to call even if it's already gone. */
export function removeWorktree(worktreePath, repoRoot) {
  if (!worktreePath) return false;
  if (!fs.existsSync(worktreePath)) return false;
  try { gitQuiet(['worktree', 'remove', '--force', worktreePath], repoRoot); }
  catch {
    // git refused — hard delete and prune so git forgets it.
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    try { gitQuiet(['worktree', 'prune'], repoRoot); } catch {}
  }
  return true;
}

function resolveHead(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return out.trim();
  } catch { return 'HEAD'; }
}

function gitQuiet(argv, cwd) {
  return execFileSync('git', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}
