#!/usr/bin/env node
// Adds claude-mem-local's memory tools (MCP server) to the Claude desktop app,
// so desktop chats can search and save the same local memory as Claude Code.
// The desktop app has no hooks, so nothing is recorded automatically there;
// Claude uses the tools (search, save_memory, entity, …) when it needs them.
//
//   node scripts/install-desktop.mjs              add or update the entry
//   node scripts/install-desktop.mjs --uninstall  remove it
//
// A backup of the config is written next to it before every change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'claude-mem-local';
const uninstall = process.argv.includes('--uninstall');

function configCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    // The Microsoft Store build may keep its settings in a package folder.
    let packaged = [];
    try {
      packaged = fs.readdirSync(path.join(local, 'Packages')).filter((d) => /^Claude_/i.test(d))
        .map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    } catch {}
    return [...packaged, path.join(appData, 'Claude', 'claude_desktop_config.json')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json')];
}

const candidates = configCandidates();
const file = candidates.find((f) => fs.existsSync(f)) || candidates[candidates.length - 1];
let config = {};
if (fs.existsSync(file)) {
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.error(`Could not read ${file}: ${err.message}. Nothing was changed.`);
    process.exit(1);
  }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  console.log(`Backup: ${backup}`);
}

config.mcpServers ||= {};
if (uninstall) {
  delete config.mcpServers[NAME];
} else {
  config.mcpServers[NAME] = {
    command: process.execPath,
    args: [path.join(root, 'plugin', 'scripts', 'cmem.mjs'), 'mcp'],
    env: {
      // No project folder in desktop chats: search all projects, save new
      // memories under "claude-desktop".
      CLAUDE_MEM_LOCAL_PROJECT: '*',
      CLAUDE_MEM_LOCAL_AUTOSTART: 'false',
    },
  };
}

fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
fs.renameSync(tmp, file);
console.log(`${uninstall ? 'Removed' : 'Added'} "${NAME}" ${uninstall ? 'from' : 'to'} ${file}`);
console.log('Fully quit the Claude desktop app (system tray icon → Quit) and open it again to load the change.');
