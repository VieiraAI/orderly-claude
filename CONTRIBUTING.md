# Contributing

Orderly Claude is small on purpose: no build step, no npm dependencies, and a
test suite that drives the real thing rather than mocks of it. That makes it
unusually easy to pick up for an evening.

## Running it

```bash
git clone https://github.com/mavedartin/orderly-claude.git
cd orderly-claude
node bin/orderly-claude.mjs --doctor   # what this machine has, and what each piece is for
node bin/orderly-claude.mjs            # opens http://localhost:7777
```

You need Node 20+ and at least one Claude Code session on the machine — the
transcripts Claude Code already writes are the data. Chrome is optional; without
it the before/after screenshots are skipped and everything else works.

There is nothing to install and nothing to compile. Edit a file under `web/` and
the page reloads itself.

## Tests

```bash
npm test
```

This boots a real server against a real session, exercises every route, then
drives headless Chrome over the rendered page and reads the result back. It
takes a few minutes and should finish `0 failed`. Run it before opening a pull
request.

The suite is deliberately specific. Many checks exist because something broke
once and should not break again quietly — that the swipe never moves the image,
that only one live indicator can be on screen, that *What happened* contains no
raw commands while *Reasoning* does. If you fix a bug, a check that would have
caught it is worth more than the fix.

## How it fits together

| | |
| --- | --- |
| `bin/orderly-claude.mjs` | the command: picks a session, allocates a port, starts the server |
| `src/core/` | reading transcripts, grouping steps, diffs, screenshots, search |
| `src/server/` | HTTP API and server-sent events |
| `web/` | the page — plain modules, no framework, no bundler |
| `plugin/` | a Claude Code mod drawing the same bubbles in a terminal pane |
| `test/smoke.mjs` | the whole suite |
| `test/workflow-engine.mjs` | workflows, called by the suite; runs alone too |
| `test/scratch-world.mjs` | the throwaway home, repo and sessions both suites run in; `KEEP_SMOKE=1` keeps it |
| `docs/workflows-plan.md` | why workflows work the way they do |

Two things are worth knowing before changing the core:

**A tool call and its result are written to the transcript together**, once the
tool has finished — so work in progress is invisible that way. Whether Claude is
working is read from `api-request` records instead (`src/core/watcher.mjs`).

**Running terminals are read from `~/.claude/sessions/<pid>.json`**, which Claude
Code maintains per process. Earlier versions guessed from process lists and
file timestamps and got it wrong; please don't reintroduce that.

## Pull requests

- One change per pull request, with a message that says what was wrong and why
  this fixes it. The history is meant to be readable a year from now.
- Run `npm test` and say what it reported.
- No dependencies without a good reason. "It would be convenient" is not one;
  the zero-dependency install is a feature people rely on.
- Match the surrounding code. It is plain modern JavaScript with comments that
  explain *why*, not *what*.

## Good places to start

Issues labelled `good first issue` are scoped to be finishable in a sitting.
Beyond those, the things most worth having are listed in the issue tracker —
Windows support, per-tab capture, and a shareable export are the big ones.

If you use Claude Code daily and something about this tool annoys you, that
annoyance is a contribution. Open an issue and describe it plainly.
