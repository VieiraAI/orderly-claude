/*
 * Scheduler for one workflow run.
 *
 * March the graph: a node turns `running` the moment every upstream node is
 * `done`; its handler produces an output; the node turns `done` and persists.
 * Ready nodes run concurrently up to the run's concurrency, so a wide graph
 * does not fire every model call at once. One Scheduler per run, held by the
 * server in a Map while the run is alive.
 *
 * Exit states:
 *   done         — every node settled
 *   failed       — a node failed, a gate said stop, or the spend limit was
 *                  reached (`run.halt` says which). Nodes already running are
 *                  allowed to finish, so work that was paid for is kept.
 *   stopped      — the person pressed Stop
 *   interrupted  — Orderly itself went away (see suspend())
 *
 * Pause state:
 *   awaiting-answer — a node is waiting for a person. The question lives on
 *   the node in run.json, and so does the answer once given, so neither is
 *   lost if the process ends in between.
 */
import { EventEmitter } from 'node:events';
import { getHandler } from './workflow-handlers.mjs';
import { writeRun, markInterrupted, recordAnswer, resetForRedo } from './workflows.mjs';
import { runSpend } from './settings.mjs';
import { removeWorktree } from './worktree.mjs';

export class Scheduler extends EventEmitter {
  constructor(run) {
    super();
    this.run = run;
    this.aborted = false;
    // Set once the run has been closed out by Stop or shutdown. After that
    // nothing this scheduler does may touch the file: a step settling late
    // would write a stale copy over whatever a resume has since done.
    this.silenced = false;
    this.halting = null;              // { status, ...fields } once the run must wind down
    this.ac = new AbortController();
    this.inFlight = new Map();        // nodeId → promise
    this.pendingAnswers = new Map();  // nodeId → { resolve, reject }
    // Bumped when a step is redone, so whatever its old attempt still sends
    // back is dropped rather than written over the new one.
    this.generation = new Map();      // nodeId → number
    this.nodeAborts = new Map();      // nodeId → AbortController of its current attempt
    this.wake = null;                 // resolves the tick loop's wait early
    this.concurrency = Math.max(1, Number(run.concurrency) || 4);
  }

  start() {
    // Fire-and-forget; errors land on the run itself as `failed`.
    this.tick().catch((e) => this.failRun(e));
    return this;
  }

  /**
   * The person pressed Stop. Steps in flight are signalled to abort and the
   * run is closed out in one write, now, rather than as each step unwinds —
   * so a Resume straight after starts from a file nothing else will change.
   */
  stop() {
    if (terminal(this.run.status)) return false;
    this.aborted = true;
    this.ac.abort();
    for (const { reject } of this.pendingAnswers.values()) reject(new Error('stopped'));
    this.pendingAnswers.clear();
    const at = new Date().toISOString();
    for (const n of this.run.graph.nodes) {
      if (n.status === 'running') { n.status = 'stopped'; n.endedAt = at; delete n.progress; }
    }
    this.run.status = 'stopped';
    this.run.endedAt = at;
    writeRun(this.run);
    this.cleanupSandbox('stopped');
    this.silenced = true;
    this.emit('update', { runId: this.run.runId });
    this.emit('finish', { runId: this.run.runId, status: 'stopped' });
    return true;
  }

  /**
   * Orderly is shutting down. Not the same as Stop: nobody chose to end this
   * run, so it is left `interrupted` and resumable. Written synchronously,
   * because the process may exit before any promise settles.
   */
  suspend(reason = 'Orderly was closed while this was running') {
    if (terminal(this.run.status)) return false;
    this.aborted = true;
    this.ac.abort();
    for (const { reject } of this.pendingAnswers.values()) reject(new Error('suspended'));
    this.pendingAnswers.clear();
    markInterrupted(this.run, reason);
    writeRun(this.run);
    this.silenced = true;
    this.emit('update', { runId: this.run.runId });
    this.emit('finish', { runId: this.run.runId, status: 'interrupted' });
    return true;
  }

