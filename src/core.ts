import { JevClient, noulAnswer, type JevClientOptions } from './client.js';
import type {
  CallAction,
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  JevQuestions,
  JevState,
  ResolvedCompactOptions,
  ToolCall,
  ToolResultPart,
  TranscriptMessage,
  TranscriptPart,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  maxConcurrentRequests: 4,
};

export const STATE_CONTEXT =
  'A coding-agent conversation is being compacted. History is oldest first. Tool outputs are represented by size/status notes. Decide whether each tool call and its full result must remain verbatim. Deleted tools can normally be run again. User constraints, decisions, errors that explain later work, and irreproducible outputs are important.';

const INPUT_LIMITS = [1_000, 200, 60] as const;
const REQUEST_OVERHEAD_TOKENS = 20;

interface StateCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

interface StateEntry {
  i: number;
  role: string;
  text: string;
  tool_calls?: StateCall[] | string[];
}

interface CompactionState {
  context: string;
  goal: string;
  history: StateEntry[];
}

interface FittedState {
  state: CompactionState;
  tokens: number;
  stage: string;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: Math.min(1, Math.max(0, finite(options.keepThreshold, 0.5))),
    preserveRecentMessages: Math.max(0, Math.floor(finite(options.preserveRecentMessages, 6))),
    maxStateTokens: Math.max(1, Math.floor(finite(options.maxStateTokens, 25_000))),
    maxRequestTokens: Math.max(1, Math.floor(finite(options.maxRequestTokens, 30_000))),
    truncateHeadChars: Math.max(0, Math.floor(finite(options.truncateHeadChars, 300))),
    maxConcurrentRequests: Math.max(1, Math.floor(finite(options.maxConcurrentRequests, 4))),
  };
}

/** Conservative tokenizer-free estimate suitable for JSON-heavy Jev requests. */
export function estimateTokens(text: string): number {
  const pieces = text.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? [];
  let tokens = 0;
  for (const piece of pieces) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[unserializable value]';
  }
}

function inputPreview(value: unknown): string {
  let text = stringify(value).replace(/\s+/g, ' ');
  text = text.replace(/("(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
  text = text.replace(/((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[=:]\s*)[^\s,}]+/gi, '$1[redacted]');
  return truncate(text, 180);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function isPinned(index: number, total: number, recent: number): boolean {
  return index === 0 || index >= total - recent;
}

export function collectToolCalls(messages: readonly TranscriptMessage[], recent: number): ToolCall[] {
  const results = new Map<string, { messageIndex: number; part: ToolResultPart }>();
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts) {
      if (part.type === 'tool_result') results.set(part.callId, { messageIndex, part });
    }
  });

  const calls: ToolCall[] = [];
  messages.forEach((message, callMessageIndex) => {
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      const result = results.get(part.id);
      if (!result) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        callId: part.id,
        name: part.name,
        input: part.input,
        callMessageIndex,
        resultMessageIndex: result.messageIndex,
        resultChars: stringify(result.part.output).length,
        isError: result.part.isError ?? false,
        pinned:
          isPinned(callMessageIndex, messages.length, recent) ||
          isPinned(result.messageIndex, messages.length, recent),
      });
    }
  });
  return calls;
}

