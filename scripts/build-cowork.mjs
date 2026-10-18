#!/usr/bin/env node
// Generates cowork/ from plugin/. The Cowork build is the same code with
// different defaults: memory is stored in the working folder (Cowork's home
// directory doesn't persist between sessions), the "general" knowledge-work
// mode, and no background viewer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'plugin');
const dest = path.join(root, 'cowork');

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, filter: (p) => !/node_modules|\.DS_Store/.test(p) });

const manifest = JSON.parse(fs.readFileSync(path.join(src, '.claude-plugin', 'plugin.json'), 'utf8'));
manifest.name = 'mem-local-cowork';
manifest.description = 'Free, local, persistent memory for Claude Cowork. Memory is kept in a .claude-mem-local folder inside the folder you work in, so it survives between Cowork sessions. No account, no subscription, no telemetry.';
fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

const config = {
  storage: 'workspace',
  platform: 'cowork',
  mode: 'general',
  worker: { autoStart: false },
};
fs.writeFileSync(path.join(dest, 'config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`Built ${path.relative(root, dest)}/ (v${manifest.version})`);
