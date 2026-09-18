import type { TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.js';
import { isRecord, message, stringify } from './shared.js';

/** Decodes Anthropic/Claude message content blocks without discarding unknown blocks. */
export function fromAnthropic(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input)) throw new TypeError('Anthropic transcript must be an array');
  return input.map((value) => {
    if (!isRecord(value)) return message('unknown', [{ type: 'opaque', value }]);
    const content = value.content;
    if (typeof content === 'string') return message(value.role, [{ type: 'text', text: content }], value.id);
    if (!Array.isArray(content)) return message(value.role, [{ type: 'opaque', value }], value.id);
    const parts: TranscriptPart[] = content.map((block): TranscriptPart => {
      if (!isRecord(block)) return { type: 'opaque', value: block };
      if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        return { type: 'tool_call', id: block.id, name: typeof block.name === 'string' ? block.name : 'tool', input: block.input ?? {} };
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const result: Extract<TranscriptPart, { type: 'tool_result' }> = {
          type: 'tool_result',
          callId: block.tool_use_id,
          output: typeof block.content === 'string' ? block.content : stringify(block.content),
        };
        if (block.is_error === true) result.isError = true;
        return result;
      }
      return { type: 'opaque', value: block };
    });
    return message(value.role, parts, value.id);
  });
}

export const anthropicAdapter: TranscriptAdapter<unknown> = {
  name: 'anthropic',
  canDecode(input) {
    return Array.isArray(input) && input.some((item) => isRecord(item) && Array.isArray(item.content) && item.content.some((block) => isRecord(block) && (block.type === 'tool_use' || block.type === 'tool_result')));
  },
  decode: fromAnthropic,
};
