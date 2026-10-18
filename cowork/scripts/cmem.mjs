#!/usr/bin/env node
// claude-mem-local command line. Used by the plugin hooks, the MCP server and
// by you directly:  node plugin/scripts/cmem.mjs help
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// node:sqlite prints an ExperimentalWarning on some Node versions; it would
// end up in hook stderr on every tool call.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (/sqlite/i.test(msg || '')) return;
  return emitWarning.call(process, warning, ...rest);
};

const { loadSettings, setSetting, settingsFile, readJson, logFile, VERSION, PLUGIN_ROOT, DEFAULTS } = await import('../lib/config.mjs');
const { projectName } = await import('../lib/project.mjs');

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function positional(from = 1) {
  const out = [];
  for (let i = from; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

async function store(settings) {
  const { openStore } = await import('../lib/store/index.mjs');
  return openStore(settings.dataDir);
}

const HELP = `claude-mem-local ${VERSION} - free, local, persistent memory for Claude Code and Cowork

Usage: node cmem.mjs <command> [options]

  status                    Show storage, observer and queue status
  doctor                    Diagnose the installation
  search <query>            Search memory   [--project p|*] [--kind observations|summaries|prompts] [--limit n]
  context                   Print the context that is injected at session start [--project p]
  remember <text>           Save a memory explicitly  [--title t] [--type t] [--project p]
  projects                  List projects with memory
  graph [status]            Graph size for this project       [--project p|*]
  graph entities            Entities, most mentioned first    [--kind k] [--limit n]
  graph entity <name>       One entity: facts and notes       [--history]
  graph walk <name>         What is connected, step by step   [--depth n] [--history]
  graph path <a> <b>        How two entities connect          [--history]
  graph overview            Key entities, themes, unexpected links, open questions
  graph export [file]       Graph as --format json (Graphify) | graphml (Gephi) | cypher (Neo4j)  [--history]
  graph review              Unsure merges, doubtful facts, near-duplicate notes
  graph review accept|reject <id>
  graph backfill            Add entities for notes the graph hasn't seen
  todo [add <task>]         To-do lists kept across sessions  [--list l] [--status todo|doing|done|dropped] [--note n] [--all]
  embeddings [build]        Optional meaning-based search (local Ollama); 'build' embeds existing notes
  import-claude-memory      Import Claude Code's memory files for this folder now (also done at session start)
  process                Compress pending tool events now  [--session id | --all]
  worker start|stop|status  Manage the local viewer (http://127.0.0.1:${DEFAULTS.worker.port})
  settings                  Show settings; 'settings set observer.provider heuristic'
  export [file]             Export memory to JSON  [--project p]
  import <file>             Import a JSON export (duplicates are skipped)
  test-observer             Run the configured observer once on a sample turn
  hook <event>              (used by the plugin) ${'session-start|user-prompt|post-tool|pre-tool|stop|session-end'}
  mcp                       (used by the plugin) run the MCP server on stdio
`;

async function main() {
  switch (cmd) {
    case 'hook': {
      const { runHook } = await import('../lib/hooks.mjs');
      await runHook(argv[1]);
      return;
    }
    case 'mcp': {
      const { runMcpServer } = await import('../lib/mcp.mjs');
      await runMcpServer();
      return;
    }
    case 'process': {
      const settings = loadSettings();
      const { processSession } = await import('../lib/observer.mjs');
      const s = await store(settings);
      try {
        const sid = flag('session');
        const sessions = sid && sid !== true ? [sid] : s.pendingSessions().map((x) => x.session_id);
        for (const id of sessions) {
          const r = await processSession(s, settings, id, { force: Boolean(flag('force')) });
          if (process.stdout.isTTY || flag('verbose')) console.log(`${id}: ${r.processed} events → ${r.created || 0} observations${r.retry ? ` (will retry: ${r.error})` : ''}`);
        }
      } finally {
        s.close();
      }
      return;
    }
    case 'worker': {
      const settings = loadSettings();
      const { isWorkerUp, stopWorker, workerUrl } = await import('../lib/worker-client.mjs');
      const sub = argv[1] || 'status';
      if (sub === 'run') {
        const { startWorker } = await import('../lib/worker.mjs');
        try {
          await startWorker({ port: flag('port') ? Number(flag('port')) : undefined });
        } catch (err) {
          if (err.code === 'EADDRINUSE') {
            console.error(`Port ${settings.worker.port} is in use. Set another with: settings set worker.port 37812`);
            process.exit(1);
          }
          throw err;
        }
        return;
      }
      if (sub === 'start' || sub === 'restart') {
        if (sub === 'restart') await stopWorker(settings);
        else if (await isWorkerUp(settings)) { console.log(`Already running: ${workerUrl(settings)}`); return; }
        const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'cmem.mjs'), 'worker', 'run'], {
          detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAUDE_MEM_LOCAL_DATA_DIR: settings.dataDir },
        });
        child.unref();
        for (let i = 0; i < 50; i++) {
          if (await isWorkerUp(settings, 300)) { console.log(`Viewer running: ${workerUrl(settings)}`); return; }
          await new Promise((r) => setTimeout(r, 100));
        }
        console.error(`Worker did not start. See ${logFile(settings.dataDir)}`);
        process.exit(1);
      }
      if (sub === 'stop') {
        console.log((await stopWorker(settings)) ? 'Stopped.' : 'Not running.');
        return;
      }
      const up = await isWorkerUp(settings);
      console.log(up ? `Running: ${workerUrl(settings)} (pid ${up.pid}, ${up.backend})` : 'Not running. Start with: worker start');
      return;
    }
    case 'search': {
      const settings = loadSettings();
      const { callTool } = await import('../lib/mcp.mjs');
      const s = await store(settings);
      try {
        const project = flag('project');
        console.log(await callTool(s, settings, 'search', {
          query: positional().join(' '), project: project === true ? undefined : project, kind: flag('kind'), limit: flag('limit'),
        }));
      } finally {
        s.close();
      }
      return;
    }
    case 'get': {
      const settings = loadSettings();
      const { callTool } = await import('../lib/mcp.mjs');
      const s = await store(settings);
      try {
        console.log(await callTool(s, settings, 'get_observations', { ids: positional() }));
      } finally {
        s.close();
      }
      return;
    }
    case 'context': {
      const settings = loadSettings();
      const { buildSessionContext } = await import('../lib/context.mjs');
      const s = await store(settings);
      try {
        const p = flag('project');
        console.log(buildSessionContext(s, settings, { project: p && p !== true ? p : projectName(process.cwd()) }) || '(no memory yet)');
      } finally {
        s.close();
      }
      return;
    }
    case 'remember': {
      const settings = loadSettings();
      const { saveMemory } = await import('../lib/memory-actions.mjs');
      const s = await store(settings);
      try {
        const p = flag('project');
        const r = saveMemory(s, settings, {
          text: positional().join(' '), title: flag('title'), type: flag('type'),
          project: p && p !== true ? p : projectName(process.cwd()),
        });
        if (r.error) { console.error(r.error); process.exit(1); }
        console.log(`Saved memory #${r.id}: ${r.title}`);
      } finally {
        s.close();
      }
      return;
    }
    case 'projects': {
      const settings = loadSettings();
      const { callTool } = await import('../lib/mcp.mjs');
      const s = await store(settings);
      try { console.log(await callTool(s, settings, 'list_projects', {})); } finally { s.close(); }
      return;
    }
    case 'graph': {
      await graphCommand();
      return;
    }
    case 'todo': {
      const settings = loadSettings();
      const s = await store(settings);
      try {
        const { writeWorkState, readWorkState, formatWorkState } = await import('../lib/work-state.mjs');
        const p = flag('project');
        const project = p && p !== true ? p : projectName(process.cwd());
        const list = flag('list') === true ? undefined : flag('list');
        if (argv[1] === 'add' || argv[1] === 'set') {
          const status = flag('status') === true ? undefined : flag('status');
          writeWorkState(s, settings, { project, list, items: [{ task: positional(2).join(' '), status: status || 'todo', note: flag('note') === true ? undefined : flag('note') }] });
        }
        console.log(formatWorkState(readWorkState(s, { project, list, includeClosed: Boolean(flag('all')) }), { project, includeClosed: Boolean(flag('all')) }));
      } finally {
        s.close();
      }
      return;
    }
    case 'embeddings': {
      const settings = loadSettings();
      const s = await store(settings);
      try {
        const { embedMissing, embeddingStats } = await import('../lib/embeddings.mjs');
        if (argv[1] === 'build') {
          if (!settings.embeddings.enabled) { console.error('Turn it on first: settings set embeddings.enabled true'); process.exit(1); }
          let total = 0;
          for (let n = 1; n; total += n) n = await embedMissing(s, settings, { limit: 200 });
          console.log(`Embedded ${total} notes with ${settings.embeddings.model}.`);
        }
        const st = embeddingStats(s, settings);
        console.log(st ? `Embeddings ${st.enabled ? 'on' : 'off'} · ${st.model} · ${st.vectors} of ${st.notes} notes have vectors` : 'Embeddings need the SQLite store.');
      } finally {
        s.close();
      }
      return;
    }
    case 'import-claude-memory': {
      const settings = loadSettings();
      const s = await store(settings);
      try {
        const { ingestClaudeMemory } = await import('../lib/claude-memory.mjs');
        const r = ingestClaudeMemory(s, { ...settings, capture: { ...settings.capture, claudeMemory: true } }, { cwd: process.cwd(), project: projectName(process.cwd()) });
        console.log(r.dirs.length ? `${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged from ${r.dirs.join(', ')}` : 'No Claude Code memory folder for this directory.');
      } finally {
        s.close();
      }
      return;
    }
    case 'status':
    case 'doctor': {
      await doctor(cmd === 'doctor');
      return;
    }
    case 'settings': {
      const settings = loadSettings();
      if (argv[1] === 'set' && argv[2]) {
        setSetting(settings.dataDir, argv[2], argv.slice(3).join(' '));
        console.log(`Set ${argv[2]} in ${settingsFile(settings.dataDir)}`);
        return;
      }
      if (argv[1] === 'path') { console.log(settingsFile(settings.dataDir)); return; }
      console.log(JSON.stringify(settings, null, 2));
      return;
    }
    case 'export': {
      const settings = loadSettings();
      const s = await store(settings);
      try {
        const p = flag('project');
        const data = s.exportAll({ project: p && p !== true ? p : undefined });
        const file = positional()[0];
        const text = JSON.stringify(data, null, 1);
        if (file) {
          fs.writeFileSync(file, text);
          console.log(`Exported ${data.observations.length} observations, ${data.summaries.length} summaries, ${data.prompts.length} prompts to ${file}`);
        } else {
          process.stdout.write(text + '\n');
        }
      } finally {
        s.close();
      }
      return;
    }
    case 'import': {
      const settings = loadSettings();
      const file = positional()[0];
      if (!file) { console.error('Usage: import <file.json>'); process.exit(1); }
      const data = readJson(file);
      if (data?.format !== 'claude-mem-local') { console.error('Not a claude-mem-local export file.'); process.exit(1); }
      const s = await store(settings);
      try { console.log(JSON.stringify(s.importAll(data))); } finally { s.close(); }
      return;
    }
    case 'test-observer': {
      await testObserver();
      return;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    default:
      process.stdout.write(HELP);
  }
}

