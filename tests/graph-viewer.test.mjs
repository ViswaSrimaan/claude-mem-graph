import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openStore } from '../plugin/lib/store/index.mjs';
import { toGraphifyJson, toGraphML, toCypher } from '../plugin/lib/graph/export.mjs';
import { CLI, tmpDir, waitFor, runCli } from './helpers.mjs';
import { PROJECT, writeStory } from './fixtures/story.mjs';

describe('graph exports', () => {
  test('Graphify JSON, GraphML and Cypher carry entities, facts and history', async () => {
    const s = await openStore(tmpDir(), { backend: 'sqlite' });
    writeStory(s);
    const g = s.graph;
    // A name that would break naive XML or Cypher output.
    const odd = g.upsertEntity({ project: PROJECT, kind: 'person', name: `O'Brien <ops> & "co" \\ x}) DETACH DELETE n //` }).entity;
    g.addFact({ project: PROJECT, src: odd.id, dst: g.findEntity({ project: PROJECT, name: 'Acme' }).id, type: 'works at', confidence: 'INFERRED' });

    const json = toGraphifyJson(g, PROJECT);
    assert.equal(json.nodes.length, 9);
    assert.deepEqual(Object.keys(json).sort(), ['directed', 'graph', 'links', 'multigraph', 'nodes']);
    const pdf = json.links.find((l) => l.relation === 'prefers format');
    assert.equal(pdf.confidence, 'EXTRACTED', 'STATED maps to Graphify EXTRACTED');
    assert.equal(pdf.memory_confidence, 'STATED');
    assert.equal(pdf._src, pdf.source);
    assert.ok(!json.links.some((l) => !l.current), 'current facts only by default');
    assert.equal(toGraphifyJson(g, PROJECT, { history: true }).links.filter((l) => !l.current).length, 1);
    assert.ok(json.nodes.find((n) => n.label === 'Acme').aliases.includes('Acme Corp'));

    const xml = toGraphML(g, PROJECT);
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<graphml/);
    assert.equal((xml.match(/<node /g) || []).length, 9);
    assert.equal((xml.match(/<edge /g) || []).length, 8);
    assert.match(xml, /O&apos;Brien &lt;ops&gt; &amp; &quot;co&quot;/);
    assert.ok(!xml.includes('<ops>'));

    const cy = toCypher(g, PROJECT);
    assert.match(cy, /CREATE CONSTRAINT memory_entity_id/);
    assert.match(cy, /SET n:Person, n \+= \{name: 'Priya'/);
    assert.match(cy, /-\[:PREFERS_FORMAT \{id: 'f\d+', relation: 'prefers format', confidence: 'STATED'/);
    const line = cy.split('\n').find((l) => l.includes('Brien'));
    assert.match(line, /name: 'O\\'Brien <ops> & "co" \\\\ x\}\) DETACH DELETE n \/\/'/, 'quotes and backslashes escaped; text stays inside the string');
    s.close();
  });

  test('cmem graph export writes each format', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    writeStory(s);
    s.close();
    const env = { CLAUDE_MEM_LOCAL_DATA_DIR: dir };
    const out = await runCli(['graph', 'export', '--format', 'graphml', '--project', PROJECT], { env });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /<graphml/);
    const json = JSON.parse((await runCli(['graph', 'export', '--project', PROJECT], { env })).stdout);
    assert.ok(json.nodes.some((n) => n.label === 'Priya' && n.community !== null), 'themes become Graphify communities');
  });
});