  /**
   * Answer a node that is waiting. The answer is written to the run file
   * before the waiting handler hears it, so a crash in between keeps it.
   * Throws if the node is not waiting or the answer is not one of its choices.
   */
  answer(nodeId, answer) {
    // Recorded as checked: one choice, or for a pick-several question, a list.
    const n = recordAnswer(this.run, nodeId, answer);
    writeRun(this.run);
    const slot = this.pendingAnswers.get(nodeId);
    if (!slot) return false;
    this.pendingAnswers.delete(nodeId);
    slot.resolve(n.pendingAnswer);
    return true;
  }

  /**
   * Redo a step while the run is live (see resetForRedo for the modes).
   * Steps being reset are cancelled; every other step carries on.
   * Returns the ids reset. Throws, changing nothing, if the step cannot be redone.
   */
  redo(nodeId, mode) {
    if (terminal(this.run.status)) throw new Error(`the run is ${this.run.status}`);
    const reset = resetForRedo(this.run, nodeId, mode);
    for (const id of reset) {
      this.generation.set(id, (this.generation.get(id) || 0) + 1);
      this.nodeAborts.get(id)?.abort();
      this.nodeAborts.delete(id);
      this.inFlight.delete(id);
      const slot = this.pendingAnswers.get(id);
      if (slot) { this.pendingAnswers.delete(id); slot.reject(new Error('redone')); }
    }
    // A failure that was winding the run down is gone if its step is redone.
    if (this.halting?.failedNode && reset.includes(this.halting.failedNode)) this.halting = null;
    if (this.run.status === 'awaiting-answer' && !this.pendingAnswers.size) this.run.status = 'running';
    this.run.redos = [...(this.run.redos || []), { nodeId, mode, at: new Date().toISOString() }];
    writeRun(this.run);
    this.emit('update', { runId: this.run.runId, nodeId });
    this.wake?.();
    return reset;
  }

  /* ----------------------------- internals ----------------------------- */

  async tick() {
    for (;;) {
      if (this.aborted || terminal(this.run.status)) return;
      // After a Decision picks a branch (or a Check with onFail: 'skip' fails),
      // some pending nodes are now unreachable. Mark them skipped so they
      // don't block the run from finishing.
      this.pruneSkipped();
      if (!this.halting) {
        const ready = this.readyNodes();
        if (ready.length && this.overBudget()) {
          const spent = runSpend(this.run);
          this.halting = {
            status: 'failed',
            halt: {
              type: 'budget', limitUsd: this.run.budgetUsd, spentUsd: round(spent),
              message: `Stopped at the $${this.run.budgetUsd.toFixed(2)} spend limit, having spent $${spent.toFixed(2)}. Raise the limit to carry on.`,
            },
          };
        } else {
          const room = this.concurrency - this.inFlight.size;
          for (const n of ready.slice(0, Math.max(0, room))) this.runNode(n);
        }
      }
      if (this.inFlight.size === 0) {
        if (this.halting) { this.finish(this.halting.status, this.halting); return; }
        if (this.readyNodes().length) continue;
        const allSettled = this.run.graph.nodes.every((n) => isTerminalNode(n.status));
        if (allSettled) this.finish('done');
        else this.failRun(new Error('stuck: some steps can never start, because a step they wait on cannot finish'));
        return;
      }
      await Promise.race([...this.inFlight.values(), new Promise((r) => { this.wake = r; })]);
      this.wake = null;
    }
  }

