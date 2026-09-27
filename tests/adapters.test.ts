import { describe, expect, it } from 'vitest';
import { fromAnthropic } from '../src/adapters/anthropic.js';
import { fromCodexJsonl } from '../src/adapters/codex.js';
import { fromOpenCode } from '../src/adapters/opencode.js';
import { compact } from '../src/compact-core.js';
import { fromClaudeSession, toClaudeSession, type ClaudeSessionMessage } from '../src/integrations/claude.js';
import type { JevAsker } from '../src/types.js';

describe('transcript adapters', () => {
  it('decodes Anthropic blocks and preserves unknown blocks', () => {
    const messages = fromAnthropic([
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } }, { type: 'thinking', data: 'opaque' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file body' }] },
    ]);
    expect(messages[0]?.parts).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'opaque', value: { type: 'thinking', data: 'opaque' } },
    ]);
    expect(messages[1]?.parts[0]).toEqual({ type: 'tool_result', callId: 'a', output: 'file body' });
  });

  it('decodes Codex response items without duplicating event messages', () => {
    const jsonl = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"pwd"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '/tmp' } },
    ].map(JSON.stringify).join('\n');
    const messages = fromCodexJsonl(jsonl);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.parts[0]).toEqual({ type: 'text', text: 'real prompt' });
    expect(messages[1]?.parts[0]).toMatchObject({ type: 'tool_call', id: 'c1', input: { cmd: 'pwd' } });
    expect(messages[2]?.parts[0]).toEqual({ type: 'tool_result', callId: 'c1', output: '/tmp' });
  });

  it('decodes OpenCode V1 tool state and V2 tool parts', () => {
    const messages = fromOpenCode([
      { info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'tool', callID: 'oc1', tool: 'read', state: { status: 'completed', input: { path: 'x' }, output: 'body' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'oc2', toolName: 'bash', input: { command: 'pwd' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'oc2', output: '/repo' }] },
    ]);
    expect(messages[0]?.parts).toHaveLength(2);
    expect(messages[0]?.parts[1]).toEqual({ type: 'tool_result', callId: 'oc1', output: 'body' });
    expect(messages[2]?.parts[0]).toEqual({ type: 'tool_result', callId: 'oc2', output: '/repo' });
  });

  it('round-trips untouched Claude session messages by identity', () => {
    const source = [
      { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'c', tool: 'Read', input: { file_path: 'x' } }] },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'c', text: 'body' }] },
    ];
    const normalized = fromClaudeSession(source);
    const output = toClaudeSession(normalized.messages, normalized.originals);
    expect(output[0]).toBe(source[0]);
    expect(output[1]).toBe(source[1]);
  });
});

/**
 * Claude Code stamps an opaque `handle` on every message it hands a `session.compact` hook. A
 * message returned with its handle is taken as the engine's own and used whole; a message without
 * one is rebuilt from `role`, `text` and its tool blocks. So an untouched message must come back
 * by identity (handle intact), and a message the compactor changed must come back without one, or
 * the engine would silently keep its own copy and discard the compaction.
 */
