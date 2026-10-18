---
name: memory-setup
description: Configure, diagnose or troubleshoot claude-mem-local memory - choose the observer (Claude CLI, Ollama, offline), change storage location, open the viewer, export/import memory, or fix "memory isn't working". Use when the user says "set up memory", "configure claude-mem-local", "use Ollama for memory", or memory looks empty or broken.
---

# claude-mem-local setup

Everything runs locally. There is no account, subscription, API key
requirement or telemetry.

The CLI is `scripts/cmem.mjs` in the plugin root (two levels up from this
skill's base directory). Below, `CMEM` means:

```
node "<plugin root>/scripts/cmem.mjs"
```

## 1. Diagnose

Run `CMEM doctor`. It reports the Node version, storage backend and file,
memory counts, queue state, which observer is active, whether the viewer is
running, and recent log lines. Fix anything marked ✘.

## 2. Choose how memories are written (observer)

| provider | cost | notes |
|---|---|---|
| `auto` (default) | uses your existing Claude plan | Claude Code CLI with `haiku` if `claude` is on PATH, else `heuristic` |
| `claude-cli` | uses your existing Claude plan | one small call per turn that used tools |
| `openai` | free | any OpenAI-compatible server: Ollama, LM Studio, llama.cpp |
| `anthropic` | pay per token | needs `ANTHROPIC_API_KEY` |
| `heuristic` | free, offline | rule-based: files touched, commands run, request/outcome |

Examples:

```
CMEM settings set observer.provider openai
CMEM settings set observer.openaiBaseUrl http://localhost:11434/v1
CMEM settings set observer.openaiModel qwen2.5:7b
CMEM test-observer
```

`test-observer` runs the configured observer on a sample turn and prints
what it would store.

## 3. Storage

- Claude Code: `~/.claude-mem-local/` (one SQLite DB for all projects).
- Cowork build: `<your folder>/.claude-mem-local/` so memory survives between
  Cowork sessions. Add `.claude-mem-local/` to `.gitignore` if the folder is a repo.
- Override anywhere with the `CLAUDE_MEM_LOCAL_DATA_DIR` environment variable.

Settings live in `settings.json` in the data directory (`CMEM settings path`).

## 4. Viewer

`CMEM worker start` then open http://127.0.0.1:37811 to browse, search, edit,
delete, export and import memory, and to change settings in a form.

## 5. Move or back up memory

```
CMEM export memory-backup.json            # everything
CMEM export proj.json --project my-app    # one project
CMEM import memory-backup.json            # duplicates are skipped
```

## 6. Privacy

- Text inside `<private>…</private>` is never stored.
- API keys, tokens, passwords and private keys are redacted before storage.
- `CMEM settings set excludedProjects '["secret-project"]'` disables capture for a project.
