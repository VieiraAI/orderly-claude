# Workflows: from demo graph to something people build with

A plan for turning the Workflows page into a place where people author their
own pipelines, and the Runs page into the control panel for them.

Everything in **Where it stands** was read out of the code, not assumed.
Everything under **The plan** is a proposal.

---

## Status — October 2026

Phases 1 to 4 are built. Between this plan and the build, schema v2 landed
(#9) with an authored `agent` kind, decisions that route, gates, loops and
approvals — which was most of Decision 2. The build went on from there.

**Shipped**

| Decision | What exists now |
| --- | --- |
| 2 — authored steps | Every field handlers read is in the editor; steps can name skills (`uses`) |
| 3 — references | `{{inputs.*}}`, `{{nodes.id.output.field}}`, `{{nodes.*.output}}`, `{{item}}`, `{{workflow.files}}`; upstream-only, checked on save; live preview from the last run; shell values quoted |
| 4 — durability | Boot reconcile, `interrupted` on shutdown, Resume, answers kept in `run.json`, retries with backoff, per-step timeouts, a concurrency cap, spend ceilings |
| 5 — fan-out ceiling | The existing loop gained `max` (≤ 500) and `concurrency` (≤ 8) and stops at the spend limit |
| 6 — control panel | Counts, answer-from-the-list, cut-short runs with Resume, failure drill-down, timeline, filters, spend |
| 7 — pinned definitions | Every run carries the definition and version it ran; reruns use it |
| 8 — ownership | Empty canvas, *Make it yours*, user scope by default, export/import, delete, broken files listed and flagged rather than hidden |
| 9 — schedules | Lock-elected ticker, missed windows counted not replayed, per-schedule and daily limits, duplicates refused |

**Found and fixed on the way** — none of these were in the plan:

- No page could answer a decision or approval; *Redesign a page* stalled at
  its choice for ever.
- *Tests green?* in *Ship a PR* always passed — the check read an exit code
  the script step never recorded — and its test step printed a fake
  "167 passed". It now runs `npm test` and the check gates on the result.
- A command that exited non-zero was marked done.
- Ctrl+C recorded every live run as though you had pressed Stop.
- After Stop, Resume was refused until a restart, and the stopped run's
  steps could write a stale copy over a resumed one.
- A shell step's timeout waited for its child process anyway.
- File publishing could write outside the project with `../`.
- Runs, prompts and skills in a project Claude Code had never run in were
  invisible.
- The suite left its runs on the real Runs page and could have fired the
  person's real schedules.

**Changed from the plan**

- No new `step` kind: the v2 `agent` already was one. Presets are the kinds.
- Fan-out as a separate `map`/`collect` pair was not built; bounding the
  loop that exists covered the risk. A true per-item subgraph is still open.
- A node failure lets running siblings finish rather than aborting them, so
  work already paid for is kept.

**Not done**

- Publishing a pull request still drafts the text only.
- *Hunt a visual regression* still opens with a placeholder "dev server"
  step; the screenshot steps after it are real.
- Subgraphs for large canvases, bounded loops over subgraphs, and a shared
  library of published workflows.

---

## Where it stands

### The engine is better than it looks

`Scheduler` (`src/core/workflow-runner.mjs`) marches a DAG correctly: a node
goes `running` when all its parents are `done`, siblings run concurrently,
every transition is persisted to `run.json` with a temp-file-and-rename so a
reader never sees a half-written run, and `ask` nodes pause the whole run
until someone answers. `validateDefinition` rejects duplicate ids, dangling
edges and cycles via a three-colour DFS. `rerunRun(id, {fromNodeId})` keeps
every ancestor's output and re-runs only from that node down.

That is a real scheduler. The gap is not the engine.

### The authoring surface is the bottleneck

Handlers already read these fields off a node:

```
node.prompt     node.model     node.command
node.question   node.choices   node.route
```

The visual editor lets you set exactly three:

```
title     kind     cost
```

**So the data model already supports custom nodes and the editor does not
expose them.** You can draw any graph you like, but every node runs the
generic behaviour for its kind. There is no field for "here is what this node
should actually do". A JSON escape hatch exists, which is the only way to
write a prompt today.

This single gap is why Workflows reads as a demo rather than a tool.

### Five things that will bite at scale

Each verified in code:

1. **Runs do not survive a restart.** Schedulers live in a `Map` in the
   server process. On shutdown every run is stopped; on boot nothing
   reconciles. A run interrupted by a crash stays `running` in its
   `run.json` for ever, with nothing driving it.
2. **A paused run is lost on restart.** `ask` answers resolve a promise held
   in `pendingAnswers`, in memory. After a restart the file says
   `awaiting-answer` and no scheduler exists to receive the answer.
3. **No retries, no per-node timeouts, no concurrency cap, no budget cap.**
   Timeouts are hardcoded (60s for `terminal`, 180s for a Claude call). Every
   ready node fires at once, so a twelve-way fan-out is twelve concurrent
   model calls and twelve times the spend, with no ceiling.
4. **Reruns can drift.** `rerunRun` fetches the *current* definition, not the
   one that ran. Edit a workflow, rerun an old run, and preserved outputs are
   grafted onto a graph that may no longer have those nodes.
5. **Context passing is a blunt instrument.** A node receives *every* direct
   parent's output, flattened to markdown and pasted under
   "Context from earlier steps". There is no way to say "use the character
   from node A and the setting from node D, and ignore the rest".

Point 5 is the one that blocks the use you described.

---

## What the established engines teach

Four systems solve this and disagree in instructive ways.

**Airflow — a DAG of tasks, scheduled.** Its dynamic task mapping defers task
creation to runtime so the scheduler counts instances from upstream output.
The lesson is the cost: the Airflow team's own proposals describe scheduler
starvation on large fan-outs, cap mapped tasks at `max_map_length` (1024 by
default), and now propose *batching* items rather than one task per item.
**Take: fan-out needs a declared ceiling from day one, not after someone
melts their laptop.**

**LangGraph — a state graph with reducers and checkpoints.** State keys carry
reducer functions that merge values arriving from several nodes; checkpoints
are written at step boundaries, not mid-node; `interrupt()` saves state and
waits, so a resume can arrive days later. Crucially, an interrupted node
re-runs *from the start of its function*, so any side effect before the pause
must be idempotent. **Take: pause and resume belongs in the file, not in
memory — and merging several parents into one result is a named, first-class
concern, not something to leave to prompt concatenation.**

**Temporal — durable execution by deterministic replay.** History is an event
log; a crashed workflow is replayed elsewhere. It only works if the code is
deterministic, so model calls, randomness and clock reads must live in
Activities. **Take: full replay is the wrong model here — our steps are model
calls, nondeterministic by definition.** Inngest's cheaper variant is the
right one: persist each step's result, and on re-execution skip completed
steps and inject the stored value. `run.json` is already nine-tenths of that.

**n8n and Flowise — visual LLM builders.** Both learned that implicit
data flow is not enough: n8n has `$('NodeName')` to reach any upstream node
with a variable picker and a live preview of the resolved value; Flowise
references node outputs by id and generates those references from the visual
connection, and type-checks what a socket will accept. Reviewers of both note
two costs: a graph is hard to diff between versions, and a big canvas gets
cluttered fast. **Take: explicit references with a picker and a live preview;
keep JSON as the source of truth so diffs stay readable.**

---

## The plan

### Decision 1 — stay a DAG, add typed state

Keep the acyclic graph. The work you described — a character here, their
context there, skills, weapons, a setting, combined at the end — is pure
fan-in, which a DAG does natively. Loops are a much larger change (they break
`validateDefinition`'s cycle check, the readiness rule and the progress
display) and no example yet needs one. If iteration is wanted later, add a
bounded `loop` node that re-runs a subgraph up to N times, rather than making
the whole graph cyclic.

### Decision 2 — one authored node kind, not fifteen built-in ones

Today a node's behaviour comes from its `kind`, chosen from a fixed list that
only we can extend. Invert it. Add a first-class kind — call it `step` — that
carries its own instructions:

```json
{
  "id": "character",
  "title": "The character",
  "kind": "step",
  "prompt": "Invent a protagonist for {{inputs.setting}}. Give name, age, one defining wound.",
  "model": "sonnet",
  "output": {
    "shape": "json",
    "schema": { "name": "string", "age": "number", "wound": "string" }
  },
  "uses": ["character-design"],
  "retry": { "attempts": 2, "backoffMs": 2000 },
  "timeoutMs": 120000
}
```

The existing kinds stay as presets: `document`, `report`, `mockup` become
`step` with a prompt and output shape filled in. One code path, and the kind
picker becomes a starting-point menu rather than a hard boundary.

`uses` names skills by slug — which is what finally connects the Skills tab
to something. Right now it is a read-only catalogue.

### Decision 3 — explicit references, with a picker

Replace blanket parent-output pasting with named references, resolved before
the prompt is sent:

```
{{inputs.setting}}            a workflow input
{{nodes.character.output}}     a whole upstream output
{{nodes.character.output.name}} one field of it
{{nodes.*.output}}             every parent, the current behaviour, opt-in
```

Rules worth stealing wholesale from n8n: only upstream nodes are
referenceable, and the editor shows the **resolved value** beside the
reference as you type, from the last run if there is one. That live preview is
what makes a graph debuggable by a non-programmer.

Keep implicit parent-pasting available as `{{nodes.*.output}}` so existing
definitions keep working unchanged.

### Decision 4 — durability by memoisation, not replay

Three changes, in order of value:

1. **Reconcile on boot.** On startup, any run marked `running` whose
   scheduler is gone becomes `interrupted`, naming the node it died on. A
   zombie that says `running` for ever is worse than an honest failure.
2. **Let the person resume it, by hand.** A `Resume` button rehydrates a
   `Scheduler` from `run.json`: nodes already `done` keep their outputs and
   are skipped; the dead node and its descendants go back to `pending`. This
   is Inngest-style step memoisation, and `run.json` already stores
   everything needed. Nothing resumes on its own — the machine woke up, the
   person did not necessarily mean to carry on, and spending their money on
   that assumption is not ours to make.
3. **Move `ask` out of memory.** An unanswered question becomes a field on
   the node in the file. Answering it is a write to the file plus a resume,
   so a question can be answered after a restart, or tomorrow.

Then the LangGraph warning applies directly: a resumed node re-runs from the
top, so handlers must be safe to run twice. `terminal` nodes are the
dangerous ones — `git push` twice is not the same as once. Mark those
`idempotent: false`, and have Resume name them before it starts: *"this will
re-run `git push`. Skip it, or run it again?"* Manual resume makes that
question answerable, which auto-resume never could.

### Decision 5 — fan-out as a declared map, with a ceiling

`redesign-page` hardcodes `dir-a`, `dir-b`, `dir-c` — three copies of one
node because the format cannot say "do this three times". Replace with:

```json
{
  "id": "directions",
  "kind": "step",
  "map": { "over": "{{inputs.directions}}", "max": 8, "concurrency": 3 },
  "prompt": "Produce direction {{item.index}}: {{item.value}}"
}
```

`max` is Airflow's `max_map_length` lesson learned cheaply, and `concurrency`
is the batching lesson: a bounded number in flight rather than all of them.
A sibling `collect` node gathers the results into one array.

### Decision 6 — Runs becomes the control panel

Runs today is a reverse-chronological list. To be an orchestrator it needs:

| | |
| --- | --- |
| **Status at a glance** | counts by state, what is running now, what needs an answer |
| **Failure drill-down** | which node, the error, its inputs, the prompt sent, and a Retry from here button — `rerunRun(id, {fromNodeId})` already does the hard part |
| **Spend** | per-run and per-period cost; every node already records `meta.cost` |
| **Filters** | by workflow, status, session, repo, date |
| **A timeline** | each node as a bar, so a slow step is visible as a long bar |
| **Schedules** | a repeat per workflow, its next due time, its last result, and any windows it slept through |
| **Start again** | run this workflow once more, inputs pre-filled, editable first |
| **Resume** | pick up a run a restart interrupted, skipping what already finished |

### Decision 7 — pin the definition into the run

Add `version` to every definition, bump it on save, and copy the whole
definition into `run.json` at start. A run then carries the graph it actually
ran, reruns stop drifting, and Runs can say "this ran on v3; the workflow is
now v5". This is the cheap answer to the "visual graphs are hard to diff"
complaint: the JSON is the source of truth, so `git diff` still works.

### Decision 8 — the people who write the code are not the people who use it

You and the repo's collaborators write Orderly. **Everyone who installs it
builds their own workflows, on their own machine, and owns them.** Two
consequences, and together they set the bar for Phase 1:

**The editor is the product, not a convenience.** A contributor can hand-write
JSON; a user will not, and should never be told to. If a field cannot be set
in the form, then for practical purposes it does not exist. The JSON view
stays as an escape hatch and a diff surface, not as the real way in.

**A person's workflows are their property, so they must be portable.** Default
new workflows to the user scope (`~/.claude/workflows/`) so they follow the
person across projects instead of being trapped in whichever repo they
happened to be standing in. Add export and import of a single definition
file, so a workflow can be shared, forked and version-controlled by whoever
made it — including back to us, which is how a good one becomes a built-in.

The three scopes already exist and the ordering is right: project beats user
beats built-in. What is missing is that nothing in the UI says which scope a
workflow is being saved to, or why anyone would pick one over another.

### Decision 9 — schedules that only claim what a local machine can deliver

A person can set a workflow to repeat. It fires while Orderly is running on a
machine that is awake, and not otherwise. That is a real constraint, and the
design is to state it rather than paper over it.

**Three rules.**

**It runs only while Orderly runs.** No daemon, no login item, no background
agent. If the terminal is closed, the window has passed.

**A missed window is reported, never made up.** This is the deliberate
opposite of Airflow, whose backfilling of missed intervals is its most
famous surprise. Come back from a long weekend to a daily schedule and you
get one line — *"4 windows missed while Orderly was closed"* — and nothing
queued. Four runs you did not ask for, firing at once, spending four times
the money, is not a kindness.

**The honesty belongs at the moment of creation.** The sentence
*"runs only while Orderly is open on this machine"* sits in the schedule
form, not in a FAQ. Someone setting a nightly job needs to know that before
they rely on it, not after they wonder why Tuesday is missing.

**Where it lives.** Not on the definition — in
`~/.orderly-claude/schedules.json`, keyed by workflow id. A schedule is a
property of a person and their machine, not of the workflow. Export a
workflow to a colleague and they get the process, not your 7am. This falls
straight out of Decision 8.

**Mechanics.** One timer in the server process, ticking each minute against
each schedule's `nextDueAt`. A schedule whose previous run is still going is
skipped rather than stacked, so a slow workflow on a fast repeat cannot pile
up. Each fire records what it produced and when the next one is due.

**One thing this brings back.** A schedule can spend money while you are at
lunch, which is the one case where nobody is watching. So the run-wide budget
ceiling in Phase 3 stops being a nicety and becomes the condition for
shipping this: a scheduled run refuses to start if it would cross the
ceiling, and says so on the Runs page.

---

## Phasing

Each phase is independently shippable and leaves the thing in a working state.

**Phase 1 — make nodes authorable.** Expose `prompt`, `model`, `question`,
`choices`, `command` in the editor's node form. Add the `step` kind with a
`prompt` and an `output.shape`. Nothing else changes. *This is the smallest
change that turns the page from a demo into a tool, and it is mostly editor
work against an engine that is ready.*

**Phase 2 — explicit references.** `{{inputs.*}}` and `{{nodes.id.output}}`
resolution, upstream-only validation, a variable picker and the live resolved
preview. `{{nodes.*.output}}` preserves today's behaviour.

**Phase 3 — durability.** Boot reconcile, resume from `run.json`, `ask` moved
into the file, retries with backoff, per-node timeouts, a run-wide
concurrency cap and a budget ceiling. Definition versioning pinned into runs.

**Phase 4 — orchestration.** The Runs control panel: status at a glance,
failure drill-down with Retry from here, Start again, Resume, the timeline,
spend reporting. Then schedules, which land last because they depend on the
budget ceiling from Phase 3.

**Later, only if wanted:** `map`/`collect` fan-out, subgraphs for canvas
clutter, bounded loops, export/import of definitions, a shared library of
workflows people have chosen to publish.

## What not to build

- **Deterministic replay.** The steps are model calls. Memoisation gives
  most of the benefit for a fraction of the work.
- **A queue or a database.** One JSON file per run is legible, greppable,
  diffable and already works. It is a feature.
- **A node type per task.** Every hardcoded kind is a thing users cannot
  author. One authored kind with presets beats fifteen built-ins.
- **Backfill or catch-up.** Missed windows are reported, not replayed. See
  Decision 9.
- **A daemon, a login item, or any always-on background process.** The
  product is a thing you open.
- **File-watch or git-hook triggers.** Same promise problem as a daemon, and
  nobody asked.
- **Cloud anything.** Local-first is the product.

## Decided

**Schedules exist, and promise only what a local machine can keep.** A person
can set a workflow to repeat; it fires while Orderly is running and the
machine is awake. A window slept through is reported, never made up, and the
form says so before anyone relies on it. No daemon. See Decision 9.

**Users build and own their workflows; we build the thing they build them in.**
The form is the authoring path, not the JSON, and new workflows belong to the
person rather than to a checkout. See Decision 8.

**A workflow is any repeatable process.** It is not a content-generation
pattern. The worked example in Decision 2 happens to assemble a character
because that is a vivid thing to fan into one place; it carries no more weight
than that. A release checklist, a weekly report, an onboarding sweep, a data
pull with three analyses hanging off it are all the same shape. This is the
strongest argument against adding a kind per task: a generic authored `step`
fits every process, while a kind that knows what a character is fits exactly
one.
