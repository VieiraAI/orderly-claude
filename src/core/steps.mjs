import path from 'node:path';

const READONLY = new Set([
  'ls','cat','head','tail','grep','rg','egrep','fgrep','find','wc','which','type','file','stat','du','df',
  'echo','printf','pwd','env','date','ps','whoami','hostname','uname','jq','sort','uniq','awk','tree',
  'basename','dirname','realpath','readlink','diff','cmp','column','tr','cut','xxd','md5','shasum','true',
]);
const GIT_READ = new Set(['log','status','diff','show','branch','remote','config','ls-files','rev-parse','describe','blame','tag']);
const GH_READ = new Set(['view','list','status','api','search']);

/** Is this shell command read-only? Read-only commands merge into one "inspected" bubble. */
export function classifyBash(cmd = '') {
  const segs = String(cmd).split(/\n|&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
  if (!segs.length) return 'inspect';
  for (const seg of segs) {
    const toks = seg.split(/\s+/).filter(Boolean);
    let head = (toks[0] === 'sudo' ? toks[1] : toks[0]) || '';
    head = head.replace(/^.*\//, '');
    if (head === 'cd' || head === 'export') continue;
    if (head === 'git') { if (!GIT_READ.has(toks[1])) return 'change'; continue; }
    if (head === 'gh')  { if (!GH_READ.has(toks[1]) && !GH_READ.has(toks[2])) return 'change'; continue; }
    if (head === 'sed') { if (!seg.includes('-n')) return 'change'; continue; }
    if (!READONLY.has(head)) return 'change';
  }
  return 'inspect';
}

const CHANGE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const INSPECT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ToolSearch', 'WebFetch', 'WebSearch', 'ListAgents']);
// The mod registers its tool as mcp__orderly-claude__plan. The former name
// and TodoWrite are honoured so older transcripts still read correctly.
const PLAN_TOOLS = new Set(['mcp__orderly-claude__plan', 'mcp__claudenized__plan', 'TodoWrite']);

function humanTool(name = '') {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `${parts[1]} · ${(parts[2] || '').replace(/_/g, ' ')}`;
  }
  return name;
}

function labelFor(call) {
  const { name, input = {} } = call;
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash':   return input.description || String(input.command || '').split('\n')[0].slice(0, 60);
    case 'Edit':
    case 'MultiEdit': return `Edited ${base(input.file_path)}`;
    case 'Write':  return `Wrote ${base(input.file_path)}`;
    case 'Read':   return `Read ${base(input.file_path)}`;
    case 'Glob':   return `Searched for ${input.pattern || 'files'}`;
    case 'Grep':   return `Searched for "${String(input.pattern || '').slice(0, 40)}"`;
    case 'WebSearch': return `Searched the web: ${String(input.query || '').slice(0, 50)}`;
    case 'WebFetch':  return `Fetched ${String(input.url || '').slice(0, 50)}`;
    case 'Task':
    case 'Agent':  return `Delegated: ${input.description || 'subtask'}`;
    case 'Skill':  return `Used skill: ${input.skill || ''}`;
    case 'AskUserQuestion': {
      const n = (input.questions || []).length;
      return n ? `Asked you ${n} question${n > 1 ? 's' : ''}` : 'Asked you a question';
    }
    case 'Artifact': return `Published artifact${input.title ? `: ${input.title}` : ''}`;
    default:       return humanTool(name);
  }
}

function kindFor(call) {
  const { name, input = {} } = call;
  if (PLAN_TOOLS.has(name)) return 'plan';
  if (CHANGE_TOOLS.has(name)) return 'change';
  if (INSPECT_TOOLS.has(name)) return 'inspect';
  if (name === 'Bash') return classifyBash(input.command);
  return 'change';
}

function targetOf(call) {
  return call.input?.file_path || call.input?.notebook_path || null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || `[${b?.type || 'block'}]`)).join('\n');
  }
  return '';
}

function stripReminders(text = '') {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}

function tokens(s = '') {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
}
/** Jaccard overlap, used to match an executed step back to a declared one. */
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/* Steps where Claude stopped and needed the person, rather than carrying on. */
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const NEEDS_YOU = /permission (?:for this|to use)|requires approval|needs? your (?:approval|permission|answer)|has no approval surface|doesn't want to proceed|rejected the|awaiting your/i;

function isUserPrompt(rec) {
  if (rec.type !== 'user' || rec.isSidechain) return false;
  // Skill loads and tool-driven injections arrive as user records; they are not prompts.
  if (rec.isMeta || rec.sourceToolUseID || rec.turnCompanion) return false;
  const c = rec.message?.content;
  if (typeof c === 'string') return stripReminders(c).length > 0;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return false;
    return c.some((b) => b?.type === 'text' && stripReminders(b.text).length > 0);
  }
  return false;
}