describe('viewer API for the graph', () => {
  test('graph, entities, facts, review, feedback and export endpoints', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const { notes } = writeStory(s);
    s.graph.addReview({ project: PROJECT, kind: 'entity-merge', a: s.graph.findEntity({ project: PROJECT, name: 'PDF' }).id, b: s.graph.findEntity({ project: PROJECT, name: 'Word' }).id, score: 0.86, reason: 'test' });
    s.close();
    const port = 41000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [CLI, 'worker', 'run', '--port', String(port)], { env: { ...process.env, CLAUDE_MEM_LOCAL_DATA_DIR: dir, CLAUDE_MEM_LOCAL_PROVIDER: 'heuristic', CLAUDE_MEM_LOCAL_MODE: 'general' }, windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    const h = { 'x-cmem-local': '1', 'content-type': 'application/json' };
    const get = async (p) => (await fetch(`${base}${p}`)).json();
    const send = async (method, p, body) => (await fetch(`${base}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined })).json();
    try {
      await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } });
      const html = await (await fetch(base)).text();
      assert.match(html, /data-tab="graph"/);
      assert.match(html, /data-tab="review"/);

      assert.equal((await fetch(`${base}/api/graph?project=*`)).status, 400, 'graph needs one project');
      const view = await get(`/api/graph?project=${PROJECT}`);
      assert.equal(view.nodes.length, 8);
      assert.equal(view.edges.length, 7, 'current facts only');
      assert.ok(view.themes.length >= 1);
      assert.ok(view.nodes.find((n) => n.name === 'Priya').theme);
      assert.equal((await get(`/api/graph?project=${PROJECT}&history=1`)).edges.length, 8);

      const ov = await get(`/api/graph/overview?project=${PROJECT}`);
      assert.ok(ov.keyEntities.some((e) => e.name === 'Priya'));
      assert.ok(ov.themes[0].members.length);

      const [obs] = await get(`/api/observations?project=${PROJECT}&q=Word`);
      assert.ok(obs.entities.some((e) => e.name === 'Priya'), 'memory cards carry their entities');

      const priyaId = view.nodes.find((n) => n.name === 'Priya').id;
      const d = await get(`/api/entities/${priyaId}`);
      assert.equal(d.entity.name, 'Priya');
      const pdf = d.facts.find((f) => f.dst_name === 'PDF');
      assert.deepEqual(pdf.previous, ['Word']);
      assert.equal(d.notes.length, 3);

      const renamed = await send('PATCH', `/api/entities/${priyaId}`, { name: 'Priya Shah' });
      assert.equal(renamed.entity.name, 'Priya Shah');
      assert.ok(renamed.entity.aliases.includes('Priya'));

      const fact = d.facts.find((f) => f.type === 'contact for');
      assert.equal((await send('PATCH', `/api/facts/${fact.id}`, { confidence: 'INFERRED' })).confidence, 'INFERRED');
      assert.equal((await send('PATCH', `/api/facts/${fact.id}`, { close: true })).current, false);

      const found = await get(`/api/entities?project=${PROJECT}&q=legal`);
      assert.equal(found[0].name, 'Legal review');
      const eu = view.nodes.find((n) => n.name === 'EU region').id;
      const merged = await send('POST', `/api/entities/${eu}/merge`, { into: found[0].id });
      assert.ok(merged.entity.aliases.includes('EU region'));

      const review = await get(`/api/review?project=${PROJECT}`);
      assert.equal(review.length, 1);
      assert.equal((await send('POST', `/api/review/${review[0].id}`, { accept: false })).status, 'rejected');
      assert.equal((await get(`/api/review?project=${PROJECT}`)).length, 0);

      const fb = await send('POST', '/api/feedback', { ids: [notes[0]], outcome: 'useful', project: PROJECT });
      assert.match(fb.message, /Recorded "useful"/);

      const exp = await fetch(`${base}/api/graph/export?project=${PROJECT}&format=cypher`);
      assert.match(exp.headers.get('content-disposition'), /attachment; filename="memory-graph-acme-report\.cypher"/);
      assert.match(exp.headers.get('content-type'), /text\/plain/);
      assert.match(await exp.text(), /MERGE \(n:Entity/);

      assert.equal((await send('DELETE', `/api/entities/${priyaId}`)).deleted, 1);
      assert.equal((await fetch(`${base}/api/entities/${priyaId}`)).status, 404);
      assert.equal((await fetch(`${base}/api/entities/1`, { method: 'DELETE' })).status, 403, 'writes still need the header');
    } finally {
      await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-cmem-local': '1' } }).catch(() => {});
      await new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill(); r(); }, 3000); });
    }
  });
});
