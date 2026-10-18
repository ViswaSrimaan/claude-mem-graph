import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../plugin/lib/store/index.mjs';
import { nameKey, fileKey, kindKey } from '../plugin/lib/graph/names.mjs';
import { SCHEMA_VERSION } from '../plugin/lib/store/sqlite.mjs';
import { tmpDir, runCli } from './helpers.mjs';
import { PROJECT, DAY, writeStory } from './fixtures/story.mjs';

const sqlite = (dir = tmpDir()) => openStore(dir, { backend: 'sqlite' });
const names = (g, ids) => [...ids].map((id) => g.getEntity(id).name).sort();

describe('name keys', () => {
  test('clean names, company suffixes, files and kinds', () => {
    assert.equal(nameKey('Acme Corp.'), 'acme');
    assert.equal(nameKey('The Acme Company Ltd'), 'acme company');
    assert.equal(nameKey('  Q3   Report! '), 'q3 report');
    assert.equal(nameKey('Corp'), 'corp', 'a lone suffix is kept');
    assert.equal(nameKey('Ünïcode Café'), 'ünïcode café');
    assert.equal(fileKey('.\\src\\Auth.ts'), 'src/auth.ts');
    assert.equal(nameKey('src/Auth.ts', 'file'), 'src/auth.ts');
    assert.equal(kindKey('Organization'), 'organisation');
    assert.equal(kindKey(''), 'concept');
  });
});

