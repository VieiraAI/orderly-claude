/**
 * Workflow engine checks — references, limits, durability, schedules.
 *
 * Runs against throwaway servers whose project, settings and schedules all
 * live in a temp directory, so nothing here touches the person's real runs,
 * schedules or spend limits. Called from smoke.mjs; also runnable alone:
 *
 *   node test/workflow-engine.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = (start) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(freePort(start + 1)));
  srv.once('listening', () => srv.close(() => resolve(start)));
  srv.listen(start, '127.0.0.1');
});

export async function runWorkflowEngineChecks({ check, session }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-wf-'));
  const repo = path.join(tmp, 'project');
  fs.mkdirSync(repo, { recursive: true });
  // Isolate everything the person owns before the modules first read it.
  process.env.ORDERLY_SCHEDULES_DIR = path.join(tmp, 'data');
  process.env.ORDERLY_SETTINGS_FILE = path.join(tmp, 'data', 'settings.json');
  process.env.ORDERLY_SCHEDULE_TICK_MS = '250';
  if (process.env.ORDERLY_HANDLER_MODE !== 'real') process.env.ORDERLY_HANDLER_MODE = 'mock';

  const { startServer } = await import('../src/server/server.mjs');
  const refs = await import('../src/core/refs.mjs');
  const wf = await import('../src/core/workflows.mjs');
  const sched = await import('../src/core/schedules.mjs');

  let server = null, base = null;
  const boot = async () => {
    const port = await freePort(7950);
    server = await startServer({
      port, file: session.file, sessionId: session.sessionId, cwd: repo, title: 'engine checks', capture: false,
    });
    base = `http://127.0.0.1:${port}`;
  };
  const crash = () => { server.close(); server = null; };
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, ...(json || {}) };
  };
  const save = (def) => api('/api/workflows', { body: { def: { schemaVersion: 2, ...def }, scope: 'project', overwrite: true } });
  const start = (id, inputs = {}) => api(`/api/workflows/${id}/run`, { body: { inputs } });
  const read = async (runId) => (await api(`/api/runs/${runId}`)).run;
  const until = async (runId, pred, ms = 8000) => {
    const end = Date.now() + ms;
    let r = null;
    while (Date.now() < end) {
      r = await read(runId);
      if (r && pred(r)) return r;
      await sleep(80);
    }
    return r;
  };
  const settled = (r) => ['done', 'failed', 'stopped', 'interrupted'].includes(r.status);
  const node = (r, id) => r?.graph?.nodes.find((n) => n.id === id);
  const script = (id, cmd, extra = {}) => ({ id, title: id, kind: 'script', col: 1, row: 0, spec: { cmd, ...extra } });
  const states = (r) => r?.graph?.nodes.map((n) => `${n.id}=${n.status}`).join(' ');

  try {
    await boot();

    /* ------------------------------ references ----------------------------- */
    console.log('\nWorkflows: references\n');

    const marker = path.join(tmp, 'PWNED');
    await save({
      id: 'refs', title: 'Refs', inputs: [{ key: 'who', label: 'Who' }],
      graph: {
        nodes: [
          script('src', `printf '%s' "x; touch ${marker}"`),
          script('use', 'printf "%s|%s|%s" {{nodes.src.output}} {{nodes.src.output.code}} {{inputs.who}}'),
        ],
        edges: [['src', 'use']],
      },
    });
    let r = await until((await start('refs', { who: 'Ana' })).run.runId, settled);
    check('references resolve from an upstream output, a field, and an input',
      node(r, 'use')?.output?.out === `x; touch ${marker}|0|Ana`, node(r, 'use')?.output?.out || states(r));
    check('a model-shaped output substituted into a command runs nothing', !fs.existsSync(marker));
    check('the command actually sent is recorded for the drill-down',
      /printf "%s\|%s\|%s" 'x; touch/.test(node(r, 'use')?.sent || ''), node(r, 'use')?.sent);

    let v = await api('/api/workflows/validate', { body: { def: { schemaVersion: 2, id: 'bad', graph: {
      nodes: [script('a', 'echo {{nodes.b.output}}'), script('b', 'echo hi'), script('c', 'echo {{nodes.ghost.output}}')],
      edges: [['a', 'b']],
    } } } });
    check('naming a step that runs later is refused, with how to fix it',
      v.problems?.some((p) => /a: cmd names "b", which is not upstream of it — connect b → a first/.test(p)), v.problems?.join(' | '));
    check('naming a step that does not exist is refused',
      v.problems?.some((p) => /names node "ghost", which does not exist/.test(p)));

    v = await api('/api/workflows/validate', { body: { def: { schemaVersion: 2, id: 'lint', inputs: [], graph: {
      nodes: [{ id: 'a', title: 'a', kind: 'agent', spec: { prompt: 'Write about {{inputs.topic}}' } }], edges: [],
    } } } });
    check('an undeclared input is a warning, not a refusal',
      v.ok === true && v.warnings?.some((w) => /\{\{inputs.topic\}\} is not one of the workflow's inputs/.test(w)), JSON.stringify(v));

    await save({ id: 'hole', title: 'Hole', graph: {
      nodes: [script('a', 'echo hi'), script('b', 'echo {{nodes.a.output.nothere}}')], edges: [['a', 'b']] } });
    r = await until((await start('hole')).run.runId, settled);
    check('a reference that resolves to nothing fails its step and names itself',
      node(r, 'b')?.status === 'failed' && /\{\{nodes.a.output.nothere\}\} was empty/.test(node(r, 'b')?.output?.error || ''),
      node(r, 'b')?.output?.error);

    check('explicit references switch off the paste-every-parent default',
      refs.isExplicit('Use {{nodes.a.output}}') && !refs.isExplicit('Use {{inputs.a}}'));

    /* --------------------------- real exit codes ---------------------------- */
    console.log('\nWorkflows: commands that fail\n');

    await save({ id: 'exit', title: 'Exit', graph: {
      nodes: [script('t', 'echo 3 failed; exit 1'), script('after', 'echo should-not-run')], edges: [['t', 'after']] } });
    r = await until((await start('exit')).run.runId, settled);
    check('a command that exits non-zero fails its step', node(r, 't')?.status === 'failed' && r.status === 'failed',
      states(r));
    check('the failure says what the command printed', /exited 1 — 3 failed/.test(node(r, 't')?.output?.error || ''), node(r, 't')?.output?.error);
    check('nothing after a failed step starts', node(r, 'after')?.status === 'pending', node(r, 'after')?.status);

    await save({ id: 'gate', title: 'Gate', graph: {
      nodes: [
        script('t', 'echo red; exit 2', { allowFailure: true }),
        { id: 'g', title: 'Green?', kind: 'check', spec: { assert: { type: 'exit-zero', from: 't' } } },
        script('ship', 'echo shipped'),
      ],
      edges: [['t', 'g'], ['g', 'ship']] } });
    r = await until((await start('gate')).run.runId, settled);
    check('an exit-zero check now sees the real exit code and blocks',
      node(r, 'g')?.output?.pass === false && node(r, 'ship')?.status === 'pending' && r.status === 'failed',
      `${states(r)} reason=${node(r, 'g')?.output?.reason}`);

    /* ------------------------------ limits ---------------------------------- */
    console.log('\nWorkflows: retries, timeouts, concurrency, spend\n');

    const counter = path.join(tmp, 'count');
    await save({ id: 'retry', title: 'Retry', graph: { nodes: [
      script('flaky', `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ $n -ge 2 ]`,
        { retry: { attempts: 2, backoffMs: 50 } }),
    ], edges: [] } });
    r = await until((await start('retry')).run.runId, settled);
    check('a flaky step succeeds on its second attempt', r.status === 'done' && node(r, 'flaky')?.attempts === 2,
      `${r.status} attempts=${node(r, 'flaky')?.attempts}`);

    await save({ id: 'slow', title: 'Slow', graph: { nodes: [
      script('hang', 'sleep 30', { timeoutMs: 1000 }),
    ], edges: [] } });
    const t0 = Date.now();
    r = await until((await start('slow')).run.runId, settled, 10000);
    const took = Date.now() - t0;
    check('a step that runs out of time fails, saying so', node(r, 'hang')?.status === 'failed'
      && /timed out after 1 s/.test(node(r, 'hang')?.output?.error || ''), node(r, 'hang')?.output?.error);
    check('a timeout ends the command, not just the wait', took < 6000, `${took} ms`);

    await save({ id: 'wide', title: 'Wide', concurrency: 2, graph: { nodes: ['a', 'b', 'c', 'd'].map((id) => script(id, 'sleep 0.4')), edges: [] } });
    r = await until((await start('wide')).run.runId, settled, 10000);
    const spans = r.graph.nodes.map((n) => [Date.parse(n.startedAt), Date.parse(n.endedAt)]);
    const peak = Math.max(...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length));
    check('no more steps run at once than the workflow allows', r.status === 'done' && peak <= 2, `peak=${peak} ${states(r)}`);

    process.env.ORDERLY_MOCK_COST = '0.5';
    await save({ id: 'spend', title: 'Spend', budgetUsd: 0.9, graph: { nodes: [
      { id: 'a', title: 'A', kind: 'agent', spec: { prompt: 'one' } },
      { id: 'b', title: 'B', kind: 'agent', spec: { prompt: 'two' } },
      { id: 'c', title: 'C', kind: 'agent', spec: { prompt: 'three' } },
    ], edges: [['a', 'b'], ['b', 'c']] } });
    const spendRun = (await start('spend')).run.runId;
    r = await until(spendRun, settled);
    check('a run stops before the step that would cross its spend limit',
      r.status === 'failed' && r.halt?.type === 'budget' && node(r, 'c')?.status === 'pending' && node(r, 'b')?.status === 'done',
      `${states(r)} halt=${JSON.stringify(r.halt)}`);
    check('the stop says how much was spent and how to carry on', /Raise the limit to carry on/.test(r.halt?.message || ''), r.halt?.message);
    let res = await api(`/api/runs/${spendRun}/resume`, { body: { budgetUsd: 5 } });
    r = await until(spendRun, (x) => x.status === 'done' || x.status === 'failed');
    check('raising the limit and resuming finishes the run without redoing paid steps',
      res.resumed === true && r.status === 'done' && node(r, 'a')?.attempts === 1, `${res.error || ''} ${states(r)}`);
    delete process.env.ORDERLY_MOCK_COST;

    await save({ id: 'many', title: 'Many', graph: { nodes: [
      { id: 'l', title: 'L', kind: 'loop', spec: { over: 'inputs.xs', action: 'script', cmd: 'printf %s {{item}}', max: 2 } },
    ], edges: [] } });
    r = await until((await start('many', { xs: "a,b;rm,c,d,e" })).run.runId, settled);
    const lo = node(r, 'l')?.output;
    check('a loop stops at its limit and says it did', lo?.results?.length === 2 && /first 2 of 5/.test(lo?.note || ''), JSON.stringify(lo?.note));
    check('loop items reach a command quoted', lo?.results?.[1]?.out === 'b;rm', lo?.results?.[1]?.out);

    await save({ id: 'escape', title: 'Escape', graph: { nodes: [
      { id: 'w', title: 'W', kind: 'publish', spec: { target: 'file', path: '../outside.md', content: 'nope' } },
    ], edges: [] } });
    r = await until((await start('escape')).run.runId, settled);
    check('a file can only be written inside the project',
      node(r, 'w')?.status === 'failed' && /outside the project/.test(node(r, 'w')?.output?.error || '') && !fs.existsSync(path.join(tmp, 'outside.md')),
      node(r, 'w')?.output?.error);

    /* --------------------------- versions, reruns --------------------------- */
    console.log('\nWorkflows: versions\n');

    const s1 = await save({ id: 'ver', title: 'Ver', graph: { nodes: [script('a', 'echo one')], edges: [] } });
    const first = await until((await start('ver')).run.runId, settled);
    await save({ id: 'ver', title: 'Ver', graph: { nodes: [script('a', 'echo two')], edges: [] } });
    const saved = JSON.parse(fs.readFileSync(s1.file, 'utf8'));
    check('saving again bumps the version', saved.version === 2, `version=${saved.version}`);
    check('a run records which version it ran', first.definitionVersion === 1, first.definitionVersion);
    const rr = await api(`/api/runs/${first.runId}/rerun`, { body: {} });
    r = await until(rr.run.runId, settled);
    check('a rerun repeats what ran, not what the file says now', node(r, 'a')?.output?.out === 'one', node(r, 'a')?.output?.out);
    const one = await api(`/api/runs/${first.runId}`);
    check('a run says the workflow has moved on since', one.currentVersion === 2 && one.run.definitionVersion === 1,
      `${one.run.definitionVersion} → ${one.currentVersion}`);

    /* ------------------------------ durability ------------------------------ */
    console.log('\nWorkflows: interruption and resume\n');

    await save({ id: 'long', title: 'Long', graph: { nodes: [
      script('quick', 'echo quick'), script('slow', 'sleep 20'), script('tail', 'echo tail'),
    ], edges: [['quick', 'slow'], ['slow', 'tail']] } });
    const longRun = (await start('long')).run.runId;
    await until(longRun, (x) => node(x, 'slow')?.status === 'running');
    crash();
    let raw = wf.readRun(longRun, { repoRoot: repo });
    check('closing Orderly leaves a running run interrupted, not stopped',
      raw.status === 'interrupted' && node(raw, 'slow')?.status === 'interrupted' && raw.interruption?.nodes?.includes('slow'),
      `${raw.status} ${states(raw)}`);
    await boot();
    res = await api(`/api/runs/${longRun}/resume`, { body: {} });
    await sleep(300);
    r = await read(longRun);
    check('resuming carries on from where it stopped', res.resumed === true && node(r, 'quick')?.attempts === 1
      && ['running', 'pending'].includes(node(r, 'slow')?.status), `${res.error || ''} ${states(r)}`);
    res = await api(`/api/runs/${longRun}/stop`, { body: {} });
    r = await read(longRun);
    check('Stop closes the run out at once', res.stopped === true && r.status === 'stopped' && node(r, 'slow')?.status === 'stopped', states(r));
    res = await api(`/api/runs/${longRun}/resume`, { body: {} });
    await sleep(300);
    r = await read(longRun);
    check('a stopped run can be resumed straight away, without a restart',
      res.resumed === true && r.resumes === 2 && ['running', 'pending'].includes(node(r, 'slow')?.status), `${res.error || ''} ${states(r)}`);
    await sleep(500);
    r = await read(longRun);
    check('…and nothing from before the stop writes over it afterwards',
      r.status === 'running' && node(r, 'slow')?.status === 'running', states(r));
    await api(`/api/runs/${longRun}/stop`, { body: {} });

    // A run left marked live by a process that died without saying so.
    raw = wf.readRun(longRun, { repoRoot: repo });
    Object.assign(raw, { status: 'running', ownerPid: 999999, endedAt: null });
    node(raw, 'slow').status = 'running';
    wf.writeRun(raw);
    crash(); // the stopped run above has no scheduler, so this changes nothing
    raw = wf.readRun(longRun, { repoRoot: repo });
    Object.assign(raw, { status: 'running', ownerPid: 999999 });
    wf.writeRun(raw);
    await boot();
    r = await read(longRun);
    check('a run whose process died is found and marked interrupted on start',
      r.status === 'interrupted', r.status);

    await save({ id: 'push', title: 'Push', graph: { nodes: [
      script('deploy', 'sleep 20', { idempotent: false }), script('announce', 'echo announced'),
    ], edges: [['deploy', 'announce']] } });
    const pushRun = (await start('push')).run.runId;
    await until(pushRun, (x) => node(x, 'deploy')?.status === 'running');
    crash();
    await boot();
    res = await api(`/api/runs/${pushRun}/resume`, { body: {} });
    check('a step marked unsafe to repeat is not re-run without asking',
      res.status === 409 && res.needsChoice?.[0]?.nodeId === 'deploy', JSON.stringify(res));
    res = await api(`/api/runs/${pushRun}/resume`, { body: { choices: { deploy: 'assume-done' } } });
    r = await until(pushRun, settled);
    check('"it already happened" carries on after it without repeating it',
      r.status === 'done' && node(r, 'announce')?.status === 'done' && /Not repeated/.test(node(r, 'deploy')?.output?.note || ''),
      states(r));

    await save({ id: 'ask', title: 'Ask', graph: { nodes: [
      { id: 'ok', title: 'Ship it?', kind: 'approve', spec: { question: 'Ship {{inputs.what}}?' } }, script('after', 'echo after'),
    ], edges: [['ok', 'after']], }, inputs: [{ key: 'what', label: 'What' }] });
    const askRun = (await start('ask', { what: 'v2' })).run.runId;
    await until(askRun, (x) => x.status === 'awaiting-answer');
    let list = await api('/api/runs');
    const row = list.runs.find((x) => x.runId === askRun);
    check('the Runs list carries the question itself, ready to answer',
      row?.needsYou?.question === 'Ship v2?' && row.needsYou.choices?.join() === 'approve,reject' && list.counts.needsYou >= 1,
      JSON.stringify(row?.needsYou));
    res = await api(`/api/runs/${askRun}/answer`, { body: { nodeId: 'ok', answer: 'maybe' } });
    check('an answer that is not one of the choices is refused', res.status === 400 && /one of: approve, reject/.test(res.error), res.error);
    crash();
    await boot();
    list = await api('/api/runs');
    check('an unanswered question survives Orderly closing',
      list.runs.find((x) => x.runId === askRun)?.needsYou?.question === 'Ship v2?');
    res = await api(`/api/runs/${askRun}/answer`, { body: { nodeId: 'ok', answer: 'approve' } });
    r = await until(askRun, settled);
    check('answering it afterwards resumes the run to the end',
      res.resumed === true && r.status === 'done' && node(r, 'after')?.status === 'done', `${JSON.stringify(res)} ${states(r)}`);

    /* ------------------------ owning your workflows ------------------------- */
    console.log('\nWorkflows: owning them\n');

    const dup = await api('/api/workflows/ship-pr/duplicate', { body: { scope: 'project' } });
    check('a built-in can be copied into your own library', dup.saved === true && dup.id === 'ship-pr', JSON.stringify(dup));
    const mine = (await api('/api/workflows')).workflows.find((w) => w.id === dup.id);
    check('the copy is yours, records where it came from, and shadows the built-in',
      mine?.scope === 'project' && mine?.derivedFrom?.id === 'ship-pr' && /\(yours\)/.test(mine?.title), JSON.stringify(mine?.derivedFrom));
    const dup2 = await api('/api/workflows/ship-pr/duplicate', { body: { scope: 'project' } });
    check('copying again picks a free name instead of overwriting', dup2.id !== dup.id, dup2.id);

    const exp = await fetch(`${base}/api/workflows/refs/export`);
    const exported = await exp.json();
    check('a workflow exports as a single file', /attachment; filename="refs.workflow.json"/.test(exp.headers.get('content-disposition') || '')
      && exported.id === 'refs' && !('scope' in exported) && !('file' in exported));
    res = await api('/api/workflows/import', { body: { def: exported, scope: 'project' } });
    check('importing a name you already have is refused, with a free one suggested',
      res.status === 409 && res.suggestedId === 'refs-2', JSON.stringify(res));
    res = await api('/api/workflows/import', { body: { def: { ...exported, id: res.suggestedId }, scope: 'project' } });
    check('importing under the suggested name works', res.saved === true && res.id === 'refs-2', JSON.stringify(res));
    res = await api('/api/workflows/import', { body: { def: { id: 'junk', graph: { nodes: [] } }, scope: 'project' } });
    check('importing something that is not a workflow is refused, with why', res.status === 400 && res.problems?.length > 0);

    res = await api(`/api/workflows/${dup2.id}?scope=project`, { method: 'DELETE' });
    check('you can delete a workflow you own', res.deleted === true);
    res = await api('/api/workflows/redesign-page?scope=builtin', { method: 'DELETE' });
    check('a built-in cannot be deleted', res.status === 400);

    // A file that stopped validating is shown, flagged, rather than vanishing.
    fs.writeFileSync(path.join(repo, '.claude', 'workflows', 'broken.json'),
      JSON.stringify({ schemaVersion: 2, id: 'broken', title: 'Broken', graph: { nodes: [{ id: 'a', kind: 'agent', spec: {} }], edges: [] } }));
    const broken = (await api('/api/workflows')).workflows.find((w) => w.id === 'broken');
    check('a workflow with a problem stays listed, marked, so its owner can fix it',
      broken?.invalid === true && broken.problems?.some((p) => /prompt is required/.test(p)));
    res = await start('broken');
    check('…and refuses to run until it is fixed, saying why', res.status === 400 && /needs fixing/.test(res.error), res.error);

    const prev = await api('/api/workflows/preview', { body: {
      def: (await api('/api/workflows/refs')).workflow, nodeId: 'use', field: 'cmd' } });
    check('the editor can preview what a reference becomes, from the last run',
      prev.fromRun && prev.text.includes("'x; touch") && prev.text.endsWith("'Ana'"), prev.text);

    /* ------------------------------ schedules ------------------------------- */
    console.log('\nWorkflows: schedules\n');

    check('schedules are written to a disposable place in this suite',
      process.env.ORDERLY_SCHEDULES_DIR.startsWith(tmp));
    res = await api('/api/schedules', { body: { workflowId: 'ver', rule: { every: 'minutes', n: 15 } } });
    check('a schedule cannot be made without a spend limit', res.status === 400 && /spend limit/.test(res.error), res.error);
    res = await api('/api/schedules', { body: { workflowId: 'ver', rule: { every: 'minutes', n: 1 }, budgetUsd: 1 } });
    check('a schedule that would fire every minute is refused', res.status === 400);
    res = await api('/api/schedules', { body: { workflowId: 'ver', rule: { every: 'day', at: '07:00' }, budgetUsd: 0.5 } });
    const sid = res.schedule?.id;
    const twice = await api('/api/schedules', { body: { workflowId: 'ver', rule: { every: 'day', at: '07:00' }, budgetUsd: 0.5 } });
    check('the same schedule twice is refused, so a double click never doubles the runs',
      twice.status === 400 && /already have this exact schedule/.test(twice.error), twice.error);
    check('a daily schedule is created and says when it runs next',
      !!sid && res.schedule.describe === 'Every day at 07:00' && res.schedule.nextDueAt > Date.now(), JSON.stringify(res));
    let all = await api('/api/schedules');
    check('the schedules list says plainly it only runs while Orderly is open',
      /only while Orderly is open on this machine/.test(all.note) && /never made up later/.test(all.note));

    // Due a moment ago: fires on the next tick.
    const file = path.join(process.env.ORDERLY_SCHEDULES_DIR, 'schedules.json');
    const setDue = (ms) => {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      s.find((x) => x.id === sid).nextDueAt = Date.now() - ms;
      fs.writeFileSync(file, JSON.stringify(s));
    };
    setDue(1000);
    let fired = null;
    for (let i = 0; i < 40 && !fired; i++) {
      await sleep(100);
      fired = (await api('/api/schedules')).schedules.find((x) => x.id === sid && x.lastRunId);
    }
    check('a due schedule fires on its own', !!fired && fired.lastStatus === 'started' && fired.fired === 1, JSON.stringify(fired?.lastStatus));
    const firedRun = fired && await read(fired.lastRunId);
    check('a scheduled run says it was scheduled and carries its spend limit',
      firedRun?.trigger === 'schedule' && firedRun?.budgetUsd === 0.5 && firedRun?.scheduleId === sid,
      `${firedRun?.trigger} ${firedRun?.budgetUsd}`);
    check('…and its next time is pushed forward', fired?.nextDueAt > Date.now());

    // Slept through three days: counted, not made up.
    setDue(3 * 86_400_000 + 60_000);
    const before = (await api('/api/runs')).total;
    let missed = null;
    for (let i = 0; i < 40 && !missed; i++) {
      await sleep(100);
      missed = (await api('/api/schedules')).schedules.find((x) => x.id === sid && x.missed > 0);
    }
    const after = (await api('/api/runs')).total;
    check('windows slept through are counted as missed', missed?.missed >= 3, `missed=${missed?.missed}`);
    check('…and none of them is made up later', after === before, `${before} → ${after}`);

    // Another live Orderly holds the lock: this one must not fire.
    sched.releaseLock();
    fs.writeFileSync(path.join(process.env.ORDERLY_SCHEDULES_DIR, 'scheduler.lock'), JSON.stringify({ pid: process.ppid }));
    setDue(1000);
    await sleep(900);
    const held = (await api('/api/schedules')).schedules.find((x) => x.id === sid);
    check('only the Orderly holding the lock fires schedules', held.fired === 1, `fired=${held.fired}`);
    fs.rmSync(path.join(process.env.ORDERLY_SCHEDULES_DIR, 'scheduler.lock'));

    // Daily limit reached: skipped, said so.
    await api('/api/settings', { body: { budget: { scheduledPerDayUsd: 0.01 } } });
    process.env.ORDERLY_MOCK_COST = '0.5';
    await save({ id: 'costly', title: 'Costly', graph: { nodes: [{ id: 'a', title: 'A', kind: 'agent', spec: { prompt: 'x' } }], edges: [] } });
    const c = await api('/api/schedules', { body: { workflowId: 'costly', rule: { every: 'hours', n: 1 }, budgetUsd: 1 } });
    const cfile = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const due = (id) => { const s = cfile(); s.find((x) => x.id === id).nextDueAt = Date.now() - 500; fs.writeFileSync(file, JSON.stringify(s)); };
    due(c.schedule.id);
    let cs = null;
    for (let i = 0; i < 40 && !(cs?.lastRunId); i++) { await sleep(100); cs = (await api('/api/schedules')).schedules.find((x) => x.id === c.schedule.id); }
    if (cs?.lastRunId) await until(cs.lastRunId, settled);
    due(c.schedule.id);
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      cs = (await api('/api/schedules')).schedules.find((x) => x.id === c.schedule.id);
      if (/limit/.test(cs?.lastStatus || '')) break;
    }
    check('scheduled runs stop for the day once they reach the daily limit',
      cs.fired === 1 && /reached today's \$0.01 limit/.test(cs.lastStatus), cs.lastStatus);
    delete process.env.ORDERLY_MOCK_COST;

    res = await api(`/api/schedules/${sid}`, { method: 'PATCH', body: { enabled: false } });
    check('a schedule can be paused', res.schedule?.enabled === false);
    res = await api(`/api/schedules/${sid}`, { method: 'DELETE' });
    check('a schedule can be deleted', res.deleted === true);
    res = await api('/api/settings', { body: { budget: { scheduledPerDayUsd: '' } } });
    check('scheduled runs can never be left without a daily limit', res.status === 400, res.error);

    await browserChecks({ check, base, api, save, start, until, settled, node });
  } finally {
    if (server) server.close();
    sched.releaseLock();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.ORDERLY_SCHEDULES_DIR;
    delete process.env.ORDERLY_SETTINGS_FILE;
    delete process.env.ORDERLY_SCHEDULE_TICK_MS;
  }
}

