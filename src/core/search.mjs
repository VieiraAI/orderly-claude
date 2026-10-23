/** Flat searchable index over prompts, steps, command detail and images. */
export function indexSession(session, { sessionId, title } = {}) {
  const entries = [];
  const push = (e) => entries.push({ sessionId, sessionTitle: title, ...e });

  for (const t of session.turns || []) {
    if (t.prompt) push({ kind: 'prompt', turnId: t.id, text: t.prompt, at: t.promptAt });
    if (t.summary) push({ kind: 'summary', turnId: t.id, text: t.summary, at: t.promptAt });
    for (const s of t.steps) {
      push({ kind: 'step', turnId: t.id, stepId: s.id, text: s.label, status: s.status, at: s.startedAt });
      for (const c of s.calls) {
        const detail = [c.input?.command, c.input?.description, c.input?.file_path, c.input?.pattern, c.input?.query]
          .filter(Boolean).join(' · ');
        if (detail) push({ kind: 'detail', turnId: t.id, stepId: s.id, text: detail, tool: c.tool, at: c.at });
      }
      if (s.shots?.after) push({ kind: 'image', turnId: t.id, stepId: s.id, text: `screenshot — ${s.label}`, at: s.endedAt });
    }
  }
  return entries;
}

export function search(entries, query, { limit = 80 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const e of entries) {
    const hay = String(e.text || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      const i = hay.indexOf(term);
      if (i === -1) { score = 0; break; }
      score += 10;
      if (i === 0) score += 5;
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)) score += 3;
    }
    if (!score) continue;
    if (e.kind === 'prompt') score += 12;   // prompts rank high: reusing them is the point
    if (e.kind === 'step') score += 6;
    if (e.kind === 'image') score += 4;
    scored.push({ ...e, score, snippet: snippet(e.text, terms[0]) });
  }
  scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  return scored.slice(0, limit);
}

function snippet(text = '', term = '', pad = 70) {
  const i = String(text).toLowerCase().indexOf(term);
  if (i === -1) return String(text).slice(0, pad * 2);
  const start = Math.max(0, i - pad);
  return (start > 0 ? '…' : '') + String(text).slice(start, i + term.length + pad) +
    (i + term.length + pad < text.length ? '…' : '');
}
