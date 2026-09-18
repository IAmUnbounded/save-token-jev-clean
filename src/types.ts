export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'unknown';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  output: unknown;
  isError?: boolean;
}

/** Data the compactor does not understand. It is always preserved. */
export interface OpaquePart {
  type: 'opaque';
  value: unknown;
}

export type TranscriptPart = TextPart | ToolCallPart | ToolResultPart | OpaquePart;

export interface TranscriptMessage {
  id?: string;
  role: MessageRole;
  parts: TranscriptPart[];
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  callId: string;
  name: string;
  input: unknown;
  callMessageIndex: number;
  resultMessageIndex: number;
  resultChars: number;
  isError: boolean;
  pinned: boolean;
}

export type CallAction = 'keep' | 'truncate_result' | 'drop_call';

export interface CallDecision {
  id: string;
  callId: string;
  name: string;
  inputPreview: string;
  resultChars: number;
  savedChars: number;
  keepCall: number;
  keepResult: number;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_truncated' | 'call_dropped';
}

export interface CompactOptions {
  goal?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  truncateHeadChars?: number;
  /** Maximum number of Jev requests allowed to run at once. */
  maxConcurrentRequests?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  maxConcurrentRequests: number;
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  resultsTruncated: number;
  callsDropped: number;
  pinned: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
}

export interface CompactResult {
  messages: TranscriptMessage[];
  decisions: CallDecision[];
  stats: CompactStats;
}

export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type JevQuestions = Record<string, NoulQuestion>;

export interface JevAnswer {
  type?: 'noul';
  noul: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}

export interface TranscriptAdapter<T> {
  readonly name: string;
  canDecode(input: unknown): boolean;
  decode(input: T): TranscriptMessage[];
}