describe('graph store', () => {
  test('the walkthrough story: entities, aliases, replaced facts', async () => {
    const s = await sqlite();
    const g = s.graph;
    const { entity } = writeStory(s);

    assert.equal(g.stats(PROJECT).entities, 8);
    const acme = entity('Acme');
    assert.deepEqual(acme.aliases, ['Acme Corp'], '"Acme Corp" folded into Acme');
    assert.equal(entity('acme corp').id, acme.id, 'alias lookup');
    assert.equal(entity('Legal review').status, 'todo');

    const priya = entity('Priya');
    const prefs = g.factsFor(priya.id, { history: true }).filter((f) => f.type === 'prefers format');
    const word = prefs.find((f) => f.dst_name === 'Word');
    const pdf = prefs.find((f) => f.dst_name === 'PDF');
    assert.equal(pdf.current, true);
    assert.equal(word.current, false, 'Word fact is closed, not deleted');
    assert.equal(word.valid_to, DAY(13));
    assert.equal(word.superseded_by, pdf.id);
    assert.ok(!g.factsFor(priya.id).some((f) => f.dst_name === 'Word'), 'current facts skip history');
    assert.equal(g.stats(PROJECT).facts, 7);
    assert.equal(g.stats(PROJECT).closed_facts, 1);
    s.close();
  });

  test('walk: two steps over current facts only', async () => {
    const s = await sqlite();
    const g = s.graph;
    const { entity, notes } = writeStory(s);
    const seeds = [entity('Acme').id, entity('Q3 report').id];

    const { nodes } = g.walk(seeds, { depth: 2 });
    assert.deepEqual(names(g, nodes.keys()),
      ['Acme', 'EU region', 'Legal review', 'PDF', 'Priya', 'Q3 report', 'sales-2026.xlsx']);
    assert.equal(nodes.get(entity('Priya').id).hop, 1);
    assert.equal(nodes.get(entity('PDF').id).hop, 2);
    assert.ok(!nodes.has(entity('Word').id), 'closed fact is not followed');

    const one = g.walk(seeds, { depth: 1 });
    assert.ok(!one.nodes.has(entity('PDF').id), 'PDF is two steps away');
    assert.ok(g.walk(seeds, { depth: 2, history: true }).nodes.has(entity('Word').id), 'history walk includes Word');

    const reachedNotes = new Set(g.notesMentioning(nodes.keys()).map((m) => m.note_id));
    assert.ok(reachedNotes.has(notes[2]), 'the EU finding (#3) is reached without mentioning Acme');
    s.close();
  });

  test('path explains how two things connect', async () => {
    const s = await sqlite();
    const g = s.graph;
    const { entity } = writeStory(s);
    const p = g.path(entity('Acme').id, entity('PDF').id);
    assert.deepEqual(p.entities.map((e) => e.name), ['Acme', 'Priya', 'PDF']);
    assert.deepEqual(p.steps.map((x) => [x.type, x.forward]), [['works at', false], ['prefers format', true]]);
    assert.equal(g.path(entity('Acme').id, entity('Word').id), null, 'no current path to Word');
    assert.equal(g.path(entity('Acme').id, entity('Word').id, { history: true }).steps.length, 2);
    s.close();
  });

  test('search finds entities by name or alias, and facts by text', async () => {
    const s = await sqlite();
    const g = s.graph;
    writeStory(s);
    assert.equal(g.searchEntities('acme corp', { project: PROJECT })[0].name, 'Acme');
    assert.equal(g.searchEntities('legal', { project: PROJECT })[0].name, 'Legal review');
    assert.equal(g.searchEntities('acme', { project: 'other' }).length, 0, 'project filter');
    const eu = g.searchFacts('EU sales', { project: PROJECT });
    assert.equal(eu[0].dst_name, 'EU region');
    assert.deepEqual(g.searchFacts('prefers format', { project: PROJECT }).map((f) => f.dst_name), ['PDF']);
    assert.equal(g.searchFacts('prefers format', { project: PROJECT, history: true }).length, 2);
    s.close();
  });

  test('repeated facts are refreshed, not duplicated; out-of-order facts become history', async () => {
    const s = await sqlite();
    const g = s.graph;
    const { entity } = writeStory(s);
    const report = entity('Q3 report').id;
    const xlsx = entity('sales-2026.xlsx').id;
    const again = g.addFact({ project: PROJECT, src: report, dst: xlsx, type: 'uses', confidence: 'STATED', at: DAY(14) });
    assert.equal(again.created, false);
    assert.equal(g.getFact(again.id).confidence, 'STATED', 'confidence upgraded');

    const priya = entity('Priya').id;
    const { entity: excel } = g.upsertEntity({ project: PROJECT, kind: 'format', name: 'Excel', at: DAY(5) });
    const old = g.addFact({ project: PROJECT, src: priya, dst: excel.id, type: 'prefers format', at: DAY(5), single: true });
    assert.equal(old.historical, true);
    const row = g.getFact(old.id);
    assert.equal(row.valid_to, DAY(7), 'ends when the Word preference started');
    assert.equal(g.factsFor(priya).filter((f) => f.type === 'prefers format').map((f) => f.dst_name).join(), 'PDF');
    assert.equal(g.addFact({ project: PROJECT, src: priya, dst: priya, type: 'is' }), null, 'no self-loops');
    s.close();
  });

  test('merging two entities moves facts, mentions and names', async () => {
    const s = await sqlite();
    const g = s.graph;
    const p = 'db-project';
    const app = g.upsertEntity({ project: p, kind: 'project', name: 'Billing app' }).entity;
    const pg = g.upsertEntity({ project: p, kind: 'tool', name: 'Postgres' }).entity;
    const pg2 = g.upsertEntity({ project: p, kind: 'tool', name: 'PostgreSQL' }).entity;
    g.addFact({ project: p, src: app.id, dst: pg.id, type: 'uses', confidence: 'INFERRED', at: 1000 });
    g.addFact({ project: p, src: app.id, dst: pg2.id, type: 'uses', confidence: 'STATED', at: 2000 });
    g.addMention(pg2.id, 'observation', 42);
    const merged = g.mergeEntities(pg.id, pg2.id);
    assert.deepEqual(merged.aliases, ['PostgreSQL']);
    assert.equal(merged.mention_count, 1);
    assert.equal(g.getEntity(pg2.id), null);
    const uses = g.factsFor(app.id);
    assert.equal(uses.length, 1, 'duplicate facts collapsed');
    assert.equal(uses[0].confidence, 'STATED');
    assert.equal(uses[0].valid_from, 1000);
    assert.equal(g.findEntity({ project: p, name: 'postgresql' }).id, pg.id);

    const renamed = g.updateEntity(pg.id, { name: 'PostgreSQL 16' });
    assert.ok(renamed.aliases.includes('Postgres'));
    assert.equal(g.deleteEntity(pg.id), 1);
    assert.equal(g.factsFor(app.id).length, 0, 'facts go with the entity');
    s.close();
  });

  test('notes index their files; edits and deletes keep mentions in step', async () => {
    const s = await sqlite();
    const g = s.graph;
    const id = s.addObservation({
      session_id: 'a', project: 'web', title: 'Fixed auth',
      files_read: ['src/auth.ts', 'README.md'], files_modified: ['src\\auth.ts'], concepts: ['gotcha'],
    });
    const m = g.mentionsOf('observation', id);
    assert.deepEqual(m.map((x) => [x.kind, x.name, x.role]).sort(), [
      ['file', 'README.md', 'read'], ['file', 'src\\auth.ts', 'modified'],
    ], 'concept tags are not entities');
    const auth = g.findEntity({ project: 'web', name: 'src/auth.ts' });
    assert.equal(auth.kind, 'file');

    s.updateObservation(id, { files_read: ['README.md'], files_modified: ['src/login.ts'] });
    assert.deepEqual(g.mentionsOf('observation', id).map((x) => x.name).sort(), ['README.md', 'src/login.ts']);
    assert.equal(g.getEntity(auth.id).mention_count, 0);

    s.addObservation({ session_id: 'b', project: 'web', title: 'Other', files_read: ['README.md'] });
    assert.equal(g.findEntity({ project: 'web', name: 'README.md' }).mention_count, 2);
    s.deleteObservation(id);
    assert.equal(g.mentionsOf('observation', id).length, 0);
    assert.equal(s.deleteSession('b'), 0, 'no session row, but its notes are gone');
    assert.equal(g.findEntity({ project: 'web', name: 'README.md' }).mention_count, 0);
    s.close();
  });

  test('json storage has no graph', async () => {
    const s = await openStore(tmpDir(), { backend: 'json' });
    assert.equal(s.graph, null);
    s.close();
  });
});

