// Whole-graph insights for one project, in plain JavaScript: key entities,
// themes (Louvain communities), unexpected links and open questions. The
// rules follow Graphify's analysis (oversized communities are split, themes
// are named after their hub, cohesion is reported, ids stay stable between
// runs, uncertain cross-theme links count as more surprising) — written
// from scratch for memory rather than code.

const CONF_WEIGHT = { STATED: 1, INFERRED: 0.7, AMBIGUOUS: 0.4 };
const QUIET = new Set(['changed with']);
const CO_MENTION = 0.2;           // two entities named in the same note
const MAX_NOTE_ENTITIES = 8;      // bigger notes don't create co-mention links
const MAX_SHARE = 0.25;           // themes above this share of the graph are split
const MIN_SPLIT = 10;
const STALE_TASK_DAYS = 14;
const DAY = 86400000;
const LABEL_KINDS = new Set(['project', 'organisation']);

// ---- load -----------------------------------------------------------------

export function loadGraph(g, project) {
  const nodes = new Map(g.listEntities({ project, limit: 100000 }).map((e) => [e.id, e]));
  const facts = g.listFacts({ project, limit: 100000 }).filter((f) => nodes.has(f.src) && nodes.has(f.dst));
  const weights = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const add = (a, b, w) => {
    if (a === b) return;
    const k = key(a, b);
    weights.set(k, (weights.get(k) || 0) + w);
  };
  for (const f of facts) add(f.src, f.dst, QUIET.has(f.type) ? 0.3 : CONF_WEIGHT[f.confidence] ?? 0.7);
  const byNote = new Map();
  for (const m of g.notesMentioning(nodes.keys(), { noteKind: 'observation', limit: 1000000 })) {
    if (!byNote.has(m.note_id)) byNote.set(m.note_id, []);
    byNote.get(m.note_id).push(m.entity_id);
  }
  for (const ids of byNote.values()) {
    if (ids.length < 2 || ids.length > MAX_NOTE_ENTITIES) continue;
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) add(sorted[i], sorted[j], CO_MENTION);
  }
  const edges = [...weights].map(([k, w]) => {
    const [a, b] = k.split('|').map(Number);
    return { a, b, w };
  }).sort((x, y) => x.a - y.a || x.b - y.b);
  const degree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const f of facts) {
    if (QUIET.has(f.type)) continue;
    degree.set(f.src, degree.get(f.src) + 1);
    degree.set(f.dst, degree.get(f.dst) + 1);
  }
  return { nodes, facts, edges, degree };
}

// ---- communities ----------------------------------------------------------

// Deterministic Louvain: nodes visited in id order, ties go to the lowest
// community id. Returns Map(node → community index).
export function louvain(nodeIds, edges, { resolution = 1 } = {}) {
  let ids = [...nodeIds].sort((a, b) => a - b);
  let links = edges.map((e) => ({ ...e }));
  let membership = new Map(ids.map((id) => [id, id]));
  for (let level = 0; level < 10; level++) {
    const adj = new Map(ids.map((id) => [id, new Map()]));
    const k = new Map(ids.map((id) => [id, 0]));
    let m2 = 0;
    for (const { a, b, w } of links) {
      if (!adj.has(a) || !adj.has(b)) continue;
      if (a === b) {
        k.set(a, k.get(a) + 2 * w);
        m2 += 2 * w;
        continue;
      }
      adj.get(a).set(b, (adj.get(a).get(b) || 0) + w);
      adj.get(b).set(a, (adj.get(b).get(a) || 0) + w);
      k.set(a, k.get(a) + w);
      k.set(b, k.get(b) + w);
      m2 += 2 * w;
    }
    if (!m2) break;
    const comm = new Map(ids.map((id) => [id, id]));
    const tot = new Map(ids.map((id) => [id, k.get(id)]));
    let moved = false;
    for (let pass = 0; pass < 50; pass++) {
      let changed = false;
      for (const i of ids) {
        const ci = comm.get(i);
        const ki = k.get(i);
        const toComm = new Map();
        for (const [j, w] of adj.get(i)) {
          const cj = comm.get(j);
          toComm.set(cj, (toComm.get(cj) || 0) + w);
        }
        tot.set(ci, tot.get(ci) - ki);
        let best = ci;
        let bestGain = (toComm.get(ci) || 0) - (resolution * tot.get(ci) * ki) / m2;
        for (const c of [...toComm.keys()].sort((x, y) => x - y)) {
          const gain = toComm.get(c) - (resolution * tot.get(c) * ki) / m2;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best && c !== ci && gain > 0)) {
            best = c;
            bestGain = gain;
          }
        }
        tot.set(best, tot.get(best) + ki);
        if (best !== ci) {
          comm.set(i, best);
          changed = true;
          moved = true;
        }
      }
      if (!changed) break;
    }
    if (!moved) break;
    // Collapse each community into one node and repeat on the smaller graph.
    for (const [orig, cur] of membership) membership.set(orig, comm.get(cur));
    const merged = new Map();
    for (const { a, b, w } of links) {
      const ca = comm.get(a);
      const cb = comm.get(b);
      if (ca === undefined || cb === undefined) continue;
      const kk = ca <= cb ? `${ca}|${cb}` : `${cb}|${ca}`;
      merged.set(kk, (merged.get(kk) || 0) + w);
    }
    links = [...merged].map(([kk, w]) => {
      const [a, b] = kk.split('|').map(Number);
      return { a, b, w };
    });
    ids = [...new Set(comm.values())].sort((a, b) => a - b);
  }
  // Renumber 0..n by first member id.
  const order = new Map();
  for (const id of [...membership.keys()].sort((a, b) => a - b)) {
    const c = membership.get(id);
    if (!order.has(c)) order.set(c, order.size);
  }
  return new Map([...membership].map(([id, c]) => [id, order.get(c)]));
}

