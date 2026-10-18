// Near-duplicate notes, following claude-mem's two tiers:
//   exact     – same title after normalising → skip the new note
//   candidate – word-weight (IDF) cosine of the titles is high AND no rare
//               word differs between them → keep it, ask in Review
// A rare word that only one title has (a name, a number, a file) usually
// means a different thing, so it vetoes the match.
import { tokenize } from './store/common.mjs';

export const COSINE_AT = 0.8;
const VETO_DF = 10;        // a word in at most this many titles is "rare"
const MIN_DOCS = 10;       // below this, word weights are unreliable
const WINDOW = 500;

const normTitle = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const idf = (df, n) => Math.log(1 + n / (df + 0.5));

function cosine(a, b, w) {
  const va = new Map();
  const vb = new Map();
  for (const t of a) va.set(t, (va.get(t) || 0) + w(t));
  for (const t of b) vb.set(t, (vb.get(t) || 0) + w(t));
  let dot = 0;
  for (const [t, x] of va) if (vb.has(t)) dot += x * vb.get(t);
  const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  const d = norm(va) * norm(vb);
  return d ? dot / d : 0;
}

// → { tier: 'exact' | 'candidate' | 'none', match?, score? }
export function findNearDuplicate(store, project, title) {
  const recent = store.recentObservations({ project, limit: WINDOW });
  const t = normTitle(title);
  const exact = recent.find((r) => normTitle(r.title) === t);
  if (exact) return { tier: 'exact', match: exact, score: 1 };
  if (recent.length < MIN_DOCS) return { tier: 'none' };
  const docs = recent.map((r) => tokenize(r.title));
  const df = new Map();
  for (const d of docs) for (const tok of new Set(d)) df.set(tok, (df.get(tok) || 0) + 1);
  const n = docs.length + 1;
  const weight = (tok) => idf(df.get(tok) || 0, n);
  const theta = idf(VETO_DF + 1, n);
  const mine = tokenize(title);
  if (!mine.length) return { tier: 'none' };
  let best = null;
  docs.forEach((d, i) => {
    const score = cosine(mine, d, weight);
    if (score < COSINE_AT || (best && best.score >= score)) return;
    const a = new Set(mine);
    const b = new Set(d);
    const vetoed = [...a].some((x) => !b.has(x) && weight(x) > theta) || [...b].some((x) => !a.has(x) && weight(x) > theta);
    if (!vetoed) best = { score, match: recent[i] };
  });
  return best ? { tier: 'candidate', ...best } : { tier: 'none' };
}
