// Explicit "remember this" writes, shared by the MCP server, CLI and viewer.
import { loadMode, validType } from './modes.mjs';
import { redactSecrets, stripPrivate } from './privacy.mjs';
import { asList } from './store/common.mjs';
import { ingestNote } from './graph/ingest.mjs';

const clean = (v, max) => redactSecrets(stripPrivate(String(v ?? '').trim())).slice(0, max);

// relations: [{ src, type, dst, fact?, why? }]; what you save yourself is
// STATED unless it says otherwise.
function graphInput(entities, relations) {
  const ents = (Array.isArray(entities) ? entities : [])
    .filter((e) => e && e.name).slice(0, 12)
    .map((e) => ({ name: clean(e.name, 120), kind: clean(e.kind, 40) || 'topic', status: clean(e.status, 20) }));
  const rels = (Array.isArray(relations) ? relations : [])
    .filter((r) => r && r.src && r.dst && r.type).slice(0, 12)
    .map((r) => ({
      src: clean(r.src, 120), type: clean(r.type, 60), dst: clean(r.dst, 120),
      fact: clean(r.fact, 300), why: clean(r.why, 300), confidence: clean(r.confidence, 12).toUpperCase() || 'STATED',
    }));
  return { entities: ents, relations: rels };
}

export function saveMemory(store, settings, { text, title, type, project, concepts, facts, files, session_id, entities, relations } = {}) {
  const body = redactSecrets(stripPrivate(String(text || '').trim()));
  if (!body) return { error: 'text is required', status: 400 };
  const mode = loadMode(settings.mode, settings.dataDir);
  const heading = String(title || '').trim() || body.split(/[.\n]/)[0].slice(0, 100);
  const id = store.addObservation({
    session_id: session_id || 'manual',
    project: project || 'default',
    type: validType(mode, type || 'note', mode.types.some((t) => t.id === 'note') ? 'note' : undefined),
    title: redactSecrets(heading),
    narrative: body,
    facts: asList(facts).map(redactSecrets),
    concepts: asList(concepts),
    files_modified: asList(files),
    source: 'manual',
  });
  const g = graphInput(entities, relations);
  const graph = store.graph && (g.entities.length || g.relations.length)
    ? ingestNote(store.graph, mode, { project: project || 'default', noteId: id, session_id: session_id || 'manual', ...g, defaultConfidence: 'STATED' })
    : null;
  return { id, saved: true, title: heading, graph };
}
