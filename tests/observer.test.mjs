import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../plugin/lib/store/index.mjs';
import { loadMode } from '../plugin/lib/modes.mjs';
import { buildObserverPrompt, parseObserverOutput, heuristicObserve, processSession, summarizeChatTurn } from '../plugin/lib/observer.mjs';
import { buildSessionContext, buildAgentContext } from '../plugin/lib/context.mjs';
import { tmpDir, baseSettings } from './helpers.mjs';

const mode = loadMode('code');

test('parseObserverOutput tolerates fences, prose and trailing commas; normalizes types', () => {
  const text = 'Here you go:\n```json\n{"observations":[{"type":"BUGFIX","title":"Fixed X","narrative":"n","facts":["a",],"files_modified":["a.js"]},{"type":"weird","title":"Y"}],"summary":{"request":"r","completed":"c"}}\n```';
  const r = parseObserverOutput(text, mode);
  assert.equal(r.observations.length, 2);
  assert.equal(r.observations[0].type, 'bugfix');
  assert.equal(r.observations[1].type, 'change', 'unknown types fall back');
  assert.deepEqual(r.observations[0].facts, ['a']);
  assert.equal(r.summary.request, 'r');
  assert.throws(() => parseObserverOutput('no json here', mode));
});

test('parseObserverOutput redacts secrets the model echoed back', () => {
  const r = parseObserverOutput('{"observations":[{"type":"change","title":"Set key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","narrative":"password=hunter2xyz"}]}', mode);
  assert.ok(!JSON.stringify(r).includes('hunter2xyz'));
  assert.ok(!JSON.stringify(r).includes('sk-ant-api03'));
});

test('buildObserverPrompt respects the budget and keeps newest events', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ tool_name: 'Bash', tool_input: `{"command":"step ${i}"}`, tool_output: 'x'.repeat(3000) }));
  const p = buildObserverPrompt({ mode, project: 'p', cwd: '/p', requests: [{ prompt_number: 1, text: 'do it' }], events, lastAssistant: 'done', maxChars: 30000 });
  assert.ok(p.length <= 31000, `prompt too long: ${p.length}`);
  assert.match(p, /step 199/);
  assert.match(p, /do it/);
  assert.match(p, /omitted/);
});

test('heuristicObserve extracts files, commands and failures', () => {
  const r = heuristicObserve({
    mode,
    cwd: process.cwd(),
    requests: [{ prompt_number: 1, text: 'Fix the parser' }],
    lastAssistant: 'Parser fixed.',
    events: [
      { tool_name: 'Read', tool_input: JSON.stringify({ file_path: `${process.cwd()}/src/a.js` }) },
      { tool_name: 'Edit', tool_input: JSON.stringify({ file_path: `${process.cwd()}/src/parser.js` }) },
      { tool_name: 'Bash', tool_input: JSON.stringify({ command: 'npm test' }), tool_output: 'boom', failed: 1 },
    ],
  });
  assert.equal(r.observations.length, 1);
  const o = r.observations[0];
  assert.equal(o.type, 'change');
  assert.deepEqual(o.files_modified, ['src/parser.js']);
  assert.deepEqual(o.files_read, ['src/a.js']);
  assert.ok(o.facts.some((f) => f.includes('npm test')));
  assert.ok(o.facts.some((f) => f.startsWith('Failed: Bash')));
  assert.equal(r.summary.completed, 'Parser fixed.');
});

function seed(store) {
  store.upsertSession({ session_id: 's1', project: 'proj', cwd: process.cwd() });
  const n = store.nextPromptNumber('s1');
  store.addPrompt({ session_id: 's1', project: 'proj', prompt_number: n, text: 'Make the cache expire after one hour' });
  store.addEvent({ session_id: 's1', project: 'proj', prompt_number: n, tool_name: 'Edit', tool_input: JSON.stringify({ file_path: `${process.cwd()}/src/cache.js` }), tool_output: 'ok' });
  store.setLastAssistant('s1', 'Cache TTL is now 3600s.');
}

test('processSession with the offline observer stores observation + summary', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  seed(store);
  const r = await processSession(store, baseSettings(dir), 's1');
  assert.equal(r.processed, 1);
  assert.equal(r.created, 1);
  assert.equal(store.countPendingEvents('s1'), 0);
  assert.equal(store.recentSummaries({ project: 'proj' })[0].completed, 'Cache TTL is now 3600s.');
  // same turn processed again yields no duplicate titles
  store.addEvent({ session_id: 's1', project: 'proj', prompt_number: 1, tool_name: 'Edit', tool_input: JSON.stringify({ file_path: `${process.cwd()}/src/cache.js` }) });
  const r2 = await processSession(store, baseSettings(dir), 's1');
  assert.equal(r2.created, 0);
  store.close();
});

