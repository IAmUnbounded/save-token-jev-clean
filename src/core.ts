import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact-core.js';
import type { CompactOptions, CompactResult, TranscriptMessage } from './types.js';

export * from './compact-core.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

export function compactMessages(
  messages: readonly TranscriptMessage[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}
