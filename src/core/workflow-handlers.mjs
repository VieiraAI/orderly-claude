/*
 * Handlers — one per node kind.
 *
 * A handler reads a node + run, does its work, and returns an output object
 * matching what the canvas card renders. It may call onProgress({progress,
 * partialOutput}) along the way so a long-running node shows motion. Throwing
 * marks the node failed and stops the run.
 *
 * Most kinds shell out to the `claude` CLI with a prompt built from the run's
 * workflow + inputs + any upstream outputs. The CLI runs with
 * --permission-mode acceptEdits so it can read the repo it was pointed at,
 * and the full skill shelf is available to it — a document handler can call
 * the doc-coauthoring skill, a report handler can call code-review, and so on.
 *
 * Two kinds stay local:
 *   terminal — spawns the declared command, captures stdout
 *   ask      — pauses the run until a client posts an answer
 *
 * shots-set is still placeholder: a real capture handler needs the dev-server
 * dance and chrome launch that lives elsewhere in this repo.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenshot, detectDevServer } from './capture.mjs';
import { putFile } from './blobs.mjs';

/** Pick the handler for a kind. Unknown kinds get the generic placeholder. */
export function getHandler(kind) {
  return HANDLERS[kind] || HANDLERS._default;
}

const HANDLERS = {
  terminal: async (node, { run, onProgress, signal }) => {
    const cmd = pickTerminalCommand(node, run);
    const started = Date.now();
    onProgress({ progress: `$ ${cmd.display}` });
    const { out, err, code } = await exec(cmd.argv, { cwd: run.repoRoot, signal, timeoutMs: 60_000 });
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    return {
      prompt: `$ ${cmd.display}`,
      out: (out || err || '').split('\n').slice(0, 20).join('\n'),
      status: code === 0 ? `done · ${elapsed} s` : `exit ${code} · ${elapsed} s`,
    };
  },

  ask: async (node, { awaitAnswer }) => {
    const answer = await awaitAnswer(node.id, {
      question: node.question || node.title,
      choices: node.choices || null,
    });
    return { question: node.question || node.title, answer };
  },

  document: async (node, ctx) => {
    const upstream = upstreamContext(node, ctx.run);
    const prompt = [
      `Draft a focused Markdown document for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is called "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      inputBlock(ctx.run.inputs),
      upstream && `## Context from earlier steps\n${upstream}`,
      '',
      `Return only the Markdown body — no preamble, no closing commentary.`,
      `Keep it concise: no more than ~400 words. Start with a single H1.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      cwd: ctx.run.repoRoot, signal: ctx.signal, model: pickModel(node, 'haiku'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const title = firstHeadline(text) || `${slug(node.title)}.md`;
    return { title: `${title}.md`, body: text.trim(), meta };
  },

  report: async (node, ctx) => {
    const upstream = upstreamContext(node, ctx.run);
    const prompt = [
      `You are reviewing work produced by the "${ctx.run.workflowTitle}" workflow.`,
      `This review node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      inputBlock(ctx.run.inputs),
      upstream && `## What to review\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"findings":[{"tag":"<correctness|readability|perf|security|style>","text":"<one short sentence>"}]}`,
      `List at most five findings, most important first. If there is nothing to flag, return an empty array.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      cwd: ctx.run.repoRoot, signal: ctx.signal, model: pickModel(node, 'sonnet'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const parsed = extractJson(text) || { findings: [] };
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return {
      title: `${slug(node.title)}.md · ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
      findings,
      meta,
    };
  },

  mockup: async (node, ctx) => {
    const upstream = upstreamContext(node, ctx.run);
    const prompt = [
      `Produce a single self-contained HTML mockup for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      inputBlock(ctx.run.inputs),
      upstream && `## Direction from earlier steps\n${upstream}`,
      '',
      `Return only the HTML (no code fences, no commentary). Use inline CSS. Keep it under 200 lines.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      cwd: ctx.run.repoRoot, signal: ctx.signal, model: pickModel(node, 'sonnet'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const html = stripFences(text);
    return { name: `${slug(node.title)}.html`, html, note: `${html.split('\n').length} lines`, meta };
  },

  diff: async (node, ctx) => {
    const upstream = upstreamContext(node, ctx.run);
    const prompt = [
      `Propose a small code change for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      inputBlock(ctx.run.inputs),
      upstream && `## What to work from\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"file":"<path>","hunks":[{"op":"add"|"del","line":"<raw line, no leading +/-/space>"}]}`,
      `Keep the change tiny — ten hunks or fewer.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      cwd: ctx.run.repoRoot, signal: ctx.signal, model: pickModel(node, 'sonnet'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const parsed = extractJson(text) || { file: 'unknown', hunks: [] };
    return { file: parsed.file || 'unknown', hunks: parsed.hunks || [], meta };
  },

  pr: async (node, ctx) => {
    const upstream = upstreamContext(node, ctx.run);
    const prompt = [
      `Draft a GitHub pull request body for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      inputBlock(ctx.run.inputs),
      upstream && `## What this PR covers\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"title":"<pr title, under 70 chars>","body":"<short markdown body>"}`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      cwd: ctx.run.repoRoot, signal: ctx.signal, model: pickModel(node, 'haiku'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const parsed = extractJson(text) || {};
    const title = parsed.title || ctx.run.inputs?.title || ctx.run.workflowTitle;
    const body  = parsed.body  || 'Draft PR body — generated by workflow.';
    return {
      state: 'draft', number: '#—',
      title,
      bodyPreview: body.split('\n').slice(0, 8).join('\n'),
      url: null,
      meta,
    };
  },

  shots: async (node, ctx) => {
    const origin = await pickOrigin(ctx);
    if (!origin) return { note: 'No dev server detected. Set inputs.devUrl or start one on a known port.' };
    const route = node.route || ctx.run.inputs?.route || '/';
    const shot = await captureShot(`${origin}${route.startsWith('/') ? route : `/${route}`}`, ctx.signal);
    if (!shot) return { note: `Capture failed for ${route}` };
    return { route, origin, shot };
  },

  'shots-set': async (node, ctx) => {
    // Walk one route at a time so the grid fills in on-screen. Each route is
    // captured against the detected dev server (or inputs.devUrl) and the PNG
    // lands in the shared blob store so the canvas can render it live.
    const origin = await pickOrigin(ctx);
    const routes = parseRoutes(ctx.run.inputs?.routes) || ['/', '/blog', '/about', '/pricing', '/contact'];
    const pairs = routes.map((r) => ({ route: r, status: origin ? 'waits' : 'skipped' }));
    if (!origin) {
      return {
        title: `0 of ${pairs.length} captured`,
        pairs, note: 'No dev server detected. Set inputs.devUrl or start one on a known port.',
      };
    }
    for (let i = 0; i < pairs.length; i++) {
      if (ctx.signal?.aborted) break;
      pairs[i].status = 'running';
      onProgressSnapshot(ctx, pairs, i);
      try {
        const url = `${origin}${pairs[i].route.startsWith('/') ? pairs[i].route : `/${pairs[i].route}`}`;
        const shot = await captureShot(url, ctx.signal);
        if (shot) {
          pairs[i].status = 'done';
          pairs[i].shot = shot;
        } else {
          pairs[i].status = 'failed';
        }
      } catch (e) {
        pairs[i].status = 'failed';
        pairs[i].error = e.message;
      }
      onProgressSnapshot(ctx, pairs, i);
    }
    const done = pairs.filter((p) => p.status === 'done').length;
    return { title: `${done} of ${pairs.length} captured`, origin, pairs };
  },

  _default: async (node, ctx) => {
    await nap(ctx, 300);
    return { note: `output for ${node.kind} (placeholder — no handler wired)` };
  },
};

/* --------------------------- Claude CLI driver --------------------------- */

/**
 * Spawn `claude -p` with the given prompt and return its text result.
 * The CLI runs with --output-format stream-json so we can emit progress
 * events as the text comes in — the card advances token-by-token instead
 * of waiting for the whole response. The final `result` line carries the
 * structured metadata (duration, cost, session id, model usage).
 *
 * Tests and demos set `ORDERLY_HANDLER_MODE=mock` to short-circuit the spawn
 * so the smoke suite does not bill the API on every run.
 */
async function callClaude(prompt, { cwd, signal, model = 'sonnet', onProgress, timeoutMs = 180_000 } = {}) {
  if (process.env.ORDERLY_HANDLER_MODE === 'mock') {
    onProgress?.('claude · mock');
    await new Promise((r) => setTimeout(r, 120));
    return mockReply(prompt, model);
  }
  onProgress?.(`claude · ${model} · starting…`);
  const started = Date.now();
  const argv = ['claude', '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--model', model, prompt];
  const { finalPayload, text, code, err } = await execStream(argv, {
    cwd, signal, timeoutMs,
    onDelta: (delta, totals) => {
      const tail = text => text.slice(-40).replace(/\s+/g, ' ').trim();
      onProgress?.(`claude · ${model} · ${totals.tokens} tok · ${tail(totals.text)}`);
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!finalPayload) {
    throw new Error(`claude cli exited ${code} without a result: ${(err || '').slice(0, 200)}`);
  }
  if (finalPayload.is_error) {
    throw new Error(`claude cli reported error: ${finalPayload.result || finalPayload.subtype || 'unknown'}`);
  }
  const modelKey = Object.keys(finalPayload.modelUsage || {})[0] || model;
  const meta = {
    model: modelKey,
    cost: finalPayload.total_cost_usd,
    elapsed: `${elapsed} s`,
    sessionId: finalPayload.session_id,
    tokens: finalPayload.usage?.output_tokens,
  };
  return { text: String(finalPayload.result || text || ''), meta };
}

/** Spawn a process and stream its stdout line-by-line. Each line is parsed
 *  as JSON; recognised event types feed onDelta so the card can advance. */
function execStream(argv, { cwd, signal, timeoutMs = 180_000, onDelta } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env });
    let finalPayload = null;
    let text = '';
    let tokens = 0;
    let err = '';
    let stdoutBuf = '';
    let timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    signal?.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} }, { once: true });
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'result') { finalPayload = msg; continue; }
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
          const t = msg.event.delta?.text;
          if (t) { text += t; tokens++; onDelta?.(t, { text, tokens }); }
        }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ finalPayload, text, code: code ?? -1, err }); });
    child.on('error', (e)   => { clearTimeout(timer); resolve({ finalPayload: null, text: '', code: -1, err: e.message }); });
  });
}