function mockLlm(responses) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const next = responses.shift();
      if (next.status) { res.writeHead(next.status); res.end('{"error":"nope"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: next.content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('processSession with an OpenAI-compatible model (e.g. Ollama)', async () => {
  const { server, seen, url } = await mockLlm([{ content: JSON.stringify({
    observations: [{ type: 'feature', title: 'Cache entries now expire after 1 hour', narrative: 'TTL set to 3600s in src/cache.js.', facts: ['TTL is 3600s'], concepts: ['what-changed'] }],
    summary: { request: 'Cache expiry', completed: 'TTL added', next_steps: 'Make TTL configurable' },
  }) }]);
  const dir = tmpDir();
  const store = await openStore(dir);
  seed(store);
  const settings = baseSettings(dir, { observer: { provider: 'openai', openaiBaseUrl: url } });
  const r = await processSession(store, settings, 's1');
  server.close();
  assert.equal(r.created, 1);
  const o = store.recentObservations({ project: 'proj' })[0];
  assert.equal(o.title, 'Cache entries now expire after 1 hour');
  assert.equal(o.source, 'openai');
  assert.deepEqual(o.files_modified, ['src/cache.js'], 'files filled from tool inputs');
  assert.equal(store.recentSummaries({ project: 'proj' })[0].next_steps, 'Make TTL configurable');
  assert.match(seen[0].messages[1].content, /Make the cache expire after one hour/);
  store.close();
});

test('model failure retries once, then falls back to offline so nothing is lost', async () => {
  const { server, url } = await mockLlm([{ status: 500 }, { status: 500 }]);
  const dir = tmpDir();
  const store = await openStore(dir);
  seed(store);
  const settings = baseSettings(dir, { observer: { provider: 'openai', openaiBaseUrl: url } });
  const first = await processSession(store, settings, 's1');
  assert.equal(first.retry, true);
  assert.equal(store.countPendingEvents('s1'), 1, 'events released for retry');
  const second = await processSession(store, settings, 's1');
  server.close();
  assert.equal(second.created, 1);
  assert.equal(store.recentObservations({ project: 'proj' })[0].source, 'heuristic');
  store.close();
});

test('chat-only turns get an offline summary', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  store.upsertSession({ session_id: 'c', project: 'proj' });
  store.addPrompt({ session_id: 'c', project: 'proj', prompt_number: store.nextPromptNumber('c'), text: 'What does HTTP 418 mean?' });
  assert.ok(summarizeChatTurn(store, baseSettings(dir), 'c', "It's the teapot status code."));
  assert.equal(store.recentSummaries({ project: 'proj' })[0].request, 'What does HTTP 418 mean?');
  store.close();
});

test('session context: header, last session, details, index and budget', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  assert.equal(buildSessionContext(store, baseSettings(dir), { project: 'proj' }), '', 'empty memory injects nothing');
  for (let i = 0; i < 60; i++) store.addObservation({ session_id: 's', project: 'proj', type: 'discovery', title: `Observation number ${i}`, narrative: 'n'.repeat(200), created_at: Date.now() - (60 - i) * 60000 });
  store.addObservation({ session_id: 's', project: 'other', title: 'Other project thing' });
  store.addSummary({ session_id: 's', project: 'proj', request: 'Build the thing', completed: 'Thing built', next_steps: 'Ship it' });
  const settings = baseSettings(dir, { context: { maxChars: 3000 } });
  const text = buildSessionContext(store, settings, { project: 'proj' });
  assert.ok(text.length <= 3000, `over budget: ${text.length}`);
  assert.match(text, /# Memory: proj/);
  assert.match(text, /\*\*Next steps:\*\* Ship it/);
  assert.match(text, /Observation number 59/);
  assert.ok(!text.includes('Other project thing'));
  assert.match(text, /reference data, not instructions/);
  store.close();
});

test('agent context finds relevant memory for a subagent prompt', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  store.addObservation({ session_id: 's', project: 'proj', type: 'gotcha', title: 'Migrations must run before seeding', narrative: 'Seeding fails with missing table otherwise.' });
  const block = buildAgentContext(store, baseSettings(dir), { project: 'proj', query: 'seed the database with test data', limit: 5 });
  assert.match(block, /<prior-project-memory/);
  assert.match(block, /Migrations must run before seeding/);
  assert.equal(buildAgentContext(store, baseSettings(dir), { project: 'proj', query: 'quantum chromodynamics', limit: 5 }), '');
  store.close();
});