async function doctor(full) {
  const settings = loadSettings();
  const { resolveProvider, findClaudeCli } = await import('../lib/providers.mjs');
  const { isWorkerUp, workerUrl } = await import('../lib/worker-client.mjs');
  const lines = [];
  const ok = (good, label, detail = '') => lines.push(`${good ? '✔' : '✘'} ${label}${detail ? `: ${detail}` : ''}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  ok(major > 22 || (major === 22 && minor >= 5), 'Node.js', `${process.versions.node}${major < 22 ? ' (SQLite needs 22.5+; using JSON store)' : ''}`);
  let s;
  try {
    s = await store(settings);
    const st = s.stats();
    ok(true, 'Storage', `${st.backend} at ${st.file}`);
    ok(true, 'Memory', `${st.observations} observations, ${st.summaries} summaries, ${st.prompts} prompts, ${st.sessions} sessions`);
    ok(st.failed_events === 0, 'Queue', `${st.pending_events} pending, ${st.failed_events} failed`);
    ok(Boolean(st.graph), 'Graph', st.graph
      ? `${st.graph.entities} entities, ${st.graph.facts} current facts, ${st.graph.closed_facts} past facts (schema v${st.schema_version})`
      : 'off (needs the SQLite store)');
    if (st.graph) {
      const { embeddingStats } = await import('../lib/embeddings.mjs');
      const e = embeddingStats(s, settings);
      ok(true, 'Embeddings', e.enabled ? `on · ${e.model} at ${settings.embeddings.baseUrl} · ${e.vectors} of ${e.notes} notes` : 'off (optional; see README)');
    }
    const { memoryDirs } = await import('../lib/claude-memory.mjs');
    const dirs = memoryDirs(process.cwd());
    ok(true, 'Claude Code memory', settings.capture.claudeMemory === false ? 'import off' : dirs.length ? `imported from ${dirs.join(', ')}` : 'no memory folder for this directory');
  } catch (err) {
    ok(false, 'Storage', err.message);
  } finally {
    s?.close();
  }
  const provider = resolveProvider(settings);
  ok(true, 'Observer', `${provider}${settings.observer.provider === 'auto' ? ' (auto)' : ''}`);
  if (provider === 'claude-cli' || full) ok(Boolean(findClaudeCli(settings)), 'Claude CLI', findClaudeCli(settings) || 'not found on PATH');
  if (provider === 'anthropic') ok(Boolean(process.env.ANTHROPIC_API_KEY || settings.observer.anthropicApiKey), 'ANTHROPIC_API_KEY');
  const up = await isWorkerUp(settings);
  ok(true, 'Viewer', up ? `${workerUrl(settings)} (pid ${up.pid})` : 'not running (worker start)');
  lines.push(`  settings: ${settingsFile(settings.dataDir)}`);
  lines.push(`  log:      ${logFile(settings.dataDir)}`);
  lines.push(`  mode:     ${settings.mode}, storage: ${settings.storage}, project here: ${projectName(process.cwd())}`);
  if (full) {
    try {
      const tail = fs.readFileSync(logFile(settings.dataDir), 'utf8').trim().split('\n').slice(-8);
      lines.push('', 'Recent log:', ...tail.map((l) => `  ${l.slice(0, 300)}`));
    } catch {
      lines.push('', 'Recent log: (empty)');
    }
  }
  console.log(lines.join('\n'));
}

async function graphCommand() {
  const settings = loadSettings();
  const s = await store(settings);
  try {
    const g = s.graph;
    if (!g) { console.error('The graph needs the SQLite store (Node 22.5+).'); process.exit(1); }
    const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'status';
    const args = positional(2);
    const p = flag('project');
    const project = p === '*' ? '*' : p && p !== true ? p : projectName(process.cwd());
    const history = Boolean(flag('history'));
    const date = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
    const fact = (f) => `${f.src_name} —${f.type}→ ${f.dst_name}  ${f.confidence}  ${date(f.valid_from)}${f.current ? '' : ` → ${date(f.valid_to)}`}`
      + `${f.fact ? `  "${f.fact}"` : ''}${f.why ? `  why: ${f.why}` : ''}`;
    const find = (name) => {
      const e = project === '*' ? g.searchEntities(name, { limit: 1 })[0] : g.findEntity({ project, name }) || g.searchEntities(name, { project, limit: 1 })[0];
      if (!e) { console.error(`No entity "${name}" in ${project}.`); process.exit(1); }
      return g.getEntity(e.id);
    };
    const label = (e) => `${e.name} (${e.kind}${e.status ? `, ${e.status}` : ''})`;

    if (sub === 'status') {
      const st = g.stats(project);
      console.log(`Graph for ${project === '*' ? 'all projects' : project}: ${st.entities} entities, ${st.facts} current facts, ${st.closed_facts} past facts, ${st.mentions} note links`);
      for (const e of g.listEntities({ project, limit: 10 })) console.log(`  ${label(e)}  ·  ${e.mention_count} notes`);
      return;
    }
    if (sub === 'entities') {
      const rows = g.listEntities({ project, kind: flag('kind') === true ? undefined : flag('kind'), limit: Number(flag('limit')) || 50 });
      if (!rows.length) console.log('(no entities)');
      for (const e of rows) console.log(`#${e.id}  ${label(e)}  ·  ${e.mention_count} notes  ·  last ${date(e.last_seen)}`);
      return;
    }
    if (sub === 'entity') {
      const e = find(args.join(' '));
      console.log(`${label(e)}  #${e.id}${e.aliases.length ? `  also: ${e.aliases.join(', ')}` : ''}`);
      if (e.summary) console.log(`  ${e.summary}`);
      const facts = g.factsFor(e.id, { history });
      console.log(facts.length ? 'Facts:' : 'Facts: none');
      for (const f of facts) console.log(`  ${f.current ? ' ' : '✗'} ${fact(f)}`);
      const notes = g.notesMentioning([e.id], { limit: 10 });
      if (notes.length) {
        const obs = new Map(s.getObservations(notes.filter((n) => n.note_kind === 'observation').map((n) => n.note_id)).map((o) => [o.id, o]));
        console.log('Notes:');
        for (const n of notes) console.log(`  #${n.note_id} ${obs.get(n.note_id)?.title || `(${n.note_kind})`}`);
      }
      return;
    }
    if (sub === 'walk') {
      const e = find(args.join(' '));
      const { nodes, relations } = g.walk([e.id], { depth: Number(flag('depth')) || 2, history });
      const byHop = new Map();
      for (const n of nodes.values()) {
        if (!byHop.has(n.hop)) byHop.set(n.hop, []);
        byHop.get(n.hop).push(n);
      }
      for (const [hop, list] of [...byHop].sort((a, b) => a[0] - b[0])) {
        console.log(hop === 0 ? `Start: ${label(e)}` : `${hop} step${hop > 1 ? 's' : ''}:`);
        if (hop === 0) continue;
        for (const n of list) {
          const r = relations.get(n.via);
          const via = r ? g.getFact(r.id) : null;
          console.log(`  ${label(g.getEntity(n.id))}${via ? `   via ${via.src_name} —${via.type}→ ${via.dst_name}` : ''}`);
        }
      }
      return;
    }
    if (sub === 'path') {
      if (args.length < 2) { console.error('Usage: graph path "<a>" "<b>"'); process.exit(1); }
      const a = find(args[0]);
      const b = find(args.slice(1).join(' '));
      const found = g.path(a.id, b.id, { history });
      if (!found) { console.log(`No connection between ${a.name} and ${b.name} within 4 steps.`); return; }
      console.log(`${found.steps.length} step${found.steps.length === 1 ? '' : 's'}:`);
      for (const step of found.steps) console.log(`  ${fact(step)}`);
      return;
    }
    if (sub === 'export') {
      const { exportGraph, EXPORT_FORMATS } = await import('../lib/graph/export.mjs');
      const { analyzeGraph } = await import('../lib/graph/analyze.mjs');
      const fmt = flag('format');
      const format = EXPORT_FORMATS[fmt] ? fmt : 'json';
      const p = project === '*' ? projectName(process.cwd()) : project;
      const snap = g.latestSnapshot(p);
      const text = exportGraph(g, p, format, { history, themes: analyzeGraph(g, p, { previousThemes: snap?.data?.themes || [] }).themes });
      const file = args[0];
      if (file) {
        fs.writeFileSync(file, text);
        console.log(`Wrote the ${p} graph as ${format} to ${file}`);
      } else {
        process.stdout.write(text);
      }
      return;
    }
    if (sub === 'overview') {
      const { callTool } = await import('../lib/mcp.mjs');
      console.log(await callTool(s, settings, 'graph_overview', { project }));
      return;
    }
    if (sub === 'review') {
      const [action, id] = args;
      if (action === 'accept' || action === 'reject') {
        const r = g.resolveReview(id, action === 'accept');
        if (!r) { console.error(`No open review item #${id}.`); process.exit(1); }
        console.log(r.status === 'stale' ? `#${id} no longer applies (something it refers to was removed).` : `#${id} ${r.status}.`);
        return;
      }
      const items = g.listReview({ project });
      if (!items.length) { console.log('Nothing to review.'); return; }
      for (const r of items) console.log(`#${r.id}  ${r.question}${r.score ? `  (${Math.round(r.score * 100)}% similar, ${r.reason})` : ''}`);
      console.log('\nAnswer with: graph review accept <id>  |  graph review reject <id>');
      return;
    }
    if (sub === 'backfill') {
      console.log(`Indexed ${g.backfill()} notes.`);
      return;
    }
    console.error(`Unknown graph command: ${sub}`);
    process.exit(1);
  } finally {
    s.close();
  }
}

