import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { SHOTS_DIR } from './paths.mjs';
import { CDP, httpJSON } from './cdp.mjs';
import { comparePairInPage } from './visual.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

const PORTS = [3000, 5173, 3001, 4321, 8080, 5174, 4200, 8000, 1420, 4000, 3002, 8081, 9000];

const lsof = (args) => {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
};

/* A browser's own debugging port serves pages but is not anyone's app. */
const NOT_AN_APP = /chrome|chromium|msedge|safari|firefox|ollama|adobe|dropbox|spotify/i;

/** Every listening TCP port with the process holding it. */
export function listeningServers() {
  const seen = new Map();
  let pid = null;
  let command = '';
  for (const line of lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']).split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)) || null; command = ''; }
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const m = line.match(/:(\d+)$/);
      const port = m && Number(m[1]);
      if (port && !seen.has(port)) seen.set(port, { port, pid, command });
    }
  }
  return [...seen.values()].filter((s) => !NOT_AN_APP.test(s.command));
}

/** The directory a process was started in. */
export function processCwd(pid) {
  const line = lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

async function alive(port, timeout = 350) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: ctl.signal, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    return res.status < 500 && (type.includes('html') || type === '');
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/**
 * Find the dev server for this project.
 *
 * A plain port scan picks whatever answers first, which is routinely some
 * unrelated app — and then every before/after is a photograph of the wrong
 * thing. So prefer a server whose process was started inside the project,
 * and only fall back to the scan when none is.
 */
export async function detectDevServer(projectDir) {
  if (projectDir) {
    const depth = (p) => p.split('/').filter(Boolean).length;
    const mine = [];
    for (const srv of listeningServers()) {
      const cwd = processCwd(srv.pid);
      if (!cwd || cwd === '/') continue;
      if (cwd === projectDir || cwd.startsWith(`${projectDir}/`)) mine.push({ ...srv, cwd });
    }
    // Closest wins. A session run from a home directory matches almost
    // everything, so the nearest server is a better guess than the lowest port.
    mine.sort((a, b) => (depth(a.cwd) - depth(projectDir)) - (depth(b.cwd) - depth(projectDir))
      || a.port - b.port);
    for (const srv of mine) {
      if (await alive(srv.port)) return `http://localhost:${srv.port}`;
    }
  }

  const checks = PORTS.map(async (p) => ((await alive(p)) ? p : null));
  const found = (await Promise.all(checks)).filter(Boolean);
  return found.length ? `http://localhost:${found[0]}` : null;
}

function freePort(start = 9222) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(freePort(start + 1)));
    srv.once('listening', () => srv.close(() => resolve(start)));
    srv.listen(start, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One headless Chrome kept alive between shots, torn down when idle. */
class Browser {
  constructor() { this.cdp = null; this.proc = null; this.profile = null; this.starting = null; this.idle = null; }

  async ensure() {
    if (this.cdp) return this.cdp;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const chrome = findChrome();
    if (!chrome) throw new Error('no Chrome found');
    const port = await freePort();
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-claude-'));
    this.proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      '--disable-component-update', '--disable-background-networking',
      `--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`,
      'about:blank',
    ], { stdio: 'ignore' });
    this.proc.on('exit', () => { this.cdp = null; this.proc = null; });

    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try { wsUrl = (await httpJSON(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; }
      catch { await sleep(120); }
    }
    if (!wsUrl) { this.kill(); throw new Error('Chrome did not expose a debugging port'); }
    this.cdp = await CDP.attach(wsUrl);
    return this.cdp;
  }

  kill() {
    try { this.cdp?.close(); } catch {}
    try { this.proc?.kill('SIGKILL'); } catch {}
    if (this.profile) fs.rm(this.profile, { recursive: true, force: true }, () => {});
    this.cdp = null; this.proc = null; this.profile = null;
  }

  touchIdle(ms = 300000) {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(), ms);
    this.idle.unref?.();
  }

  async shot(url, outFile, { width = 1440, height = 900, settleMs = 650, fullPage = false } = {}) {
    const cdp = await this.ensure();
    this.touchIdle();
    // Size comes from Emulation below; Target.createTarget rejects it in new headless.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    let sessionId;
    try {
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      // A page holding an SSE or HMR socket may never fire load — carry on regardless.
      await cdp.once('Page.loadEventFired', sessionId, 7000);
      await sleep(settleMs);

      const params = { format: 'png' };
      if (fullPage) {
        const { cssContentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        if (cssContentSize) {
          params.captureBeyondViewport = true;
          params.clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 12000), scale: 1 };
        }
      }
      const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, Buffer.from(data, 'base64'));
      return { ok: true, file: outFile };
    } finally {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
    }
  }

  /**
   * Run a script on a blank page of our own origin.
   *
   * Reading pixels back from a canvas is refused once a `file://` image has
   * been drawn onto it, so the images are fetched over this server instead,
   * from the same origin as the page. The alternative is launching the
   * browser with file access turned on, which is a larger hole than this
   * needs.
   */
  async evaluateOnOrigin(origin, expression, { timeout = 20000 } = {}) {
    const cdp = await this.ensure();
    this.touchIdle();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url: `${origin}/blank.html` }, sessionId);
      await cdp.once('Page.loadEventFired', sessionId, timeout);
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluation failed');
      return res.result?.value;
    } finally {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
    }
  }
}

const browser = new Browser();
export function shutdownBrowser() { browser.kill(); }

export async function screenshot(url, outFile, opts = {}) {
  try {
    return await browser.shot(url, outFile, opts);
  } catch (e) {
    browser.kill();
    return { ok: false, error: e.message };
  }
}

export function shotPath(sessionId, stepId, which) {
  return path.join(SHOTS_DIR, sessionId, `${stepId}-${which}.png`);
}

/**
 * How much of the picture actually changed, and where.
 *
 * Comparing bytes said 71% of pairs had changed when almost none of them had
 * anything a person would notice: a page that redraws itself differs every
 * time. Counting pixels answers the question that was being asked.
 *
 * Returns null when the comparison could not be made, so the caller can fall
 * back rather than treat a failure as "no change".
 */
export async function comparePair(origin, beforeFile, afterFile, opts = {}) {
  if (!origin || !beforeFile || !afterFile) return null;
  const asUrl = (f) => `${origin}/api/shot?f=${encodeURIComponent(f)}`;
  try {
    const raw = await browser.evaluateOnOrigin(
      origin,
      comparePairInPage(asUrl(beforeFile), asUrl(afterFile), opts),
    );
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function captureFor(sessionId, stepId, which, url, opts = {}) {
  if (!url) return null;
  const out = shotPath(sessionId, stepId, which);
  const res = await screenshot(url, out, opts);
  return res.ok ? { which, file: out, url, at: new Date().toISOString() } : null;
}
