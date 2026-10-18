import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openStore } from '../plugin/lib/store/index.mjs';
import { callTool } from '../plugin/lib/mcp.mjs';
import { buildSessionContext } from '../plugin/lib/context.mjs';
import { ingestClaudeMemory, encodeCwd, parseMemoryFile } from '../plugin/lib/claude-memory.mjs';
import { embedMissing, semanticSearch, cosine } from '../plugin/lib/embeddings.mjs';
import { tmpDir, baseSettings } from './helpers.mjs';
import { PROJECT, writeStory } from './fixtures/story.mjs';

const settingsFor = (dir, over = {}) => ({ ...baseSettings(dir, over), mode: 'general', embeddings: { enabled: false, model: 'm', baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 3000 }, corpus: { maxChars: 60000 }, ...over });

function server(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, body: json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(req.url, json)));
    });
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}/v1` })));
}

describe('to-do lists (work_state)', () => {
  test('items persist, update by name, show at session start, and close', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = settingsFor(dir);
    const tool = (name, args) => callTool(s, settings, name, { project: 'web', ...args });
    const w = await tool('work_state_write', { items: [{ task: 'Fix the login redirect', status: 'doing' }, { task: 'Write release notes' }] });
    assert.match(w, /Updated 2 items: Fix the login redirect → doing, Write release notes → todo/);
    assert.match(w, /todo \(2 open\):\n- \[doing\] Fix the login redirect .*\n- \[todo\] Write release notes/);

    await tool('work_state_write', { items: [{ task: 'fix the login redirects', status: 'done', note: 'merged in #42' }] });
    const open = await tool('work_state_read', {});
    assert.doesNotMatch(open, /login/, 'the done item left the open list (matched despite the plural)');
    assert.match(await tool('work_state_read', { includeClosed: true }), /\[done\] Fix the login redirect — merged in #42/);

    await tool('work_state_write', { list: 'launch', items: [{ task: 'Book the venue' }] });
    assert.match(await tool('work_state_read', {}), /launch \(1 open\):[\s\S]*todo \(1 open\):/);

    s.addObservation({ session_id: 'x', project: 'web', title: 'Some note' });
    const ctx = buildSessionContext(s, settings, { project: 'web' });
    assert.match(ctx, /## Open work\n(- .*\n)*- \[todo\] (Write release notes|Book the venue)/);
    assert.doesNotMatch(ctx.split('## Open work')[1].split('\n## ')[0], /login/);
    await assert.rejects(() => tool('work_state_write', { items: [] }), /Pass items/);
    s.close();
  });
});

describe('Claude desktop app (no project folder)', () => {
  test('CLAUDE_MEM_LOCAL_PROJECT=* searches everything and saves under claude-desktop', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = settingsFor(dir);
    s.addObservation({ session_id: 'a', project: 'shop', title: 'Checkout uses Stripe test mode in staging' });
    const before = process.env.CLAUDE_MEM_LOCAL_PROJECT;
    process.env.CLAUDE_MEM_LOCAL_PROJECT = '*';
    try {
      assert.match(await callTool(s, settings, 'search', { query: 'stripe' }), /Checkout uses Stripe .*\[shop\]/);
      assert.match(await callTool(s, settings, 'save_memory', { text: 'Prefers short answers in the desktop app' }), /Saved memory #\d+/);
      assert.equal(s.recentObservations({ project: 'claude-desktop' })[0].title, 'Prefers short answers in the desktop app');
      assert.match(await callTool(s, settings, 'work_state_write', { items: [{ task: 'Renew passport' }] }), /todo \(1 open\)/);
      assert.equal(s.graph.listWork({ project: 'claude-desktop' }).length, 1);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_MEM_LOCAL_PROJECT;
      else process.env.CLAUDE_MEM_LOCAL_PROJECT = before;
    }
    s.close();
  });
});

describe('get_tool_uses', () => {
  test('returns the raw tool calls of the turn behind a note', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = settingsFor(dir);
    s.addEvent({ session_id: 's', project: 'p', prompt_number: 2, tool_name: 'Bash', tool_input: '{"command":"npm test"}', tool_output: '12 passing' });
    s.addEvent({ session_id: 's', project: 'p', prompt_number: 3, tool_name: 'Read', tool_input: '{"file_path":"other.js"}', tool_output: 'x' });
    const id = s.addObservation({ session_id: 's', project: 'p', prompt_number: 2, title: 'Tests pass' });
    const manual = s.addObservation({ session_id: 'manual', project: 'p', title: 'Hand note' });
    const out = await callTool(s, settings, 'get_tool_uses', { ids: [id, manual] });
    assert.match(out, /## #\d+ Tests pass\n- Bash at .*\n {2}input: \{"command":"npm test"\}\n {2}output: 12 passing/);
    assert.doesNotMatch(out, /other\.js/, 'only the same turn');
    assert.match(out, /## #\d+ Hand note\n\(no raw tool calls kept/);
    s.close();
  });
});

describe('Claude Code memory import', () => {
  test('memory files become notes; changes update them; MEMORY.md and secrets are skipped', async () => {
    const config = tmpDir('claude-config-');
    const cwd = tmpDir('work-');
    const memDir = path.join(config, 'projects', encodeCwd(path.resolve(cwd)), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [Release](release.md) — how we ship');
    fs.writeFileSync(path.join(memDir, 'release.md'), '---\nname: release-process\ndescription: "Releases go through make release; CI signs tags"\n---\n\nNever push tags by hand. Token: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n');
    fs.writeFileSync(path.join(memDir, 'style.md'), '# Writing style\nShort sentences. No emoji.');

    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const dir = tmpDir();
      const s = await openStore(dir, { backend: 'sqlite' });
      const settings = settingsFor(dir);
      const r1 = ingestClaudeMemory(s, settings, { cwd, project: 'shop' });
      assert.deepEqual([r1.added, r1.updated, r1.unchanged], [2, 0, 0]);
      const notes = s.recentObservations({ project: 'shop' });
      const rel = notes.find((o) => o.title === 'Releases go through make release; CI signs tags');
      assert.ok(rel, 'title from front matter');
      assert.equal(rel.source, 'claude-memory');
      assert.ok(!rel.narrative.includes('sk-ant-api03'), 'secret redacted');
      assert.ok(notes.some((o) => o.title === 'Writing style'), 'title from heading');
      assert.ok(!notes.some((o) => /\[Release\]/.test(o.narrative)), 'MEMORY.md index skipped');

      assert.deepEqual(ingestClaudeMemory(s, settings, { cwd, project: 'shop' }).unchanged, 2, 'unchanged files are not re-imported');
      fs.writeFileSync(path.join(memDir, 'style.md'), '# Writing style\nShort sentences. British spelling.');
      const r3 = ingestClaudeMemory(s, settings, { cwd, project: 'shop' });
      assert.deepEqual([r3.added, r3.updated], [0, 1]);
      assert.equal(s.stats('shop').observations, 2);
      assert.match(s.search({ query: 'British spelling', project: 'shop' })[0].narrative, /British/);

      assert.equal(ingestClaudeMemory(s, { ...settings, capture: { ...settings.capture, claudeMemory: false } }, { cwd, project: 'shop' }).dirs.length, 0, 'can be switched off');
      s.close();

      const j = await openStore(tmpDir(), { backend: 'json' });
      assert.equal(ingestClaudeMemory(j, settingsFor(dir), { cwd, project: 'shop' }).added, 2, 'works with JSON storage too');
      j.close();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
    assert.deepEqual(parseMemoryFile('no front matter').title, '');
  });
});

describe('knowledge corpora', () => {
  test('build by words or entity, list, rebuild, and ask with one model call', async () => {
    const { s: srv, seen, url } = await server(() => ({ choices: [{ message: { content: 'Priya wants PDF now (#4); it used to be Word (#2).' } }] }));
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = settingsFor(dir, { observer: { provider: 'openai', openaiBaseUrl: url, openaiModel: 'm', timeoutMs: 5000 } });
    const { notes } = writeStory(s);
    const tool = (name, args) => callTool(s, settings, name, { project: PROJECT, ...args });

    assert.match(await tool('build_corpus', { name: 'Acme', entity: 'Acme', description: 'Everything about the client' }), /Built corpus "Acme" in "acme-report": 4 notes/);
    assert.match(await tool('build_corpus', { name: 'formats', query: 'Word PDF', types: ['preference', 'change'] }), /Built corpus "formats" in "acme-report": 2 notes/);
    assert.match(await tool('list_corpora', {}), /- formats \[acme-report\] · 2 notes .*query "Word PDF"\n- Acme \[acme-report\] · 4 notes .*Everything about the client .*around Acme/);

    const answer = await tool('query_corpus', { name: 'Acme', question: 'What format does Priya want?' });
    srv.close();
    assert.match(answer, /^Answer from corpus "Acme" \(4 of 4 notes, \d+ facts, via openai\):\n\nPriya wants PDF now \(#4\)/);
    const sent = seen[0].body.messages;
    assert.match(sent[0].content, /knowledge corpus/, 'its own system prompt, not the observer one');
    assert.match(sent[1].content, /## Facts\n(- .*\n)*- Priya —prefers format→ PDF/);
    assert.match(sent[1].content, new RegExp(`### #${notes[3]} Acme now wants PDF`));
    assert.match(sent[1].content, /Question: What format does Priya want\?$/);

    s.addObservation({ session_id: 'later', project: PROJECT, type: 'preference', title: 'Acme wants the Word draft exported to PDF with page numbers' });
    assert.match(await tool('build_corpus', { name: 'formats' }), /Rebuilt corpus "formats" .*3 notes/);

    const offline = await callTool(s, settingsFor(dir), 'query_corpus', { project: PROJECT, name: 'formats', question: 'page numbers' });
    assert.match(offline, /No model is configured to answer[\s\S]*- #\d+ Acme wants the Word draft exported to PDF with page numbers/);
    await assert.rejects(() => tool('query_corpus', { name: 'nope', question: 'x' }), /No corpus "nope"/);
    s.close();
  });
});

