// Graph layer over the SQLite memory database. Entities are nodes, relations
// are facts (edges) that stay current until valid_to is set, and mentions tie
// notes to the entities they involve. Every graph read and write goes through
// this class so another backend could be swapped in later.
import { nameKey, fileKey, kindKey, displayName } from './names.mjs';
import { ftsQuery, tokenize, projectFilter } from '../store/common.mjs';

const CONF_RANK = { AMBIGUOUS: 0, INFERRED: 1, STATED: 2 };
const MAX_FILES = 30;
const CHUNK = 400;
const DAY = 86400000;
const FEEDBACK_HALF_LIFE = 30 * DAY;
export const FEEDBACK_OUTCOMES = ['useful', 'dead_end', 'corrected'];

export function normConfidence(c) {
  const u = String(c || '').toUpperCase();
  if (u === 'EXTRACTED') return 'STATED';
  return u in CONF_RANK ? u : 'INFERRED';
}

export function relationType(t) {
  return String(t || '').toLowerCase().replace(/[_\s]+/g, ' ').trim().slice(0, 60) || 'related to';
}

const plain = (row) => (row ? { ...row } : row);

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const looksLikeFile = (name) => /[\\/]/.test(name) || /\.[a-z][a-z0-9]{0,7}$/i.test(String(name).trim());

export class GraphStore {
  constructor(db, tx) {
    this.db = db;
    this.tx = tx;
    this.stmts = new Map();
  }

  #s(sql) {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  // ---- entities -----------------------------------------------------------

