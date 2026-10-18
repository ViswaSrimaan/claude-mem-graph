# claude-mem-local

**Free, open-source, local-first persistent memory for Claude Code and Claude Cowork.**

Claude forgets everything between sessions. claude-mem-local watches what happens
in a session (prompts, tool calls, results), compresses it into short searchable
*observations*, and brings the relevant ones back the next time you work on the
same project, so Claude starts with context instead of rediscovering it.

- **No account, no subscription, no telemetry, no cloud.** Everything is stored on your machine.
- **Zero dependencies.** Plain Node.js (built-in `node:sqlite` + FTS5). No Bun, Python, Chroma, Docker or `npm install`.
- **Works with Claude Code and Claude Cowork** (separate build that keeps memory inside your work folder).
- **Pick your observer:** your existing Claude Code login, a free local model (Ollama / LM Studio), an Anthropic API key, or fully offline rules.

> Inspired by [Claude-Mem](https://github.com/thedotmack/claude-mem) (Apache-2.0) and rebuilt from scratch for local-only use. See [NOTICE](NOTICE).

---

## Install

Requirements: Node.js 18.17+ (22.5+ recommended for SQLite; older versions fall back to a JSON store) and Claude Code.

### Claude Code

```bash
git clone <this repo> claude-mem-graph
cd claude-mem-local
npm run install-plugin            # = node scripts/install.mjs
```

Or inside Claude Code:

```
/plugin marketplace add /path/to/claude-mem-local
/plugin install mem-local@mem-local
```

Restart Claude Code. Memory starts recording in the next session.

> The plugin's install ID is `mem-local` because Claude Code reserves plugin names that start with `claude-`.

To try it without installing: `claude --plugin-dir ./plugin`.

### Claude desktop app (chats)

```bash
npm run install-desktop            # = node scripts/install-desktop.mjs  (--uninstall to remove)
```

Adds the memory tools to `claude_desktop_config.json` (a backup is written
first; other servers and settings are kept). Fully quit the app (tray icon →
Quit) and reopen it. Desktop chats then share the same memory as Claude Code:
Claude can `search`, look up an `entity`, `save_memory`, keep a to-do list
and so on. The desktop app has no hooks, so chats are not recorded
automatically; ask Claude to remember things, or let it save what matters.
Searches cover all projects; new memories go under `claude-desktop`.

### Claude Cowork

Cowork's home directory doesn't persist between sessions, so the Cowork build
(`mem-local-cowork`) stores memory in a `.claude-mem-local/` folder **inside the
folder you work in**, uses the knowledge-work vocabulary (deliverables, findings,
decisions, preferences, open tasks) and doesn't start a background viewer.

```bash
npm run package     # builds dist/mem-local-cowork.zip (and dist/mem-local.zip)
```

Then add it in the Claude desktop app, either by adding this repository as a
plugin marketplace and installing `mem-local-cowork`, or by uploading
`dist/mem-local-cowork.zip` as a custom plugin. If the folder is a git repo, add
`.claude-mem-local/` to its `.gitignore`.

In Cowork the Claude CLI may not be available to the observer; it then falls back to the offline observer automatically (see [Observers](#observers)).

---

## How it works

```
 SessionStart ──► inject recent memory for this project (index + a few full details)
 UserPromptSubmit ─► store the prompt; surface up to 3 related memories
 PreToolUse(Agent) ─► prepend relevant memory to subagent prompts
 PostToolUse ──► queue the tool call (redacted, truncated) ── async, never blocks
 Stop ──► background process: ONE observer call per turn
           └─► observations (type, title, narrative, facts, files) + turn summary
 SessionEnd ──► mark session ended, flush the queue
```

- **Knowledge graph.** The same observer call also lists the *entities* each
  note is about (people, organisations, documents, tools, tasks, decisions,
  preferences) and the *facts* linking them, e.g. `Priya —prefers format→ PDF`.
  Each fact carries a confidence tag (STATED / INFERRED / AMBIGUOUS), an
  optional "why", and the note it came from. When a one-at-a-time fact changes
  (prefers, owner, status …) the old one is closed with an end date, not
  deleted. Names are matched to what is already known: "Acme Corp" joins
  "Acme", "Q3 reports" joins "Q3 report", while "API v2"/"API v3" or
  "Sales Report"/"Legal Report" stay apart; unsure pairs go to a review list
  (`cmem graph review`). Files touched by tool calls become entities on their own.
- **Hybrid recall.** Search finds starting points by words (notes, entity names,
  fact text), walks up to two steps over *current* facts (stated facts and
  recent facts count more, busy hub entities spread less), and merges both
  rankings. Notes whose facts were all replaced later are marked outdated.
  Session start adds **Key facts** (current preferences, owners, decisions) and
  **Open work** (tasks still to do). Prompt recall and subagent memory use the
  same search, but only add graph results next to something the prompt names.
- **Insights.** Themes are found with community detection (Louvain, run in
  plain JavaScript; oversized themes are split, each is named after its
  best-connected member and keeps its id between sessions). `graph_overview`
  lists key entities, themes, unexpected links between themes and open
  questions (stale tasks, things mentioned often but never connected).
- **Lessons.** `memory_feedback` marks a recalled memory useful, a dead end or
  corrected. Signals fade with a 30-day half-life; a fresh dead end pushes a
  memory below the alternatives. Session start shows **Lessons** (corrections,
  dead ends, memories proven useful twice) and **Since last session** (new
  entities and facts, changed facts, new themes), compared with a snapshot
  taken when the previous session started.
- **Progressive disclosure.** Context shows a cheap index (`#id time icon title`).
  Claude fetches details only when needed through the MCP tools:
  `search` → `timeline` → `get_observations`.
- **One model call per turn**, not per tool call, and none for chat-only turns.
- **Fail-soft.** Hooks always exit 0; if the observer fails it retries once, then
  falls back to the offline observer, so nothing captured is lost.
- **No recursion.** The observer runs `claude -p --safe-mode --no-session-persistence`
  with a guard variable, so its own session is never recorded.

### MCP tools

| tool | purpose |
|---|---|
| `search(query, project?, type?, kind?, days?, limit?)` | hybrid: word matches plus what the knowledge graph connects to them (marked `← via …`), with connected facts; falls back to all projects if the current one has none |
| `timeline(anchor_id \| query)` | neighbouring observations, prompts and summaries |
| `get_observations(ids)` | full narrative, facts, files |
| `save_memory(text, title?, type?, entities?, relations?)` | explicitly remember a decision / preference / note, optionally with facts |
| `entity(name, history?)` | everything about one thing: current facts, what they replaced, aliases, notes |
| `related(name \| anchor_id, depth?)` | what is connected, step by step |
| `path(from, to, history?)` | how two things connect, fact by fact |
| `facts(subject? \| type? \| query?, history?)` | list facts from the knowledge graph |
| `graph_overview()` | key entities, themes, unexpected links between themes, open questions |
| `memory_feedback(ids, outcome, correction?)` | mark recalled memory useful / dead_end / corrected; changes ranking and feeds Lessons |
| `get_tool_uses(ids)` | the original tool calls behind notes (raw calls are kept `capture.keepRawDays`) |
| `work_state_write(items, list?)` / `work_state_read(list?, includeClosed?)` | to-do lists kept across sessions; open items appear under Open work at session start |
| `build_corpus(name, query? \| types? \| entity? \| days?)` | save a named slice of memory; same name with no filters refreshes it |
| `list_corpora()` / `query_corpus(name, question)` | ask a corpus a question – one call to your configured model, answering only from the corpus with note ids |
| `recent_context(project?)` | reprint the session-start digest |
| `list_projects()` | projects with memory |

### Skills and commands

- `mem-search` – how to search memory efficiently
- `memory-setup` – configure / diagnose (observer, storage, viewer, backup)
- `handoff` – write a structured "where we stopped" note
- `/mem-local:remember <text>` – save something
- `/mem-local:memory [status|viewer|process|search <q>]`

---

## Observers

| `observer.provider` | cost | what happens |
|---|---|---|
| `auto` (default) | your existing Claude plan | uses the Claude Code CLI (`haiku`) if `claude` is on PATH, otherwise `heuristic` |
| `claude-cli` | your existing Claude plan | one small Haiku call per turn that used tools |
| `openai` | **free** | any OpenAI-compatible server – Ollama, LM Studio, llama.cpp, vLLM |
| `anthropic` | pay per token | your own `ANTHROPIC_API_KEY` |
| `heuristic` | **free, offline** | rule-based: files edited/read, commands, failures, request and outcome |

Fully free and offline with Ollama:

```bash
ollama pull qwen2.5:7b
node plugin/scripts/cmem.mjs settings set observer.provider openai
node plugin/scripts/cmem.mjs settings set observer.openaiModel qwen2.5:7b
node plugin/scripts/cmem.mjs test-observer
```

Optional meaning-based search (a free local stand-in for claude-mem's Chroma):
notes are embedded by a local model and matched by meaning as a third ranking
next to words and the graph, so "automobile maintenance" can find "car service
schedule". Off by default; if the server is down, search just skips it.

```bash
ollama pull nomic-embed-text
node plugin/scripts/cmem.mjs settings set embeddings.enabled true
node plugin/scripts/cmem.mjs embeddings build      # embed existing notes; new ones are embedded as they are written
```

---

## Viewer

```bash
npm run viewer        # http://127.0.0.1:37811
```

Browse and search memory, filter by type and project, explore the **knowledge graph** (Graph tab: themes in colour, click an entity for its facts, history and notes; rename, merge or delete entities; confirm, close or delete facts; export as Graphify JSON, GraphML for Gephi or Cypher for Neo4j), answer the **Review** list (unsure merges, doubtful facts, near-duplicate notes), mark notes useful or dead end, open sessions as a
timeline (with raw tool events), edit or delete observations, add memories by
hand, preview exactly what gets injected, change settings, process the queue,
and export or import JSON. Live updates as new observations arrive. It binds
to 127.0.0.1 only, rejects foreign `Host` headers (DNS rebinding) and requires
a custom header for every write (blocks cross-site requests).

The viewer starts automatically with Claude Code sessions (`worker.autoStart`).

---

## CLI

```
node plugin/scripts/cmem.mjs <command>

  status | doctor               health, storage, observer, queue, viewer
  search <query> [--project p|*] [--kind observations|summaries|prompts]
  get <id> [id...]              full observation details
  context [--project p]         what gets injected at session start
  remember <text> [--type t] [--title t] [--project p]
  projects
  graph [status|overview|entities|entity <name>|walk <name>|path <a> <b>|review|export|backfill]
  todo [add <task>] [--list l] [--status todo|doing|done|dropped] [--all]
  embeddings [build]            optional meaning-based search
  import-claude-memory          import Claude Code's memory files for this folder now
  process [--session id|--all] [--force]
  worker start|stop|status|restart
  settings | settings set <dotted.key> <value> | settings path
  export [file] [--project p] | import <file>
  test-observer
```

---

## Privacy

- `<private>…</private>` in a prompt is never stored; a fully private prompt is skipped.
- Claude Code's own memory files for the project (`~/.claude/projects/<folder>/memory/*.md`)
  are read at session start and stored as notes (secrets redacted, files never
  modified). Turn off with `capture.claudeMemory false`.
- API keys (Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe), JWTs, bearer
  tokens, private keys, URL credentials and `password=` / `api_key:` style
  assignments are replaced with `[REDACTED:…]` before anything is written, and
  again on observer output.
- Captured fields are truncated (`capture.maxFieldChars`, default 4000).
- Raw tool events are deleted after `capture.keepRawDays` (default 7); only the compressed observations remain.
- `excludedProjects` turns capture off per project; `capture.skipTools` per tool.
- Memory injected into Claude is labelled as reference data, not instructions.

---

## Storage & settings

| | Claude Code build | Cowork build |
|---|---|---|
| data dir | `~/.claude-mem-local/` | `<work folder>/.claude-mem-local/` |
| database | `memory.db` (SQLite WAL + FTS5) | same |
| graph | `entities`, `relations` (facts with start/end dates), `mentions` tables in `memory.db` | same |
| backups | `backups/` – a copy is taken before each database upgrade (last 5 kept) | same |
| settings | `settings.json` in the data dir | same |
| log | `logs/claude-mem-local.log` | same |

Environment overrides: `CLAUDE_MEM_LOCAL_DATA_DIR`, `CLAUDE_MEM_LOCAL_STORAGE`
(`home`/`workspace`), `CLAUDE_MEM_LOCAL_PROVIDER`, `CLAUDE_MEM_LOCAL_MODEL`,
`CLAUDE_MEM_LOCAL_MODE`, `CLAUDE_MEM_LOCAL_PORT`, `CLAUDE_MEM_LOCAL_AUTOSTART`,
`CLAUDE_MEM_LOCAL_BACKEND` (`sqlite`/`json`).

Key settings (all defaults in `plugin/lib/config.mjs`):

| key | default | |
|---|---|---|
| `mode` | `code` (`general` in Cowork) | observation vocabulary; add your own JSON in `<data dir>/modes/` |
| `context.observations` / `fullDetails` / `summaries` | 40 / 5 / 3 | what is injected at session start |
| `context.maxChars` | 12000 | injection budget (~3k tokens) |
| `context.allProjects` | false | inject memory from every project |
| `context.promptRecall` | true | related memories on each prompt |
| `context.agentContext` | true | memory for subagents |
| `context.notices` | true | one visible line in the terminal when memory is loaded at session start or recalled for a prompt |
| `context.graph` / `graphChars` | true / 1500 | Key facts and Open work blocks at session start |
| `capture.claudeMemory` | true | import Claude Code's memory files |
| `embeddings.enabled` / `model` / `baseUrl` | false / nomic-embed-text / Ollama | meaning-based search |
| `corpus.maxChars` | 60000 | how much of a corpus is sent with a question |
| `observer.provider` | `auto` | see Observers |
| `worker.port` | 37811 | viewer port |

---

## Development

```bash
npm test            # 82 tests: both storage backends, graph layer, name matching, upgrade, privacy, observer (with a mock LLM), hooks, MCP, viewer API
npm run build       # regenerate cowork/ from plugin/
npm run package     # zips in dist/
npm run validate    # claude plugin validate on marketplace + both plugins
```

Layout:

```
plugin/                 the Claude Code plugin (source of truth)
  .claude-plugin/       plugin manifest
  hooks/hooks.json      lifecycle hooks -> scripts/cmem.mjs hook <event>
  .mcp.json             MCP server -> scripts/cmem.mjs mcp
  scripts/cmem.mjs      CLI entry point
  lib/                  config, privacy, store/ (sqlite + json), observer, providers,
                        context, hooks, mcp, worker (viewer API)
  modes/                code.json, general.json
  ui/viewer.html        single-file viewer
  skills/, commands/
cowork/                 generated by scripts/build-cowork.mjs (do not edit)
tests/                  node:test suites
```

## Troubleshooting

1. `node plugin/scripts/cmem.mjs doctor` – anything marked ✘ is the problem; recent log lines are shown.
2. Nothing recorded? Check `/plugin` shows `mem-local` enabled and restart Claude Code.
3. Observations look shallow? You are on the `heuristic` observer – check `doctor`, or set up `claude-cli` / Ollama.
4. Queue stuck? `cmem process --all --force`.
5. Port busy? `cmem settings set worker.port 37812`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
