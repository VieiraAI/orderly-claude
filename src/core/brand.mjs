/*
 * Brand pack loader + assert primitives.
 *
 * A brand.json lives at <repo>/.claude/brand.json. It names the project's
 * palette, fonts, spacing scale, radii, and minimum contrast. Check nodes
 * read these to turn "stay on brand" from a reviewer memory test into a
 * machine-checked rule.
 *
 * The primitives here (colorsInPalette, fontIsBrand, contrastRatio,
 * spacingOnScale, scanRawHex) operate on plain inputs so they're easy to
 * unit-test and reuse from both the Check handler and Agent spec.verify.
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE = new Map();

/** Load brand.json for a repo. Returns the loaded object or a safe default. */
export function loadBrand(repoRoot) {
  const file = path.join(repoRoot || '', '.claude', 'brand.json');
  const stamp = mtime(file);
  const hit = CACHE.get(file);
  if (hit && hit.stamp === stamp) return hit.brand;
  let brand = defaultBrand();
  try {
    if (stamp) brand = { ...brand, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* fall through to default */ }
  // The stylesheet's own colour variables are the palette, so the list in
  // brand.json cannot fall out of date with the design.
  const sheets = [].concat(brand.tokensCss || []);
  if (sheets.length) {
    const fromCss = sheets.flatMap((rel) => cssTokenColors(path.join(repoRoot || '', rel)));
    const whitelist = new Set([...(brand.palette?.whitelist || []), ...fromCss].map((h) => h.toUpperCase()));
    brand = { ...brand, palette: { ...brand.palette, whitelist: [...whitelist] } };
  }
  CACHE.set(file, { stamp, brand });
  return brand;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Every `--name: #hex` declared in a stylesheet. */
export function cssTokenColors(file) {
  let css = '';
  try { css = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const m of css.matchAll(/--[\w-]+\s*:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/g)) {
    const c = parseColor(m[1]);
    if (c) out.push(toHex(c));
  }
  return out;
}

/** Clear the cache. For tests. */
export function _resetBrandCache() { CACHE.clear(); }

function defaultBrand() {
  return {
    colors: {},
    palette: { whitelist: [], allowGrays: true, grayTolerance: 10 },
    fonts: { sans: { families: [] }, mono: { families: [] } },
    spacing: { unit: 4, scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96], tolerance: 1 },
    radii: {},
    contrast: { min: 4.5, preferred: 7 },
  };
}

/* ---------- color ---------- */

/** Parse "#rgb", "#rrggbb", "rgb(r,g,b)", "rgba(r,g,b,a)" → {r,g,b,a} 0-255. */
export function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 };
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  }
  return null;
}

/** Hex-normalize to "#rrggbb" (upper or lower respects input). */
export function toHex({ r, g, b }, { upper = true } = {}) {
  const h = (n) => n.toString(16).padStart(2, '0');
  const s = `#${h(r)}${h(g)}${h(b)}`;
  return upper ? s.toUpperCase() : s;
}

/** Chebyshev distance between two colors (max channel diff). */
export function colorDistance(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** Gray if all three channels within `tol` of each other. */
export function isGray(c, tol = 10) {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= tol;
}

/**
 * Check an array of colors (hex strings) against the brand palette.
 * Returns { ok, offenders: [{color, nearest, distance}] }.
 */
export function colorsInPalette(colors, brand, { ignoreGrays = true, tolerance = 8 } = {}) {
  const whitelist = (brand.palette?.whitelist || []).map(parseColor).filter(Boolean);
  if (!whitelist.length) return { ok: true, offenders: [], reason: 'no palette configured' };
  const offenders = [];
  for (const raw of colors) {
    const c = parseColor(raw);
    if (!c) continue;
    if (ignoreGrays && isGray(c, brand.palette?.grayTolerance ?? 10)) continue;
    let best = { nearest: null, distance: Infinity };
    for (const w of whitelist) {
      const d = colorDistance(c, w);
      if (d < best.distance) best = { nearest: toHex(w), distance: d };
    }
    if (best.distance > tolerance) {
      offenders.push({ color: toHex(c), nearest: best.nearest, distance: best.distance });
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/* ---------- fonts ---------- */

/**
 * Does a computed font-family stack contain the brand's chosen family for the role?
 * `fontFamily` is the CSS value, e.g. 'Inter, system-ui, sans-serif'.
 */
export function fontIsBrand(fontFamily, brand, { role = 'sans' } = {}) {
  const want = brand.fonts?.[role]?.families || [];
  if (!want.length) return { ok: true, reason: `no ${role} font configured` };
  const used = String(fontFamily || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const brandNames = want.map((f) => f.toLowerCase());
  const matched = used.find((f) => brandNames.includes(f));
  if (matched) return { ok: true, matched };
  return { ok: false, used, want: brandNames };
}

/* ---------- contrast ---------- */

function srgbToLinear(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two colors (hex strings or parsed). */
export function contrastRatio(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return 0;
  const L1 = relativeLuminance(f);
  const L2 = relativeLuminance(b);
  const [a, c] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (a + 0.05) / (c + 0.05);
}

/** Check a list of {fg, bg, label?} pairs against the brand minimum. */
export function contrastPassesAll(pairs, brand, { ratio } = {}) {
  const min = ratio ?? brand.contrast?.min ?? 4.5;
  const results = pairs.map((p) => {
    const r = Number(contrastRatio(p.fg, p.bg).toFixed(2));
    return { ...p, ratio: r, ok: r >= min };
  });
  const failures = results.filter((r) => !r.ok);
  return { ok: failures.length === 0, min, results, failures };
}

/* ---------- spacing ---------- */

/** Check an array of pixel values against the brand spacing scale. */
export function spacingOnScale(values, brand) {
  const scale = brand.spacing?.scale || [];
  const tol = brand.spacing?.tolerance ?? 1;
  if (!scale.length) return { ok: true, offenders: [] };
  const offenders = [];
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const nearest = scale.reduce((best, s) => Math.abs(s - n) < Math.abs(best - n) ? s : best, scale[0]);
    if (Math.abs(nearest - n) > tol) offenders.push({ value: n, nearest });
  }
  return { ok: offenders.length === 0, offenders };
}

/* ---------- diff scanning ---------- */

/** Find raw hex colors in a diff/source that are not in the brand palette. */
export function scanRawHex(source, brand, { ignoreGrays = true } = {}) {
  const whitelist = new Set(
    (brand.palette?.whitelist || []).map((h) => (parseColor(h) ? toHex(parseColor(h)) : null)).filter(Boolean)
  );
  const matches = String(source || '').match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || [];
  const offenders = [];
  for (const raw of matches) {
    const c = parseColor(raw);
    if (!c) continue;
    if (ignoreGrays && isGray(c, brand.palette?.grayTolerance ?? 10)) continue;
    const hex = toHex(c);
    if (!whitelist.has(hex)) offenders.push({ hex, raw });
  }
  return { ok: offenders.length === 0, offenders };
}
