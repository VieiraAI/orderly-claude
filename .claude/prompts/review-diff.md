---
name: review-diff
title: Review the current diff
description: Ask Claude to review the current git diff and surface the top findings
category: review
inputs:
  - key: focus
    label: Focus area
    placeholder: security, performance, naming
  - key: count
    label: Max findings
    placeholder: "3"
---
Review the current git diff. Focus on {{focus|anything that stands out}}.
Report the top {{count|three}} findings, each as:

- `file:line` — one-sentence problem, one-sentence fix.

If nothing is worth flagging, say so plainly.
