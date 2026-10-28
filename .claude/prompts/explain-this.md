---
name: explain-this
title: Explain this code
description: Walk through what the selected code does and why it was written this way
category: content
inputs:
  - key: path
    label: File or symbol
    placeholder: src/core/workflow-runner.mjs or Scheduler.runNode
---
Explain what `{{path}}` does and why it was written this way.

Cover:
- What problem it solves and who the caller is.
- The non-obvious design choices and the trade-offs they make.
- Anything a new reader is likely to get wrong on a first pass.

Keep it under 300 words.