/** A deterministic stub for each prompt shape. Keeps the output shape close
 *  enough to the real thing that downstream parsers behave the same. */
function mockReply(prompt, model) {
  const meta = { model: `mock-${model}`, cost: 0, elapsed: '0.1 s', sessionId: 'mock', tokens: 0 };
  if (/Return a JSON object .*findings/i.test(prompt)) {
    return { text: JSON.stringify({
      findings: [{ tag: 'readability', text: 'Mock finding — swap in a real review.' }],
    }), meta };
  }
  if (/Return a JSON object .*hunks/i.test(prompt)) {
    return { text: JSON.stringify({ file: 'mock.css', hunks: [
      { op: 'del', line: '  padding: 24px;' },
      { op: 'add', line: '  padding: 32px;' },
    ] }), meta };
  }
  if (/Return a JSON object .*title.*body/i.test(prompt)) {
    return { text: JSON.stringify({ title: '[mock] PR title', body: '## Summary\n\nMock body.' }), meta };
  }
  if (/single self-contained HTML mockup/i.test(prompt)) {
    return { text: '<!doctype html><html><body><h1>Mock</h1></body></html>', meta };
  }
  // Default: a short Markdown document.
  return { text: '# Mock document\n\nA stub body produced in `ORDERLY_HANDLER_MODE=mock`.', meta };
}

