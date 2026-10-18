// The walkthrough story (Q3 report for Acme), as data. Later phases feed the
// same turns through the observer; here they are written straight to the graph.

export const PROJECT = 'acme-report';
export const DAY = (d) => Date.UTC(2026, 9, d, 9);
export const SINGLE = new Set(['prefers format']);

export const TURNS = [
  {
    at: DAY(6),
    note: { type: 'task', title: 'Started Q3 report for Acme; contact is Priya' },
    entities: [
      { name: 'Acme', kind: 'organisation' },
      { name: 'Priya', kind: 'person' },
      { name: 'Q3 report', kind: 'document' },
    ],
    facts: [
      { src: 'Q3 report', type: 'for', dst: 'Acme', confidence: 'STATED' },
      { src: 'Priya', type: 'works at', dst: 'Acme', confidence: 'STATED' },
      { src: 'Priya', type: 'contact for', dst: 'Q3 report', confidence: 'STATED' },
    ],
  },
  {
    at: DAY(7),
    note: { type: 'preference', title: 'Priya wants the report as a Word file' },
    entities: [{ name: 'Priya', kind: 'person' }, { name: 'Word', kind: 'format' }],
    facts: [{ src: 'Priya', type: 'prefers format', dst: 'Word', confidence: 'STATED' }],
  },
  {
    at: DAY(8),
    note: { type: 'finding', title: 'EU sales fell 12% in Q3 (from sales-2026.xlsx)' },
    entities: [
      { name: 'Q3 report', kind: 'document' },
      { name: 'sales-2026.xlsx', kind: 'document' },
      { name: 'EU region', kind: 'topic' },
    ],
    facts: [
      { src: 'Q3 report', type: 'uses', dst: 'sales-2026.xlsx', confidence: 'INFERRED' },
      { src: 'Q3 report', type: 'covers', dst: 'EU region', fact: 'EU sales fell 12%', confidence: 'INFERRED' },
    ],
  },
  {
    at: DAY(13),
    note: { type: 'change', title: 'Acme now wants PDF, not Word; legal review needed' },
    entities: [
      { name: 'Acme Corp', kind: 'organisation' },
      { name: 'Priya', kind: 'person' },
      { name: 'PDF', kind: 'format' },
      { name: 'Q3 report', kind: 'document' },
      { name: 'Legal review', kind: 'task', status: 'todo' },
    ],
    facts: [
      { src: 'Priya', type: 'prefers format', dst: 'PDF', confidence: 'STATED' },
      { src: 'Q3 report', type: 'needs', dst: 'Legal review', confidence: 'STATED' },
    ],
  },
];

// Writes the story through the graph API. Returns note ids and an entity
// lookup by (lowercase) name.
export function writeStory(store) {
  const g = store.graph;
  const notes = [];
  for (const turn of TURNS) {
    const noteId = store.addObservation({ session_id: 'story', project: PROJECT, ...turn.note, created_at: turn.at });
    notes.push(noteId);
    const ids = new Map();
    for (const e of turn.entities) {
      const { entity } = g.upsertEntity({ project: PROJECT, ...e, at: turn.at });
      ids.set(e.name, entity.id);
      g.addMention(entity.id, 'observation', noteId, 'mention', turn.at);
    }
    for (const f of turn.facts) {
      g.addFact({
        project: PROJECT, ...f, src: ids.get(f.src), dst: ids.get(f.dst), at: turn.at,
        note_kind: 'observation', note_id: noteId, single: SINGLE.has(f.type),
      });
    }
  }
  const entity = (name) => g.findEntity({ project: PROJECT, name });
  return { notes, entity };
}
