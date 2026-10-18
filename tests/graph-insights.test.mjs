import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../plugin/lib/store/index.mjs';
import { loadMode } from '../plugin/lib/modes.mjs';
import { ingestNote } from '../plugin/lib/graph/ingest.mjs';
import { louvain, cohesion, analyzeGraph, loadGraph, themes } from '../plugin/lib/graph/analyze.mjs';
import { recall } from '../plugin/lib/graph/recall.mjs';
import { callTool } from '../plugin/lib/mcp.mjs';
import { buildSessionContext } from '../plugin/lib/context.mjs';
import { tmpDir, baseSettings } from './helpers.mjs';
import { PROJECT, DAY, TURNS, writeStory } from './fixtures/story.mjs';

const general = loadMode('general');
const sqlite = () => openStore(tmpDir(), { backend: 'sqlite' });

// A second, separate piece of work in the same project, joined to the
// report work by one inferred fact.
const WEBSITE = [
  { at: DAY(9), note: { type: 'task', title: 'Website redesign kicked off with Marco' },
    entities: [{ name: 'Website redesign', kind: 'project' }, { name: 'Marco', kind: 'person' }, { name: 'Figma', kind: 'tool' }, { name: 'Homepage', kind: 'document' }],
    facts: [
      { src: 'Marco', type: 'works on', dst: 'Website redesign', confidence: 'STATED' },
      { src: 'Website redesign', type: 'uses', dst: 'Figma', confidence: 'STATED' },
      { src: 'Homepage', type: 'part of', dst: 'Website redesign', confidence: 'STATED' },
      { src: 'Marco', type: 'owned by', dst: 'Homepage', confidence: 'STATED' },
      { src: 'Homepage', type: 'uses', dst: 'Figma', confidence: 'STATED' },
    ] },
  { at: DAY(10), note: { type: 'finding', title: 'Priya may review the homepage copy' },
    entities: [{ name: 'Priya', kind: 'person' }, { name: 'Homepage', kind: 'document' }],
    facts: [{ src: 'Priya', type: 'reviews', dst: 'Homepage', confidence: 'INFERRED' }] },
];

function write(store, turns) {
  const ids = [];
  for (const t of turns) {
    const noteId = store.addObservation({ session_id: t.session || 'story', project: PROJECT, ...t.note, created_at: t.at });
    ingestNote(store.graph, general, { project: PROJECT, noteId, at: t.at, entities: t.entities, relations: t.facts });
    ids.push(noteId);
  }
  return ids;
}