/* ------------------------------- Helpers -------------------------------- */

function upstreamContext(node, run) {
  // Pull in the output of every direct parent node, labelled by title.
  const parents = (run.graph.edges || [])
    .filter(([, b]) => b === node.id)
    .map(([a]) => run.graph.nodes.find((n) => n.id === a))
    .filter(Boolean);
  const chunks = [];
  for (const p of parents) {
    if (!p.output) continue;
    const body = outputToText(p);
    if (body) chunks.push(`### ${p.title}\n${body}`);
  }
  return chunks.join('\n\n');
}

function outputToText(node) {
  const o = node.output || {};
  if (o.body)       return String(o.body);
  if (o.text)       return String(o.text);
  if (o.out)        return `\n\`\`\`\n${String(o.out).slice(0, 2000)}\n\`\`\``;
  if (o.findings)   return o.findings.map((f) => `- **${f.tag}:** ${f.text}`).join('\n');
  if (o.answer)     return `**${o.question || node.title}**\n${o.answer}`;
  if (o.hunks)      return `\`${o.file || ''}\`: ${o.hunks.length} hunk(s)`;
  if (o.title)      return o.title;
  return '';
}

function inputBlock(inputs) {
  const rows = Object.entries(inputs || {}).filter(([, v]) => v);
  if (!rows.length) return null;
  return `## Inputs\n${rows.map(([k, v]) => `- **${k}:** ${v}`).join('\n')}`;
}