  #hydrate(row) {
    if (!row) return null;
    const e = plain(row);
    e.aliases = this.#s('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias').all(e.id).map((r) => r.alias);
    return e;
  }

  getEntity(id) {
    return this.#hydrate(this.#s('SELECT * FROM entities WHERE id = ?').get(Number(id)));
  }

  // Exact key match first, then a known alias. Without a kind the most
  // mentioned match wins.
  findEntity({ project, name, kind }) {
    const p = project || 'default';
    const k = kind ? kindKey(kind) : null;
    const keys = k ? [nameKey(name, k)] : [...new Set([nameKey(name), looksLikeFile(name) ? fileKey(name) : null].filter(Boolean))];
    for (const key of keys) {
      if (!key) continue;
      const row = k
        ? this.#s('SELECT * FROM entities WHERE project = ? AND kind = ? AND key = ?').get(p, k, key)
        : this.#s('SELECT * FROM entities WHERE project = ? AND key = ? ORDER BY mention_count DESC, id LIMIT 1').get(p, key);
      if (row) return this.#hydrate(row);
    }
    for (const key of keys) {
      if (!key) continue;
      const row = k
        ? this.#s(`SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
                   WHERE a.key = ? AND e.project = ? AND e.kind = ? ORDER BY e.mention_count DESC LIMIT 1`).get(key, p, k)
        : this.#s(`SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
                   WHERE a.key = ? AND e.project = ? ORDER BY e.mention_count DESC LIMIT 1`).get(key, p);
      if (row) return this.#hydrate(row);
    }
    return null;
  }

  upsertEntity({ project, kind, name, summary, status, at }) {
    const p = project || 'default';
    const k = kindKey(kind);
    const display = displayName(name);
    const key = nameKey(display, k);
    if (!key) return null;
    const when = Number(at) || Date.now();
    return this.tx(() => {
      const found = this.findEntity({ project: p, name: display, kind: k });
      if (found) {
        this.#s(`UPDATE entities SET last_seen = MAX(last_seen, ?), first_seen = MIN(first_seen, ?),
                   summary = COALESCE(NULLIF(summary, ''), ?), status = COALESCE(?, status) WHERE id = ?`)
          .run(when, when, summary || null, status || null, found.id);
        if (k !== 'file' && display.toLowerCase() !== found.name.toLowerCase()) this.addAlias(found.id, display);
        return { entity: this.getEntity(found.id), created: false };
      }
      const r = this.#s(`INSERT INTO entities(project, kind, name, key, summary, status, first_seen, last_seen)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p, k, display, key, summary || null, status || null, when, when);
      return { entity: this.getEntity(Number(r.lastInsertRowid)), created: true };
    });
  }

  touchEntity(id, { summary, status, at } = {}) {
    const when = Number(at) || Date.now();
    this.#s(`UPDATE entities SET last_seen = MAX(last_seen, ?), summary = COALESCE(NULLIF(summary, ''), ?),
               status = COALESCE(?, status) WHERE id = ?`).run(when, summary || null, status || null, Number(id));
  }

  // Names and aliases of one kind in a project, most recently seen first,
  // for fuzzy matching a new name against.
  matchCandidates(project, kind, limit = 5000) {
    return this.#s(`SELECT id AS entity_id, key, last_seen FROM entities WHERE project = ? AND kind = ?
                    UNION ALL
                    SELECT e.id, a.key, e.last_seen FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
                    WHERE e.project = ? AND e.kind = ?
                    ORDER BY last_seen DESC LIMIT ?`).all(project || 'default', kindKey(kind), project || 'default', kindKey(kind), limit);
  }

  addAlias(entityId, alias) {
    const e = this.#s('SELECT id, kind, key, name FROM entities WHERE id = ?').get(Number(entityId));
    const display = displayName(alias);
    const key = e ? nameKey(display, e.kind) : '';
    if (!e || !key || display.toLowerCase() === e.name.toLowerCase()) return false;
    return this.#s('INSERT OR IGNORE INTO entity_aliases(entity_id, alias, key) VALUES (?, ?, ?)').run(e.id, display, key).changes > 0;
  }

  updateEntity(id, { name, kind, summary, status } = {}) {
    const cur = this.getEntity(id);
    if (!cur) return null;
    const k = kind ? kindKey(kind) : cur.kind;
    const display = name ? displayName(name) : cur.name;
    const key = nameKey(display, k);
    if (!key) return cur;
    return this.tx(() => {
      const clash = this.#s('SELECT id FROM entities WHERE project = ? AND kind = ? AND key = ? AND id != ?').get(cur.project, k, key, cur.id);
      if (clash) return this.mergeEntities(clash.id, cur.id);
      this.#s(`UPDATE entities SET name = ?, kind = ?, key = ?, summary = COALESCE(?, summary), status = COALESCE(?, status) WHERE id = ?`)
        .run(display, k, key, summary ?? null, status ?? null, cur.id);
      if (display !== cur.name) this.addAlias(cur.id, cur.name);
      return this.getEntity(cur.id);
    });
  }

  // Fold `dropId` into `keepId`: facts, mentions and aliases move over, the
  // dropped name becomes an alias, and duplicate current facts collapse.
  mergeEntities(keepId, dropId) {
    keepId = Number(keepId);
    dropId = Number(dropId);
    if (keepId === dropId) return this.getEntity(keepId);
    const keep = this.getEntity(keepId);
    const drop = this.getEntity(dropId);
    if (!keep || !drop) return keep || null;
    return this.tx(() => {
      this.#s('UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?').run(keepId, dropId);
      this.#s('DELETE FROM entity_aliases WHERE entity_id = ?').run(dropId);
      this.#s('UPDATE relations SET src = ? WHERE src = ?').run(keepId, dropId);
      this.#s('UPDATE relations SET dst = ? WHERE dst = ?').run(keepId, dropId);
      this.#s('DELETE FROM relations WHERE src = ? AND dst = ?').run(keepId, keepId);
      this.#s('UPDATE OR IGNORE mentions SET entity_id = ? WHERE entity_id = ?').run(keepId, dropId);
      this.#s('DELETE FROM mentions WHERE entity_id = ?').run(dropId);
      this.#s(`UPDATE entities SET first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
                 summary = COALESCE(NULLIF(summary, ''), ?), status = COALESCE(status, ?),
                 mention_count = (SELECT COUNT(*) FROM mentions WHERE entity_id = ?) WHERE id = ?`)
        .run(drop.first_seen, drop.last_seen, drop.summary || null, drop.status || null, keepId, keepId);
      this.#s('DELETE FROM entities WHERE id = ?').run(dropId);
      this.addAlias(keepId, drop.name);
      for (const a of drop.aliases) this.addAlias(keepId, a);
      this.#collapseDuplicates(keepId);
      return this.getEntity(keepId);
    });
  }

  #collapseDuplicates(entityId) {
    const groups = this.#s(`SELECT src, type, dst FROM relations
                            WHERE (src = ? OR dst = ?) AND valid_to IS NULL
                            GROUP BY src, type, dst HAVING COUNT(*) > 1`).all(entityId, entityId);
    for (const g of groups) {
      const rows = this.#s('SELECT * FROM relations WHERE src = ? AND type = ? AND dst = ? AND valid_to IS NULL ORDER BY id')
        .all(g.src, g.type, g.dst);
      rows.sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || a.valid_from - b.valid_from || a.id - b.id);
      const [winner, ...rest] = rows;
      for (const r of rest) {
        this.#s('UPDATE relations SET superseded_by = ? WHERE superseded_by = ?').run(winner.id, r.id);
        this.#s(`UPDATE relations SET fact = COALESCE(NULLIF(fact, ''), ?), why = COALESCE(NULLIF(why, ''), ?),
                   valid_from = MIN(valid_from, ?) WHERE id = ?`).run(r.fact || null, r.why || null, r.valid_from, winner.id);
        this.#s('DELETE FROM relations WHERE id = ?').run(r.id);
      }
    }
  }

  deleteEntity(id) {
    id = Number(id);
    return this.tx(() => {
      this.#s('UPDATE relations SET superseded_by = NULL WHERE superseded_by IN (SELECT id FROM relations WHERE src = ? OR dst = ?)').run(id, id);
      this.#s('DELETE FROM relations WHERE src = ? OR dst = ?').run(id, id);
      this.#s('DELETE FROM mentions WHERE entity_id = ?').run(id);
      this.#s('DELETE FROM entity_aliases WHERE entity_id = ?').run(id);
      return this.#s('DELETE FROM entities WHERE id = ?').run(id).changes;
    });
  }

  listEntities({ project, kind, status, limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    const p = projectFilter(project);
    if (p) { where.push('project = ?'); args.push(p); }
    if (kind) { where.push('kind = ?'); args.push(kindKey(kind)); }
    const statuses = [].concat(status || []);
    if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
    return this.db.prepare(`SELECT * FROM entities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                            ORDER BY mention_count DESC, last_seen DESC, id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(plain);
  }

  searchEntities(query, { project, kind, limit = 10 } = {}) {
    if (!tokenize(query).length) return [];
    const p = projectFilter(project);
    for (const op of ['AND', 'OR']) {
      const args = [ftsQuery(query, op)];
      let extra = '';
      if (p) { extra += ' AND e.project = ?'; args.push(p); }
      if (kind) { extra += ' AND e.kind = ?'; args.push(kindKey(kind)); }
      try {
        const rows = this.db.prepare(`SELECT e.*, bm25(entities_fts, 10.0, 6.0, 1.0) AS score
            FROM entities_fts f JOIN entities e ON e.id = f.rowid
            WHERE entities_fts MATCH ?${extra} ORDER BY score LIMIT ?`).all(...args, limit).map(plain);
        if (rows.length) return rows;
      } catch {
        return [];
      }
    }
    return [];
  }

  // ---- facts --------------------------------------------------------------

  #factRow(row) {
    if (!row) return null;
    const f = plain(row);
    const names = this.#s('SELECT id, name, kind FROM entities WHERE id IN (?, ?)').all(f.src, f.dst);
    const byId = new Map(names.map((n) => [n.id, n]));
    f.src_name = byId.get(f.src)?.name ?? `#${f.src}`;
    f.dst_name = byId.get(f.dst)?.name ?? `#${f.dst}`;
    f.current = f.valid_to === null || f.valid_to === undefined;
    return f;
  }

  getFact(id) {
    return this.#factRow(this.#s('SELECT * FROM relations WHERE id = ?').get(Number(id)));
  }

  // Adds one fact. A repeat of a current fact refreshes it instead of adding a
  // copy. With `single`, the relation holds one value at a time: the earlier
  // current value is closed and points at the fact that replaced it. A fact
  // dated before a later value is stored as history straight away.
  addFact({ project, src, dst, type, fact, why, confidence, score, at, note_kind, note_id, session_id, single = false }) {
    src = Number(src);
    dst = Number(dst);
    if (!src || !dst || src === dst) return null;
    const t = relationType(type);
    const conf = normConfidence(confidence);
    const when = Number(at) || Date.now();
    const p = project || this.#s('SELECT project FROM entities WHERE id = ?').get(src)?.project || 'default';
    return this.tx(() => {
      const same = this.#s('SELECT * FROM relations WHERE src = ? AND type = ? AND dst = ? AND valid_to IS NULL').get(src, t, dst);
      if (same) {
        const stronger = CONF_RANK[conf] > CONF_RANK[same.confidence] ? conf : same.confidence;
        this.#s(`UPDATE relations SET confidence = ?, fact = COALESCE(NULLIF(fact, ''), ?), why = COALESCE(NULLIF(why, ''), ?),
                   valid_from = MIN(valid_from, ?), updated_at = ? WHERE id = ?`)
          .run(stronger, fact || null, why || null, when, Math.max(when, same.updated_at), same.id);
        this.#touch([src, dst], when);
        return { id: same.id, created: false, closed: [] };
      }
      let validTo = null;
      let supersededBy = null;
      if (single) {
        const later = this.#s('SELECT id, valid_from FROM relations WHERE src = ? AND type = ? AND valid_from > ? ORDER BY valid_from, id LIMIT 1').get(src, t, when);
        if (later) {
          validTo = later.valid_from;
          supersededBy = later.id;
        }
      }
      const r = this.#s(`INSERT INTO relations(project, src, type, dst, fact, why, confidence, score, valid_from, valid_to, superseded_by,
                           note_kind, note_id, session_id, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p, src, t, dst, fact || null, why || null, conf, score ?? null, when, validTo, supersededBy,
          note_kind || null, note_id ?? null, session_id || null, Date.now(), when);
      const id = Number(r.lastInsertRowid);
      const closed = [];
      if (single && validTo === null) {
        const current = this.#s('SELECT id FROM relations WHERE src = ? AND type = ? AND valid_to IS NULL AND id != ? AND valid_from <= ?').all(src, t, id, when);
        for (const c of current) {
          this.#s('UPDATE relations SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?').run(when, id, when, c.id);
          closed.push(c.id);
        }
      }
      this.#touch([src, dst], when);
      return { id, created: true, closed, historical: validTo !== null };
    });
  }

  #touch(ids, when) {
    for (const id of ids) this.#s('UPDATE entities SET last_seen = MAX(last_seen, ?) WHERE id = ?').run(when, id);
  }

  updateFact(id, { confidence, fact, why } = {}) {
    const cur = this.getFact(id);
    if (!cur) return null;
    this.#s('UPDATE relations SET confidence = ?, fact = ?, why = ?, updated_at = ? WHERE id = ?').run(
      confidence ? normConfidence(confidence) : cur.confidence,
      fact === undefined ? cur.fact : fact || null,
      why === undefined ? cur.why : why || null,
      Date.now(), cur.id,
    );
    return this.getFact(cur.id);
  }

  closeFact(id, at = Date.now()) {
    return this.#s('UPDATE relations SET valid_to = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL').run(at, at, Number(id)).changes;
  }

  deleteFact(id) {
    return this.tx(() => {
      this.#s('UPDATE relations SET superseded_by = NULL WHERE superseded_by = ?').run(Number(id));
      return this.#s('DELETE FROM relations WHERE id = ?').run(Number(id)).changes;
    });
  }

  factsFor(entityId, { history = false, limit = 100 } = {}) {
    const cur = history ? '' : ' AND valid_to IS NULL';
    const rows = this.db.prepare(`SELECT * FROM relations WHERE (src = ? OR dst = ?)${cur}
                                  ORDER BY (valid_to IS NULL) DESC, valid_from DESC, id DESC LIMIT ?`)
      .all(Number(entityId), Number(entityId), limit);
    return rows.map((r) => this.#factRow(r));
  }

  // Current facts (or all, with history) in a project, newest first.
  listFacts({ project, type, history = false, limit = 50 } = {}) {
    const where = [];
    const args = [];
    const p = projectFilter(project);
    if (p) { where.push('project = ?'); args.push(p); }
    if (type) { where.push('type = ?'); args.push(relationType(type)); }
    if (!history) where.push('valid_to IS NULL');
    return this.db.prepare(`SELECT * FROM relations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                            ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, limit).map((r) => this.#factRow(r));
  }

  // Values a fact replaced: the closed facts that point at it.
  previousValues(factIds) {
    const out = new Map();
    for (const part of chunks([...new Set([...factIds].map(Number))])) {
      const rows = this.db.prepare(`SELECT * FROM relations WHERE superseded_by IN (${part.map(() => '?').join(',')}) ORDER BY valid_from DESC`).all(...part);
      for (const r of rows) {
        if (!out.has(r.superseded_by)) out.set(r.superseded_by, []);
        out.get(r.superseded_by).push(this.#factRow(r));
      }
    }
    return out;
  }

  // Per note: how many of the facts it produced are still current or closed.
  noteFactStatus(noteIds, noteKind = 'observation') {
    const out = new Map();
    for (const part of chunks([...new Set([...noteIds].map(Number))])) {
      const rows = this.db.prepare(`SELECT note_id, SUM(valid_to IS NULL) AS current, SUM(valid_to IS NOT NULL) AS closed
                                    FROM relations WHERE note_kind = ? AND note_id IN (${part.map(() => '?').join(',')}) GROUP BY note_id`)
        .all(noteKind, ...part);
      for (const r of rows) out.set(r.note_id, { current: r.current, closed: r.closed });
    }
    return out;
  }

  // Number of current facts touching each entity.
  degrees(ids) {
    const out = new Map();
    for (const part of chunks([...new Set([...ids].map(Number))])) {
      const marks = part.map(() => '?').join(',');
      for (const col of ['src', 'dst']) {
        for (const r of this.db.prepare(`SELECT ${col} AS id, COUNT(*) AS n FROM relations WHERE ${col} IN (${marks}) AND valid_to IS NULL GROUP BY ${col}`).all(...part)) {
          out.set(r.id, (out.get(r.id) || 0) + r.n);
        }
      }
    }
    return out;
  }

  searchFacts(query, { project, history = false, limit = 20 } = {}) {
    if (!tokenize(query).length) return [];
    const p = projectFilter(project);
    for (const op of ['AND', 'OR']) {
      const args = [ftsQuery(query, op)];
      let extra = history ? '' : ' AND r.valid_to IS NULL';
      if (p) { extra += ' AND r.project = ?'; args.push(p); }
      try {
        const rows = this.db.prepare(`SELECT r.*, bm25(facts_fts, 2.0, 6.0, 3.0) AS score_fts
            FROM facts_fts f JOIN relations r ON r.id = f.rowid
            WHERE facts_fts MATCH ?${extra} ORDER BY score_fts LIMIT ?`).all(...args, limit);
        if (rows.length) return rows.map((r) => this.#factRow(r));
      } catch {
        return [];
      }
    }
    return [];
  }

  // Facts touching any of `ids`, using the src and dst indexes.
  neighbours(ids, { history = false } = {}) {
    const list = [...new Set([...ids].map(Number))];
    const cur = history ? '' : ' AND valid_to IS NULL';
    const seen = new Map();
    for (const part of chunks(list)) {
      const marks = part.map(() => '?').join(',');
      for (const col of ['src', 'dst']) {
        for (const r of this.db.prepare(`SELECT * FROM relations WHERE ${col} IN (${marks})${cur}`).all(...part)) {
          seen.set(r.id, plain(r));
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.id - b.id);
  }

  // Breadth-first walk over facts from the seed entities, in both
  // directions. Returns each reached entity with its distance in steps.
  walk(seeds, { depth = 2, history = false, maxNodes = 500 } = {}) {
    const nodes = new Map();
    const relations = new Map();
    let frontier = [...new Set([...seeds].map(Number))].filter((id) => id > 0);
    for (const id of frontier) nodes.set(id, { id, hop: 0, via: null });
    for (let hop = 1; hop <= depth && frontier.length && nodes.size < maxNodes; hop++) {
      const next = [];
      const inFrontier = new Set(frontier);
      for (const r of this.neighbours(frontier, { history })) {
        relations.set(r.id, r);
        for (const [from, to] of [[r.src, r.dst], [r.dst, r.src]]) {
          if (!inFrontier.has(from) || nodes.has(to) || nodes.size >= maxNodes) continue;
          nodes.set(to, { id: to, hop, via: r.id });
          next.push(to);
        }
      }
      frontier = next;
    }
    return { nodes, relations };
  }

  // Shortest connection between two entities, ignoring arrow direction.
  path(fromId, toId, { maxDepth = 4, history = false } = {}) {
    fromId = Number(fromId);
    toId = Number(toId);
    if (!fromId || !toId) return null;
    if (fromId === toId) return { entities: [this.getEntity(fromId)], steps: [] };
    const parent = new Map([[fromId, null]]);
    let frontier = [fromId];
    for (let d = 0; d < maxDepth && frontier.length && !parent.has(toId); d++) {
      const next = [];
      const inFrontier = new Set(frontier);
      for (const r of this.neighbours(frontier, { history })) {
        for (const [from, to] of [[r.src, r.dst], [r.dst, r.src]]) {
          if (!inFrontier.has(from) || parent.has(to)) continue;
          parent.set(to, { from, relation: r });
          next.push(to);
        }
      }
      frontier = next;
    }
    if (!parent.has(toId)) return null;
    const ids = [toId];
    const steps = [];
    for (let cur = toId; parent.get(cur); cur = parent.get(cur).from) {
      const { from, relation } = parent.get(cur);
      steps.unshift({ ...this.#factRow(relation), forward: relation.src === from });
      ids.unshift(from);
    }
    return { entities: ids.map((id) => this.getEntity(id)), steps };
  }

  // ---- mentions -----------------------------------------------------------

  addMention(entityId, noteKind, noteId, role = 'mention', at = Date.now()) {
    const r = this.#s('INSERT OR IGNORE INTO mentions(entity_id, note_kind, note_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(Number(entityId), noteKind, Number(noteId), role, at);
    if (r.changes) {
      this.#s('UPDATE entities SET mention_count = mention_count + 1, last_seen = MAX(last_seen, ?) WHERE id = ?').run(at, Number(entityId));
    }
    return r.changes > 0;
  }

  removeMentions(noteKind, noteId, { roles } = {}) {
    const rows = this.#s('SELECT entity_id, role FROM mentions WHERE note_kind = ? AND note_id = ?').all(noteKind, Number(noteId))
      .filter((m) => !roles || roles.includes(m.role));
    for (const m of rows) {
      this.#s('DELETE FROM mentions WHERE entity_id = ? AND note_kind = ? AND note_id = ?').run(m.entity_id, noteKind, Number(noteId));
      this.#s('UPDATE entities SET mention_count = MAX(mention_count - 1, 0) WHERE id = ?').run(m.entity_id);
    }
    return rows.length;
  }

  mentionsOf(noteKind, noteId) {
    return this.#s(`SELECT e.*, m.role FROM mentions m JOIN entities e ON e.id = m.entity_id
                    WHERE m.note_kind = ? AND m.note_id = ? ORDER BY e.kind, e.name`).all(noteKind, Number(noteId)).map(plain);
  }

  notesMentioning(entityIds, { noteKind, limit = 200 } = {}) {
    const list = [...new Set([...entityIds].map(Number))];
    const out = [];
    for (const part of chunks(list)) {
      const marks = part.map(() => '?').join(',');
      const kindClause = noteKind ? ' AND note_kind = ?' : '';
      out.push(...this.db.prepare(`SELECT * FROM mentions WHERE entity_id IN (${marks})${kindClause} ORDER BY created_at DESC LIMIT ?`)
        .all(...part, ...(noteKind ? [noteKind] : []), limit).map(plain));
    }
    return out.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  // ---- notes → graph ------------------------------------------------------

  // Files already recorded on a note become entities, so even memory written
  // before the graph existed is connected. Concepts are not indexed: they are
  // a small fixed tag list (how-it-works, gotcha, …) and as entities they
  // would become hubs joining unrelated notes.
  indexObservation(o) {
    if (!o?.id) return 0;
    const at = Number(o.created_at) || Date.now();
    const project = o.project || 'default';
    return this.tx(() => {
      this.removeMentions('observation', o.id, { roles: ['read', 'modified'] });
      let n = 0;
      const modified = new Set((o.files_modified || []).map(fileKey));
      const files = [
        ...(o.files_modified || []).map((f) => [f, 'modified']),
        ...(o.files_read || []).filter((f) => !modified.has(fileKey(f))).map((f) => [f, 'read']),
      ].slice(0, MAX_FILES);
      for (const [file, role] of files) {
        const r = this.upsertEntity({ project, kind: 'file', name: file, at });
        if (r && this.addMention(r.entity.id, 'observation', o.id, role, at)) n++;
      }
      return n;
    });
  }

  forgetObservation(id) {
    return this.removeMentions('observation', id);
  }

  // Indexes observations not yet seen by the graph. Safe to run repeatedly.
  backfill({ batch = 500, parse } = {}) {
    let done = 0;
    for (;;) {
      const last = Number(this.#s("SELECT value FROM meta WHERE key = 'graph_backfill_observation'").get()?.value || 0);
      const rows = this.db.prepare('SELECT * FROM observations WHERE id > ? ORDER BY id LIMIT ?').all(last, batch);
      if (!rows.length) return done;
      this.tx(() => {
        for (const row of rows) this.indexObservation(parse ? parse(row) : row);
        this.#s("INSERT OR REPLACE INTO meta(key, value) VALUES ('graph_backfill_observation', ?)").run(String(rows[rows.length - 1].id));
      });
      done += rows.length;
    }
  }

  // ---- review queue -------------------------------------------------------
  // kinds: entity-merge (a = existing entity, b = new one), fact-check
  // (a = fact), note-duplicate (a = older note, b = newer note). A pair that
  // was already decided is never asked about again.

  addReview({ project, kind, a, b = 0, score = null, reason = '' }) {
    return this.#s(`INSERT OR IGNORE INTO review_queue(project, kind, a_id, b_id, score, reason, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(project || 'default', kind, Number(a), Number(b) || 0, score, reason, Date.now()).changes > 0;
  }

  #reviewItem(row) {
    const r = plain(row);
    if (r.kind === 'entity-merge') {
      r.a = this.getEntity(r.a_id);
      r.b = this.getEntity(r.b_id);
      if (!r.a || !r.b) return null;
      r.question = `Are "${r.a.name}" and "${r.b.name}" the same ${r.a.kind}?`;
    } else if (r.kind === 'fact-check') {
      r.a = this.getFact(r.a_id);
      if (!r.a) return null;
      r.question = `Is this right? ${r.a.src_name} —${r.a.type}→ ${r.a.dst_name}${r.a.fact ? ` ("${r.a.fact}")` : ''}`;
    } else if (r.kind === 'note-duplicate') {
      const note = (id) => plain(this.#s('SELECT id, title, created_at FROM observations WHERE id = ?').get(id));
      r.a = note(r.a_id);
      r.b = note(r.b_id);
      if (!r.a || !r.b) return null;
      r.question = `Do notes #${r.a.id} and #${r.b.id} say the same thing? "${r.a.title}" / "${r.b.title}"`;
    }
    return r;
  }

  listReview({ project, status = 'open', limit = 50 } = {}) {
    const p = projectFilter(project);
    const rows = this.db.prepare(`SELECT * FROM review_queue WHERE status = ?${p ? ' AND project = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...[status, ...(p ? [p] : []), limit]);
    const out = [];
    for (const row of rows) {
      const item = this.#reviewItem(row);
      if (item) out.push(item);
      else this.#s("UPDATE review_queue SET status = 'stale', resolved_at = ? WHERE id = ?").run(Date.now(), row.id);
    }
    return out;
  }

  // accept: merge the entities / confirm the fact / drop the newer note.
  resolveReview(id, accept) {
    const row = this.#s('SELECT * FROM review_queue WHERE id = ?').get(Number(id));
    if (!row || row.status !== 'open') return null;
    return this.tx(() => {
      const item = this.#reviewItem(row);
      if (!item) {
        this.#s("UPDATE review_queue SET status = 'stale', resolved_at = ? WHERE id = ?").run(Date.now(), row.id);
        return { status: 'stale' };
      }
      if (accept && row.kind === 'entity-merge') this.mergeEntities(row.a_id, row.b_id);
      if (row.kind === 'fact-check') {
        if (accept) this.#s("UPDATE relations SET confidence = 'STATED' WHERE id = ?").run(row.a_id);
        else this.deleteFact(row.a_id);
      }
      if (accept && row.kind === 'note-duplicate') {
        this.forgetObservation(row.b_id);
        this.#s('DELETE FROM observations WHERE id = ?').run(row.b_id);
      }
      const status = accept ? 'accepted' : 'rejected';
      this.#s('UPDATE review_queue SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), row.id);
      return { status, kind: row.kind };
    });
  }

  // ---- feedback -----------------------------------------------------------
  // Outcomes on notes or facts. Like Graphify's lessons, signals fade with a
  // half-life, so a fresh dead end outweighs an old "useful".

  addFeedback({ project, target_kind = 'observation', target_id, outcome, correction, session_id, at = Date.now() }) {
    if (!FEEDBACK_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${FEEDBACK_OUTCOMES.join(', ')}`);
    const r = this.#s(`INSERT INTO feedback(project, target_kind, target_id, outcome, correction, session_id, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(project || 'default', target_kind, Number(target_id), outcome, correction || null, session_id || null, at);
    return Number(r.lastInsertRowid);
  }

  // → Map(id → { score, multiplier, useful, negative, latest })
  feedbackFor(targetKind, ids, now = Date.now()) {
    const out = new Map();
    for (const part of chunks([...new Set([...ids].map(Number))])) {
      const rows = this.db.prepare(`SELECT * FROM feedback WHERE target_kind = ? AND target_id IN (${part.map(() => '?').join(',')}) ORDER BY created_at, id`)
        .all(targetKind, ...part);
      for (const r of rows) {
        const cur = out.get(r.target_id) || { score: 0, useful: 0, negative: 0, latest: null };
        const fade = 0.5 ** (Math.max(0, now - r.created_at) / FEEDBACK_HALF_LIFE);
        cur.score += (r.outcome === 'useful' ? 1 : -1) * fade;
        if (r.outcome === 'useful') cur.useful++;
        else cur.negative++;
        cur.latest = plain(r);
        out.set(r.target_id, cur);
      }
    }
    // A dead end or correction should push a memory below the alternatives,
    // even one found both by words and by the graph (one fresh mark → 0.4);
    // praise lifts more gently.
    for (const v of out.values()) v.multiplier = v.score >= 0 ? Math.min(1.6, 1 + 0.25 * v.score) : Math.max(0.2, 1 + 0.6 * v.score);
    return out;
  }

  // Dead ends, corrections and memories proven useful more than once.
  lessons(project, { days = 90, limit = 5, now = Date.now() } = {}) {
    const rows = this.db.prepare(`SELECT DISTINCT target_id FROM feedback WHERE project = ? AND target_kind = 'observation' AND created_at >= ?`)
      .all(project || 'default', now - days * DAY);
    const fb = this.feedbackFor('observation', rows.map((r) => r.target_id), now);
    const notes = new Map(this.db.prepare(`SELECT id, title, created_at FROM observations WHERE id IN (${[...fb.keys()].map(() => '?').join(',') || 'NULL'})`)
      .all(...fb.keys()).map((o) => [o.id, plain(o)]));
    const out = { deadEnds: [], corrections: [], proven: [] };
    for (const [id, f] of fb) {
      const note = notes.get(id);
      if (!note) continue;
      const item = { note, at: f.latest.created_at, correction: f.latest.correction, useful: f.useful };
      if (f.latest.outcome === 'dead_end') out.deadEnds.push(item);
      else if (f.latest.outcome === 'corrected') out.corrections.push(item);
      else if (f.useful >= 2 && f.score > 0) out.proven.push(item);
    }
    for (const list of Object.values(out)) list.sort((a, b) => b.at - a.at).splice(limit);
    return out;
  }

  // ---- snapshots ----------------------------------------------------------

  maxIds() {
    return {
      entity: this.#s('SELECT COALESCE(MAX(id), 0) AS n FROM entities').get().n,
      fact: this.#s('SELECT COALESCE(MAX(id), 0) AS n FROM relations').get().n,
    };
  }

  saveSnapshot({ project, session_id, data, at = Date.now() }) {
    const ids = this.maxIds();
    return this.#s(`INSERT OR IGNORE INTO graph_snapshots(project, session_id, created_at, max_entity_id, max_fact_id, data)
                    VALUES (?, ?, ?, ?, ?, ?)`)
      .run(project || 'default', session_id, at, ids.entity, ids.fact, JSON.stringify(data || {})).changes > 0;
  }

  latestSnapshot(project, { excludeSession } = {}) {
    const row = excludeSession
      ? this.#s('SELECT * FROM graph_snapshots WHERE project = ? AND session_id != ? ORDER BY created_at DESC, id DESC LIMIT 1').get(project || 'default', excludeSession)
      : this.#s('SELECT * FROM graph_snapshots WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(project || 'default');
    if (!row) return null;
    let data = {};
    try { data = JSON.parse(row.data); } catch {}
    return { ...plain(row), data };
  }

  hasSnapshot(project, session_id) {
    return Boolean(this.#s('SELECT 1 FROM graph_snapshots WHERE project = ? AND session_id = ?').get(project || 'default', session_id));
  }

  // What was added or replaced after a snapshot was taken.
  changesSince(project, snap, { limit = 5 } = {}) {
    const p = project || 'default';
    const count = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const entities = this.db.prepare(`SELECT * FROM entities WHERE project = ? AND id > ? AND kind != 'file'
                                      ORDER BY mention_count DESC, id LIMIT ?`).all(p, snap.max_entity_id, limit).map(plain);
    const facts = this.db.prepare(`SELECT * FROM relations WHERE project = ? AND id > ? AND valid_to IS NULL AND type != 'changed with'
                                   ORDER BY id DESC LIMIT ?`).all(p, snap.max_fact_id, limit).map((r) => this.#factRow(r));
    const replaced = this.db.prepare(`SELECT * FROM relations WHERE project = ? AND valid_to IS NOT NULL AND superseded_by IS NOT NULL
                                        AND valid_to >= ? AND id <= ? ORDER BY valid_to DESC LIMIT ?`)
      .all(p, snap.created_at, snap.max_fact_id, limit)
      .map((r) => ({ old: this.#factRow(r), now: this.getFact(r.superseded_by) }));
    return {
      entities,
      entityCount: count("SELECT COUNT(*) AS n FROM entities WHERE project = ? AND id > ? AND kind != 'file'", p, snap.max_entity_id),
      facts,
      factCount: count("SELECT COUNT(*) AS n FROM relations WHERE project = ? AND id > ? AND valid_to IS NULL AND type != 'changed with'", p, snap.max_fact_id),
      replaced,
    };
  }

  // ---- work state (to-do lists) --------------------------------------------

  upsertWorkItem({ project, list, entity_id, status, note, at = Date.now() }) {
    this.#s(`INSERT INTO work_state(project, list, entity_id, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, list, entity_id) DO UPDATE SET status = excluded.status,
               note = COALESCE(excluded.note, work_state.note), updated_at = excluded.updated_at`)
      .run(project || 'default', list, Number(entity_id), status, note || null, at, at);
    this.#s('UPDATE entities SET status = ?, last_seen = MAX(last_seen, ?) WHERE id = ?').run(status, at, Number(entity_id));
  }

  listWork({ project, list, includeClosed = false } = {}) {
    const where = ['w.project = ?'];
    const args = [project || 'default'];
    if (list) { where.push('w.list = ?'); args.push(list); }
    if (!includeClosed) where.push("w.status IN ('todo', 'doing')");
    return this.db.prepare(`SELECT w.*, e.name FROM work_state w JOIN entities e ON e.id = w.entity_id
                            WHERE ${where.join(' AND ')}
                            ORDER BY w.list, CASE w.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, w.updated_at DESC`)
      .all(...args).map(plain);
  }

  // ---- corpora --------------------------------------------------------------

  saveCorpus({ project, name, description, filters, note_ids, at = Date.now() }) {
    this.#s(`INSERT INTO corpora(project, name, description, filters, note_ids, built_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, name) DO UPDATE SET description = COALESCE(excluded.description, corpora.description),
               filters = excluded.filters, note_ids = excluded.note_ids, built_at = excluded.built_at`)
      .run(project || 'default', name, description || null, JSON.stringify(filters || {}), JSON.stringify(note_ids || []), at);
    return this.getCorpus(project, name);
  }

  getCorpus(project, name) {
    const row = this.#s('SELECT * FROM corpora WHERE project = ? AND name = ?').get(project || 'default', name);
    if (!row) return null;
    return { ...plain(row), filters: JSON.parse(row.filters), note_ids: JSON.parse(row.note_ids) };
  }

  listCorpora(project) {
    const p = projectFilter(project);
    return this.db.prepare(`SELECT * FROM corpora${p ? ' WHERE project = ?' : ''} ORDER BY built_at DESC`).all(...(p ? [p] : []))
      .map((r) => ({ ...plain(r), filters: JSON.parse(r.filters), note_ids: JSON.parse(r.note_ids) }));
  }

  deleteCorpus(project, name) {
    return this.#s('DELETE FROM corpora WHERE project = ? AND name = ?').run(project || 'default', name).changes;
  }

  // ---- export / import ----------------------------------------------------

  exportGraph({ project } = {}) {
    const p = projectFilter(project);
    const where = p ? ' WHERE project = ?' : '';
    const a = p ? [p] : [];
    const entities = this.db.prepare(`SELECT * FROM entities${where} ORDER BY id`).all(...a).map((e) => this.#hydrate(e));
    const ids = new Set(entities.map((e) => e.id));
    const relations = this.db.prepare(`SELECT * FROM relations${where} ORDER BY id`).all(...a).map(plain);
    const mentions = this.db.prepare('SELECT * FROM mentions ORDER BY entity_id, note_id').all().map(plain).filter((m) => ids.has(m.entity_id));
    return { entities, relations, mentions };
  }

  // noteIds maps exported observation ids to their ids in this database.
  importGraph(data, noteIds = new Map()) {
    const counts = { entities: 0, facts: 0, mentions: 0 };
    if (!data?.entities) return counts;
    return this.tx(() => {
      const ent = new Map();
      for (const e of data.entities) {
        const found = this.findEntity({ project: e.project, name: e.name, kind: e.kind });
        let id = found?.id;
        if (!id) {
          const key = nameKey(e.name, kindKey(e.kind));
          if (!key) continue;
          id = Number(this.#s(`INSERT INTO entities(project, kind, name, key, summary, status, first_seen, last_seen)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(e.project, kindKey(e.kind), displayName(e.name), key, e.summary || null, e.status || null,
              e.first_seen || Date.now(), e.last_seen || Date.now()).lastInsertRowid);
          counts.entities++;
        }
        ent.set(e.id, id);
        for (const alias of e.aliases || []) this.addAlias(id, alias);
      }
      const rel = new Map();
      const mapNote = (kind, id) => (kind === 'observation' ? noteIds.get(id) ?? null : null);
      for (const r of data.relations || []) {
        const src = ent.get(r.src);
        const dst = ent.get(r.dst);
        if (!src || !dst) continue;
        const dup = this.#s('SELECT id FROM relations WHERE src = ? AND type = ? AND dst = ? AND valid_from = ?').get(src, r.type, dst, r.valid_from);
        if (dup) { rel.set(r.id, dup.id); continue; }
        const id = Number(this.#s(`INSERT INTO relations(project, src, type, dst, fact, why, confidence, score, valid_from, valid_to,
                                     note_kind, note_id, session_id, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(r.project, src, r.type, dst, r.fact || null, r.why || null, normConfidence(r.confidence), r.score ?? null,
            r.valid_from, r.valid_to ?? null, r.note_kind || null, mapNote(r.note_kind, r.note_id), r.session_id || null,
            r.created_at || Date.now(), r.updated_at || Date.now()).lastInsertRowid);
        rel.set(r.id, id);
        counts.facts++;
      }
      for (const r of data.relations || []) {
        if (r.superseded_by && rel.has(r.id) && rel.has(r.superseded_by)) {
          this.#s('UPDATE relations SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(rel.get(r.superseded_by), rel.get(r.id));
        }
      }
      for (const m of data.mentions || []) {
        const e = ent.get(m.entity_id);
        const note = m.note_kind === 'observation' ? noteIds.get(m.note_id) : null;
        if (e && note && this.addMention(e, m.note_kind, note, m.role, m.created_at)) counts.mentions++;
      }
      return counts;
    });
  }

  // ---- overview -----------------------------------------------------------

  stats(project) {
    const p = projectFilter(project);
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const w = p ? ' AND project = ?' : '';
    const a = p ? [p] : [];
    return {
      entities: one(`SELECT COUNT(*) AS n FROM entities WHERE 1 = 1${w}`, ...a),
      facts: one(`SELECT COUNT(*) AS n FROM relations WHERE valid_to IS NULL${w}`, ...a),
      closed_facts: one(`SELECT COUNT(*) AS n FROM relations WHERE valid_to IS NOT NULL${w}`, ...a),
      mentions: p
        ? one('SELECT COUNT(*) AS n FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE e.project = ?', p)
        : one('SELECT COUNT(*) AS n FROM mentions'),
      review: one(`SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'${w}`, ...a),
    };
  }
}
