/*
 * References — how one node names what another produced.
 *
 *   {{inputs.key}}               a value the person typed when starting the run
 *   {{nodes.ID.output}}          everything node ID produced, as readable text
 *   {{nodes.ID.output.a.b}}      one field of it
 *   {{nodes.*.output}}           every direct parent, which is what a node got
 *                                implicitly before references existed
 *   {{item}}, {{item.field}}     the current element inside a loop
 *
 * A node whose text names any `nodes.` reference is in explicit mode: it gets
 * exactly what it asked for and nothing else. A node that names none keeps the
 * old behaviour of seeing all its parents, so existing workflows run unchanged.
 *
 * Values substituted into a shell command are single-quoted. Without that, a
 * model's output becomes a command line — `{{nodes.review.output}}` containing
 * `$(rm -rf ~)` would run it.
 */

const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Every `{{...}}` in `text`, parsed. Unknown shapes come back as kind 'other'. */
export function parseRefs(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(REF_RE)) {
    const raw = m[0];
    const parts = m[1].split('.').map((s) => s.trim()).filter(Boolean);
    const head = parts[0];
    if (head === 'inputs' && parts[1]) {
      out.push({ raw, kind: 'inputs', key: parts.slice(1).join('.') });
    } else if (head === 'nodes' && parts[1]) {
      // `nodes.ID` alone means its output, so a typo of omission still works.
      const rest = parts[2] === 'output' ? parts.slice(3) : parts.slice(2);
      out.push({ raw, kind: 'nodes', nodeId: parts[1], path: rest });
    } else if (head === 'item') {
      out.push({ raw, kind: 'item', path: parts.slice(1) });
    } else {
      out.push({ raw, kind: 'other', path: parts });
    }
  }
  return out;
}

/** Node ids a piece of text depends on, `*` excluded. */
export function referencedNodes(text) {
  return new Set(parseRefs(text)
    .filter((r) => r.kind === 'nodes' && r.nodeId !== '*')
    .map((r) => r.nodeId));
}

/** True when the text chooses its own upstream context. */
export function isExplicit(text) {
  return parseRefs(text).some((r) => r.kind === 'nodes');
}

/** Single-quote for POSIX sh: close, escape, reopen. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Readable text for a node's output — the same rendering a parent's output has
 * always had when pasted into a child's prompt.
 */
export function outputText(output) {
  const o = output || {};
  if (typeof o === 'string') return o;
  if (o.body)     return String(o.body);
  if (o.text)     return String(o.text);
  if (o.html)     return String(o.html);
  if (o.out)      return String(o.out);
  if (o.findings) return o.findings.map((f) => `- ${f.tag}: ${f.text}`).join('\n');
  if (o.answer !== undefined) return String(o.answer);
  if (o.data !== undefined) return typeof o.data === 'string' ? o.data : JSON.stringify(o.data, null, 2);
  if (o.results)  return o.results.map((r) => r.text ?? r.out ?? JSON.stringify(r)).join('\n\n');
  if (o.values)   return Object.entries(o.values).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (o.hunks)    return `${o.file || ''}: ${o.hunks.length} hunk(s)`;
  if (o.title)    return String(o.title);
  return '';
}

function walk(value, path) {
  let v = value;
  for (const seg of path) {
    if (v == null) return undefined;
    v = v[seg];
  }
  return v;
}

function render(value, { wholeOutput = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (wholeOutput) return outputText(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/** Direct parents of a node, in edge order. */
export function parentsOf(nodeId, graph) {
  const byId = Object.fromEntries((graph?.nodes || []).map((n) => [n.id, n]));
  return (graph?.edges || [])
    .filter((e) => e[1] === nodeId)
    .map((e) => byId[e[0]])
    .filter(Boolean);
}

/**
 * Substitute references in `text`. Returns the text and the references that
 * had nothing to resolve to, so a caller can say which one was empty rather
 * than sending a prompt with a hole in it.
 *
 *   mode 'text'  — values go in as they are (prompts, questions, paths)
 *   mode 'shell' — every value is single-quoted
 */
export function resolveText(text, { run, nodeId = null, item, mode = 'text' } = {}) {
  const missing = [];
  const graph = run?.graph || { nodes: [], edges: [] };
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const out = String(text ?? '').replace(REF_RE, (raw, inner) => {
    const [ref] = parseRefs(raw);
    let value;
    if (ref.kind === 'inputs') {
      value = render(walk(run?.inputs || {}, ref.key.split('.')));
    } else if (ref.kind === 'item') {
      value = item === undefined ? undefined : render(walk(item, ref.path));
    } else if (ref.kind === 'nodes' && ref.nodeId === '*') {
      const parents = nodeId ? parentsOf(nodeId, graph) : [];
      const chunks = parents
        .filter((p) => p.output)
        .map((p) => `### ${p.title || p.id}\n${outputText(p.output)}`);
      value = chunks.length ? chunks.join('\n\n') : undefined;
    } else if (ref.kind === 'nodes') {
      const target = byId[ref.nodeId];
      value = target?.output == null ? undefined
        : render(ref.path.length ? walk(target.output, ref.path) : target.output,
          { wholeOutput: ref.path.length === 0 });
    } else {
      // Not ours — leave it for whoever wrote it, e.g. a template language
      // inside a mockup prompt.
      return raw;
    }
    if (value === undefined || value === '') { missing.push(raw); value = ''; }
    return mode === 'shell' ? shellQuote(value) : value;
  });
  return { text: out, missing };
}

/** Every node upstream of `nodeId`. */
export function ancestorsOf(nodeId, graph) {
  const parents = {};
  for (const n of graph?.nodes || []) parents[n.id] = [];
  for (const e of graph?.edges || []) if (parents[e[1]]) parents[e[1]].push(e[0]);
  const seen = new Set();
  const stack = [...(parents[nodeId] || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents[id] || []));
  }
  return seen;
}

/** The text fields on a node that may carry references, by kind. */
export function referenceFields(node) {
  const s = node?.spec || {};
  const fields = [];
  const add = (key, value, mode = 'text') => { if (typeof value === 'string' && value) fields.push({ key, value, mode }); };
  add('prompt', s.prompt ?? node?.prompt);
  add('cmd', s.cmd ?? node?.command, 'shell');
  add('question', s.question ?? node?.question);
  add('path', s.path);
  add('content', s.content);
  if (typeof s.over === 'string') add('over', s.over);
  if (s.assert?.needle) add('assert.needle', s.assert.needle);
  return fields;
}
