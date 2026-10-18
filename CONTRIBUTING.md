# Contributing to claude-mem-graph

Thanks for helping out. Bug reports, fixes and new features are all welcome.
Please read the ground rules below before opening a pull request.

## Ground rules

These keep the project what it is. Pull requests that break them won't be merged.

- **Local only.** No accounts, logins, telemetry, usage metering, billing or
  hosted services. Memory never leaves the user's machine unless they point the
  observer at a provider themselves.
- **Zero dependencies.** Plain Node.js (18.17+, built-in `node:sqlite` on 22.5+).
  No `npm install`, no native modules, no bundler. If you need something, write
  the small piece you need.
- **Fail-soft hooks.** Hooks must always exit 0 and must never block Claude Code.
  Errors go to the log, not to the user's session.
- **Privacy first.** Anything captured goes through `plugin/lib/privacy.mjs`
  (`clean` / `redactSecrets`) before it is stored or sent to an observer.
- **Clean-room code.** This project is inspired by
  [Claude-Mem](https://github.com/thedotmack/claude-mem) but written from
  scratch. Don't copy code from other projects unless the licence is compatible
  with Apache-2.0, and say where it came from in [NOTICE](NOTICE).
  Claude-Mem's `cowork/` directory is under a non-commercial licence: don't copy from it.

## Getting started

```bash
git clone https://github.com/ViswaSrimaan/claude-mem-graph.git
cd claude-mem-graph
npm test                       # no install step needed
claude --plugin-dir ./plugin   # try your changes in Claude Code without installing
```

Useful while developing:

```bash
node plugin/scripts/cmem.mjs doctor          # health check and recent log lines
node plugin/scripts/cmem.mjs context         # what gets injected at session start
node plugin/scripts/cmem.mjs test-observer   # check the configured observer
npm run viewer                               # http://127.0.0.1:37811
```

To keep your experiments out of your real memory, point the data dir somewhere
else: `CLAUDE_MEM_LOCAL_DATA_DIR=/tmp/cmem-dev`.

## Where things live

- `plugin/` is the source of truth. **Edit only here.**
- `cowork/` is generated from `plugin/` by `npm run build`. Don't edit it by
  hand; run the build and commit the result together with your change.
- `tests/` holds the `node:test` suites. See the layout section of the
  [README](README.md#development) for the rest.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on
   the approach.
2. Create a branch from `main`.
3. Make your change in `plugin/`, then run:

   ```bash
   npm run build      # regenerate cowork/
   npm test           # all tests must pass
   npm run validate   # needs the claude CLI; checks the marketplace and both plugins
   ```

4. Update the [README](README.md) if you changed behaviour, settings, CLI
   commands or MCP tools.

### Tests

- Add a test for every fix and feature. Tests use the built-in `node:test` and
  `node:assert/strict`; there is no test framework to install.
- Use `tmpDir()` and `baseSettings()` from `tests/helpers.mjs`, and `runCli()`
  for anything that goes through the CLI. Tests must never touch the real
  `~/.claude-mem-local` or `~/.claude` (the helpers point `CLAUDE_CONFIG_DIR`
  at a temp dir for this).
- Storage changes must work with both backends, SQLite and JSON. The store
  tests run against each.
- Observer tests use a mock LLM server. Don't make real model calls from tests.

### Database changes

The SQLite schema is versioned (`SCHEMA_VERSION` in
`plugin/lib/store/sqlite.mjs`). To change it, bump the version and add a
migration step. Never edit an existing migration, since users already have
databases at that version. A backup is taken automatically before each upgrade.
Add a test that upgrades from the previous version.

### Code style

- ES modules (`.mjs`), Node built-ins imported as `node:*`.
- Match the code around you: same naming, same comment density, small focused
  functions.
- Keep user-visible text short and plain.

## Commits and pull requests

- Write commit messages in the imperative ("Add path tool", not "Added…"),
  with a short first line and a body that explains why.
- Keep pull requests focused on one thing. Describe what changed, why, and how
  you tested it.
- Make sure `npm test` passes and `cowork/` is rebuilt before asking for review.

## Reporting bugs

Open an issue with:

- what you did, what you expected and what happened;
- your OS, Node version (`node -v`) and Claude Code version (`claude --version`);
- the output of `node plugin/scripts/cmem.mjs doctor`.

Check the doctor output and logs for secrets or private project details before
posting them. Capture is redacted, but check anyway.

For security problems, don't open a public issue. Use GitHub's private
vulnerability reporting on the repository instead.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE), the same as the rest of the project.
