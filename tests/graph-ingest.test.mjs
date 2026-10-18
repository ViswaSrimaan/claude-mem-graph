import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../plugin/lib/store/index.mjs';
import { loadMode } from '../plugin/lib/modes.mjs';
import { compareNames, jaroWinkler } from '../plugin/lib/graph/match.mjs';
import { nameKey } from '../plugin/lib/graph/names.mjs';
import { ingestNote, resolveEntity } from '../plugin/lib/graph/ingest.mjs';
import { isSingle, normalizeKind } from '../plugin/lib/graph/vocab.mjs';
import { buildObserverPrompt, parseObserverOutput, heuristicObserve, processSession } from '../plugin/lib/observer.mjs';
import { findNearDuplicate } from '../plugin/lib/dedup.mjs';
import { saveMemory } from '../plugin/lib/memory-actions.mjs';
import { callTool } from '../plugin/lib/mcp.mjs';
import { tmpDir, baseSettings } from './helpers.mjs';
import { PROJECT, TURNS } from './fixtures/story.mjs';

const general = loadMode('general');
const code = loadMode('code');
const sqlite = () => openStore(tmpDir(), { backend: 'sqlite' });
const decide = (a, b) => compareNames(nameKey(a), nameKey(b)).decision;

describe('name matching', () => {
  test('tricky pairs merge, go to review, or stay apart', () => {
    const cases = [
      ['Acme Corp', 'Acme', 'merge'],
      ['Q3 reports', 'Q3 report', 'merge'],
      ['report Q3', 'Q3 report', 'merge'],
      ['Jonathan Smith', 'Jonathon Smith', 'merge'],
      ['Postgres', 'PostgreSQL', 'review'],
      ['Acme', 'Acme Widgets', 'review'],
      ['pane', 'plane', 'none'],
      ['API v2', 'API v3', 'none'],
      ['ADR 0011', 'ADR 0013', 'none'],
      ['Sales Report', 'Legal Report', 'none'],
      ['Asset Contribution Flow', 'Asset Consumption Flow', 'none'],
      ['Priya', 'Pratik', 'none'],
    ];
    for (const [a, b, want] of cases) assert.equal(decide(a, b), want, `${a} / ${b}`);
    assert.ok(Math.abs(jaroWinkler('martha', 'marhta') - 0.961) < 0.001, 'textbook Jaro-Winkler value');
  });

  test('kinds and one-at-a-time relations come from the mode', () => {
    assert.equal(normalizeKind(general, 'Organization'), 'organisation');
    assert.equal(normalizeKind(general, 'spaceship'), 'topic', 'unknown kinds become topic');
    assert.equal(normalizeKind(code, 'file'), 'file');
    assert.ok(isSingle(general, 'prefers format'));
    assert.ok(isSingle(code, 'prefers'));
    assert.ok(isSingle(general, 'prefers_tone'), 'any "prefers…" relation');
    assert.ok(!isSingle(general, 'uses'));
  });
});

