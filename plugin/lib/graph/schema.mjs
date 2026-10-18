// Graph tables. Version 2: entities are the nodes, relations are the facts
// (edges) with a validity window, mentions link notes to entities.
// Version 3: the review queue for unsure merges, ambiguous facts and
// near-duplicate notes.

export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  score REAL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(kind, a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_review_open ON review_queue(status, project, created_at DESC);
`;

// Version 4: feedback on memories (useful / dead end / corrected) and a
// snapshot of the graph at each session start, for "since last session".
export const INSIGHT_SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  correction TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project, created_at DESC);

CREATE TABLE IF NOT EXISTS graph_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  max_entity_id INTEGER NOT NULL,
  max_fact_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(project, session_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON graph_snapshots(project, created_at DESC);
`;

// Version 5: to-do lists kept across sessions (each item is also a task
// entity), saved knowledge corpora, and optional embedding vectors.
export const WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  list TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project, list, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_work_state ON work_state(project, list, updated_at DESC);

CREATE TABLE IF NOT EXISTS corpora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  filters TEXT NOT NULL,
  note_ids TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  UNIQUE(project, name)
);

CREATE TABLE IF NOT EXISTS embeddings (
  note_kind TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_kind, note_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project, model);
`;

export const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  summary TEXT,
  status TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(project, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_entities_key ON entities(project, key);
CREATE INDEX IF NOT EXISTS idx_entities_recent ON entities(project, last_seen DESC);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (entity_id, key)
);
CREATE INDEX IF NOT EXISTS idx_aliases_key ON entity_aliases(key);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  src INTEGER NOT NULL,
  type TEXT NOT NULL,
  dst INTEGER NOT NULL,
  fact TEXT,
  why TEXT,
  confidence TEXT NOT NULL DEFAULT 'INFERRED',
  score REAL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  superseded_by INTEGER,
  note_kind TEXT,
  note_id INTEGER,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_out ON relations(src, valid_to);
CREATE INDEX IF NOT EXISTS idx_rel_in ON relations(dst, valid_to);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relations(src, type, valid_from);
CREATE INDEX IF NOT EXISTS idx_rel_project ON relations(project, valid_to);

CREATE TABLE IF NOT EXISTS mentions (
  entity_id INTEGER NOT NULL,
  note_kind TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'mention',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, note_kind, note_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_note ON mentions(note_kind, note_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, aliases, summary, tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS ent_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, aliases, summary) VALUES (new.id, new.name, '', new.summary);
END;
CREATE TRIGGER IF NOT EXISTS ent_au AFTER UPDATE OF name, summary ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid = old.id;
  INSERT INTO entities_fts(rowid, name, aliases, summary)
  VALUES (new.id, new.name, COALESCE((SELECT group_concat(alias, ' ') FROM entity_aliases WHERE entity_id = new.id), ''), new.summary);
END;
CREATE TRIGGER IF NOT EXISTS ent_ad AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS alias_ai AFTER INSERT ON entity_aliases BEGIN
  DELETE FROM entities_fts WHERE rowid = new.entity_id;
  INSERT INTO entities_fts(rowid, name, aliases, summary)
  SELECT id, name, COALESCE((SELECT group_concat(alias, ' ') FROM entity_aliases WHERE entity_id = new.entity_id), ''), summary
  FROM entities WHERE id = new.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS alias_ad AFTER DELETE ON entity_aliases BEGIN
  DELETE FROM entities_fts WHERE rowid = old.entity_id;
  INSERT INTO entities_fts(rowid, name, aliases, summary)
  SELECT id, name, COALESCE((SELECT group_concat(alias, ' ') FROM entity_aliases WHERE entity_id = old.entity_id), ''), summary
  FROM entities WHERE id = old.entity_id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  type, fact, why, content='relations', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS rel_ai AFTER INSERT ON relations BEGIN
  INSERT INTO facts_fts(rowid, type, fact, why) VALUES (new.id, new.type, new.fact, new.why);
END;
CREATE TRIGGER IF NOT EXISTS rel_ad AFTER DELETE ON relations BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, type, fact, why) VALUES ('delete', old.id, old.type, old.fact, old.why);
END;
CREATE TRIGGER IF NOT EXISTS rel_au AFTER UPDATE OF type, fact, why ON relations BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, type, fact, why) VALUES ('delete', old.id, old.type, old.fact, old.why);
  INSERT INTO facts_fts(rowid, type, fact, why) VALUES (new.id, new.type, new.fact, new.why);
END;
`;
