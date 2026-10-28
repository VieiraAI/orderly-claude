/*
 * Prompts — named templates you can send into a session.
 *
 * One Markdown file per prompt, with frontmatter and a body:
 *
 *   ---
 *   name: Review the current diff
 *   description: Surface the top findings
 *   category: review
 *   inputs:
 *     - key: focus
 *       label: Focus area
 *       placeholder: security, performance, naming
 *   ---
 *   Review the current git diff. Focus on {{focus|anything that stands out}}.
 *   Report top three findings with file:line references.
 *
 * Discovery mirrors workflows and skills: every repo the sessions index knows
 * about contributes its `.claude/prompts/` folder, plus the global
 * ~/.claude/prompts/. Project > user ordering so a repo-local prompt wins.
 *
 * Interpolation: {{key}} or {{key|default}} is replaced from `inputs`.
 * Unknown or empty keys fall back to the default (or empty string if none).
 */
import fs from 'node:fs';
import path from 'node:path';
import { USER_PROMPTS_DIR, repoPromptsDir } from './paths.mjs';
import { knownRepoRoots } from './workflows.mjs';

export function listPrompts() {
  const out = [];
  for (const root of knownRepoRoots()) {
    out.push(...readRoot(repoPromptsDir(root), 'project', root));
  }
  out.push(...readRoot(USER_PROMPTS_DIR, 'user', null));
  return out;
}

export function getPrompt(id) {
  return listPrompts().find((p) => p.id === id) || null;
}

/** Replace {{key}} and {{key|default}} with values from `inputs`. */
export function interpolate(body, inputs = {}) {
  return String(body || '').replace(/\{\{([^}|]+?)(?:\|([^}]*))?\}\}/g, (_m, key, def) => {
    const k = key.trim();
    const v = inputs[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    return def !== undefined ? def : '';
  });
}

function readRoot(root, scope, repoRoot) {
  if (!fs.existsSync(root)) return [];
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(root, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { front, body } = split(text);
    const slug = name.replace(/\.md$/, '');
    out.push({
      id: `${scope}:${repoRoot || 'global'}:${slug}`,
      slug,
      scope,
      repoRoot:  repoRoot || null,
      repoName:  repoRoot ? path.basename(repoRoot) : null,
      path:      file,
      name:        front.name        || slug,
      title:       front.title       || front.name || slug,
      description: front.description || '',
      category:    front.category    || 'build',
      inputs:  Array.isArray(front.inputs) ? front.inputs : [],
      body: body.trim(),
    });
  }
  out.sort((a, b) => (a.title || a.slug).localeCompare(b.title || b.slug));
  return out;
}

/** Split a .md file into { front, body }. Front is parsed with the same small
 *  YAML reader as skills — nested `inputs:` arrays supported. */
function split(text) {
  if (!text.startsWith('---')) return { front: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { front: {}, body: text };
  const front = parseFront(text.slice(4, end));
  const body = text.slice(end + 4);
  return { front, body };
}

function parseFront(src) {
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent !== 0) { i++; continue; } // top-level only
    const colon = line.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (key === 'inputs' && !rest) {
      const [arr, used] = parseInputsArray(lines, i + 1);
      out.inputs = arr;
      i += 1 + used;
      continue;
    }
    const block = /^([|>])[-+]?\s*$/.exec(rest);
    if (block) {
      const [folded, used] = readBlock(lines, i + 1, 0, block[1] === '>');
      out[key] = folded;
      i += 1 + used;
      continue;
    }
    out[key] = unquote(rest);
    i++;
  }
  return out;
}

function parseInputsArray(lines, start) {
  const items = [];
  let i = start;
  let cur = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent === 0) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      cur = {};
      items.push(cur);
      const after = trimmed.slice(2).trim();
      if (after) {
        const c = after.indexOf(':');
        if (c > 0) cur[after.slice(0, c).trim()] = unquote(after.slice(c + 1).trim());
      }
    } else if (cur) {
      const c = trimmed.indexOf(':');
      if (c > 0) cur[trimmed.slice(0, c).trim()] = unquote(trimmed.slice(c + 1).trim());
    }
    i++;
  }
  return [items, i - start];
}

function readBlock(lines, start, parentIndent, fold) {
  const out = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { out.push(''); i++; continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= parentIndent) break;
    out.push(line.trim());
    i++;
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return [fold ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n'), i - start];
}

function unquote(v) {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}
