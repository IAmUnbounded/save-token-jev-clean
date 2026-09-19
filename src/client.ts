import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/**
 * OpenRouter serves the same Decisions request/response protocol as System One
 * (`{ model, state, questions }` in, `{ model, answers, usage }` out) from an
 * alpha path outside `/api/v1`, so only the endpoint, key, and model id differ.
 * @see https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
 */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_DEFAULT_MODEL = 'typesafe/jev-1.13';
export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';
export const PROVIDER_ENV = 'JEV_PROVIDER';

export type JevProvider = 'typesafe' | 'openrouter';

export interface JevProviderDefaults {
  /** Decisions endpoint used when neither the option nor `JEV_BASE_URL` is set. */
  url: string;
  /** Model id used when neither the option nor `JEV_MODEL` is set. */
  model: string;
  /** Environment variable that holds this provider's API key. */
  apiKeyEnv: string;
  /** macOS Login Keychain service checked after the environment variable. */
  keychainService: string;
}

const PROVIDERS: Record<JevProvider, JevProviderDefaults> = {
  typesafe: {
    url: SYSTEM_ONE_URL,
    model: DEFAULT_MODEL,
    apiKeyEnv: TYPESAFE_API_KEY_ENV,
    keychainService: 'save-token-jev',
  },
  openrouter: {
    url: OPENROUTER_DECISIONS_URL,
    model: OPENROUTER_DEFAULT_MODEL,
    apiKeyEnv: OPENROUTER_API_KEY_ENV,
    keychainService: 'save-token-jev-openrouter',
  },
};

export function providerDefaults(provider: JevProvider): JevProviderDefaults {
  return PROVIDERS[provider];
}

export function isJevProvider(value: unknown): value is JevProvider {
  return value === 'typesafe' || value === 'openrouter';
}

/**
 * Picks the Jev transport. An explicit option wins over `JEV_PROVIDER`, which
 * wins over detection: an OpenRouter key with no TypeSafe key and no endpoint
 * override means OpenRouter is the only transport this configuration can serve.
 * An explicitly passed key suppresses detection, because `apiKey` has always
 * meant a TypeSafe key and must not be redirected by an unrelated ambient one.
 */
export function resolveProvider(
  options: { provider?: JevProvider | string; apiKey?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): JevProvider {
  const configured = options.provider ?? env[PROVIDER_ENV];
  if (configured) {
    const normalized = String(configured).trim().toLowerCase();
    if (!isJevProvider(normalized)) {
      throw new Error(`Unknown Jev provider "${configured}". Set ${PROVIDER_ENV} to "typesafe" or "openrouter".`);
    }
    return normalized;
  }
  if (options.apiKey) return 'typesafe';
  if (env[OPENROUTER_API_KEY_ENV] && !env[TYPESAFE_API_KEY_ENV] && !env.JEV_BASE_URL) return 'openrouter';
  return 'typesafe';
}

export interface ApiKeyOptions {
  provider?: JevProvider;
  env?: NodeJS.ProcessEnv;
  /** Consult the macOS Login Keychain when no environment key is set. Defaults to true. */
  useKeychain?: boolean;
}

export interface JevClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Transport to use. Defaults to `JEV_PROVIDER`, then to detection from the environment. */
  provider?: JevProvider;
  /** OpenRouter app name sent as `x-title` for attribution. Ignored by the TypeSafe transport. */
  appName?: string;
  /** OpenRouter app URL sent as `http-referer` for attribution. Ignored by the TypeSafe transport. */
  appUrl?: string;
  /** Environment consulted for defaults, including the provider API key. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Consult the macOS Login Keychain when the environment has no key. Defaults to true. */
  useKeychain?: boolean;
  fetch?: typeof fetch;
  /** Abort a provider request after this many milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export type JevRequestOptions = Pick<
  JevClientOptions,
  'apiKey' | 'model' | 'baseUrl' | 'provider' | 'appName' | 'appUrl' | 'env' | 'useKeychain'
>;

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Resolves a key without persisting it in project files. On macOS the final fallback is Login Keychain. */
export function resolveApiKey(explicit?: string, options: ApiKeyOptions = {}): string {
  if (explicit) return explicit;
  const provider = options.provider ?? 'typesafe';
  const env = options.env ?? process.env;
  const fromEnv = env[providerDefaults(provider).apiKeyEnv];
  if (fromEnv) return fromEnv;
  if ((options.useKeychain ?? true) && process.platform === 'darwin') {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-a', userInfo().username, '-s', providerDefaults(provider).keychainService, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      // Missing or locked Keychain entry; the caller reports the normal missing-key error.
    }
  }
  return '';
}

/** Empty environment values are common "unset" placeholders, so they never beat a default. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) if (value) return value;
  return undefined;
}

/** Builds key options without assigning explicit `undefined` under `exactOptionalPropertyTypes`. */
function keyOptions(provider: JevProvider, env: NodeJS.ProcessEnv, useKeychain?: boolean): ApiKeyOptions {
  const options: ApiKeyOptions = { provider, env };
  if (typeof useKeychain === 'boolean') options.useKeychain = useKeychain;
  return options;
}

export function buildJevRequest(options: JevRequestOptions, state: JevState, questions: JevQuestions): JevRequest {
  const env = options.env ?? process.env;
  const provider = resolveProvider(options, env);
  const defaults = providerDefaults(provider);
  const apiKey = resolveApiKey(options.apiKey, keyOptions(provider, env, options.useKeychain));
  if (!apiKey) throw new Error(`${defaults.apiKeyEnv} is not configured`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  if (provider === 'openrouter') {
    // Optional OpenRouter attribution headers; they never change routing.
    const appUrl = firstNonEmpty(options.appUrl, env.OPENROUTER_APP_URL);
    if (appUrl) headers['http-referer'] = appUrl;
    headers['x-title'] = firstNonEmpty(options.appName, env.OPENROUTER_APP_NAME) ?? 'save-token-jev';
  }
  return {
    url: firstNonEmpty(options.baseUrl, env.JEV_BASE_URL) ?? defaults.url,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: firstNonEmpty(options.model, env.JEV_MODEL) ?? defaults.model,
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
