/*
 * Skills — the small, named pieces of guidance Claude Code reads from the
 * two `.claude/skills/` roots. Each skill is one folder with a SKILL.md whose
 * frontmatter carries at least a name and description. Everything else is
 * optional; this reader is tolerant of hand-written files.
 *
 * Scope ordering mirrors the workflow catalog:
 *   project — <repo>/.claude/skills (only when a repoRoot is passed)
 *   user    — ~/.claude/skills
 *
 * No Claude Code builtins are enumerated here; those are hard-wired into the
 * harness, not files on disk you can browse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { USER_SKILLS_DIR, repoSkillsDir } from './paths.mjs';

export function listSkills({ repoRoot } = {}) {
  const out = [];
  if (repoRoot) out.push(...readRoot(repoSkillsDir(repoRoot), 'project'));
  out.push(...readRoot(USER_SKILLS_DIR, 'user'));
  return out;
}

function readRoot(root, scope) {
  if (!fs.existsSync(root)) return [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of dirs) {
    if (!e.isDirectory()) continue;
    const skillPath = path.join(root, e.name);
    const mdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    const parsed = readSkillMd(mdPath);
    out.push({
      id:          `${scope}:${e.name}`,
      slug:        e.name,
      scope,
      scopeRoot:   root,
      path:        skillPath,
      name:        parsed.name || e.name,
      description: parsed.description || '',
      category:    categorize(parsed.name || e.name, parsed.description || ''),
      author:      parsed.author || null,
      version:     parsed.version || null,
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/*
 * Minimal YAML frontmatter reader — handles the fields we care about and
 * the two block scalars authors reach for:
 *   description: >    folded, newlines → spaces
 *   description: |    literal, newlines kept
 * Everything else is read as a plain scalar on the key line.
 */
function readSkillMd(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const lines = text.slice(4, end).split('\n').map((l) => l.replace(/\r$/, ''));

  const fields = {};
  const sub = {};
  let i = 0;
  let inMetadata = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) { i++; continue; }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();

    if (indent === 0) {
      inMetadata = key === 'metadata' && !value;
      if (value === '>' || value === '|') {
        const [folded, used] = readBlockScalar(lines, i + 1, indent, value === '>');
        fields[key] = folded;
        i += 1 + used;
      } else {
        fields[key] = unquote(value);
        i++;
      }
    } else if (inMetadata) {
      sub[key] = unquote(value);
      i++;
    } else {
      i++;
    }
  }
  return {
    name:        fields.name,
    description: fields.description,
    author:      sub.author,
    version:     sub.version,
  };
}

function readBlockScalar(lines, start, parentIndent, fold) {
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
  const used = i - start;
  // Strip trailing empties, then fold or join literal.
  while (out.length && !out[out.length - 1]) out.pop();
  return [fold ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n'), used];
}

function unquote(v) {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/* A keyword-based colour category. The frontmatter doesn't carry one, so we
 * match on the slug — stable, concise, usually names the skill's job — and
 * fall back to the description. Rules match whole words to avoid "design"
 * swallowing any description that mentions the word "design". */
const CAT_RULES = [
  ['design',  /\b(design|logo|brand|banner|icon|palette|color|dataviz|motion|slide|theme|canvas|art|styling|poster|frontend|ui|mockup|redesign)\b/i],
  ['review',  /\b(review|audit|lint|quality|security|perf|grill|discernment|critique|a11y)\b/i],
  ['ship',    /\b(ship|deploy|release|pr|merge|wizard|rollout|changelog)\b/i],
  ['plan',    /\b(plan|spec|roadmap|clarify|architect|domain|constraints|interview|idea)\b/i],
  ['content', /\b(write|writing|docs|comms|coauthor|blog|internal|copy|academy|guide|research|tdd|test|debug)\b/i],
  ['io',      /\b(scrape|fetch|reach|mcp|browser|chrome|automation|xlsx|docx|pptx|pdf|upload|download|slack|export|import)\b/i],
];
function categorize(name, desc) {
  // Try the slug/name alone first — it's the cleanest signal.
  for (const [cat, re] of CAT_RULES) if (re.test(name || '')) return cat;
  // Then the first sentence of the description, which usually states purpose.
  const headline = String(desc || '').split(/[.!?]/)[0];
  for (const [cat, re] of CAT_RULES) if (re.test(headline)) return cat;
  return 'build';
}
