/**
 * Deciding what deserves a before and after, and whether one shows anything.
 *
 * Measured on 509 captures taken while building this tool: 382 of them (75%)
 * photographed Orderly's own page, which is a live conversation that grows on
 * its own every few seconds. Every pair therefore differed, a byte comparison
 * reported 71% of them as changes, and almost none of those changes had
 * anything to do with the step they were filed under.
 *
 * Three things follow, and this module holds all three:
 *
 *   1. Capture only steps that could plausibly have changed what the app
 *      draws. Editing a test or a README cannot.
 *   2. Never photograph ourselves, where the picture changes regardless.
 *   3. Compare pixels, not bytes, and say where and how much — a pair that
 *      differs by a tenth of a percent in one corner is not a change anyone
 *      asked to see.
 *
 * Nothing here runs a browser; `comparePairInPage` returns the script to run
 * in one, so the caller owns the browser and this stays testable.
 */

import path from 'node:path';

/* ------------------------------------------------------------------ *
 * 1. Which files can change what an app draws
 * ------------------------------------------------------------------ */

/** Markup, styling, scripts, templates and assets all reach the screen. */
const RENDERS = new Set([
  '.html', '.htm', '.xhtml',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.vue', '.svelte', '.astro',
  '.ejs', '.hbs', '.handlebars', '.pug', '.njk', '.liquid', '.erb', '.twig', '.php',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
]);

/** Build and design config decides what gets drawn, so it counts. */
const CONFIG_RENDERS = /^(vite|next|nuxt|astro|svelte|tailwind|postcss|webpack|rollup|parcel|remix|gatsby|angular)\.config\./i;

/** A test proves the code; it is not the code anyone looks at. */
const IS_TEST = [
  /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright|fixtures?|__mocks__)\//i,
  /\.(test|spec)\.[a-z]+$/i,
];

/** Writing about the project is not the project. */
const IS_PROSE = [
  /(^|\/)(docs?|\.github|\.vscode|\.idea)\//i,
  /(^|\/)(readme|contributing|license|licence|changelog|code_of_conduct|security|authors)(\.[a-z]+)?$/i,
];

/** Machine-written and never read by a browser. */
const IS_NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i,
  /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.svelte-kit|\.astro|\.git)\//i,
  /\.(log|lock|map|snap)$/i,
];

/** Content directories, where prose really is what the page shows. */
const CONTENT_DIR = /(^|\/)(content|posts?|pages?|articles?|blog|docs?|src\/content)\//i;

const matchesAny = (patterns, value) => patterns.some((p) => p.test(value));

/**
 * Could editing this file change what the app at `projectDir` draws?
 *
 * Returns `{ renders, reason }` so a refusal can be explained rather than
 * silently producing nothing.
 */
export function rendersInto(filePath, projectDir) {
  if (!filePath) return { renders: false, reason: 'no file' };

  const abs = path.resolve(filePath);
  if (projectDir) {
    const root = path.resolve(projectDir);
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
      return { renders: false, reason: 'outside the running app' };
    }
  }

  const rel = projectDir ? path.relative(path.resolve(projectDir), abs) : abs;
  const posix = rel.split(path.sep).join('/');
  const base = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();

  if (matchesAny(IS_NOISE, `/${posix}`)) return { renders: false, reason: 'generated or vendored' };
  if (matchesAny(IS_TEST, `/${posix}`)) return { renders: false, reason: 'a test' };
  if (matchesAny(IS_PROSE, `/${posix}`)) return { renders: false, reason: 'documentation' };

  if (CONFIG_RENDERS.test(base)) return { renders: true, reason: 'build configuration' };

  // Prose is content when it sits where a site keeps its content.
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') {
    return CONTENT_DIR.test(`/${posix}`)
      ? { renders: true, reason: 'page content' }
      : { renders: false, reason: 'prose outside the content folder' };
  }

  // JSON is content or config depending on where it lives; only count it
  // where a site would actually read it.
  if (ext === '.json') {
    return CONTENT_DIR.test(`/${posix}`) || /(^|\/)(src|app|public|static|assets)\//i.test(`/${posix}`)
      ? { renders: true, reason: 'data the app reads' }
      : { renders: false, reason: 'configuration the browser never sees' };
  }

  if (RENDERS.has(ext)) return { renders: true, reason: `a ${ext.slice(1)} file the app serves` };
  return { renders: false, reason: `nothing the browser reads (${ext || 'no extension'})` };
}

/* ------------------------------------------------------------------ *
 * 2. Whether a step is worth photographing
 * ------------------------------------------------------------------ */

/**
 * Decide before spending a capture.
 *
 * `files` are the paths the step wrote. `projectDir` is the root of the app
 * being photographed, and `selfPort` is this server's own port — a page that
 * redraws itself as the conversation grows will differ in every pair, and
 * none of those differences belong to the step.
 */
