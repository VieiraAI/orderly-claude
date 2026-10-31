/**
 * Workflow engine checks — references, limits, durability, schedules.
 *
 * Runs against throwaway servers whose project, settings and schedules all
 * live in a temp directory, so nothing here touches the person's real runs,
 * schedules or spend limits. Called from smoke.mjs; also runnable alone:
 *
 *   node test/workflow-engine.mjs
 */
// First, so standalone runs read and write only a throwaway world too.
import './scratch-world.mjs';
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

    /* --------------------------- every project ---------------------------- */
    console.log('\nWorkflows: every project\n');

    // A second project with a workflow of the same id as one in the booted
    // repo. Registered the way the server registers the booted repo.
    const other = path.join(tmp, 'other-project');
    fs.mkdirSync(other, { recursive: true });
    wf.registerRoot(other);
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const twin = (title) => ({ schemaVersion: 2, id: 'twin', title, graph: { nodes: [script('where', 'pwd')], edges: [] } });
    await save(twin('Twin here'));
    wf.writeWorkflow({ def: twin('Twin there'), scope: 'project', repoRoot: other, overwrite: true });
    const inB = `scope=project&repo=${encodeURIComponent(path.resolve(other))}`;

    const listed = (await api('/api/workflows')).workflows.filter((w) => w.id === 'twin');
    const here = listed.find((w) => w.repoRoot === path.resolve(repo));
    const there = listed.find((w) => w.repoRoot === path.resolve(other));
    check('the list carries project workflows from every known repo, each tagged with its repo',
      here?.title === 'Twin here' && there?.title === 'Twin there' && there?.repoName === 'other-project',
      JSON.stringify(listed.map((w) => [w.title, w.repoRoot])));
    check('the same id in two repos is two workflows with their own keys', here && there && here.key !== there.key,
      JSON.stringify([here?.key, there?.key]));
    // A clash from before ids were unique: listed, both kept, each warned.
    check('an id already shared on disk is listed with a warning naming the other repo and a new id',
      /other-project/.test(here?.clash?.message || '') && here?.clash?.suggestedId === 'twin-project'
      && /the project project/.test(there?.clash?.message || '') && there?.clash?.suggestedId === 'twin-other-project',
      JSON.stringify([here?.clash, there?.clash]));
    check('the warning is not written into either file', !('clash' in JSON.parse(fs.readFileSync(path.join(other, '.claude', 'workflows', 'twin.json'), 'utf8'))));
    check('opening one of them by repo carries the same warning',
      (await api(`/api/workflows/twin?${inB}`)).workflow?.clash?.suggestedId === 'twin-other-project');

    let got = await api(`/api/workflows/twin?${inB}`);
    const plain = await api('/api/workflows/twin');
    check('a workflow is fetched by repo and id, and id alone still means the booted repo',
      got.workflow?.title === 'Twin there' && plain.workflow?.title === 'Twin here',
      JSON.stringify([got.workflow?.title, plain.workflow?.title]));
    check('a repo Orderly does not know is refused', (await api(`/api/workflows/twin?scope=project&repo=${encodeURIComponent(path.join(tmp, 'nowhere'))}`)).status === 400);

    const runThere = (await api('/api/workflows/twin/run', { body: { scope: 'project', repo: other } })).run;
    const runHere = (await api('/api/workflows/twin/run', { body: {} })).run;
    check('a run of another repo\'s workflow runs in that repo',
      runThere?.repoRoot === path.resolve(other) && runThere?.cwd === path.resolve(other) && runThere?.workflowTitle === 'Twin there',
      JSON.stringify([runThere?.repoRoot, runThere?.cwd]));
    r = await until(runThere.runId, settled);
    check('…and its scripts see that repo as their folder', real(node(r, 'where')?.output?.out?.trim()) === real(other),
      node(r, 'where')?.output?.out || states(r));
    r = await until(runHere.runId, settled);
    check('…while the booted repo\'s workflow of the same id runs in the booted repo',
      runHere?.cwd === repo && real(node(r, 'where')?.output?.out?.trim()) === real(repo), node(r, 'where')?.output?.out || states(r));
    const pastThere = (await api(`/api/runs?workflow=twin&scope=project&repo=${encodeURIComponent(other)}`)).runs || [];
    check('past runs asked for by repo leave out a same-id workflow\'s runs from another repo',
      pastThere.some((x) => x.runId === runThere.runId) && !pastThere.some((x) => x.runId === runHere.runId),
      JSON.stringify(pastThere.map((x) => x.repoRoot)));

    const savedB = await api('/api/workflows', { body: { def: twin('Twin there, edited'), scope: 'project', repoRoot: other, overwrite: true } });
    got = await api(`/api/workflows/twin?${inB}`);
    check('saving another repo\'s workflow writes to that repo, not the booted one',
      savedB.saved && got.workflow?.title === 'Twin there, edited' && (await api('/api/workflows/twin')).workflow?.title === 'Twin here',
      JSON.stringify(savedB));
    await api('/api/workflows/twin/lessons', { body: { scope: 'project', repo: other, lesson: { note: 'Check the folder first', pin: true } } });
    const fileB = JSON.parse(fs.readFileSync(path.join(other, '.claude', 'workflows', 'twin.json'), 'utf8'));
    const fileA = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'workflows', 'twin.json'), 'utf8'));
    check('a lesson lands on the workflow it was written for',
      fileB.lessons?.length === 1 && !fileA.lessons?.length, JSON.stringify([fileB.lessons, fileA.lessons]));
    check('where a workflow was found is never written into its file',
      !('repoRoot' in fileB) && !('key' in fileB) && !('scope' in fileB), Object.keys(fileB).join(' '));
    const exportedB = await fetch(`${base}/api/workflows/twin/export?${inB}`, { headers: { connection: 'close' } }).then((x) => x.json());
    check('export takes the workflow named by repo and id', exportedB.title === 'Twin there, edited' && !('repoRoot' in exportedB), exportedB.title);
    const delB = await api(`/api/workflows/twin?${inB}`, { method: 'DELETE' });
    check('deleting another repo\'s workflow leaves the booted repo\'s one of the same id',
      delB.deleted && !fs.existsSync(path.join(other, '.claude', 'workflows', 'twin.json'))
      && fs.existsSync(path.join(repo, '.claude', 'workflows', 'twin.json')), JSON.stringify(delB));

    /* ------------------------------ unique ids ------------------------------ */
    console.log('\nWorkflows: unique ids\n');

    // An unusual id, so no workflow in a real repo on this machine has it.
    const tide = (title) => ({ schemaVersion: 2, id: 'uniq-tide-zq', title, graph: { nodes: [script('a', 'echo hi')], edges: [] } });
    let u = await api('/api/workflows', { body: { def: tide('Tide there'), scope: 'project', repoRoot: other, overwrite: true } });
    check('a new id saves as given when nothing else uses it', u.saved && u.id === 'uniq-tide-zq', JSON.stringify(u));
    u = await save(tide('Tide here'));
    check('saving a new workflow whose id another repo uses is refused, with <id>-<repo> suggested',
      u.status === 409 && u.suggestedId === 'uniq-tide-zq-project' && /other-project/.test(u.error || '')
      && !fs.existsSync(path.join(repo, '.claude', 'workflows', 'uniq-tide-zq.json')), JSON.stringify(u));
    u = await save({ ...tide('Tide here'), id: u.suggestedId });
    check('saving under the suggested id works', u.saved && u.id === 'uniq-tide-zq-project', JSON.stringify(u));
    u = await api('/api/workflows', { body: { def: tide('Tide there, again'), scope: 'project', repoRoot: other, overwrite: true } });
    check('saving an existing workflow over its own file keeps its id', u.saved && u.id === 'uniq-tide-zq' && u.version === 2, JSON.stringify(u));
    check('the same id taken by a project gets -2 after the repo name',
      wf.freeId('uniq-tide-zq', { scope: 'project', repoRoot: repo }) === 'uniq-tide-zq-project-2');
    check('in the user library a clash with a project becomes <id>-mine', wf.freeId('uniq-tide-zq', { scope: 'user' }) === 'uniq-tide-zq-mine');
    check('in the user library a clash with a built-in becomes <id>-mine', wf.freeId('ship-pr', { scope: 'user' }) === 'ship-pr-mine');
    wf.writeWorkflow({ def: { ...tide('Taken'), id: 'ship-pr-mine' }, scope: 'project', repoRoot: other, overwrite: true });
    check('…and -2 when <id>-mine is taken too', wf.freeId('ship-pr', { scope: 'user' }) === 'ship-pr-mine-2');
    fs.rmSync(path.join(other, '.claude', 'workflows', 'ship-pr-mine.json'));
    u = await api('/api/workflows/import', { body: { def: tide('Tide shared'), scope: 'project' } });
    check('importing an id another repo uses is refused, naming that repo, with a free id suggested',
      u.status === 409 && u.suggestedId === 'uniq-tide-zq-project-2' && /other-project/.test(u.error || ''), JSON.stringify(u));
    u = await api('/api/workflows/scaffold?id=uniq-tide-zq');
    check('a starter workflow comes with a free id', u.def?.id === 'uniq-tide-zq-project-2', u.def?.id);

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

    // A workflow's own files: a folder beside its JSON, named by `files`.
    const filesDir = path.join(repo, '.claude', 'workflows', 'kit');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'hello.sh'), 'echo "kit says $1"\n');
    // ---- Run a workflow: one workflow as a step of another ------------------
    const flow = (id, spec, extra = {}) => ({ id, title: id, kind: 'workflow', col: 1, row: 0, spec, ...extra });
    await save({ id: 'sub-child', title: 'Sub child', inputs: [{ key: 'word', label: 'Word' }],
      graph: { nodes: [script('a', 'echo child got {{inputs.word}}')], edges: [] } });
    await save({ id: 'sub-parent', title: 'Sub parent', inputs: [{ key: 'w', label: 'W' }], graph: { nodes: [
      flow('inner', { workflow: 'sub-child', inputs: { word: '{{inputs.w}} twice' } }),
      script('after', 'echo after {{nodes.inner.output.steps.a.out}}'),
    ], edges: [['inner', 'after']] } });
    r = await until((await start('sub-parent', { w: 'hello' })).run.runId, settled);
    const innerRun = node(r, 'inner')?.output?.child?.runId;
    const kid = innerRun ? await read(innerRun) : null;
    check('a workflow runs another as one of its steps', r.status === 'done' && kid?.status === 'done', `${states(r)} child=${kid?.status}`);
    check('…filling its inputs from this run', /child got hello twice/.test(node(kid, 'a')?.output?.out || ''), node(kid, 'a')?.output?.out);
    check('…and later steps can use what its steps made', /after child got hello twice/.test(node(r, 'after')?.output?.out || ''), node(r, 'after')?.output?.out);
    check('the inner run knows which run and step started it',
      kid?.parent?.runId === r.runId && kid?.parent?.nodeId === 'inner' && kid?.parent?.chain?.join('>') === 'sub-parent>sub-child', JSON.stringify(kid?.parent));
    check('the step\'s card has the inner run\'s progress', node(r, 'inner')?.output?.child?.done === 1 && node(r, 'inner')?.output?.child?.total === 1, JSON.stringify(node(r, 'inner')?.output?.child));

    await save({ id: 'sub-self', title: 'Sub self', graph: { nodes: [flow('me', { workflow: 'sub-self' })], edges: [] } });
    r = await until((await start('sub-self')).run.runId, settled);
    check('a workflow cannot run itself', r.status === 'failed' && /inside itself/.test(node(r, 'me')?.output?.error || ''), node(r, 'me')?.output?.error);

    await save({ id: 'sub-bad', title: 'Sub bad', graph: { nodes: [script('boom', 'echo no luck; exit 3')], edges: [] } });
    await save({ id: 'sub-wraps-bad', title: 'Sub wraps bad', graph: { nodes: [flow('inner', { workflow: 'sub-bad' })], edges: [] } });
    r = await until((await start('sub-wraps-bad')).run.runId, settled);
    check('when the inner workflow fails, the step fails and says why',
      r.status === 'failed' && /Sub bad failed/.test(node(r, 'inner')?.output?.error || '') && node(r, 'inner')?.output?.child?.status === 'failed', node(r, 'inner')?.output?.error);

    await save({ id: 'sub-asks', title: 'Sub asks', graph: { nodes: [
      { id: 'ok', title: 'Looks right?', kind: 'approve', spec: { question: 'Looks right?' } }, script('then', 'echo approved'),
    ], edges: [['ok', 'then']] } });
    await save({ id: 'sub-waits', title: 'Sub waits', graph: { nodes: [flow('inner', { workflow: 'sub-asks' })], edges: [] } });
    const waitsRun = (await start('sub-waits')).run.runId;
    r = await until(waitsRun, (x) => node(x, 'inner')?.waitsFor === 'child');
    const innerAsk = node(r, 'inner')?.output?.child?.runId;
    check('a question inside the inner workflow shows on the step', node(r, 'inner')?.waitsFor === 'child'
      && /waiting for you in Sub asks: Looks right\?/.test(node(r, 'inner')?.progress || ''), `${node(r, 'inner')?.waitsFor} ${node(r, 'inner')?.progress}`);
    await api(`/api/runs/${innerAsk}/answer`, { body: { nodeId: 'ok', answer: 'approve' } });
    r = await until(waitsRun, settled);
    check('…and answering it there lets both runs finish', r.status === 'done' && !node(r, 'inner')?.waitsFor, states(r));

    await save({ id: 'sub-slow', title: 'Sub slow', graph: { nodes: [script('nap', 'sleep 20')], edges: [] } });
    await save({ id: 'sub-wraps-slow', title: 'Sub wraps slow', graph: { nodes: [flow('inner', { workflow: 'sub-slow' })], edges: [] } });
    const slowRun = (await start('sub-wraps-slow')).run.runId;
    r = await until(slowRun, (x) => node(x, 'inner')?.output?.child?.runId);
    const napRun = node(r, 'inner').output.child.runId;
    await until(napRun, (x) => node(x, 'nap')?.status === 'running');
    await api(`/api/runs/${slowRun}/stop`, { body: {} });
    const nap = await until(napRun, settled);
    check('stopping a run stops the workflow it started', nap?.status === 'stopped', nap?.status);

    await save({ id: 'sub-deep-4', title: 'Deep 4', graph: { nodes: [script('x', 'echo bottom')], edges: [] } });
    await save({ id: 'sub-deep-3', title: 'Deep 3', graph: { nodes: [flow('d', { workflow: 'sub-deep-4' })], edges: [] } });
    await save({ id: 'sub-deep-2', title: 'Deep 2', graph: { nodes: [flow('d', { workflow: 'sub-deep-3' })], edges: [] } });
    await save({ id: 'sub-deep-1', title: 'Deep 1', graph: { nodes: [flow('d', { workflow: 'sub-deep-2' })], edges: [] } });
    r = await until((await start('sub-deep-1')).run.runId, settled, 12000);
    const two = await read(node(r, 'd')?.output?.child?.runId);
    const three = await read(node(two, 'd')?.output?.child?.runId);
    check('workflows nest three deep, and no further', r.status === 'failed' && two?.status === 'failed'
      && /3 workflows deep/.test(node(three, 'd')?.output?.error || ''), node(three, 'd')?.output?.error);

    let sv = await api('/api/workflows/validate', { body: { def: { schemaVersion: 2, id: 'sub-none', graph: { nodes: [flow('w', {})], edges: [] } } } });
    check('a Run a workflow step must name its workflow', !sv.ok && sv.problems.some((p) => /pick the workflow it runs/.test(p)), JSON.stringify(sv.problems));

    await save({ id: 'kit', title: 'Kit', files: 'kit', graph: { nodes: [script('a', 'sh {{workflow.files}}/hello.sh hi')], edges: [] } });
    r = await until((await start('kit')).run.runId, settled);
    check('{{workflow.files}} runs a script the workflow ships with', /kit says hi/.test(node(r, 'a')?.output?.out || ''), states(r));
    await save({ id: 'kitless', title: 'Kitless', files: 'no-such-kit', graph: { nodes: [script('a', 'sh {{workflow.files}}/hello.sh')], edges: [] } });
    r = await until((await start('kitless')).run.runId, settled);
    check('a missing files folder fails the step and says so',
      node(r, 'a')?.status === 'failed' && /names no files folder, or that folder is not there/.test(node(r, 'a')?.output?.error || ''),
      node(r, 'a')?.output?.error);
    check('a copy of a built-in finds the built-in files folder',
      /workflow-defs\/picture-book$/.test(wf.filesDirOf({ id: 'my-book', files: 'picture-book' }) || ''));
    check('files must be a plain folder name',
      wf.validateDefinition({ id: 'x', title: 'x', schemaVersion: 2, files: '../etc', graph: { nodes: [script('a', 'true')], edges: [] } })
        .some((p) => /files must be a folder name/.test(p)));
    const book = wf.getDefinition('picture-book', {});
    check('the picture-book built-in is valid and has its files', book?.scope === 'builtin' && !book.invalid
      && fs.existsSync(path.join(wf.filesDirOf(book), 'book.sh')), JSON.stringify(book?.problems));

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

    // A 1×1 PNG, written twice inside the project and once outside it.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await save({ id: 'shows', title: 'Shows', graph: { nodes: [
      script('make', `mkdir -p out && echo ${png} | base64 -d > out/a.png && cp out/a.png out/b.png && cp out/a.png ../outside.png`,
        { show: 'out/*.png, ../outside.png' }),
    ], edges: [] } });
    r = await until((await start('shows')).run.runId, settled);
    const shown = node(r, 'make')?.output?.images || [];
    check('a command step shows the pictures it made', shown.length === 2 && shown.map((x) => x.name).join() === 'out/a.png,out/b.png',
      JSON.stringify(shown.map((x) => x.name)));
    check('…and never a file outside the project, even when asked', !shown.some((x) => /outside/.test(x.name)));
    const sha = /^blob:sha256:([a-f0-9]{64})/.exec(shown[0]?.ref || '')?.[1];
    const img = sha ? await fetch(`${base}/api/blob?sha=${sha}`) : null;
    check('a shown picture is kept, and served as an image', img?.status === 200 && img.headers.get('content-type') === 'image/png');

    // Pictures show while the step still runs, each once it is finished. One
    // was there before the step and is left alone; one is written in two
    // parts, a second apart, and must only ever show whole.
    fs.mkdirSync(path.join(repo, 'live'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'live-src.png'), Buffer.from(png, 'base64'));
    fs.copyFileSync(path.join(repo, 'live-src.png'), path.join(repo, 'live', 'old.png'));
    await save({ id: 'live', title: 'Live', graph: { nodes: [
      script('draw', 'for i in 1 2 3; do sleep 1.5; cp live-src.png live/p$i.png; echo "  page $i: live/p$i.png"; done; '
        + 'head -c 30 live-src.png > live/half.png; sleep 1; tail -c +31 live-src.png >> live/half.png; sleep 4.5',
        { show: 'live/*.png' }),
    ], edges: [] } });
    const liveId = (await start('live')).run.runId;
    const seen = [];
    r = await until(liveId, (x) => {
      const d = node(x, 'draw');
      if (d?.status === 'running') seen.push({ images: d.output?.images || [], out: d.output?.out || '' });
      return settled(x);
    }, 20_000);
    const named = (list, re) => list.filter((m) => re.test(m.name));
    const counts = seen.map((x) => named(x.images, /\/p\d\.png$/).length);
    check('a running step shows some of its pictures before it ends', counts.some((c) => c >= 1 && c < 3), JSON.stringify(counts));
    const finalImgs = node(r, 'draw')?.output?.images || [];
    check('…and all of them when it is done', node(r, 'draw')?.status === 'done' && named(finalImgs, /\/p\d\.png$/).length === 3,
      JSON.stringify(finalImgs.map((m) => m.name)));
    check('a picture there before the step, untouched, is not shown as new while it runs',
      seen.length > 0 && !seen.some((x) => named(x.images, /old\.png$/).length) && named(finalImgs, /old\.png$/).length === 1);
    const wholeRef = named(finalImgs, /half\.png$/)[0]?.ref;
    const halfRefs = [...new Set(seen.flatMap((x) => named(x.images, /half\.png$/).map((m) => m.ref)))];
    check('a picture still being written is not shown until it is whole',
      !!wholeRef && halfRefs.length === 1 && halfRefs[0] === wholeRef, JSON.stringify({ halfRefs, wholeRef }));
    check('a running step shows the last lines it printed', seen.some((x) => /page \d: live\/p\d\.png/.test(x.out)),
      JSON.stringify(seen.map((x) => x.out).filter(Boolean).slice(-1)));

    /* --------------------------- redo one picture --------------------------- */
    console.log('\nWorkflows: redo one picture\n');
    {

    // A step that draws two pictures, each with its prompt beside it, and
    // can draw one again: the redo copies the prompt it was given beside the
    // picture and makes the picture different, so a change can be seen.
    fs.writeFileSync(path.join(repo, 'two.png'), Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('x')]));
    await save({ id: 'redo', title: 'Redo', graph: { nodes: [
      script('art', `mkdir -p art && for p in a b; do echo ${png} | base64 -d > art/$p.png; echo "prompt $p" > art/$p.prompt.txt; done`,
        { show: 'art/*.png', redo: { cmd: 'cp {{redo.prompt}} "$(dirname {{redo.file}})/$(basename {{redo.file}} .png).prompt.txt" && cp two.png {{redo.file}} && echo {{inputs.who}} > redo-by.txt' } }),
      script('after', 'true'),
    ], edges: [['art', 'after']] } });
    r = await until((await start('redo', { who: 'me; rm -rf x' })).run.runId, settled);
    const redoId = r.runId;
    let meta = await api(`/api/runs/${redoId}`);
    check('a step with a redo is listed as able to draw single pictures', meta.redoSteps?.join() === 'art', JSON.stringify(meta.redoSteps));
    const got = await api(`/api/runs/${redoId}/nodes/art/redo?name=${encodeURIComponent('art/a.png')}`);
    check('the prompt that drew a picture is read from beside it', got.prompt === 'prompt a\n', JSON.stringify(got));
    const before = node(r, 'art').output.images.map((m) => m.ref);
    const started = await api(`/api/runs/${redoId}/nodes/art/redo`, { body: { name: 'art/a.png', prompt: "it's a new prompt" } });
    check('a redo starts at once and says so', started.status === 202 && started.drawing === true, JSON.stringify(started));
    meta = await (async () => {
      const end = Date.now() + 8000;
      let m = null;
      while (Date.now() < end) { m = await api(`/api/runs/${redoId}`); if (!m.redos?.length) break; await sleep(80); }
      return m;
    })();
    const after = node(meta.run, 'art').output.images.map((m) => m.ref);
    check('only the picture asked for is drawn again', after[0] !== before[0] && after[1] === before[1], JSON.stringify({ before, after }));
    check('the edited prompt reaches the command whole',
      fs.readFileSync(path.join(repo, 'art', 'a.prompt.txt'), 'utf8') === "it's a new prompt");
    check('run inputs in a redo command are quoted', fs.readFileSync(path.join(repo, 'redo-by.txt'), 'utf8').trim() === 'me; rm -rf x');
    check('the run notes when the picture was drawn again', !!node(meta.run, 'art').output.redone?.['art/a.png']);
    const bad = await api(`/api/runs/${redoId}/nodes/art/redo`, { body: { name: '../outside.png', prompt: 'x' } });
    check('only a picture the step showed can be drawn again', bad.status === 400 && /not one of the pictures/.test(bad.error || ''), JSON.stringify(bad));
    const none = await api(`/api/runs/${redoId}/nodes/after/redo`, { body: { name: 'art/a.png', prompt: 'x' } });
    check('a step without a redo refuses one', none.status === 400 && /cannot draw single pictures/.test(none.error || ''), JSON.stringify(none));
    fs.writeFileSync(path.join(repo, 'two.png'), '');
    await save({ id: 'redo-fail', title: 'Redo fail', graph: { nodes: [
      script('art', `mkdir -p art && echo ${png} | base64 -d > art/a.png`, { show: 'art/a.png', redo: { cmd: 'echo "no credits left" >&2; exit 3' } }),
    ], edges: [] } });
    const failId = (await until((await start('redo-fail')).run.runId, settled)).runId;
    await api(`/api/runs/${failId}/nodes/art/redo`, { body: { name: 'art/a.png', prompt: 'x' } });
    const failMeta = await (async () => {
      const end = Date.now() + 8000;
      let m = null;
      while (Date.now() < end) { m = await api(`/api/runs/${failId}`); if (m.redos?.[0]?.status === 'failed') break; await sleep(80); }
      return m;
    })();
    check('a failed redo says why, and leaves the picture as it was',
      /no credits left/.test(failMeta.redos?.[0]?.error || '') && !failMeta.run.graph.nodes[0].output.redone, JSON.stringify(failMeta.redos));
    }

    /* ------------------------------ verify retries ---------------------------- */
    console.log('\nWorkflows: verify retries\n');

    // Call the agent handler directly so every prompt it sends is kept; the
    // run record only holds the last one. The mock judge fails any rubric
    // with MOCK_FAIL in it, so each of the three attempts fails.
    const handlers = await import('../src/core/workflow-handlers.mjs');
    const sent = [];
    const draftNode = { id: 'd', title: 'Draft', kind: 'agent', spec: { prompt: 'Write the story.', output: 'markdown',
      verify: { asserts: [{ type: 'llm-judge', rubric: 'MOCK_FAIL reads well' }], maxRetries: 2, onFail: 'skip' } } };
    const vOut = await handlers.getHandler('agent')(draftNode, {
      run: { workflowTitle: 'Verify', cwd: repo, inputs: {}, graph: { nodes: [draftNode], edges: [] } },
      onProgress: () => {}, recordSent: (t) => sent.push(String(t)),
    });
    const drafts = sent.filter((t) => /Draft a focused Markdown document/.test(t));
    const third = drafts[2] || '';
    check('every verify attempt is still recorded', vOut?.verify?.attempts?.length === 3, vOut?.verify?.attempts?.length);
    check('a retry sends back the previous draft', /## Your previous draft[\s\S]*A stub body produced/.test(third), third.slice(-600));
    check('a retry lists only the latest failures, not every earlier one',
      (third.match(/mock judge failed it/g) || []).length === 1 && /change nothing else that works/.test(third), third.slice(-600));
    check('the first attempt is not asked to revise anything', drafts[0] && !/previous draft/.test(drafts[0]));

    // A verify that fails with onFail "stop" fails the step but keeps its draft.
    await save({ id: 'vstop', title: 'Vstop', graph: { nodes: [
      { id: 'd', title: 'Draft', kind: 'agent', spec: { prompt: 'Write the story.', output: 'markdown',
        verify: { asserts: [{ type: 'llm-judge', rubric: 'MOCK_FAIL reads well' }], maxRetries: 1 } } },
    ], edges: [] } });
    r = await until((await start('vstop')).run.runId, settled);
    const stopped = node(r, 'd');
    check('a step that fails verify keeps its last draft and verdicts',
      r.status === 'failed' && stopped?.status === 'failed' && /verify failed/.test(stopped?.output?.error || '')
      && /A stub body produced/.test(stopped?.output?.body || '')
      && stopped?.output?.verify?.pass === false && stopped.output.verify.attempts?.length === 2
      && stopped.output.verify.results?.some((x) => x.type === 'llm-judge'),
      JSON.stringify(stopped?.output).slice(0, 300));
    const onDisk = wf.readRun(r.runId, { repoRoot: repo });
    check('…and run.json has it too', /A stub body produced/.test(onDisk?.graph?.nodes?.find((n) => n.id === 'd')?.output?.body || ''));

    // A judge that broke its JSON and then corrected itself.
    const selfCorrected = '{"pass": false, "reason": "Page 3 contradicts page 1" "and the ending is rushed"}\n\n'
      + 'Correction: valid JSON output:\n\n{"pass": true, "reason": "The story is consistent and reads {well}."}';
    const verdict = handlers.extractJson(selfCorrected, { want: (o) => typeof o.pass === 'boolean', last: true });
    check("the judge's corrected verdict is the one read", verdict?.pass === true && /reads \{well\}/.test(verdict?.reason || ''),
      JSON.stringify(verdict));
    check('plain JSON parsing still takes the first object',
      handlers.extractJson('Here: {"a": 1} and later {"a": 2}')?.a === 1);

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

    /* ---------------------------- redo one step ----------------------------- */
    console.log('\nWorkflows: redo a step in the same run\n');

    const tally = (name) => path.join(tmp, `tally-${name}`);
    const count = (name) => { try { return fs.readFileSync(tally(name), 'utf8').length; } catch { return 0; } };
    const bump = (name) => `printf x >> '${tally(name)}'`;
    await save({ id: 'redo', title: 'Redo', graph: { nodes: [
      script('a', bump('a')), script('b', bump('b')),
      { id: 'ok', title: 'Go on?', kind: 'approve', spec: { question: 'Go on?' } }, script('c', bump('c')),
    ], edges: [['a', 'b'], ['b', 'ok'], ['ok', 'c']] } });
    const redoRun = (await start('redo')).run.runId;
    await until(redoRun, (x) => x.status === 'awaiting-answer');
    res = await api(`/api/runs/${redoRun}/redo-step`, { body: { nodeId: 'a', mode: 'alone' } });
    r = await until(redoRun, (x) => x.status === 'awaiting-answer' && node(x, 'a')?.status === 'done' && count('a') === 2);
    check('redo alone, while live, runs the step again in the same run',
      res.status === 200 && count('a') === 2 && r.runId === redoRun, `${res.status} ${res.error || ''} a=${count('a')}`);
    check('…keeps later steps that finished', count('b') === 1 && node(r, 'b')?.status === 'done', `b=${count('b')}`);
    check('…and asks a later question again', node(r, 'ok')?.waitsFor === 'you' && r.redos?.length === 1, states(r));
    await api(`/api/runs/${redoRun}/answer`, { body: { nodeId: 'ok', answer: 'approve' } });
    r = await until(redoRun, settled);
    check('the run carries on to the end after a redo', r.status === 'done' && count('c') === 1, `${states(r)} c=${count('c')}`);

    res = await api(`/api/runs/${redoRun}/redo-step`, { body: { nodeId: 'b', mode: 'onward' } });
    r = await until(redoRun, (x) => x.status === 'awaiting-answer');
    check('redo from a step on a finished run starts it again from that step',
      res.status === 200 && count('a') === 2 && count('b') === 2 && node(r, 'c')?.status === 'pending', `${res.error || ''} ${states(r)}`);
    await api(`/api/runs/${redoRun}/answer`, { body: { nodeId: 'ok', answer: 'approve' } });
    r = await until(redoRun, settled);
    check('…and every later step runs again', r.status === 'done' && count('c') === 2, `${states(r)} c=${count('c')}`);

    res = await api(`/api/runs/${redoRun}/redo-step`, { body: { nodeId: 'a', mode: 'sideways' } });
    check('an unknown redo mode is refused', res.status === 400 && /mode must be one of/.test(res.error || ''), res.error);

    await save({ id: 'redo-busy', title: 'Redo busy', graph: { nodes: [
      script('slow', `${bump('slow')}; sleep 2`), script('quick', `${bump('quick')}; sleep 1`), script('next', bump('next')),
    ], edges: [['quick', 'next']] } });
    const busyRun = (await start('redo-busy')).run.runId;
    await until(busyRun, (x) => node(x, 'quick')?.status === 'running' && node(x, 'slow')?.status === 'running');
    res = await api(`/api/runs/${busyRun}/redo-step`, { body: { nodeId: 'next', mode: 'alone' } });
    check('a step that has not run yet cannot be redone', res.status === 400 && /has not run yet/.test(res.error || ''), res.error);
    res = await api(`/api/runs/${busyRun}/redo-step`, { body: { nodeId: 'quick', mode: 'alone' } });
    r = await until(busyRun, settled);
    check('redoing a running step stops it and starts it again',
      res.status === 200 && r.status === 'done' && count('quick') === 2 && count('next') === 1, `${res.error || ''} ${states(r)} quick=${count('quick')}`);
    check('…while other running steps carry on untouched', count('slow') === 1 && node(r, 'slow')?.status === 'done', `slow=${count('slow')}`);

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
    check('a built-in copied into a project gets <id>-<repo>', dup.saved === true && dup.id === 'ship-pr-project', JSON.stringify(dup));
    const catalog = (await api('/api/workflows')).workflows;
    const mine = catalog.find((w) => w.id === dup.id);
    check('the copy is yours, records where it came from, and no longer hides the built-in',
      mine?.scope === 'project' && mine?.derivedFrom?.id === 'ship-pr' && /\(yours\)/.test(mine?.title)
      && catalog.some((w) => w.id === 'ship-pr' && w.scope === 'builtin'), JSON.stringify(mine?.derivedFrom));
    const dup2 = await api('/api/workflows/ship-pr/duplicate', { body: { scope: 'project' } });
    check('copying again picks a free name instead of overwriting', dup2.id !== dup.id, dup2.id);

    const exp = await fetch(`${base}/api/workflows/refs/export`);
    const exported = await exp.json();
    check('a workflow exports as a single file', /attachment; filename="refs.workflow.json"/.test(exp.headers.get('content-disposition') || '')
      && exported.id === 'refs' && !('scope' in exported) && !('file' in exported));
    res = await api('/api/workflows/import', { body: { def: exported, scope: 'project' } });
    check('importing a name you already have is refused, with a free one suggested',
      res.status === 409 && res.suggestedId === 'refs-project' && /You already have/.test(res.error || ''), JSON.stringify(res));
    res = await api('/api/workflows/import', { body: { def: { ...exported, id: res.suggestedId }, scope: 'project' } });
    check('importing under the suggested name works', res.saved === true && res.id === 'refs-project', JSON.stringify(res));
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

    // The second project and its twin workflow, for the per-project sections.
    await browserChecks({ check, base, api, save, start, until, settled, node, repo, other, twin, wf });
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
async function browserChecks({ check, base, api, save, start, until, settled, node, repo, other, twin, wf }) {
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
    let p = await open('/workflow-editor.html');
    let r = await p.ev(`
      const $ = (id) => document.getElementById(id);
      const fire = (el, t = 'input') => el.dispatchEvent(new Event(t, { bubbles: true }));
      const empty = document.querySelectorAll('.n-card').length;
      const sideHidden = $('edLayout').classList.contains('no-sel');
      $('wfTitle').value = 'Page check'; fire($('wfTitle'));
      $('btnSettings').click(); ${tick}
      $('btnAddInput').click(); ${tick}
      const k = document.querySelector('#inputsList [data-f="key"]'); k.value = 'who'; fire(k);
      const add = async (kind, after) => {
        $('btnAddNodeOpen').click();
        $('newKind').value = kind; fire($('newKind'), 'change');
        $('newAfter').value = after || '';
        $('btnAddNode').click(); ${tick}
      };
      const kinds = [...$('newKind').options].map((o) => o.textContent);
      await add('script');
      const c = document.querySelector('#selSpec [data-spec="cmd"]'); c.value = 'echo hi'; fire(c);
      await add('agent', 'script');
      const pr = document.querySelector('#selSpec [data-spec="prompt"]');
      pr.focus(); pr.value = 'Use '; pr.selectionStart = pr.selectionEnd = 4;
      document.querySelector('#selSpec .ref-btn[data-for="sp-prompt"]').click(); ${tick}
      const offered = [...document.querySelectorAll('#refPop button[data-ref]')].map((b) => b.dataset.ref);
      document.querySelector('#refPop button[data-ref="{{nodes.script.output.out}}"]').click(); ${tick}
      await new Promise((r) => setTimeout(r, 900));
      return { empty, sideHidden, kinds, id: $('wfId').value, cards: document.querySelectorAll('.n-card').length,
        edges: document.querySelectorAll('#edEdges .edge-hit').length, offered, prompt: pr.value,
        preview: !$('preview').classList.contains('hidden') && /Use/.test($('previewText').textContent) };`);
    check('a new workflow starts from an empty canvas, sidebar out of the way', r.empty === 0 && r.sideHidden, JSON.stringify([r.empty, r.sideHidden]));
    check('steps are offered by what they do', r.kinds.includes('Ask Claude') && r.kinds.includes('Ask me to approve'), r.kinds.join(', '));
    check('the name fills in the short name', r.id === 'page-check', r.id);
    check('a step added "after" another is connected to it', r.cards === 2 && r.edges === 1, JSON.stringify(r));
    check('the reference picker offers inputs and what earlier steps produced',
      r.offered.includes('{{inputs.who}}') && r.offered.includes('{{nodes.script.output.out}}'), r.offered.join(' '));
    check('picking a reference inserts it at the cursor, with a live preview', r.prompt === 'Use {{nodes.script.output.out}}' && r.preview, r.prompt);
    r = await p.ev(`
      document.querySelector('#edEdges .edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })); ${tick}
      const opened = document.getElementById('selSummary').textContent;
      document.querySelector('#selEdges [data-act="rm-edge"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const flagged = document.querySelector('.n-card[data-id="agent"]');
      const problem = flagged.classList.contains('has-problem') ? flagged.title : '';
      document.querySelector('.n-card[data-id="script"]').click();
      document.getElementById('btnConnect').click();
      document.querySelector('.n-card[data-id="agent"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const cleared = !document.querySelector('.n-card.has-problem');
      document.getElementById('wfScope').value = 'project';
      document.getElementById('btnSave').click();
      await new Promise((r) => setTimeout(r, 900));
      return { opened, problem, cleared, saved: document.getElementById('saveLine').textContent, url: location.search };`);
    check('clicking a connection opens the step it leads into', r.opened === 'Ask Claude', r.opened);
    check('removing a connection a reference relies on is flagged on the card at once', /not upstream/.test(r.problem), r.problem);
    check('reconnecting clears it, and saving moves to editing the saved file',
      r.cleared && /^saved/.test(r.saved) && r.url === '?from=page-check', JSON.stringify(r));
    check('the editor raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
    p = await open('/workflows-new.html?id=page-check');
    r = await p.ev(`return { path: location.pathname, cards: document.querySelectorAll('.n-card').length, edges: document.querySelectorAll('#edEdges .edge-hit').length, inputs: document.querySelectorAll('#inputsList .list-row').length };`);
    check('a saved workflow reopens as it was left, old links included', r.path === '/workflow-editor.html' && r.cards === 2 && r.edges === 1 && r.inputs === 1, JSON.stringify(r));
    await p.close();
    // "refs" was saved with both steps in the same spot; Tidy lines them up.
    p = await open('/workflow-editor.html?from=refs');
    r = await p.ev(`
      const left = (id) => parseFloat(document.querySelector('.n-card[data-id="' + id + '"]').style.left);
      const before = [left('src'), left('use')];
      document.getElementById('btnTidy').click(); ${tick}
      return { before, after: [left('src'), left('use')] };`);
    check('Tidy lines steps up left to right in the order they run', r.before[0] === r.before[1] && r.after[0] < r.after[1], JSON.stringify(r));
    check('Tidy raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
    // ship-pr was copied into this project above, and that copy rightly
    // shadows the built-in. Pick one that is still only a built-in here —
    // the person's own library may hold a copy of any of them.
    const stillBuiltin = (await api('/api/workflows')).workflows.find((w) => w.scope === 'builtin')?.id;
    p = await open(`/workflow-editor.html?from=${stillBuiltin}`);
    r = await p.ev(`return !document.getElementById('builtinBanner').classList.contains('hidden');`);
    check('opening a built-in says saving makes your own copy', r === true);
    await p.close();

    // A workflow's preview, and the catalog's way into the editor.
    p = await open('/workflows-run.html#def:visual-regression');
    // Clicks that navigate are fired after the evaluation returns; awaiting
    // across a navigation loses the page the script was running in.
    const before = await p.ev(`
      setTimeout(() => document.querySelector('#runActions [data-act="run-preview"]').click(), 0);
      return { status: document.getElementById('runStatus').textContent, cards: document.querySelectorAll('.card').length };`);
    await sleep(1400);
    r = { ...before, ...(await p.ev(`return { sheet: document.getElementById('shTitle')?.textContent || '', path: location.pathname };`)) };
    check('a workflow previews on its canvas before it has ever run', /^Preview/.test(r.status) && r.cards >= 4, JSON.stringify(r));
    check('Run from the preview opens its inputs sheet, not a browser prompt', r.path === '/workflows.html' && /visual regression/i.test(r.sheet), JSON.stringify(r));
    check('the preview raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
    p = await open('/workflows.html#workflows');
    await p.ev(`setTimeout(() => document.querySelector('.tile[data-id="visual-regression"] h3').click(), 0); return 1;`);
    await sleep(1200);
    r = await p.ev('return location.pathname + location.search;');
    check('clicking a workflow in the catalog opens it in the editor', r === '/workflow-editor.html?from=visual-regression', r);
    await p.close();

    // One section per project, as on the Skills page, each named for its repo.
    wf.writeWorkflow({ def: twin('Twin there'), scope: 'project', repoRoot: other, overwrite: true });
    p = await open('/workflows.html#workflows');
    await sleep(600);
    r = await p.ev(`
      const sec = (root) => document.querySelector('#projectSections section[data-repo="' + CSS.escape(root) + '"]');
      const a = sec(${JSON.stringify(path.resolve(repo))}), b = sec(${JSON.stringify(path.resolve(other))});
      const first = document.querySelector('#projectSections section');
      setTimeout(() => b?.querySelector('.tile[data-id="twin"] h3')?.click(), 0);
      return { a: a?.querySelector('h2')?.textContent, b: b?.querySelector('h2')?.textContent,
        bootedFirst: first === a, aTwin: !!a?.querySelector('.tile[data-id="twin"]'),
        bTile: b?.querySelector('.tile[data-id="twin"] h3')?.textContent };`);
    check('the Workflows page groups workflows by project, booted repo first, repo name shown',
      /^This project · project$/.test(r.a || '') && r.b === 'other-project' && r.bootedFirst && r.aTwin && r.bTile === 'Twin there', JSON.stringify(r));
    await sleep(1200);
    r = await p.ev('return location.pathname + location.search;');
    check('opening another repo\'s workflow names its repo in the editor link',
      r === `/workflow-editor.html?from=twin&scope=project&repo=${encodeURIComponent(path.resolve(other))}`, r);
    await p.close();
    p = await open(`/workflow-editor.html?from=twin&scope=project&repo=${encodeURIComponent(path.resolve(other))}`);
    await sleep(600);
    r = await p.ev(`return document.getElementById('wfTitle').value;`);
    check('the editor loads the workflow from the repo it names', r === 'Twin there', r);
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

    // Previews on the run page: a story's pages, pictures turned over six at
    // a time, a saved file, and a tall card that pushes only its own column.
    // The last step sleeps so the page is still being updated when the
    // pictures are turned over.
    const shots = path.join(repo, 'pv-shots');
    fs.mkdirSync(shots, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(shots, `p${i}.png`), png);
    await save({ id: 'ui-previews', title: 'UI previews', graph: { nodes: [
      { id: 'pics', title: 'Pictures', kind: 'script', col: 0, row: 0, spec: { cmd: 'true', show: 'pv-shots/*.png' } },
      { id: 'under', title: 'Under', kind: 'script', col: 0, row: 1, spec: { cmd: 'true' } },
      { id: 'story', title: 'Story', kind: 'agent', col: 1, row: 0, spec: { prompt: 'Write it. MOCK_PAGES', output: 'json' } },
      { id: 'keep', title: 'Keep', kind: 'publish', col: 2, row: 0, spec: { target: 'file', path: 'pv-out/story.json', content: 'x' } },
      { id: 'next', title: 'Next', kind: 'script', col: 2, row: 1, spec: { cmd: 'sleep 3' } },
    ], edges: [['pics', 'under'], ['story', 'keep'], ['keep', 'next']] } });
    const pvId = (await start('ui-previews')).run.runId;
    await until(pvId, (x) => node(x, 'pics')?.status === 'done' && node(x, 'keep')?.status === 'done');
    p = await open(`/workflows-run.html#${pvId}`);
    const caps = `[...document.querySelectorAll('.card[data-id="pics"] .pv-cap')].map((x) => x.textContent).join()`;
    const count = `document.querySelector('.card[data-id="pics"] .pv-pager .pv-count')?.textContent`;
    r = await p.ev(`
      const first = { caps: ${caps}, count: ${count} };
      const pics = document.querySelector('.card[data-id="pics"]');
      pics.dataset.before = '1';
      pics.querySelector('[data-pv="1"]').click(); ${tick}
      return { first, second: { caps: ${caps}, count: ${count} }, drawerOn: document.getElementById('drawer').classList.contains('on') };`);
    check('more than six pictures show six at a time, with a pager',
      r.first.caps === 'p1,p2,p3,p4,p5,p6' && r.first.count === '1–6 of 8', JSON.stringify(r.first));
    check('the pager turns to the rest without opening the step drawer',
      r.second.caps === 'p7,p8' && r.second.count === '7–8 of 8' && !r.drawerOn, JSON.stringify(r));
    await until(pvId, settled);
    await sleep(800);
    r = await p.ev(`
      const card = (id) => document.querySelector('.card[data-id="' + id + '"]');
      const box = (id) => ({ top: card(id).offsetTop, bottom: card(id).offsetTop + card(id).offsetHeight, width: card(id).offsetWidth });
      const tiles = [...card('story').querySelectorAll('.pv-page')];
      return { rebuilt: !card('pics').dataset.before, caps: ${caps}, tiles: tiles.length,
        nums: tiles.map((t) => t.querySelector('.pv-n').textContent).join(),
        serif: /Georgia|serif/.test(getComputedStyle(tiles[0]).fontFamily), font: parseFloat(getComputedStyle(tiles[0]).fontSize),
        saved: card('keep').querySelector('.check-pill')?.textContent, savedName: card('keep').querySelector('.saved-name')?.textContent,
        pics: box('pics'), under: box('under'), next: box('next'), story: box('story'),
        canvas: document.getElementById('canvas').offsetHeight };`);
    check('the pictures stay on the page they were turned to when the cards are rebuilt', r.rebuilt && r.caps === 'p7,p8', JSON.stringify([r.rebuilt, r.caps]));
    check('a story an agent wrote shows each page as a little serif book page, numbered',
      r.tiles === 5 && r.nums === '1,2,3,4,5' && r.serif && r.font >= 10 && r.story.width === 470, JSON.stringify(r));
    check('a step that saved a file shows "saved" and the file name', r.saved === 'saved' && r.savedName === 'story.json', JSON.stringify([r.saved, r.savedName]));
    check('a tall card pushes down only its own column',
      r.pics.bottom > 272 && r.under.top === r.pics.bottom + 40 && r.next.top === 272 && r.canvas >= r.under.bottom,
      JSON.stringify({ pics: r.pics, under: r.under, next: r.next, canvas: r.canvas }));
    check('the previews raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    // The run page: back to the workflow, and a preview window for what a
    // step made (a page it designed, a page it saved). Then the editor:
    // right-click a step to delete it, after a confirmation.
    await save({ id: 'ui-pages', title: 'UI pages', graph: { nodes: [
      { id: 'design', title: 'Design', kind: 'agent', col: 0, row: 0, spec: { prompt: 'A landing page', output: 'html' } },
      { id: 'site', title: 'Save site', kind: 'publish', col: 1, row: 0, spec: { target: 'file', path: 'pv-out/site.html', content: '<!doctype html><h1 id="saved">Saved page</h1>' } },
      { id: 'tidy', title: 'Tidy', kind: 'script', col: 2, row: 0, spec: { cmd: 'true' } },
    ], edges: [['design', 'site'], ['site', 'tidy']] } });
    const pgId = (await start('ui-pages')).run.runId;
    await until(pgId, settled);
    p = await open(`/workflows-run.html#${pgId}`);
    r = await p.ev(`const back = document.getElementById('backToWf');
      return { back: back.textContent.trim(), href: back.getAttribute('href'), pv: [...document.querySelectorAll('.card.has-pv')].map((c) => c.dataset.id) };`);
    check('a run page has Back to workflow, to this workflow in the editor', r.back === '← Back to workflow' && /^\/workflow-editor\.html\?from=ui-pages&scope=project/.test(r.href || ''), JSON.stringify(r));
    check('steps that made a web page are marked as previewable; others are not', r.pv.join() === 'design,site', JSON.stringify(r.pv));
    r = await p.ev(`document.querySelector('.card[data-id="site"]').click(); ${tick}
      const d = document.getElementById('pvwDlg');
      const f = d?.querySelector('iframe');
      await new Promise((r) => setTimeout(r, 400));
      return { open: !!d?.open, title: d?.querySelector('#pvwTitle').textContent, file: d?.querySelector('#pvwFile').textContent,
        sandbox: f?.getAttribute('sandbox'), src: f?.getAttribute('src'), drawer: document.getElementById('drawer').classList.contains('on') };`);
    check('clicking it opens the preview window, not the step drawer', r.open && r.title === 'Save site' && r.file === 'pv-out/site.html' && !r.drawer, JSON.stringify(r));
    check('the page shows sandboxed: its scripts run, but it cannot reach Orderly', r.sandbox === 'allow-scripts', JSON.stringify(r));
    const served = await fetch(base + r.src);
    const body = await served.text();
    check('the saved page is served whole, under a sandbox policy', served.ok && /id="saved"/.test(body) && /sandbox/.test(served.headers.get('content-security-policy') || ''), `${served.status} ${served.headers.get('content-security-policy')}`);
    r = await p.ev(`const d = document.getElementById('pvwDlg');
      d.querySelector('#pvwSizes [data-w="390"]').click(); ${tick}
      const w = d.querySelector('iframe').style.width;
      d.querySelector('#pvwDetails').click(); ${tick}
      return { w, closed: !d.open, drawer: document.getElementById('drawer').classList.contains('on'), btn: !!document.getElementById('drPreview') };`);
    check('it previews at phone width, and Step details opens the drawer, which links back', r.w === '390px' && r.closed && r.drawer && r.btn, JSON.stringify(r));
    r = await p.ev(`document.getElementById('drawerClose').click();
      document.querySelector('.card[data-id="design"]').click(); ${tick}
      const d = document.getElementById('pvwDlg');
      const src = d.querySelector('iframe').getAttribute('src'); d.close();
      return { open: true, src };`);
    const mock = await fetch(base + r.src).then((x) => x.text());
    check('a page a step designed opens the same way', /<h1>Mock<\/h1>/.test(mock), mock.slice(0, 80));
    const plain = await fetch(`${base}/api/runs/${pgId}/nodes/tidy/page`);
    check('a step that made no page has nothing to serve', plain.status === 404, String(plain.status));
    check('the preview window raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    p = await open('/workflow-editor.html?from=ui-pages');
    const rightClick = (id) => `document.querySelector('.n-card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); ${tick}`;
    r = await p.ev(`${rightClick('site')}
      const d = document.getElementById('delDlg');
      return { open: !!d?.open, title: d?.querySelector('#delTitle').textContent, what: d?.querySelector('#delWhat').textContent, focus: document.activeElement?.id };`);
    check('right-clicking a step asks before deleting it, saying what goes with it',
      r.open && r.title === 'Delete “Save site”?' && /its 2 connections/.test(r.what) && r.focus === 'delCancel', JSON.stringify(r));
    r = await p.ev(`document.getElementById('delCancel').click(); ${tick}
      return { open: document.getElementById('delDlg').open, cards: document.querySelectorAll('.n-card').length };`);
    check('Cancel keeps the step', !r.open && r.cards === 3, JSON.stringify(r));
    r = await p.ev(`${rightClick('site')} document.getElementById('delGo').click(); ${tick}
      return { cards: [...document.querySelectorAll('.n-card')].map((c) => c.dataset.id), saved: document.getElementById('saveLine').textContent };`);
    check('Delete step removes it and its connections, unsaved until Save', r.cards.join() === 'design,tidy' && /unsaved/.test(r.saved), JSON.stringify(r));
    check('deleting raised no errors or browser dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    // Repeat from a step: two quick clicks start one run, and the page moves
    // to it. Only the part after # changes, which a browser does not reload for.
    p = await open(`/workflows-run.html#${failId}`);
    await p.ev(`document.querySelector('.card[data-id="t"]').click(); ${tick}
      window.oldPage = true;
      const b = document.querySelector('[data-act="rerun-from"]'); b.click(); b.click();`);
    await sleep(1500);
    const repeats = (await api('/api/runs')).runs.filter((x) => x.rerunOf === failId || x.trigger === `rerun of ${failId.slice(0, 8)}`);
    // A page that only changed its address still has the old run's state.
    r = await p.ev(`return { hash: location.hash.slice(1), reloaded: !window.oldPage, cards: document.querySelectorAll('.card').length };`);
    check('two quick clicks on Repeat from a step start one run', repeats.length === 1, `${repeats.length} runs`);
    check('Repeat from a step opens the new run', repeats.length > 0 && r.hash === repeats[0].runId && r.reloaded && r.cards > 0, JSON.stringify(r));
    check('repeating raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    // Redo a step: both choices are in the step's drawer, and two quick
    // clicks redo it once, in the same run.
    p = await open(`/workflows-run.html#${failId}`);
    r = await p.ev(`document.querySelector('.card[data-id="t"]').click(); ${tick}
      const modes = [...document.querySelectorAll('[data-redo-step]')].map((b) => b.dataset.redoStep).join();
      const why = document.querySelector('.dr-redo-why')?.textContent || '';
      const b = document.querySelector('[data-redo-step="alone"]'); b.click(); b.click();
      return { modes, why };`);
    await sleep(1500);
    const again = (await api(`/api/runs/${failId}`)).run;
    check('a step\'s drawer offers redo alone and redo from here', r.modes === 'alone,onward' && r.why.length > 0, JSON.stringify(r));
    check('two quick clicks on Redo this step redo it once, in the same run', again.redos?.length === 1, JSON.stringify(again.redos));
    check('redoing raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    // Run a workflow: the step's card links to the run it started, that run
    // links back, and the editor picks the workflow and fills its inputs.
    const outerId = (await start('sub-parent', { w: 'hi' })).run.runId;
    const outer = await until(outerId, settled);
    const innerId = node(outer, 'inner')?.output?.child?.runId;
    p = await open(`/workflows-run.html#${outerId}`);
    r = await p.ev(`const c = document.querySelector('.card[data-id="inner"]');
      return { title: c?.querySelector('.doc-h')?.textContent, line: c?.querySelector('.doc-b')?.textContent,
        link: c?.querySelector('.sub-open')?.textContent, href: c?.querySelector('.sub-open')?.getAttribute('href'),
        up: !document.getElementById('toParent').hidden };`);
    check('a Run a workflow step shows the run it started, with a link to open it',
      r.title === 'Sub child' && r.line === '1 of 1 steps' && r.link === 'Open its run ↗' && r.href === `/workflows-run.html#${innerId}` && !r.up, JSON.stringify(r));
    await p.close();
    p = await open(`/workflows-run.html#${innerId}`);
    r = await p.ev(`const up = document.getElementById('toParent'); return { shown: !up.hidden, text: up.textContent, href: up.getAttribute('href') };`);
    check('the run it started links back to the run it is part of',
      r.shown && r.text === '↑ Part of Sub parent' && r.href === `/workflows-run.html#${outerId}`, JSON.stringify(r));
    check('following runs raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();

    p = await open('/workflow-editor.html?from=sub-parent');
    await sleep(600);
    r = await p.ev(`document.querySelector('.n-card[data-id="inner"]').click(); ${tick}
      const sel = document.getElementById('sp-wf');
      return { kinds: [...document.getElementById('newKind').options].map((o) => o.textContent),
        picked: sel?.selectedOptions[0]?.textContent, word: document.getElementById('sp-inputs.word')?.value,
        hands: document.getElementById('selSpec').textContent.includes('nodes.inner.output.steps.a') };`);
    check('the editor offers Run a workflow as a kind of step', r.kinds.includes('Run a workflow'), JSON.stringify(r.kinds));
    check('a Run a workflow step shows the workflow it runs and that workflow\'s inputs',
      /^Sub child/.test(r.picked || '') && r.word === '{{inputs.w}} twice' && r.hands, JSON.stringify(r));
    r = await p.ev(`const sel = document.getElementById('sp-wf');
      sel.value = [...sel.options].find((o) => /^Sub asks/.test(o.textContent)).value;
      sel.dispatchEvent(new Event('change')); ${tick}
      return { none: document.getElementById('selSpec').textContent.includes('It asks for nothing'), saved: document.getElementById('saveLine').textContent };`);
    check('picking another workflow shows its inputs instead', r.none && /unsaved/.test(r.saved), JSON.stringify(r));
    check('the Run a workflow form raised no errors or dialogs', p.errors.length === 0, p.errors.join(' | '));
    await p.close();
  } finally {
    try { cdp?.close?.(); } catch { /* gone */ }
    proc.kill();
    // Chrome writes its profile on the way out; give it a moment.
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir; the OS will clear it */ }
  }
}

// Standalone: boot on the scratch world's session.
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
