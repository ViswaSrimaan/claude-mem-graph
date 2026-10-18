---
name: handoff
description: Write a handoff note into claude-mem-local memory so the next session (or a teammate's) can pick up exactly where this one stopped. Use when the user says "hand off", "wrap up", "save where we are", "I'll continue tomorrow", or before ending long work.
---

# Handoff note

1. Check what is already recorded so you don't duplicate it:
   `search(query="<main topic>", days=2)`.
2. Write ONE note with `save_memory`, `type="note"`, title starting with
   `Handoff:`. Use this structure, keeping it under ~250 words:

   - **Goal** - what we are trying to achieve, in one sentence.
   - **Done** - what is finished and verified (with file paths / commands).
   - **In progress** - what is half-done and its exact state.
   - **Next** - the next 1-3 concrete steps.
   - **Gotchas** - traps discovered, decisions that must not be undone.

3. Tell the user the memory ID that was saved.

Don't paste code blocks longer than a few lines, transcripts, or secrets.