  overBudget() {
    const limit = Number(this.run.budgetUsd);
    return limit > 0 && runSpend(this.run) >= limit;
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
      if (!parents.every((p) => p && p.status === 'done')) return false;
      // A step redone alone is pending behind finished steps; what comes
      // after those waits for it too.
      return ![...this.ancestorsOf(n.id)].some((id) => ['pending', 'running'].includes(byId[id]?.status));
    });
  }

  ancestorsOf(nodeId) {
    const seen = new Set();
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      for (const [a, b] of this.run.graph.edges || []) if (b === id && !seen.has(a)) { seen.add(a); stack.push(a); }
    }
    return seen;
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
    const startedAt = new Date().toISOString();
    const gen = this.generation.get(node.id) || 0;
    const current = () => (this.generation.get(node.id) || 0) === gen;
    this.updateNode(node.id, { status: 'running', startedAt, waitsFor: null });
    const p = this.attempt(node, current)
      .then((output) => {
        if (!current()) return;
        this.updateNode(node.id, {
          status: 'done', output: output ?? node.output, endedAt: new Date().toISOString(),
          progress: undefined, waitsFor: null, pendingAnswer: undefined,
          durationMs: Date.now() - Date.parse(startedAt),
        });
        // Check gating. When a Check reports pass: false, by default stop the
        // run with status 'failed'; the author can opt into 'skip' instead so
        // downstream nodes just skip and the run finishes cleanly.
        if (node.kind === 'check' && output?.pass === false) {
          const mode = node.spec?.onFail || 'stop';
          if (mode === 'stop' && !this.halting) {
            this.halting = { status: 'failed', error: `check "${node.title}" failed: ${output.reason || 'no reason'}`, failedNode: node.id };
          }
        }
      })
      .catch((e) => {
        // Stop and shutdown wrote the final state already; a redo reset it.
        if (this.silenced || this.aborted || !current()) return;
        this.updateNode(node.id, {
          status: 'failed', endedAt: new Date().toISOString(), progress: undefined,
          // A step that failed may still have produced something worth reading
          // (a command's output); the handler hangs it on the error.
          output: { ...(node.output || {}), ...(e.output || {}), error: e.message },
          durationMs: Date.now() - Date.parse(startedAt),
        });
        if (!this.halting) this.halting = { status: 'failed', error: e.message, failedNode: node.id };
      })
      .finally(() => { if (this.inFlight.get(node.id) === p) this.inFlight.delete(node.id); });
    this.inFlight.set(node.id, p);
  }

  /**
   * Run a node's handler, retrying on failure if the node asks for it.
   * Each attempt gets its own abort signal, so a node's timeout ends that
   * node's work without stopping its siblings.
   */
  async attempt(node, current = () => true) {
    const spec = node.spec || {};
    const retries = Math.max(0, Math.min(5, Number(spec.retry?.attempts) || 0));
    const backoff = Math.max(0, Number(spec.retry?.backoffMs ?? 2000));
    const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : null;
    const handler = getHandler(node.kind);
    for (let attempt = 1; ; attempt++) {
      if (!current()) throw new Error('redone');
      this.updateNode(node.id, { attempts: attempt });
      const nodeAc = new AbortController();
      this.nodeAborts.set(node.id, nodeAc);
      const onRunAbort = () => nodeAc.abort();
      this.ac.signal.addEventListener('abort', onRunAbort, { once: true });
      let timedOut = false;
      const timer = timeoutMs ? setTimeout(() => { timedOut = true; nodeAc.abort(); }, timeoutMs) : null;
      try {
        const output = await handler(node, this.context(node, nodeAc.signal, timeoutMs, current));
        // Some handlers return what they had when their signal fired rather
        // than throwing. A step that ran out of time did not succeed.
        if (timedOut) throw new Error('timed out');
        return output;
      } catch (err) {
        if (this.aborted || !current()) throw err;
        const e = timedOut ? Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { retryable: true }) : err;
        if (e.retryable === false || attempt > retries) {
          if (attempt > 1) e.message = `${e.message} (after ${attempt} attempts)`;
          throw e;
        }
        const wait = backoff * 2 ** (attempt - 1);
        this.updateNode(node.id, {
          progress: `attempt ${attempt} failed — trying again in ${Math.round(wait / 1000)} s`,
          lastError: e.message,
        });
        await sleep(wait, this.ac.signal);
        if (this.aborted || !current()) throw e;
      } finally {
        if (timer) clearTimeout(timer);
        this.ac.signal.removeEventListener('abort', onRunAbort);
        if (this.nodeAborts.get(node.id) === nodeAc) this.nodeAborts.delete(node.id);
      }
    }
  }

  context(node, signal, timeoutMs, current = () => true) {
    // An attempt cancelled by a redo may still report as it unwinds.
    const updateNode = (id, patch) => { if (current()) this.updateNode(id, patch); };
    return {
      run: this.run,
      signal,
      timeoutMs: timeoutMs || undefined,
      onProgress: ({ progress, partialOutput } = {}) => {
        const patch = {};
        if (progress !== undefined) patch.progress = progress;
        if (partialOutput !== undefined) patch.output = { ...(node.output || {}), ...partialOutput };
        if (Object.keys(patch).length) updateNode(node.id, patch);
      },
      // A step waiting on something other than this run, such as a question
      // in a workflow it started. Shown on its card; answered elsewhere.
      wait: (who) => { if ((node.waitsFor || null) !== (who || null)) updateNode(node.id, { waitsFor: who || null }); },
      // What was actually sent, references resolved, for the drill-down.
      recordSent: (text) => updateNode(node.id, { sent: String(text ?? '').slice(0, 20_000) }),
      awaitAnswer: (nodeId, question) => {
        if (!current()) return Promise.reject(new Error('redone'));
        const n = this.run.graph.nodes.find((x) => x.id === nodeId);
        // Answered while the run was down — use it rather than asking again.
        if (n && n.pendingAnswer !== undefined) {
          const given = n.pendingAnswer;
          updateNode(nodeId, { output: { ...question, answer: given }, waitsFor: null });
          return Promise.resolve(given);
        }
        updateNode(nodeId, { output: question, waitsFor: 'you' });
        this.patch({ status: 'awaiting-answer' });
        return new Promise((resolve, reject) => {
          this.pendingAnswers.set(nodeId, { resolve, reject });
        }).then((answer) => {
          updateNode(nodeId, { waitsFor: null });
          // Several questions can be open at once; the run is only back to
          // running when none is.
          if (current() && !this.pendingAnswers.size && !terminal(this.run.status)) this.patch({ status: 'running' });
          return answer;
        });
      },
    };
  }

  updateNode(nodeId, patch) {
    if (this.silenced) return;
    const n = this.run.graph.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete n[k];
      else n[k] = v;
    }
    writeRun(this.run);
    this.emit('update', { runId: this.run.runId, nodeId });
  }

  patch(fields) {
    if (this.silenced) return;
    Object.assign(this.run, fields);
    writeRun(this.run);
    this.emit('update', { runId: this.run.runId });
  }

  finish(status, extra = {}) {
    const { status: _ignored, ...fields } = extra;
    this.patch({ ...fields, status, endedAt: new Date().toISOString() });
    this.cleanupSandbox(status);
    this.emit('finish', { runId: this.run.runId, status });
  }

  failRun(err) {
    if (!terminal(this.run.status)) this.finish('failed', { error: err?.message || String(err) });
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

export function terminal(status) {
  return status === 'done' || status === 'failed' || status === 'stopped' || status === 'interrupted';
}

/** Node-level terminal — includes `skipped` which only applies to individual
 *  nodes (never to the run as a whole). */
function isTerminalNode(status) {
  return status === 'done' || status === 'failed' || status === 'stopped' || status === 'skipped';
}

function round(n) { return Math.round(n * 10000) / 10000; }

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
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
    // A pick-several question keeps every picked branch live.
    return Array.isArray(picked) ? picked.includes(label) : picked === label;
  }
  if (source.kind === 'check' && source.status === 'done'
      && source.spec?.onFail === 'skip' && source.output?.pass === false) {
    return false;
  }
  return true;
}
