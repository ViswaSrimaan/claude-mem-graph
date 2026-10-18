// Plain-file exports of a project's knowledge graph. Nothing is installed or
// uploaded: open the files in the tool of your choice.
//   json    – node-link JSON in Graphify's graph.json shape
//   graphml – Gephi, yEd, Cytoscape
//   cypher  – a script for Neo4j (or FalkorDB / Memgraph)
import { VERSION } from '../config.mjs';

export const EXPORT_FORMATS = {
  json: { ext: 'json', type: 'application/json; charset=utf-8' },
  graphml: { ext: 'graphml', type: 'application/xml; charset=utf-8' },
  cypher: { ext: 'cypher', type: 'text/plain; charset=utf-8' },
};

// Graphify's confidence vocabulary: what someone stated was read straight
// from the source, so it maps to EXTRACTED.
const GRAPHIFY_CONFIDENCE = { STATED: 'EXTRACTED', INFERRED: 'INFERRED', AMBIGUOUS: 'AMBIGUOUS' };
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function graphData(g, project, { history = false, themes = [] } = {}) {
  const entities = g.listEntities({ project, limit: 1000000 });
  const ids = new Set(entities.map((e) => e.id));
  const facts = g.listFacts({ project, history, limit: 1000000 }).filter((f) => ids.has(f.src) && ids.has(f.dst));
  const themeOf = new Map();
  themes.forEach((t, i) => t.members.forEach((id) => themeOf.set(id, { index: i, id: t.id, label: t.label })));
  const aliases = new Map(entities.map((e) => [e.id, g.getEntity(e.id).aliases]));
  return { entities, facts, themeOf, aliases };
}

export function toGraphifyJson(g, project, opts = {}) {
  const { entities, facts, themeOf, aliases } = graphData(g, project, opts);
  return {
    directed: false,
    multigraph: true,
    graph: { source: 'claude-mem-local', version: VERSION, project, exported_at: new Date().toISOString() },
    nodes: entities.map((e) => ({
      id: `e${e.id}`,
      label: e.name,
      file_type: e.kind === 'file' ? 'code' : 'concept',
      source_file: e.kind === 'file' ? e.name : '',
      source_location: null,
      kind: e.kind,
      status: e.status || null,
      aliases: aliases.get(e.id),
      mentions: e.mention_count,
      first_seen: iso(e.first_seen),
      last_seen: iso(e.last_seen),
      community: themeOf.get(e.id)?.index ?? null,
      theme: themeOf.get(e.id)?.label ?? null,
    })),
    links: facts.map((f) => ({
      source: `e${f.src}`,
      target: `e${f.dst}`,
      _src: `e${f.src}`,
      _tgt: `e${f.dst}`,
      relation: f.type,
      confidence: GRAPHIFY_CONFIDENCE[f.confidence] || 'INFERRED',
      memory_confidence: f.confidence,
      weight: 1,
      fact: f.fact || null,
      why: f.why || null,
      valid_from: iso(f.valid_from),
      valid_to: iso(f.valid_to),
      current: f.current,
      source_note: f.note_kind === 'observation' ? f.note_id : null,
    })),
  };
}

const xml = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
  // Characters XML 1.0 does not allow at all.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function toGraphML(g, project, opts = {}) {
  const { entities, facts, themeOf, aliases } = graphData(g, project, opts);
  const nodeKeys = [['label', 'string'], ['kind', 'string'], ['status', 'string'], ['aliases', 'string'], ['mentions', 'int'], ['theme', 'string'], ['community', 'int']];
  const edgeKeys = [['relation', 'string'], ['confidence', 'string'], ['fact', 'string'], ['why', 'string'], ['valid_from', 'string'], ['valid_to', 'string'], ['current', 'boolean']];
  const keys = [
    ...nodeKeys.map(([k, t]) => `  <key id="n_${k}" for="node" attr.name="${k}" attr.type="${t}"/>`),
    ...edgeKeys.map(([k, t]) => `  <key id="e_${k}" for="edge" attr.name="${k}" attr.type="${t}"/>`),
  ];
  const data = (prefix, pairs) => pairs.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<data key="${prefix}_${k}">${xml(v)}</data>`).join('');
  const nodes = entities.map((e) => `    <node id="e${e.id}">${data('n', [
    ['label', e.name], ['kind', e.kind], ['status', e.status], ['aliases', aliases.get(e.id).join('; ')], ['mentions', e.mention_count],
    ['theme', themeOf.get(e.id)?.label], ['community', themeOf.get(e.id)?.index],
  ])}</node>`);
  const edges = facts.map((f) => `    <edge id="f${f.id}" source="e${f.src}" target="e${f.dst}">${data('e', [
    ['relation', f.type], ['confidence', f.confidence], ['fact', f.fact], ['why', f.why],
    ['valid_from', iso(f.valid_from)], ['valid_to', iso(f.valid_to)], ['current', f.current ? 'true' : 'false'],
  ])}</edge>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
${keys.join('\n')}
  <graph id="${xml(project)}" edgedefault="directed">
${[...nodes, ...edges].join('\n')}
  </graph>
</graphml>
`;
}

const cypherString = (v) => `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const label = (kind) => String(kind || 'thing').replace(/[^a-z0-9]+/gi, ' ').trim().split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Thing';
const relType = (t) => String(t || 'related to').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'RELATED_TO';
const props = (obj) => `{${Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => `${k}: ${typeof v === 'number' || typeof v === 'boolean' ? v : cypherString(v)}`).join(', ')}}`;

export function toCypher(g, project, opts = {}) {
  const { entities, facts, themeOf, aliases } = graphData(g, project, opts);
  const lines = [
    `// claude-mem-local knowledge graph for "${String(project).replace(/\n/g, ' ')}" (${new Date().toISOString()})`,
    '// Run in Neo4j Browser or cypher-shell. Every node is :Entity plus its kind.',
    'CREATE CONSTRAINT memory_entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;',
  ];
  for (const e of entities) {
    lines.push(`MERGE (n:Entity {id: ${cypherString(`e${e.id}`)}}) SET n:${label(e.kind)}, n += ${props({
      name: e.name, kind: e.kind, status: e.status, aliases: aliases.get(e.id).join('; '), mentions: e.mention_count,
      project, theme: themeOf.get(e.id)?.label,
    })};`);
  }
  for (const f of facts) {
    lines.push(`MATCH (a:Entity {id: ${cypherString(`e${f.src}`)}}), (b:Entity {id: ${cypherString(`e${f.dst}`)}}) CREATE (a)-[:${relType(f.type)} ${props({
      id: `f${f.id}`, relation: f.type, confidence: f.confidence, fact: f.fact, why: f.why,
      valid_from: iso(f.valid_from), valid_to: iso(f.valid_to), current: f.current,
    })}]->(b);`);
  }
  return `${lines.join('\n')}\n`;
}

export function exportGraph(g, project, format = 'json', opts = {}) {
  if (format === 'graphml') return toGraphML(g, project, opts);
  if (format === 'cypher') return toCypher(g, project, opts);
  return `${JSON.stringify(toGraphifyJson(g, project, opts), null, 1)}\n`;
}