async function testObserver() {
  const settings = loadSettings();
  const { resolveProvider, runProvider } = await import('../lib/providers.mjs');
  const { buildObserverPrompt, parseObserverOutput, heuristicObserve } = await import('../lib/observer.mjs');
  const { loadMode } = await import('../lib/modes.mjs');
  const mode = loadMode(settings.mode, settings.dataDir);
  const provider = resolveProvider(settings);
  const sample = {
    mode, project: 'demo', cwd: process.cwd(),
    requests: [{ prompt_number: 1, text: 'The login form crashes when the email has a plus sign. Fix it.' }],
    events: [
      { tool_name: 'Read', tool_input: '{"file_path":"src/validate.js"}', tool_output: 'const EMAIL = /^[a-z0-9.]+@[a-z]+\\.[a-z]+$/;' },
      { tool_name: 'Edit', tool_input: '{"file_path":"src/validate.js","old_string":"[a-z0-9.]+","new_string":"[a-z0-9.+_-]+"}', tool_output: 'ok' },
      { tool_name: 'Bash', tool_input: '{"command":"npm test"}', tool_output: '12 passing' },
    ],
    lastAssistant: 'Fixed: the email regex rejected "+". Widened the local-part character class; tests pass.',
  };
  console.log(`Observer: ${provider}`);
  const started = Date.now();
  if (provider === 'heuristic') {
    console.log(JSON.stringify(heuristicObserve(sample), null, 2));
    return;
  }
  try {
    const text = await runProvider(provider, buildObserverPrompt({ ...sample, maxChars: settings.observer.maxInputChars }), settings);
    console.log(JSON.stringify(parseObserverOutput(text, mode), null, 2));
    console.log(`OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`Observer failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  if (cmd === 'hook') {
    // Hooks must never fail the host session.
    process.stderr.write(`claude-mem-local: ${err.message}\n`);
    process.exit(0);
  }
  console.error(err.stack || err.message);
  process.exit(1);
});