function textOf(message: TranscriptMessage): string {
  return message.parts
    .filter((part): part is Extract<TranscriptPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function goalFromMessages(messages: readonly TranscriptMessage[]): string {
  return messages
    .filter((message) => message.role === 'user' && textOf(message).trim())
    .slice(-3)
    .map((message) => truncate(textOf(message), 500))
    .join('\n');
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const result = new Map<number, ToolCall[]>();
  for (const call of calls) result.set(call.callMessageIndex, [...(result.get(call.callMessageIndex) ?? []), call]);
  return result;
}

function stateEntries(
  messages: readonly TranscriptMessage[],
  calls: readonly ToolCall[],
  inputLimit: number,
): StateEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: StateEntry[] = [];
  messages.forEach((message, i) => {
    const text = textOf(message);
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.name,
      input: truncate(stringify(call.input), inputLimit),
      result: `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`,
    }));
    if (!text.trim() && toolCalls.length === 0) return;
    const entry: StateEntry = { i, role: message.role, text };
    if (toolCalls.length) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

function fitState(
  messages: readonly TranscriptMessage[],
  calls: readonly ToolCall[],
  options: ResolvedCompactOptions,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const byMessage = callsByMessage(calls);
  const make = (history: StateEntry[]): FittedState => {
    const state = { context: STATE_CONTEXT, goal, history };
    return { state, tokens: estimateTokens(JSON.stringify(state)), stage: 'full' };
  };

  for (const limit of INPUT_LIMITS) {
    const fitted = make(stateEntries(messages, calls, limit));
    fitted.stage = limit === INPUT_LIMITS[0] ? 'full' : `inputs<=${limit}`;
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }

  let history = stateEntries(messages, calls, INPUT_LIMITS.at(-1)!);
  const oldFirst = history
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number(isPinned(a.entry.i, messages.length, options.preserveRecentMessages)) - Number(isPinned(b.entry.i, messages.length, options.preserveRecentMessages)));

  for (const { entry } of oldFirst) {
    if (entry.text.length <= 590) continue;
    const omitted = entry.text.length - 550;
    entry.text = `${entry.text.slice(0, 400)}\n[… ${omitted} chars omitted …]\n${entry.text.slice(-150)}`;
    const fitted = make(history);
    fitted.stage = 'texts abridged';
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }

  for (const { entry } of oldFirst) {
    if (isPinned(entry.i, messages.length, options.preserveRecentMessages) || !entry.text) continue;
    entry.text = `[… ${textOf(messages[entry.i]!).length} chars omitted …]`;
    const fitted = make(history);
    fitted.stage = 'old messages collapsed';
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }

  for (const { entry } of oldFirst) {
    if (isPinned(entry.i, messages.length, options.preserveRecentMessages) || !entry.tool_calls) continue;
    const own = byMessage.get(entry.i) ?? [];
    entry.tool_calls = own.map((call) => `${call.id} ${call.name} ${truncate(stringify(call.input).replace(/\s+/g, ' '), 60)} → ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`);
    const fitted = make(history);
    fitted.stage = 'old calls compacted';
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }

  for (const { entry } of oldFirst) {
    if (isPinned(entry.i, messages.length, options.preserveRecentMessages) || entry.tool_calls) continue;
    history = history.filter((candidate) => candidate !== entry);
    const fitted = make(history);
    fitted.stage = 'old messages left out';
    if (fitted.tokens <= options.maxStateTokens) return fitted;
  }

  const fitted = make(history);
  throw new Error(`history too large for Jev (~${fitted.tokens} tokens after truncation, limit ${options.maxStateTokens})`);
}

export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.name}) should remain: knowing it ran with this input still matters for the agent's next actions`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full ${call.resultChars}-character result of ${call.id} (${call.name}) must remain verbatim: its exact contents are still needed and re-running it would not recover them`,
    },
  };
}

function batchCalls(calls: readonly ToolCall[], stateTokens: number, maxRequestTokens: number): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (!current.length && tokens > budget) throw new Error(`state leaves no room for Jev questions (~${stateTokens}/${maxRequestTokens} tokens)`);
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function askBatches(
  batches: readonly ToolCall[][],
  state: JevState,
  asker: JevAsker,
  maxConcurrent: number,
): Promise<Array<{ id: string; keepCall: number; keepResult: number }[]>> {
  const responses: Array<{ id: string; keepCall: number; keepResult: number }[]> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index]!;
      const questions = Object.assign({}, ...batch.map(questionsFor)) as JevQuestions;
      const response = await asker.ask(state, questions);
      responses[index] = batch.map((call) => ({
        id: call.id,
        keepCall: noulAnswer(response.answers, `call_${call.id}`),
        keepResult: noulAnswer(response.answers, `result_${call.id}`),
      }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, batches.length) }, () => worker()));
  return responses;
}

