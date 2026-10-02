import { describe, expect, it, vi } from 'vitest';
import { register, type ClaudeSessionMessage } from '../src/integrations/claude.js';

/**
 * The Claude Code `session.compact` function hook. Everything it touches arrives on the injected
 * `$` runtime, so these tests drive it with a fake `on`/`$`/`next` instead of a live session.
 *
 * The hook's contract: answer with `{ messages }` when Jev produced a worthwhile reduction, and
 * otherwise hand the original event to `next` so Claude's built-in compaction runs. Passing the
 * event through by identity is what preserves the fields Claude pins on it (`trigger`, `agentId`).
 */

/** Derived from the public export so the fakes cannot drift from the real signature. */
type On = Parameters<typeof register>[0];
type Callback = Parameters<On>[1];
type Runtime = Parameters<Callback>[0];
type CompactEvent = Parameters<Callback>[1];

/** A sentinel that must never reach a log line, a toast, or an assertion message. */
const API_KEY = 'test-key-must-not-be-logged';

interface Harness {
  invoke(event: CompactEvent): Promise<unknown>;
  fetch: ReturnType<typeof vi.fn>;
  envGet: ReturnType<typeof vi.fn>;
  settingsRead: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  /** Everything the hook surfaced to the person, log lines and toasts together. */
  messages(): string[];
}

interface HarnessOptions {
  options?: Record<string, unknown>;
  /** Jev's verdict per question name; the default drops every candidate. */
  noul?: (name: string) => number;
  /** Replaces the Jev response outright, for failure cases. */
  respond?: (body: string) => { status: number; ok: boolean; headers: Record<string, string>; text: string };
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
}

function harness({ options = {}, noul = () => 0.01, respond, env = {}, settings = {} }: HarnessOptions = {}): Harness {
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    if (respond) return respond(init.body);
    const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: noul(name) }]));
    return { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) };
  });
  const envGet = vi.fn(async (name: string) => env[name]);
  const settingsRead = vi.fn(async () => settings);
  const log = vi.fn();
  const toast = vi.fn();
  const next = vi.fn(() => 'built-in');

  const runtime = {
    http: { fetch },
    env: { get: envGet },
    settings: { read: settingsRead },
    ui: { log, toast },
  } as unknown as Runtime;

  let callback: Callback | undefined;
  const on = ((event: string, handler: Callback) => {
    expect(event).toBe('session.compact');
    callback = handler;
  }) as unknown as On;

  register(on, { apiKey: API_KEY, preserveRecentMessages: 0, ...options });
  if (!callback) throw new Error('register did not subscribe to session.compact');
  const subscribed = callback;

  return {
    invoke: (event) => subscribed(runtime, event, next as unknown as Parameters<Callback>[2]),
    fetch,
    envGet,
    settingsRead,
    log,
    toast,
    next,
    messages: () => [...log.mock.calls, ...toast.mock.calls].map(([text]) => String(text)),
  };
}

/** A transcript with one bulky tool result, so dropping it is a large, unambiguous reduction. */
function compactableEvent(): CompactEvent {
  const messages: ClaudeSessionMessage[] = [
    { role: 'user', text: 'Find the leak.', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: 'reading', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { p: 'big.log' } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'noise '.repeat(500) }], handle: 'h2' },
    { role: 'assistant', text: 'done', toolUses: [], handle: 'h3' },
  ];
  // `trigger` and `agentId` are pinned by Claude Code; the hook must pass them through untouched.
  return { trigger: 'auto', agentId: 'agent-7', messages } as unknown as CompactEvent;
}

