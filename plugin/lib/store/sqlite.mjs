// SQLite backend on Node's built-in node:sqlite (Node 22.5+). FTS5 provides
// full-text search; WAL + busy_timeout lets hooks write concurrently.
import fs from 'node:fs';
import path from 'node:path';
import {
  JSON_FIELDS, OBSERVATION_FIELDS, SUMMARY_FIELDS,
  normalizeObservation, normalizeSummary, tokenize, projectFilter, ftsQuery,
} from './common.mjs';
import { GRAPH_SCHEMA, REVIEW_SCHEMA, INSIGHT_SCHEMA, WORK_SCHEMA } from '../graph/schema.mjs';
import { GraphStore } from '../graph/store.mjs';

export const SCHEMA_VERSION = 5;
const KEEP_BACKUPS = 5;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  cwd TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  prompt_count INTEGER NOT NULL DEFAULT 0,
  last_assistant TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, started_at DESC);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, prompt_number);
CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_output TEXT,
  cwd TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, session_id, id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  narrative TEXT,
  facts TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  source TEXT NOT NULL DEFAULT 'llm',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL DEFAULT 0,
  request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_project ON summaries(project, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, facts, concepts, files_read, files_modified,
  content='observations', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files_read, new.files_modified);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files_read, old.files_modified);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files_read, old.files_modified);
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files_read, new.files_modified);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content='summaries', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sum_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS sum_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  text, content='prompts', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS pr_ai AFTER INSERT ON prompts BEGIN
  INSERT INTO prompts_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS pr_ad AFTER DELETE ON prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

function inflateObservation(row) {
  if (!row) return row;
  const o = { ...row };
  for (const f of JSON_FIELDS) {
    try { o[f] = o[f] ? JSON.parse(o[f]) : []; } catch { o[f] = []; }
  }
  return o;
}

function plain(row) {
  return row ? { ...row } : row;
}

// Numbered upgrades. Each runs once, in order, inside one transaction.
// They only ever add tables, so older data is never rewritten.
const MIGRATIONS = {
  1: (store) => store.db.exec(SCHEMA_V1),
  2: (store) => {
    store.db.exec(GRAPH_SCHEMA);
    store.graph.backfill({ parse: inflateObservation });
  },
  3: (store) => store.db.exec(REVIEW_SCHEMA),
  4: (store) => store.db.exec(INSIGHT_SCHEMA),
  5: (store) => store.db.exec(WORK_SCHEMA),
};

