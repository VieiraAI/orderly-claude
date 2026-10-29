/*
 * Scheduler for one workflow run.
 *
 * March the graph: a node turns `running` the moment every upstream node is
 * `done`; its handler produces an output; the node turns `done` and persists.
 * In-flight nodes run concurrently when their topology allows it. One
 * Scheduler per run, held by the server in a Map while the run is alive.
 *
 * Three exit states:
 *   done           — every node reached done
 *   failed         — a handler threw; remaining pending nodes stay pending
 *   stopped        — the user hit Stop
 *
 * One pause state:
 *   awaiting-answer — an `ask` node is open; the handler's promise resolves
 *   when a client posts an answer, and the scheduler marches on from there.
 */
import { EventEmitter } from 'node:events';
import { getHandler } from './workflow-handlers.mjs';
import { writeRun } from './workflows.mjs';
import { removeWorktree } from './worktree.mjs';

export class Scheduler extends EventEmitter {
  constructor(run) {
    super();
    this.run = run;
    this.aborted = false;
    this.ac = new AbortController();
    this.inFlight = new Map();        // nodeId → promise
    this.pendingAnswers = new Map();  // nodeId → { resolve, reject }
  }

  start() {
    // Fire-and-forget; errors land on the run itself as `failed`.
    this.tick().catch((e) => this.failRun(e));
    return this;
  }

  /** Mark the run stopped. Any in-flight handler is signaled to abort. */
  stop() {
    if (terminal(this.run.status)) return false;
    this.aborted = true;
    this.ac.abort();
    for (const { reject } of this.pendingAnswers.values()) {
      reject(new Error('stopped'));
    }
    this.pendingAnswers.clear();
    this.patch({ status: 'stopped', endedAt: new Date().toISOString() });
    this.cleanupSandbox('stopped');
    return true;
  }

  /** Answer an open `ask` node. Resolves its handler promise. */
  answer(nodeId, answer) {
    const slot = this.pendingAnswers.get(nodeId);
    if (!slot) return false;
    this.pendingAnswers.delete(nodeId);
    slot.resolve(answer);
    return true;
  }

  /* ----------------------------- internals ----------------------------- */

  async tick() {
    while (!terminal(this.run.status) && !this.aborted) {
      // After a Decision picks a branch (or a Check with onFail: 'skip' fails),
      // some pending nodes are now unreachable. Mark them skipped so they
      // don't block the run from finishing.
      this.pruneSkipped();
      const ready = this.readyNodes();
      if (!ready.length) {
        if (this.inFlight.size === 0) {
          // Nothing running and nothing ready. Done, or stuck.
          const allSettled = this.run.graph.nodes.every((n) => isTerminalNode(n.status));
          if (allSettled) this.finish('done');
          else this.failRun(new Error('stuck: nodes unreachable from any root'));
          return;
        }
        // Something is in flight; wait for it to settle.
        await Promise.race([...this.inFlight.values()]);
        continue;
      }
      // Kick off every ready node concurrently.
      for (const n of ready) this.runNode(n);
      // Yield so a race finishes before we check again.
      if (this.inFlight.size) await Promise.race([...this.inFlight.values()]);
    }
  }

  readyNodes() {
    const byId = Object.fromEntries(this.run.graph.nodes.map((n) => [n.id, n]));
    return this.run.graph.nodes.filter((n) => {
      if (n.status !== 'pending') return false;
      // Only consider parents reached via a *live* edge — a Decision that
      // picked another branch doesn't gate its unpicked downstream.
      const parents = (this.run.graph.edges || [])
        .filter(([a, b, lbl]) => b === n.id && edgeIsLive(byId[a], lbl))
        .map(([a]) => byId[a]);
      if (parents.length === 0) {
        // If every incoming edge is dead and the source is settled, this
        // branch isn't going to run — pruneSkipped handled it. Otherwise
        // it's a true root with no edges in: ready immediately.
        const anyIncoming = (this.run.graph.edges || []).some(([, b]) => b === n.id);
        return !anyIncoming;
      }
      return parents.every((p) => p && p.status === 'done');
    });
  }

