// Optional meaning-based search with local embeddings (a free, private
// stand-in for claude-mem's Chroma). Off by default. Turn it on with an
// OpenAI-compatible embeddings server, e.g. Ollama:
//   ollama pull nomic-embed-text
//   cmem settings set embeddings.enabled true
// Vectors are stored in memory.db and compared in plain JavaScript.
import { log } from './config.mjs';

const BATCH = 32;

export function embeddingsOn(store, settings) {
  return Boolean(settings.embeddings?.enabled && store.graph);
}

export function noteText(o) {
  return [o.title, o.subtitle, o.narrative, ...(o.facts || [])].filter(Boolean).join('\n').slice(0, 4000);
}

export async function embed(settings, texts) {
  const e = settings.embeddings;
  const base = String(e.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
  const key = process.env.OPENAI_API_KEY || e.apiKey;
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: e.model, input: texts }),
    signal: AbortSignal.timeout(e.timeoutMs || 15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${JSON.stringify(body.error || body).slice(0, 200)}`);
  const data = [...(body.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) throw new Error('embeddings server returned the wrong number of vectors');
  return data.map((d) => Float32Array.from(d.embedding));
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}

export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
}

// Embeds notes that have no vector yet for the configured model.
export async function embedMissing(store, settings, { project, limit = 200 } = {}) {
  if (!embeddingsOn(store, settings)) return 0;
  const db = store.db;
  const model = settings.embeddings.model;
  const rows = db.prepare(`SELECT o.* FROM observations o
      LEFT JOIN embeddings e ON e.note_kind = 'observation' AND e.note_id = o.id AND e.model = ?
      WHERE e.note_id IS NULL${project ? ' AND o.project = ?' : ''} ORDER BY o.id DESC LIMIT ?`)
    .all(...[model, ...(project ? [project] : []), limit]);
  if (!rows.length) return 0;
  const notes = store.getObservations(rows.map((r) => r.id));
  let done = 0;
  for (let i = 0; i < notes.length; i += BATCH) {
    const part = notes.slice(i, i + BATCH);
    const vectors = await embed(settings, part.map(noteText));
    const ins = db.prepare(`INSERT OR REPLACE INTO embeddings(note_kind, note_id, project, model, dim, vector, created_at)
                            VALUES ('observation', ?, ?, ?, ?, ?, ?)`);
    part.forEach((o, j) => ins.run(o.id, o.project, model, vectors[j].length, toBlob(vectors[j]), Date.now()));
    done += part.length;
  }
  return done;
}

// Notes closest in meaning to the query → [{ ...observation, similarity }].
export async function semanticSearch(store, settings, query, { project, limit = 20, minSimilarity = 0.3 } = {}) {
  if (!embeddingsOn(store, settings) || !String(query || '').trim()) return [];
  try {
    const [q] = await embed(settings, [String(query).slice(0, 2000)]);
    const model = settings.embeddings.model;
    const p = project && project !== '*' && project !== 'all' ? project : null;
    const rows = store.db.prepare(`SELECT note_id, vector FROM embeddings WHERE note_kind = 'observation' AND model = ?${p ? ' AND project = ?' : ''}`)
      .all(...[model, ...(p ? [p] : [])]);
    const scored = rows.map((r) => ({ id: r.note_id, similarity: cosine(q, fromBlob(r.vector)) }))
      .filter((r) => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    const notes = new Map(store.getObservations(scored.map((r) => r.id)).map((o) => [o.id, o]));
    return scored.filter((r) => notes.has(r.id)).map((r) => ({ ...notes.get(r.id), similarity: r.similarity }));
  } catch (err) {
    log(settings.dataDir, 'warn', 'semantic search skipped', err);
    return [];
  }
}

export function embeddingStats(store, settings) {
  if (!store.graph) return null;
  const model = settings.embeddings?.model;
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE model = ?').get(model).n;
  const total = store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
  return { enabled: Boolean(settings.embeddings?.enabled), model, vectors: n, notes: total };
}
