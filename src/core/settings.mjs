/*
 * Settings that belong to the person, not to any one workflow.
 *
 * Today that is money. A run started by hand has someone watching it, so its
 * ceiling is off unless they set one. A scheduled run may fire while nobody is
 * looking, so scheduled runs always carry a per-run limit (on the schedule)
 * and share a daily one (here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

// Per call, so the test suite can use a disposable file.
const FILE = () => process.env.ORDERLY_SETTINGS_FILE || path.join(DATA_DIR, 'settings.json');

export const DEFAULTS = Object.freeze({
  budget: { perRunUsd: null, scheduledPerDayUsd: 5 },
  concurrency: 4,
});

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

export function readSettings() {
  const s = read();
  return {
    budget: { ...DEFAULTS.budget, ...(s.budget || {}) },
    concurrency: Number.isInteger(s.concurrency) && s.concurrency > 0 ? s.concurrency : DEFAULTS.concurrency,
  };
}

/** A money field: a positive number, or null for "no limit". */
function money(v, name) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive amount, or empty for no limit`);
  return Math.round(n * 100) / 100;
}

export function writeSettings(patch = {}) {
  const cur = readSettings();
  const next = { ...cur, budget: { ...cur.budget } };
  if (patch.budget) {
    if ('perRunUsd' in patch.budget) next.budget.perRunUsd = money(patch.budget.perRunUsd, 'Per-run limit');
    if ('scheduledPerDayUsd' in patch.budget) {
      const v = money(patch.budget.scheduledPerDayUsd, 'Daily limit for scheduled runs');
      // Scheduled runs never go without a daily limit; that is the condition
      // schedules exist on at all.
      if (v === null) throw new Error('Scheduled runs need a daily limit');
      next.budget.scheduledPerDayUsd = v;
    }
  }
  if ('concurrency' in patch) {
    const c = Number(patch.concurrency);
    if (!Number.isInteger(c) || c < 1 || c > 16) throw new Error('Concurrency must be a whole number from 1 to 16');
    next.concurrency = c;
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE());
  return next;
}

/** Total recorded spend across a run's nodes. */
export function runSpend(run) {
  let total = 0;
  for (const n of run?.graph?.nodes || []) {
    // A loop rolls its items' cost up into its own meta, so one field per
    // node is the whole story.
    const c = n.output?.meta?.cost;
    if (typeof c === 'number' && Number.isFinite(c)) total += c;
  }
  return total;
}