describe('Claude session.compact hook', () => {
  it('answers with replacement messages and does not call next when Jev reduces the transcript', async () => {
    const h = harness();
    const event = compactableEvent();
    const result = (await h.invoke(event)) as { messages: ClaudeSessionMessage[] };

    expect(h.next).not.toHaveBeenCalled();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.messages)).not.toContain('noise noise');
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.messages().every((text) => text.startsWith('save-token-jev: '))).toBe(true);
  });

  it('falls back through next with the original event when Jev fails', async () => {
    const h = harness({ respond: () => ({ status: 500, ok: false, headers: {}, text: 'upstream exploded' }) });
    const event = compactableEvent();

    expect(await h.invoke(event)).toBe('built-in');
    expect(h.next).toHaveBeenCalledTimes(1);
    // Identity, not equality: that is what carries the pinned fields through unchanged.
    expect(h.next.mock.calls[0]?.[0]).toBe(event);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.messages().join('\n')).toContain("using Claude's built-in compaction");
  });

  it('never puts the API key into a log line or a toast', async () => {
    const cases = [
      harness(),
      harness({ respond: () => ({ status: 401, ok: false, headers: {}, text: 'unauthorized' }) }),
      harness({ options: { apiKey: undefined } }),
    ];
    const surfaced: string[] = [];
    for (const h of cases) {
      await h.invoke(compactableEvent());
      surfaced.push(...h.messages());
    }

    // Guard against passing vacuously: every case above must actually say something.
    expect(surfaced.length).toBe(cases.length * 2);
    for (const text of surfaced) expect(text).not.toContain(API_KEY);
  });

  it('stays silent and defers to next when the reduction is below minReductionRatio', async () => {
    // Jev keeps everything, so nothing is removed and the gate declines.
    const h = harness({ noul: () => 1, options: { minReductionRatio: 0.15 } });
    const event = compactableEvent();

    expect(await h.invoke(event)).toBe('built-in');
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.next.mock.calls[0]?.[0]).toBe(event);
    // Deliberately quiet: a below-threshold compaction is not worth interrupting anyone over.
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });

  it('returns a SessionCompacted-shaped result and leaves the pinned event fields alone', async () => {
    const h = harness();
    const event = compactableEvent();
    const before = structuredClone(event);

    const result = (await h.invoke(event)) as Record<string, unknown>;

    // No summary string and no echo of trigger/agentId: a compaction is `{ messages }`.
    expect(Object.keys(result)).toEqual(['messages']);
    expect(event).toEqual(before);
  });
});

describe('Claude session.compact key resolution', () => {
  /** Reads the Bearer header off the request without ever surfacing the credential. */
  function authorization(fetch: Harness['fetch']): string {
    const init = fetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
    return init.headers.authorization ?? '';
  }

  it('prefers the plugin option and does not consult the environment', async () => {
    const h = harness({ options: { apiKey: API_KEY } });
    await h.invoke(compactableEvent());

    expect(h.envGet).not.toHaveBeenCalled();
    expect(h.settingsRead).not.toHaveBeenCalled();
    expect(authorization(h.fetch)).toMatch(/^Bearer .+/);
  });

  it('falls back to TYPESAFE_API_KEY in the environment', async () => {
    const h = harness({ options: { apiKey: undefined }, env: { TYPESAFE_API_KEY: API_KEY } });
    await h.invoke(compactableEvent());

    expect(h.envGet).toHaveBeenCalledWith('TYPESAFE_API_KEY');
    expect(h.settingsRead).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
    expect(authorization(h.fetch)).toMatch(/^Bearer .+/);
  });

  it('falls back to settings env when neither the option nor the environment has one', async () => {
    const h = harness({ options: { apiKey: undefined }, settings: { env: { TYPESAFE_API_KEY: API_KEY } } });
    await h.invoke(compactableEvent());

    expect(h.envGet).toHaveBeenCalledWith('TYPESAFE_API_KEY');
    expect(h.settingsRead).toHaveBeenCalledTimes(1);
    expect(h.next).not.toHaveBeenCalled();
    expect(authorization(h.fetch)).toMatch(/^Bearer .+/);
  });

  it('defers to next without contacting Jev when no key is configured anywhere', async () => {
    const h = harness({ options: { apiKey: undefined } });
    const event = compactableEvent();

    expect(await h.invoke(event)).toBe('built-in');
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.next.mock.calls[0]?.[0]).toBe(event);
    expect(h.messages().join('\n')).toContain('TYPESAFE_API_KEY is not configured');
  });
});
