/*
 * Lightweight workflow suggester.
 *
 * Given a free-text query and the current workflow catalog, score each def by
 * token overlap with its searchable surface (title + whenToUse + tags + id).
 * No model call; no embeddings; no network. Fast enough to run on every
 * keystroke. A later pass can promote this to a Haiku call for ambiguous
 * queries, but the ranked overlap gets most of the way.
 */

const STOP = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'if', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'this', 'to', 'us',
  'we', 'will', 'with', 'you', 'your',
  // Words almost any ask contains; matching on them alone is noise.
  'make', 'do', 'want', 'need', 'get', 'help', 'please', 'can', 'could', 'would',
  'should', 'some', 'thing', 'things', 'new', 'like', 'just', 'all', 'any',
]);

/** Lowercase + split on non-letter/digit, drop short + stop words. */
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length >= 2 && !STOP.has(t));
}

/** The haystack for a def: its id, title, description, whenToUse, tags, category. */
export function defSurface(def) {
  const parts = [
    def.id,
    def.title,
    def.desc,
    def.whenToUse,
    ...(Array.isArray(def.tags) ? def.tags : []),
    def.category,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Return a score in [0, 1] for a query against a def's surface. The score is
 * the fraction of query tokens that appear in the def's token set, nudged up
 * when a token matches the title (where intent is strongest) or an exact tag.
 */
export function scoreDef(query, def) {
  const qt = tokenize(query);
  if (!qt.length) return { score: 0, reasons: [] };
  const titleTokens = new Set(tokenize(def.title));
  const tagTokens = new Set((Array.isArray(def.tags) ? def.tags : []).flatMap(tokenize));
  const haystack = new Set(tokenize(defSurface(def)));
  const reasons = [];
  let hits = 0, titleHits = 0, tagHits = 0;
  for (const t of qt) {
    if (!haystack.has(t)) continue;
    hits++;
    if (titleTokens.has(t)) titleHits++;
    if (tagTokens.has(t)) tagHits++;
  }
  const base = hits / qt.length;
  const bonus = (titleHits * 0.15) + (tagHits * 0.1);
  const score = Math.min(1, base + bonus);
  if (titleHits) reasons.push(`title match (${titleHits})`);
  if (tagHits) reasons.push(`tag match (${tagHits})`);
  if (!titleHits && !tagHits && hits) reasons.push(`description match (${hits})`);
  return { score: Number(score.toFixed(2)), reasons };
}

/**
 * Suggest matching defs. Returns at most `limit` matches with score ≥ `min`,
 * highest first. Ties break by score; subsequent ties go to the shorter id.
 */
export function suggestWorkflows({ query, defs, limit = 5, min = 0.2 }) {
  const scored = defs.map((d) => ({ def: d, ...scoreDef(query, d) }))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score || a.def.id.length - b.def.id.length);
  return scored.slice(0, limit).map((s) => ({
    id: s.def.id,
    // Which workflow this is, when the same id lives in two repos.
    key: s.def.key || null,
    title: s.def.title,
    score: s.score,
    reason: s.reasons.join(', ') || 'weak match',
  }));
}
