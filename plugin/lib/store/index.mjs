// Picks the best available storage backend.
import fs from 'node:fs';
import path from 'node:path';

let sqliteAvailable;

async function hasSqlite() {
  if (sqliteAvailable !== undefined) return sqliteAvailable;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(a)');
    db.close();
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

export async function openStore(dataDir, { backend } = {}) {
  const forced = backend || process.env.CLAUDE_MEM_LOCAL_BACKEND;
  // Keep using the JSON file if that's where existing memory lives.
  const useJson = forced === 'json'
    || (forced !== 'sqlite' && (!(await hasSqlite()) || (fs.existsSync(path.join(dataDir, 'memory.json')) && !fs.existsSync(path.join(dataDir, 'memory.db')))));
  if (useJson) {
    const { JsonStore } = await import('./json.mjs');
    return JsonStore.open(dataDir);
  }
  const { SqliteStore } = await import('./sqlite.mjs');
  return SqliteStore.open(dataDir);
}