function groups(assign) {
  const out = new Map();
  for (const [id, c] of assign) {
    if (!out.has(c)) out.set(c, []);
    out.get(c).push(id);
  }
  return [...out.values()].map((m) => m.sort((a, b) => a - b));
}

export function cohesion(members, edges) {
  const set = new Set(members);
  const n = members.length;
  if (n <= 1) return 1;
  const inside = edges.filter((e) => set.has(e.a) && set.has(e.b) && e.a !== e.b).length;
  return inside / ((n * (n - 1)) / 2);
}

// Themes with at least two members, split when one swallows the graph,
// named after their best-connected member, with ids kept from `previous`.
export function themes(G, { previous = [] } = {}) {
  const connected = new Set(G.edges.flatMap((e) => [e.a, e.b]));
  const ids = [...G.nodes.keys()].filter((id) => connected.has(id));
  let parts = groups(louvain(ids, G.edges));
  const limit = Math.max(MIN_SPLIT, Math.ceil(ids.length * MAX_SHARE));
  parts = parts.flatMap((members) => {
    if (members.length <= limit) return [members];
    const set = new Set(members);
    const sub = groups(louvain(members, G.edges.filter((e) => set.has(e.a) && set.has(e.b)), { resolution: 1.5 }));
    return sub.length > 1 ? sub : [members];
  }).filter((m) => m.length >= 2);

  // A theme is named after its best-connected member; projects and
  // organisations get a little extra, since work tends to revolve round them.
  const rank = (id) => {
    const e = G.nodes.get(id);
    return [-((G.degree.get(id) || 0) + (LABEL_KINDS.has(e.kind) ? 1.5 : 0)), -(e.mention_count || 0), e.name];
  };
  const byRank = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || String(ra[2]).localeCompare(String(rb[2]));
  };
  const list = parts.map((members) => {
    const sorted = [...members].sort(byRank);
    const hub = G.nodes.get(sorted.find((id) => G.nodes.get(id).kind !== 'file') ?? sorted[0]);
    return { label: hub.name, hub: hub.id, members: sorted, size: members.length, cohesion: Number(cohesion(members, G.edges).toFixed(2)) };
  }).sort((a, b) => b.size - a.size || a.hub - b.hub);

  // Keep ids stable: each new theme takes the id of the previous theme it
  // overlaps most (Jaccard >= 0.3), biggest themes first.
  const used = new Set();
  let next = previous.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, '')) || 0), 0);
  for (const t of list) {
    const mine = new Set(t.members);
    let best = null;
    for (const p of previous) {
      if (used.has(p.id)) continue;
      const theirs = new Set(p.members);
      const inter = [...mine].filter((x) => theirs.has(x)).length;
      const j = inter / (mine.size + theirs.size - inter);
      if (j >= 0.3 && (!best || j > best.j)) best = { id: p.id, j };
    }
    t.id = best ? best.id : `t${++next}`;
    used.add(t.id);
  }
  return list;
}

// ---- rankings -------------------------------------------------------------