describe('ingest', () => {
  test('the walkthrough story through ingestNote', async () => {
    const s = await sqlite();
    const g = s.graph;
    for (const t of TURNS) {
      const noteId = s.addObservation({ session_id: 'story', project: PROJECT, ...t.note, created_at: t.at });
      ingestNote(g, general, { project: PROJECT, noteId, at: t.at, entities: t.entities, relations: t.facts });
    }
    const priya = g.findEntity({ project: PROJECT, name: 'Priya' });
    assert.deepEqual(g.factsFor(priya.id).filter((f) => f.type === 'prefers format').map((f) => f.dst_name), ['PDF']);
    assert.equal(g.stats(PROJECT).closed_facts, 1, 'Word preference closed via the mode vocabulary');
    assert.deepEqual(g.findEntity({ project: PROJECT, name: 'Acme' }).aliases, ['Acme Corp']);
    assert.equal(g.stats(PROJECT).entities, 8);
    s.close();
  });

  test('close spellings merge or go to review; decided pairs are not asked again', async () => {
    const s = await sqlite();
    const g = s.graph;
    const p = 'demo';
    const pg = resolveEntity(g, code, { project: p, name: 'PostgreSQL', kind: 'tool' });
    const unsure = resolveEntity(g, code, { project: p, name: 'Postgres', kind: 'tool' });
    assert.equal(unsure.review, true);
    const [item] = g.listReview({ project: p });
    assert.equal(item.kind, 'entity-merge');
    assert.match(item.question, /"PostgreSQL" and "Postgres" the same tool/);

    const report = resolveEntity(g, general, { project: p, name: 'Quarterly report', kind: 'document' });
    const plural = resolveEntity(g, general, { project: p, name: 'Quarterly reports', kind: 'document' });
    assert.equal(plural.id, report.id);
    assert.equal(plural.merged, 'singular/plural');
    assert.ok(g.getEntity(report.id).aliases.includes('Quarterly reports'));

    assert.equal(g.resolveReview(item.id, true).status, 'accepted');
    assert.equal(g.getEntity(unsure.id), null, 'merged into PostgreSQL');
    assert.equal(g.findEntity({ project: p, name: 'Postgres' }).id, pg.id);

    const other = resolveEntity(g, code, { project: p, name: 'Grafana', kind: 'tool' });
    const typo = resolveEntity(g, code, { project: p, name: 'Grafanna', kind: 'tool' });
    const [second] = g.listReview({ project: p });
    assert.deepEqual([second.a_id, second.b_id], [other.id, typo.id]);
    g.resolveReview(second.id, false);
    assert.ok(g.getEntity(typo.id), 'rejected: both stay');
    resolveEntity(g, code, { project: p, name: 'Grafanna', kind: 'tool' });
    resolveEntity(g, code, { project: p, name: 'Redis', kind: 'tool' });
    resolveEntity(g, code, { project: p, name: 'Rediss', kind: 'tool' });
    assert.equal(g.listReview({ project: p }).length, 0, 'not asked again; short names with a length change stay apart');
    s.close();
  });

  test('a generic topic is sharpened instead of duplicated; tasks keep their status', async () => {
    const s = await sqlite();
    const g = s.graph;
    const a = resolveEntity(g, general, { project: 'x', name: 'Acme', kind: 'topic' });
    const b = resolveEntity(g, general, { project: 'x', name: 'Acme', kind: 'organisation' });
    assert.equal(a.id, b.id);
    assert.equal(g.getEntity(a.id).kind, 'organisation');
    const t = resolveEntity(g, general, { project: 'x', name: 'Legal review', kind: 'task', status: 'TODO' });
    assert.equal(g.getEntity(t.id).status, 'todo');
    resolveEntity(g, general, { project: 'x', name: 'Legal review', kind: 'task', status: 'done' });
    assert.equal(g.getEntity(t.id).status, 'done');
    resolveEntity(g, general, { project: 'x', name: 'Legal review', kind: 'task', status: 'nonsense' });
    assert.equal(g.getEntity(t.id).status, 'done', 'unknown statuses ignored');
    const doc = resolveEntity(g, general, { project: 'x', name: 'Q3 report', kind: 'document', status: 'doing' });
    assert.equal(g.getEntity(doc.id).status, null, 'only tasks have a status');

    // Seen in a real session: the tool call created a file entity, then the
    // observer named the same file as a document.
    const noteId = s.addObservation({ session_id: 's', project: 'x', title: 'Wrote notes', files_modified: ['notes.md'] });
    const file = g.findEntity({ project: 'x', name: 'notes.md', kind: 'file' });
    ingestNote(g, general, { project: 'x', noteId, entities: [{ name: 'notes.md', kind: 'document' }], relations: [{ src: 'notes.md', type: 'about', dst: 'Q3 report' }] });
    assert.equal(g.listEntities({ project: 'x' }).filter((e) => e.name === 'notes.md').length, 1, 'one notes.md entity');
    assert.equal(g.factsFor(file.id)[0].dst_name, 'Q3 report');
    s.close();
  });

  test('ambiguous facts go to review: confirm makes them STATED, reject removes them', async () => {
    const s = await sqlite();
    const g = s.graph;
    const noteId = s.addObservation({ session_id: 's', project: 'x', title: 'Maybe' });
    const r = ingestNote(g, general, {
      project: 'x', noteId,
      entities: [{ name: 'Priya', kind: 'person' }, { name: 'Acme', kind: 'organisation' }, { name: 'Globex', kind: 'organisation' }],
      relations: [
        { src: 'Priya', type: 'works at', dst: 'Acme', confidence: 'AMBIGUOUS' },
        { src: 'Acme', type: 'related to', dst: 'Globex', confidence: 'AMBIGUOUS' },
      ],
    });
    assert.equal(r.review, 2);
    const items = g.listReview({ project: 'x' });
    const works = items.find((i) => i.a.type === 'works at');
    assert.match(works.question, /Priya —works at→ Acme/);
    g.resolveReview(works.id, true);
    assert.equal(g.getFact(works.a_id).confidence, 'STATED');
    const rel = items.find((i) => i.a.type === 'related to');
    g.resolveReview(rel.id, false);
    assert.equal(g.getFact(rel.a_id), null);
    assert.equal(g.mentionsOf('observation', noteId).length, 3, 'the note is linked to all three');
    s.close();
  });
});

