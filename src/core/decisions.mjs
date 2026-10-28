/*
 * Decisions — the moments a session committed to a direction.
 *
 * Two sources, merged chronologically:
 *   auto   — every `ask` node across every known run whose user answer landed
 *   marked — any session step a user flagged in the viewer
 *
 * Marks persist to ~/.orderly-claude/decisions.json. The file is a flat list
 * of { sessionId, stepId, note, at } rows; one row per mark. Auto-extracted
 * entries are never written here, since the run file is already the source
 * of truth for ask-node answers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';
import { listRuns } from './workflows.mjs';

const FILE = path.join(DATA_DIR, 'decisions.json');

export function listDecisions({ limit = 400 } = {}) {
  const out = [...autoDecisions(), ...readMarks()];
  out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return out.slice(0, limit);
}

export function markDecision({ sessionId, stepId, note = '' }) {
  if (!sessionId || !stepId) throw new Error('sessionId and stepId required');
  const marks = readMarks();
  const existing = marks.find((m) => m.sessionId === sessionId && m.stepId === stepId);
  const at = new Date().toISOString();
  if (existing) { existing.note = note; existing.at = at; }
  else marks.push({ kind: 'marked', sessionId, stepId, note, at });
  writeMarks(marks);
  return existing || marks[marks.length - 1];
}

export function unmarkDecision({ sessionId, stepId }) {
  const marks = readMarks().filter((m) => !(m.sessionId === sessionId && m.stepId === stepId));
  writeMarks(marks);
  return true;
}

function autoDecisions() {
  const out = [];
  for (const run of listRuns({ limit: 400 })) {
    for (const n of run.graph?.nodes || []) {
      if (n.kind !== 'ask' || !n.output?.answer) continue;
      out.push({
        kind: 'auto',
        at: n.endedAt || n.startedAt || run.startedAt,
        sessionId: run.sessionId || null,
        runId: run.runId,
        workflowTitle: run.workflowTitle,
        nodeId: n.id,
        question: n.output.question || n.title,
        answer:   n.output.answer,
      });
    }
  }
  return out;
}

function readMarks() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}
function writeMarks(marks) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(marks, null, 2));
}
