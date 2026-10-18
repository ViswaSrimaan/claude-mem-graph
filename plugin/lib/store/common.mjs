// Shared shapes for both storage backends.

export const JSON_FIELDS = ['facts', 'concepts', 'files_read', 'files_modified'];

export const OBSERVATION_FIELDS = [
  'session_id', 'project', 'prompt_number', 'type', 'title', 'subtitle', 'narrative',
  'facts', 'concepts', 'files_read', 'files_modified', 'source', 'created_at',
];

export const SUMMARY_FIELDS = [
  'session_id', 'project', 'prompt_number', 'request', 'investigated', 'learned',
  'completed', 'next_steps', 'notes', 'created_at',
];

export function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
    return [v];
  }
  return [];
}

export function normalizeObservation(o) {
  return {
    session_id: o.session_id || 'manual',
    project: o.project || 'default',
    prompt_number: Number(o.prompt_number) || 0,
    type: String(o.type || 'change').toLowerCase(),
    title: String(o.title || 'Untitled').slice(0, 200),
    subtitle: o.subtitle ? String(o.subtitle).slice(0, 300) : '',
    narrative: o.narrative ? String(o.narrative) : '',
    facts: asList(o.facts),
    concepts: asList(o.concepts),
    files_read: asList(o.files_read),
    files_modified: asList(o.files_modified),
    source: o.source || 'llm',
    created_at: Number(o.created_at) || Date.now(),
  };
}

export function normalizeSummary(s) {
  const str = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v));
  return {
    session_id: s.session_id || 'manual',
    project: s.project || 'default',
    prompt_number: Number(s.prompt_number) || 0,
    request: str(s.request),
    investigated: str(s.investigated),
    learned: str(s.learned),
    completed: str(s.completed),
    next_steps: str(s.next_steps),
    notes: str(s.notes),
    created_at: Number(s.created_at) || Date.now(),
  };
}

export function tokenize(query) {
  if (!query) return [];
  const words = String(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, 16);
}

// FTS5 MATCH expression: every token as a prefix term, joined by AND or OR.
export function ftsQuery(query, op) {
  const tokens = tokenize(query);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(op === 'OR' ? ' OR ' : ' ');
}

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'you', 'your', 'can',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'into', 'about', 'have', 'has', 'had',
  'not', 'but', 'all', 'any', 'our', 'out', 'use', 'using', 'please', 'let', 'its', 'it', 'is',
  'be', 'to', 'of', 'in', 'on', 'at', 'an', 'or', 'as', 'by', 'do', 'does', 'did', 'me', 'my',
  'we', 'us', 'so', 'if', 'then', 'there', 'here', 'just', 'also', 'make', 'need', 'want',
]);

// Projects filter: undefined/null/'' or '*'/'all' means no filter.
export function projectFilter(project) {
  if (!project || project === '*' || project === 'all') return null;
  return project;
}
