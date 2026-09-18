import { describe, expect, it } from 'vitest';
import { compact, reductionRatio } from '../src/core.js';
import type { JevAsker, TranscriptMessage } from '../src/types.js';

const asker: JevAsker = {
  async ask(_state, questions) {
    return {
      answers: Object.fromEntries(Object.keys(questions).map((name) => [name, {
        noul: name.includes('t2') && name.startsWith('call_') ? 0.9 : 0.1,
      }])),
    };
  },
};

describe('compact', () => {
  it('drops call/result pairs together and truncates results independently', async () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Fix it without touching generated files.' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'old.txt' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'call-1', output: 'stale output'.repeat(100) }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-2', name: 'test', input: { suite: 'unit' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'call-2', output: 'failure details '.repeat(100) }] },
      { role: 'user', parts: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'working' }] },
      { role: 'user', parts: [{ type: 'text', text: 'latest' }] },
    ];

    const result = await compact(messages, asker, { preserveRecentMessages: 1, truncateHeadChars: 20 });
    const parts = result.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'tool_call' && part.id === 'call-1')).toBe(false);
    expect(parts.some((part) => part.type === 'tool_result' && part.callId === 'call-1')).toBe(false);
    expect(parts.some((part) => part.type === 'tool_call' && part.id === 'call-2')).toBe(true);
    const resultPart = parts.find((part) => part.type === 'tool_result' && part.callId === 'call-2');
    expect(resultPart).toMatchObject({ type: 'tool_result' });
    expect((resultPart as { output: string }).output).toContain('save-token-jev omitted');
    expect(result.stats.callsDropped).toBe(1);
    expect(result.stats.resultsTruncated).toBe(1);
    expect(reductionRatio(result)).toBeGreaterThan(0.5);
  });

  it('does not contact Jev when all calls are pinned', async () => {
    let calls = 0;
    const result = await compact([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'x', name: 'read', input: {} }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'x', output: 'value' }] },
    ], { ask: async () => { calls++; return { answers: {} }; } }, { preserveRecentMessages: 2 });
    expect(calls).toBe(0);
    expect(result.stats.pinned).toBe(1);
    expect(result.messages).toHaveLength(2);
  });
});
