// Fallback backend for runtimes without node:sqlite (Node < 22.5). A single
// JSON file guarded by a lock directory; search is BM25 over an in-memory
// index. Fine for personal-scale memory; SQLite is used whenever available.
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeObservation, normalizeSummary, tokenize, projectFilter,
} from './common.mjs';

const EMPTY = () => ({
  version: 1,
  next: { sessions: 1, prompts: 1, events: 1, observations: 1, summaries: 1 },
  sessions: [], prompts: [], events: [], observations: [], summaries: [], meta: {},
});

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const byNewest = (a, b) => (b.created_at - a.created_at) || (b.id - a.id);

// Rough English suffix stripping so "refreshing" finds "refresh" (SQLite
// gets this from the porter tokenizer).
function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ational', 'ization', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return suf === 'ies' ? w.slice(0, -3) + 'y' : w.slice(0, -suf.length);
  }
  return w;
}

const words = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).map(stem);

export class JsonStore {
  static async open(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    return new JsonStore(path.join(dataDir, 'memory.json'));
  }

  constructor(file) {
    this.kind = 'json';
    // The graph layer needs SQLite (Node 22.5+); JSON storage keeps plain notes only.
    this.graph = null;
    this.file = file;
    this.lockDir = file + '.lock';
    this.cache = null;
    this.cacheMtime = 0;
  }

  close() {}

  getMeta(key) {
    return this.#read().meta?.[key] ?? null;
  }

  setMeta(key, value) {
    this.#write((d) => { d.meta = { ...(d.meta || {}), [key]: value }; });
  }

