import type { MessageRole, TranscriptMessage, TranscriptPart } from '../types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function role(value: unknown): MessageRole {
  return value === 'system' || value === 'developer' || value === 'user' || value === 'assistant' || value === 'tool'
    ? value
    : 'unknown';
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!isRecord(item)) return '';
      return typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable value]';
  }
}

export function message(roleValue: unknown, parts: TranscriptPart[], id?: unknown, metadata?: Record<string, unknown>): TranscriptMessage {
  const result: TranscriptMessage = { role: role(roleValue), parts };
  if (typeof id === 'string') result.id = id;
  if (metadata) result.metadata = metadata;
  return result;
}

export function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
