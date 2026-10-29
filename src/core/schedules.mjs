/*
 * Schedules — a workflow set to repeat, on this machine, while Orderly is open.
 *
 * That last clause is the whole design. Orderly is a local server that exits
 * with its terminal, so a schedule can only promise to fire while it runs.
 * When it was closed or asleep at a due time, the window is counted as missed
 * and never made up later: coming back to four queued runs firing at once,
 * spending four times the money, is not what anyone meant by "daily".
 *
 * Schedules live here rather than on the workflow because they belong to a
 * person and their machine. Export a workflow and you share the process, not
 * your 7am.
 *
 * Several Orderly servers can run at once, one per session, so only the one
 * holding the lock file ticks. When it exits, the next tick of another takes
 * the lock over.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './paths.mjs';

// Resolved per call so the test suite can point them somewhere disposable
// instead of at the person's real schedules.
const dir = () => process.env.ORDERLY_SCHEDULES_DIR || DATA_DIR;
const FILE = () => path.join(dir(), 'schedules.json');
const LOCK = () => path.join(dir(), 'scheduler.lock');
/** How late a tick may be and still fire. Anything later was slept through. */
export const GRACE_MS = 150_000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* -------------------------------- rules --------------------------------- */

/*
 * Four shapes, chosen to be sayable rather than to be cron:
 *   { every: 'minutes', n }             every n minutes
 *   { every: 'hours', n }               every n hours
 *   { every: 'day', at: 'HH:MM' }       every day at a local time
 *   { every: 'week', day: 0-6, at }     every week, on a day, at a time
 */
export function validateRule(rule) {
  const problems = [];
  if (!rule || typeof rule !== 'object') return ['a repeat rule is required'];
  const hhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  switch (rule.every) {
    case 'minutes':
      if (!Number.isInteger(rule.n) || rule.n < 5 || rule.n > 1440) problems.push('minutes must be a whole number from 5 to 1440');
      break;
    case 'hours':
      if (!Number.isInteger(rule.n) || rule.n < 1 || rule.n > 168) problems.push('hours must be a whole number from 1 to 168');
      break;
    case 'day':
      if (!hhmm(rule.at)) problems.push('time must look like 07:30');
      break;
    case 'week':
      if (!Number.isInteger(rule.day) || rule.day < 0 || rule.day > 6) problems.push('pick a day of the week');
      if (!hhmm(rule.at)) problems.push('time must look like 07:30');
      break;
    default:
      problems.push('repeat must be every N minutes, every N hours, daily, or weekly');
  }
  return problems;
}

export function describeRule(rule) {
  if (!rule) return '';
  switch (rule.every) {
    case 'minutes': return `Every ${rule.n} minutes`;
    case 'hours':   return rule.n === 1 ? 'Every hour' : `Every ${rule.n} hours`;
    case 'day':     return `Every day at ${rule.at}`;
    case 'week':    return `Every ${DAYS[rule.day]} at ${rule.at}`;
    default:        return 'Unknown repeat';
  }
}

