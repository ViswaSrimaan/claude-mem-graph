// To-do lists and working state kept across sessions (claude-mem's
// work_state_write / work_state_read). Each item is a task entity in the
// knowledge graph, so open items also appear under "Open work" at session
// start and in the viewer's Graph tab; the list it belongs to and an
// optional note are kept beside it.
import { loadMode } from './modes.mjs';
import { resolveEntity } from './graph/ingest.mjs';
import { TASK_STATUSES } from './graph/vocab.mjs';
import { redactSecrets, stripPrivate } from './privacy.mjs';

const clean = (v, max) => redactSecrets(stripPrivate(String(v ?? '').trim())).slice(0, max);
export const DEFAULT_LIST = 'todo';

function items(args) {
  const raw = Array.isArray(args.items) ? args.items : args.task ? [args] : [];
  return raw.filter((i) => i && i.task).slice(0, 50).map((i) => {
    const status = String(i.status || 'todo').toLowerCase();
    return { task: clean(i.task, 200), status: TASK_STATUSES.includes(status) ? status : 'todo', note: i.note ? clean(i.note, 500) : null };
  }).filter((i) => i.task);
}

export function writeWorkState(store, settings, { project, list, ...args }) {
  const g = store.graph;
  if (!g) throw new Error('To-do lists need the SQLite store (Node 22.5+).');
  const mode = loadMode(settings.mode, settings.dataDir);
  const name = clean(list || DEFAULT_LIST, 60) || DEFAULT_LIST;
  const list_ = items(args);
  if (!list_.length) throw new Error('Pass items: [{ task, status, note? }] (status: todo | doing | done | dropped).');
  const at = Date.now();
  return g.tx(() => list_.map((i) => {
    // Close spellings of an existing task land on the same item.
    const r = resolveEntity(g, mode, { project, name: i.task, kind: 'task', status: i.status, at });
    g.upsertWorkItem({ project, list: name, entity_id: r.id, status: i.status, note: i.note, at });
    return { ...i, id: r.id, name: g.getEntity(r.id).name };
  }));
}

export function readWorkState(store, { project, list, includeClosed = false } = {}) {
  const g = store.graph;
  if (!g) throw new Error('To-do lists need the SQLite store (Node 22.5+).');
  return g.listWork({ project, list, includeClosed });
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export function formatWorkState(rows, { project, includeClosed }) {
  if (!rows.length) return `No ${includeClosed ? '' : 'open '}items for "${project}".`;
  const lists = new Map();
  for (const r of rows) {
    if (!lists.has(r.list)) lists.set(r.list, []);
    lists.get(r.list).push(r);
  }
  const out = [];
  for (const [name, rs] of lists) {
    const open = rs.filter((r) => r.status === 'todo' || r.status === 'doing').length;
    out.push(`${name} (${open} open):`);
    for (const r of rs) out.push(`- [${r.status}] ${r.name}${r.note ? ` — ${r.note}` : ''} (updated ${day(r.updated_at)})`);
  }
  return out.join('\n');
}
