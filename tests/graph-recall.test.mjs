import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../plugin/lib/store/index.mjs';
import { recall } from '../plugin/lib/graph/recall.mjs';
import { callTool } from '../plugin/lib/mcp.mjs';
import { buildSessionContext, buildRecallContext, buildAgentContext } from '../plugin/lib/context.mjs';
import { tmpDir, baseSettings } from './helpers.mjs';
import { PROJECT, DAY, writeStory } from './fixtures/story.mjs';

const QUESTION = "What format does Acme want for the report, and what's still open?";

describe('hybrid recall on the walkthrough story', () => {
  let s;
  let notes;
  let settings;
  const tool = (name, args) => callTool(s, settings, name, { project: PROJECT, ...args });

  before(async () => {
    const dir = tmpDir();
    s = await openStore(dir, { backend: 'sqlite' });
    settings = { ...baseSettings(dir), mode: 'general' };
    ({ notes } = writeStory(s));
  });
  after(() => s.close());

  test('the current answer comes first, the old one only as history', () => {
    const r = recall(s, { query: QUESTION, project: PROJECT, now: DAY(20) });
    const pdf = r.facts.find((f) => f.type === 'prefers format');
    assert.equal(pdf.dst_name, 'PDF');
    assert.deepEqual(pdf.previous.map((p) => p.dst_name), ['Word']);
    assert.ok(!r.facts.some((f) => f.dst_name === 'Word'), 'no current Word fact');
    assert.ok(r.facts.slice(0, 3).some((f) => f.dst_name === 'PDF'), 'PDF preference ranks near the top');
    assert.ok(r.facts.some((f) => f.dst_name === 'Legal review'), 'open task is connected');
  });

  test('the graph finds a note text search misses', () => {
    const textOnly = s.search({ query: QUESTION, project: PROJECT, limit: 30 }).map((o) => o.id);
    assert.ok(!textOnly.includes(notes[2]), 'text search alone misses the EU finding');
    const r = recall(s, { query: QUESTION, project: PROJECT, now: DAY(20) });
    const eu = r.notes.find((o) => o.id === notes[2]);
    assert.ok(eu, 'EU finding is recalled');
    assert.deepEqual(eu.found_by, ['graph']);
    assert.equal(eu.via, 'Q3 report');
    const both = r.notes.find((o) => o.id === notes[3]);
    assert.deepEqual(both.found_by.sort(), ['graph', 'text'], 'found both ways ranks high');
    assert.equal(r.notes[0].found_by.length, 2);
    const word = r.notes.find((o) => o.id === notes[1]);
    assert.equal(word.outdated, true, 'the Word note is marked outdated');
    assert.ok(r.notes.indexOf(word) > r.notes.indexOf(both), 'and ranks below the note that replaced it');
  });

  test('filters still apply to graph-found notes', () => {
    assert.ok(recall(s, { query: QUESTION, project: 'other' }).notes.length === 0);
    const onlyFindings = recall(s, { query: QUESTION, project: PROJECT, type: 'finding' }).notes;
    assert.deepEqual(onlyFindings.map((o) => o.id), [notes[2]]);
    assert.ok(!recall(s, { query: QUESTION, project: PROJECT, excludeSession: 'story' }).notes.length);
  });

  test('search tool shows how each note was found and the connected facts', async () => {
    const out = await tool('search', { query: QUESTION });
    assert.match(out, new RegExp(`#${notes[2]} .*EU sales fell 12%.*← via Q3 report`));
    assert.match(out, new RegExp(`#${notes[1]} .*Word file.*\\(outdated: its facts were replaced later\\)`));
    assert.match(out, /Connected facts:\n(- .*\n)*- Priya —prefers format→ PDF \(stated, since 2026-10-13; replaced Word\)/);
    assert.match(out, /entity\(name\) for everything about one thing/);
  });

  test('entity tool: facts, replaced values, aliases and notes', async () => {
    const acme = await tool('entity', { name: 'Acme Corp' });
    assert.match(acme, /Acme \(organisation\) #\d+ in "acme-report" · also called: Acme Corp/);
    assert.match(acme, /- Priya —works at→ Acme \(stated/);
    assert.match(acme, /Notes:\n- #\d+ /);
    const priya = await tool('entity', { name: 'priya' });
    assert.match(priya, /Priya —prefers format→ PDF \(stated, since 2026-10-13; replaced Word\)/);
    assert.match(priya, /Past facts: 1 \(pass history=true/);
    assert.match(await tool('entity', { name: 'Priya', history: true }), /Past facts:\n- Priya —prefers format→ Word \(stated, 2026-10-07 → 2026-10-13\)/);
    assert.match(await tool('entity', { name: 'nobody' }), /No entity matching "nobody"/);
  });

  test('path, related and facts tools', async () => {
    assert.match(await tool('path', { from: 'Acme', to: 'PDF' }), /Acme → PDF in 2 steps:\n- Priya —works at→ Acme .*\n- Priya —prefers format→ PDF/);
    assert.match(await tool('path', { from: 'Acme', to: 'Word' }), /No connection .*try history=true/);
    assert.match(await tool('path', { from: 'Acme', to: 'Word', history: true }), /in 2 steps/);

    const rel = await tool('related', { name: 'Acme' });
    assert.match(rel, /1 step:\n(- .*\n)*- Priya \(person\)  via Priya —works at→ Acme/);
    assert.match(rel, /2 steps:\n(- .*\n)*- PDF \(format\)/);
    assert.doesNotMatch(rel.split('Notes involved:')[0], /Word/, 'closed fact not followed');
    assert.match(rel, /Notes involved:/);
    assert.match(await tool('related', { anchor_id: notes[2], depth: 1 }), /Connected to note #\d+:\n1 step:/);

    assert.match(await tool('facts', { subject: 'Priya', type: 'prefers_format', history: true }), /2 facts about Priya:\n- Priya —prefers format→ PDF[^\n]*\n- Priya —prefers format→ Word/);
    assert.match(await tool('facts', { query: 'EU sales' }), /Q3 report —covers→ EU region \(inferred, since 2026-10-08\) — EU sales fell 12%/);
    assert.match(await tool('facts', {}), /current facts newest first/);
  });

  test('session start shows key facts and open work', () => {
    const text = buildSessionContext(s, settings, { project: PROJECT, now: DAY(20) });
    assert.match(text, /## Key facts\n(- .*\n)*- Priya —prefers format→ PDF \(stated, since 2026-10-13; replaced Word\)/);
    assert.match(text, /## Open work\n- \[todo\] Legal review — Q3 report —needs→ Legal review/);
    assert.doesNotMatch(text, /—prefers format→ Word/);
    assert.match(text, /entity\(name\) for everything about one thing/);
    const off = buildSessionContext(s, { ...settings, context: { ...settings.context, graph: false } }, { project: PROJECT });
    assert.doesNotMatch(off, /## Key facts/);
    const tiny = buildSessionContext(s, { ...settings, context: { ...settings.context, graphChars: 120 } }, { project: PROJECT });
    const block = tiny.split('## Key facts')[1]?.split('\n\n')[0] || '';
    assert.ok(block.length <= 120, 'graph block keeps to its own budget');
  });

  test('prompt recall adds facts about what the prompt names, and stays quiet otherwise', () => {
    const r = buildRecallContext(s, settings, { project: PROJECT, query: 'Can I send Priya the Word version?', limit: 3, heading: 'H:' });
    assert.match(r, /^H:/);
    assert.match(r, /Known facts:\n(- .*\n)*- Priya —prefers format→ PDF \(stated, since 2026-10-13; replaced Word\)/);
    assert.equal(buildRecallContext(s, settings, { project: PROJECT, query: 'quantum chromodynamics lecture notes', limit: 3, heading: 'H:' }), '');
  });

  test('subagents get the connected facts too', () => {
    const block = buildAgentContext(s, settings, { project: PROJECT, query: 'Prepare the final Acme report for sending', limit: 5 });
    assert.match(block, /<prior-project-memory/);
    assert.match(block, /Known facts:/);
    assert.match(block, /Q3 report —for→ Acme/);
  });
});

describe('without the graph', () => {
  test('JSON storage keeps plain search and says the graph is off', async () => {
    const dir = tmpDir();
    const s = await openStore(dir, { backend: 'json' });
    const settings = baseSettings(dir);
    s.addObservation({ session_id: 'a', project: 'p', title: 'Prefer pnpm over npm' });
    assert.match(await callTool(s, settings, 'search', { query: 'pnpm', project: 'p' }), /Prefer pnpm/);
    assert.match(await callTool(s, settings, 'entity', { name: 'pnpm', project: 'p' }), /needs the SQLite store/);
    assert.equal(recall(s, { query: 'pnpm', project: 'p' }).notes.length, 1);
    s.close();
  });
});
