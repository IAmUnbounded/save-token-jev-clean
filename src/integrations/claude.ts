import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../client.js';
import { compact, reductionRatio } from '../core.js';
import { summarizeCompaction } from '../render.js';
import type { CompactOptions, JevAsker, TranscriptMessage, TranscriptPart } from '../types.js';

export interface ClaudeToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

export interface ClaudeToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

export interface ClaudeSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ClaudeToolUse[];
  toolResults?: ClaudeToolResult[];
  [key: string]: unknown;
}

interface ClaudePluginOptions extends Record<string, unknown> {}
interface ClaudeCompactEvent { messages: ClaudeSessionMessage[] }

interface ClaudeRuntime {
  http: {
    fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; text: string }>;
  };
  env: { get(name: string): Promise<string | undefined> };
  settings: { read(): Promise<Readonly<Record<string, unknown>>> };
  ui: { log(text: string): void; toast(text: string, options?: { timeoutMs?: number }): void };
}

type Next = (event: ClaudeCompactEvent) => unknown;
type ClaudeOn = (event: 'session.compact', callback: ($: ClaudeRuntime, event: ClaudeCompactEvent, next: Next) => Promise<unknown>) => void;

interface NormalizedClaude {
  messages: TranscriptMessage[];
  originals: Map<TranscriptMessage, ClaudeSessionMessage>;
}

export function fromClaudeSession(input: readonly ClaudeSessionMessage[]): NormalizedClaude {
  const originals = new Map<TranscriptMessage, ClaudeSessionMessage>();
  const messages = input.map((source) => {
    const parts: TranscriptPart[] = [];
    if (source.text) parts.push({ type: 'text', text: source.text });
    for (const tool of source.toolUses) {
      parts.push({ type: 'tool_call', id: tool.tool_use_id, name: tool.tool, input: tool.input });
    }
    for (const result of source.toolResults ?? []) {
      const part: Extract<TranscriptPart, { type: 'tool_result' }> = { type: 'tool_result', callId: result.tool_use_id, output: result.text };
      if (result.isError) part.isError = true;
      parts.push(part);
    }
    const message: TranscriptMessage = { role: source.role, parts };
    originals.set(message, source);
    return message;
  });
  return { messages, originals };
}

export function toClaudeSession(normalized: readonly TranscriptMessage[], originals = new Map<TranscriptMessage, ClaudeSessionMessage>()): ClaudeSessionMessage[] {
  return normalized.map((message) => {
    const original = originals.get(message);
    if (original) return original;
    const toolUses: ClaudeToolUse[] = message.parts
      .filter((part): part is Extract<TranscriptPart, { type: 'tool_call' }> => part.type === 'tool_call')
      .map((part) => ({
        tool_use_id: part.id,
        tool: part.name,
        input: typeof part.input === 'object' && part.input !== null && !Array.isArray(part.input) ? part.input as Record<string, unknown> : { value: part.input },
      }));
    const toolResults: ClaudeToolResult[] = message.parts
      .filter((part): part is Extract<TranscriptPart, { type: 'tool_result' }> => part.type === 'tool_result')
      .map((part) => {
        const result: ClaudeToolResult = {
          tool_use_id: part.callId,
          text: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
        };
        if (part.isError) result.isError = true;
        return result;
      });
    const rebuilt: ClaudeSessionMessage = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: message.parts.filter((part): part is Extract<TranscriptPart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n'),
      toolUses,
    };
    if (toolResults.length) rebuilt.toolResults = toolResults;
    return rebuilt;
  });
}

function numberOption(options: ClaudePluginOptions, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function apiKey(runtime: ClaudeRuntime, options: ClaudePluginOptions): Promise<string | undefined> {
  if (typeof options.apiKey === 'string' && options.apiKey) return options.apiKey;
  const environment = await runtime.env.get('TYPESAFE_API_KEY');
  if (environment) return environment;
  const settings = await runtime.settings.read();
  const env = settings.env;
  return env && typeof env === 'object' && typeof (env as Record<string, unknown>).TYPESAFE_API_KEY === 'string'
    ? (env as Record<string, string>).TYPESAFE_API_KEY
    : undefined;
}

/** Claude Code function-hook registration entrypoint. */
export const register = (on: ClaudeOn, options: ClaudePluginOptions): void => {
  on('session.compact', async (runtime, event, next) => {
    try {
      const key = await apiKey(runtime, options);
      if (!key) throw new Error('TYPESAFE_API_KEY is not configured');
      const model = typeof options.model === 'string' ? options.model : DEFAULT_MODEL;
      const asker: JevAsker = {
        async ask(state, questions) {
          const request = buildJevRequest({ apiKey: key, model }, state, questions);
          const response = await runtime.http.fetch(request.url, request);
          return parseJevResponse(response.status, response.ok, response.text);
        },
      };
      const normalized = fromClaudeSession(event.messages);
      const compactOptions: CompactOptions = {
        keepThreshold: numberOption(options, 'keepThreshold', 0.5),
        preserveRecentMessages: numberOption(options, 'preserveRecentMessages', 6),
        maxStateTokens: numberOption(options, 'maxStateTokens', 25_000),
        maxRequestTokens: numberOption(options, 'maxRequestTokens', 30_000),
        truncateHeadChars: numberOption(options, 'truncateHeadChars', 300),
      };
      const result = await compact(normalized.messages, asker, compactOptions);
      const minimum = numberOption(options, 'minReductionRatio', 0.15);
      if (reductionRatio(result) < minimum) return next(event);
      const text = `save-token-jev: ${summarizeCompaction(result)}`;
      runtime.ui.log(text);
      runtime.ui.toast(text, { timeoutMs: 15_000 });
      return { messages: toClaudeSession(result.messages, normalized.originals) };
    } catch (error) {
      const text = `save-token-jev: using Claude's built-in compaction (${error instanceof Error ? error.message : String(error)})`;
      runtime.ui.log(text);
      runtime.ui.toast(text, { timeoutMs: 15_000 });
      return next(event);
    }
  });
};
