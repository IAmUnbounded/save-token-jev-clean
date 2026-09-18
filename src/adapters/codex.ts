import type { TranscriptMessage } from '../types.js';
import { isRecord } from './shared.js';
import { responseItem } from './openai.js';

/**
 * Reads the useful response items from a Codex rollout JSONL transcript.
 * The rollout format is intentionally isolated here because Codex documents it
 * as a convenience rather than a stable hook interface.
 */
export function fromCodexJsonl(input: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Codex JSONL at line ${index + 1}`);
    }
    if (!isRecord(row) || row.type !== 'response_item' || !isRecord(row.payload)) continue;
    const item = responseItem(row.payload);
    if (item.parts.every((part) => part.type === 'opaque')) continue;
    messages.push(item);
  }
  return messages;
}