describe('meaning-based search (embeddings)', () => {
  // A stand-in embedding model: bag of words over a tiny vocabulary with
  // synonyms folded together, so "automobile" lands next to "car".
  const SYN = { automobile: 'car', vehicle: 'car', maintenance: 'service', servicing: 'service' };
  const VOCAB = ['car', 'service', 'schedule', 'invoice', 'client', 'pdf', 'report', 'garden'];
  const vec = (t) => {
    const v = new Array(VOCAB.length).fill(0);
    for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) { const i = VOCAB.indexOf(SYN[w] || w); if (i >= 0) v[i] += 1; }
    v.push(0.01);
    return v;
  };

  test('finds notes by meaning, merges them into search, and fails soft', async () => {
    const { s: srv, url } = await server((u, body) => ({ data: body.input.map((t, index) => ({ index, embedding: vec(t) })) }));
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = settingsFor(dir, { embeddings: { enabled: true, baseUrl: url, model: 'fake', timeoutMs: 3000 } });
    const car = s.addObservation({ session_id: 'a', project: 'home', title: 'Car service schedule', narrative: 'The car needs a service every 12 months.' });
    s.addObservation({ session_id: 'a', project: 'home', title: 'Garden plan', narrative: 'Plant tomatoes in May.' });
    assert.equal(await embedMissing(s, settings, {}), 2);
    assert.equal(await embedMissing(s, settings, {}), 0, 'nothing left');

    assert.equal(s.search({ query: 'automobile maintenance', project: 'home' }).length, 0, 'words alone find nothing');
    const hits = await semanticSearch(s, settings, 'automobile maintenance', { project: 'home' });
    assert.equal(hits[0].id, car);
    const out = await callTool(s, settings, 'search', { query: 'automobile maintenance', project: 'home' });
    assert.match(out, new RegExp(`#${car} .*Car service schedule.*≈ similar in meaning`));
    assert.doesNotMatch(out, /Garden/);
    srv.close();

    const down = settingsFor(dir, { embeddings: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', timeoutMs: 1000 } });
    assert.deepEqual(await semanticSearch(s, down, 'car', { project: 'home' }), [], 'server down: no meaning hits, no error');
    assert.match(await callTool(s, down, 'search', { query: 'car service', project: 'home' }), /Car service schedule/);
    assert.ok(Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])) - 1) < 1e-9);
    s.close();
  });
});