function decide(
  call: ToolCall,
  keepCall: number,
  keepResult: number,
  threshold: number,
  truncateHeadChars: number,
): CallDecision {
  let action: CallAction = 'drop_call';
  let reason: CallDecision['reason'] = 'call_dropped';
  if (call.pinned) [action, reason] = ['keep', 'pinned'];
  else if (keepResult >= threshold) [action, reason] = ['keep', 'kept'];
  else if (keepCall >= threshold) [action, reason] = ['truncate_result', 'result_truncated'];
  const originalChars = stringify(call.input).length + call.resultChars;
  const savedChars = action === 'drop_call'
    ? originalChars
    : action === 'truncate_result'
      ? Math.max(0, call.resultChars - truncateHeadChars)
      : 0;
  return {
    id: call.id,
    callId: call.callId,
    name: call.name,
    inputPreview: inputPreview(call.input),
    resultChars: call.resultChars,
    savedChars,
    keepCall,
    keepResult,
    action,
    reason,
  };
}

function truncatedOutput(output: unknown, isError: boolean, headChars: number): string {
  const text = stringify(output);
  if (text.length <= headChars + 120) return text;
  const head = headChars ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[save-token-jev omitted ${text.length - headChars} chars from this tool result${isError ? ' (error)' : ''}; rerun the tool if needed]`;
}

export function applyDecisions(
  messages: readonly TranscriptMessage[],
  decisions: readonly CallDecision[],
  headChars: number,
): TranscriptMessage[] {
  const actions = new Map(decisions.map((decision) => [decision.callId, decision.action]));
  return messages.flatMap((message) => {
    let changed = false;
    const parts = message.parts.flatMap<TranscriptPart>((part) => {
      const callId = part.type === 'tool_call' ? part.id : part.type === 'tool_result' ? part.callId : undefined;
      if (!callId) return [part];
      const action = actions.get(callId);
      if (action === 'drop_call') {
        changed = true;
        return [];
      }
      if (action === 'truncate_result' && part.type === 'tool_result') {
        const output = truncatedOutput(part.output, part.isError ?? false, headChars);
        if (output !== part.output) changed = true;
        return [{ ...part, output }];
      }
      return [part];
    });
    if (!parts.length) return [];
    return [changed ? { ...message, parts } : message];
  });
}

export function messageChars(message: TranscriptMessage): number {
  return message.parts.reduce((sum, part) => {
    if (part.type === 'text') return sum + part.text.length;
    if (part.type === 'tool_call') return sum + stringify(part.input).length;
    if (part.type === 'tool_result') return sum + stringify(part.output).length;
    return sum + stringify(part.value).length;
  }, 0);
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  return result.stats.charsBefore ? (result.stats.charsBefore - result.stats.charsAfter) / result.stats.charsBefore : 0;
}

export async function compact(
  messages: readonly TranscriptMessage[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const answers = new Map<string, { keepCall: number; keepResult: number }>();
  let fitted: FittedState | undefined;
  let batches: ToolCall[][] = [];

  if (candidates.length) {
    fitted = fitState(messages, calls, resolved);
    batches = batchCalls(candidates, fitted.tokens, resolved.maxRequestTokens);
    const responses = await askBatches(batches, fitted.state, asker, resolved.maxConcurrentRequests);
    for (const answer of responses.flat()) answers.set(answer.id, answer);
  }

  const decisions = calls.map((call) => {
    const answer = answers.get(call.id) ?? { keepCall: 1, keepResult: 1 };
    return decide(call, answer.keepCall, answer.keepResult, resolved.keepThreshold, resolved.truncateHeadChars);
  });
  const compacted = applyDecisions(messages, decisions, resolved.truncateHeadChars);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  const charsAfter = compacted.reduce((sum, message) => sum + messageChars(message), 0);
  const count = (reason: CallDecision['reason']): number => decisions.filter((decision) => decision.reason === reason).length;

  return {
    messages: compacted,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: compacted.length,
      charsBefore,
      charsAfter,
      calls: calls.length,
      kept: count('kept'),
      resultsTruncated: count('result_truncated'),
      callsDropped: count('call_dropped'),
      pinned: count('pinned'),
      stateTokens: fitted?.tokens ?? 0,
      stateStage: fitted?.stage ?? '',
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

export function compactMessages(messages: readonly TranscriptMessage[], options: CompactMessagesOptions = {}): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}
