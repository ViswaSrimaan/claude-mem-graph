// Writes what the observer extracted for one note into the graph: entities
// are matched against what is already known (exact, alias, then fuzzy with
// guards), facts are added with replacement for one-value relations, and the
// note is linked to every entity it involves. Unsure cases go to Review.
import { nameKey, displayName } from './names.mjs';
import { compareNames } from './match.mjs';
import { normalizeKind, isSingle, TASK_STATUSES } from './vocab.mjs';
import { normConfidence, looksLikeFile } from './store.mjs';

const MAX_CANDIDATES = 5000;

// → { id, created, merged?, review? }
export function resolveEntity(graph, mode, { project, name, kind, status, summary, at }) {
  let k = normalizeKind(mode, kind);
  const display = displayName(name);
  // A document named like a file ("notes.md") is the same file the tool calls
  // touched, so both land on one "file" entity.
  if (k === 'document' && looksLikeFile(display)) k = 'file';
  const key = nameKey(display, k);
  if (!key) return null;
  const st = k === 'task' && TASK_STATUSES.includes(String(status || '').toLowerCase()) ? String(status).toLowerCase() : null;
  const extra = { summary: summary ? String(summary).slice(0, 300) : null, status: st, at };

  // 1. Same name (or a known alias) and kind.
  if (graph.findEntity({ project, name: display, kind: k })) {
    return { id: graph.upsertEntity({ project, kind: k, name: display, ...extra }).entity.id, created: false };
  }
  // 2. Same name under the generic "topic" kind: reuse it and sharpen the kind.
  const anyKind = graph.findEntity({ project, name: display });
  if (anyKind && (anyKind.kind === 'topic' || k === 'topic')) {
    if (anyKind.kind === 'topic' && k !== 'topic') graph.updateEntity(anyKind.id, { kind: k });
    graph.upsertEntity({ project, kind: k === 'topic' ? anyKind.kind : k, name: display, ...extra });
    return { id: anyKind.id, created: false };
  }
  // 3. A close spelling of an existing entity of the same kind.
  if (k !== 'file') {
    let best = null;
    for (const c of graph.matchCandidates(project, k, MAX_CANDIDATES)) {
      const r = compareNames(key, c.key);
      if (r.decision !== 'none' && (!best || r.score > best.score)) best = { ...r, id: c.entity_id };
    }
    if (best?.decision === 'merge') {
      graph.addAlias(best.id, display);
      graph.touchEntity(best.id, extra);
      return { id: best.id, created: false, merged: best.reason };
    }
    if (best?.decision === 'review') {
      const { entity } = graph.upsertEntity({ project, kind: k, name: display, ...extra });
      graph.addReview({ project, kind: 'entity-merge', a: best.id, b: entity.id, score: best.score, reason: best.reason });
      return { id: entity.id, created: true, review: true };
    }
  }
  const { entity, created } = graph.upsertEntity({ project, kind: k, name: display, ...extra });
  return { id: entity.id, created };
}

// entities: [{ name, kind, status?, summary? }]
// relations: [{ src, type, dst, fact?, why?, confidence? }]
export function ingestNote(graph, mode, {
  project, noteKind = 'observation', noteId, at = Date.now(), session_id, entities = [], relations = [], defaultConfidence = 'INFERRED',
}) {
  const counts = { entities: 0, created: 0, merged: 0, facts: 0, closed: 0, review: 0 };
  if (!graph) return counts;
  return graph.tx(() => {
    const ids = new Map();
    const resolve = (e) => {
      const lookup = String(e.name || '').trim().toLowerCase();
      if (ids.has(lookup)) return ids.get(lookup);
      const r = resolveEntity(graph, mode, { project, ...e, at });
      if (!r) return null;
      ids.set(lookup, r.id);
      counts.entities++;
      if (r.created) counts.created++;
      if (r.merged) counts.merged++;
      if (r.review) counts.review++;
      if (noteId) graph.addMention(r.id, noteKind, noteId, 'mention', at);
      return r.id;
    };
    for (const e of entities) resolve(e);
    for (const rel of relations) {
      // An endpoint the observer didn't list as an entity is matched by name
      // against what's known, or added as a topic.
      const src = resolve({ name: rel.src, kind: entities.find((e) => sameName(e.name, rel.src))?.kind || guessKind(graph, project, rel.src) });
      const dst = resolve({ name: rel.dst, kind: entities.find((e) => sameName(e.name, rel.dst))?.kind || guessKind(graph, project, rel.dst) });
      if (!src || !dst || src === dst) continue;
      const confidence = normConfidence(rel.confidence || defaultConfidence);
      const r = graph.addFact({
        project, src, dst, type: rel.type, fact: rel.fact, why: rel.why, confidence, at,
        note_kind: noteKind, note_id: noteId ?? null, session_id, single: isSingle(mode, rel.type),
      });
      if (!r) continue;
      if (r.created) counts.facts++;
      counts.closed += r.closed.length;
      if (confidence === 'AMBIGUOUS' && r.created) {
        graph.addReview({ project, kind: 'fact-check', a: r.id, b: 0, reason: 'marked ambiguous by the observer' });
        counts.review++;
      }
    }
    return counts;
  });
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function guessKind(graph, project, name) {
  return graph.findEntity({ project, name })?.kind || 'topic';
}