export function shouldCapture(step, { projectDir, devUrl, selfPort } = {}) {
  if (!devUrl) return { capture: false, reason: 'no app is running to photograph' };

  // The capture target can be typed by hand, so it is not necessarily a URL.
  let port = null;
  try { port = new URL(devUrl).port; } catch { port = null; }
  if (selfPort && port === String(selfPort)) {
    return { capture: false, reason: 'that is this viewer, which redraws on its own' };
  }

  if (step?.kind !== 'change') {
    return { capture: false, reason: 'the step changed nothing' };
  }

  const files = (step.files || []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  if (!files.length) return { capture: false, reason: 'no files were written' };

  const verdicts = files.map((f) => ({ file: f, ...rendersInto(f, projectDir) }));
  const drawing = verdicts.filter((v) => v.renders);
  if (!drawing.length) {
    const why = verdicts[0]?.reason || 'nothing the app draws';
    return { capture: false, reason: `only ${why}`, files: verdicts };
  }

  return {
    capture: true,
    reason: `changed ${drawing.length === 1 ? drawing[0].file : `${drawing.length} files`} the app draws`,
    files: verdicts,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Whether the pair shows anything
 * ------------------------------------------------------------------ */

/** Below this share of pixels, a difference is rendering noise, not a change. */
export const NOISE_FLOOR = 0.0015; // 0.15%

/** A difference smaller than this is not worth cropping to. */
const MIN_REGION = 12;

/**
 * A script to run in a page that has both images, returning where they differ.
 *
 * Done in the browser because it already decodes PNGs; doing it here would
 * mean writing a PNG decoder to answer a question the browser answers for
 * free. The caller injects this and hands back the result.
 */
export function comparePairInPage(beforeUrl, afterUrl, { tolerance = 24 } = {}) {
  return `(async () => {
    const load = (src) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('could not load ' + src));
      img.src = src;
    });
    const [a, b] = await Promise.all([load(${JSON.stringify(beforeUrl)}), load(${JSON.stringify(afterUrl)})]);

    // Pages change height as content changes; compare on a canvas big enough
    // for both and treat the uncovered margin as changed.
    const w = Math.max(a.naturalWidth, b.naturalWidth);
    const h = Math.max(a.naturalHeight, b.naturalHeight);
    const draw = (img) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const A = draw(a), B = draw(b);

    let changed = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    const tol = ${tolerance};
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.abs(A[i] - B[i]) > tol
          || Math.abs(A[i + 1] - B[i + 1]) > tol
          || Math.abs(A[i + 2] - B[i + 2]) > tol
          || Math.abs(A[i + 3] - B[i + 3]) > tol) {
          changed++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    const ratio = changed / (w * h);
    return JSON.stringify({
      width: w, height: h, changedPixels: changed, ratio,
      box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      sizeDiffers: a.naturalHeight !== b.naturalHeight || a.naturalWidth !== b.naturalWidth,
    });
  })()`;
}

/**
 * Turn a raw comparison into something worth showing, or not showing.
 *
 * A pair is only called a change when enough pixels moved; and the region
 * that moved is padded a little, so the crop shows the change in context
 * rather than flush against its edge.
 */
export function readComparison(raw, { floor = NOISE_FLOOR, pad = 24 } = {}) {
  if (!raw || typeof raw.ratio !== 'number') {
    return { changed: false, reason: 'could not be compared' };
  }
  if (!raw.box || raw.ratio < floor) {
    return {
      changed: false,
      ratio: raw.ratio,
      reason: raw.ratio > 0 ? 'the picture is all but identical' : 'the picture is identical',
    };
  }

  const box = {
    x: Math.max(0, raw.box.x - pad),
    y: Math.max(0, raw.box.y - pad),
    w: Math.min(raw.width, raw.box.w + pad * 2),
    h: Math.min(raw.height, raw.box.h + pad * 2),
  };
  const wholePage = box.w > raw.width * 0.9 && box.h > raw.height * 0.9;

  return {
    changed: true,
    ratio: raw.ratio,
    percent: Math.max(0.1, Math.round(raw.ratio * 1000) / 10),
    box: box.w < MIN_REGION || box.h < MIN_REGION ? null : box,
    // A change spread across the whole frame cannot usefully be cropped to.
    wholePage,
    sizeDiffers: !!raw.sizeDiffers,
    reason: wholePage ? 'the page changed throughout' : 'part of the page changed',
  };
}

/**
 * How much to trust that this pair shows this step.
 *
 * The "before" is the picture taken after the previous step, so a long gap
 * means other things happened in between and the pair cannot honestly be
 * said to show only this one.
 */
export function attribution(spanMs) {
  if (!spanMs && spanMs !== 0) return { level: 'unknown', note: 'when this was taken is not recorded' };
  if (spanMs <= 20000) return { level: 'tight', note: null };
  if (spanMs <= 90000) return { level: 'loose', note: `the before was taken ${Math.round(spanMs / 1000)}s earlier` };
  return { level: 'weak', note: `the before was taken ${Math.round(spanMs / 60000)} minutes earlier` };
}
