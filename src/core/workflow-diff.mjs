/*
 * What changed between two versions of a workflow, in terms a person reads:
 * which steps were added, removed or changed (and which of their settings),
 * which connections and inputs moved, and which workflow settings changed.
 *
 * Layout (a step's col and row) is not a change: moving a card does not
 * change what runs, and a proposal that only re-tidied the canvas should
 * not ask anyone to review it.
 */

const LAYOUT = new Set(['col', 'row']);
const SETTINGS = ['title', 'desc', 'category', 'estimate', 'budgetUsd', 'concurrency', 'whenToUse', 'tags'];

/** Readable names for the spec fields people actually edit. */
const FIELD = {
  prompt: 'instructions', model: 'model', output: 'what it produces', cmd: 'command', op: 'what it does',
  question: 'question', options: 'choices', target: 'where it goes', path: 'file', content: 'what goes in it',
  over: 'list it repeats over', action: 'what it does for each', max: 'item limit', concurrency: 'items at once',
  wait: 'wait', render: 'how it shows', from: 'what it shows', fields: 'fields', assert: 'what it checks',
  onFail: 'what happens if it fails', retry: 'retries', timeoutMs: 'time limit', idempotent: 'safe to run twice',
  allowFailure: 'keep going on failure', show: 'pictures it shows', uses: 'skills', verify: 'checks on its result',
};

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changedFields(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (LAYOUT.has(k) || k === 'spec') continue;
    if (!same(a[k], b[k])) out.push({ key: k, label: { title: 'name', kind: 'kind', cost: 'card weight' }[k] || k, from: a[k], to: b[k] });
  }
  const sa = a?.spec || {}, sb = b?.spec || {};
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (!same(sa[k], sb[k])) out.push({ key: `spec.${k}`, label: FIELD[k] || k, from: sa[k], to: sb[k] });
  }
  return out;
}

const edgeKey = (e) => `${e[0]}→${e[1]}${e[2] ? `#${e[2]}` : ''}`;

export function diffWorkflows(before, after) {
  const bn = new Map((before?.graph?.nodes || []).map((n) => [n.id, n]));
  const an = new Map((after?.graph?.nodes || []).map((n) => [n.id, n]));
  const steps = { added: [], removed: [], changed: [] };
  for (const [id, n] of an) {
    if (!bn.has(id)) steps.added.push({ id, title: n.title || id, kind: n.kind });
    else {
      const fields = changedFields(bn.get(id), n);
      if (fields.length) steps.changed.push({ id, title: n.title || id, kind: n.kind, fields });
    }
  }
  for (const [id, n] of bn) if (!an.has(id)) steps.removed.push({ id, title: n.title || id, kind: n.kind });

  const be = new Set((before?.graph?.edges || []).map(edgeKey));
  const ae = new Set((after?.graph?.edges || []).map(edgeKey));
  const edges = {
    added: (after?.graph?.edges || []).filter((e) => !be.has(edgeKey(e))),
    removed: (before?.graph?.edges || []).filter((e) => !ae.has(edgeKey(e))),
  };

  const bi = new Map((before?.inputs || []).map((f) => [f.key, f]));
  const ai = new Map((after?.inputs || []).map((f) => [f.key, f]));
  const inputs = {
    added: [...ai.keys()].filter((k) => !bi.has(k)),
    removed: [...bi.keys()].filter((k) => !ai.has(k)),
    changed: [...ai.keys()].filter((k) => bi.has(k) && !same(bi.get(k), ai.get(k))),
  };

  const settings = SETTINGS.filter((k) => !same(before?.[k], after?.[k]))
    .map((k) => ({ key: k, from: before?.[k] ?? null, to: after?.[k] ?? null }));

  const empty = !steps.added.length && !steps.removed.length && !steps.changed.length
    && !edges.added.length && !edges.removed.length
    && !inputs.added.length && !inputs.removed.length && !inputs.changed.length && !settings.length;
  return { empty, steps, edges, inputs, settings };
}

/** One line per change, for a summary a person can scan. */
export function describeDiff(d) {
  const lines = [];
  for (const s of d.steps.added) lines.push({ kind: 'added', text: `Added “${s.title}”` });
  for (const s of d.steps.changed) lines.push({ kind: 'changed', text: `Changed “${s.title}”: ${[...new Set(s.fields.map((f) => f.label))].join(', ')}` });
  for (const s of d.steps.removed) lines.push({ kind: 'removed', text: `Removed “${s.title}”` });
  const ea = d.edges.added.length, er = d.edges.removed.length;
  if (ea || er) lines.push({ kind: 'changed', text: `Connections: ${[ea && `${ea} added`, er && `${er} removed`].filter(Boolean).join(', ')}` });
  if (d.inputs.added.length) lines.push({ kind: 'added', text: `New input${d.inputs.added.length > 1 ? 's' : ''}: ${d.inputs.added.join(', ')}` });
  if (d.inputs.changed.length) lines.push({ kind: 'changed', text: `Changed input${d.inputs.changed.length > 1 ? 's' : ''}: ${d.inputs.changed.join(', ')}` });
  if (d.inputs.removed.length) lines.push({ kind: 'removed', text: `Removed input${d.inputs.removed.length > 1 ? 's' : ''}: ${d.inputs.removed.join(', ')}` });
  const NAME = { title: 'Name', desc: 'Description', category: 'Kind of work', estimate: 'Takes about', budgetUsd: 'Spend limit', concurrency: 'Steps at once', whenToUse: 'When to use it', tags: 'Tags' };
  for (const s of d.settings) {
    const fmt = (v) => (v == null || v === '' ? 'none' : s.key === 'budgetUsd' ? `$${v}` : Array.isArray(v) ? v.join(', ') : String(v));
    lines.push({ kind: 'changed', text: s.key === 'desc' || s.key === 'whenToUse' ? `${NAME[s.key]} rewritten` : `${NAME[s.key]}: ${fmt(s.from)} → ${fmt(s.to)}` });
  }
  return lines;
}
