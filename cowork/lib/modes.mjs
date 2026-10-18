// Modes define the observation vocabulary (types, icons, focus) used by the
// observer prompt and the context renderer. Users can drop their own mode
// files into <dataDir>/modes/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJson } from './config.mjs';

const cache = new Map();

export function loadMode(id = 'code', dataDir) {
  const key = `${id}|${dataDir || ''}`;
  if (cache.has(key)) return cache.get(key);
  const candidates = [
    dataDir && path.join(dataDir, 'modes', `${id}.json`),
    path.join(PLUGIN_ROOT, 'modes', `${id}.json`),
    path.join(PLUGIN_ROOT, 'modes', 'code.json'),
  ].filter(Boolean);
  let mode = null;
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      mode = readJson(file);
      if (mode?.types?.length) break;
    }
  }
  mode ||= { id: 'code', name: 'Code', types: [{ id: 'note', label: 'Note', icon: '✎' }], concepts: [], focus: '' };
  cache.set(key, mode);
  return mode;
}

export function listModes(dataDir) {
  const ids = new Set();
  for (const dir of [path.join(PLUGIN_ROOT, 'modes'), dataDir && path.join(dataDir, 'modes')].filter(Boolean)) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
    } catch {}
  }
  return [...ids].sort();
}

export function typeIcon(mode, type) {
  return mode.types.find((t) => t.id === type)?.icon || '•';
}

export function validType(mode, type, fallback) {
  const t = String(type || '').toLowerCase().trim();
  if (mode.types.some((x) => x.id === t)) return t;
  return fallback || mode.types[0].id;
}
