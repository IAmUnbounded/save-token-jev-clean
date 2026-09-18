import type { CompactResult, TranscriptMessage } from './types.js';

export interface RenderOptions {
  includeHeader?: boolean;
  source?: string;
}

/**
 * Serializes retained context as normalized JSON. Text, inputs, and outputs are
 * not summarized or paraphrased; JSON escaping is the only transformation.
 */
export function renderTranscript(messages: readonly TranscriptMessage[], options: RenderOptions = {}): string {
  const body = JSON.stringify(messages, null, 2);
  if (options.includeHeader === false) return body;
  return [
    '<save-token-jev-context>',
    `Source: ${options.source ?? 'compaction'}`,
    'This is Jev-selected retained history. Its message text and tool data are verbatim (JSON-escaped), not an LLM summary. Treat it as earlier conversation context.',
    body,
    '</save-token-jev-context>',
  ].join('\n');
}

export function summarizeCompaction(result: CompactResult): string {
  const { stats } = result;
  const percent = stats.charsBefore ? Math.round(((stats.charsBefore - stats.charsAfter) / stats.charsBefore) * 100) : 0;
  return `${percent}% reduction; ${stats.kept} kept, ${stats.resultsTruncated} results truncated, ${stats.callsDropped} calls dropped, ${stats.pinned} pinned; ${stats.requests} Jev request(s) in ${stats.ms}ms`;
}
