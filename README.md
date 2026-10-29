# Orderly Claude

Organize Claude's outputs for better interpretation and learning.

Claude Code does a lot of work in a single response. The terminal fills with
commands and output, and you only find out what happened when the summary
arrives at the end. Orderly Claude turns that stream into **progress bubbles** you
can read at a glance, click into when you care, and search later.

It reads what Claude Code already writes to disk. Nothing is intercepted, no
transcript leaves your machine, and it works on sessions that already happened.

## What you get

- **Bubbles, not scrollback.** One line per step — not one per command.
  Read-only look-around commands fold into a single bubble so the list stays
  the length of the work, not the length of the log.
- **Colour says what kind of work it was.** A filled near-black check is
  finished work; tan means it hit a problem and recovered; dusk blue means
  the step visibly changed the app; grey means it looked and changed
  nothing; red means it failed. A step still running is a hollow ring with
  one arc turning.
- **A decision stands out.** When Claude asks something, or is stopped for
  want of permission, the step turns amber, carries a question mark and a
  **needs you** pill, and breathes gently until it is dealt with — these
  are the steps that will not move on their own. Once answered it settles
  to a quiet stone colour marked **you decided**.
- **Slash commands work.** `/model`, `/btw` and the rest are passed to
  Claude Code exactly as typing them in the terminal would be; the
  composer marks the line as a command as you type it.
