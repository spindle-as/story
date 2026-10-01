import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Activity, Chat, ChatMessage } from '../shared/types.ts';
import { emit } from './events.ts';
import { assertScope, BIN_DIR, HttpError, internalDir, SERVER_URL } from './paths.ts';
import { busy, busyKey, getProject, snapshot } from './projects.ts';
import { systemPrompt, turnContext } from './prompt.ts';
import { readVoiceover } from './voice.ts';

/**
 * Runs Claude Code headless (`claude -p`) in the project directory, with the codebase
 * added read-only. One resumable Claude session per chat scope (a scene, or the project).
 */

interface Running {
  proc: ChildProcess;
  label: string;
  stopped: boolean;
}

const running = new Map<string, Running>();

const chatFile = (slug: string, scope: string) => path.join(internalDir(slug), 'chats', `${scope}.json`);

export async function loadChat(slug: string, scope: string): Promise<Chat> {
  assertScope(scope);
  let chat: Chat = { scope, messages: [] };
  try {
    chat = JSON.parse(await fsp.readFile(chatFile(slug, scope), 'utf8'));
  } catch {}
  if (!running.has(busyKey(slug, scope))) {
    for (const m of chat.messages) if (m.status === 'running') m.status = 'stopped';
  }
  return chat;
}

async function saveChat(slug: string, chat: Chat) {
  await fsp.mkdir(path.dirname(chatFile(slug, chat.scope)), { recursive: true });
  await fsp.writeFile(chatFile(slug, chat.scope), JSON.stringify(chat, null, 2));
}

export async function clearChat(slug: string, scope: string) {
  if (running.has(busyKey(slug, scope))) throw new HttpError(409, 'Stop the running turn first');
  await fsp.rm(chatFile(slug, scope), { force: true });
}

/** Label used for scene versions created while a turn is running in this project. */
export function activeLabel(slug: string): string | null {
  for (const [key, run] of running) if (key.startsWith(`${slug}:`)) return run.label;
  return null;
}

/**
 * Environment for the Claude Code child process. Variables describing a parent Claude Code
 * session (e.g. when spindle/story itself was started from Claude Code) would make the child
 * try to use that session's auth, so they are dropped.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key === 'AI_AGENT' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_SDK')) continue;
    if (['CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR', '__CFBundleIdentifier', 'ELEVENLABS_API_KEY'].includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const AUTH_HELP =
  "Claude Code isn't signed in for command-line use. Open a terminal, run `claude` and use `/login` (or set ANTHROPIC_API_KEY before starting spindle/story), then send your message again.";

/**
 * Permission rules ("//abs/path/**") that make the codebase read-only for Claude without blocking
 * the project folder. Deny rules can't have exceptions, so when the project lives inside the
 * codebase (e.g. the example project, whose codebase is this app), deny every sibling along the
 * path down to the project instead of the whole codebase.
 */
export function codebaseDenyRules(codebase: string, projectDir: string): string[] {
  const root = path.resolve(codebase);
  const target = path.resolve(projectDir);
  const abs = (p: string) => `/${p}`;
  if (target !== root && !target.startsWith(root + path.sep)) return [abs(`${root}/**`)];
  if (target === root) return [];
  const rules: string[] = [];
  let dir = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (entry.name === segment) continue;
      const full = path.join(dir, entry.name);
      rules.push(abs(entry.isDirectory() ? `${full}/**` : full));
    }
    dir = path.join(dir, segment);
  }
  return rules;
}

function claudeBinary(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find((c) => fs.existsSync(c)) ?? 'claude';
}

function rel(file: string, roots: [string, string][]) {
  for (const [root, name] of roots) {
    if (file.startsWith(root + path.sep)) return `${name}${file.slice(root.length)}`;
  }
  return file;
}

function describeTool(name: string, input: any, roots: [string, string][]): Activity | null {
  switch (name) {
    case 'Read':
      return { kind: 'tool', label: `Read ${rel(input.file_path, roots)}` };
    case 'Write':
      return { kind: 'tool', label: `Wrote ${rel(input.file_path, roots)}` };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'tool', label: `Edited ${rel(input.file_path, roots)}` };
    case 'Grep':
      return { kind: 'tool', label: `Searched for “${input.pattern}”` };
    case 'Glob':
      return { kind: 'tool', label: `Looked for ${input.pattern}` };
    case 'Bash':
      return { kind: 'tool', label: String(input.command).split('\n')[0].slice(0, 120), detail: input.description };
    case 'TodoWrite':
      return null;
    default:
      return { kind: 'tool', label: name };
  }
}