  /**
   * Walk from roots forward along *live* edges to find reachable node ids.
   * Any pending node not in the reachable set is marked `skipped`. Idempotent;
   * safe to call every tick.
   */
  pruneSkipped() {
    const nodes = this.run.graph.nodes;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const edges = this.run.graph.edges || [];
    const incoming = Object.fromEntries(nodes.map((n) => [n.id, []]));
    for (const e of edges) incoming[e[1]]?.push(e);
    const roots = nodes.filter((n) => !(incoming[n.id] || []).length);
    const reachable = new Set();
    const queue = roots.map((n) => n.id);
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const [a, b, lbl] of edges) {
        if (a !== id) continue;
        if (edgeIsLive(byId[a], lbl)) queue.push(b);
      }
    }
    for (const n of nodes) {
      if (n.status === 'pending' && !reachable.has(n.id)) {
        this.updateNode(n.id, { status: 'skipped', endedAt: new Date().toISOString() });
      }
    }
  }

  runNode(node) {
    this.updateNode(node.id, { status: 'running', startedAt: new Date().toISOString(), waitsFor: null });
    const handler = getHandler(node.kind);
    const ctx = {
      run: this.run,
      signal: this.ac.signal,
      onProgress: ({ progress, partialOutput } = {}) => {
        const patch = {};
        if (progress !== undefined) patch.progress = progress;
        if (partialOutput !== undefined) patch.output = { ...(node.output || {}), ...partialOutput };
        if (Object.keys(patch).length) this.updateNode(node.id, patch);
      },
      awaitAnswer: (nodeId, question) => {
        this.updateNode(nodeId, { output: question });
        this.patch({ status: 'awaiting-answer' });
        return new Promise((resolve, reject) => {
          this.pendingAnswers.set(nodeId, { resolve, reject });
        }).then((answer) => {
          this.patch({ status: 'running' });
          return answer;
        });
      },
    };
    const p = Promise.resolve()
      .then(() => handler(node, ctx))
      .then((output) => {
        this.updateNode(node.id, {
          status: 'done', output: output ?? node.output, endedAt: new Date().toISOString(), progress: undefined,
        });
        // Check gating. When a Check reports pass: false, by default stop the
        // run with status 'failed'; the author can opt into 'skip' instead so
        // downstream nodes just skip and the run finishes cleanly.
        if (node.kind === 'check' && output?.pass === false) {
          const mode = node.spec?.onFail || 'stop';
          if (mode === 'stop') {
            this.failRun(new Error(`check "${node.title}" failed: ${output.reason || 'no reason'}`));
          }
          // 'skip' lets pruneSkipped take care of the downstream subtree.
        }
      })
      .catch((e) => {
        if (this.aborted) {
          this.updateNode(node.id, { status: 'stopped', endedAt: new Date().toISOString() });
          return;
        }
        this.updateNode(node.id, { status: 'failed', endedAt: new Date().toISOString(),
          output: { ...(node.output || {}), error: e.message } });
        this.failRun(e);
      })
      .finally(() => { this.inFlight.delete(node.id); });
    this.inFlight.set(node.id, p);
  }

  updateNode(nodeId, patch) {
    const n = this.run.graph.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    Object.assign(n, patch);
    writeRun(this.run);
    this.emit('update', { runId: this.run.runId, nodeId });
  }

  patch(fields) {
    Object.assign(this.run, fields);
    writeRun(this.run);
    this.emit('update', { runId: this.run.runId });
  }

  finish(status) {
    const endedAt = new Date().toISOString();
    this.patch({ status, endedAt });
    this.cleanupSandbox(status);
    this.emit('finish', { runId: this.run.runId, status });
  }

  failRun(err) {
    if (!terminal(this.run.status)) this.finish('failed');
    this.emit('fail', { runId: this.run.runId, error: err?.message || String(err) });
  }

  /** Remove the per-run worktree once a run is terminal, unless the def set
   *  keepOnFail and the run didn't succeed. */
  cleanupSandbox(status) {
    const p = this.run.sandboxPath;
    if (!p) return;
    const keep = this.run.runtime?.keepOnFail && status !== 'done';
    if (keep) return;
    try { removeWorktree(p, this.run.repoRoot); } catch { /* best-effort */ }
    this.run.sandboxPath = null;
    writeRun(this.run);
  }
}

function terminal(status) {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

/** Node-level terminal — includes `skipped` which only applies to individual
 *  nodes (never to the run as a whole). */
function isTerminalNode(status) {
  return status === 'done' || status === 'failed' || status === 'stopped' || status === 'skipped';
}

/**
 * An edge is "live" when it should contribute to its target's readiness.
 *   - Default: live.
 *   - A Decision that is done gates each labeled outgoing edge: only the edge
 *     whose label matches `output.picked` stays live. Unlabeled edges always
 *     stay live (a Decision can mix labeled and default branches).
 *   - A Check that is done with pass: false AND spec.onFail === 'skip' makes
 *     every outgoing edge dead so the subtree is pruned.
 */
function edgeIsLive(source, label) {
  if (!source) return true;
  if (source.kind === 'decision' && source.status === 'done') {
    const picked = source.output?.picked;
    if (!label) return true;
    return picked === label;
  }
  if (source.kind === 'check' && source.status === 'done'
      && source.spec?.onFail === 'skip' && source.output?.pass === false) {
    return false;
  }
  return true;
}
