// Claude Code / Cowork lifecycle hooks. Every hook is fail-soft: errors are
// logged and the hook still exits 0, so memory can never break a session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSettings, log, INTERNAL_ENV, PLUGIN_ROOT } from './config.mjs';
import { projectName } from './project.mjs';
import { openStore } from './store/index.mjs';
import { clean, isFullyPrivate, stripPrivate, redactSecrets, truncate } from './privacy.mjs';
import { buildSessionContext, buildSessionNotice, buildRecallContext, buildAgentContext } from './context.mjs';
import { summarizeChatTurn } from './observer.mjs';
import { ingestClaudeMemory } from './claude-memory.mjs';
import { isWorkerUp, workerUrl } from './worker-client.mjs';

const CLI = path.join(PLUGIN_ROOT, 'scripts', 'cmem.mjs');

export function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    const done = () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); } catch { resolve({}); }
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

export function spawnDetached(args, settings) {
  try {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: settings.dataDir,
      env: { ...process.env, CLAUDE_MEM_LOCAL_DATA_DIR: settings.dataDir },
    });
    child.unref();
  } catch (err) {
    log(settings.dataDir, 'error', `spawn ${args.join(' ')} failed`, err);
  }
}

function isOwnTool(name) {
  return /(claude[-_])?mem[-_]local/i.test(name) || /^mcp__.*__(search|timeline|get_observations|save_memory|recent_context|list_projects|entity|related|path|facts|graph_overview|memory_feedback|get_tool_uses|work_state_write|work_state_read|build_corpus|list_corpora|query_corpus)$/.test(name) && /mem/i.test(name);
}

export function readLastAssistantMessage(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const stat = fs.statSync(transcriptPath);
    const size = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'assistant' || !row.message) continue;
      const content = row.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (text.trim()) return text.trim();
    }
  } catch {}
  return '';
}

function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