function promptText(rec) {
  const c = rec.message?.content;
  if (typeof c === 'string') return stripReminders(c);
  if (Array.isArray(c)) {
    return stripReminders(c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
  }
  return '';
}

/**
 * Build the session model: turns, each holding bubble-sized steps.
 * Declared steps (from a plan tool) seed the list as `pending`; executed work
 * either matches a declared step or is inserted as `emergent`.
 */
export function buildSession(records, { live = false } = {}) {
  const results = new Map();
  for (const r of records) {
    const c = r.message?.content;
    if (r.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_result') {
          results.set(b.tool_use_id, { isError: !!b.is_error, text: resultText(b.content) });
        }
      }
    }
  }

  const pick = (key) => records.find((r) => r[key])?.[key] || null;
  const meta = {
    sessionId: pick('sessionId') || pick('session_id'),
    cwd: pick('cwd'),
    gitBranch: pick('gitBranch'),
  };
  const titleRec = [...records].reverse().find((r) => r.type === 'ai-title');
  const session = {
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    title: titleRec?.title || titleRec?.aiTitle || null,
    startedAt: records.find((r) => r.timestamp)?.timestamp || null,
    endedAt: [...records].reverse().find((r) => r.timestamp)?.timestamp || null,
    turns: [],
  };

  let turn = null;
  let group = null;
  let stepSeq = 0;

  const newTurn = (rec) => {
    turn = {
      id: `t${session.turns.length + 1}`,
      prompt: promptText(rec),
      promptAt: rec.timestamp || null,
      steps: [],
      declared: [],
      intro: '',
      summary: '',
      thinking: [],
    };
    session.turns.push(turn);
    group = null;
  };

  const newStep = (label, kind, rec) => {
    const step = {
      id: `s${++stepSeq}`,
      label,
      kind,
      status: 'done',
      emergent: true,
      declaredLabel: null,
      startedAt: rec.timestamp || null,
      endedAt: rec.timestamp || null,
      calls: [],
      notes: [],
      thinking: [],
      files: [],
      shots: null,
      agent: rec.isSidechain ? 'sub' : 'main',
    };
    turn.steps.push(step);
    return step;
  };

  for (const rec of records) {
    if (isUserPrompt(rec)) { newTurn(rec); continue; }
    if (rec.type !== 'assistant' || !turn) continue;
    const blocks = rec.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const b of blocks) {
      if (b?.type === 'thinking') {
        (group || turn).thinking.push(String(b.thinking || '').trim());
        continue;
      }
      if (b?.type === 'text') {
        const t = stripReminders(b.text);
        if (t) {
          if (!turn.intro) turn.intro = t;
          else turn.summary = t;
          if (group) group.notes.push(t);
        }
        group = null; // prose is a natural boundary between steps
        continue;
      }
      if (b?.type !== 'tool_use') continue;

      const kind = kindFor(b);

      if (kind === 'plan') {
        const items = b.input?.steps || b.input?.todos || [];
        turn.declared = items.map((it) =>
          typeof it === 'string' ? it : it.label || it.content || it.title || ''
        ).filter(Boolean);
        continue;
      }

      const label = labelFor(b);
      // No result recorded yet means this call is still in flight right now.
      const res = results.get(b.id);
      const inFlight = res === undefined;
      const target = targetOf(b);

      const mergeable =
        group &&
        group.kind === kind &&
        ((kind === 'inspect') ||
          (kind === 'change' && target && group.target === target) ||
          (group.label === label));

      if (!mergeable) {
        group = newStep(label, kind, rec);
        group.target = target;
      } else if (kind === 'inspect' && group.calls.length === 1) {
        group.label = group.label.replace(/\s*\(\d+ steps\)$/, '');
      }

      group.calls.push({
        id: b.id,
        tool: b.name,
        toolLabel: humanTool(b.name),
        input: b.input || {},
        label,
        isError: !!res?.isError,
        pending: inFlight,
        result: (res?.text || '').slice(0, 20000),
        at: rec.timestamp || null,
      });
      group.endedAt = rec.timestamp || group.endedAt;
      if (inFlight) group.inFlight = true;
      if (res?.isError) group.status = 'warn';
      // Only changes get a file entry; reads shouldn't claim a before/after.
      if (kind === 'change' && target && !group.files.some((f) => f.path === target)) {
        group.files.push({ path: target });
      }
    }
  }

  // Merge counts, declared matching, and terminal status
  for (const t of session.turns) {
    for (const s of t.steps) {
      if (s.calls.length > 1 && s.kind === 'inspect') {
        s.label = `${s.label} (${s.calls.length} commands)`;
      }
      const errors = s.calls.filter((c) => c.isError).length;
      if (errors && errors === s.calls.length) s.status = 'failed';
      else if (errors) s.status = 'warn';
      // Only a live session can still be running; in a replay nothing is.
      if (s.inFlight && live) s.status = 'running';

      // A step that asked something, or was stopped for want of permission,
      // is a decision point — the person has to act before it can move.
      const asks = s.calls.filter((c) => ASK_TOOLS.has(c.tool));
      const blocked = s.calls.filter((c) => c.isError && NEEDS_YOU.test(c.result || ''));
      if (asks.length || blocked.length) {
        s.needsUser = true;
        // An answered question is settled; a refused one, or a blocked call,
        // is still waiting on the person.
        s.userResolved = asks.length > 0
          && asks.some((c) => !c.isError && !c.pending)
          && blocked.length === 0;
      }

      if (t.declared.length) {
        let best = null, bestScore = 0;
        for (const d of t.declared) {
          const score = similar(d, s.label);
          if (score > bestScore) { bestScore = score; best = d; }
        }
        if (bestScore >= 0.34) { s.emergent = false; s.declaredLabel = best; }
      }
    }
    // Declared steps never reached stay as pending bubbles
    const matched = new Set(t.steps.map((s) => s.declaredLabel).filter(Boolean));
    t.pending = t.declared.filter((d) => !matched.has(d));
  }

  return session;
}
