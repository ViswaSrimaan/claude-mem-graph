// Claude Code's own "auto memory" for a project lives in
//   <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with non-alphanumerics as ->/memory/*.md
// Those files are already distilled, so each one is stored directly as a
// note (no model call). A changed file updates its note; MEMORY.md is only
// an index of links and is skipped. Files are only read, never modified.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMode, validType } from './modes.mjs';
import { redactSecrets, stripPrivate } from './privacy.mjs';
import { projectRoot } from './project.mjs';

const MAX_BYTES = 64 * 1024;
const MAX_FILES = 200;
const SOURCE = 'claude-memory';

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// Memory folders for a working directory and its project root.
export function memoryDirs(cwd) {
  const roots = [...new Set([cwd, projectRoot(cwd)].filter(Boolean).map((p) => path.resolve(p)))];
  return roots.map((r) => path.join(claudeConfigDir(), 'projects', encodeCwd(r), 'memory')).filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

// Simple "key: value" front matter between --- lines.
export function parseMemoryFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const body = (m ? text.slice(m[0].length) : text).trim();
  const heading = /^#{1,3}\s+(.+)$/m.exec(body)?.[1];
  return { meta, body, title: meta.description || meta.name || heading || '' };
}

export function ingestClaudeMemory(store, settings, { cwd, project }) {
  const result = { added: 0, updated: 0, unchanged: 0, dirs: [] };
  if (settings.capture?.claudeMemory === false || !cwd) return result;
  const mode = loadMode(settings.mode, settings.dataDir);
  const type = validType(mode, 'note', mode.types[0].id);
  for (const dir of memoryDirs(cwd)) {
    result.dirs.push(dir);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'memory.md').sort().slice(0, MAX_FILES); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let text;
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      const key = `claude-memory:${file}`;
      const seen = store.getMeta?.(key);
      if (seen?.hash === hash) { result.unchanged++; continue; }
      const { body, title } = parseMemoryFile(text);
      const clean = redactSecrets(stripPrivate(body));
      if (!clean) continue;
      const note = {
        session_id: SOURCE, project, type, source: SOURCE,
        title: redactSecrets(title || f.replace(/\.md$/, '').replace(/[-_]/g, ' ')).slice(0, 160),
        subtitle: `Claude Code memory: ${f}`,
        narrative: clean,
      };
      if (seen?.id && store.getObservation(seen.id)) {
        store.updateObservation(seen.id, note);
        store.setMeta?.(key, { hash, id: seen.id });
        result.updated++;
      } else {
        const id = store.addObservation(note);
        store.setMeta?.(key, { hash, id });
        result.added++;
      }
    }
  }
  return result;
}
