import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fromCodexJsonl } from '../adapters/codex.js';
import { compactMessages, reductionRatio, type CompactMessagesOptions } from '../core.js';
import { renderTranscript, summarizeCompaction } from '../render.js';
import type { CallDecision, CompactStats } from '../types.js';
import { isRecord } from '../adapters/shared.js';

interface CodexHookInput {
  session_id: string;
  transcript_path?: string | null;
  hook_event_name: string;
  source?: string;
}

interface Sidecar {
  version: 1;
  createdAt: string;
  context: string;
  stats: CompactStats;
  decisions: CallDecision[];
}

function hookInput(value: unknown): CodexHookInput {
  if (!isRecord(value) || typeof value.session_id !== 'string' || typeof value.hook_event_name !== 'string') {
    throw new Error('Invalid Codex hook input');
  }
  const result: CodexHookInput = { session_id: value.session_id, hook_event_name: value.hook_event_name };
  if (typeof value.transcript_path === 'string' || value.transcript_path === null) result.transcript_path = value.transcript_path;
  if (typeof value.source === 'string') result.source = value.source;
  return result;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180);
}

export function codexDataPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PLUGIN_DATA || env.SAVE_TOKEN_JEV_DATA_DIR || join(tmpdir(), 'save-token-jev');
  return join(root, 'codex', `${safeId(sessionId)}.json`);
}

export function codexHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PLUGIN_DATA || env.SAVE_TOKEN_JEV_DATA_DIR || join(tmpdir(), 'save-token-jev');
  return join(root, 'codex', 'history.jsonl');
}

async function writeSidecar(path: string, sidecar: Sidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function compactOptions(env: NodeJS.ProcessEnv): CompactMessagesOptions {
  const options: CompactMessagesOptions = {
    keepThreshold: numberEnv(env, 'SAVE_TOKEN_JEV_KEEP_THRESHOLD', 0.5),
    preserveRecentMessages: numberEnv(env, 'SAVE_TOKEN_JEV_PRESERVE_RECENT', 6),
    maxStateTokens: numberEnv(env, 'SAVE_TOKEN_JEV_MAX_STATE_TOKENS', 25_000),
    maxRequestTokens: numberEnv(env, 'SAVE_TOKEN_JEV_MAX_REQUEST_TOKENS', 30_000),
    truncateHeadChars: numberEnv(env, 'SAVE_TOKEN_JEV_TRUNCATE_HEAD_CHARS', 300),
    maxConcurrentRequests: numberEnv(env, 'SAVE_TOKEN_JEV_MAX_CONCURRENT_REQUESTS', 4),
    timeoutMs: numberEnv(env, 'SAVE_TOKEN_JEV_TIMEOUT_MS', 30_000),
  };
  if (env.TYPESAFE_API_KEY) options.apiKey = env.TYPESAFE_API_KEY;
  if (env.JEV_MODEL) options.model = env.JEV_MODEL;
  if (env.JEV_BASE_URL) options.baseUrl = env.JEV_BASE_URL;
  return options;
}

async function ensureDashboard(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configuredPort = Number(env.SAVE_TOKEN_JEV_DASHBOARD_PORT || 43127);
  const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 43127;
  const url = `http://127.0.0.1:${port}/`;
  // The link is useful even when auto-start is disabled or the detached
  // process cannot be spawned, so every hook response can expose it.
  if (env.SAVE_TOKEN_JEV_DASHBOARD === 'off') return url;
  try {
    const response = await fetch(`${url}api/health`);
    if (response.ok) return url;
  } catch {
    // Start it below when the dashboard is not already listening.
  }
  try {
    const entrypoint = process.argv[1];
    if (!entrypoint) return undefined;
    const child = spawn(process.execPath, [entrypoint, 'dashboard', '--host', '127.0.0.1', '--port', String(port)], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return url;
  } catch {
    return undefined;
  }
}

export async function handleCodexHook(value: unknown, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const input = hookInput(value);
  const path = codexDataPath(input.session_id, env);
  const dashboard = await ensureDashboard(env);
  const dashboardNote = dashboard ? ` Dashboard: ${dashboard}` : '';

  if (input.hook_event_name === 'PreCompact') {
    if (!input.transcript_path) return { continue: true, systemMessage: `save-token-jev: no transcript path; using built-in compaction only.${dashboardNote}` };
    try {
      const transcript = fromCodexJsonl(await readFile(input.transcript_path, 'utf8'));
      const result = await compactMessages(transcript, compactOptions(env));
      const minimum = numberEnv(env, 'SAVE_TOKEN_JEV_MIN_REDUCTION', 0.15);
      if (reductionRatio(result) < minimum) {
        return { continue: true, systemMessage: `save-token-jev: built-in compaction only (reduction below ${Math.round(minimum * 100)}%).${dashboardNote}` };
      }
      await writeSidecar(path, {
        version: 1,
        createdAt: new Date().toISOString(),
        context: renderTranscript(result.messages, { source: 'Codex transcript before compaction' }),
        stats: result.stats,
        decisions: result.decisions,
      });
      await appendFile(
        codexHistoryPath(env),
        `${JSON.stringify({
          version: 1,
          createdAt: new Date().toISOString(),
          sessionId: input.session_id,
          trigger: value && isRecord(value) && typeof value.trigger === 'string' ? value.trigger : 'unknown',
          stats: result.stats,
          decisions: result.decisions,
        })}\n`,
        { mode: 0o600 },
      );
      return { continue: true, systemMessage: `save-token-jev prepared retained context: ${summarizeCompaction(result)}${dashboardNote}` };
    } catch (error) {
      return { continue: true, systemMessage: `save-token-jev fell back to built-in compaction: ${error instanceof Error ? error.message : String(error)}${dashboardNote}` };
    }
  }

  if (input.hook_event_name === 'SessionStart' && input.source === 'compact') {
    try {
      const sidecar = JSON.parse(await readFile(path, 'utf8')) as Sidecar;
      if (!sidecar || sidecar.version !== 1 || typeof sidecar.context !== 'string') throw new Error('invalid sidecar');
      return {
        continue: true,
        systemMessage: dashboard ? `save-token-jev dashboard: ${dashboard}` : undefined,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `${sidecar.context}${dashboard ? `\n\nDashboard: ${dashboard}` : ''}`,
        },
      };
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code === 'ENOENT') return dashboard ? { continue: true, systemMessage: `save-token-jev dashboard: ${dashboard}` } : { continue: true };
      return { continue: true, systemMessage: `save-token-jev could not restore retained context: ${error instanceof Error ? error.message : String(error)}${dashboard ? ` Dashboard: ${dashboard}` : ''}` };
    }
  }

  return { continue: true, systemMessage: `save-token-jev dashboard: ${dashboard ?? 'http://127.0.0.1:43127/'}` };
}
