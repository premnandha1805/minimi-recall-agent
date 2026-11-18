export const MAX_MESSAGE_CHARS: number;
export const MAX_HISTORY_ITEMS: number;
export const MAX_HISTORY_CONTENT_CHARS: number;
export const DEFAULT_MAX_BODY_BYTES: number;

export interface ChatHistoryItem {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatRequestPayload {
  conversationId?: string;
  message: string;
  timezone?: string;
  history?: ChatHistoryItem[];
  turn?: { key: string; attemptKey: string };
}

export interface BoundedChatBodyResult {
  ok: boolean;
  exceedsLimit: boolean;
  maxBodyBytes: number;
  body: ChatRequestPayload;
  omittedCount: number;
  serializedBytes: number;
}

export interface ValidationDetail {
  path: string;
  message: string;
}

export interface HealthStatusResult {
  ok: boolean;
  service?: string;
  version?: string;
  timestamp?: string;
  errorMessage?: string;
}

export interface ChatApiResult {
  kind: 'not_implemented' | 'http_error' | 'network_error' | 'aborted' | 'unsupported_response' | 'protocol_error' | 'stream_error' | 'ok';
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  conversationId?: string;
  details?: ValidationDetail[];
  contentType?: string;
  rawResponse?: Response;
  data?: unknown;
  result?: import('../src/contracts.js').ChatResult;
  omittedHistoryCount?: number;
  receipt?: { conversationId: string; turnId: string; attemptId: string };
}

export function getUtf8ByteLength(value: string): number;

export function buildBoundedChatBody(
  payload: ChatRequestPayload,
  limits?: {
    maxHistoryItems?: number;
    maxBodyBytes?: number;
  },
): BoundedChatBodyResult;

export function getLocalTimeZone(): string | undefined;

export function checkHealth(options?: {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<HealthStatusResult>;

export function sendChatRequest(
  payload: ChatRequestPayload,
  options?: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    maxHistoryItems?: number;
    maxBodyBytes?: number;
    onProgress?: (progress: import('../src/contracts.js').ChatEventPayloads['progress']) => void;
    onDelta?: (text: string) => void;
    onDraftReset?: () => void;
  },
): Promise<ChatApiResult>;

export function validChatEvent(event: string, value: unknown): boolean;
export function readChatStream(response: Response, options?: {
  signal?: AbortSignal;
  onProgress?: (progress: import('../src/contracts.js').ChatEventPayloads['progress']) => void;
  onDelta?: (text: string) => void;
  onDraftReset?: () => void;
}): Promise<{ meta: import('../src/contracts.js').ChatEventPayloads['meta'];
  result?: import('../src/contracts.js').ChatResult;
  error?: import('../src/contracts.js').ChatEventPayloads['error'] }>;

export function memoryId(value: string | null): boolean;
export class MemoryApiError extends Error { status: number; }
export function memoryRequest(path: string, options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; method?: string; body?: object }): Promise<any>;
export function validConversation(value: unknown): value is StoredConversation;

export interface StoredConversation {
  schemaVersion: 'recall.memory.v1'; id: string;
  seededMessages: Array<ChatHistoryItem & {id: string}>;
  turns: Array<{id: string; key: string; ordinal: number; user: ChatHistoryItem & {id: string}; timezone?: string;
    attempts: Array<{id: string; key: string; status: string; answer?: {result: import('../src/contracts.js').ChatResult}}>}>
}
