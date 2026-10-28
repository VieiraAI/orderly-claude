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
      const ready = this.readyNodes();
      if (!ready.length) {
        if (this.inFlight.size === 0) {
          // Nothing running and nothing ready → done, assuming every node
          // reached done. If any pending survives, it's a broken graph.
          const allDone = this.run.graph.nodes.every((n) => n.status === 'done');
          if (allDone) this.finish('done');
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
      const parents = (this.run.graph.edges || []).filter(([, b]) => b === n.id).map(([a]) => byId[a]);
      return parents.every((p) => p && p.status === 'done');
    });
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
    this.emit('finish', { runId: this.run.runId, status });
  }

  failRun(err) {
    if (!terminal(this.run.status)) this.finish('failed');
    this.emit('fail', { runId: this.run.runId, error: err?.message || String(err) });
  }
}

function terminal(status) {
  return status === 'done' || status === 'failed' || status === 'stopped';
}
