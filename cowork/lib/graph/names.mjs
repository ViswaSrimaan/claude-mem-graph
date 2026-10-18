// Name keys: the cleaned form of an entity name used to spot the same thing
// written differently ("Acme Corp." and "acme" share the key "acme").

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'corp', 'corporation', 'co',
  'plc', 'gmbh', 'ag', 'sa', 'pvt', 'pty', 'bv', 'oy', 'ab',
]);

const KIND_ALIASES = {
  organization: 'organisation', org: 'organisation', company: 'organisation',
  people: 'person', user: 'person', doc: 'document', library: 'tool', package: 'tool',
};

export function cleanText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

export function fileKey(file) {
  return String(file ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

export function nameKey(name, kind) {
  if (kind === 'file') return fileKey(name);
  const tokens = cleanText(name).split(' ').filter(Boolean);
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

export function kindKey(kind) {
  const k = cleanText(kind).replace(/ /g, '_') || 'concept';
  return KIND_ALIASES[k] || k;
}

export function displayName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
