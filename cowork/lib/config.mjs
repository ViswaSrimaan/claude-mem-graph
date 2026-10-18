// Settings and path resolution. Everything is local: no accounts, no keys
// required, no network calls unless the user picks a network observer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './project.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))?.version || '0.0.0';

// Set on every child process the observer spawns, so hooks fired by that
// child (if any) exit immediately instead of recording the observer itself.
export const INTERNAL_ENV = 'CLAUDE_MEM_LOCAL_INTERNAL';

export const DEFAULTS = Object.freeze({
  // "home": one database for every project at ~/.claude-mem-local
  // "workspace": a database inside each project folder (.claude-mem-local/),
  //              which is what Cowork needs because its home dir is not durable.
  storage: 'home',
  dataDir: '',
  platform: 'claude-code',
  mode: 'code',
  excludedProjects: [],
  observer: {
    // auto: Claude Code CLI if it is on PATH (uses the plan you already have),
    // otherwise the offline heuristic observer. Network providers are opt-in.
    provider: 'auto',
    claudeCliModel: 'haiku',
    claudeCliPath: '',
    anthropicModel: 'claude-haiku-5-5',
    anthropicBaseUrl: 'https://api.anthropic.com',
    openaiBaseUrl: 'http://localhost:11434/v1',
    openaiModel: 'llama3.2',
    timeoutMs: 180000,
    maxInputChars: 60000,
    // Turns without any tool use are summarized offline (no LLM call).
    skipLlmForChatOnlyTurns: true,
  },
  context: {
    enabled: true,
    observations: 40,
    fullDetails: 5,
    summaries: 3,
    maxChars: 12000,
    allProjects: false,
    promptRecall: true,
    promptRecallLimit: 3,
    agentContext: true,
    agentContextLimit: 5,
    // Knowledge graph blocks at session start (part of maxChars).
    graph: true,
    graphChars: 1500,
    keyFacts: 8,
    openWork: 8,
    // One visible line in the terminal when memory is loaded or recalled.
    notices: true,
  },
  capture: {
    enabled: true,
    skipTools: ['TodoWrite', 'TodoRead', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'TaskStop', 'ScheduleWakeup'],
    maxFieldChars: 4000,
    redactSecrets: true,
    keepRawDays: 7,
    // Import Claude Code's own memory files for the project (read only).
    claudeMemory: true,
  },
  // Optional meaning-based search through a local OpenAI-compatible
  // embeddings server (e.g. Ollama). Off by default.
  embeddings: {
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    model: 'nomic-embed-text',
    timeoutMs: 15000,
  },
  corpus: {
    maxChars: 60000,
  },
  worker: {
    host: '127.0.0.1',
    port: 37811,
    autoStart: true,
  },
});

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// The plugin can ship a config.json (the Cowork build does) to change
// defaults such as storage without the user editing anything.
export function pluginConfig() {
  return readJson(path.join(PLUGIN_ROOT, 'config.json')) || {};
}

export function resolveDataDir(cwd = process.cwd()) {
  const env = process.env.CLAUDE_MEM_LOCAL_DATA_DIR;
  if (env) return path.resolve(expandHome(env));
  const pc = pluginConfig();
  if (pc.dataDir) return path.resolve(expandHome(pc.dataDir));
  const storage = process.env.CLAUDE_MEM_LOCAL_STORAGE || pc.storage || DEFAULTS.storage;
  if (storage === 'workspace') {
    const root = process.env.CLAUDE_PROJECT_DIR || projectRoot(cwd) || cwd;
    return path.join(root, '.claude-mem-local');
  }
  return path.join(os.homedir(), '.claude-mem-local');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function settingsFile(dataDir) {
  return path.join(dataDir, 'settings.json');
}

const ENV_OVERRIDES = {
  CLAUDE_MEM_LOCAL_PROVIDER: ['observer', 'provider'],
  CLAUDE_MEM_LOCAL_MODEL: ['observer', 'claudeCliModel'],
  CLAUDE_MEM_LOCAL_MODE: ['mode'],
  CLAUDE_MEM_LOCAL_PORT: ['worker', 'port'],
  CLAUDE_MEM_LOCAL_AUTOSTART: ['worker', 'autoStart'],
};

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

export function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

export function loadSettings(cwd = process.cwd()) {
  const dataDir = resolveDataDir(cwd);
  let s = deepMerge(DEFAULTS, pluginConfig());
  s = deepMerge(s, readJson(settingsFile(dataDir)) || {});
  for (const [env, keys] of Object.entries(ENV_OVERRIDES)) {
    if (process.env[env] !== undefined && process.env[env] !== '') setPath(s, keys, coerce(process.env[env]));
  }
  s.dataDir = dataDir;
  return s;
}

// Persist only the user's overrides, not the merged defaults, so future
// default improvements still reach them.
export function updateSettings(dataDir, patch) {
  const file = settingsFile(dataDir);
  const current = readJson(file) || {};
  const next = deepMerge(current, patch);
  writeJsonAtomic(file, next);
  return next;
}

export function setSetting(dataDir, dottedKey, rawValue) {
  const file = settingsFile(dataDir);
  const current = readJson(file) || {};
  let value = rawValue;
  if (typeof rawValue === 'string') {
    try { value = JSON.parse(rawValue); } catch { value = coerce(rawValue); }
  }
  setPath(current, dottedKey.split('.'), value);
  writeJsonAtomic(file, current);
  return current;
}

export function logFile(dataDir) {
  return path.join(dataDir, 'logs', 'claude-mem-local.log');
}

export function log(dataDir, level, msg, extra) {
  try {
    const file = logFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch {}
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${process.pid}] ${msg}${extra ? ' ' + safeStringify(extra) : ''}\n`;
    fs.appendFileSync(file, line);
  } catch {}
}

function safeStringify(v) {
  try {
    if (v instanceof Error) return v.stack || v.message;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