describe('observer', () => {
  test('prompt lists kinds, relation types and known entities', () => {
    const p = buildObserverPrompt({
      mode: general, project: 'p', cwd: '/p', requests: [{ prompt_number: 1, text: 'hi' }], events: [], lastAssistant: '',
      knownEntities: [{ name: 'Acme', kind: 'organisation' }, { name: 'Pri<ya>', kind: 'person' }],
    });
    assert.match(p, /Known entities: Acme \(organisation\); Priya \(person\)/);
    assert.match(p, /prefers format \[one at a time\]/);
    assert.match(p, /organisation \(client, company, team\)/);
    assert.match(p, /"relations":\[\{"src":""/);
  });

  test('parser keeps valid entities and relations, redacts secrets, drops broken ones', () => {
    const r = parseObserverOutput(JSON.stringify({
      observations: [{
        type: 'preference', title: 'Priya wants PDF',
        entities: [{ name: 'Priya', kind: 'person' }, { name: '' }, 'junk', { name: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', kind: 'tool' }],
        relations: [
          { src: 'Priya', type: 'prefers format', dst: 'PDF', why: 'portal password=hunter2xyz', confidence: 'stated' },
          { source: 'Priya', relation: 'works at', target: 'Acme' },
          { src: 'Priya', type: 'is', dst: 'priya' },
          { src: 'Priya', dst: 'x' },
        ],
      }],
    }), general);
    const o = r.observations[0];
    assert.deepEqual(o.entities.map((e) => e.name).slice(0, 1), ['Priya']);
    assert.equal(o.entities.length, 2);
    assert.ok(!JSON.stringify(o).includes('sk-ant-api03'));
    assert.ok(!JSON.stringify(o).includes('hunter2xyz'));
    assert.deepEqual(o.relations.map((x) => [x.src, x.type, x.dst, x.confidence]), [
      ['Priya', 'prefers format', 'PDF', 'STATED'], ['Priya', 'works at', 'Acme', 'INFERRED'],
    ]);
    assert.deepEqual(parseObserverOutput('{"observations":[{"title":"t"}]}', general).observations[0].relations, [], 'old-style output still works');
  });

  test('offline observer links files edited together', () => {
    const cwd = process.cwd();
    const r = heuristicObserve({
      mode: code, cwd, requests: [{ prompt_number: 1, text: 'rename' }], lastAssistant: '',
      events: ['a', 'b', 'c'].map((f) => ({ tool_name: 'Edit', tool_input: JSON.stringify({ file_path: `${cwd}/src/${f}.js` }) })),
    });
    assert.deepEqual(r.observations[0].relations.map((x) => `${x.src}~${x.dst}`), ['src/a.js~src/b.js', 'src/a.js~src/c.js', 'src/b.js~src/c.js']);
  });

  function mockLlm(contents) {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: contents.shift() } }] }));
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
  }

  test('processSession writes notes and graph from one model call per turn', async () => {
    const reply = (title, entities, relations) => JSON.stringify({ observations: [{ type: 'finding', title, narrative: title, entities, relations }], summary: { request: title } });
    const { server, seen, url } = await mockLlm([
      reply('Priya at Acme wants the report as Word', [{ name: 'Priya', kind: 'person' }, { name: 'Acme', kind: 'organisation' }, { name: 'Word', kind: 'format' }],
        [{ src: 'Priya', type: 'works at', dst: 'Acme', confidence: 'STATED' }, { src: 'Priya', type: 'prefers format', dst: 'Word', confidence: 'STATED' }]),
      reply('Acme Corp now wants PDF instead of Word', [{ name: 'Acme Corp', kind: 'organisation' }, { name: 'PDF', kind: 'format' }],
        [{ src: 'Priya', type: 'prefers format', dst: 'PDF', why: 'their portal only accepts PDF', confidence: 'STATED' }]),
    ]);
    const dir = tmpDir();
    const store = await openStore(dir, { backend: 'sqlite' });
    const settings = { ...baseSettings(dir, { observer: { provider: 'openai', openaiBaseUrl: url } }), mode: 'general' };
    store.upsertSession({ session_id: 's', project: 'report', cwd: process.cwd() });
    for (const text of ['Note the client preference', 'Update: they changed their mind']) {
      const n = store.nextPromptNumber('s');
      store.addPrompt({ session_id: 's', project: 'report', prompt_number: n, text });
      store.addEvent({ session_id: 's', project: 'report', prompt_number: n, tool_name: 'Read', tool_input: '{"file_path":"brief.md"}', tool_output: 'brief' });
      const r = await processSession(store, settings, 's');
      assert.equal(r.created, 1);
    }
    server.close();
    assert.match(seen[1].messages[1].content, /Known entities: .*Priya \(person\)/, 'second call is told what is already known');
    const g = store.graph;
    const priya = g.findEntity({ project: 'report', name: 'Priya' });
    const prefs = g.factsFor(priya.id, { history: true }).filter((f) => f.type === 'prefers format');
    assert.deepEqual(prefs.map((f) => [f.dst_name, f.current]), [['PDF', true], ['Word', false]]);
    assert.equal(prefs[0].why, 'their portal only accepts PDF');
    const [note2] = store.recentObservations({ project: 'report', limit: 1 });
    assert.equal(prefs[0].note_id, note2.id, 'fact points to its source note');
    assert.ok(g.mentionsOf('observation', note2.id).some((e) => e.name === 'Acme'), '"Acme Corp" resolved to Acme');
    store.close();
  });
});

