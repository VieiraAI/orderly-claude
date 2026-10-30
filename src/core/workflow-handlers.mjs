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
import { screenshot, detectDevServer, pageProblem } from './capture.mjs';
import { putFile } from './blobs.mjs';
import { resolveText, isExplicit } from './refs.mjs';
import { runSpend } from './settings.mjs';
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

/** An error that retrying cannot fix: a missing reference, a rejection. */
function final(message) { return Object.assign(new Error(message), { retryable: false }); }

/**
 * Resolve a node's text against the run. A reference to another node that
 * comes back empty fails the node, naming the reference — a prompt with a
 * silent hole in it produces confident nonsense. An empty input is allowed;
 * the person may have left an optional field blank.
 */
function resolveOrFail(text, ctx, node, opts = {}) {
  const { text: out, missing } = resolveText(text, { run: ctx.run, nodeId: node.id, ...opts });
  const holes = missing.filter((m) => /\{\{\s*nodes\./.test(m));
  if (holes.length) {
    throw final(`${holes.join(', ')} ${holes.length === 1 ? 'was' : 'were'} empty when "${node.title || node.id}" started — check that the step it names produced that field`);
  }
  return out;
}

/** Pick the handler for a kind. Unknown kinds get the generic placeholder. */
export function getHandler(kind) {
  return HANDLERS[kind] || HANDLERS._default;
}

const HANDLERS = {
  terminal: async (node, { run, onProgress, signal, timeoutMs, recordSent, onData }) => {
    const cmd = pickTerminalCommand(node, run);
    const started = Date.now();
    onProgress({ progress: `$ ${cmd.display}` });
    recordSent?.(`$ ${cmd.display}`);
    // Ten minutes by default: a real test suite takes longer than a minute.
    const res = await exec(cmd.argv, { cwd: cwdOf(run), signal, timeoutMs: timeoutMs || 600_000, onData });
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    const text = [res.out, res.err].filter(Boolean).join('\n').trim();
    const output = {
      prompt: `$ ${cmd.display}`,
      // The tail, not the head: the summary line of a test run is at the end.
      out: text.split('\n').slice(-40).join('\n'),
      code: res.code,
      status: res.code === 0 ? `done · ${elapsed} s` : `exit ${res.code} · ${elapsed} s`,
    };
    // A command that failed fails its step, as it would in any build system,
    // unless the author said a failure is something to look at, not to stop on.
    if (res.code !== 0 && !node.spec?.allowFailure && !signal?.aborted) {
      const why = failureLine(text);
      throw Object.assign(new Error(`\`${cmd.display}\` exited ${res.code}${why ? ` — ${why.slice(0, 300)}` : ''}`), { output });
    }
    return output;
  },

  ask: async (node, ctx) => {
    const question = resolveOrFail(node.question || node.title, ctx, node);
    const answer = await ctx.awaitAnswer(node.id, { question, choices: node.choices || null });
    return { question, answer };
  },

  document: async (node, ctx) => {
    const upstream = node.explicit ? '' : upstreamContext(node, ctx.run);
    const prompt = [
      `Draft a focused Markdown document for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is called "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      promptInputs(node, ctx),
      upstream && `## Context from earlier steps\n${upstream}`,
      '',
      `Return only the Markdown body — no preamble, no closing commentary.`,
      `Keep it concise: no more than ~400 words. Start with a single H1.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'haiku'),
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
    const upstream = node.explicit ? '' : upstreamContext(node, ctx.run);
    const prompt = [
      `You are reviewing work produced by the "${ctx.run.workflowTitle}" workflow.`,
      `This review node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      promptInputs(node, ctx),
      upstream && `## What to review\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"findings":[{"tag":"<correctness|readability|perf|security|style>","text":"<one short sentence>"}]}`,
      `List at most five findings, most important first. If there is nothing to flag, return an empty array.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
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
    const upstream = node.explicit ? '' : upstreamContext(node, ctx.run);
    const prompt = [
      `Produce a single self-contained HTML mockup for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      promptInputs(node, ctx),
      upstream && `## Direction from earlier steps\n${upstream}`,
      '',
      // A page can need script (an interactive card, a chart), so it is not
      // limited to CSS, and not cut short at a line count.
      `Return only the HTML (no code fences, no commentary): one self-contained file, with CSS and any JavaScript inline.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const html = stripFences(text);
    return { name: `${slug(node.title)}.html`, html, note: `${html.split('\n').length} lines`, meta };
  },

  diff: async (node, ctx) => {
    const upstream = node.explicit ? '' : upstreamContext(node, ctx.run);
    const prompt = [
      `Propose a small code change for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      promptInputs(node, ctx),
      upstream && `## What to work from\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"file":"<path>","hunks":[{"op":"add"|"del","line":"<raw line, no leading +/-/space>"}]}`,
      `Keep the change tiny — ten hunks or fewer.`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'sonnet'),
      onProgress: (msg) => ctx.onProgress({ progress: msg }),
    });
    const parsed = extractJson(text) || { file: 'unknown', hunks: [] };
    return { file: parsed.file || 'unknown', hunks: parsed.hunks || [], meta };
  },

  pr: async (node, ctx) => {
    const upstream = node.explicit ? '' : upstreamContext(node, ctx.run);
    const prompt = [
      `Draft a GitHub pull request body for the "${ctx.run.workflowTitle}" workflow.`,
      `This node is "${node.title}". ${node.prompt ? node.prompt : ''}`.trim(),
      promptInputs(node, ctx),
      upstream && `## What this PR covers\n${upstream}`,
      '',
      `Return a JSON object with this exact shape and nothing else:`,
      `{"title":"<pr title, under 70 chars>","body":"<short markdown body>"}`,
    ].filter(Boolean).join('\n\n');
    const { text, meta } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(node, 'haiku'),
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
    if (after.problem) return { route, origin, after, shot: after, problem: after.problem, note: `${route}: ${after.problem}` };
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
        if (!after) pairs[i].status = 'failed';
        else if (after.problem) { pairs[i].status = 'failed'; pairs[i].error = after.problem; }
        else pairs[i].status = 'done';
      } catch (e) {
        pairs[i].status = 'failed';
        pairs[i].error = e.message;
      }
      onProgressSnapshot(ctx, pairs, i);
    }
    const done = pairs.filter((p) => p.status === 'done').length;
    const broken = pairs.filter((p) => p.error).map((p) => `${p.route}: ${p.error}`);
    const note = broken.length
      ? `Not counted — ${broken.join('; ')}. Is ${origin} the app you meant?`
      : !baselineOrigin && baselineName
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
    const verify = node.spec?.verify;
    const maxRetries = Number(verify?.maxRetries ?? 0);
    const attempts = [];
    let output;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // A retry revises the last draft against the last verdict only. Older
      // complaints were about drafts that no longer exist.
      const last = attempts[attempts.length - 1];
      const revise = last ? { draft: draftText(output), failures: last.failures } : null;
      output = await runAgentOnce(node, ctx, revise);
      if (!verify) return output;
      const result = await runVerify(node, output, ctx);
      attempts.push({ attempt, pass: result.pass, failures: result.failures });
      if (result.pass || attempt === maxRetries) {
        output.verify = { pass: result.pass, attempts, results: result.results };
        if (!result.pass && (verify.onFail || 'stop') === 'stop') {
          // The step fails, but its last draft and verdicts stay on it to read.
          throw Object.assign(final(`verify failed: ${result.failures.map((f) => f.reason).join('; ')}`), { output });
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
    if (spec.op === 'find-dev-server') {
      const origin = await pickOrigin(ctx);
      if (!origin) {
        throw final('No dev server is running for this project. Start it (for example `npm run dev`), or give its address in "Dev server URL", then run again.');
      }
      return { origin, out: `found ${origin}`, code: 0 };
    }
    // Shell command — reuse the terminal handler with the cmd shimmed on.
    // Substituted values are quoted, so an output cannot become a command.
    const raw = spec.cmd || node.command;
    const command = typeof raw === 'string' ? resolveOrFail(raw, ctx, node, { mode: 'shell' }) : raw;
    const live = watchScript(spec.show, ctx, node);
    let output;
    try {
      output = await HANDLERS.terminal({ ...node, command }, { ...ctx, onData: live.onData });
    } finally {
      live.stop();
    }
    // Pictures or clips the command made, shown on the run page — so a
    // person can see what they are about to approve. Unlike the live view,
    // this shows every match, so a step that skipped pictures it had already
    // drawn still shows them at the end.
    if (spec.show) output.images = collectShown(spec.show, ctx, node, live.stored);
    return output;
  },

  decision: async (node, ctx) => {
    const spec = node.spec || {};
    const options = spec.options || [];
    const askNode = {
      ...node,
      question: resolveOrFail(spec.question || node.title, ctx, node),
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
      const broken = pairs.filter((p) => p.error);
      if (pairs.length > 0 && skipped === pairs.length) {
        // Nothing was captured because there was nothing to capture against.
        // That is not a pass: a green tick here would claim pages were checked.
        pass = !!a.allowNone;
        reason = 'no dev server found, so nothing was captured';
      } else {
        pass = done >= min;
        reason = `${done} of ${pairs.length} captured${pass ? '' : `, need ${min}`}`
          + (broken.length ? ` — ${broken.length} were error or blank pages (${broken.slice(0, 2).map((p) => `${p.route}: ${p.error}`).join('; ')})` : '');
      }
    } else if (a.type === 'contains') {
      const haystack = JSON.stringify(from?.output || '');
      const needle = resolveOrFail(String(a.needle ?? ''), ctx, node);
      pass = needle !== '' && haystack.includes(needle);
      reason = pass ? `found "${needle}"` : `missing "${needle}"`;
    } else if (a.type === 'manual') {
      const answer = await ctx.awaitAnswer(node.id, {
        question: a.question || spec.question || `Does ${from?.title || 'the upstream'} look right?`,
        choices: ['yes', 'no'],
      });
      pass = answer === 'yes';
      reason = answer;
    } else if (a.type === 'color-in-palette') {
      const brand = loadBrand(cwdOf(ctx.run));
      const colors = resolveColors(a, from).length ? resolveColors(a, from) : renderDataOf(from).colors;
      const res = colorsInPalette(colors, brand, { ignoreGrays: a.ignoreGrays !== false, tolerance: a.tolerance ?? 8 });
      pass = res.ok;
      reason = pass
        ? `${colors.length} on palette`
        : `${res.offenders.length} off palette: ${res.offenders.slice(0, 3).map((o) => `${o.color}→${o.nearest}`).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, offenders: res.offenders };
    } else if (a.type === 'font-is-brand') {
      const brand = loadBrand(cwdOf(ctx.run));
      const family = a.fontFamily ?? from?.output?.fontFamily ?? renderDataOf(from).fontFamily;
      const res = fontIsBrand(family, brand, { role: a.role || 'sans' });
      pass = res.ok;
      reason = pass ? `brand ${a.role || 'sans'}` : `uses ${res.used?.join(', ') || '(none)'}, want ${res.want?.join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title };
    } else if (a.type === 'contrast-min') {
      const brand = loadBrand(cwdOf(ctx.run));
      const pairs = a.pairs ?? renderDataOf(from).contrastPairs;
      const res = contrastPassesAll(pairs, brand, { ratio: a.ratio });
      pass = res.ok;
      reason = pass
        ? `all ≥ ${res.min}`
        : `${res.failures.length} fail: ${res.failures.slice(0, 2).map((f) => `${f.label || f.fg + '/' + f.bg}=${f.ratio}`).join(', ')}`;
      return { pass, reason, assertType: a.type, from: a.from || null, title: node.title, results: res.results };
    } else if (a.type === 'spacing-on-scale') {
      const brand = loadBrand(cwdOf(ctx.run));
      const values = a.values ?? from?.output?.spacing ?? renderDataOf(from).spacing;
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
      // Write to a file inside the repo; return a receipt. `content` may name
      // exactly what to write; without it, every parent's output is written.
      const body = spec.content
        ? resolveOrFail(spec.content, ctx, node)
        : upstreamContext(node, ctx.run);
      const relPath = resolveOrFail(spec.path || `.orderly-claude/outputs/${node.id}.md`, ctx, node);
      if (!cwdOf(ctx.run)) return { target, path: relPath, note: 'no repoRoot — skipped' };
      const root = path.resolve(cwdOf(ctx.run));
      const full = path.resolve(root, relPath);
      // A path, possibly built from a model's output, may not leave the repo.
      if (full !== root && !full.startsWith(root + path.sep)) {
        throw final(`refusing to write outside the project: ${relPath}`);
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body || '', 'utf8');
      ctx.recordSent?.(body || '');
      return { target, path: path.relative(root, full), bytes: Buffer.byteLength(body || ''), body: (body || '').slice(0, 4000) };
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
  // from spec.over, collecting results into an array. Bounded twice: `max`
  // items (50 unless raised, never past 500) so a list a model produced
  // cannot turn into ten thousand calls, and `concurrency` at once.
  loop: async (node, ctx) => {
    const spec = node.spec || {};
    const all = resolveOver(spec.over, ctx.run);
    const max = Math.min(500, Math.max(1, Number(spec.max) || 50));
    const items = all.slice(0, max);
    const width = Math.min(8, Math.max(1, Number(spec.concurrency) || 1));
    const results = new Array(items.length);
    const limit = Number(ctx.run.budgetUsd) || 0;
    let spent = 0, done = 0, halted = null, next = 0;
    const report = (i) => ctx.onProgress({
      progress: `item ${done}/${items.length}${i != null ? `: ${String(items[i]).slice(0, 40)}` : ''}`,
      partialOutput: { items, results: results.filter(Boolean), count: items.length, pos: done },
    });

    const one = async (i) => {
      const item = items[i];
      try {
        if (spec.action === 'script' && spec.cmd) {
          const cmd = resolveOrFail(String(spec.cmd), ctx, node, { item, mode: 'shell' });
          const { out, err, code } = await exec(['sh', '-c', cmd], {
            cwd: cwdOf(ctx.run), signal: ctx.signal, timeoutMs: ctx.timeoutMs || 120_000,
          });
          results[i] = { item, out: (out || err || '').slice(0, 2000), code };
        } else if (spec.action === 'agent' && spec.prompt) {
          const prompt = resolveOrFail(String(spec.prompt), ctx, node, { item });
          const { text, meta } = await callClaude(prompt, {
            cwd: cwdOf(ctx.run), signal: ctx.signal, timeoutMs: ctx.timeoutMs,
            model: pickModel({ model: spec.model || node.model }, 'haiku'),
            onProgress: () => {}, onStream: () => {},
          });
          spent += Number(meta?.cost) || 0;
          results[i] = { item, text, meta };
        } else {
          results[i] = { item };
        }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        results[i] = { item, error: e.message };
      }
      done++;
      report(i);
    };

    const worker = async () => {
      while (next < items.length && !ctx.signal?.aborted && !halted) {
        // The run's spend limit applies inside a loop too, between items.
        if (limit && runSpend(ctx.run) + spent >= limit) { halted = 'budget'; break; }
        await one(next++);
      }
    };
    ctx.recordSent?.(spec.action === 'agent' ? String(spec.prompt || '') : String(spec.cmd || ''));
    report(null);
    await Promise.all(Array.from({ length: Math.min(width, items.length || 1) }, worker));

    const ran = results.filter(Boolean);
    const notes = [];
    if (all.length > max) notes.push(`ran the first ${max} of ${all.length} items — raise the loop's limit to run more`);
    if (halted) notes.push(`stopped after ${ran.length} of ${items.length} items at the run's spend limit`);
    const failed = ran.filter((r) => r.error || (r.code != null && r.code !== 0)).length;
    if (failed) notes.push(`${failed} item${failed === 1 ? '' : 's'} failed`);
    return {
      items, results: ran, count: items.length, total: all.length,
      ...(notes.length ? { note: notes.join('; ') } : {}),
      ...(halted ? { halted } : {}),
      ...joinResults(spec.join, ran),
      // One cost for the whole loop, so totals add up without counting twice.
      ...(spent ? { meta: { model: 'loop', cost: spent, elapsed: null } } : {}),
    };
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
    const question = resolveOrFail(spec.question || spec.prompt || 'Approve?', ctx, node);
    const answer = await ctx.awaitAnswer(node.id, { question, choices: ['approve', 'reject'] });
    const approved = answer === 'approve';
    if (!approved) {
      // Signal rejection the same way Check-stop does: throw so the scheduler
      // marks the node failed and finishes the run as failed. Never retried.
      throw final(`approve "${node.title}" rejected`);
    }
    // Keep the question: the run page says what was approved, not just that something was.
    return { approved: true, answer, question };
  },

  _default: async (node, ctx) => {
    await nap(ctx, 300);
    return { note: `output for ${node.kind} (placeholder — no handler wired)` };
  },
};

/* ---------------------------- files to show ------------------------------ */

const SHOWABLE = /\.(png|jpe?g|gif|webp|svg|mp4|webm)$/i;
const SHOW_MAX = 48;

/**
 * Files a step asked to show, copied into the blob store so the run page can
 * display them after the files themselves have changed or gone. `show` is a
 * comma-separated list of paths inside the project; the last part of each
 * may use `*`. Anything outside the project is ignored.
 */
function collectShown(show, ctx, node, stored) {
  return matchShown(show, ctx, node).map(({ file, name, kind }) => ({ ref: storedRef(file, stored) || putFile(file), name, kind }));
}

/** The files a step's show globs match, in order, inside the project only. */
function matchShown(show, ctx, node) {
  const root = cwdOf(ctx.run) ? path.resolve(cwdOf(ctx.run)) : null;
  if (!root) return [];
  const patterns = resolveOrFail(String(show), ctx, node).split(',').map((x) => x.trim()).filter(Boolean);
  const found = [];
  for (const pattern of patterns) {
    const full = path.resolve(root, pattern);
    if (full !== root && !full.startsWith(root + path.sep)) continue;
    const dir = path.dirname(full);
    const base = path.basename(full);
    let names = [base];
    if (base.includes('*')) {
      const re = new RegExp(`^${base.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      try { names = fs.readdirSync(dir).filter((n) => re.test(n)).sort(); } catch { names = []; }
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (!SHOWABLE.test(name) || !fs.existsSync(file) || found.some((f) => f.file === file)) continue;
      found.push({ file, name: path.relative(root, file), kind: /\.(mp4|webm)$/i.test(name) ? 'video' : 'image' });
      if (found.length >= SHOW_MAX) break;
    }
  }
  return found;
}

/** The blob already kept for a file, if it has not changed since. */
function storedRef(file, stored) {
  if (!stored) return null;
  try {
    const st = fs.statSync(file);
    return stored.get(`${file}:${st.size}:${st.mtimeMs}`) || null;
  } catch { return null; }
}

// How often a running command step looks for new pictures and output.
const LIVE_TICK_MS = 2000;

/**
 * Show a running command step's progress: the last few lines it printed and,
 * when it has show globs, each picture as soon as it is finished — a step
 * that draws twenty pictures over a quarter of an hour shows each one as it
 * lands, not all of them at the end.
 *
 * A picture is kept only once it has stopped growing (same size and time on
 * two looks in a row), so a half-written file never shows. A picture that
 * was already there when the step started and has not changed since is not
 * shown while it runs: it is not this run's work. The final collect still
 * shows it.
 *
 * Steps without show globs never look at the disk; the timer only sends the
 * output when it changed.
 */
function watchScript(show, ctx, node) {
  const stored = new Map();   // file:size:mtime → blob ref
  let recent = '';
  let sent = '';
  let timer = null;
  const onData = (d) => { recent = (recent + d).slice(-4000); };
  const tail = () => recent.split('\n')
    // A progress bar redraws its line with \r; keep what it says last.
    .map((l) => l.split('\r').pop().trimEnd().slice(0, 200))
    .filter(Boolean).slice(-6).join('\n');
  let before = null;          // file → mtime when the step started
  const last = new Map();     // file → size:mtime at the previous look
  if (show) {
    try {
      before = new Map(matchShown(show, ctx, node).map((f) => [f.file, statKey(f.file)]));
    } catch { show = null; }
    // A step run again starts with an empty view, not last time's pictures.
    ctx.onProgress({ partialOutput: { images: [], out: '' } });
  }
  sent = JSON.stringify(show ? { out: '', images: [] } : { out: '' });
  const look = () => {
    try {
      const update = { out: tail() };
      if (show) {
        const images = [];
        for (const f of matchShown(show, ctx, node)) {
          const now = statKey(f.file);
          if (!now || before.get(f.file) === now) continue;
          const key = `${f.file}:${now}`;
          if (!stored.has(key) && last.get(f.file) === now) stored.set(key, putFile(f.file));
          last.set(f.file, now);
          if (stored.has(key)) images.push({ ref: stored.get(key), name: f.name, kind: f.kind });
        }
        update.images = images;
      }
      const sig = JSON.stringify(update);
      if (sig === sent) return;
      sent = sig;
      ctx.onProgress({ partialOutput: update });
    } catch { /* a file went away between looks; try again next time */ }
  };
  timer = setInterval(look, LIVE_TICK_MS);
  return { onData, stored, stop: () => clearInterval(timer) };
}

function statKey(file) {
  try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}

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
// A designed page or a long review can take a few minutes. A step that
// needs a different limit sets "Give up after".
const CLAUDE_DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function callClaude(prompt, { ctx, cwd, signal, model = 'sonnet', onProgress, onStream, timeoutMs = CLAUDE_DEFAULT_TIMEOUT_MS } = {}) {
  ctx?.recordSent?.(prompt);
  if (ctx?.timeoutMs) timeoutMs = ctx.timeoutMs;
  if (process.env.ORDERLY_HANDLER_MODE === 'mock') {
    onProgress?.('claude · mock');
    // A mock that can be slow, so timeouts can be tested without the API.
    const delay = Number(process.env.ORDERLY_MOCK_DELAY_MS) || 120;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
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
  const { finalPayload, text, code, err, timedOut } = await execStream(argv, {
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
    if (timedOut) {
      throw new Error(`Claude had not finished after ${Math.round(timeoutMs / 60_000) || '<1'} min, so the step was stopped. Raise "Give up after" on this step if it needs longer.`);
    }
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
    // No stdin: the CLI otherwise waits for it and prints a warning that
    // ends up in the error message instead of the real reason.
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let finalPayload = null;
    let timedOut = false;
    let text = '';
    let tokens = 0;
    let err = '';
    let stdoutBuf = '';
    let timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    signal?.addEventListener('abort', () => killTree(child), { once: true });
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
    child.on('close', (code) => { clearTimeout(timer); resolve({ finalPayload, text, code: code ?? -1, err, timedOut }); });
    child.on('error', (e)   => { clearTimeout(timer); resolve({ finalPayload: null, text: '', code: -1, err: e.message }); });
  });
}

/** A deterministic stub for each prompt shape. Keeps the output shape close
 *  enough to the real thing that downstream parsers behave the same. */
function mockReply(prompt, model) {
  // ORDERLY_MOCK_COST lets the suite exercise spend limits without spending.
  const meta = { model: `mock-${model}`, cost: Number(process.env.ORDERLY_MOCK_COST) || 0, elapsed: '0.1 s', sessionId: 'mock', tokens: 0 };
  if (/Return a JSON verdict object/i.test(prompt)) {
    // Fails when the rubric says so, so tests can drive both outcomes.
    const fail = /MOCK_FAIL/.test(prompt);
    return { text: JSON.stringify({ pass: !fail, reason: fail ? 'mock judge failed it' : 'mock judge passed it' }), meta };
  }
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
  // A short story, page by page, so the run page's book pages can be tested.
  if (/MOCK_PAGES/.test(prompt)) {
    const pages = [1, 2, 3, 4, 5].map((page) => ({ page, text: `Mock page ${page}. The hare ran on.` }));
    return { text: JSON.stringify({ title: 'Mock story', pages }), meta };
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

/**
 * The run's inputs, as a block at the end of a prompt — unless the prompt
 * already names what it uses ({{inputs.x}} or {{nodes.y…}}). Then it gets
 * only those: a template brief handed the real roster as well tends to bake
 * real names into what should stay blank.
 */
/**
 * The line that says why a command failed. A crash ends in a stack trace and
 * a dump of the error object, so the last lines say nothing; the line naming
 * the error does. Falls back to the last lines.
 */
function failureLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // "TypeError: …", "Error: Command failed: …" — what a crash says first.
  const thrown = lines.find((l) => /^[A-Z]\w*(Error|Exception): /.test(l));
  if (thrown) return thrown;
  const named = lines.filter((l) => !/new \w*Error\(/.test(l)).filter((l) => !/^at\s/.test(l) && /(^|\s|:)(\w*Error|error|fatal|failed|not found|cannot|can't|refused)\b/i.test(l)
    && !/^(code|status|signal|stdout|stderr|output|pid):/i.test(l));
  if (named.length) return named[0];
  return lines.slice(-3).join(' · ');
}

function promptInputs(node, ctx) {
  const authored = String(node.spec?.prompt ?? node.prompt ?? '');
  if (node.explicit || /\{\{\s*(inputs|nodes)\./.test(authored)) return '';
  return inputBlock(ctx.run.inputs);
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
 *
 * `want` keeps only objects that pass a test; `last` takes the last such
 * object instead of the first. Both read every top-level `{...}` in the text,
 * so a broken object followed by a fixed one still yields the fixed one.
 */
export function extractJson(text, { want = null, last = false } = {}) {
  const t = String(text || '').trim();
  if (want || last) {
    const found = jsonObjectsIn(t).filter((o) => !want || want(o));
    return (last ? found[found.length - 1] : found[0]) ?? null;
  }
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
  return jsonObjectsIn(t)[0] ?? null;
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * Every top-level `{...}` in the text that parses, in order. Braces inside
 * strings do not count. An object that does not parse is skipped whole; one
 * that never closes is skipped one character on, so a later object is found.
 */
function jsonObjectsIn(text) {
  const out = [];
  let i = text.indexOf('{');
  // A guard against pathological input: plenty for any real reply.
  for (let tries = 0; i >= 0 && tries < 200; tries++) {
    const end = closingBrace(text, i);
    if (end < 0) { i = text.indexOf('{', i + 1); continue; }
    const parsed = tryParse(text.slice(i, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    i = text.indexOf('{', end + 1);
  }
  return out;
}

/** Index of the brace that closes the one at `start`, or -1. */
function closingBrace(text, start) {
  let depth = 0, inString = false, escaped = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

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
  const res = await screenshot(url, tmp, { width: 1400, height: 1000, probe: true });
  if (!res.ok) return null;
  const ref = putFile(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  return { url, ref, capturedAt: new Date().toISOString(), page: res.page || null, problem: pageProblem(res.page) };
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
  if ((parts[0] === 'node' || parts[0] === 'nodes') && parts[1]) {
    const target = run.graph.nodes.find((n) => n.id === parts[1]);
    let v = target?.output || null;
    const path = parts[0] === 'nodes' && parts[2] === 'output' ? parts.slice(3) : parts.slice(2);
    for (const seg of path) v = v?.[seg];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return v == null ? [] : [v];
  }
  // Last resort: treat as a literal comma-separated list.
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * What a loop hands on besides every result: the first one that worked, or
 * whether most items said yes. `concat` (the default) adds nothing.
 */
function joinResults(join, ran) {
  const ok = (r) => !r.error && (r.code == null || r.code === 0);
  if (join === 'first-match') return { join, joined: ran.find(ok) || null };
  if (join === 'vote') {
    const yes = ran.filter((r) => ok(r) && (r.pass === true || /^\s*(yes|true|pass)\b/i.test(String(r.text ?? r.out ?? '')))).length;
    return { join, joined: { pass: yes > ran.length / 2, yes, of: ran.length } };
  }
  return {};
}

/**
 * One Agent pass. Called per attempt. On a retry, `revise` carries the last
 * draft and what the checks found wrong with it, so the model corrects that
 * draft instead of writing a new one with new flaws.
 */
async function runAgentOnce(node, ctx, revise = null) {
  const spec = node.spec || {};
  const authored = spec.prompt || node.prompt || '';
  let prompt = resolveOrFail(authored, ctx, node);
  // Skills are named, not forced: the CLI decides whether one applies.
  const uses = (spec.uses || []).filter(Boolean);
  if (uses.length) prompt += `\n\nUse ${uses.length === 1 ? 'this skill' : 'these skills'} where ${uses.length === 1 ? 'it applies' : 'they apply'}: ${uses.join(', ')}.`;
  if (revise) prompt += revisionBlock(revise);
  // Shim the spec onto the node so legacy handlers see their fields. A
  // prompt that names its own references gets those and nothing else.
  const shim = { ...node, prompt, model: spec.model || node.model, explicit: isExplicit(authored) };
  const out = (spec.output || 'markdown').toLowerCase();
  if (out === 'markdown' || out === 'text')  return HANDLERS.document(shim, ctx);
  if (out === 'json-findings' || out === 'findings') return HANDLERS.report(shim, ctx);
  if (out === 'html' || out === 'mockup')    return HANDLERS.mockup(shim, ctx);
  if (out === 'json-hunks' || out === 'diff') return HANDLERS.diff(shim, ctx);
  // Generic JSON — reuse the report-shape parser but return .data instead.
  const upstream = shim.explicit ? '' : upstreamContext(node, ctx.run);
  const jsonPrompt = [
    prompt || `Produce JSON for node "${node.title}".`,
    promptInputs(node, ctx),
    upstream && `## Context from earlier steps\n${upstream}`,
    '',
    'Return a JSON object and nothing else.',
  ].filter(Boolean).join('\n\n');
  const { text, meta } = await callClaude(jsonPrompt, {
    ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: pickModel(shim, 'haiku'),
    onProgress: (msg) => ctx.onProgress({ progress: msg }),
  });
  return { title: `${slug(node.title)}.json`, data: extractJson(text) ?? text, meta };
}

// Long drafts are cut so a retry prompt stays a sensible size.
const DRAFT_MAX_CHARS = 20_000;

/** The retry section: the last draft, its problems, and what to send back. */
function revisionBlock({ draft, failures }) {
  let text = String(draft || '');
  const cut = text.length > DRAFT_MAX_CHARS;
  if (cut) text = text.slice(0, DRAFT_MAX_CHARS);
  return [
    '',
    '## Your previous draft',
    cut ? `(Cut at ${DRAFT_MAX_CHARS} characters; the full draft was longer.)` : null,
    text,
    '## Reviewers found these problems',
    (failures || []).map((f) => `- ${f.type}: ${f.reason}`).join('\n') || '- (no details given)',
    '## What to return',
    'Return the full corrected work in the same format as before. Fix only these problems and change nothing else that works.',
  ].filter((x) => x !== null).join('\n\n');
}

/**
 * The draft as the model should see it again: the text it wrote, without the
 * bookkeeping (cost, render data) the engine added. JSON kinds come back as
 * JSON, so the model sees the shape it has to return.
 */
function draftText(output) {
  if (!output || typeof output !== 'object') return pickOutputText(output);
  if (typeof output.body === 'string' || typeof output.html === 'string') return pickOutputText(output);
  const { meta, render, verify, title, ...rest } = output;
  const shown = 'data' in rest ? rest.data : rest;
  return typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2);
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
  const renders = (verify.renders || []).map((r) => (typeof r === 'string' ? { route: r } : r)).filter((r) => r.route);
  if (renders.length) {
    const rendered = await renderForVerify(renders, ctx);
    output.render = rendered.render;
    results.push(...rendered.results);
  }
  for (const a of asserts) {
    results.push(await runOneAssert(a, output, brand, ctx));
  }
  const failures = results.filter((r) => !r.pass);
  return { pass: failures.length === 0, results, failures };
}

/**
 * Look at the work: screenshot each route and read what it rendered with.
 * A route that comes back as an error or blank page fails on its own, before
 * any brand check runs against it.
 */
async function renderForVerify(renders, ctx) {
  const origin = await pickOrigin(ctx);
  if (!origin) {
    return { render: null, results: [{ type: 'render', pass: false,
      reason: 'no dev server found to look at the result — start one, or set inputs.devUrl' }] };
  }
  const render = { origin, shots: [], colors: [], spacing: [], contrastPairs: [], fontFamily: '' };
  const results = [];
  const colors = new Set(), spacing = new Set();
  for (const r of renders) {
    const route = r.route.startsWith('/') ? r.route : `/${r.route}`;
    const shot = await captureShot(`${origin}${route}`, ctx.signal);
    if (!shot) { results.push({ type: 'render', pass: false, reason: `${route}: capture failed` }); continue; }
    render.shots.push({ route, ref: shot.ref, label: r.label || route });
    if (shot.problem) { results.push({ type: 'render', pass: false, reason: `${route}: ${shot.problem}` }); continue; }
    const pg = shot.page || {};
    (pg.colors || []).forEach((c) => colors.add(c));
    (pg.spacing || []).forEach((v) => spacing.add(v));
    render.contrastPairs.push(...(pg.contrastPairs || []).map((p) => ({ ...p, label: `${route} ${p.label}` })));
    if (!render.fontFamily) render.fontFamily = pg.fontFamily || '';
  }
  render.colors = [...colors];
  render.spacing = [...spacing];
  return { render, results };
}

async function runOneAssert(a, output, brand, ctx) {
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
    if (!a.rubric) return { type: t, pass: false, reason: 'no rubric given' };
    const prompt = [
      'You are checking a piece of work against a rubric. Be strict: pass only if the work clearly meets it.',
      `## Rubric\n${a.rubric}`,
      `## The work\n${pickOutputText(output).slice(0, 12000)}`,
      'Return a JSON verdict object and nothing else: {"pass": true|false, "reason": "<one sentence>"}',
      'Your reply must be exactly one JSON object, with no corrections or text after it.',
    ].join('\n\n');
    const { text } = await callClaude(prompt, {
      ctx, cwd: cwdOf(ctx.run), signal: ctx.signal, model: a.model || 'haiku',
      onProgress: (msg) => ctx.onProgress({ progress: `judging · ${msg}` }),
    });
    // A judge that corrects itself sends more than one object; its last
    // verdict is the one it means.
    const verdict = extractJson(text, { want: (o) => typeof o.pass === 'boolean', last: true });
    if (!verdict || typeof verdict.pass !== 'boolean') return { type: t, pass: false, reason: 'the judge gave no clear verdict' };
    return { type: t, pass: verdict.pass, reason: String(verdict.reason || (verdict.pass ? 'meets the rubric' : 'misses the rubric')) };
  }
  // An unknown check is a failure: passing it would claim something was checked.
  return { type: t || 'none', pass: false, reason: `unknown check "${t}"` };
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
 * What an earlier step rendered: an Ask Claude step that looked at its work
 * (output.render), or a screenshot step (its captured pages). Every page that
 * loaded is merged, so one check covers all the routes.
 */
function renderDataOf(from) {
  const o = from?.output || {};
  if (o.render) return { colors: [], spacing: [], contrastPairs: [], fontFamily: '', ...o.render };
  const pages = [o.after?.page, ...(o.pairs || []).filter((p) => p.status === 'done').map((p) => p.after?.page)].filter(Boolean);
  const colors = new Set(), spacing = new Set(), contrastPairs = [];
  for (const pg of pages) {
    (pg.colors || []).forEach((c) => colors.add(c));
    (pg.spacing || []).forEach((v) => spacing.add(v));
    contrastPairs.push(...(pg.contrastPairs || []));
  }
  return { colors: [...colors], spacing: [...spacing], contrastPairs, fontFamily: pages[0]?.fontFamily || '' };
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
  return { argv: ['sh', '-c', `echo "node ${node.id}"`], display: `# ${node.id}` };
}

/*
 * Kill a child and everything it started. `sh -c 'sleep 600'` forks, and
 * killing only the shell leaves the sleep holding the output pipe open, so
 * the step would still wait the full ten minutes. Children are spawned as
 * their own process group so the whole group can be signalled.
 */
function killTree(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
}

function exec(argv, { cwd, signal, timeoutMs = 30_000, onData }) {
  return new Promise((resolve) => {
    let out = '', err = '', timer = null;
    // Python holds its output back when it is not printing to a screen; ask
    // it not to, so a step watched live shows what it says as it says it.
    const env = onData ? { ...process.env, PYTHONUNBUFFERED: '1' } : process.env;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true });
    const kill = (reason) => { killTree(child); out += reason ? `\n[${reason}]` : ''; };
    timer = setTimeout(() => kill('timeout'), timeoutMs);
    signal?.addEventListener('abort', () => kill('aborted'), { once: true });
    child.stdout.on('data', (d) => { out += d.toString(); onData?.(d.toString()); });
    child.stderr.on('data', (d) => { err += d.toString(); onData?.(d.toString()); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code: code ?? -1 }); });
    child.on('error', (e)   => { clearTimeout(timer); resolve({ out, err: e.message, code: -1 }); });
  });
}
