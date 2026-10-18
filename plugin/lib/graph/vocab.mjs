// Entity kinds and relation names come from the active mode (modes/*.json).
// Modes without a graph section get these defaults.
import { kindKey } from './names.mjs';
import { relationType } from './store.mjs';

const DEFAULT_KINDS = [
  { id: 'person', description: 'someone involved' },
  { id: 'organisation', description: 'company, client, team' },
  { id: 'project', description: 'a piece of work with a goal' },
  { id: 'document', description: 'file, report, page, dataset' },
  { id: 'tool', description: 'software, service, library' },
  { id: 'topic', description: 'subject, area, concept' },
  { id: 'task', description: 'something to do' },
  { id: 'decision', description: 'a choice that was made' },
  { id: 'preference', description: 'how someone likes things done' },
];

const DEFAULT_RELATIONS = [
  { id: 'uses' }, { id: 'part of' }, { id: 'about' }, { id: 'needs' }, { id: 'decided' },
  { id: 'prefers', single: true }, { id: 'owned by', single: true }, { id: 'related to' },
];

export const TASK_STATUSES = ['todo', 'doing', 'done', 'dropped'];

export function entityKinds(mode) {
  const kinds = Array.isArray(mode?.entities) && mode.entities.length ? mode.entities : DEFAULT_KINDS;
  return kinds.map((k) => (typeof k === 'string' ? { id: k, description: '' } : k));
}

export function relationTypes(mode) {
  const rels = Array.isArray(mode?.relations) && mode.relations.length ? mode.relations : DEFAULT_RELATIONS;
  return rels.map((r) => (typeof r === 'string' ? { id: r } : r));
}

// Unknown kinds become "topic" so the same thing isn't split across many
// made-up kinds. Files are always allowed (they come from tool calls).
export function normalizeKind(mode, kind) {
  const k = kindKey(kind);
  if (k === 'file') return k;
  const known = entityKinds(mode).map((x) => kindKey(x.id));
  if (known.includes(k)) return k;
  return known.includes('topic') ? 'topic' : known[known.length - 1] || 'topic';
}

// Relations that hold one value at a time: a new value closes the old one.
export function isSingle(mode, type) {
  const t = relationType(type);
  if (t.startsWith('prefers')) return true;
  return relationTypes(mode).some((r) => r.single && relationType(r.id) === t);
}