describe('graph CLI', () => {
  test('entity, walk, path and status print the story', async () => {
    const dir = tmpDir();
    const s = await sqlite(dir);
    writeStory(s);
    s.close();
    const env = { CLAUDE_MEM_LOCAL_DATA_DIR: dir };
    const run = async (...args) => {
      const r = await runCli(['graph', ...args, '--project', PROJECT], { env });
      assert.equal(r.code, 0, r.stderr);
      return r.stdout;
    };
    const entityOut = await run('entity', 'Priya', '--history');
    assert.match(entityOut, /Priya —prefers format→ PDF {2}STATED {2}2026-10-13/);
    assert.match(entityOut, /✗ Priya —prefers format→ Word .* → 2026-10-13/);
    assert.match(entityOut, /#\d+ Priya wants the report as a Word file/);
    assert.match(await run('path', 'Acme', 'PDF'), /2 steps:\n {2}Priya —works at→ Acme[\s\S]*Priya —prefers format→ PDF/);
    const walk = await run('walk', 'Acme Corp');
    assert.match(walk, /Start: Acme \(organisation\)/);
    assert.match(walk, /2 steps:[\s\S]*PDF \(format\)/);
    assert.doesNotMatch(walk, /Word/);
    assert.match(await run('status'), /8 entities, 7 current facts, 1 past facts/);
    const doctor = await runCli(['doctor'], { env });
    assert.match(doctor.stdout, /✔ Graph: 8 entities, 7 current facts, 1 past facts \(schema v5\)/);
  });
});

describe('database upgrade', () => {
  test('a version-1 database is backed up, upgraded and back-filled', async () => {
    const dir = tmpDir();
    const a = await sqlite(dir);
    const obsId = a.addObservation({ session_id: 's', project: 'old', title: 'Old note', files_modified: ['lib/a.js'], concepts: ['caching'] });
    a.addPrompt({ session_id: 's', project: 'old', prompt_number: 1, text: 'keep me' });
    // Turn it back into a pre-graph (v1) database.
    a.db.exec(`DROP TABLE entities; DROP TABLE entity_aliases; DROP TABLE relations; DROP TABLE mentions;
               DROP TABLE entities_fts; DROP TABLE facts_fts; DROP TABLE review_queue;
               DROP TABLE feedback; DROP TABLE graph_snapshots; DROP TABLE work_state; DROP TABLE corpora; DROP TABLE embeddings;
               DELETE FROM meta WHERE key = 'graph_backfill_observation';
               UPDATE meta SET value = '1' WHERE key = 'schema_version';`);
    a.close();

    const b = await sqlite(dir);
    assert.equal(b.schemaVersion, SCHEMA_VERSION);
    assert.ok(b.backupFile && fs.existsSync(b.backupFile), 'backup written before upgrading');
    assert.match(path.basename(b.backupFile), /^memory-v1-/);
    assert.equal(b.getObservation(obsId).title, 'Old note', 'old notes intact');
    assert.equal(b.recentPrompts({ project: 'old' })[0].text, 'keep me');
    assert.deepEqual(b.graph.mentionsOf('observation', obsId).map((m) => m.name), ['lib/a.js'], 'back-filled');
    assert.equal(b.stats('old').graph.entities, 1);
    assert.equal(b.graph.backfill(), 0, 'nothing left to back-fill');
    b.close();

    const c = await sqlite(dir);
    assert.equal(c.backupFile, null, 'no second backup once upgraded');
    assert.equal(c.graph.stats('old').entities, 1);
    c.close();

    const { DatabaseSync } = await import('node:sqlite');
    const bak = new DatabaseSync(fs.readdirSync(path.join(dir, 'backups')).map((f) => path.join(dir, 'backups', f))[0]);
    assert.equal(bak.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1', 'backup is the old version');
    assert.equal(bak.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
    bak.close();
  });

  test('a new database starts at the latest version with no backup', async () => {
    const s = await sqlite();
    assert.equal(s.schemaVersion, SCHEMA_VERSION);
    assert.equal(s.backupFile, null);
    assert.equal(s.stats().graph.entities, 0);
    s.close();
  });
});
