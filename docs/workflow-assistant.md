# The workflow assistant

Claude, inside the workflow editor, helping a person build, change, fix and
understand the workflow in front of them.

## What a person sees

- **Ask Claude**, a button in the bottom-right corner of the canvas (⌘J). A panel docks on the
  right and the editor moves over to make room, so nothing Claude proposes can
  land out of sight.
- The conversation reads exactly like the Sessions page: avatars, names and
  times; Claude's steps as a checklist of coloured bubbles; its reply as a
  short summary. It is drawn from the same summariser, not imitated.
- Suggestions that fit the moment. An empty canvas offers starting points; a
  workflow offers *explain it*, *make it cheaper*, *add an approval*, *add
  retries* — and *why did the last run fail?* only when it did.
- **A change is never made directly.** It comes back as a proposal: listed in
  plain words (*Added "Approve opening the PR"*, *Changed "Self-review": model,
  instructions*), checked by Orderly's validator (*Ready to run*), and
  previewable on the canvas, where new steps are outlined green, changed ones
  amber and removed ones faded. **Apply** puts it on the canvas unsaved, with
  **Undo**; **Save** remains the one way a workflow changes, so every change is
  still a normal, versioned save.

## How it works

Each conversation is an ordinary Claude Code session, run with the person's
own Claude login (`claude -p`), in a working folder of its own under
`~/.orderly-claude/assistant/`. That folder holds:

| File | What it is |
| --- | --- |
| `current.json` | the workflow as the editor holds it, unsaved edits included |
| `draft.json` | Claude's proposal; the only file it may write |
| `context.json` | this workflow's recent runs (the failed step and its error, cost), installed skills, the project |
| `check.mjs` | runs Orderly's own validator on the draft; Claude must run it before finishing |
| `BRIEF.md` | the brief: the workflow shape, house rules, two real built-ins as examples |

When a turn ends, Orderly reads `draft.json`, validates it and diffs it
against `current.json`. A difference is a proposal; no difference means the
turn was a question.

The brief deliberately does not restate every validation rule. Claude runs the
real validator, so the validator stays the single source of truth and the
brief cannot drift out of date in a way that matters.

## What it may and may not do

Enforced by Claude Code's permission system, not by asking nicely:

| | |
| --- | --- |
| Read | its folder, and the project the workflow belongs to (only a project Orderly already knows) |
| Write | `draft.json`, nothing else |
| Run | `node check.mjs`, nothing else |
| Everything else | refused without a prompt (`--permission-prompts none`) |

Verified against the real CLI: asked to create another file, read a file
outside its folders, or run a shell command, each was refused and nothing
leaked. A project file containing instructions can therefore at worst produce
a proposal — which the person reads, previews and chooses whether to apply.

## Scale and cost

- **No keys to manage.** It uses the Claude login people already have.
- **Cost is visible.** Every turn's cost is recorded; the panel shows what the
  conversation has cost. Measured on real requests: a change took 17 s and
  $0.08, a question 6 s and $0.09 (Sonnet).
- **Bounded.** One message at a time per workflow; at most three conversations
  running at once per machine (a clear message, not a queue, beyond that); a
  turn is stopped after six minutes; thirty tool steps at most.
- **Persistent.** A conversation belongs to its workflow and survives
  restarts. A workflow saved for the first time keeps its conversation. *New
  conversation* starts again; old transcripts stay on disk.
- **Out of the way.** Assistant sessions are hidden from the Sessions list and
  from project discovery, which scan the same transcript folders.
- **Free to test.** The suite runs against a stand-in for the CLI
  (`test/fixtures/fake-claude.mjs`) that writes real-format transcripts, so CI
  never spends.

## Tests

`test/assistant.mjs`, part of `npm test`: proposals and their diffs, the
conversation through the Sessions summariser, friendly step names, the
lockdown flags, refusing unknown folders, follow-ups, apply, never undoing the
person's own edits, invalid proposals, signed-out Claude, one-at-a-time,
stop, the three-at-once cap, a new workflow keeping its conversation, reset,
staying out of Sessions — and the panel in Chrome: open, greet, send with
Enter, live progress, proposal, preview, apply, undo, Esc, no errors or
dialogs.

## Next

- **Model choice per conversation** (Haiku for quick questions, Opus for big
  redesigns), with the cost difference shown.
- **Proposal history**: every proposal kept, so an older one can be applied.
- **Run from the panel**: after Apply and Save, *Run it now* with the inputs
  filled from the last run.
- **Team mode**: when Orderly is shared, a per-person daily assistant budget,
  the way scheduled runs have one.
