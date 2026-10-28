---
name: workflow-new
description: Scaffold a new Orderly Claude workflow in <repo>/.claude/workflows/<id>.json
---

Scaffold a new Orderly Claude workflow with the id `$ARGUMENTS`.

Steps:
1. Pick the id. The user typed `/workflow-new <id>`. If no id was given, ask for one — a short, hyphenated string like `ship-pr` or `hunt-regression`.
2. Run the scaffold command from the repo root:

   ```sh
   node bin/orderly-claude.mjs new-workflow <id>
   ```

   This writes `<repo>/.claude/workflows/<id>.json` with three starter nodes (`brief` → `review` → `ship`) wired as a line.

3. Open the new file and ask the user:
   - What does this workflow do? Replace the `desc` and `title` fields.
   - Which node kinds does it need? Options: `document`, `report`, `mockup`, `diff`, `shots`, `shots-set`, `terminal`, `ask`, `pr`. Replace the three starter nodes with the right set.
   - Any `inputs` the user should fill before a run?

4. Validate the result:

   ```sh
   curl -s -X POST http://localhost:7777/api/workflows/validate \
     -H 'content-type: application/json' \
     -d "$(cat <repo>/.claude/workflows/<id>.json | jq '{def: .}')"
   ```

   (Port 7777 is the default; use whatever the orderly server is on.)

5. The new workflow shows up in the Workflows tab immediately — no restart needed.

Keep the diff tight: this is a scaffold, not a long doc. Only edit the fields the user asked about.
