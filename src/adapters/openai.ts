import type { TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.js';
import { isRecord, message, parseJsonArguments, stringify, textFromContent } from './shared.js';

/** Decodes Chat Completions messages. */
export function fromOpenAIChat(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input)) throw new TypeError('OpenAI chat transcript must be an array');
  return input.map((value) => {
    if (!isRecord(value)) return message('unknown', [{ type: 'opaque', value }]);
    const parts: TranscriptPart[] = [];
    const text = textFromContent(value.content);
    if (text) parts.push({ type: 'text', text });
    if (Array.isArray(value.tool_calls)) {
      for (const tool of value.tool_calls) {
        if (!isRecord(tool)) continue;
        const fn = isRecord(tool.function) ? tool.function : tool;
        const id = typeof tool.id === 'string' ? tool.id : typeof tool.call_id === 'string' ? tool.call_id : undefined;
        if (id) parts.push({ type: 'tool_call', id, name: typeof fn.name === 'string' ? fn.name : 'tool', input: parseJsonArguments(fn.arguments ?? fn.input) });
      }
    }
    if (value.role === 'tool' && typeof value.tool_call_id === 'string') {
      parts.push({ type: 'tool_result', callId: value.tool_call_id, output: value.content ?? '' });
    }
    if (!parts.length) parts.push({ type: 'opaque', value });
    return message(value.role, parts, value.id);
  });
}

/** Decodes OpenAI Responses API input/output items, including custom tools. */
export function fromOpenAIResponses(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input)) throw new TypeError('OpenAI Responses transcript must be an array');
  return input.map((value) => responseItem(value));
}

export function responseItem(value: unknown): TranscriptMessage {
  if (!isRecord(value)) return message('unknown', [{ type: 'opaque', value }]);
  if (value.type === 'message') {
    const text = textFromContent(value.content);
    return message(value.role, text ? [{ type: 'text', text }] : [{ type: 'opaque', value }], value.id);
  }

  const type = typeof value.type === 'string' ? value.type : '';
  const callId = typeof value.call_id === 'string' ? value.call_id : typeof value.id === 'string' ? value.id : undefined;
  if (callId && (type.endsWith('_call') || type === 'function_call')) {
    const name = typeof value.name === 'string' ? value.name : type.replace(/_call$/, '') || 'tool';
    const input = value.arguments ?? value.input ?? value.action ?? {};
    return message('assistant', [{ type: 'tool_call', id: callId, name, input: parseJsonArguments(input) }], value.id);
  }
  if (callId && (type.endsWith('_call_output') || type === 'function_call_output')) {
    return message('tool', [{ type: 'tool_result', callId, output: value.output ?? value.result ?? '' }], value.id);
  }
  return message('unknown', [{ type: 'opaque', value }], value.id);
}

export const openAIResponsesAdapter: TranscriptAdapter<unknown> = {
  name: 'openai-responses',
  canDecode(input) {
    return Array.isArray(input) && input.some((item) => isRecord(item) && typeof item.type === 'string');
  },
  decode: fromOpenAIResponses,
};

export const openAIChatAdapter: TranscriptAdapter<unknown> = {
  name: 'openai-chat',
  canDecode(input) {
    return Array.isArray(input) && input.some((item) => isRecord(item) && typeof item.role === 'string' && ('tool_calls' in item || 'tool_call_id' in item));
  },
  decode: fromOpenAIChat,
};

export function stringifyOpenAIValue(value: unknown): string {
  return stringify(value);
}
