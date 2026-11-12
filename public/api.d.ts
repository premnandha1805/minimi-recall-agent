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
  kind: 'not_implemented' | 'http_error' | 'network_error' | 'aborted' | 'unsupported_response' | 'ok';
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  conversationId?: string;
  details?: ValidationDetail[];
  contentType?: string;
  rawResponse?: Response;
  data?: unknown;
  omittedHistoryCount?: number;
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
  },
): Promise<ChatApiResult>;
