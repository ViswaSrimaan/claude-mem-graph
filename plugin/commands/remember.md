---
description: Save something to claude-mem-local memory
argument-hint: <what to remember>
---

Save the following to persistent memory using the claude-mem-local `save_memory` tool. Choose a short, specific title and the best-fitting type (decision, preference, gotcha, note, …). Rewrite it so it makes sense on its own months from now, but keep the user's meaning exactly. If it names people, organisations, documents, tools or preferences, also pass them as `entities` and the facts linking them as `relations` (for example `{"src":"Priya","type":"prefers format","dst":"PDF","why":"..."}`); a new preference replaces the old one automatically. Do not include secrets. Reply with the saved memory ID.

$ARGUMENTS
