import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Abort a provider request after this many milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Resolves a key without persisting it in project files. On macOS the final fallback is Login Keychain. */
export function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-a', userInfo().username, '-s', 'save-token-jev', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      // Missing or locked Keychain entry; the caller reports the normal missing-key error.
    }
  }
  return '';
}

export function buildJevRequest(
  options: Pick<JevClientOptions, 'apiKey' | 'model' | 'baseUrl'>,
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  return {
    url: options.baseUrl ?? process.env.JEV_BASE_URL ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as unknown as JevResponse;
}

export function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

export class JevClient implements JevAsker {
  private readonly options: JevClientOptions;

  constructor(options: JevClientOptions = {}) {
    this.options = options;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const request = buildJevRequest(this.options, state, questions);
    const timeout = Number.isFinite(this.options.timeoutMs) ? Math.max(1, this.options.timeoutMs!) : 30_000;
    const response = await (this.options.fetch ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeout),
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
