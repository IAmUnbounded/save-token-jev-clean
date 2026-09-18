import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodePlugin } from '../src/integrations/opencode.js';

afterEach(() => vi.unstubAllGlobals());

describe('OpenCode plugin', () => {
  it('exports the V2 id/setup contract and supplies a compaction result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { call_t1: { noul: 0 }, result_t1: { noul: 0 } },
    }), { status: 200 })));
    let callback: ((event: { messages: unknown[]; result?: unknown }) => Promise<void>) | undefined;
    const plugin = createOpenCodePlugin({ apiKey: 'test', preserveRecentMessages: 0, minReductionRatio: 0 });
    expect(plugin.id).toBe('save-token-jev');
    await plugin.setup({
      session: {
        async hook(name, value) {
          expect(name).toBe('compaction');
          callback = value;
          return { dispose() {} };
        },
      },
    });
    const event: { messages: unknown[]; result?: { summary: string } } = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'goal' }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'read', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', output: 'x'.repeat(1_000) }] },
      ],
    };
    await callback!(event);
    expect(event.result?.summary).toContain('<save-token-jev-context>');
    expect(event.result?.summary).not.toContain('x'.repeat(100));
  });
});