describe('communities', () => {
  test('louvain separates two groups joined by one link, the same way every time', () => {
    const edges = [];
    const clique = (ids) => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) edges.push({ a: ids[i], b: ids[j], w: 1 }); };
    clique([1, 2, 3, 4]);
    clique([5, 6, 7, 8]);
    edges.push({ a: 4, b: 5, w: 0.3 });
    const r = louvain([8, 7, 6, 5, 4, 3, 2, 1], edges);
    assert.equal(new Set([1, 2, 3, 4].map((i) => r.get(i))).size, 1);
    assert.equal(new Set([5, 6, 7, 8].map((i) => r.get(i))).size, 1);
    assert.notEqual(r.get(1), r.get(8));
    assert.deepEqual([...louvain([1, 2, 3, 4, 5, 6, 7, 8], [...edges].reverse())], [...r].sort((a, b) => a[0] - b[0]), 'order does not matter');
    assert.equal(louvain([1, 2], []).size, 2, 'no edges: everyone alone');
    assert.equal(cohesion([1, 2, 3, 4], edges), 1);
    assert.equal(cohesion([4, 5], edges), 1);
    assert.ok(cohesion([1, 2, 5, 6], edges) < 0.5);
  });

  test('themes are named after their hub and keep their ids between runs', async () => {
    const s = await sqlite();
    writeStory(s);
    write(s, WEBSITE);
    const a = analyzeGraph(s.graph, PROJECT);
    assert.equal(a.themes.length, 2);
    const labels = a.themes.map((t) => t.label).sort();
    assert.deepEqual(labels, ['Q3 report', 'Website redesign']);
    assert.ok(a.themes.every((t) => t.cohesion > 0 && t.cohesion <= 1));
    assert.deepEqual(JSON.stringify(analyzeGraph(s.graph, PROJECT).themes), JSON.stringify(a.themes), 'deterministic');

    // The website theme grows; its id survives, and a re-run against the
    // previous themes keeps both ids.
    const previous = a.themes.map((t) => ({ id: t.id, label: t.label, members: t.members }));
    write(s, [{ at: DAY(11), note: { type: 'task', title: 'Marco adds a pricing page' },
      entities: [{ name: 'Pricing page', kind: 'document' }, { name: 'Website redesign', kind: 'project' }],
      facts: [{ src: 'Pricing page', type: 'part of', dst: 'Website redesign', confidence: 'STATED' }] }]);
    const b = themes(loadGraph(s.graph, PROJECT), { previous });
    const id = (list, label) => list.find((t) => t.label === label).id;
    assert.equal(id(b, 'Website redesign'), id(a.themes, 'Website redesign'));
    assert.equal(id(b, 'Q3 report'), id(a.themes, 'Q3 report'));
    assert.equal(b.find((t) => t.label === 'Website redesign').size, 5);
    s.close();
  });

  test('key entities, unexpected links and open questions', async () => {
    const s = await sqlite();
    writeStory(s);
    write(s, WEBSITE);
    // A task nobody mentioned for weeks, and a thing mentioned twice with no facts.
    write(s, [
      { at: DAY(1), note: { type: 'task', title: 'Book the venue' }, entities: [{ name: 'Book the venue', kind: 'task', status: 'todo' }], facts: [] },
      { at: DAY(2), note: { type: 'finding', title: 'Budget spreadsheet found' }, entities: [{ name: 'Budget', kind: 'topic' }], facts: [] },
      { at: DAY(3), note: { type: 'finding', title: 'Budget is tight' }, entities: [{ name: 'Budget', kind: 'topic' }], facts: [] },
    ]);
    s.graph.addReview({ project: PROJECT, kind: 'fact-check', a: 1, reason: 'x' });
    const a = analyzeGraph(s.graph, PROJECT, { now: DAY(25) });
    assert.ok(['Priya', 'Q3 report'].includes(a.keyEntities[0].name), `top is ${a.keyEntities[0].name}`);
    assert.ok(!a.keyEntities.some((e) => e.kind === 'file'));
    const link = a.unexpected[0];
    assert.equal(`${link.fact.src_name} ${link.fact.type} ${link.fact.dst_name}`, 'Priya reviews Homepage');
    assert.match(link.reasons.join('; '), /links themes .*inferred, not stated directly/);
    const qs = a.questions.map((q) => q.question).join('\n');
    assert.match(qs, /Is "Book the venue" still to do\? Not mentioned for 24 days/);
    assert.match(qs, /How does "Budget" relate to the rest\? Mentioned in 2 notes/);
    assert.match(qs, /1 item waiting in review/);
    assert.ok(!/Legal review/.test(qs), 'a recent task is not stale');
    s.close();
  });
});