/** Resolve the model for a node: explicit `node.model` wins, otherwise the
 *  kind's cheap default — most work is small enough for haiku. */
function pickModel(node, fallback = 'haiku') { return node.model || fallback; }

function firstHeadline(text) {
  const m = String(text || '').match(/^#\s+(.+?)\s*$/m);
  return m ? slug(m[1]) : null;
}

function stripFences(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : t;
}

/**
 * Pull a JSON object out of a response. Models sometimes wrap JSON in a code
 * fence or add commentary around it, so look for the outer braces first.
 */
function extractJson(text) {
  const t = String(text || '').trim();
  const direct = tryParse(t);
  if (direct) return direct;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inside = tryParse(fenced[1]);
    if (inside) return inside;
  }
  const brace = t.indexOf('{');
  if (brace >= 0) {
    const slice = t.slice(brace);
    const parsed = tryParse(slice);
    if (parsed) return parsed;
  }
  return null;
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Pick an origin to capture against: explicit `inputs.devUrl` wins; otherwise
 * detect a dev server running inside the repo. Returns null when nothing is
 * reachable, so the handler can report "no dev server" instead of hanging.
 */
async function pickOrigin(ctx) {
  const given = (ctx.run.inputs?.devUrl || '').trim();
  if (given) return given.replace(/\/+$/, '');
  return await detectDevServer(ctx.run.repoRoot);
}

/** Capture one URL and move the PNG into the content-addressed blob store. */
async function captureShot(url, signal) {
  if (signal?.aborted) throw new Error('aborted');
  const tmp = path.join(os.tmpdir(), `orderly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const res = await screenshot(url, tmp, { width: 1400, height: 1000 });
  if (!res.ok) return null;
  const ref = putFile(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  return { url, ref, capturedAt: new Date().toISOString() };
}

function onProgressSnapshot(ctx, pairs, i) {
  ctx.onProgress({
    progress: `capturing ${pairs[i].route}`,
    partialOutput: { title: `${pairs.filter((p) => p.status === 'done').length} of ${pairs.length} captured`, pairs: pairs.map((p) => ({ ...p })) },
  });
}

function parseRoutes(src) {
  if (!src) return null;
  return String(src).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* A nap that respects stop() — resolves early if the run was aborted. */
function nap(ctx, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

function pickTerminalCommand(node, run) {
  // The node can declare its command explicitly. Default per workflow follows.
  if (node.command) {
    const argv = typeof node.command === 'string' ? ['sh', '-c', node.command] : node.command;
    return { argv, display: typeof node.command === 'string' ? node.command : node.command.join(' ') };
  }
  if (run.workflowId === 'visual-regression' && node.id === 'server') {
    return { argv: ['sh', '-c', 'node -e "console.log(\'placeholder dev server ready on :5173\')"'], display: 'npm run dev' };
  }
  if (run.workflowId === 'ship-pr' && node.id === 'tests') {
    return { argv: ['sh', '-c', 'echo "167 passed · placeholder"'], display: 'npm test' };
  }
  return { argv: ['sh', '-c', `echo "node ${node.id}"`], display: `# ${node.id}` };
}

function exec(argv, { cwd, signal, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    let out = '', err = '', timer = null;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env });
    const kill = (reason) => { try { child.kill('SIGTERM'); } catch {} out += reason ? `\n[${reason}]` : ''; };
    timer = setTimeout(() => kill('timeout'), timeoutMs);
    signal?.addEventListener('abort', () => kill('aborted'), { once: true });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code: code ?? -1 }); });
    child.on('error', (e)   => { clearTimeout(timer); resolve({ out, err: e.message, code: -1 }); });
  });
}
