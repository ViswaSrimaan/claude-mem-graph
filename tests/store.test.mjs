import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../plugin/lib/store/index.mjs';
import { tmpDir } from './helpers.mjs';

for (const backend of ['sqlite', 'json']) {
  describe(`${backend} store`, () => {
    test('sessions, prompts and prompt numbering', async () => {
      const s = await openStore(tmpDir(), { backend });
      assert.equal(s.kind, backend);
      s.upsertSession({ session_id: 'a', project: 'p1', cwd: '/x' });
      assert.equal(s.nextPromptNumber('a'), 1);
      assert.equal(s.nextPromptNumber('a'), 2);
      s.addPrompt({ session_id: 'a', project: 'p1', prompt_number: 2, text: 'second prompt' });
      assert.equal(s.getPrompt('a', 2).text, 'second prompt');
      s.endSession('a');
      assert.equal(s.getSession('a').status, 'ended');
      s.upsertSession({ session_id: 'a', project: 'p1' });
      assert.equal(s.getSession('a').status, 'active');
      assert.equal(s.listSessions({ project: 'p1' })[0].first_prompt, 'second prompt');
      s.close();
    });

    test('event queue claim / finish / release / stale reset', async () => {
      const s = await openStore(tmpDir(), { backend });
      s.upsertSession({ session_id: 'a', project: 'p' });
      for (let i = 0; i < 3; i++) s.addEvent({ session_id: 'a', project: 'p', tool_name: 'Read', tool_input: `{"i":${i}}` });
      s.addEvent({ session_id: 'b', project: 'p', tool_name: 'Read' });
      assert.equal(s.countPendingEvents('a'), 3);
      assert.deepEqual(s.pendingSessions().map((x) => x.session_id).sort(), ['a', 'b']);
      const claimed = s.claimEvents('a');
      assert.equal(claimed.length, 3);
      assert.deepEqual(claimed.map((e) => e.tool_input), ['{"i":0}', '{"i":1}', '{"i":2}']);
      assert.equal(s.claimEvents('a').length, 0, 'claimed events are not handed out twice');
      s.releaseEvents([claimed[0].id]);
      s.finishEvents([claimed[1].id]);
      assert.equal(s.claimEvents('a').length, 1);
      assert.equal(s.resetStaleEvents(0), 2);
      assert.equal(s.claimEvents('a').length, 2);
      s.close();
    });

    test('observations: add, search, filters, timeline, delete', async () => {
      const s = await openStore(tmpDir(), { backend });
      const base = Date.now() - 10000;
      const ids = [
        s.addObservation({ session_id: 'a', project: 'web', type: 'bugfix', title: 'Fixed token refresh race in auth middleware', narrative: 'Two requests refreshed the JWT at once.', facts: ['refresh is now single-flight'], files_modified: ['src/auth.ts'], created_at: base }),
        s.addObservation({ session_id: 'a', project: 'web', type: 'decision', title: 'Chose SQLite over Postgres for local cache', narrative: 'Zero setup.', created_at: base + 1000 }),
        s.addObservation({ session_id: 'b', project: 'api', type: 'feature', title: 'Added rate limiting to the API gateway', narrative: 'Token bucket per client.', created_at: base + 2000 }),
      ];
      assert.equal(s.getObservation(ids[0]).facts[0], 'refresh is now single-flight');
      assert.equal(s.search({ query: 'refresh', project: 'web' })[0].id, ids[0]);
      assert.equal(s.search({ query: 'refreshing tokens', project: 'web' })[0].id, ids[0], 'stemming/prefix');
      assert.equal(s.search({ query: 'auth.ts' })[0].id, ids[0], 'file names are searchable');
      assert.equal(s.search({ query: 'token', project: 'api' })[0].id, ids[2]);
      assert.equal(s.search({ query: 'token', project: '*' }).length, 2);
      assert.equal(s.search({ query: 'token', type: 'feature' })[0].id, ids[2]);
      assert.equal(s.search({ query: 'sqlite postgres nonexistentword' }).length, 1, 'falls back to OR');
      assert.equal(s.search({ query: 'zzzz' }).length, 0);
      assert.equal(s.search({ query: '', project: 'web' }).length, 2, 'empty query lists recent');
      assert.equal(s.search({ query: 'token', excludeSession: 'a' })[0].id, ids[2]);
      const t = s.timelineAround({ id: ids[1], before: 5, after: 5 });
      assert.deepEqual(t.observations.map((o) => o.id), [ids[0], ids[1]]);
      assert.deepEqual(s.getObservations([ids[2], ids[0], 999]).map((o) => o.id), [ids[2], ids[0]]);
      s.updateObservation(ids[1], { title: 'Chose SQLite (FTS5) for local cache' });
      assert.equal(s.search({ query: 'fts5' })[0].id, ids[1], 'updates are re-indexed');
      assert.equal(s.deleteObservation(ids[0]), 1);
      assert.equal(s.search({ query: 'refresh middleware', project: 'web' }).length, 0, 'deleted rows leave the index');
      s.close();
    });

    test('summaries and prompts are searchable', async () => {
      const s = await openStore(tmpDir(), { backend });
      s.addSummary({ session_id: 'a', project: 'p', request: 'Migrate the build to esbuild', completed: 'Build time down to 2s' });
      s.addPrompt({ session_id: 'a', project: 'p', prompt_number: 1, text: 'why is the webpack build so slow' });
      assert.equal(s.search({ query: 'esbuild', kind: 'summaries' }).length, 1);
      assert.equal(s.search({ query: 'webpack', kind: 'prompts' }).length, 1);
      s.close();
    });

    test('stats, projects, export and idempotent import', async () => {
      const a = await openStore(tmpDir(), { backend });
      a.upsertSession({ session_id: 's', project: 'p' });
      a.addPrompt({ session_id: 's', project: 'p', prompt_number: 1, text: 'hi' });
      a.addObservation({ session_id: 's', project: 'p', title: 'One', created_at: 1000 });
      a.addSummary({ session_id: 's', project: 'p', request: 'r', created_at: 2000 });
      assert.equal(a.stats().observations, 1);
      assert.equal(a.listProjects()[0].project, 'p');
      const dump = a.exportAll();
      a.close();
      for (const target of ['sqlite', 'json']) {
        const b = await openStore(tmpDir(), { backend: target });
        const { graph, ...counts } = b.importAll(dump);
        assert.deepEqual(counts, { sessions: 1, prompts: 1, observations: 1, summaries: 1, skipped: 0 });
        assert.equal(b.importAll(dump).skipped, 3, 'second import skips duplicates');
        assert.equal(b.stats().observations, 1);
        assert.equal(b.search({ query: 'one' }).length, 1);
        b.close();
      }
    });

    test('deleteSession removes everything for it', async () => {
      const s = await openStore(tmpDir(), { backend });
      s.upsertSession({ session_id: 'x', project: 'p' });
      s.addObservation({ session_id: 'x', project: 'p', title: 'gone' });
      s.addEvent({ session_id: 'x', project: 'p', tool_name: 'Read' });
      assert.equal(s.deleteSession('x'), 1);
      assert.equal(s.stats().observations, 0);
      assert.equal(s.countPendingEvents(), 0);
      s.close();
    });
  });
}
