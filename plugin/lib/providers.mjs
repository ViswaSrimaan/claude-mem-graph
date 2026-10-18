// LLM backends for the observer. None of them involve a claude-mem account:
//   claude-cli  - the Claude Code CLI you are already signed in to (default)
//   anthropic   - your own ANTHROPIC_API_KEY
//   openai      - any OpenAI-compatible server, e.g. Ollama/LM Studio (free, offline)
//   heuristic   - no model at all, rule-based extraction
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { INTERNAL_ENV } from './config.mjs';

const isWin = process.platform === 'win32';
const SYSTEM = 'You are a background memory observer. You never use tools. You reply with a single JSON object and nothing else.';

let cliCache;

export function findClaudeCli(settings) {
  const explicit = settings?.observer?.claudeCliPath;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  if (cliCache !== undefined) return cliCache;
  const names = isWin ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'));
  if (isWin && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return (cliCache = p);
      } catch {}
    }
  }
  return (cliCache = null);
}

export function resolveProvider(settings) {
  const p = settings.observer.provider || 'auto';
  if (p !== 'auto') return p;
  return findClaudeCli(settings) ? 'claude-cli' : 'heuristic';
}

function childEnv() {
  const env = { ...process.env, [INTERNAL_ENV]: '1' };
  // Don't let the observer think it is nested inside the interactive session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function runProcess(cmd, args, input, timeoutMs, useShell) {
  return new Promise((resolve, reject) => {
    const child = spawn(useShell ? `"${cmd}"` : cmd, args, {
      env: childEnv(),
      cwd: os.tmpdir(),
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`observer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function runClaudeCli(prompt, settings, { system = SYSTEM } = {}) {
  const cli = findClaudeCli(settings);
  if (!cli) throw new Error('Claude Code CLI not found on PATH');
  const useShell = isWin && /\.(cmd|bat)$/i.test(cli);
  const empty = useShell ? '""' : '';
  const sys = useShell ? `"${system.replace(/"/g, "'")}"` : system;
  const base = ['-p', '--model', settings.observer.claudeCliModel || 'haiku', '--output-format', 'json',
    '--no-session-persistence', '--tools', empty, '--system-prompt', sys];
  let r = await runProcess(cli, [...base, '--safe-mode'], prompt, settings.observer.timeoutMs, useShell);
  if (r.code !== 0 && /unknown option|unrecognized/i.test(r.err + r.out)) {
    // Older CLI without --safe-mode: the INTERNAL_ENV guard still stops our hooks.
    r = await runProcess(cli, base, prompt, settings.observer.timeoutMs, useShell);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop());
  } catch {
    throw new Error(`claude CLI returned non-JSON (exit ${r.code}): ${(r.err || r.out).slice(0, 400)}`);
  }
  if (parsed.is_error || r.code !== 0) throw new Error(`claude CLI error: ${String(parsed.result || r.err).slice(0, 400)}`);
  return String(parsed.result || '');
}

export async function runAnthropic(prompt, settings, { system = SYSTEM } = {}) {
  const key = process.env.ANTHROPIC_API_KEY || settings.observer.anthropicApiKey;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch(`${settings.observer.anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: settings.observer.anthropicModel,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(settings.observer.timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function runOpenAI(prompt, settings, { system = SYSTEM } = {}) {
  const base = settings.observer.openaiBaseUrl.replace(/\/$/, '');
  const key = process.env.OPENAI_API_KEY || settings.observer.openaiApiKey;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: settings.observer.openaiModel,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(settings.observer.timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
  return body.choices?.[0]?.message?.content || '';
}

export async function runProvider(provider, prompt, settings, opts = {}) {
  switch (provider) {
    case 'claude-cli': return runClaudeCli(prompt, settings, opts);
    case 'anthropic': return runAnthropic(prompt, settings, opts);
    case 'openai':
    case 'ollama': return runOpenAI(prompt, settings, opts);
    default: throw new Error(`unknown provider: ${provider}`);
  }
}
