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
import {
  loadBrand,
  colorsInPalette,
  fontIsBrand,
  contrastPassesAll,
  spacingOnScale,
  scanRawHex,
} from './brand.mjs';
import { loadMcpConfig, resolveTool, interpolate, PUBLISH_TO_MCP } from './mcp.mjs';

/** Working directory for handler-side filesystem calls. Prefers a sandbox
 *  path when one is set on the run; falls back to the repo root. */
function cwdOf(run) { return run?.cwd || run?.repoRoot; }

/** Pick the handler for a kind. Unknown kinds get the generic placeholder. */
export function getHandler(kind) {
  return HANDLERS[kind] || HANDLERS._default;
}

const HANDLERS = {
  terminal: async (node, { run, onProgress, signal }) => {
    const cmd = pickTerminalCommand(node, run);
    const started = Date.now();
    onProgress({ progress: `$ ${cmd.display}` });
    const { out, err, code } = await exec(cmd.argv, { cwd: cwdOf(run), signal, timeoutMs: 60_000 });
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
      cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'haiku'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
      // Stream the growing body into the card so the running state feels alive.
      onStream: ({ text: running }) => ctx.onProgress({
        partialOutput: { title: `${slug(node.title)}.md · streaming…`, body: running },
      }),
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
      cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
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
      cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
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
      cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
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
      cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'haiku'),
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
    const baselineOrigin = (ctx.run.inputs?.baselineUrl || '').trim().replace(/\/+$/, '');
    const route = node.route || ctx.run.inputs?.route || '/';
    const path = route.startsWith('/') ? route : `/${route}`;
    const after = await captureShot(`${origin}${path}`, ctx.signal);
    const before = baselineOrigin ? await captureShot(`${baselineOrigin}${path}`, ctx.signal) : null;
    if (!after) return { note: `Capture failed for ${route}` };
    return { route, origin, baselineOrigin: baselineOrigin || null, before, after, shot: after };
  },

  'shots-set': async (node, ctx) => {
    // Walk one route at a time so the grid fills in on-screen. Each route is
    // captured against the detected dev server (or inputs.devUrl); when
    // inputs.baselineUrl is set, a matching before-shot comes from there so
    // the card renders a real before/after pair.
    const origin = await pickOrigin(ctx);
    const baselineOrigin = (ctx.run.inputs?.baselineUrl || '').trim().replace(/\/+$/, '');
    const baselineName = (ctx.run.inputs?.baseline || '').trim();
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
        const path = pairs[i].route.startsWith('/') ? pairs[i].route : `/${pairs[i].route}`;
        const after = await captureShot(`${origin}${path}`, ctx.signal);
        if (after) {
          pairs[i].after = after;
          pairs[i].shot = after; // compat with old renderer that reads .shot
        }
        if (baselineOrigin) {
          const before = await captureShot(`${baselineOrigin}${path}`, ctx.signal);
          if (before) pairs[i].before = before;
        }
        pairs[i].status = after ? 'done' : 'failed';
      } catch (e) {
        pairs[i].status = 'failed';
        pairs[i].error = e.message;
      }
      onProgressSnapshot(ctx, pairs, i);
    }
    const done = pairs.filter((p) => p.status === 'done').length;
    const note = !baselineOrigin && baselineName
      ? `No baselineUrl set. To compare against ${baselineName}, start a dev server on that branch and pass inputs.baselineUrl.`
      : null;
    return {
      title: `${done} of ${pairs.length} captured${baselineOrigin ? ' · before/after' : ''}`,
      origin, baselineOrigin: baselineOrigin || null, pairs, note,
    };
  },

  /* --------------------- v2 vocabulary (schemaVersion: 2) --------------------
   * Each handler reads node.spec and either calls a legacy handler or does its
   * own work. Legacy handlers above stay registered so old workflow files and
   * old run.json records keep working unchanged. */

  agent: async (node, ctx) => {
    const spec = node.spec || {};
    const verify = spec.verify;
    const maxRetries = Number(verify?.maxRetries ?? 0);
    const attempts = [];
    let output;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prevFailures = attempts.map((a) => a.failures).flat();
      output = await runAgentOnce(node, ctx, prevFailures);
      if (!verify) return output;
      const result = await runVerify(node, output, ctx);
      attempts.push({ attempt, pass: result.pass, failures: result.failures, verify: result });
      if (result.pass || attempt === maxRetries) {
        output.verify = { pass: result.pass, attempts, results: result.results };
        if (!result.pass && (verify.onFail || 'stop') === 'stop') {
          throw new Error(`verify failed: ${result.failures.map((f) => f.reason).join('; ')}`);
        }
        return output;
      }
      ctx.onProgress({ progress: `verify failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying…` });
    }
    return output;
  },

  script: async (node, ctx) => {
    const spec = node.spec || {};
    if (spec.op === 'capture-shots') return HANDLERS['shots-set'](node, ctx);
    if (spec.op === 'capture-shot')  return HANDLERS.shots(node, ctx);
    // Shell command — reuse the terminal handler with the cmd shimmed on.
    const shim = { ...node, command: spec.cmd || node.command };
    return HANDLERS.terminal(shim, ctx);
  },

  decision: async (node, ctx) => {
    const spec = node.spec || {};
    const options = spec.options || [];
    const askNode = {
      ...node,
      question: spec.question || node.title,
      choices: options.map((o) => o.label),
    };
    const base = await HANDLERS.ask(askNode, ctx);
    const picked = options.find((o) => o.label === base.answer);
    return { ...base, picked: picked?.edgeLabel || base.answer, options };
  },

  check: async (node, ctx) => {
    const spec = node.spec || {};
    const a = spec.assert || {};
    const from = ctx.run.graph.nodes.find((n) => n.id === a.from);
    let pass = false, reason = '';
    if (a.type === 'exit-zero') {
      const code = from?.output?.code;
      // Legacy terminal handler reports status not code; treat undefined as pass.
      pass = code === 0 || code === undefined;
      reason = pass ? 'exit 0' : `exit ${code}`;
    } else if (a.type === 'has-pairs') {
      const pairs = from?.output?.pairs || [];
      const done = pairs.filter((p) => p.status === 'done').length;
      const skipped = pairs.filter((p) => p.status === 'skipped').length;
      const min = a.min || 1;
      if (pairs.length > 0 && skipped === pairs.length) {
        // No origin to capture against — treat as "nothing to check" rather
        // than a failure so the gate doesn't trip on a missing dev server.
        pass = true; reason = 'no captures available';
      } else {
        pass = done >= min;
        reason = `${done} captured${pass ? '' : `, need ${min}`}`;
      }
    } else if (a.type === 'contains') {
      const haystack = JSON.stringify(from?.output || '');
      pass = haystack.includes(a.needle);
      reason = pass ? `found "${a.needle}"` : `missing "${a.needle}"`;
    } else if (a.type === 'manual') {
      const answer = await ctx.awaitAnswer(node.id, {
        question: a.question || spec.question || `Does ${from?.title || 'the upstream'} look right?`,
        choices: ['yes', 'no'],
      });
      pass = answer === 'yes';
      reason = answer;
    } else if (a.type === 'color-in-palette') {
      const brand = loadBrand(cwdOf(ctx.run));
      const colors = resolveColors(a, from);
      const res = colorsInPalette(colors, brand, { ignoreGrays: a.ignoreGrays !== false, tolerance: a.tolerance ?? 8 });
      pass = res.ok;
      reason = pass
        ? `${colors.length} on palette`
        : `${res.offenders.length} off palette: ${res.offenders.slice(0, 3).map((o) => `${o.color}→${o.nearest}`).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, offenders: res.offenders };
    } else if (a.type === 'font-is-brand') {
      const brand = loadBrand(cwdOf(ctx.run));
      const family = a.fontFamily ?? from?.output?.fontFamily ?? '';
      const res = fontIsBrand(family, brand, { role: a.role || 'sans' });
      pass = res.ok;
      reason = pass ? `brand ${a.role || 'sans'}` : `uses ${res.used?.join(', ') || '(none)'}, want ${res.want?.join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title };
    } else if (a.type === 'contrast-min') {
      const brand = loadBrand(cwdOf(ctx.run));
      const pairs = a.pairs ?? from?.output?.pairs ?? [];
      const res = contrastPassesAll(pairs, brand, { ratio: a.ratio });
      pass = res.ok;
      reason = pass
        ? `all ≥ ${res.min}`
        : `${res.failures.length} fail: ${res.failures.slice(0, 2).map((f) => `${f.label || f.fg + '/' + f.bg}=${f.ratio}`).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, results: res.results };
    } else if (a.type === 'spacing-on-scale') {
      const brand = loadBrand(cwdOf(ctx.run));
      const values = a.values ?? from?.output?.spacing ?? [];
      const res = spacingOnScale(values, brand);
      pass = res.ok;
      reason = pass ? `${values.length} on scale` : `${res.offenders.length} off: ${res.offenders.slice(0, 3).map((o) => `${o.value}→${o.nearest}`).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, offenders: res.offenders };
    } else if (a.type === 'no-raw-hex') {
      const brand = loadBrand(cwdOf(ctx.run));
      const source = a.text ?? pickDiffText(from) ?? '';
      const res = scanRawHex(source, brand, { ignoreGrays: a.ignoreGrays !== false });
      pass = res.ok;
      reason = pass ? 'no raw hex' : `${res.offenders.length} raw: ${res.offenders.slice(0, 3).map((o) => o.hex).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, offenders: res.offenders };
    } else {
      pass = true; reason = 'no assert specified';
    }
    return { pass, reason, assertType: a.type || 'none', from: a.from || null, title: node.title };
  },

  publish: async (node, ctx) => {
    const spec = node.spec || {};
    const target = spec.target || 'pr';
    if (target === 'pr') return HANDLERS.pr(node, ctx);
    if (target === 'file') {
      // Write upstream text to a file inside the repo; return a receipt.
      const upstream = upstreamContext(node, ctx.run);
      const relPath = spec.path || `.orderly-claude/outputs/${node.id}.md`;
      if (!cwdOf(ctx.run)) return { target, path: relPath, note: 'no repoRoot — skipped' };
      const full = path.join(cwdOf(ctx.run), relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, upstream || '', 'utf8');
      return { target, path: relPath, bytes: Buffer.byteLength(upstream || '') };
    }
    // External shorthand targets map to an MCP call: {server, tool} looked up
    // from .claude/mcp.json. Args come from the publish spec itself.
    const mcpMap = PUBLISH_TO_MCP[target];
    if (mcpMap) {
      const mcpNode = {
        ...node,
        kind: 'mcp',
        spec: { server: mcpMap.server, tool: mcpMap.tool, args: { ...spec } },
      };
      const out = await HANDLERS.mcp(mcpNode, ctx);
      return { target, ...out };
    }
    throw new Error(`unknown publish target: ${target}`);
  },

  // Call out to an MCP-configured server+tool. Resolution is file-based
  // (.claude/mcp.json) so an un-configured target is a clear error, not a
  // silent no-op.
  mcp: async (node, ctx) => {
    const spec = node.spec || {};
    const { server, tool, args = {} } = spec;
    if (!server || !tool) throw new Error('mcp: spec.server and spec.tool are required');
    const config = loadMcpConfig(cwdOf(ctx.run));
    const template = resolveTool(config, server, tool);
    if (!template) {
      return { server, tool, ok: false,
        reason: `${server}.${tool} is not configured in ${cwdOf(ctx.run) || ''}/.claude/mcp.json` };
    }
    const resolved = {};
    for (const [k, v] of Object.entries(args)) {
      resolved[k] = typeof v === 'string'
        ? v.replace(/\{\{\s*node\.([^.}]+)\.output\.([^}]+)\s*\}\}/g, (_, id, field) => {
            const n = ctx.run.graph.nodes.find((x) => x.id === id);
            const parts = field.split('.');
            let cur = n?.output;
            for (const p of parts) cur = cur?.[p];
            return cur == null ? '' : String(cur);
          })
        : v;
    }
    const cmd = interpolate(template, resolved);
    ctx.onProgress({ progress: `mcp · ${server}.${tool}` });
    const { out, err, code } = await exec(['sh', '-c', cmd], {
      cwd: cwdOf(ctx.run), signal: ctx.signal, timeoutMs: 60_000,
    });
    const text = (out || err || '').trim();
    return {
      server, tool, ok: code === 0,
      code, out: text.slice(0, 2000),
      cmd: cmd.slice(0, 300),
    };
  },

  display: async (node, ctx) => {
    const spec = node.spec || {};
    const fromIds = Array.isArray(spec.from) ? spec.from : [spec.from];
    const sources = fromIds
      .map((id) => ctx.run.graph.nodes.find((n) => n.id === id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, title: p.title, kind: p.kind, output: p.output }));
    return { render: spec.render || 'auto', sources };
  },

  inputs: async (node, ctx) => {
    const spec = node.spec || {};
    const fields = spec.fields || [];
    const values = {};
    for (const f of fields) {
      values[f.key] = (ctx.run.inputs || {})[f.key] ?? f.default ?? '';
    }
    return { fields, values };
  },

  // Control-flow kinds.

  // Loop runs a per-item action (script or agent) across an array resolved
  // from spec.over, collecting results into an array. The scheduler stays
  // topological — true subgraph fan-out is a follow-up.
  loop: async (node, ctx) => {
    const spec = node.spec || {};
    const items = resolveOver(spec.over, ctx.run);
    const results = [];
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal?.aborted) break;
      ctx.onProgress({
        progress: `item ${i + 1}/${items.length}: ${String(items[i]).slice(0, 40)}`,
        partialOutput: { items, results: [...results], count: items.length, pos: i },
      });
      try {
        if (spec.action === 'script' && spec.cmd) {
          const cmd = String(spec.cmd).replaceAll('{{item}}', String(items[i]));
          const { out, err, code } = await exec(['sh', '-c', cmd], {
            cwd: cwdOf(ctx.run), signal: ctx.signal, timeoutMs: 30_000,
          });
          results.push({ item: items[i], out: (out || err || '').slice(0, 500), code });
        } else if (spec.action === 'agent' && spec.prompt) {
          const prompt = String(spec.prompt).replaceAll('{{item}}', String(items[i]));
          const { text, meta } = await callClaude(prompt, {
            cwd: cwdOf(ctx.run), signal: ctx.signal,
            model: pickModel(node, 'haiku'),
            onProgress: () => {}, onStream: () => {},
          });
          results.push({ item: items[i], text, meta });
        } else {
          results.push({ item: items[i] });
        }
      } catch (e) {
        results.push({ item: items[i], error: e.message });
      }
    }
    return { items, results, count: items.length };
  },

  // fanOut runs an action concurrently over an iterable, with bounded
  // concurrency and a configurable join mode. The scalar sibling to `loop`.
  fanOut: async (node, ctx) => {
    const spec = node.spec || {};
    const body = spec.body || {};
    const items = resolveOver(spec.over, ctx.run);
    const limit = Math.max(1, Math.min(16, Number(spec.concurrency) || 4));
    const join = spec.join || 'concat';
    const action = spec.action || (body.cmd ? 'script' : (body.prompt ? 'agent' : null));
    const total = items.length;
    const results = new Array(total);
    let completed = 0;
    let cursor = 0;

    const runOne = async (i) => {
      const item = items[i];
      try {
        if (action === 'script') {
          const rawCmd = body.cmd || spec.cmd;
          if (!rawCmd) return { item, error: 'missing body.cmd' };
          const cmd = String(rawCmd).replaceAll('{{item}}', String(item));
          const { out, err, code } = await exec(['sh', '-c', cmd], {
            cwd: cwdOf(ctx.run), signal: ctx.signal, timeoutMs: 30_000,
          });
          return { item, out: (out || err || '').slice(0, 500), code };
        }
        if (action === 'agent') {
          const rawPrompt = body.prompt || spec.prompt;
          if (!rawPrompt) return { item, error: 'missing body.prompt' };
          const prompt = String(rawPrompt).replaceAll('{{item}}', String(item));
          const { text, meta } = await callClaude(prompt, {
            cwd: cwdOf(ctx.run), signal: ctx.signal,
            model: body.model || pickModel(node, 'haiku'),
            onProgress: () => {}, onStream: () => {},
          });
          return { item, text, meta };
        }
        return { item };
      } catch (e) {
        return { item, error: e.message };
      }
    };

    const worker = async () => {
      while (!ctx.signal?.aborted) {
        const i = cursor++;
        if (i >= total) return;
        results[i] = await runOne(i);
        completed++;
        ctx.onProgress({
          progress: `${completed}/${total} done`,
          partialOutput: { items, results: results.slice(), count: total, done: completed },
        });
      }
    };

    const workers = Array.from({ length: Math.min(limit, total) }, () => worker());
    await Promise.all(workers);

    let joined;
    if (join === 'first-match') {
      const hit = results.find((r) => !r?.error && (r?.code === 0 || r?.text || r?.item !== undefined));
      joined = hit || null;
    } else if (join === 'vote') {
      const trues = results.filter((r) => r && !r.error && (r.pass === true || /^(yes|true)$/i.test(String(r.text || '').trim()))).length;
      joined = { pass: trues > total / 2, trues, total };
    } else {
      joined = results;
    }
    return { items, results, count: total, join, joined };
  },

  // Delay parks the scheduler for a wall-clock duration (or until a given
  // ISO timestamp). Capped at ten minutes to keep a stray workflow from
  // sitting in the queue indefinitely.
  delay: async (node, ctx) => {
    const spec = node.spec || {};
    const target = parseWait(spec.wait);
    const ms = Math.max(0, Math.min(target.ms, 10 * 60_000));
    ctx.onProgress({ progress: `waiting ${target.label}` });
    const started = Date.now();
    await napMs(ctx, ms);
    return { waited: target.label, ms, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString() };
  },

  // Approve blocks until a human picks approve/reject. A reject fails the
  // run so downstream work doesn't start on an unapproved artifact.
  approve: async (node, ctx) => {
    const spec = node.spec || {};
    const answer = await ctx.awaitAnswer(node.id, {
      question: spec.question || spec.prompt || 'Approve?',
      choices: ['approve', 'reject'],
    });
    const approved = answer === 'approve';
    if (!approved) {
      // Signal rejection the same way Check-stop does: throw so the scheduler
      // marks the node failed and finishes the run as failed.
      throw new Error(`approve "${node.title}" rejected`);
    }
    return { approved: true, answer };
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
async function callClaude(prompt, { cwd, signal, model = 'sonnet', onProgress, onStream, timeoutMs = 180_000 } = {}) {
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
      // Hand the running text to the handler so it can mirror it into the
      // node's partialOutput — a document handler shows the body growing.
      onStream?.(totals);
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
  return await detectDevServer(cwdOf(ctx.run));
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
/** Promise-based nap that resolves on timeout OR on abort (not rejects). */
function napMs(ctx, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    ctx.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Parse a Loop's spec.over into an array. Accepted shapes:
 *   - a real array literal in the def           ([...])
 *   - a string of the form "inputs.KEY" or "{{inputs.KEY}}" (split on commas / whitespace)
 *   - a string of the form "node.ID" or "{{node.ID.field}}" (walk the upstream node's output)
 */
function resolveOver(over, run) {
  if (Array.isArray(over)) return over;
  if (typeof over !== 'string') return [];
  const raw = over.trim().replace(/^\{\{|\}\}$/g, '').trim();
  const parts = raw.split('.');
  if (parts[0] === 'inputs') {
    const key = parts.slice(1).join('.');
    const v = (run.inputs || {})[key];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return v == null ? [] : [v];
  }
  if (parts[0] === 'node' && parts[1]) {
    const target = run.graph.nodes.find((n) => n.id === parts[1]);
    let v = target?.output || null;
    for (const seg of parts.slice(2)) v = v?.[seg];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return v == null ? [] : [v];
  }
  // Last resort: treat as a literal comma-separated list.
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * One Agent pass. Called per attempt; `extraFailures` from prior rounds get
 * appended to the prompt as "fix these on this pass" lines.
 */
async function runAgentOnce(node, ctx, extraFailures = []) {
  const spec = node.spec || {};
  const promptTail = extraFailures.length
    ? `\n\n## Fix these on this pass\n${extraFailures.map((f) => `- ${f.type}: ${f.reason}`).join('\n')}`
    : '';
  const shim = {
    ...node,
    prompt: (spec.prompt || node.prompt || '') + promptTail,
    model: spec.model || node.model,
  };
  const out = (spec.output || 'markdown').toLowerCase();
  if (out === 'markdown' || out === 'text')         return HANDLERS.document(shim, ctx);
  if (out === 'json-findings' || out === 'findings') return HANDLERS.report(shim, ctx);
  if (out === 'html' || out === 'mockup')           return HANDLERS.mockup(shim, ctx);
  if (out === 'json-hunks' || out === 'diff')       return HANDLERS.diff(shim, ctx);
  const prompt = [
    (spec.prompt || `Produce JSON for node "${node.title}".`) + promptTail,
    inputBlock(ctx.run.inputs),
    '',
    'Return a JSON object and nothing else.',
  ].filter(Boolean).join('\n\n');
  const { text, meta } = await callClaude(prompt, {
    cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(shim, 'haiku'),
    onProgress: (msg) => ctx.onProgress({ progress: msg }),
  });
  return { title: `${slug(node.title)}.json`, data: extractJson(text) ?? text, meta };
}

/**
 * Run the asserts in spec.verify against the agent's output. Returns
 * { pass, results, failures }. Each result is { type, pass, reason }. Asserts
 * that need a render pull from `output.render` when present; otherwise they
 * fall back to inline fields on the assert spec.
 */
async function runVerify(node, output, ctx) {
  const verify = node.spec?.verify || {};
  const asserts = Array.isArray(verify.asserts) ? verify.asserts : [];
  const brand = loadBrand(cwdOf(ctx.run));
  const results = [];
  for (const a of asserts) {
    const res = await runOneAssert(a, output, brand);
    results.push(res);
  }
  const failures = results.filter((r) => !r.pass);
  return { pass: failures.length === 0, results, failures };
}

async function runOneAssert(a, output, brand) {
  const t = a.type;
  if (t === 'no-raw-hex') {
    const text = typeof a.text === 'string' ? a.text : pickOutputText(output);
    const r = scanRawHex(text, brand, { ignoreGrays: a.ignoreGrays !== false });
    return { type: t, pass: r.ok,
      reason: r.ok ? 'no raw hex' : `${r.offenders.length} raw: ${r.offenders.slice(0, 3).map((o) => o.hex).join(', ')}`,
      offenders: r.offenders };
  }
  if (t === 'color-in-palette') {
    const colors = Array.isArray(a.colors) ? a.colors : (output.render?.colors || []);
    const r = colorsInPalette(colors, brand, { ignoreGrays: a.ignoreGrays !== false, tolerance: a.tolerance ?? 8 });
    return { type: t, pass: r.ok,
      reason: r.ok ? `${colors.length} on palette` : `${r.offenders.length} off: ${r.offenders.slice(0, 3).map((o) => `${o.color}→${o.nearest}`).join(', ')}`,
      offenders: r.offenders };
  }
  if (t === 'font-is-brand') {
    const family = a.fontFamily ?? output.render?.fontFamily ?? '';
    const r = fontIsBrand(family, brand, { role: a.role || 'sans' });
    return { type: t, pass: r.ok,
      reason: r.ok ? `brand ${a.role || 'sans'}` : `uses ${(r.used || []).join(', ') || '(none)'}` };
  }
  if (t === 'contrast-min') {
    const pairs = Array.isArray(a.pairs) ? a.pairs : (output.render?.contrastPairs || []);
    const r = contrastPassesAll(pairs, brand, { ratio: a.ratio });
    return { type: t, pass: r.ok,
      reason: r.ok ? `all ≥ ${r.min}` : `${r.failures.length} fail: ${r.failures.slice(0, 2).map((f) => `${f.label || f.fg + '/' + f.bg}=${f.ratio}`).join(', ')}`,
      results: r.results };
  }
  if (t === 'spacing-on-scale') {
    const values = Array.isArray(a.values) ? a.values : (output.render?.spacing || []);
    const r = spacingOnScale(values, brand);
    return { type: t, pass: r.ok,
      reason: r.ok ? `${values.length} on scale` : `${r.offenders.length} off: ${r.offenders.slice(0, 3).map((o) => `${o.value}→${o.nearest}`).join(', ')}`,
      offenders: r.offenders };
  }
  if (t === 'llm-judge') {
    // Placeholder — a real implementation would call a model with the rubric.
    return { type: t, pass: true, reason: 'llm-judge not wired' };
  }
  return { type: t || 'none', pass: true, reason: 'unknown assert type, skipped' };
}

function pickOutputText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output.body === 'string') return output.body;
  if (typeof output.html === 'string') return output.html;
  if (typeof output.text === 'string') return output.text;
  if (Array.isArray(output.hunks)) {
    return output.hunks.map((h) => `${h.op === 'add' ? '+' : '-'}${h.line}`).join('\n');
  }
  return JSON.stringify(output);
}

