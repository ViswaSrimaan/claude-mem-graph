import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'plugin', 'scripts', 'cmem.mjs');

export function tmpDir(prefix = 'cmem-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runCli(args, { input, env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd || ROOT,
      // Never read the real ~/.claude (Claude Code memory import) from tests.
      env: { ...process.env, CLAUDE_MEM_LOCAL_AUTOSTART: 'false', CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'cmem-test-no-claude-config'), ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
  });
}

export async function waitFor(fn, { timeout = 10000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function baseSettings(dataDir, over = {}) {
  return {
    storage: 'home', dataDir, mode: 'code', excludedProjects: [], platform: 'test',
    observer: { provider: 'heuristic', claudeCliModel: 'haiku', anthropicModel: 'x', anthropicBaseUrl: 'http://127.0.0.1:1', openaiBaseUrl: 'http://127.0.0.1:1/v1', openaiModel: 'm', timeoutMs: 5000, maxInputChars: 60000, skipLlmForChatOnlyTurns: true, ...(over.observer || {}) },
    context: { enabled: true, observations: 40, fullDetails: 5, summaries: 3, maxChars: 12000, allProjects: false, promptRecall: true, promptRecallLimit: 3, agentContext: true, agentContextLimit: 5, ...(over.context || {}) },
    capture: { enabled: true, skipTools: ['TodoWrite'], maxFieldChars: 4000, redactSecrets: true, keepRawDays: 7, ...(over.capture || {}) },
    worker: { host: '127.0.0.1', port: 37811, autoStart: false },
  };
}
