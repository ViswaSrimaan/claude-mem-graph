// Deciding whether two entity names mean the same thing. Approach follows
// Graphify's de-duplication guards (written from scratch): a high string
// similarity is not enough on its own, because short names, numbered
// siblings and names that swap a key word are usually different things.
// Inputs are name keys (see names.mjs), already lower-cased and cleaned.

export const MERGE_AT = 0.92;
export const REVIEW_AT = 0.85;

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'this', 'that', 'its']);

export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps).
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export function singular(token) {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

const digits = (s) => (s.match(/\d+/g) || []).map((n) => n.replace(/^0+(?=\d)/, '')).sort().join(',');

// "v2" / "v3", "ADR 0011" / "ADR 0013": numbered siblings, not duplicates.
export function numbersDiffer(a, b) {
  return digits(a) !== digits(b);
}

// One word misspelt (typo) rather than two different words.
export function sameWordVariant(x, y) {
  if (x.length === y.length && editDistance(x, y) <= 1) return true;
  if (Math.min(x.length, y.length) < 6) return false;
  return jaroWinkler(x, y) >= MERGE_AT;
}

// "sales report" / "legal report": same shape, a different key word.
export function contentWordSwapped(a, b) {
  const ta = a.split(' ');
  const tb = b.split(' ');
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y || STOPWORDS.has(x) || STOPWORDS.has(y) || sameWordVariant(x, y)) continue;
    return true;
  }
  return false;
}

// Short names get a high score from shared prefixes alone ("pane" / "plane",
// "m1" / "m1 pro"); only a same-length one-letter typo may merge.
export function shortNameBlocked(a, b, score) {
  if (Math.max(a.length, b.length) >= 12) return false;
  return !(score >= 0.97 && a.length === b.length && editDistance(a, b) <= 1);
}

// → { decision: 'merge' | 'review' | 'none', score, reason }
export function compareNames(a, b) {
  if (!a || !b) return { decision: 'none', score: 0, reason: 'empty' };
  if (a === b) return { decision: 'merge', score: 1, reason: 'same name' };
  const sa = a.split(' ').map(singular);
  const sb = b.split(' ').map(singular);
  if (sa.join(' ') === sb.join(' ')) return { decision: 'merge', score: 0.97, reason: 'singular/plural' };
  if (numbersDiffer(a, b)) return { decision: 'none', score: 0, reason: 'different numbers' };
  if (sa.length > 1 && [...sa].sort().join(' ') === [...sb].sort().join(' ')) return { decision: 'merge', score: 0.95, reason: 'word order' };
  const score = jaroWinkler(a, b);
  if (score < REVIEW_AT) return { decision: 'none', score, reason: 'not similar' };
  if (contentWordSwapped(a, b)) return { decision: 'none', score, reason: 'different key word' };
  if (score >= MERGE_AT && !shortNameBlocked(a, b, score)) return { decision: 'merge', score, reason: 'typo or spelling' };
  return { decision: 'review', score, reason: score >= MERGE_AT ? 'short name, unsure' : 'similar name' };
}