const handlers = {
  async 'session-start'({ input, store, settings, project, cwd }) {
    store.upsertSession({ session_id: input.session_id, project, cwd, platform: settings.platform || 'claude-code' });
    store.resetStaleEvents();
    if (store.pendingSessions().length) spawnDetached(['process', '--all'], settings);
    if (Math.random() < 0.1) store.pruneEvents(settings.capture.keepRawDays);
    if (settings.worker.autoStart && !(await isWorkerUp(settings, 300))) spawnDetached(['worker', 'run'], settings);
    try {
      ingestClaudeMemory(store, settings, { cwd, project });
    } catch (err) {
      log(settings.dataDir, 'warn', 'Claude memory import failed', err);
    }
    if (!settings.context.enabled) return;
    const text = buildSessionContext(store, settings, { project, session_id: input.session_id });
    // additionalContext reaches only the model; systemMessage is what the
    // person sees in the terminal.
    const notice = settings.context.notices
      ? buildSessionNotice(store, settings, { project, viewerUrl: settings.worker.autoStart ? workerUrl(settings) : '' })
      : '';
    if (!text && !notice) return;
    out({
      ...(text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {}),
      ...(notice ? { systemMessage: notice } : {}),
    });
  },

  async 'user-prompt'({ input, store, settings, project, cwd }) {
    const session_id = input.session_id;
    if (!store.getSession(session_id)) store.upsertSession({ session_id, project, cwd, platform: settings.platform || 'claude-code' });
    const prompt_number = store.nextPromptNumber(session_id);
    const raw = String(input.prompt || '');
    if (!raw.trim() || isFullyPrivate(raw)) return;
    const text = truncate(redactSecrets(stripPrivate(raw)), 20000);
    store.addPrompt({ session_id, project, prompt_number, text });
    const c = settings.context;
    if (!c.enabled || !c.promptRecall || text.startsWith('/') || text.length < 12) return;
    // Only rows that share real words with the prompt, or sit next to
    // something it names, are passed on (see buildRecallContext).
    const recall = buildRecallContext(store, settings, {
      project, query: text.slice(0, 600), excludeSession: session_id, limit: c.promptRecallLimit,
      heading: 'Possibly relevant memories from earlier sessions:',
    });
    if (!recall) return;
    const ids = [...recall.matchAll(/^- #(\d+)/gm)].map((m) => `#${m[1]}`);
    out({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: recall },
      ...(c.notices ? { systemMessage: `🧠 mem-local: recalled ${ids.length ? ids.join(', ') : 'related facts'} from earlier sessions` } : {}),
    });
  },

  async 'post-tool'({ input, store, settings, project, cwd }) {
    if (!settings.capture.enabled) return;
    const tool = String(input.tool_name || '');
    if (!tool || settings.capture.skipTools.includes(tool) || isOwnTool(tool)) return;
    const session_id = input.session_id;
    const session = store.getSession(session_id) || store.upsertSession({ session_id, project, cwd, platform: settings.platform || 'claude-code' });
    const response = input.tool_response ?? input.error ?? input.tool_output;
    const failed = input.hook_event_name === 'PostToolUseFailure' || Boolean(input.error)
      || (response && typeof response === 'object' && (response.is_error || response.interrupted));
    const opts = { maxChars: settings.capture.maxFieldChars, redact: settings.capture.redactSecrets };
    store.addEvent({
      session_id,
      project,
      prompt_number: session.prompt_count || 0,
      tool_name: tool,
      tool_input: clean(input.tool_input, opts),
      tool_output: clean(response, opts),
      cwd,
      failed,
    });
  },

  async 'pre-tool'({ input, store, settings, project }) {
    const c = settings.context;
    if (!c.enabled || !c.agentContext) return;
    const ti = input.tool_input;
    if (!ti || typeof ti.prompt !== 'string' || ti.prompt.includes('<prior-project-memory')) return;
    const query = `${ti.description || ''} ${ti.prompt}`.slice(0, 800);
    const block = buildAgentContext(store, settings, { project, query, limit: c.agentContextLimit });
    if (!block) return;
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'claude-mem-local added relevant project memory to the agent prompt',
        updatedInput: { ...ti, prompt: `${block}\n\n${ti.prompt}` },
      },
    });
  },

  async stop({ input, store, settings, project, cwd }) {
    const session_id = input.session_id;
    if (!store.getSession(session_id)) store.upsertSession({ session_id, project, cwd, platform: settings.platform || 'claude-code' });
    const last = input.last_assistant_message || readLastAssistantMessage(input.transcript_path);
    const cleaned = last ? truncate(redactSecrets(stripPrivate(last)), 6000) : '';
    store.setLastAssistant(session_id, cleaned);
    if (store.countPendingEvents(session_id) > 0) {
      spawnDetached(['process', '--session', session_id], settings);
    } else if (cleaned) {
      summarizeChatTurn(store, settings, session_id, cleaned);
    }
  },

  async 'session-end'({ input, store, settings }) {
    store.endSession(input.session_id);
    if (store.countPendingEvents(input.session_id) > 0) spawnDetached(['process', '--session', input.session_id], settings);
  },
};

export const HOOK_EVENTS = Object.keys(handlers);

export async function runHook(event, inputOverride) {
  if (process.env[INTERNAL_ENV]) return;
  const handler = handlers[event];
  if (!handler) {
    process.stderr.write(`claude-mem-local: unknown hook "${event}"\n`);
    return;
  }
  const input = inputOverride || (await readStdin());
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let settings;
  try {
    settings = loadSettings(cwd);
  } catch (err) {
    process.stderr.write(`claude-mem-local: bad settings: ${err.message}\n`);
    return;
  }
  const project = projectName(cwd);
  if (settings.excludedProjects.includes(project) || !input.session_id) return;
  let store;
  try {
    store = await openStore(settings.dataDir);
    await handler({ input, store, settings, project, cwd });
  } catch (err) {
    log(settings.dataDir, 'error', `hook ${event} failed`, err);
  } finally {
    store?.close();
  }
}
