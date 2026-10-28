/*
 * Signed share links.
 *
 * A token is `<sessionId>.<exp>.<hex-hmac>` where `exp` is a unix millis
 * expiration. The HMAC is SHA-256 over `<sessionId>.<exp>` with a secret
 * stored at ~/.orderly-claude/share.key (generated on first use).
 *
 * The signed URL opens a static, self-contained HTML export of the session:
 * every turn, every tool step, every screenshot inlined as base64 so the
 * page needs no fetches. The export never touches the live server once
 * generated, so a shared link survives the server going down.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.mjs';

const KEY_FILE = path.join(DATA_DIR, 'share.key');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week

function key() {
  try { return fs.readFileSync(KEY_FILE); } catch {}
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, buf, { mode: 0o600 });
  return buf;
}

function sign(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('hex');
}

export function generateToken(sessionId, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const exp = Date.now() + ttlMs;
  const payload = `${sessionId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns { sessionId, exp } if the token is valid and unexpired, else null. */
export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, expStr, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${sessionId}.${exp}`);
  // Constant-time compare so a timing attack cannot forge a token.
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { sessionId, exp };
}

/**
 * Build a self-contained HTML bundle for a session. Shots are inlined so the
 * file works without the server. Turns and steps are rendered as a plain,
 * accessible timeline — the goal is "a reader opens this and understands what
 * happened", not "pixel parity with the viewer".
 */
export function exportSessionHtml({ session, meta, sessionId, shotsDir }) {
  const title = esc(meta?.title || session?.title || 'Claude Code session');
  const cwd = esc(meta?.cwd || session?.cwd || '');
  const when = esc(session?.turns?.[0]?.promptAt?.slice(0, 10) || '');
  const turns = (session?.turns || []).map((t) => renderTurn(t, sessionId, shotsDir)).join('\n');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Orderly Claude export</title>
<style>${CSS}</style>
</head><body>
<header>
  <div class="brand">◇ Orderly / <em>shared session</em></div>
  <h1>${title}</h1>
  <div class="meta">${cwd ? `<code>${cwd}</code> · ` : ''}${when}</div>
</header>
<main>${turns || '<div class="empty">Nothing in this session yet.</div>'}</main>
<footer>Exported ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · This page runs without the Orderly server.</footer>
</body></html>`;
}

function renderTurn(turn, sessionId, shotsDir) {
  const prompt = turn.prompt ? `<div class="turn-prompt"><div class="who">You</div><p>${esc(turn.prompt)}</p></div>` : '';
  const steps = (turn.steps || []).map((s) => renderStep(s, sessionId, shotsDir)).join('');
  const body = turn.intro ? `<p class="intro">${esc(turn.intro)}</p>` : '';
  const summary = turn.summary ? `<p class="summary">${esc(turn.summary)}</p>` : '';
  if (!prompt && !body && !steps && !summary) return '';
  return `<section class="turn">${prompt}
    <div class="turn-body"><div class="who">Claude</div>${body}<div class="steps">${steps}</div>${summary}</div></section>`;
}

function renderStep(step, sessionId, shotsDir) {
  const bits = [];
  if (step.callCount > 1) bits.push(`${step.callCount} commands`);
  if (step.fileCount) bits.push(`${step.fileCount} file${step.fileCount > 1 ? 's' : ''}`);
  const sub = bits.length ? `<span class="sub">${bits.join(' · ')}</span>` : '';
  const shot = inlineShotPair(step, sessionId, shotsDir);
  return `<div class="step tone-${step.status || 'done'}">
    <div class="row"><span class="label">${esc(step.label || '')}</span>${sub}</div>
    ${shot}
  </div>`;
}

function inlineShotPair(step, sessionId, shotsDir) {
  if (!step.hasShots) return '';
  const sides = ['before', 'after'];
  const parts = [];
  for (const w of sides) {
    const file = path.join(shotsDir, sessionId, `${step.id}-${w}.png`);
    if (!fs.existsSync(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      parts.push(`<figure><img alt="${w}" src="data:image/png;base64,${buf.toString('base64')}"><figcaption>${w}</figcaption></figure>`);
    } catch {}
  }
  return parts.length ? `<div class="shots">${parts.join('')}</div>` : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root { --bg: #0e1013; --raised: #15181c; --text: #f3f1ec; --mute: #a1a7af; --faint: #6a6e75;
  --accent: #a3abff; --edge: #ffffff14; --mono: ui-monospace, Menlo, monospace;
  --sans: -apple-system, "Segoe UI", Inter, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
header { padding: 32px 48px 16px; border-bottom: 1px solid var(--edge); }
.brand { font: 12px var(--mono); color: var(--faint); letter-spacing: 0.08em; margin-bottom: 10px; }
.brand em { color: var(--accent); font-style: normal; }
h1 { margin: 0 0 6px; font: 500 32px/1.1 var(--sans); letter-spacing: -0.015em; }
.meta { color: var(--mute); font-size: 13px; }
.meta code { font: 11.5px var(--mono); color: var(--faint); }
main { max-width: 920px; margin: 0 auto; padding: 32px 48px 80px; }
.turn { margin-bottom: 28px; }
.turn-prompt { background: var(--raised); border: 1px solid var(--edge); border-radius: 10px; padding: 14px 18px; margin-bottom: 10px; }
.turn-prompt p { margin: 4px 0 0; white-space: pre-wrap; }
.turn-body { border-left: 2px solid var(--edge); padding: 2px 0 2px 16px; margin-left: 10px; }
.who { font: 11px var(--mono); color: var(--faint); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
.intro, .summary { margin: 0 0 12px; color: var(--mute); }
.summary { color: var(--text); }
.steps { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.step { background: var(--raised); border: 1px solid var(--edge); border-radius: 8px; padding: 10px 14px; }
.step .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 14px; }
.step .label { font-weight: 500; }
.step .sub { color: var(--faint); font: 11px var(--mono); }
.step.tone-warn  { border-color: #ef7d9b60; }
.step.tone-fix   { border-color: #efb36c60; }
.step.tone-ask   { border-color: #82c1ee60; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.shots figure { margin: 0; }
.shots img { width: 100%; height: auto; border: 1px solid var(--edge); border-radius: 6px; display: block; }
.shots figcaption { font: 10.5px var(--mono); color: var(--faint); margin-top: 4px; text-align: center; }
footer { max-width: 920px; margin: 0 auto; padding: 20px 48px 48px; color: var(--faint); font: 11.5px var(--mono); }
`;
