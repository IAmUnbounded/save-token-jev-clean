import { describe, expect, it } from 'vitest';
import { fromAnthropic } from '../src/adapters/anthropic.js';
import { fromCodexJsonl } from '../src/adapters/codex.js';
import { fromOpenCode } from '../src/adapters/opencode.js';
import { fromClaudeSession, toClaudeSession } from '../src/integrations/claude.js';

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
