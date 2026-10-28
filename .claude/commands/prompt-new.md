---
name: prompt-new
description: Scaffold a new Orderly Claude prompt in <repo>/.claude/prompts/<slug>.md
---

Scaffold a new Orderly Claude prompt with the slug `$ARGUMENTS`.

Steps:
1. The user typed `/prompt-new <slug>`. If no slug was given, ask for one — a short hyphenated string like `review-diff` or `summarize-session`.
2. Scaffold the file:

   ```sh
   node bin/orderly-claude.mjs new-prompt <slug>
   ```

   Writes `<repo>/.claude/prompts/<slug>.md` with a frontmatter block (name, title, description, category, inputs) and a short body.

3. Open the file and ask:
   - What is this prompt for? Replace `description` and the body.
   - Which inputs does it need? Each is `{key, label, placeholder}`. The body uses `{{key|default}}` interpolation.
   - Category: `build`, `design`, `review`, `ship`, `plan`, `content`, `io`.

4. Validate from the orderly server (default port 7777):

   ```sh
   curl -s -X POST http://localhost:7777/api/prompts/validate \
     -H 'content-type: application/json' \
     -d "$(jq -Rs '{md: .}' < <repo>/.claude/prompts/<slug>.md)"
   ```

5. The prompt shows up in the Prompts tab immediately. Clicking Send on the brief sheet drops the interpolated body into the active Claude Code session.