/* -------------------------------- browser -------------------------------- */

/**
 * The pages, driven in headless Chrome: build a workflow in the editor, answer
 * a question from the Runs panel, read a failure on the run page. Every page
 * must load without a console error or a browser dialog — a dialog blocks
 * automation and is a worse experience than saying it inline.
 */
async function browserChecks({ check, base, api, save, start, until, settled, node }) {
  const { findChrome } = await import('../src/core/capture.mjs');
  const { CDP, httpJSON } = await import('../src/core/cdp.mjs');
  const { spawn } = await import('node:child_process');
  let chrome;
  try { chrome = findChrome(); } catch { chrome = null; }
  if (!chrome) { console.log('  (no Chrome — skipping the workflow pages)'); return; }

  console.log('\nWorkflows: the pages\n');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orderly-wf-ui-'));
  const port = await freePort(9640);
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-component-update',
    '--disable-background-networking', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    let ws = null;
    for (let i = 0; i < 80 && !ws; i++) { try { ws = (await httpJSON(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; } catch { await sleep(120); } }
    if (!ws) { check('Chrome starts for the page checks', false); return; }
    cdp = await CDP.attach(ws);

    const open = async (url) => {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sessionId);
      const errors = [];
      cdp.listeners.add((m) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
        if (m.method === 'Page.javascriptDialogOpening') errors.push(`dialog: ${m.params.message}`);
      });
      await cdp.send('Page.navigate', { url: base + url }, sessionId);
      try { await cdp.once('Page.loadEventFired', sessionId, 9000); } catch { /* streams keep it loading */ }
      await sleep(900);
      const ev = async (body) => {
        const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      return { ev, errors, close: () => cdp.send('Target.closeTarget', { targetId }) };
    };
    const tick = 'await new Promise((r) => setTimeout(r, 60));';

    // Build one in the editor, from an empty canvas.
    let p = await open('/workflows-new.html');
    let r = await p.ev(`
      const $ = (id) => document.getElementById(id);
      const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));
      const empty = document.querySelectorAll('.n-card').length;
      $('wfTitle').value = 'Page check'; fire($('wfTitle'));
      $('btnAddInput').click(); ${tick}
      const k = document.querySelector('#inputsList [data-f="key"]'); k.value = 'who'; fire(k);
      document.querySelector('.kind-btn[data-kind="script"]').click(); ${tick}
      const c = document.querySelector('#selSpec [data-spec="cmd"]'); c.value = 'echo hi'; fire(c);
      document.querySelector('.kind-btn[data-kind="agent"]').click(); ${tick}
      const pr = document.querySelector('#selSpec [data-spec="prompt"]');
      pr.focus(); pr.value = 'Use '; pr.selectionStart = pr.selectionEnd = 4;
      document.querySelector('#selSpec .ref-btn[data-for="sp-prompt"]').click(); ${tick}
      const offered = [...document.querySelectorAll('#refPop button[data-ref]')].map((b) => b.dataset.ref);
      document.querySelector('#refPop button[data-ref="{{nodes.script.output.out}}"]').click(); ${tick}
      await new Promise((r) => setTimeout(r, 900));
      return { empty, id: $('wfId').value, cards: document.querySelectorAll('.n-card').length,
        edges: document.querySelectorAll('#edEdges .edge-hit').length, offered, prompt: pr.value,
        preview: !$('preview').classList.contains('hidden') && /Use/.test($('previewText').textContent) };`);
    check('a new workflow starts from an empty canvas', r.empty === 0, String(r.empty));
    check('the name fills in the short name', r.id === 'page-check', r.id);
    check('a step added while another is selected is connected after it', r.cards === 2 && r.edges === 1, JSON.stringify(r));
    check('the reference picker offers inputs and what earlier steps produced',
      r.offered.includes('{{inputs.who}}') && r.offered.includes('{{nodes.script.output.out}}'), r.offered.join(' '));
    check('picking a reference inserts it at the cursor, with a live preview', r.prompt === 'Use {{nodes.script.output.out}}' && r.preview, r.prompt);
    r = await p.ev(`
      document.querySelector('#edEdges .edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })); ${tick}
      document.getElementById('btnDeleteEdge').click();
      await new Promise((r) => setTimeout(r, 600));
      const problem = document.getElementById('problems').textContent;
      document.querySelector('.n-card[data-id="script"]').click();
      document.getElementById('btnConnect').click();
      document.querySelector('.n-card[data-id="agent"]').click();
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('wfScope').value = 'project';
      document.getElementById('btnSave').click();
      await new Promise((r) => setTimeout(r, 900));
      return { problem, cleared: document.getElementById('problems').style.display === 'none',
        saved: document.getElementById('saveLine').textContent, url: location.search };`);
    check('removing a connection a reference relies on is flagged at once', /not upstream/.test(r.problem), r.problem);
    check('reconnecting clears it, and saving moves to editing the saved file',
      r.cleared && /^Saved/.test(r.saved) && r.url === '?id=page-check', JSON.stringify(r));
    check('the editor raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
    p = await open('/workflows-new.html?id=page-check');
    r = await p.ev(`return { cards: document.querySelectorAll('.n-card').length, edges: document.querySelectorAll('#edEdges .edge-hit').length, inputs: document.querySelectorAll('#inputsList .list-row').length };`);
    check('a saved workflow reopens as it was left', r.cards === 2 && r.edges === 1 && r.inputs === 1, JSON.stringify(r));
    await p.close();
    // ship-pr was copied into this project above, and that copy rightly
    // shadows the built-in; visual-regression is still only a built-in.
    p = await open('/workflows-new.html?id=visual-regression');
    r = await p.ev(`return !document.getElementById('builtinBanner').classList.contains('hidden');`);
    check('opening a built-in says saving makes your own copy', r === true);
    await p.close();

    // The Runs panel: a question answered from the list, a failure explained.
    await save({ id: 'ui-ask', title: 'UI ask', inputs: [{ key: 'v', label: 'V' }], graph: {
      nodes: [{ id: 'ok', title: 'Approve', kind: 'approve', spec: { question: 'Ship {{inputs.v}}?' } }], edges: [] } });
    await save({ id: 'ui-fail', title: 'UI fail', graph: { nodes: [
      { id: 't', title: 'Tests', kind: 'script', spec: { cmd: 'echo "4 failed"; exit 1' } }], edges: [] } });
    const askId = (await start('ui-ask', { v: '9.9' })).run.runId;
    const failId = (await start('ui-fail')).run.runId;
    await until(askId, (x) => x.status === 'awaiting-answer');
    await until(failId, settled);
    p = await open('/workflows.html#runs');
    r = await p.ev(`
      const card = [...document.querySelectorAll('.need-card')].find((c) => /UI ask/.test(c.textContent));
      const row = [...document.querySelectorAll('.run-row')].find((x) => /UI fail/.test(x.textContent));
      return { q: card?.querySelector('.need-q')?.textContent, choices: [...(card?.querySelectorAll('.answer-btn') || [])].map((b) => b.textContent),
        row: row?.textContent.replace(/\\s+/g, ' ') || '' };`);
    check('a waiting question is on the Runs panel with its choices', r.q === 'Ship 9.9?' && r.choices.join() === 'approve,reject', JSON.stringify(r));
    check('a failed run says which step failed and what it printed', /failed at “Tests”/.test(r.row) && /4 failed/.test(r.row), r.row);
    await p.ev(`[...document.querySelectorAll('.need-card')].find((c) => /UI ask/.test(c.textContent)).querySelector('[data-answer="approve"]').click();`);
    const answered = await until(askId, settled);
    check('answering from the panel finishes the run', answered.status === 'done', answered.status);
    check('the Runs panel raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    // The run page: why it failed, what it was given, how long it took.
    p = await open(`/workflows-run.html#${failId}`);
    r = await p.ev(`
      const notice = document.querySelector('#runNotice .notice.bad')?.textContent || '';
      document.querySelector('.card[data-id="t"]').click(); ${tick}
      return { notice, drawer: document.getElementById('drawerBody').textContent.replace(/\\s+/g, ' '),
        timeline: !document.getElementById('timeline').classList.contains('hidden'),
        resume: !!document.querySelector('#runActions [data-act="resume"]') };`);
    check('a failed run explains itself at the top of its page', /“Tests” failed/.test(r.notice), r.notice);
    check('a step opens to why it failed, what it was set to do and what it printed',
      /Why it failed/.test(r.drawer) && /Set up to/.test(r.drawer) && /4 failed/.test(r.drawer), r.drawer.slice(0, 200));
    check('the run page shows a timeline and offers Resume', r.timeline && r.resume, JSON.stringify(r));
    check('the run page raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
  } finally {
    try { cdp?.close?.(); } catch { /* gone */ }
    proc.kill();
    // Chrome writes its profile on the way out; give it a moment.
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir; the OS will clear it */ }
  }
}

// Standalone: pick any session on disk to satisfy the server's boot.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { listSessions } = await import('../src/core/sessions.mjs');
  const session = listSessions({ limit: 50 }).find((s) => s.file && fs.existsSync(s.file));
  let pass = 0; const fail = [];
  const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  await runWorkflowEngineChecks({ check, session });
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
