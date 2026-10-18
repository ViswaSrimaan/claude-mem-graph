// Hybrid recall. Text search finds starting points (notes, entity names,
// fact text); a short walk over current facts adds what is connected; the
// text ranking and the graph ranking are merged with reciprocal rank fusion.
// Every note keeps a note of how it was found.
import { tokenize } from '../store/common.mjs';

const CONF = { STATED: 1, INFERRED: 0.7, AMBIGUOUS: 0.4 };
const RRF_K = 60;
const DAY = 86400000;
const HUB = 8;           // entities with more current facts than this spread less
const TEXT_POOL = 30;
const GRAPH_POOL = 100;

export function recency(at, now = Date.now()) {
  const age = Math.max(0, now - (Number(at) || now)) / DAY;
  return 0.5 + 0.5 * Math.exp(-age / 180);
}

const confidence = (c) => CONF[c] ?? CONF.INFERRED;

export function lessonLabel(fb) {
  if (fb.latest.outcome === 'dead_end') return 'marked dead end';
  if (fb.latest.outcome === 'corrected') return `corrected${fb.latest.correction ? `: ${fb.latest.correction.slice(0, 120)}` : ''}`;
  return fb.useful >= 2 ? `useful ×${fb.useful}` : 'marked useful';
}

// → { notes: [obs + {score, found_by, via, hop, origin}], facts: [fact + {weight, previous}], entities: [entity + {weight, hop}] }
// `semantic`: optional notes already ranked by meaning (embeddings), merged
// as a third list.
export function recall(store, {
  query, project, type, since, excludeSession, limit = 15, depth = 2, factLimit = 8, now = Date.now(), semantic = [],
} = {}) {
  const text = store.search({ query, project, type, since, excludeSession, limit: TEXT_POOL });
  const g = store.graph;
  if (!g || !tokenize(query).length) {
    return { notes: text.slice(0, limit).map((o) => ({ ...o, found_by: ['text'] })), facts: [], entities: [] };
  }
  const meaning = semantic.filter((o) => (!type || o.type === type) && (!since || o.created_at >= since) && (!excludeSession || o.session_id !== excludeSession));

  // 1. Starting points.
  const reach = new Map();
  const seed = (id, weight, origin) => {
    const cur = reach.get(id);
    if (!cur || cur.weight < weight) reach.set(id, { id, weight, hop: 0, via: null, origin });
  };
  g.searchEntities(query, { project, limit: 8 }).forEach((e, i) => seed(e.id, 1 / (1 + i * 0.15), 'name'));
  // A fact whose own words match is a direct hit and ranks above facts that
  // are merely next to a matching name.
  const facts = new Map();
  g.searchFacts(query, { project, limit: 8 }).forEach((f, i) => {
    const w = 0.8 / (1 + i * 0.15);
    seed(f.src, w, 'fact');
    seed(f.dst, w, 'fact');
    facts.set(f.id, { rel: f, weight: 1.25 * w * confidence(f.confidence) * recency(f.updated_at || f.valid_from, now) });
  });
  for (const o of text.slice(0, 3)) for (const e of g.mentionsOf('observation', o.id)) seed(e.id, 0.5, 'note');

  // 2. Walk outward over current facts; each step counts for half.
  let frontier = [...reach.keys()];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const inFrontier = new Set(frontier);
    const degree = g.degrees(frontier);
    const next = new Set();
    for (const r of g.neighbours(frontier)) {
      for (const [from, to] of [[r.src, r.dst], [r.dst, r.src]]) {
        if (!inFrontier.has(from)) continue;
        const base = reach.get(from);
        const strength = base.weight * confidence(r.confidence) * recency(r.updated_at || r.valid_from, now);
        const fw = facts.get(r.id);
        if (!fw || fw.weight < strength) facts.set(r.id, { rel: r, weight: strength });
        const damp = Math.min(1, HUB / Math.max(1, degree.get(from) || 1));
        const w = strength * 0.5 * damp;
        const cur = reach.get(to);
        if (!cur) {
          reach.set(to, { id: to, weight: w, hop, via: r.id, origin: base.origin });
          next.add(to);
        } else if (cur.weight < w && cur.hop > 0) {
          Object.assign(cur, { weight: w, via: r.id, origin: base.origin });
        }
      }
    }
    frontier = [...next];
  }

  // 3. Notes linked to what was reached (mentions, and the notes facts came from).
  const noteScore = new Map();
  const bump = (noteId, w, entityId) => {
    const cur = noteScore.get(noteId) || { weight: 0, count: 0, entity: entityId };
    if (w > cur.weight) Object.assign(cur, { weight: w, entity: entityId });
    cur.count++;
    noteScore.set(noteId, cur);
  };
  for (const m of g.notesMentioning(reach.keys(), { noteKind: 'observation', limit: 1000 })) {
    bump(m.note_id, reach.get(m.entity_id).weight * (m.role === 'mention' ? 1 : 0.6), m.entity_id);
  }
  for (const { rel, weight } of facts.values()) {
    if (rel.note_kind === 'observation' && rel.note_id) bump(rel.note_id, weight, reach.has(rel.src) ? rel.src : rel.dst);
  }
  const ranked = [...noteScore].map(([id, s]) => [id, s.weight * (1 + 0.15 * Math.min(s.count - 1, 4)), s])
    .sort((a, b) => b[1] - a[1]).slice(0, GRAPH_POOL);
  const byId = new Map(store.getObservations(ranked.map(([id]) => id)).map((o) => [o.id, o]));
  const p = project && project !== '*' && project !== 'all' ? project : null;
  const graphNotes = ranked.map(([id, , s]) => ({ o: byId.get(id), s })).filter(({ o }) => o
    && (!p || o.project === p)
    && (!type || o.type === type)
    && (!since || o.created_at >= since)
    && (!excludeSession || o.session_id !== excludeSession));

  // 4. Merge the two rankings.
  const fused = new Map();
  const add = (o, rank, how, extra = {}) => {
    const cur = fused.get(o.id) || { ...o, score: 0, found_by: [] };
    cur.score += 1 / (RRF_K + rank + 1);
    cur.found_by.push(how);
    Object.assign(cur, extra);
    fused.set(o.id, cur);
  };
  text.forEach((o, i) => add(o, i, 'text'));
  meaning.forEach((o, i) => add(o, i, 'meaning', { similarity: o.similarity }));
  graphNotes.forEach(({ o, s }, i) => {
    const r = reach.get(s.entity);
    add(o, i, 'graph', { via: g.getEntity(s.entity)?.name, hop: r?.hop ?? 0, origin: r?.origin });
  });
  // A note whose facts have all been replaced since is out of date: say so,
  // and let current notes go first. Feedback (useful / dead end /
  // corrected) moves notes and facts up or down.
  const status = g.noteFactStatus(fused.keys());
  const noteFeedback = g.feedbackFor('observation', fused.keys(), now);
  for (const o of fused.values()) {
    const st = status.get(o.id);
    if (st && st.closed > 0 && st.current === 0) {
      o.outdated = true;
      o.score *= 0.7;
    }
    const fb = noteFeedback.get(o.id);
    if (fb) {
      o.score *= fb.multiplier;
      o.lesson = lessonLabel(fb);
    }
  }
  const notes = [...fused.values()].sort((a, b) => b.score - a.score || b.created_at - a.created_at).slice(0, limit);

  const factFeedback = g.feedbackFor('fact', facts.keys(), now);
  for (const [id, f] of facts) if (factFeedback.has(id)) f.weight *= factFeedback.get(id).multiplier;
  const topFacts = [...facts.values()].sort((a, b) => b.weight - a.weight).slice(0, factLimit);
  const previous = g.previousValues(topFacts.map((f) => f.rel.id));
  const factRows = topFacts.map(({ rel, weight }) => ({
    ...g.getFact(rel.id), weight, previous: previous.get(rel.id) || [],
    near: [reach.get(rel.src), reach.get(rel.dst)].filter(Boolean).reduce((m, x) => (x.hop < m.hop ? x : m), { hop: 99 }),
  }));
  const entities = [...reach.values()].sort((a, b) => b.weight - a.weight).slice(0, 20)
    .map((r) => ({ ...g.getEntity(r.id), weight: r.weight, hop: r.hop, origin: r.origin }))
    .filter((e) => e.id);
  return { notes, facts: factRows, entities };
}
