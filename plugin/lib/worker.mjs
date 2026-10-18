// Optional local worker: serves the memory viewer UI and a JSON API on
// 127.0.0.1. Hooks and the MCP server work without it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { PLUGIN_ROOT, VERSION, loadSettings, updateSettings, readJson, settingsFile, log } from './config.mjs';
import { openStore } from './store/index.mjs';
import { buildSessionContext } from './context.mjs';
import { listModes, loadMode } from './modes.mjs';
import { processSession } from './observer.mjs';
import { resolveProvider } from './providers.mjs';
import { saveMemory } from './memory-actions.mjs';
import { callTool } from './mcp.mjs';
import { analyzeGraph } from './graph/analyze.mjs';
import { exportGraph, EXPORT_FORMATS } from './graph/export.mjs';

const MAX_GRAPH_NODES = 400;

const VIEWER = path.join(PLUGIN_ROOT, 'ui', 'viewer.html');

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const int = (v, d, max = 500) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d;
};

export async function startWorker({ port, host, quiet = false } = {}) {
  let settings = loadSettings();
  const dataDir = settings.dataDir;
  port ??= settings.worker.port;
  host ??= settings.worker.host;
  const store = await openStore(dataDir);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const clients = new Set();
  let last = store.latestIds();
  let processing = false;

  const poll = setInterval(() => {
    if (!clients.size) { last = store.latestIds(); return; }
    try {
      const fresh = store.since(last);
      for (const [kind, rows] of Object.entries(fresh)) {
        for (const row of rows) {
          last[kind] = Math.max(last[kind], row.id);
          const msg = `event: ${kind}\ndata: ${JSON.stringify(row)}\n\n`;
          for (const c of clients) c.write(msg);
        }
      }
    } catch (err) {
      log(dataDir, 'warn', 'sse poll failed', err);
    }
  }, 2000);
  poll.unref();

  // ---- knowledge graph helpers --------------------------------------------
  const graph = () => store.graph;
  const needGraph = () => (graph() ? null : { error: 'The knowledge graph needs the SQLite store (Node 22.5+).', status: 409 });
  const needProject = (q) => {
    const p = q.get('project');
    return p && p !== '*' ? null : { error: 'Pick a project to see its graph.', status: 400 };
  };
  const analysis = (project) => {
    const snap = graph().latestSnapshot(project);
    return analyzeGraph(graph(), project, { previousThemes: snap?.data?.themes || [] });
  };
  const withEntities = (rows) => {
    if (!graph() || !Array.isArray(rows)) return rows;
    for (const o of rows) o.entities = graph().mentionsOf('observation', o.id).filter((e) => e.kind !== 'file').slice(0, 8).map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
    return rows;
  };

  // Nodes and current facts for the canvas, with themes for colour. Big
  // graphs are cut to the best-connected entities.
  const graphView = (q) => {
    const p = q.get('project');
    const a = analysis(p);
    const history = q.get('history') === '1';
    const files = q.get('files') === '1';
    const themeOf = new Map();
    a.themes.forEach((t) => t.members.forEach((id) => themeOf.set(id, t.id)));
    let nodes = [...a.G.nodes.values()].filter((e) => files || e.kind !== 'file')
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, status: e.status, mentions: e.mention_count, degree: a.G.degree.get(e.id) || 0, theme: themeOf.get(e.id) || null }));
    const total = nodes.length;
    nodes = nodes.sort((x, y) => y.degree - x.degree || y.mentions - x.mentions || x.id - y.id).slice(0, int(q.get('limit'), MAX_GRAPH_NODES, 2000));
    const keep = new Set(nodes.map((n) => n.id));
    const edges = graph().listFacts({ project: p, history, limit: 20000 }).filter((f) => keep.has(f.src) && keep.has(f.dst))
      .map((f) => ({ id: f.id, src: f.src, dst: f.dst, type: f.type, confidence: f.confidence, current: f.current }));
    return {
      project: p, total, nodes, edges,
      themes: a.themes.map((t) => ({ id: t.id, label: t.label, size: t.size, cohesion: t.cohesion })),
      stats: graph().stats(p),
    };
  };

  const entityDetail = (id) => {
    const g = graph();
    const e = g.getEntity(id);
    if (!e) return { error: 'not found', status: 404 };
    const facts = g.factsFor(e.id, { history: true, limit: 500 });
    const previous = g.previousValues(facts.filter((f) => f.current).map((f) => f.id));
    const noteIds = [...new Set(g.notesMentioning([e.id], { noteKind: 'observation', limit: 50 }).map((m) => m.note_id))];
    const feedback = g.feedbackFor('observation', noteIds);
    const notes = store.getObservations(noteIds).map((o) => ({ id: o.id, title: o.title, type: o.type, created_at: o.created_at, lesson: feedback.get(o.id)?.latest?.outcome || null }));
    return { entity: e, facts: facts.map((f) => ({ ...f, previous: (previous.get(f.id) || []).map((x) => x.dst_name) })), notes };
  };

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ app: 'claude-mem-local', ok: true, version: VERSION, pid: process.pid, backend: store.kind, dataDir, provider: resolveProvider(settings) })],
    ['GET', /^\/api\/stats$/, (q) => store.stats(q.get('project'))],
    ['GET', /^\/api\/projects$/, () => store.listProjects()],
    ['GET', /^\/api\/modes$/, () => ({ active: settings.mode, modes: listModes(dataDir), mode: loadMode(settings.mode, dataDir) })],
    ['GET', /^\/api\/observations$/, (q) => withEntities(q.get('q')
      ? store.search({ query: q.get('q'), project: q.get('project'), type: q.get('type') || undefined, limit: int(q.get('limit'), 50, 100) })
      : store.recentObservations({ project: q.get('project'), type: q.get('type') || undefined, session_id: q.get('session_id') || undefined, limit: int(q.get('limit'), 50), offset: int(q.get('offset'), 0, 1e9) }))],
    ['GET', /^\/api\/observations\/(\d+)$/, (q, m) => store.getObservation(m[1]) || { error: 'not found', status: 404 }],
    ['PATCH', /^\/api\/observations\/(\d+)$/, async (q, m, req) => {
      const body = await readBody(req);
      const allowed = Object.fromEntries(Object.entries(body).filter(([k]) => ['type', 'title', 'subtitle', 'narrative', 'facts', 'concepts', 'project'].includes(k)));
      return store.updateObservation(m[1], allowed) || { error: 'not found', status: 404 };
    }],
    ['DELETE', /^\/api\/observations\/(\d+)$/, (q, m) => ({ deleted: store.deleteObservation(m[1]) })],
    ['POST', /^\/api\/observations$/, async (q, m, req) => {
      const body = await readBody(req);
      return saveMemory(store, settings, body);
    }],
    ['GET', /^\/api\/timeline$/, (q) => store.timelineAround({ id: q.get('id'), before: int(q.get('before'), 5, 50), after: int(q.get('after'), 5, 50) }) || { error: 'not found', status: 404 }],
    ['GET', /^\/api\/summaries$/, (q) => (q.get('q')
      ? store.search({ query: q.get('q'), project: q.get('project'), kind: 'summaries', limit: int(q.get('limit'), 50, 100) })
      : store.recentSummaries({ project: q.get('project'), limit: int(q.get('limit'), 50), offset: int(q.get('offset'), 0, 1e9) }))],
    ['DELETE', /^\/api\/summaries\/(\d+)$/, (q, m) => ({ deleted: store.deleteSummary(m[1]) })],
    ['GET', /^\/api\/prompts$/, (q) => (q.get('q')
      ? store.search({ query: q.get('q'), project: q.get('project'), kind: 'prompts', limit: int(q.get('limit'), 50, 100) })
      : store.recentPrompts({ project: q.get('project'), limit: int(q.get('limit'), 50), offset: int(q.get('offset'), 0, 1e9) }))],
    ['GET', /^\/api\/sessions$/, (q) => store.listSessions({ project: q.get('project'), limit: int(q.get('limit'), 50), offset: int(q.get('offset'), 0, 1e9) })],
    ['GET', /^\/api\/sessions\/([^/]+)$/, (q, m) => {
      const sid = decodeURIComponent(m[1]);
      const session = store.getSession(sid);
      if (!session) return { error: 'not found', status: 404 };
      return {
        session,
        prompts: store.recentPrompts({ session_id: sid, limit: 500 }).reverse(),
        observations: store.recentObservations({ session_id: sid, limit: 500 }).reverse(),
        summaries: store.recentSummaries({ session_id: sid, limit: 200 }).reverse(),
        events: store.recentEvents({ session_id: sid, limit: 200 }).reverse(),
      };
    }],
    ['DELETE', /^\/api\/sessions\/([^/]+)$/, (q, m) => ({ deleted: store.deleteSession(decodeURIComponent(m[1])) })],
    ['GET', /^\/api\/context$/, (q) => ({ text: buildSessionContext(store, settings, { project: q.get('project') || undefined }) })],
    ['GET', /^\/api\/settings$/, () => ({ effective: settings, overrides: readJson(settingsFile(dataDir)) || {}, file: settingsFile(dataDir) })],
    ['PUT', /^\/api\/settings$/, async (q, m, req) => {
      const body = await readBody(req);
      delete body.dataDir;
      updateSettings(dataDir, body);
      settings = loadSettings();
      return { effective: settings, overrides: readJson(settingsFile(dataDir)) || {} };
    }],
    ['GET', /^\/api\/export$/, (q) => ({ __download: `claude-mem-local-${q.get('project') || 'all'}-${new Date().toISOString().slice(0, 10)}.json`, data: store.exportAll({ project: q.get('project') }) })],
    ['POST', /^\/api\/import$/, async (q, m, req) => {
      const body = await readBody(req);
      if (body.format !== 'claude-mem-local') return { error: 'not a claude-mem-local export', status: 400 };
      return store.importAll(body);
    }],
    ['POST', /^\/api\/process$/, async () => {
      if (processing) return { busy: true };
      processing = true;
      try {
        store.resetStaleEvents(0);
        const results = [];
        for (const { session_id } of store.pendingSessions()) results.push({ session_id, ...(await processSession(store, settings, session_id, { force: true })) });
        return { results };
      } finally {
        processing = false;
      }
    }],
    // ---- knowledge graph ----------------------------------------------------
    ['GET', /^\/api\/graph$/, (q) => needGraph() || needProject(q) || graphView(q)],
    ['GET', /^\/api\/graph\/overview$/, (q) => {
      const bad = needGraph() || needProject(q);
      if (bad) return bad;
      const a = analysis(q.get('project'));
      const name = (id) => a.G.nodes.get(id)?.name;
      return {
        keyEntities: a.keyEntities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, degree: e.degree, mentions: e.mention_count })),
        themes: a.themes.map((t) => ({ id: t.id, label: t.label, size: t.size, cohesion: t.cohesion, members: t.members.slice(0, 8).map((id) => ({ id, name: name(id) })) })),
        unexpected: a.unexpected.map((u) => ({ fact: u.fact, reasons: u.reasons })),
        questions: a.questions,
      };
    }],
    ['GET', /^\/api\/graph\/export$/, (q) => {
      const bad = needGraph() || needProject(q);
      if (bad) return bad;
      const format = EXPORT_FORMATS[q.get('format')] ? q.get('format') : 'json';
      const p = q.get('project');
      const text = exportGraph(graph(), p, format, { history: q.get('history') === '1', themes: analysis(p).themes });
      const safe = p.replace(/[^\w.-]+/g, '_');
      return { __download: `memory-graph-${safe}.${EXPORT_FORMATS[format].ext}`, text, type: EXPORT_FORMATS[format].type };
    }],
    ['GET', /^\/api\/entities$/, (q) => needGraph() || (q.get('q')
      ? graph().searchEntities(q.get('q'), { project: q.get('project'), limit: int(q.get('limit'), 20, 100) })
      : graph().listEntities({ project: q.get('project'), kind: q.get('kind') || undefined, limit: int(q.get('limit'), 50) }))],
    ['GET', /^\/api\/entities\/(\d+)$/, (q, m) => needGraph() || entityDetail(m[1])],
    ['PATCH', /^\/api\/entities\/(\d+)$/, async (q, m, req) => {
      const bad = needGraph();
      if (bad) return bad;
      const body = await readBody(req);
      const patch = Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'kind', 'status', 'summary'].includes(k)));
      const e = graph().updateEntity(m[1], patch);
      return e ? entityDetail(e.id) : { error: 'not found', status: 404 };
    }],
    ['DELETE', /^\/api\/entities\/(\d+)$/, (q, m) => needGraph() || { deleted: graph().deleteEntity(m[1]) }],
    ['POST', /^\/api\/entities\/(\d+)\/merge$/, async (q, m, req) => {
      const bad = needGraph();
      if (bad) return bad;
      const { into } = await readBody(req);
      if (!graph().getEntity(into) || !graph().getEntity(m[1])) return { error: 'not found', status: 404 };
      return entityDetail(graph().mergeEntities(into, m[1]).id);
    }],
    ['PATCH', /^\/api\/facts\/(\d+)$/, async (q, m, req) => {
      const bad = needGraph();
      if (bad) return bad;
      const body = await readBody(req);
      if (body.close) graph().closeFact(m[1]);
      return graph().updateFact(m[1], body) || { error: 'not found', status: 404 };
    }],
    ['DELETE', /^\/api\/facts\/(\d+)$/, (q, m) => needGraph() || { deleted: graph().deleteFact(m[1]) }],
    ['GET', /^\/api\/review$/, (q) => needGraph() || graph().listReview({ project: q.get('project'), limit: int(q.get('limit'), 50, 200) })],
    ['POST', /^\/api\/review\/(\d+)$/, async (q, m, req) => {
      const bad = needGraph();
      if (bad) return bad;
      const { accept } = await readBody(req);
      return graph().resolveReview(m[1], Boolean(accept)) || { error: 'not open', status: 404 };
    }],
    ['POST', /^\/api\/feedback$/, async (q, m, req) => {
      const bad = needGraph();
      if (bad) return bad;
      const body = await readBody(req);
      return { message: await callTool(store, settings, 'memory_feedback', body) };
    }],

    ['POST', /^\/api\/shutdown$/, () => {
      setTimeout(() => shutdown(), 50);
      return { ok: true };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 403, 'forbidden host');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(VIEWER), {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      // Browsers can't add custom headers cross-origin without a preflight
      // we never answer, so this blocks drive-by writes from other sites.
      if (req.method !== 'GET' && req.headers['x-cmem-local'] !== '1') return send(res, 403, { error: 'missing x-cmem-local header' });
      for (const [method, re, fn] of routes) {
        if (method !== req.method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const result = await fn(url.searchParams, m, req);
        if (result && result.__download) {
          return send(res, 200, result.text ?? JSON.stringify(result.data, null, 1), {
            'content-type': result.type || 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${result.__download}"`,
          });
        }
        const status = result && typeof result === 'object' && !Array.isArray(result) && result.status && result.error ? result.status : 200;
        return send(res, status, result ?? null);
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      log(dataDir, 'error', `worker ${req.method} ${req.url}`, err);
      send(res, 500, { error: String(err.message || err) });
    }
  });

  const pidFile = path.join(dataDir, 'worker.pid');
  function shutdown() {
    clearInterval(poll);
    for (const c of clients) c.end();
    server.close();
    store.close();
    try {
      if (readJson(pidFile)?.pid === process.pid) fs.rmSync(pidFile, { force: true });
    } catch {}
    setTimeout(() => process.exit(0), 100).unref();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, host, started_at: Date.now() }));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!quiet) process.stdout.write(`claude-mem-local viewer: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}\n`);
  log(dataDir, 'info', `worker listening on ${host}:${port}`);
  return { server, shutdown, port };
}
