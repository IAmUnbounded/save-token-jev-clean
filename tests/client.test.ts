import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL,
  JevClient,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_DEFAULT_MODEL,
  SYSTEM_ONE_URL,
  buildJevRequest,
  parseJevResponse,
  resolveProvider,
} from '../src/client.js';
import type { JevQuestions, JevState } from '../src/types.js';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

// The Login Keychain fallback must never run during tests.
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const state: JevState = { context: 'A coding-agent conversation is being compacted.', history: [] };
const questions: JevQuestions = { keep: { type: 'noul', instructions: 'Keep this call?' } };

function payload(request: { body: string }): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

function openRouterResponse(answers: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({
    id: 'gen-dec-1789738314-X5e5eKGQdvR9rblyX250',
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers,
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  }), { status });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => {
    throw new Error('no keychain entry in tests');
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('provider selection', () => {
  it('defaults to the TypeSafe System One transport', () => {
    const request = buildJevRequest({ env: { TYPESAFE_API_KEY: 'ts-key' } }, state, questions);

    expect(request.url).toBe(SYSTEM_ONE_URL);
    expect(request.headers.authorization).toBe('Bearer ts-key');
    expect(payload(request).model).toBe(DEFAULT_MODEL);
    expect(payload(request)).toMatchObject({ state, questions });
  });

  it('does not send OpenRouter attribution headers to TypeSafe', () => {
    const request = buildJevRequest({ env: { TYPESAFE_API_KEY: 'ts-key', OPENROUTER_APP_URL: 'https://example.test' } }, state, questions);

    expect(request.headers['x-title']).toBeUndefined();
    expect(request.headers['http-referer']).toBeUndefined();
  });

  it('uses the OpenRouter Decisions endpoint when JEV_PROVIDER=openrouter', () => {
    const request = buildJevRequest({ env: { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' } }, state, questions);

    expect(request.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(request.headers.authorization).toBe('Bearer or-key');
    expect(request.headers['x-title']).toBe('save-token-jev');
    expect(payload(request).model).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it('accepts a padded, mixed-case JEV_PROVIDER value', () => {
    expect(resolveProvider({}, { JEV_PROVIDER: ' OpenRouter ' })).toBe('openrouter');
  });

  it('prefers an explicit provider option over JEV_PROVIDER', () => {
    const request = buildJevRequest(
      { provider: 'typesafe', env: { JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'ts-key' } },
      state,
      questions,
    );

    expect(request.url).toBe(SYSTEM_ONE_URL);
  });

  it('detects OpenRouter when only its key is configured', () => {
    expect(resolveProvider({}, { OPENROUTER_API_KEY: 'or-key' })).toBe('openrouter');
  });

  it('keeps TypeSafe when a TypeSafe key or a custom endpoint is also configured', () => {
    expect(resolveProvider({}, { OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key' })).toBe('typesafe');
    expect(resolveProvider({}, { OPENROUTER_API_KEY: 'or-key', JEV_BASE_URL: 'https://gateway.test/jev' })).toBe('typesafe');
    expect(resolveProvider({}, {})).toBe('typesafe');
  });

  it('does not redirect an explicitly passed key to OpenRouter', () => {
    expect(resolveProvider({ apiKey: 'explicit-typesafe-key' }, { OPENROUTER_API_KEY: 'or-key' })).toBe('typesafe');
    expect(resolveProvider({ apiKey: 'explicit-typesafe-key', provider: 'openrouter' }, {})).toBe('openrouter');
  });

  it('rejects an unknown provider instead of silently falling back', () => {
    expect(() => resolveProvider({}, { JEV_PROVIDER: 'openruter' })).toThrow(/Unknown Jev provider "openruter"/);
  });

  it('names the provider key that is missing', () => {
    expect(() => buildJevRequest({ env: {} }, state, questions)).toThrow('TYPESAFE_API_KEY is not configured');
    expect(() => buildJevRequest({ env: { JEV_PROVIDER: 'openrouter' } }, state, questions))
      .toThrow('OPENROUTER_API_KEY is not configured');
  });

  it('lets explicit options and environment overrides win over provider defaults', () => {
    const explicit = buildJevRequest({
      provider: 'openrouter',
      model: 'typesafe/jev-9',
      baseUrl: 'https://gateway.test/decisions',
      apiKey: 'chosen',
      env: { OPENROUTER_API_KEY: 'or-key', JEV_MODEL: 'ignored', JEV_BASE_URL: 'https://ignored.test' },
    }, state, questions);
    expect(explicit.url).toBe('https://gateway.test/decisions');
    expect(explicit.headers.authorization).toBe('Bearer chosen');
    expect(payload(explicit).model).toBe('typesafe/jev-9');

    const fromEnv = buildJevRequest({
      provider: 'openrouter',
      env: { OPENROUTER_API_KEY: 'or-key', JEV_MODEL: 'typesafe/jev-env', JEV_BASE_URL: 'https://env.test/decisions' },
    }, state, questions);
    expect(fromEnv.url).toBe('https://env.test/decisions');
    expect(payload(fromEnv).model).toBe('typesafe/jev-env');
  });

  it('ignores empty environment placeholders', () => {
    const request = buildJevRequest({
      provider: 'openrouter',
      env: { OPENROUTER_API_KEY: 'or-key', JEV_MODEL: '', JEV_BASE_URL: '', OPENROUTER_APP_NAME: '' },
    }, state, questions);

    expect(request.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(payload(request).model).toBe(OPENROUTER_DEFAULT_MODEL);
    expect(request.headers['x-title']).toBe('save-token-jev');
  });

  it('sends OpenRouter attribution headers from options or environment', () => {    const request = buildJevRequest({
      provider: 'openrouter',
      appName: 'my-agent',
      appUrl: 'https://agent.test',
      env: { OPENROUTER_API_KEY: 'or-key' },
    }, state, questions);

    expect(request.headers['x-title']).toBe('my-agent');
    expect(request.headers['http-referer']).toBe('https://agent.test');
  });
});

describe('JevClient over OpenRouter', () => {
  it('posts the Decisions request and reads noul answers', async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const fetchStub = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return openRouterResponse({ keep: { type: 'noul', noul: 0.93 } });
    }) as unknown as typeof fetch;
    const client = new JevClient({ provider: 'openrouter', env: { OPENROUTER_API_KEY: 'or-key' }, fetch: fetchStub });

    const response = await client.ask(state, questions);

    expect(response.answers.keep?.noul).toBe(0.93);
    expect(response.provider).toBe('TypeSafe');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(calls[0]!.init.headers.authorization).toBe('Bearer or-key');
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ model: OPENROUTER_DEFAULT_MODEL, state, questions });
  });

  it('detects OpenRouter from the process environment when no options are given', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env-key');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_PROVIDER', '');
    vi.stubEnv('JEV_BASE_URL', '');
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(url);
      return openRouterResponse({ keep: { type: 'noul', noul: 1 } });
    }) as unknown as typeof fetch;

    await new JevClient({ fetch: fetchStub }).ask(state, questions);

    expect(calls).toEqual([OPENROUTER_DECISIONS_URL]);
  });

  it('surfaces the OpenRouter error body instead of accepting a partial answer', async () => {
    const fetchStub = (async () => new Response(JSON.stringify({
      error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' },
    }), { status: 402 })) as unknown as typeof fetch;
    const client = new JevClient({ provider: 'openrouter', env: { OPENROUTER_API_KEY: 'or-key' }, fetch: fetchStub });

    await expect(client.ask(state, questions)).rejects.toThrow(/Insufficient credits/);
  });

  it('rejects a 200 response with no answers', () => {
    expect(() => parseJevResponse(200, true, JSON.stringify({ id: 'x', model: 'typesafe/jev-1.13' })))
      .toThrow('Jev response is missing answers');
    expect(parseJevResponse(200, true, JSON.stringify({ answers: { keep: { type: 'noul', noul: 0.5 } } })).answers.keep)
      .toMatchObject({ noul: 0.5 });
  });
});