/** The first due time strictly after `fromMs`. Interval rules count from `anchorMs`. */
export function nextAfter(rule, fromMs, anchorMs = fromMs) {
  if (rule.every === 'minutes' || rule.every === 'hours') {
    const step = rule.n * (rule.every === 'minutes' ? 60_000 : 3_600_000);
    const k = Math.floor((fromMs - anchorMs) / step) + 1;
    return anchorMs + Math.max(1, k) * step;
  }
  const [h, m] = String(rule.at).split(':').map(Number);
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (rule.every === 'day') {
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    // setDate keeps local wall time across DST, so 07:00 stays 07:00.
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  // week
  let add = (rule.day - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= fromMs) add = 7;
  d.setDate(d.getDate() + add);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** How many due times fall in [fromMs, toMs]. Capped, since it is only ever reported. */
export function countWindows(rule, fromMs, toMs, anchorMs) {
  let n = 0;
  let t = fromMs;
  while (t <= toMs && n < 10_000) { n++; t = nextAfter(rule, t, anchorMs); }
  return n;
}

/* -------------------------------- store --------------------------------- */

export function listSchedules() {
  try {
    const all = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

function save(all) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE());
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function createSchedule({ workflowId, repoRoot = null, inputs = {}, rule, budgetUsd, now = Date.now() }) {
  if (!workflowId) throw new Error('workflowId is required');
  const problems = validateRule(rule);
  if (problems.length) throw new Error(problems.join('; '));
  const budget = money(budgetUsd);
  if (!budget) throw new Error('A scheduled run needs a spend limit, since nobody may be watching it');
  // The same workflow, at the same times, with the same inputs, would just
  // run twice — almost always a double click, never what anyone wanted.
  const same = (x) => x.workflowId === workflowId && (x.repoRoot || null) === (repoRoot || null)
    && JSON.stringify(x.rule) === JSON.stringify(rule) && JSON.stringify(x.inputs || {}) === JSON.stringify(inputs || {});
  if (listSchedules().some(same)) throw new Error('You already have this exact schedule');
  const s = {
    id: randomUUID(),
    workflowId,
    repoRoot,
    inputs: inputs || {},
    rule,
    budgetUsd: budget,
    enabled: true,
    createdAt: new Date(now).toISOString(),
    anchorAt: now,
    nextDueAt: nextAfter(rule, now, now),
    lastFiredAt: null,
    lastRunId: null,
    lastStatus: null,
    missed: 0,
    lastMissedAt: null,
    fired: 0,
  };
  const all = listSchedules();
  all.push(s);
  save(all);
  return s;
}

export function updateSchedule(id, patch, now = Date.now()) {
  const all = listSchedules();
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error('schedule not found');
  if (patch.rule) {
    const problems = validateRule(patch.rule);
    if (problems.length) throw new Error(problems.join('; '));
    s.rule = patch.rule;
    s.anchorAt = now;
    s.nextDueAt = nextAfter(s.rule, now, now);
  }
  if ('budgetUsd' in patch) {
    const b = money(patch.budgetUsd);
    if (!b) throw new Error('A scheduled run needs a spend limit');
    s.budgetUsd = b;
  }
  if ('inputs' in patch) s.inputs = patch.inputs || {};
  if ('enabled' in patch) {
    s.enabled = !!patch.enabled;
    // Re-enabling starts from now; the paused stretch is not "missed".
    if (s.enabled) s.nextDueAt = nextAfter(s.rule, now, s.anchorAt);
  }
  if (patch.clearMissed) { s.missed = 0; s.lastMissedAt = null; }
  save(all);
  return s;
}

export function deleteSchedule(id) {
  const all = listSchedules();
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  save(next);
  return true;
}

/* -------------------------------- lock ---------------------------------- */

function holder() {
  try { return JSON.parse(fs.readFileSync(LOCK(), 'utf8')); } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Take or keep the lock. True when this process should tick. */
export function acquireLock(pid = process.pid) {
  fs.mkdirSync(dir(), { recursive: true });
  const h = holder();
  if (h?.pid === pid) return true;
  if (h && alive(h.pid)) return false;
  try { fs.unlinkSync(LOCK()); } catch { /* not there */ }
  try {
    // `wx` fails if another process created it first, which settles a race
    // between two servers starting together.
    fs.writeFileSync(LOCK(), JSON.stringify({ pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch { return holder()?.pid === pid; }
}

export function releaseLock(pid = process.pid) {
  if (holder()?.pid === pid) { try { fs.unlinkSync(LOCK()); } catch { /* gone */ } }
}

/* -------------------------------- tick ---------------------------------- */

/**
 * One pass over every schedule. `deps` keeps this free of the server:
 *   start(schedule)    → { runId } or throws
 *   isActive(runId)    → whether that run is still going
 *   spentToday()       → dollars spent today by scheduled runs
 *   dailyLimit         → the shared daily ceiling for scheduled runs
 * Returns what happened, for logging and tests.
 */
export async function tick(deps, now = Date.now()) {
  const all = listSchedules();
  const events = [];
  let changed = false;
  for (const s of all) {
    if (!s.enabled || now < s.nextDueAt) continue;
    changed = true;
    const late = now - s.nextDueAt;
    if (late > GRACE_MS) {
      const n = countWindows(s.rule, s.nextDueAt, now, s.anchorAt);
      s.missed += n;
      s.lastMissedAt = new Date(now).toISOString();
      s.nextDueAt = nextAfter(s.rule, now, s.anchorAt);
      events.push({ id: s.id, kind: 'missed', count: n });
      continue;
    }
    s.nextDueAt = nextAfter(s.rule, now, s.anchorAt);
    s.lastFiredAt = new Date(now).toISOString();
    if (s.lastRunId && deps.isActive(s.lastRunId)) {
      s.lastStatus = 'skipped — the previous run was still going';
      events.push({ id: s.id, kind: 'skipped', reason: 'busy' });
      continue;
    }
    const spent = deps.spentToday();
    if (spent >= deps.dailyLimit) {
      s.lastStatus = `skipped — scheduled runs reached today's $${deps.dailyLimit.toFixed(2)} limit`;
      events.push({ id: s.id, kind: 'skipped', reason: 'budget' });
      continue;
    }
    try {
      const run = await deps.start(s);
      s.lastRunId = run.runId;
      s.lastStatus = 'started';
      s.fired += 1;
      events.push({ id: s.id, kind: 'fired', runId: run.runId });
    } catch (e) {
      s.lastStatus = `could not start — ${e.message}`;
      events.push({ id: s.id, kind: 'error', error: e.message });
    }
  }
  if (changed) {
    // Merge rather than overwrite: a schedule added or deleted while `start`
    // was awaited must survive this write.
    const fresh = listSchedules();
    const mine = Object.fromEntries(all.map((s) => [s.id, s]));
    save(fresh.map((s) => mine[s.id] ? { ...s, ...pick(mine[s.id]) } : s));
  }
  return events;
}

function pick(s) {
  const { nextDueAt, lastFiredAt, lastRunId, lastStatus, missed, lastMissedAt, fired } = s;
  return { nextDueAt, lastFiredAt, lastRunId, lastStatus, missed, lastMissedAt, fired };
}