describe('feedback and lessons', () => {
  test('dead ends sink, useful notes rise, corrections become memories', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = { ...baseSettings(dir), mode: 'general' };
    const { notes } = writeStory(s);
    const q = 'Acme report';
    const rank = (id) => recall(s, { query: q, project: PROJECT, now: DAY(20) }).notes.findIndex((o) => o.id === id);
    const before = rank(notes[0]);
    assert.equal(before, 0, 'note #1 starts on top');

    const out = await callTool(s, settings, 'memory_feedback', { ids: [notes[0]], outcome: 'dead_end', project: PROJECT });
    assert.match(out, new RegExp(`Recorded "dead end" for #${notes[0]}`));
    assert.ok(rank(notes[0]) > before, 'dead end ranks lower');
    const hit = recall(s, { query: q, project: PROJECT, now: DAY(20) }).notes.find((o) => o.id === notes[0]);
    assert.equal(hit.lesson, 'marked dead end');

    for (let i = 0; i < 2; i++) s.graph.addFeedback({ project: PROJECT, target_id: notes[2], outcome: 'useful' });
    assert.equal(recall(s, { query: 'EU sales', project: PROJECT }).notes[0].lesson, 'useful ×2');

    const fixed = await callTool(s, settings, 'memory_feedback', { ids: [notes[1]], outcome: 'corrected', correction: 'Priya never wanted Word; that was Marco', project: PROJECT });
    assert.match(fixed, /Saved the correction as #\d+/);
    assert.match(await callTool(s, settings, 'search', { query: 'Marco Word', project: PROJECT }), /Correction to #\d+: Priya never wanted Word/);

    const lessons = s.graph.lessons(PROJECT);
    assert.deepEqual(lessons.deadEnds.map((l) => l.note.id), [notes[0]]);
    assert.equal(lessons.corrections[0].correction, 'Priya never wanted Word; that was Marco');
    assert.deepEqual(lessons.proven.map((l) => l.note.id), [notes[2]]);

    const text = buildSessionContext(s, settings, { project: PROJECT });
    assert.match(text, /## Lessons\n- Corrected: #\d+ Priya wants the report as a Word file → Priya never wanted Word; that was Marco\n- Dead end: #\d+ Started Q3 report/);
    assert.match(text, /- Proven useful: #\d+ EU sales fell 12% in Q3 .*\(2×\)/);
    await assert.rejects(() => callTool(s, settings, 'memory_feedback', { ids: [notes[0]], outcome: 'great' }), /outcome must be one of/);
    s.close();
  });
});

describe('since last session', () => {
  test('session start compares with the previous session and records its own snapshot', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = { ...baseSettings(dir), mode: 'general' };
    write(s, TURNS.slice(0, 3).map((t) => ({ ...t, facts: t.facts })));

    const first = buildSessionContext(s, settings, { project: PROJECT, session_id: 's1', now: DAY(9) });
    assert.doesNotMatch(first, /Since last session/, 'nothing to compare with yet');
    assert.ok(s.graph.hasSnapshot(PROJECT, 's1'));

    write(s, [TURNS[3], ...WEBSITE].map((t) => ({ ...t, at: Math.max(t.at, DAY(13)) })));
    const second = buildSessionContext(s, settings, { project: PROJECT, session_id: 's2', now: DAY(14) });
    const block = second.split('## Since last session')[1].split('\n## ')[0];
    assert.match(block, /^ \(2026-10-09 \d\d:\d\d\)/);
    assert.match(block, /- New: .*(Marco|Website redesign|PDF|Legal review).*\+\d+ more/);
    assert.match(block, /- \d+ new facts, e\.g\. /);
    assert.match(block, /- Changed: Priya prefers format: Word → PDF/);
    assert.match(block, /- New theme: Website redesign \(\d\)/);
    assert.match(second, /Themes: .*Q3 report \(\d+\).*graph_overview\(\) for more/);

    const resumed = buildSessionContext(s, settings, { project: PROJECT, session_id: 's2', now: DAY(15) });
    assert.match(resumed, /Since last session \(2026-10-09/, 'a resumed session still compares with s1');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM graph_snapshots WHERE session_id = 's2'").get().n, 1);
    assert.doesNotMatch(buildSessionContext(s, settings, { project: PROJECT }), /Since last session \(2026-10-09/, 'without a session id it compares with the latest snapshot');
    s.close();
  });
});

describe('overview tool', () => {
  test('graph_overview summarises the project', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'sqlite' });
    const settings = { ...baseSettings(dir), mode: 'general' };
    writeStory(s);
    write(s, WEBSITE);
    const out = await callTool(s, settings, 'graph_overview', { project: PROJECT });
    assert.match(out, /Knowledge graph for "acme-report": \d+ entities, \d+ current facts, 1 past facts, 2 themes\./);
    assert.match(out, /Key entities:\n- (Priya|Q3 report) \(/);
    assert.match(out, /Themes:\n- t\d "(Q3 report|Website redesign)" · \d+ things · cohesion /);
    assert.match(out, /Unexpected links:\n- Priya —reviews→ Homepage \(inferred/);
    assert.match(await callTool(s, settings, 'graph_overview', { project: 'empty' }), /No knowledge graph yet/);
    s.close();
  });
});