- **It tells you when Claude is thinking.** A tool call appears in the
  transcript the moment it starts and its result lands later, so a step
  genuinely in flight is shown spinning rather than guessed at. Below the
  conversation a live row names what Claude is on and how long it has been
  going. It sits inside the reply it belongs to, as the last item of that
  reply's checklist, so continuing work never looks like a second answer.
  If nothing new arrives for 45 seconds it says so plainly instead of
  animating as though all is well. Click the word to change
  voice: a plain-English term with how it is said now ("Excellent —
  peak"), plain words, or booth talk. Hovering gives the meaning.
- **Click any bubble.** *What happened* answers in plain language — what
  changed, how many lines, whether anything failed — with no commands in
  sight. *Changes* has the diffs, *Before / after* the pictures, and
  *Reasoning* the commands, their output and Claude's own thinking. Close
  it by clicking away, with Escape, or on the ✕.
- **Before and after, captured automatically.** Orderly Claude finds the dev
  server belonging to *this* project — by the directory each listening
  process was started in, not by taking whatever port answers first — and
  screenshots it around every change, pairing the images. A step whose
  pictures differ is badged **before & after**; one whose pictures match
  says so instead. The target is shown in the header and can be set by
  hand if the guess is wrong. Compare
  side by side, or drag the swipe handle — which clips the top image in place
  rather than resizing it, so the picture is revealed and never slides about.
  You never have to ask for a screenshot.
- **Search everything, including your own prompts.** `⌘F` across steps,
  commands, screenshots and every prompt you have ever typed — with a copy
  button, so good prompts become a library instead of something you scroll for.
- **Every session, every agent.** Run one instance per Claude Code session,
  each on its own port, and switch between them. Any past session on disk
  replays as a bubble timeline.
- **Slash commands, with the mode shown.** Typing `/` offers the commands
  with what each expects; Tab or Enter completes one. A chip then names the
  mode you are in until you clear it, so `/model` and a question are never
  confused — and commands that need the real terminal say so rather than
  appearing to work.
- **Every terminal in one window, as tabs.** Claude Code keeps a file per
  running process naming its session, so the terminals open on this machine
  are known exactly. `+` opens one as a tab; each tab keeps its own live
  reader, so a background tab shows a green dot while it works and a count
  of what you have not looked at. Switching is instant, and the timeline,
  screenshots and composer all follow the tab in front.
- **Attach files.** Drop a document on the composer or use Attach. The file
  is written beside the session and its path handed to Claude, which reads it
  with its own tools — the bytes never go into the prompt, so a PDF does not
  cost you the context window.
- **Prompt without a terminal.** Send Claude a prompt from the page; it
  resumes the session you are watching and the bubbles fill in as it works.
  Enter sends, Shift+Enter starts a new line, and the box grows with it. Each
  tab runs on its own, so a prompt in one never waits behind another.

## Workflows

A workflow is a job you run the same way every time — the steps you would
otherwise type out one prompt at a time. You build it, it is yours, and it
runs on your machine.

- **Build one without writing a file.** Open **Workflows → + New workflow**
  and add steps from plain-language kinds: *Ask Claude*, *Run a command*,
  *Ask me to choose*, *Ask me to approve*, *Check*, *Repeat for each*,
  *Save or publish*. Connect them in the order they should run. Every
  setting the engine reads has a field in the panel; the file view is there
  to diff, not to author in. Or start from a built-in with **Make it yours**.
- **Steps name what they use.** `{{inputs.audience}}` is something typed when
  the run starts; `{{nodes.research.output}}` is what an earlier step made,
  and `{{nodes.tests.output.code}}` one field of it. **+ insert** offers only
  what is upstream, and a live preview shows what will actually be sent,
  using the last run. Naming a step that runs later is caught before you
  can save. A value put into a shell command is quoted, so a model's output
  can never become a command.
- **Failures fail.** A command that exits non-zero fails its step, as in any
  build system — tick *keep going* to let a later Check look at it instead.
  Steps can retry with a growing wait, give up after a set time, and a run
  never has more than a few steps going at once.
- **Money has a ceiling.** Set a spend limit on a workflow, or one for every
  run you start; a run stops before the step that would cross it and says
  how much it spent. Raise the limit and it carries on without redoing what
  it already paid for.
- **The Runs page is the control panel.** What is running, what is waiting
  on you — answer it right there — what failed and at which step, what it
  cost. Click a run for each step's drill-down: what it was set to do, what
  it was actually given, what it produced, why it failed, a timeline.
- **Nothing is lost when Orderly closes.** A run cut short is marked so, not
  left pretending to run, and **Resume** carries on from the step it was on.
  A question you had not answered is still there, and can be answered after
  a restart. A step marked *not safe to run twice* — a deploy, a push — is
  never repeated without asking whether it already happened.
- **Reruns repeat what ran.** Every run keeps the version of the workflow it
  used, so editing a workflow never changes a run you already have.
- **Schedules, honestly.** Set a workflow to repeat daily, weekly, or every
  few hours. It runs **only while Orderly is open on this machine**: a time
  slept through is counted as missed and never made up later, so you never
  come back to a pile of runs you did not ask for. Every schedule carries a
  spend limit, and scheduled runs share a daily one.
- **Share them.** Export a workflow as one file; import one someone sent you.
  Schedules stay yours — exporting shares the process, not your 7am.

Still drafts, not actions: the *publish as pull request* step writes the
title and description but does not open the PR on GitHub. See
[docs/workflows-plan.md](docs/workflows-plan.md) for the design and what is next.

## Install

Node 20 or newer. There are no npm dependencies to install.

```bash
git clone https://github.com/mavedartin/orderly-claude.git
cd orderly-claude
node bin/orderly-claude.mjs --doctor    # check this machine is ready
```

`--doctor` reports what it found and what is missing:

```
  orderly-claude 0.1.0  ·  node v22.18.0  ·  darwin

  yes  Claude Code directory   ~/.claude
  yes  transcripts             99 sessions found
  yes  claude on PATH          needed to send prompts from the page
  yes  Chrome                  /Applications/Google Chrome.app/…
  yes  lsof                    used to find this project's dev server
```

Only Node and a Claude Code transcript are required. Without Chrome the
before/after screenshots are skipped and everything else works; without
`claude` on PATH you can read sessions but not send prompts from the page.

To get `orderly` on your PATH:

```bash
npm link            # or: npm install -g .
```

Without that, run it as `node /path/to/orderly-claude/bin/orderly-claude.mjs`.

## Use

```bash
cd ~/your-project     # a directory where you run Claude Code
orderly               # opens http://localhost:7777
```

It picks the newest session for that directory and follows it live. Start a
second one in another project and it takes the next free port, so several
agents can be watched at once.

```
orderly --list            # recent sessions
orderly --session <id>    # watch or replay a specific one
orderly --port 8100       # pin a port
orderly --no-capture      # skip automatic screenshots
orderly --no-open         # don't open a browser
```

A step has its own URL — `#<session>/<step>/<tab>` — so you can link someone
straight to the diff you want them to look at.

## Where the data comes from

| What you see | Where it comes from |
| --- | --- |
| Bubble labels | The `description` Claude writes for every shell command |
| Step grouping | Consecutive calls, split on prose and on read vs. write |
| File diffs | Tool inputs (`Edit`, `Write`, shell heredocs), plus Claude Code's own file-history snapshots |
| Before/after images | Headless Chrome, driven over the DevTools Protocol |
| Prompts | The transcript Claude Code already keeps |

Screenshots are driven over CDP rather than Chrome's `--screenshot` flag,
because that flag waits for a load event that never fires on a page holding a
live connection — which is every Vite or HMR dev server.

## The terminal pane

`plugin/` is a Claude Code mod that draws the same bubbles in a pane beside the
chat, for when you don't want a browser at all. It also registers a `plan` tool
that lets Claude declare its steps up front, so they appear greyed out and fill
in as the work completes — and unplanned steps show up amber when something
needed fixing along the way.

```bash
claude --plugin-dir ./plugin
```

## The Gen Z library

`web/genz.mjs` holds 106 terms across eight groups — praise, criticism,
agreement, effort, emotion, social, intensity and action. Each entry is a
plain phrase, how it is commonly said now, and a line on what it actually
means, so a wait teaches you something rather than only flashing a word.

```js
import { TERMS, createRotation, find, byCategory } from './genz.mjs';

createRotation().next();   // { plain: 'Excellent', genz: 'peak', note: '…' }
find('goated');            // matches plain phrase, slang or meaning
byCategory('social');      // 22 terms
```

The rotation is a shuffle that works through every term before any comes
round again, so the same word does not repeat during a single wait.

## Requirements

| | |
| --- | --- |
| Node 20+ | required |
| Claude Code, with at least one session | required — the transcripts are the data |
| `claude` on PATH | to send prompts from the page |
| Chrome, Chromium or Edge | for before/after screenshots |
| `lsof` (macOS, Linux) | to match a dev server to the project |

macOS and Linux are supported. On Windows the viewer runs, but dev-server
detection and the before/after captures that depend on it do not.

## Tests

```bash
npm test
```

Boots a real server against a real session on disk, exercises every API
route, then loads the page in headless Chrome and checks it rendered with no
console errors, in both themes. The workflow checks (`test/workflow-engine.mjs`,
also runnable on its own) boot throwaway servers in a temp project, crash and
restart them to test recovery, and drive the editor, Runs page and run page
in Chrome. The suite never touches your real schedules or spend limits, and
removes any run it starts.

## Layout

```
bin/orderly-claude.mjs  CLI: port allocation, instance registry
src/core/               transcript parsing, step grouping, diffs, capture
src/server/             HTTP API and server-sent events
web/                    the UI
plugin/                 the Claude Code mod (terminal pane)
test/smoke.mjs          end-to-end smoke test
test/workflow-engine.mjs  workflows: engine, durability, schedules, pages
docs/                   design notes
```

## Contributing

Pull requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers running it,
the test suite, and how the pieces fit together. There is no build step and
nothing to install, so it is a short road from clone to first change.

If you use Claude Code daily and something here annoys you, say so in an
issue — that is a contribution.

## License

MIT. See [LICENSE](LICENSE).
