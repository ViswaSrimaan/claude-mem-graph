---
description: claude-mem-local status, viewer and maintenance (status | viewer | process | search <q>)
argument-hint: [status|viewer|process|search <query>]
allowed-tools: Bash(node:*)
---

Run the claude-mem-local CLI for the user's request and report the result briefly.

The CLI is: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cmem.mjs"`

- no argument or `status` → run `doctor`
- `viewer` → run `worker start` and give the user the URL it prints
- `process` → run `process --all --force --verbose` (compresses queued tool events now)
- `search <query>` → run `search <query>`

Request: $ARGUMENTS