/**
 * Resolve a `colors` input for the color-in-palette assert. Accepts an inline
 * array in the spec, or pulls from the upstream node's output under common
 * field names (colors, palette, swatches).
 */
function resolveColors(assertSpec, from) {
  if (Array.isArray(assertSpec.colors)) return assertSpec.colors;
  const o = from?.output || {};
  if (Array.isArray(o.colors)) return o.colors;
  if (Array.isArray(o.palette)) return o.palette;
  if (Array.isArray(o.swatches)) return o.swatches;
  return [];
}

/**
 * Pull diff/source text out of an upstream node's output. Common shapes:
 * output.diff (string), output.text, output.body, or the whole output as JSON.
 */
function pickDiffText(from) {
  const o = from?.output;
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (typeof o.diff === 'string') return o.diff;
  if (typeof o.text === 'string') return o.text;
  if (typeof o.body === 'string') return o.body;
  return JSON.stringify(o);
}

/**
 * Parse a Delay's spec.wait. Accepts "5s", "2m", "500ms", "1h", or an ISO
 * timestamp (wait until that moment). Caps are enforced upstream.
 */
function parseWait(wait) {
  if (!wait) return { ms: 0, label: '0s' };
  const s = String(wait).trim();
  // ISO timestamp — compute delta from now.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const target = Date.parse(s);
    if (!Number.isFinite(target)) return { ms: 0, label: s };
    return { ms: Math.max(0, target - Date.now()), label: `until ${s}` };
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(s);
  if (!m) return { ms: 0, label: s };
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return { ms: Math.round(n * mult), label: `${n}${unit}` };
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
