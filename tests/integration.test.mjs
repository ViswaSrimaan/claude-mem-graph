// Drives the real CLI the way Claude Code does: JSON on stdin, JSON on stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../plugin/lib/store/index.mjs';
import { CLI, ROOT, runCli, tmpDir, waitFor } from './helpers.mjs';

const cwd = ROOT;

function envFor(dir, extra = {}) {
  return { CLAUDE_MEM_LOCAL_DATA_DIR: dir, CLAUDE_MEM_LOCAL_PROVIDER: 'heuristic', ...extra };
}

test('full session through hook processes', async () => {
  const dir = tmpDir();
  const env = envFor(dir);
  const sid = 'sess-1';

  const start = await runCli(['hook', 'session-start'], { env, input: { session_id: sid, cwd, source: 'startup', hook_event_name: 'SessionStart' } });
  assert.equal(start.code, 0);
  const startOut = JSON.parse(start.stdout);
  assert.equal(startOut.hookSpecificOutput, undefined, 'no context on an empty memory');
  assert.match(startOut.systemMessage, /no notes yet/, 'the person still sees that memory is on');

  const prompt = await runCli(['hook', 'user-prompt'], { env, input: { session_id: sid, cwd, prompt: 'Add retry logic to the HTTP client <private>my bank pin 1234</private>' } });
  assert.equal(prompt.code, 0);

  await Promise.all([
    runCli(['hook', 'post-tool'], { env, input: { session_id: sid, cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src', 'http.js') }, tool_response: 'export function get() {}' } }),
    runCli(['hook', 'post-tool'], { env, input: { session_id: sid, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src', 'http.js') }, tool_response: { success: true } } }),
    runCli(['hook', 'post-tool'], { env, input: { session_id: sid, cwd, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1: GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' } }),
    runCli(['hook', 'post-tool'], { env, input: { session_id: sid, cwd, tool_name: 'TodoWrite', tool_input: { todos: [] } } }),
    runCli(['hook', 'post-tool'], { env, input: { session_id: sid, cwd, tool_name: 'mcp__plugin_mem-local_memory__search', tool_input: { query: 'x' } } }),
  ]);

  const stop = await runCli(['hook', 'stop'], { env, input: { session_id: sid, cwd, last_assistant_message: 'Added exponential backoff retries to get().' } });
  assert.equal(stop.code, 0);

  const store = await openStore(dir);
  try {
    await waitFor(() => store.countPendingEvents(sid) === 0 && store.recentObservations({}).length > 0, { timeout: 15000 });
    const events = store.recentEvents({ session_id: sid });
    assert.equal(events.length, 3, 'TodoWrite and own MCP tools are skipped');
    assert.ok(events.every((e) => !e.tool_output.includes('ghp_')), 'secrets redacted before storage');
    assert.ok(events.some((e) => e.failed === 1));
    const p = store.recentPrompts({ session_id: sid })[0];
    assert.ok(!p.text.includes('1234'), 'private content not stored');
    const o = store.recentObservations({})[0];
    assert.equal(o.project, 'claude-mem-local');
    assert.deepEqual(o.files_modified, ['src/http.js']);
  } finally {
    store.close();
  }

  // Next session gets that memory injected.
  const next = await runCli(['hook', 'session-start'], { env, input: { session_id: 'sess-2', cwd, source: 'startup' } });
  const out = JSON.parse(next.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Added exponential backoff retries/);
  assert.match(out.systemMessage, /mem-local: \d+ notes? for .* loaded/);

  // Prompt-time recall surfaces related memory from the earlier session.
  const recall = await runCli(['hook', 'user-prompt'], { env, input: { session_id: 'sess-2', cwd, prompt: 'the http.js retry logic is flaky, look again' } });
  const recallOut = JSON.parse(recall.stdout);
  assert.match(recallOut.hookSpecificOutput.additionalContext, /http\.js/);
  assert.match(recallOut.systemMessage, /recalled #\d+/);

  // Subagents get memory prepended to their prompt.
  const pre = await runCli(['hook', 'pre-tool'], { env, input: { session_id: 'sess-2', cwd, tool_name: 'Agent', tool_input: { description: 'Review retry', prompt: 'Review the retry logic in http.js' } } });
  const preOut = JSON.parse(pre.stdout).hookSpecificOutput;
  assert.match(preOut.updatedInput.prompt, /^<prior-project-memory/);
  assert.match(preOut.updatedInput.prompt, /Review the retry logic in http\.js$/);
  assert.equal(preOut.updatedInput.description, 'Review retry');

  const end = await runCli(['hook', 'session-end'], { env, input: { session_id: 'sess-2', cwd } });
  assert.equal(end.code, 0);
});

test('hooks are no-ops inside the observer process and never fail', async () => {
  const dir = tmpDir();
  const r = await runCli(['hook', 'user-prompt'], { env: envFor(dir, { CLAUDE_MEM_LOCAL_INTERNAL: '1' }), input: { session_id: 'x', cwd, prompt: 'hello there friend' } });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'memory.db')));
  const bad = await runCli(['hook', 'post-tool'], { env: envFor(dir), input: 'this is not json' });
  assert.equal(bad.code, 0);
  const unknown = await runCli(['hook', 'nope'], { env: envFor(dir), input: {} });
  assert.equal(unknown.code, 0);
});

test('workspace storage keeps memory inside the project folder (Cowork)', async () => {
  const project = tmpDir('cmem-ws-');
  fs.mkdirSync(path.join(project, '.git'));
  const env = { CLAUDE_MEM_LOCAL_STORAGE: 'workspace', CLAUDE_MEM_LOCAL_PROVIDER: 'heuristic', CLAUDE_MEM_LOCAL_DATA_DIR: '' };
  await runCli(['hook', 'user-prompt'], { env, cwd: project, input: { session_id: 'w', cwd: path.join(project), prompt: 'draft the quarterly report' } });
  assert.ok(fs.existsSync(path.join(project, '.claude-mem-local', 'memory.db')));
});

function mcpClient(env) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, ...env }, cwd, windowsHide: true });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return {
    call(method, params) {
      const myId = ++id;
      return new Promise((resolve) => {
        waiting.set(myId, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

test('MCP server: handshake, tools and progressive disclosure', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  const a = store.addObservation({ session_id: 's', project: 'claude-mem-local', type: 'decision', title: 'Use FTS5 for search', narrative: 'Porter stemming, bm25 ranking.', facts: ['bm25 weights favor titles'] });
  store.addObservation({ session_id: 's', project: 'elsewhere', type: 'bugfix', title: 'Fixed flaky websocket reconnect' });
  store.close();
  const c = mcpClient({ CLAUDE_MEM_LOCAL_DATA_DIR: dir });
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'claude-mem-local');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  c.notify('notifications/initialized');
  const list = await c.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['search', 'timeline', 'get_observations', 'save_memory', 'entity', 'related', 'path', 'facts', 'graph_overview', 'memory_feedback', 'get_tool_uses', 'work_state_write', 'work_state_read', 'build_corpus', 'list_corpora', 'query_corpus', 'recent_context', 'list_projects']);

  const text = async (name, args) => (await c.call('tools/call', { name, arguments: args })).result.content[0].text;
  assert.match(await text('search', { query: 'fts5' }), new RegExp(`#${a} .*Use FTS5 for search`));
  assert.match(await text('search', { query: 'websocket' }), /No matches in "claude-mem-local"; showing matches from all projects/);
  assert.match(await text('get_observations', { ids: [a] }), /bm25 weights favor titles/);
  assert.match(await text('timeline', { anchor_id: a }), /→ #/);
  const saved = await text('save_memory', { text: 'Always run npm test before committing.', type: 'preference' });
  assert.match(saved, /Saved memory #\d+/);
  assert.match(await text('search', { query: 'committing', type: 'preference' }), /Always run npm test/);
  assert.match(await text('list_projects', {}), /claude-mem-local: 2 observations/);
  assert.match(await text('recent_context', {}), /# Memory: claude-mem-local/);
  const bad = await c.call('tools/call', { name: 'nope', arguments: {} });
  assert.ok(bad.error);
  const unknown = await c.call('does/not/exist', {});
  assert.equal(unknown.error.code, -32601);
  await c.close();
});

test('viewer worker: API, SSE-ready, and request guards', async () => {
  const dir = tmpDir();
  const port = 39000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [CLI, 'worker', 'run', '--port', String(port)], { env: { ...process.env, CLAUDE_MEM_LOCAL_DATA_DIR: dir, CLAUDE_MEM_LOCAL_PROVIDER: 'heuristic' }, windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    });
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.app, 'claude-mem-local');
    const html = await (await fetch(base)).text();
    assert.match(html, /<title>claude-mem-local<\/title>/);

    const blocked = await fetch(`${base}/api/observations`, { method: 'POST', body: '{"text":"x"}' });
    assert.equal(blocked.status, 403, 'writes need the x-cmem-local header');
    // fetch() won't send a custom Host header, so use http.request directly.
    const rebinding = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(rebinding, 403, 'foreign Host header rejected (DNS rebinding guard)');

    const h = { 'x-cmem-local': '1', 'content-type': 'application/json' };
    const created = await (await fetch(`${base}/api/observations`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Staging DB is reset nightly at 02:00 UTC.', project: 'ops' }) })).json();
    assert.ok(created.id);
    const found = await (await fetch(`${base}/api/observations?q=staging&project=ops`)).json();
    assert.equal(found[0].id, created.id);
    const patched = await (await fetch(`${base}/api/observations/${created.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ title: 'Staging reset schedule' }) })).json();
    assert.equal(patched.title, 'Staging reset schedule');
    assert.equal((await (await fetch(`${base}/api/projects`)).json())[0].project, 'ops');
    assert.match((await (await fetch(`${base}/api/context?project=ops`)).json()).text, /Staging reset schedule/);
    const exp = await fetch(`${base}/api/export`);
    assert.match(exp.headers.get('content-disposition'), /attachment/);
    const dump = await exp.json();
    assert.equal(dump.observations.length, 1);
    const settings = await (await fetch(`${base}/api/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ context: { observations: 12 } }) })).json();
    assert.equal(settings.effective.context.observations, 12);
    assert.equal(settings.overrides.context.observations, 12);
    assert.equal((await (await fetch(`${base}/api/observations/${created.id}`, { method: 'DELETE', headers: h })).json()).deleted, 1);
    assert.equal((await fetch(`${base}/api/observations/${created.id}`)).status, 404);
  } finally {
    await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-cmem-local': '1' } }).catch(() => {});
    await new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill(); r(); }, 3000); });
  }
});

test('CLI: remember, search, export/import round trip', async () => {
  const dir = tmpDir();
  const env = envFor(dir);
  const r = await runCli(['remember', 'Prefer pnpm over npm in this repo', '--type', 'preference', '--project', 'demo'], { env });
  assert.match(r.stdout, /Saved memory #1/);
  assert.match((await runCli(['search', 'pnpm', '--project', 'demo'], { env })).stdout, /Prefer pnpm/);
  const file = path.join(dir, 'export.json');
  await runCli(['export', file], { env });
  const dir2 = tmpDir();
  const imp = await runCli(['import', file], { env: envFor(dir2) });
  assert.match(imp.stdout, /"observations":1/);
  const doc = await runCli(['doctor'], { env: envFor(dir2) });
  assert.match(doc.stdout, /1 observations/);
});