export async function sendMessage(
  slug: string,
  scope: string,
  input: { text: string; playhead?: number; attachments?: string[] },
): Promise<ChatMessage> {
  assertScope(scope);
  const key = busyKey(slug, scope);
  if (running.has(key)) throw new HttpError(409, 'Claude is already working on this. Stop it or wait.');
  const project = await getProject(slug);
  if (scope !== '_project' && !project.scenes.some((s) => s.id === scope)) throw new HttpError(404, 'Scene not found');

  const chat = await loadChat(slug, scope);
  const now = Date.now();
  const user: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    text: input.text,
    createdAt: now,
    attachments: input.attachments,
    playhead: input.playhead,
  };
  const reply: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: '',
    createdAt: now,
    status: 'running',
    activity: [],
  };
  chat.messages.push(user, reply);
  await saveChat(slug, chat);
  emit({ type: 'chat', project: slug, scope, message: user });
  emit({ type: 'chat', project: slug, scope, message: reply });

  const roots: [string, string][] = [
    [project.dir, ''],
    [project.codebase, path.basename(project.codebase)],
  ];
  const deny = codebaseDenyRules(project.codebase, project.dir).flatMap((rule) => [`Edit(${rule})`, `Write(${rule})`]);
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Write,Edit,Glob,Grep,Bash,TodoWrite',
    '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash(story:*)', 'Bash(ls:*)',
    '--disallowedTools', ...deny,
    '--add-dir', project.codebase,
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--append-system-prompt', systemPrompt(project, scope),
  ];
  const model = project.model || process.env.STORY_MODEL;
  if (model) args.push('--model', model);
  if (chat.sessionId) args.push('--resume', chat.sessionId);

  // Make sure the state before this turn can be restored, whatever happened to the files since.
  for (const scene of project.scenes) await snapshot(slug, scene.id, 'Before AI edit');

  const voice = (await readVoiceover(slug)).lines.map(({ scene, t, text, duration }) => ({ scene, t, text, duration }));
  const prompt = turnContext(project, scope, { ...input, voice }) + input.text;
  const proc = spawn(claudeBinary(), args, {
    cwd: project.dir,
    env: childEnv({
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`,
      STORY_SERVER: SERVER_URL,
      STORY_PROJECT: slug,
      STORY_SCENE: scope === '_project' ? '' : scope,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.end(prompt);

  const run: Running = { proc, label: `AI: ${input.text.replace(/\s+/g, ' ').slice(0, 80)}`, stopped: false };
  running.set(key, run);
  busy.add(key);
  emit({ type: 'project', project: slug });

  let buffer = '';
  let stderr = '';
  let streaming = '';
  let lastDelta = 0;
  let result: any = null;
  const publish = () => emit({ type: 'chat', project: slug, scope, message: reply });

  const onEvent = (evt: any) => {
    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      chat.sessionId = evt.session_id;
    } else if (evt.type === 'stream_event') {
      const e = evt.event;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text') {
        if (reply.text.trim()) reply.activity!.push({ kind: 'note', label: reply.text.trim() });
        streaming = '';
        reply.text = '';
      } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streaming += e.delta.text;
        reply.text = streaming;
        if (Date.now() - lastDelta > 60) {
          lastDelta = Date.now();
          emit({ type: 'chat-delta', project: slug, scope, id: reply.id, text: reply.text });
        }
      }
    } else if (evt.type === 'assistant') {
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'text') {
          reply.text = block.text;
        } else if (block.type === 'tool_use') {
          if (reply.text.trim()) reply.activity!.push({ kind: 'note', label: reply.text.trim() });
          reply.text = '';
          const activity = describeTool(block.name, block.input ?? {}, roots);
          if (activity) reply.activity!.push(activity);
        }
      }
      publish();
      saveChat(slug, chat).catch(() => {});
    } else if (evt.type === 'result') {
      result = evt;
      if (evt.session_id) chat.sessionId = evt.session_id;
    }
  };

  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {}
    }
  });
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', async (code) => {
    running.delete(key);
    busy.delete(key);
    reply.durationMs = Date.now() - reply.createdAt;
    if (result) {
      reply.costUsd = result.total_cost_usd;
      if (typeof result.result === 'string' && result.result.trim()) reply.text = result.result.trim();
      reply.status = result.is_error ? 'error' : 'done';
      if (result.is_error && !reply.text) reply.text = `Claude stopped: ${result.subtype}`;
      if (result.is_error && /api key|log ?in|logged in|authenticat/i.test(reply.text)) reply.text = AUTH_HELP;
    } else if (run.stopped) {
      reply.status = 'stopped';
    } else {
      reply.status = 'error';
      const reason = stderr.trim().split('\n').slice(-6).join('\n') || `claude exited with code ${code}`;
      reply.text = reply.text || `Couldn't run Claude Code: ${reason}`;
      // A failed resume (e.g. session deleted) should not poison every future turn.
      if (chat.sessionId && /session|resume/i.test(stderr)) chat.sessionId = undefined;
    }
    if (run.stopped) reply.status = 'stopped';
    await saveChat(slug, chat).catch(() => {});
    publish();
    emit({ type: 'project', project: slug });
  });
  proc.on('error', (err) => {
    stderr += `\n${err.message}${(err as any).code === 'ENOENT' ? ' (is the `claude` CLI installed? Set CLAUDE_BIN to its path.)' : ''}`;
  });

  return reply;
}

export function stop(slug: string, scope: string) {
  const run = running.get(busyKey(slug, scope));
  if (!run) return false;
  run.stopped = true;
  run.proc.kill('SIGINT');
  setTimeout(() => run.proc.exitCode === null && run.proc.kill('SIGKILL'), 3000);
  return true;
}

export function stopAll() {
  for (const run of running.values()) {
    run.stopped = true;
    run.proc.kill('SIGKILL');
  }
}