describe('near-duplicate notes', () => {
  test('exact titles are skipped; close rewordings are queued, rare-word differences are not', async () => {
    const s = await sqlite();
    const p = 'web';
    for (let i = 0; i < 12; i++) s.addObservation({ session_id: 's', project: p, title: `Fixed the login form crash number ${i}` });
    s.addObservation({ session_id: 's', project: p, title: 'Cache expiry fixed for the login session' });
    assert.equal(findNearDuplicate(s, p, 'cache expiry FIXED for the login session!').tier, 'exact');
    const near = findNearDuplicate(s, p, 'Fixed cache expiry for login session');
    assert.equal(near.tier, 'candidate');
    assert.match(near.match.title, /^Cache expiry/);
    assert.equal(findNearDuplicate(s, p, 'Cache expiry fixed for the billing session').tier, 'none', 'billing is a rare word: veto');
    assert.equal(findNearDuplicate(s, 'empty', 'anything').tier, 'none');
    s.close();
  });
});

describe('save_memory with facts', () => {
  test('explicit facts are STATED and replace older one-at-a-time values', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = { ...baseSettings(dir), mode: 'general' };
    saveMemory(s, settings, { text: 'Priya prefers Word', project: 'r', relations: [{ src: 'Priya', type: 'prefers format', dst: 'Word' }] });
    const out = await callTool(s, settings, 'save_memory', {
      text: 'Priya now prefers PDF', project: 'r',
      entities: [{ name: 'Priya', kind: 'person' }, { name: 'PDF', kind: 'format' }],
      relations: [{ src: 'Priya', type: 'prefers format', dst: 'PDF', why: 'portal' }],
    });
    assert.match(out, /Saved memory #\d+: Priya now prefers PDF \(2 entities, 1 new facts, 1 older facts replaced\)/);
    const priya = s.graph.findEntity({ project: 'r', name: 'Priya' });
    assert.equal(priya.kind, 'person', 'topic from the first save sharpened to person');
    const [cur] = s.graph.factsFor(priya.id);
    assert.deepEqual([cur.dst_name, cur.confidence, cur.why], ['PDF', 'STATED', 'portal']);
    s.close();
  });
});

describe('export and import keep the graph', () => {
  test('facts, history, aliases and note links survive a round trip', async () => {
    const a = await sqlite();
    for (const t of TURNS) {
      const noteId = a.addObservation({ session_id: 'story', project: PROJECT, ...t.note, created_at: t.at });
      ingestNote(a.graph, general, { project: PROJECT, noteId, at: t.at, entities: t.entities, relations: t.facts });
    }
    const dump = JSON.parse(JSON.stringify(a.exportAll()));
    a.close();
    const b = await sqlite();
    b.addObservation({ session_id: 'other', project: 'zzz', title: 'shifts the ids' });
    const counts = b.importAll(dump);
    assert.deepEqual(counts.graph, { entities: 8, facts: 8, mentions: 13 });
    const g = b.graph;
    const priya = g.findEntity({ project: PROJECT, name: 'Priya' });
    const hist = g.factsFor(priya.id, { history: true }).filter((f) => f.type === 'prefers format');
    assert.deepEqual(hist.map((f) => [f.dst_name, f.current]), [['PDF', true], ['Word', false]]);
    assert.equal(hist[1].superseded_by, hist[0].id);
    const note = b.getObservation(hist[0].note_id);
    assert.match(note.title, /PDF, not Word/, 'note ids remapped');
    assert.deepEqual(g.findEntity({ project: PROJECT, name: 'Acme' }).aliases, ['Acme Corp']);
    assert.deepEqual(b.importAll(dump).graph, { entities: 0, facts: 0, mentions: 0 }, 'second import adds nothing');
    b.close();
  });
});
