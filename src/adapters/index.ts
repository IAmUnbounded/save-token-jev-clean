import type { TranscriptAdapter, TranscriptMessage } from '../types.js';
import { anthropicAdapter } from './anthropic.js';
import { genericAdapter } from './generic.js';
import { openAIChatAdapter, openAIResponsesAdapter } from './openai.js';
import { openCodeAdapter } from './opencode.js';

export * from './anthropic.js';
export * from './codex.js';
export * from './generic.js';
export * from './openai.js';
export * from './opencode.js';

export const builtInAdapters: readonly TranscriptAdapter<unknown>[] = [
  genericAdapter,
  anthropicAdapter,
  openCodeAdapter,
  openAIChatAdapter,
  openAIResponsesAdapter,
];

export function decodeTranscript(input: unknown, format = 'auto', adapters: readonly TranscriptAdapter<unknown>[] = builtInAdapters): TranscriptMessage[] {
  if (format !== 'auto') {
    const adapter = adapters.find((candidate) => candidate.name === format);
    if (!adapter) throw new Error(`Unknown transcript format: ${format}`);
    return adapter.decode(input);
  }
  const adapter = adapters.find((candidate) => candidate.canDecode(input));
  if (!adapter) throw new Error('No adapter recognized this transcript; use normalized generic messages or register an adapter');
  return adapter.decode(input);
}
