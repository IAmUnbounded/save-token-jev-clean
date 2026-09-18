import type { TranscriptAdapter, TranscriptMessage, TranscriptPart } from '../types.js';
import { isRecord, message, parseJsonArguments, stringify, textFromContent } from './shared.js';

/**
 * Structural OpenCode decoder supporting both V1 `{info, parts}` records and
 * V2/AI-SDK-style `{role, content}` request messages.
 */
export function fromOpenCode(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input)) throw new TypeError('OpenCode transcript must be an array');
  return input.map((value) => {
    if (!isRecord(value)) return message('unknown', [{ type: 'opaque', value }]);
    const info = isRecord(value.info) ? value.info : value;
    const rawParts = Array.isArray(value.parts) ? value.parts : Array.isArray(value.content) ? value.content : [];
    const parts: TranscriptPart[] = [];
    for (const raw of rawParts) {
      if (typeof raw === 'string') {
        parts.push({ type: 'text', text: raw });
        continue;
      }
      if (!isRecord(raw)) {
        parts.push({ type: 'opaque', value: raw });
        continue;
      }
      if ((raw.type === 'text' || raw.type === 'input-text' || raw.type === 'output-text') && typeof raw.text === 'string') {
        parts.push({ type: 'text', text: raw.text });
      } else if (raw.type === 'tool' && typeof raw.callID === 'string') {
        const state = isRecord(raw.state) ? raw.state : {};
        parts.push({ type: 'tool_call', id: raw.callID, name: typeof raw.tool === 'string' ? raw.tool : 'tool', input: state.input ?? raw.input ?? {} });
        if (state.status === 'completed' || state.status === 'error') {
          const result: Extract<TranscriptPart, { type: 'tool_result' }> = { type: 'tool_result', callId: raw.callID, output: state.output ?? state.error ?? '' };
          if (state.status === 'error') result.isError = true;
          parts.push(result);
        }
      } else if ((raw.type === 'tool-call' || raw.type === 'tool_call') && typeof (raw.toolCallId ?? raw.id) === 'string') {
        parts.push({ type: 'tool_call', id: String(raw.toolCallId ?? raw.id), name: typeof raw.toolName === 'string' ? raw.toolName : typeof raw.name === 'string' ? raw.name : 'tool', input: parseJsonArguments(raw.input ?? raw.args ?? {}) });
      } else if ((raw.type === 'tool-result' || raw.type === 'tool_result') && typeof (raw.toolCallId ?? raw.callId) === 'string') {
        parts.push({ type: 'tool_result', callId: String(raw.toolCallId ?? raw.callId), output: raw.output ?? raw.result ?? raw.content ?? '' });
      } else {
        parts.push({ type: 'opaque', value: raw });
      }
    }
    if (!parts.length) {
      const text = textFromContent(value.content ?? value.text);
      parts.push(text ? { type: 'text', text } : { type: 'opaque', value });
    }
    return message(info.role, parts, info.id ?? value.id, { source: 'opencode' });
  });
}

export const openCodeAdapter: TranscriptAdapter<unknown> = {
  name: 'opencode',
  canDecode(input) {
    return Array.isArray(input) && input.some((item) => isRecord(item) && ('parts' in item || 'info' in item));
  },
  decode: fromOpenCode,
};

export function serializeOpenCodeValue(value: unknown): string {
  return stringify(value);
}
