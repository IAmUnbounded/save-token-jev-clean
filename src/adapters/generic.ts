import type { TranscriptAdapter, TranscriptMessage } from '../types.js';
import { isRecord } from './shared.js';

function isMessage(value: unknown): value is TranscriptMessage {
  return isRecord(value) && typeof value.role === 'string' && Array.isArray(value.parts);
}

export function fromGeneric(input: unknown): TranscriptMessage[] {
  if (!Array.isArray(input) || !input.every(isMessage)) {
    throw new TypeError('Generic transcript must be an array of normalized {role, parts} messages');
  }
  return input;
}

export const genericAdapter: TranscriptAdapter<unknown> = {
  name: 'generic',
  canDecode(input) {
    return Array.isArray(input) && input.every(isMessage);
  },
  decode: fromGeneric,
};