describe('Claude session round-trip', () => {
  /** Keeps c1's call but not its result (truncate), and drops c2 outright. */
  const asker: JevAsker = {
    async ask(_state, questions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [name, { noul: name === 'call_t1' ? 0.9 : 0.01 }]),
        ),
      };
    },
  };

  const bulk = 'stale output '.repeat(200);

  function session(): ClaudeSessionMessage[] {
    return [
      { role: 'user', text: 'Fix the parser.', toolUses: [], handle: 'h-goal' },
      { role: 'assistant', text: 'reading', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { p: 'a.ts' }, text: bulk }], handle: 'h-call-1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: bulk }], handle: 'h-result-1' },
      { role: 'assistant', text: 'listing', toolUses: [{ tool_use_id: 'c2', tool: 'Bash', input: { cmd: 'ls' }, text: 'files' }], handle: 'h-call-2' },
      { role: 'user', text: 'and now?', toolUses: [], toolResults: [{ tool_use_id: 'c2', text: 'files' }], handle: 'h-result-2' },
      { role: 'assistant', text: 'done', toolUses: [], handle: 'h-done' },
    ];
  }

  async function compactSession(source: ClaudeSessionMessage[], options = {}) {
    const normalized = fromClaudeSession(source);
    const result = await compact(normalized.messages, asker, { preserveRecentMessages: 0, truncateHeadChars: 20, ...options });
    return { result, output: toClaudeSession(result.messages, normalized.originals) };
  }

  it('preserves untouched messages by object identity, opaque host fields included', async () => {
    const source = session();
    const { output } = await compactSession(source);

    // Messages no decision touched: same objects, so their handles travel untouched.
    expect(output[0]).toBe(source[0]);
    expect(output[1]).toBe(source[1]);
    expect(output[5]).toBe(source[5]);
    expect(output[0]?.handle).toBe('h-goal');
    expect(output[5]?.handle).toBe('h-done');
  });

  it('rebuilds a message whose result was truncated, dropping its handle', async () => {
    const source = session();
    const { output, result } = await compactSession(source);
    expect(result.stats.resultsTruncated).toBe(1);

    const rebuilt = output[2]!;
    expect(rebuilt).not.toBe(source[2]);
    expect(rebuilt.handle).toBeUndefined();
    expect('handle' in rebuilt).toBe(false);

    const truncated = rebuilt.toolResults?.[0];
    expect(truncated?.tool_use_id).toBe('c1');
    expect(truncated?.text.length).toBeLessThan(bulk.length);
    expect(truncated?.text).toContain('save-token-jev omitted');

    // The assistant message holding c1's tool_use was not itself changed, so it keeps its handle.
    expect(output[1]).toBe(source[1]);
  });

  it('removes both halves of a dropped call and rebuilds the messages that held them', async () => {
    const source = session();
    const { output, result } = await compactSession(source);
    expect(result.stats.callsDropped).toBe(1);

    const callSide = output[3]!;
    expect(callSide).not.toBe(source[3]);
    expect(callSide.handle).toBeUndefined();
    expect(callSide.toolUses).toEqual([]);
    expect(callSide.text).toBe('listing');

    const resultSide = output[4]!;
    expect(resultSide).not.toBe(source[4]);
    expect(resultSide.handle).toBeUndefined();
    expect(resultSide.toolResults).toBeUndefined();
    expect(resultSide.text).toBe('and now?');

    // Nothing anywhere still refers to the dropped call.
    expect(JSON.stringify(output)).not.toContain('c2');
  });

  it('prunes a message left empty by a dropped call, keeping the rest by identity', async () => {
    const source: ClaudeSessionMessage[] = [
      { role: 'user', text: 'goal', toolUses: [], handle: 'p-goal' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: {} }], handle: 'p-call' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'z'.repeat(500) }], handle: 'p-result' },
      { role: 'assistant', text: 'done', toolUses: [], handle: 'p-done' },
    ];
    const dropEverything: JevAsker = {
      async ask(_state, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.01 }])) };
      },
    };
    const normalized = fromClaudeSession(source);
    const result = await compact(normalized.messages, dropEverything, { preserveRecentMessages: 0 });
    const output = toClaudeSession(result.messages, normalized.originals);

    // Both messages carried nothing but the dropped call, so both go.
    expect(output).toHaveLength(2);
    expect(output[0]).toBe(source[0]);
    expect(output[1]).toBe(source[3]);
    expect(output.map((message) => message.handle)).toEqual(['p-goal', 'p-done']);
  });
});

/**
 * Confirmed against Claude Code 2.1.283: `toolUses[].text` is not stored on the assistant message.
 * The host attaches it when a transcript is read, by pairing the tool_use with the matching
 * `toolResults` entry of a later message. It is derived metadata, not separately transmitted
 * content, so the adapter ignores it and the compactor must not count it.
 */
describe('Claude toolUses[].text is host-derived metadata', () => {
  const keepEverything: JevAsker = {
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 1 }])) };
    },
  };

  function withDerivedText(text: string | undefined): ClaudeSessionMessage[] {
    return [
      { role: 'user', text: 'goal', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { p: 'a' }, ...(text === undefined ? {} : { text }) }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'body' }] },
    ];
  }

  it('is left out of the normalized transcript, so it cannot skew the byte accounting', async () => {
    const withoutText = fromClaudeSession(withDerivedText(undefined));
    const withStaleText = fromClaudeSession(withDerivedText('X'.repeat(5_000)));
    expect(withStaleText.messages).toEqual(withoutText.messages);

    const bare = await compact(withoutText.messages, keepEverything, { preserveRecentMessages: 0 });
    const stale = await compact(withStaleText.messages, keepEverything, { preserveRecentMessages: 0 });
    expect(stale.stats.charsBefore).toBe(bare.stats.charsBefore);
    expect(stale.stats.charsAfter).toBe(bare.stats.charsAfter);
  });

  it('leaves an in-flight call untouched, having no result to compact', async () => {
    // A call with no matching toolResults anywhere is still running: there is nothing to shorten,
    // and the pair must survive so the transcript stays answerable.
    const source: ClaudeSessionMessage[] = [
      { role: 'user', text: 'goal', toolUses: [], handle: 'f-goal' },
      { role: 'assistant', text: 'running', toolUses: [{ tool_use_id: 'c9', tool: 'Bash', input: { cmd: 'sleep 1' } }], handle: 'f-call' },
    ];
    const normalized = fromClaudeSession(source);
    const result = await compact(normalized.messages, keepEverything, { preserveRecentMessages: 0 });
    const output = toClaudeSession(result.messages, normalized.originals);

    expect(result.stats.calls).toBe(0);
    expect(result.decisions).toEqual([]);
    expect(output[0]).toBe(source[0]);
    expect(output[1]).toBe(source[1]);
    expect(output[1]?.toolUses[0]?.tool_use_id).toBe('c9');
  });
});