export function keyEntities(G, limit = 10) {
  return [...G.nodes.values()]
    .filter((e) => e.kind !== 'file')
    .map((e) => ({ ...e, degree: G.degree.get(e.id) || 0, score: (G.degree.get(e.id) || 0) + 0.5 * Math.log1p(e.mention_count || 0) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}

// Facts that cross themes, scored like Graphify's surprising connections:
// uncertain beats certain, different kinds of thing, a small entity
// reaching a hub.
export function unexpectedLinks(G, themeList, limit = 5) {
  const themeOf = new Map();
  for (const t of themeList) for (const id of t.members) themeOf.set(id, t);
  const out = [];
  for (const f of G.facts) {
    if (QUIET.has(f.type)) continue;
    const ta = themeOf.get(f.src);
    const tb = themeOf.get(f.dst);
    if (!ta || !tb || ta === tb) continue;
    const reasons = [`links themes "${ta.label}" and "${tb.label}"`];
    let score = 1 + ({ AMBIGUOUS: 3, INFERRED: 2, STATED: 1 }[f.confidence] ?? 1);
    if (f.confidence !== 'STATED') reasons.push(`${f.confidence.toLowerCase()}, not stated directly`);
    const a = G.nodes.get(f.src);
    const b = G.nodes.get(f.dst);
    if (a.kind !== b.kind) { score += 1; reasons.push(`connects a ${a.kind} to a ${b.kind}`); }
    const da = G.degree.get(f.src) || 0;
    const db = G.degree.get(f.dst) || 0;
    if (Math.min(da, db) <= 2 && Math.max(da, db) >= 5) {
      score += 1;
      reasons.push(`"${(da <= 2 ? a : b).name}" is a side detail that reaches the hub "${(da <= 2 ? b : a).name}"`);
    }
    out.push({ fact: f, score, reasons });
  }
  return out.sort((x, y) => y.score - x.score || x.fact.id - y.fact.id).slice(0, limit);
}

// Questions worth asking: stale tasks, things mentioned often but never
// connected, entities that bridge themes, and items waiting in review.
export function openQuestions(G, themeList, { now = Date.now(), reviewCount = 0, limit = 6 } = {}) {
  const qs = [];
  for (const e of G.nodes.values()) {
    if (e.kind === 'task' && (e.status === 'todo' || e.status === 'doing') && now - e.last_seen > STALE_TASK_DAYS * DAY) {
      qs.push({ kind: 'stale-task', id: e.id, question: `Is "${e.name}" still ${e.status === 'doing' ? 'in progress' : 'to do'}? Not mentioned for ${Math.round((now - e.last_seen) / DAY)} days.` });
    }
  }
  for (const e of G.nodes.values()) {
    if (e.kind !== 'file' && (G.degree.get(e.id) || 0) === 0 && (e.mention_count || 0) >= 2) {
      qs.push({ kind: 'unconnected', id: e.id, question: `How does "${e.name}" relate to the rest? Mentioned in ${e.mention_count} notes but no facts link it.` });
    }
  }
  const themeOf = new Map();
  for (const t of themeList) for (const id of t.members) themeOf.set(id, t.id);
  const touched = new Map();
  const touch = (id, other) => {
    const t = themeOf.get(other);
    if (!t) return;
    if (!touched.has(id)) touched.set(id, new Set());
    touched.get(id).add(t);
  };
  for (const f of G.facts) {
    if (QUIET.has(f.type)) continue;
    touch(f.src, f.dst);
    touch(f.dst, f.src);
  }
  for (const [id, set] of touched) {
    if (set.size >= 3) qs.push({ kind: 'bridge', id, question: `"${G.nodes.get(id).name}" connects ${set.size} themes. Is it central, or should it be split?` });
  }
  if (reviewCount) qs.push({ kind: 'review', question: `${reviewCount} item${reviewCount > 1 ? 's' : ''} waiting in review (unsure merges, doubtful facts, near-duplicate notes).` });
  const order = { 'stale-task': 0, review: 1, unconnected: 2, bridge: 3 };
  return qs.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, limit);
}

export function analyzeGraph(g, project, { previousThemes = [], now = Date.now() } = {}) {
  const G = loadGraph(g, project);
  const list = themes(G, { previous: previousThemes });
  return {
    G,
    keyEntities: keyEntities(G),
    themes: list,
    unexpected: unexpectedLinks(G, list),
    questions: openQuestions(G, list, { now, reviewCount: g.stats(project).review }),
  };
}