export class SqliteStore {
  static async open(dataDir) {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'memory.db');
    const db = new DatabaseSync(file);
    return new SqliteStore(db, file);
  }

  constructor(db, file) {
    this.kind = 'sqlite';
    this.file = file;
    this.db = db;
    db.exec('PRAGMA busy_timeout = 10000');
    try { db.exec('PRAGMA journal_mode = WAL'); } catch {}
    db.exec('PRAGMA synchronous = NORMAL');
    this.stmts = new Map();
    this.txDepth = 0;
    this.backupFile = null;
    const current = this.#schemaVersion();
    if (current < SCHEMA_VERSION) this.#migrate(current);
  }

  get schemaVersion() {
    return this.#schemaVersion();
  }

  // Graph layer (entities, facts, mentions) sharing this connection.
  get graph() {
    if (!this._graph) this._graph = new GraphStore(this.db, (fn) => this.#tx(fn));
    return this._graph;
  }

  #migrate(from) {
    // An existing database is copied first; a brand-new one has nothing to lose.
    if (from > 0) this.backupFile = this.#backup(from);
    this.#tx(() => {
      // Another process may have upgraded while we waited for the lock.
      for (let v = this.#schemaVersion() + 1; v <= SCHEMA_VERSION; v++) {
        MIGRATIONS[v](this);
        this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(v));
      }
    });
  }

  #backup(version) {
    if (!this.file || this.file === ':memory:') return null;
    const dir = path.join(path.dirname(this.file), 'backups');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(dir, `memory-v${version}-${stamp}-${process.pid}.db`);
      this.db.prepare('VACUUM INTO ?').run(target);
      const old = fs.readdirSync(dir).filter((f) => /^memory-v\d+-.*\.db$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, f), { force: true });
      return target;
    } catch {
      // The upgrade only adds tables, so it is still safe to continue.
      return null;
    }
  }

  #schemaVersion() {
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  #s(sql) {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  // Re-entrant: a nested call joins the transaction already open.
  #tx(fn) {
    if (this.txDepth > 0) {
      this.txDepth++;
      try { return fn(); } finally { this.txDepth--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  close() {
    try { this.db.close(); } catch {}
  }

  // Small JSON values kept in the meta table (e.g. which files were imported).
  getMeta(key) {
    const row = this.#s('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  setMeta(key, value) {
    this.#s('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  // ---- sessions ---------------------------------------------------------

  upsertSession({ session_id, project, cwd, platform = 'claude-code' }) {
    const now = Date.now();
    this.#s(`INSERT INTO sessions(session_id, project, cwd, platform, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at,
               status = CASE WHEN sessions.status = 'ended' THEN 'active' ELSE sessions.status END`)
      .run(session_id, project, cwd || null, platform, now, now);
    return this.getSession(session_id);
  }

  getSession(session_id) {
    return plain(this.#s('SELECT * FROM sessions WHERE session_id = ?').get(session_id));
  }

  nextPromptNumber(session_id) {
    return this.#tx(() => {
      this.#s('UPDATE sessions SET prompt_count = prompt_count + 1, updated_at = ? WHERE session_id = ?').run(Date.now(), session_id);
      const row = this.#s('SELECT prompt_count FROM sessions WHERE session_id = ?').get(session_id);
      return row ? row.prompt_count : 1;
    });
  }

  setLastAssistant(session_id, text) {
    this.#s('UPDATE sessions SET last_assistant = ?, updated_at = ? WHERE session_id = ?').run(text || null, Date.now(), session_id);
  }

  endSession(session_id) {
    const now = Date.now();
    this.#s("UPDATE sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE session_id = ?").run(now, now, session_id);
  }

  listSessions({ project, limit = 50, offset = 0 } = {}) {
    const p = projectFilter(project);
    const sql = `SELECT s.*,
        (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.session_id) AS observation_count,
        (SELECT text FROM prompts pr WHERE pr.session_id = s.session_id ORDER BY prompt_number LIMIT 1) AS first_prompt
      FROM sessions s ${p ? 'WHERE s.project = ?' : ''} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`;
    const args = p ? [p, limit, offset] : [limit, offset];
    return this.#s(sql).all(...args).map(plain);
  }

  deleteSession(session_id) {
    return this.#tx(() => {
      for (const { id } of this.#s('SELECT id FROM observations WHERE session_id = ?').all(session_id)) {
        this.graph.forgetObservation(id);
      }
      for (const t of ['observations', 'summaries', 'prompts', 'events']) {
        this.#s(`DELETE FROM ${t} WHERE session_id = ?`).run(session_id);
      }
      return this.#s('DELETE FROM sessions WHERE session_id = ?').run(session_id).changes;
    });
  }

  // ---- prompts ----------------------------------------------------------

  addPrompt({ session_id, project, prompt_number, text, created_at }) {
    const r = this.#s('INSERT INTO prompts(session_id, project, prompt_number, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(session_id, project, prompt_number, text, created_at || Date.now());
    return Number(r.lastInsertRowid);
  }

  getPrompt(session_id, prompt_number) {
    return plain(this.#s('SELECT * FROM prompts WHERE session_id = ? AND prompt_number = ? ORDER BY id DESC LIMIT 1').get(session_id, prompt_number));
  }

  recentPrompts({ project, session_id, limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    const p = projectFilter(project);
    if (p) { where.push('project = ?'); args.push(p); }
    if (session_id) { where.push('session_id = ?'); args.push(session_id); }
    const sql = `SELECT * FROM prompts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.#s(sql).all(...args, limit, offset).map(plain);
  }

  // ---- raw tool events (the observer's input queue) -----------------------

  addEvent({ session_id, project, prompt_number = 0, tool_name, tool_input, tool_output, cwd, failed = false }) {
    const r = this.#s(`INSERT INTO events(session_id, project, prompt_number, tool_name, tool_input, tool_output, cwd, failed, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session_id, project, prompt_number, tool_name, tool_input ?? '', tool_output ?? '', cwd || null, failed ? 1 : 0, Date.now());
    return Number(r.lastInsertRowid);
  }

  claimEvents(session_id, limit = 300) {
    return this.#tx(() => {
      const rows = this.#s(`UPDATE events SET status = 'processing', claimed_at = ?, attempts = attempts + 1
                            WHERE id IN (SELECT id FROM events WHERE status = 'pending' AND session_id = ? ORDER BY id LIMIT ?)
                            RETURNING *`).all(Date.now(), session_id, limit);
      return rows.map(plain).sort((a, b) => a.id - b.id);
    });
  }

  finishEvents(ids, status = 'done') {
    if (!ids.length) return;
    this.#tx(() => {
      const st = this.#s('UPDATE events SET status = ? WHERE id = ?');
      for (const id of ids) st.run(status, id);
    });
  }

  releaseEvents(ids, maxAttempts = 3) {
    if (!ids.length) return;
    this.#tx(() => {
      const st = this.#s("UPDATE events SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, claimed_at = NULL WHERE id = ?");
      for (const id of ids) st.run(maxAttempts, id);
    });
  }

  // olderThanMs = 0 releases everything claimed up to now (same millisecond included).
  resetStaleEvents(olderThanMs = 10 * 60 * 1000) {
    return this.#s("UPDATE events SET status = 'pending', claimed_at = NULL WHERE status = 'processing' AND claimed_at <= ?")
      .run(Date.now() - olderThanMs).changes;
  }

  pendingSessions() {
    return this.#s("SELECT session_id, COUNT(*) AS n FROM events WHERE status = 'pending' GROUP BY session_id").all().map(plain);
  }

  countPendingEvents(session_id) {
    const row = session_id
      ? this.#s("SELECT COUNT(*) AS n FROM events WHERE status IN ('pending','processing') AND session_id = ?").get(session_id)
      : this.#s("SELECT COUNT(*) AS n FROM events WHERE status IN ('pending','processing')").get();
    return row.n;
  }

  recentEvents({ session_id, prompt_number, limit = 100 } = {}) {
    let rows;
    if (session_id && prompt_number !== undefined) rows = this.#s('SELECT * FROM events WHERE session_id = ? AND prompt_number = ? ORDER BY id DESC LIMIT ?').all(session_id, Number(prompt_number), limit);
    else if (session_id) rows = this.#s('SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(session_id, limit);
    else rows = this.#s('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(plain);
  }

  pruneEvents(keepDays = 7) {
    const cutoff = Date.now() - keepDays * 86400000;
    return this.#s("DELETE FROM events WHERE status IN ('done','failed','skipped') AND created_at < ?").run(cutoff).changes;
  }

  // ---- observations -----------------------------------------------------

  addObservation(input) {
    const o = normalizeObservation(input);
    const values = OBSERVATION_FIELDS.map((f) => (JSON_FIELDS.includes(f) ? JSON.stringify(o[f]) : o[f]));
    return this.#tx(() => {
      const r = this.#s(`INSERT INTO observations(${OBSERVATION_FIELDS.join(', ')}) VALUES (${OBSERVATION_FIELDS.map(() => '?').join(', ')})`)
        .run(...values);
      const id = Number(r.lastInsertRowid);
      this.graph.indexObservation({ ...o, id });
      return id;
    });
  }

  updateObservation(id, patch) {
    const cur = this.getObservation(id);
    if (!cur) return null;
    const o = normalizeObservation({ ...cur, ...patch });
    const fields = OBSERVATION_FIELDS.filter((f) => f !== 'created_at');
    const values = fields.map((f) => (JSON_FIELDS.includes(f) ? JSON.stringify(o[f]) : o[f]));
    this.#tx(() => {
      this.#s(`UPDATE observations SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
      this.graph.indexObservation({ ...o, id: cur.id, created_at: cur.created_at });
    });
    return this.getObservation(id);
  }

  getObservation(id) {
    return inflateObservation(plain(this.#s('SELECT * FROM observations WHERE id = ?').get(Number(id))));
  }

  getObservations(ids) {
    const list = [...new Set(ids.map(Number).filter(Number.isFinite))].slice(0, 100);
    if (!list.length) return [];
    const rows = this.db.prepare(`SELECT * FROM observations WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
    const byId = new Map(rows.map((r) => [r.id, inflateObservation(plain(r))]));
    return list.map((id) => byId.get(id)).filter(Boolean);
  }

  recentObservations({ project, session_id, type, limit = 50, offset = 0, since } = {}) {
    const where = [];
    const args = [];
    const p = projectFilter(project);
    if (p) { where.push('project = ?'); args.push(p); }
    if (session_id) { where.push('session_id = ?'); args.push(session_id); }
    if (type) { where.push('type = ?'); args.push(type); }
    if (since) { where.push('created_at >= ?'); args.push(since); }
    const sql = `SELECT * FROM observations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.#s(sql).all(...args, limit, offset).map((r) => inflateObservation(plain(r)));
  }

  deleteObservation(id) {
    return this.#tx(() => {
      this.graph.forgetObservation(Number(id));
      return this.#s('DELETE FROM observations WHERE id = ?').run(Number(id)).changes;
    });
  }

  timelineAround({ id, before = 5, after = 5, project }) {
    const anchor = this.getObservation(id);
    if (!anchor) return null;
    const p = projectFilter(project) || anchor.project;
    const older = this.#s('SELECT * FROM observations WHERE project = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(p, anchor.created_at, anchor.created_at, anchor.id, before).map((r) => inflateObservation(plain(r))).reverse();
    const newer = this.#s('SELECT * FROM observations WHERE project = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?')
      .all(p, anchor.created_at, anchor.created_at, anchor.id, after).map((r) => inflateObservation(plain(r)));
    const lo = older[0]?.created_at ?? anchor.created_at;
    const hi = newer[newer.length - 1]?.created_at ?? anchor.created_at;
    const prompts = this.#s('SELECT * FROM prompts WHERE project = ? AND created_at BETWEEN ? AND ? ORDER BY created_at').all(p, lo - 60000, hi).map(plain);
    const summaries = this.#s('SELECT * FROM summaries WHERE project = ? AND created_at BETWEEN ? AND ? ORDER BY created_at').all(p, lo, hi + 600000).map(plain);
    return { anchor, observations: [...older, anchor, ...newer], prompts, summaries };
  }

  // ---- summaries --------------------------------------------------------

  addSummary(input) {
    const s = normalizeSummary(input);
    const r = this.#s(`INSERT INTO summaries(${SUMMARY_FIELDS.join(', ')}) VALUES (${SUMMARY_FIELDS.map(() => '?').join(', ')})`)
      .run(...SUMMARY_FIELDS.map((f) => s[f]));
    return Number(r.lastInsertRowid);
  }

  recentSummaries({ project, session_id, limit = 20, offset = 0 } = {}) {
    const where = [];
    const args = [];
    const p = projectFilter(project);
    if (p) { where.push('project = ?'); args.push(p); }
    if (session_id) { where.push('session_id = ?'); args.push(session_id); }
    const sql = `SELECT * FROM summaries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.#s(sql).all(...args, limit, offset).map(plain);
  }

  deleteSummary(id) {
    return this.#s('DELETE FROM summaries WHERE id = ?').run(Number(id)).changes;
  }

  // ---- search -----------------------------------------------------------

  search({ query, project, type, kind = 'observations', limit = 20, since, excludeSession } = {}) {
    limit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const p = projectFilter(project);
    if (!query || !tokenize(query).length) {
      if (kind === 'summaries') return this.recentSummaries({ project: p, limit });
      if (kind === 'prompts') return this.recentPrompts({ project: p, limit });
      return this.recentObservations({ project: p, type, limit, since });
    }
    for (const op of ['AND', 'OR']) {
      const q = ftsQuery(query, op);
      const rows = this.#searchKind(kind, q, { p, type, limit, since, excludeSession });
      if (rows.length) return rows;
    }
    return [];
  }

  #searchKind(kind, q, { p, type, limit, since, excludeSession }) {
    const where = [];
    const args = [q];
    if (p) { where.push('t.project = ?'); args.push(p); }
    if (since) { where.push('t.created_at >= ?'); args.push(since); }
    if (excludeSession) { where.push('t.session_id != ?'); args.push(excludeSession); }
    const extra = where.length ? ' AND ' + where.join(' AND ') : '';
    try {
      if (kind === 'summaries') {
        return this.db.prepare(`SELECT t.*, bm25(summaries_fts) AS score FROM summaries_fts f JOIN summaries t ON t.id = f.rowid
          WHERE summaries_fts MATCH ?${extra} ORDER BY score LIMIT ?`).all(...args, limit).map(plain);
      }
      if (kind === 'prompts') {
        return this.db.prepare(`SELECT t.*, bm25(prompts_fts) AS score FROM prompts_fts f JOIN prompts t ON t.id = f.rowid
          WHERE prompts_fts MATCH ?${extra} ORDER BY score LIMIT ?`).all(...args, limit).map(plain);
      }
      let typeClause = '';
      if (type) { typeClause = ' AND t.type = ?'; args.push(type); }
      return this.db.prepare(`SELECT t.*, bm25(observations_fts, 10.0, 4.0, 2.0, 3.0, 2.0, 1.0, 2.0) AS score
          FROM observations_fts f JOIN observations t ON t.id = f.rowid
          WHERE observations_fts MATCH ?${extra}${typeClause} ORDER BY score LIMIT ?`)
        .all(...args, limit).map((r) => inflateObservation(plain(r)));
    } catch {
      return [];
    }
  }

  // ---- overview ---------------------------------------------------------

  listProjects() {
    return this.#s(`SELECT project,
        COUNT(*) AS observations,
        MAX(created_at) AS last_at
      FROM observations GROUP BY project
      UNION ALL
      SELECT project, 0, MAX(started_at) FROM sessions
        WHERE project NOT IN (SELECT DISTINCT project FROM observations) GROUP BY project`)
      .all().map(plain).sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
  }

  stats(project) {
    const p = projectFilter(project);
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const w = p ? ' WHERE project = ?' : '';
    const a = p ? [p] : [];
    return {
      backend: 'sqlite',
      file: this.file,
      sessions: one(`SELECT COUNT(*) AS n FROM sessions${w}`, ...a),
      prompts: one(`SELECT COUNT(*) AS n FROM prompts${w}`, ...a),
      observations: one(`SELECT COUNT(*) AS n FROM observations${w}`, ...a),
      summaries: one(`SELECT COUNT(*) AS n FROM summaries${w}`, ...a),
      pending_events: one(`SELECT COUNT(*) AS n FROM events WHERE status IN ('pending','processing')${p ? ' AND project = ?' : ''}`, ...a),
      failed_events: one(`SELECT COUNT(*) AS n FROM events WHERE status = 'failed'${p ? ' AND project = ?' : ''}`, ...a),
      schema_version: this.#schemaVersion(),
      graph: this.graph.stats(p),
    };
  }

  latestIds() {
    const n = (t) => this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${t}`).get().n;
    return { observations: n('observations'), summaries: n('summaries'), prompts: n('prompts') };
  }

  since({ observations = 0, summaries = 0, prompts = 0 }) {
    return {
      observations: this.db.prepare('SELECT * FROM observations WHERE id > ? ORDER BY id LIMIT 100').all(observations).map((r) => inflateObservation(plain(r))),
      summaries: this.db.prepare('SELECT * FROM summaries WHERE id > ? ORDER BY id LIMIT 100').all(summaries).map(plain),
      prompts: this.db.prepare('SELECT * FROM prompts WHERE id > ? ORDER BY id LIMIT 100').all(prompts).map(plain),
    };
  }

  // ---- portability ------------------------------------------------------

  exportAll({ project } = {}) {
    const p = projectFilter(project);
    const all = (t) => (p ? this.db.prepare(`SELECT * FROM ${t} WHERE project = ? ORDER BY id`).all(p) : this.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).map(plain);
    return {
      format: 'claude-mem-local',
      version: 1,
      exported_at: new Date().toISOString(),
      sessions: all('sessions'),
      prompts: all('prompts'),
      observations: all('observations').map(inflateObservation),
      summaries: all('summaries'),
      graph: this.graph.exportGraph({ project: p }),
    };
  }

  importAll(data) {
    const counts = { sessions: 0, prompts: 0, observations: 0, summaries: 0, skipped: 0 };
    const noteIds = new Map();
    this.#tx(() => {
      for (const s of data.sessions || []) {
        const r = this.#s(`INSERT OR IGNORE INTO sessions(session_id, project, cwd, platform, status, prompt_count, last_assistant, started_at, updated_at, ended_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(s.session_id, s.project, s.cwd || null, s.platform || 'import', s.status || 'ended', s.prompt_count || 0, s.last_assistant || null,
            s.started_at || Date.now(), s.updated_at || Date.now(), s.ended_at || null);
        counts.sessions += r.changes;
      }
      const dup = (table, s, field) => this.db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? AND created_at = ? AND ${field} = ? LIMIT 1`).get(s.session_id, s.created_at, s[field]);
      for (const pr of data.prompts || []) {
        if (dup('prompts', pr, 'text')) { counts.skipped++; continue; }
        this.addPrompt(pr);
        counts.prompts++;
      }
      for (const o of data.observations || []) {
        const existing = this.db.prepare('SELECT id FROM observations WHERE session_id = ? AND created_at = ? AND title = ? LIMIT 1').get(o.session_id, o.created_at, o.title);
        if (existing) { counts.skipped++; noteIds.set(o.id, existing.id); continue; }
        noteIds.set(o.id, this.addObservation(o));
        counts.observations++;
      }
      for (const s of data.summaries || []) {
        if (dup('summaries', s, 'request')) { counts.skipped++; continue; }
        this.addSummary(s);
        counts.summaries++;
      }
      if (data.graph) counts.graph = this.graph.importGraph(data.graph, noteIds);
    });
    return counts;
  }

  vacuum() {
    this.db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
    this.db.exec("INSERT INTO entities_fts(entities_fts) VALUES('optimize')");
    this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES('optimize')");
    this.db.exec('VACUUM');
  }
}