  #read() {
    let mtime = 0;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { return EMPTY(); }
    if (this.cache && mtime === this.cacheMtime) return this.cache;
    try {
      this.cache = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      this.cacheMtime = mtime;
    } catch {
      this.cache = EMPTY();
    }
    return this.cache;
  }

  #lock() {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(this.lockDir).mtimeMs > 10000) fs.rmSync(this.lockDir, { recursive: true, force: true });
        } catch {}
        if (Date.now() > deadline) throw new Error('memory.json lock timeout');
        sleep(25);
      }
    }
  }

  #write(fn) {
    this.#lock();
    try {
      this.cache = null;
      const data = structuredClone(this.#read());
      const result = fn(data);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
      this.cache = data;
      this.cacheMtime = fs.statSync(this.file).mtimeMs;
      return result;
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  // ---- sessions ---------------------------------------------------------

  upsertSession({ session_id, project, cwd, platform = 'claude-code' }) {
    return this.#write((d) => {
      const now = Date.now();
      let s = d.sessions.find((x) => x.session_id === session_id);
      if (!s) {
        s = { id: d.next.sessions++, session_id, project, cwd: cwd || null, platform, status: 'active', prompt_count: 0, last_assistant: null, started_at: now, updated_at: now, ended_at: null };
        d.sessions.push(s);
      } else {
        s.updated_at = now;
        if (s.status === 'ended') s.status = 'active';
      }
      return { ...s };
    });
  }

  getSession(session_id) {
    const s = this.#read().sessions.find((x) => x.session_id === session_id);
    return s ? { ...s } : undefined;
  }

  nextPromptNumber(session_id) {
    return this.#write((d) => {
      const s = d.sessions.find((x) => x.session_id === session_id);
      if (!s) return 1;
      s.prompt_count += 1;
      s.updated_at = Date.now();
      return s.prompt_count;
    });
  }

  setLastAssistant(session_id, text) {
    this.#write((d) => {
      const s = d.sessions.find((x) => x.session_id === session_id);
      if (s) { s.last_assistant = text || null; s.updated_at = Date.now(); }
    });
  }

  endSession(session_id) {
    this.#write((d) => {
      const s = d.sessions.find((x) => x.session_id === session_id);
      if (s) { s.status = 'ended'; s.ended_at = s.updated_at = Date.now(); }
    });
  }

  listSessions({ project, limit = 50, offset = 0 } = {}) {
    const d = this.#read();
    const p = projectFilter(project);
    return d.sessions
      .filter((s) => !p || s.project === p)
      .sort((a, b) => b.started_at - a.started_at)
      .slice(offset, offset + limit)
      .map((s) => ({
        ...s,
        observation_count: d.observations.filter((o) => o.session_id === s.session_id).length,
        first_prompt: d.prompts.filter((x) => x.session_id === s.session_id).sort((a, b) => a.prompt_number - b.prompt_number)[0]?.text ?? null,
      }));
  }

  deleteSession(session_id) {
    return this.#write((d) => {
      for (const t of ['observations', 'summaries', 'prompts', 'events']) d[t] = d[t].filter((x) => x.session_id !== session_id);
      const before = d.sessions.length;
      d.sessions = d.sessions.filter((x) => x.session_id !== session_id);
      return before - d.sessions.length;
    });
  }

  // ---- prompts ----------------------------------------------------------

  addPrompt({ session_id, project, prompt_number, text, created_at }) {
    return this.#write((d) => {
      const id = d.next.prompts++;
      d.prompts.push({ id, session_id, project, prompt_number, text, created_at: created_at || Date.now() });
      return id;
    });
  }

  getPrompt(session_id, prompt_number) {
    const rows = this.#read().prompts.filter((p) => p.session_id === session_id && p.prompt_number === prompt_number);
    return rows.length ? { ...rows[rows.length - 1] } : undefined;
  }

  recentPrompts({ project, session_id, limit = 50, offset = 0 } = {}) {
    const p = projectFilter(project);
    return this.#read().prompts
      .filter((x) => (!p || x.project === p) && (!session_id || x.session_id === session_id))
      .sort(byNewest).slice(offset, offset + limit).map((x) => ({ ...x }));
  }

  // ---- events -----------------------------------------------------------

  addEvent({ session_id, project, prompt_number = 0, tool_name, tool_input, tool_output, cwd, failed = false }) {
    return this.#write((d) => {
      const id = d.next.events++;
      d.events.push({ id, session_id, project, prompt_number, tool_name, tool_input: tool_input ?? '', tool_output: tool_output ?? '', cwd: cwd || null, failed: failed ? 1 : 0, status: 'pending', attempts: 0, claimed_at: null, created_at: Date.now() });
      return id;
    });
  }

  claimEvents(session_id, limit = 300) {
    return this.#write((d) => {
      const now = Date.now();
      const rows = d.events.filter((e) => e.status === 'pending' && e.session_id === session_id).slice(0, limit);
      for (const e of rows) { e.status = 'processing'; e.claimed_at = now; e.attempts += 1; }
      return rows.map((e) => ({ ...e }));
    });
  }

  finishEvents(ids, status = 'done') {
    if (!ids.length) return;
    const set = new Set(ids);
    this.#write((d) => { for (const e of d.events) if (set.has(e.id)) e.status = status; });
  }

  releaseEvents(ids, maxAttempts = 3) {
    if (!ids.length) return;
    const set = new Set(ids);
    this.#write((d) => {
      for (const e of d.events) if (set.has(e.id)) { e.status = e.attempts >= maxAttempts ? 'failed' : 'pending'; e.claimed_at = null; }
    });
  }

  resetStaleEvents(olderThanMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    const stale = this.#read().events.some((e) => e.status === 'processing' && e.claimed_at <= cutoff);
    if (!stale) return 0;
    return this.#write((d) => {
      let n = 0;
      for (const e of d.events) if (e.status === 'processing' && e.claimed_at <= cutoff) { e.status = 'pending'; e.claimed_at = null; n++; }
      return n;
    });
  }

  pendingSessions() {
    const counts = new Map();
    for (const e of this.#read().events) if (e.status === 'pending') counts.set(e.session_id, (counts.get(e.session_id) || 0) + 1);
    return [...counts].map(([session_id, n]) => ({ session_id, n }));
  }

  countPendingEvents(session_id) {
    return this.#read().events.filter((e) => (e.status === 'pending' || e.status === 'processing') && (!session_id || e.session_id === session_id)).length;
  }

  recentEvents({ session_id, prompt_number, limit = 100 } = {}) {
    return this.#read().events
      .filter((e) => (!session_id || e.session_id === session_id) && (prompt_number === undefined || e.prompt_number === Number(prompt_number)))
      .sort((a, b) => b.id - a.id).slice(0, limit).map((e) => ({ ...e }));
  }

  pruneEvents(keepDays = 7) {
    const cutoff = Date.now() - keepDays * 86400000;
    const old = (e) => ['done', 'failed', 'skipped'].includes(e.status) && e.created_at < cutoff;
    if (!this.#read().events.some(old)) return 0;
    return this.#write((d) => {
      const before = d.events.length;
      d.events = d.events.filter((e) => !old(e));
      return before - d.events.length;
    });
  }

  // ---- observations -----------------------------------------------------

  addObservation(input) {
    const o = normalizeObservation(input);
    return this.#write((d) => {
      const id = d.next.observations++;
      d.observations.push({ id, ...o });
      return id;
    });
  }

  updateObservation(id, patch) {
    return this.#write((d) => {
      const i = d.observations.findIndex((o) => o.id === Number(id));
      if (i === -1) return null;
      const cur = d.observations[i];
      d.observations[i] = { id: cur.id, ...normalizeObservation({ ...cur, ...patch, created_at: cur.created_at }) };
      return { ...d.observations[i] };
    });
  }

  getObservation(id) {
    const o = this.#read().observations.find((x) => x.id === Number(id));
    return o ? structuredClone(o) : undefined;
  }

  getObservations(ids) {
    const map = new Map(this.#read().observations.map((o) => [o.id, o]));
    return [...new Set(ids.map(Number))].slice(0, 100).map((id) => map.get(id)).filter(Boolean).map((o) => structuredClone(o));
  }

  recentObservations({ project, session_id, type, limit = 50, offset = 0, since } = {}) {
    const p = projectFilter(project);
    return this.#read().observations
      .filter((o) => (!p || o.project === p) && (!session_id || o.session_id === session_id) && (!type || o.type === type) && (!since || o.created_at >= since))
      .sort(byNewest).slice(offset, offset + limit).map((o) => structuredClone(o));
  }

  deleteObservation(id) {
    return this.#write((d) => {
      const before = d.observations.length;
      d.observations = d.observations.filter((o) => o.id !== Number(id));
      return before - d.observations.length;
    });
  }

  timelineAround({ id, before = 5, after = 5, project }) {
    const anchor = this.getObservation(id);
    if (!anchor) return null;
    const d = this.#read();
    const p = projectFilter(project) || anchor.project;
    const list = d.observations.filter((o) => o.project === p).sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id));
    const idx = list.findIndex((o) => o.id === anchor.id);
    const observations = list.slice(Math.max(0, idx - before), idx + after + 1).map((o) => structuredClone(o));
    const lo = observations[0].created_at;
    const hi = observations[observations.length - 1].created_at;
    return {
      anchor,
      observations,
      prompts: d.prompts.filter((x) => x.project === p && x.created_at >= lo - 60000 && x.created_at <= hi).sort((a, b) => a.created_at - b.created_at),
      summaries: d.summaries.filter((x) => x.project === p && x.created_at >= lo && x.created_at <= hi + 600000).sort((a, b) => a.created_at - b.created_at),
    };
  }

  // ---- summaries --------------------------------------------------------

  addSummary(input) {
    const s = normalizeSummary(input);
    return this.#write((d) => {
      const id = d.next.summaries++;
      d.summaries.push({ id, ...s });
      return id;
    });
  }

  recentSummaries({ project, session_id, limit = 20, offset = 0 } = {}) {
    const p = projectFilter(project);
    return this.#read().summaries
      .filter((x) => (!p || x.project === p) && (!session_id || x.session_id === session_id))
      .sort(byNewest).slice(offset, offset + limit).map((x) => ({ ...x }));
  }

  deleteSummary(id) {
    return this.#write((d) => {
      const before = d.summaries.length;
      d.summaries = d.summaries.filter((x) => x.id !== Number(id));
      return before - d.summaries.length;
    });
  }

  // ---- search (BM25) ----------------------------------------------------

  search({ query, project, type, kind = 'observations', limit = 20, since, excludeSession } = {}) {
    limit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const p = projectFilter(project);
    const terms = [...new Set(tokenize(query).map(stem))];
    if (!terms.length) {
      if (kind === 'summaries') return this.recentSummaries({ project: p, limit });
      if (kind === 'prompts') return this.recentPrompts({ project: p, limit });
      return this.recentObservations({ project: p, type, limit, since });
    }
    const d = this.#read();
    const docs = (kind === 'summaries' ? d.summaries : kind === 'prompts' ? d.prompts : d.observations)
      .filter((x) => (!p || x.project === p) && (!type || kind !== 'observations' || x.type === type) && (!since || x.created_at >= since) && (!excludeSession || x.session_id !== excludeSession));
    const textOf = (x) => {
      if (kind === 'summaries') return [x.request, x.investigated, x.learned, x.completed, x.next_steps, x.notes].join(' ');
      if (kind === 'prompts') return x.text;
      return [x.title, x.title, x.title, x.subtitle, x.narrative, ...(x.facts || []), ...(x.concepts || []), ...(x.files_modified || []), ...(x.files_read || [])].join(' ');
    };
    const tokenized = docs.map((x) => words(textOf(x)));
    const N = docs.length || 1;
    const avgdl = tokenized.reduce((n, t) => n + t.length, 0) / N || 1;
    const df = new Map();
    for (const t of terms) df.set(t, tokenized.filter((toks) => toks.some((w) => w.startsWith(t))).length);
    const k1 = 1.2;
    const b = 0.75;
    const scored = [];
    tokenized.forEach((toks, i) => {
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const tf = toks.filter((w) => w.startsWith(t)).length;
        if (!tf) continue;
        matched++;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks.length) / avgdl)));
      }
      if (matched) scored.push({ doc: docs[i], score, matched });
    });
    const all = scored.filter((s) => s.matched === terms.length);
    const pick = all.length ? all : scored;
    return pick.sort((a, b2) => b2.score - a.score).slice(0, limit).map((s) => ({ ...structuredClone(s.doc), score: -s.score }));
  }

  // ---- overview ---------------------------------------------------------

  listProjects() {
    const d = this.#read();
    const map = new Map();
    for (const o of d.observations) {
      const e = map.get(o.project) || { project: o.project, observations: 0, last_at: 0 };
      e.observations++;
      e.last_at = Math.max(e.last_at, o.created_at);
      map.set(o.project, e);
    }
    for (const s of d.sessions) if (!map.has(s.project)) map.set(s.project, { project: s.project, observations: 0, last_at: s.started_at });
    return [...map.values()].sort((a, b) => b.last_at - a.last_at);
  }

  stats(project) {
    const d = this.#read();
    const p = projectFilter(project);
    const f = (x) => !p || x.project === p;
    return {
      backend: 'json',
      file: this.file,
      sessions: d.sessions.filter(f).length,
      prompts: d.prompts.filter(f).length,
      observations: d.observations.filter(f).length,
      summaries: d.summaries.filter(f).length,
      pending_events: d.events.filter((e) => f(e) && (e.status === 'pending' || e.status === 'processing')).length,
      failed_events: d.events.filter((e) => f(e) && e.status === 'failed').length,
    };
  }

  latestIds() {
    const d = this.#read();
    const max = (arr) => arr.reduce((m, x) => Math.max(m, x.id), 0);
    return { observations: max(d.observations), summaries: max(d.summaries), prompts: max(d.prompts) };
  }

  since({ observations = 0, summaries = 0, prompts = 0 }) {
    const d = this.#read();
    return {
      observations: d.observations.filter((x) => x.id > observations).slice(0, 100),
      summaries: d.summaries.filter((x) => x.id > summaries).slice(0, 100),
      prompts: d.prompts.filter((x) => x.id > prompts).slice(0, 100),
    };
  }

  exportAll({ project } = {}) {
    const d = this.#read();
    const p = projectFilter(project);
    const f = (x) => !p || x.project === p;
    return {
      format: 'claude-mem-local',
      version: 1,
      exported_at: new Date().toISOString(),
      sessions: d.sessions.filter(f),
      prompts: d.prompts.filter(f),
      observations: d.observations.filter(f),
      summaries: d.summaries.filter(f),
    };
  }

  importAll(data) {
    const counts = { sessions: 0, prompts: 0, observations: 0, summaries: 0, skipped: 0 };
    this.#write((d) => {
      const known = new Set(d.sessions.map((s) => s.session_id));
      for (const s of data.sessions || []) {
        if (known.has(s.session_id)) continue;
        known.add(s.session_id);
        d.sessions.push({ ...s, id: d.next.sessions++ });
        counts.sessions++;
      }
      const key = (x, f) => `${x.session_id}|${x.created_at}|${x[f]}`;
      const sets = {
        prompts: new Set(d.prompts.map((x) => key(x, 'text'))),
        observations: new Set(d.observations.map((x) => key(x, 'title'))),
        summaries: new Set(d.summaries.map((x) => key(x, 'request'))),
      };
      const fields = { prompts: 'text', observations: 'title', summaries: 'request' };
      for (const t of ['prompts', 'observations', 'summaries']) {
        for (const x of data[t] || []) {
          const k = key(x, fields[t]);
          if (sets[t].has(k)) { counts.skipped++; continue; }
          sets[t].add(k);
          const row = t === 'observations' ? normalizeObservation(x) : t === 'summaries' ? normalizeSummary(x) : { session_id: x.session_id, project: x.project, prompt_number: x.prompt_number, text: x.text, created_at: x.created_at };
          d[t].push({ id: d.next[t]++, ...row });
          counts[t]++;
        }
      }
    });
    return counts;
  }

  vacuum() {}
}
