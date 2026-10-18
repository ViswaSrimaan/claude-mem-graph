#!/usr/bin/env node
// Registers this folder as a local plugin marketplace in Claude Code and
// installs the plugin. Usage:
//   node scripts/install.mjs            install claude-mem-local
//   node scripts/install.mjs --cowork   also install the Cowork variant
//   node scripts/install.mjs --uninstall
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const isWin = process.platform === 'win32';

function claude(...a) {
  console.log(`> claude ${a.join(' ')}`);
  // On Windows `claude` is a .cmd shim, which needs a shell; pass one quoted
  // command line rather than an args array (Node warns about the latter).
  const r = isWin
    ? spawnSync(['claude', ...a.map((x) => (/[\s"&|<>^]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x))].join(' '), { stdio: 'inherit', shell: true })
    : spawnSync('claude', a, { stdio: 'inherit' });
  return r.status === 0;
}

spawnSync(process.execPath, [path.join(root, 'scripts', 'build-cowork.mjs')], { stdio: 'inherit' });

if (args.includes('--uninstall')) {
  claude('plugin', 'uninstall', 'mem-local@mem-local');
  claude('plugin', 'uninstall', 'mem-local-cowork@mem-local');
  claude('plugin', 'marketplace', 'remove', 'mem-local');
  process.exit(0);
}

claude('plugin', 'marketplace', 'add', root) || claude('plugin', 'marketplace', 'update', 'mem-local');
const ok = claude('plugin', 'install', 'mem-local@mem-local');
if (args.includes('--cowork')) claude('plugin', 'install', 'mem-local-cowork@mem-local');
console.log(ok
  ? '\nInstalled. Restart Claude Code; memory starts recording in the next session.\nViewer: node plugin/scripts/cmem.mjs worker start  ->  http://127.0.0.1:37811'
  : '\nInstall did not complete. Inside Claude Code you can also run:\n  /plugin marketplace add ' + root + '\n  /plugin install mem-local@mem-local');
