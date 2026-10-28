/*
 * Handlers — one per node kind.
 *
 * A handler reads a node + run, does its work, and returns an output object
 * matching what the canvas card renders. It may call onProgress({progress,
 * partialOutput}) along the way so a long-running node shows motion. Throwing
 * marks the node failed and stops the run.
 *
 * This first pass has one real handler (terminal) and real `ask`. The rest
 * write a plausible placeholder output after a short delay so the end-to-end
 * flow is wired and screenshots fill in. Each placeholder is one small
 * function — swap it for a real LLM/skill/capture call as that side lands.
 */
import { spawn } from 'node:child_process';

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
    // The scheduler flips the run to `awaiting-answer`, writes the question,
    // and resolves the promise once a client posts the answer.
    const answer = await awaitAnswer(node.id, {
      question: node.question || node.title,
      choices: node.choices || null,
    });
    return { question: node.question || node.title, answer };
  },

  document: async (node, ctx) => {
    await nap(ctx, 700);
    return {
      title: `${node.title}.md`,
      body: [
        `# ${node.title}`,
        '',
        `Drafted for ${ctx.run.workflowTitle}. Replace this placeholder with a real document handler.`,
        '',
        '## Inputs',
        ...Object.entries(ctx.run.inputs || {}).map(([k, v]) => `- **${k}:** ${v || '—'}`),
      ].join('\n'),
    };
  },

  report: async (node, ctx) => {
    await nap(ctx, 900);
    return {
      title: `${node.title.toLowerCase()}.md · 3 findings`,
      findings: [
        { tag: 'correctness', text: 'None found.' },
        { tag: 'readability', text: 'A placeholder suggestion — replace with a real review handler.' },
        { tag: 'perf',        text: 'Nothing hot on the fast path.' },
      ],
    };
  },

  mockup: async (node, ctx) => {
    await nap(ctx, 1100);
    return { name: `${slug(node.title)}.html`, note: 'Placeholder — a mockup handler lands later.' };
  },

  diff: async (node, ctx) => {
    await nap(ctx, 700);
    return {
      file: 'placeholder.css',
      hunks: [
        { op: 'del', line: '  padding: 24px;' },
        { op: 'add', line: '  padding: 32px;' },
        { op: 'add', line: '  gap: 12px;' },
      ],
    };
  },

  shots: async (node, ctx) => {
    await nap(ctx, 900);
    return { note: 'before/after placeholder' };
  },

  'shots-set': async (node, ctx) => {
    // Walk one route at a time so the grid fills in on-screen.
    const routes = parseRoutes(ctx.run.inputs?.routes) || ['/', '/blog', '/about', '/pricing', '/contact'];
    const pairs = routes.map((r) => ({ route: r, status: 'waits' }));
    for (let i = 0; i < pairs.length; i++) {
      pairs[i].status = 'running';
      onProgressSnapshot(ctx, pairs, i);
      await nap(ctx, 400);
      pairs[i].status = 'done';
      onProgressSnapshot(ctx, pairs, i);
    }
    return { title: `${pairs.length} of ${pairs.length} captured`, pairs };
  },

  pr: async (node, ctx) => {
    await nap(ctx, 500);
    return {
      state: 'open', number: '#—',
      title: ctx.run.inputs?.title || `[placeholder] ${ctx.run.workflowTitle}`,
      bodyPreview: 'Open the PR in GitHub to see the full body.\nThis is a placeholder until the pr handler is wired.',
      url: null,
    };
  },

  _default: async (node, ctx) => {
    await nap(ctx, 500);
    return { note: `output for ${node.kind} (placeholder)` };
  },
};

/* ------------------------------- Helpers -------------------------------- */

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
