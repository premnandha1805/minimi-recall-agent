// @ts-check

export const MAX_MESSAGE_CHARS = 16000;
export const MAX_HISTORY_ITEMS = 100;
export const MAX_HISTORY_CONTENT_CHARS = 32000;
export const DEFAULT_MAX_BODY_BYTES = 262144;

const utf8Encoder = new TextEncoder();

/**
 * @typedef {Object} ChatHistoryItem
 * @property {string} [id]
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {string} timestamp
 */

/**
 * @typedef {Object} ChatRequestPayload
 * @property {string} [conversationId]
 * @property {string} message
 * @property {string} [timezone]
 * @property {ChatHistoryItem[]} [history]
 */

/**
 * @typedef {Object} BoundedChatBodyResult
 * @property {boolean} ok
 * @property {boolean} exceedsLimit
 * @property {number} maxBodyBytes
 * @property {ChatRequestPayload} body
 * @property {number} omittedCount
 * @property {number} serializedBytes
 */

/**
 * @typedef {Object} ValidationDetail
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {Object} HealthStatusResult
 * @property {boolean} ok
 * @property {string} [service]
 * @property {string} [version]
 * @property {string} [timestamp]
 * @property {string} [errorMessage]
 */

/**
 * @typedef {Object} ChatApiResult
 * @property {'not_implemented' | 'http_error' | 'network_error' | 'aborted' | 'unsupported_response' | 'ok'} kind
 * @property {number} [status]
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} [requestId]
 * @property {string} [conversationId]
 * @property {ValidationDetail[]} [details]
 * @property {string} [contentType]
 * @property {Response} [rawResponse]
 * @property {unknown} [data]
 * @property {number} [omittedHistoryCount]
 */

/**
 * Computes UTF-8 byte length of a string accurately for multi-byte text.
 * @param {string} value
 * @returns {number}
 */
export function getUtf8ByteLength(value) {
  return utf8Encoder.encode(value).byteLength;
}

/**
 * Determines whether a thrown error represents request cancellation/abort.
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isAbortError(error, signal) {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return Boolean(
    error &&
      typeof error === 'object' &&
      /** @type {{ name?: unknown }} */ (error).name === 'AbortError',
  );
}

/**
 * Validates and normalizes a historical turn without altering its content.
 * @param {unknown} rawItem
 * @returns {ChatHistoryItem | null}
 */
function normalizeHistoryItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (rawItem);
  if (candidate.role !== 'user' && candidate.role !== 'assistant') {
    return null;
  }
  if (
    typeof candidate.content !== 'string' ||
    candidate.content.trim().length === 0 ||
    candidate.content.length > MAX_HISTORY_CONTENT_CHARS
  ) {
    return null;
  }
  if (typeof candidate.timestamp !== 'string' || Number.isNaN(Date.parse(candidate.timestamp))) {
    return null;
  }

  /** @type {ChatHistoryItem} */
  const normalized = {
    role: candidate.role,
    content: candidate.content,
    timestamp: candidate.timestamp,
  };
  if (typeof candidate.id === 'string' && candidate.id.trim().length > 0 && candidate.id.length <= 128) {
    normalized.id = candidate.id;
  }
  return normalized;
}

/**
 * Builds a schema-valid request payload keeping at most maxHistoryItems newest eligible turns
 * while keeping total UTF-8 JSON payload size strictly below maxBodyBytes.
 * Never truncates or rewrites historical message content.
 *
 * @param {ChatRequestPayload} payload
 * @param {{ maxHistoryItems?: number, maxBodyBytes?: number }} [limits]
 * @returns {BoundedChatBodyResult}
 */
export function buildBoundedChatBody(payload, limits = {}) {
  const maxHistoryItems = limits.maxHistoryItems ?? MAX_HISTORY_ITEMS;
  const maxBodyBytes = limits.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /** @type {ChatRequestPayload} */
  const baseBody = {
    message: payload.message,
    ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
    ...(payload.timezone ? { timezone: payload.timezone } : {}),
  };

  const baseJsonBytes = getUtf8ByteLength(JSON.stringify(baseBody));
  const rawHistory = Array.isArray(payload.history) ? payload.history : [];

  if (baseJsonBytes > maxBodyBytes) {
    return {
      ok: false,
      exceedsLimit: true,
      maxBodyBytes,
      body: baseBody,
      omittedCount: rawHistory.length,
      serializedBytes: baseJsonBytes,
    };
  }

  if (rawHistory.length === 0) {
    return {
      ok: true,
      exceedsLimit: false,
      maxBodyBytes,
      body: baseBody,
      omittedCount: 0,
      serializedBytes: baseJsonBytes,
    };
  }

  /** @type {ChatHistoryItem[]} */
  const eligible = [];
  for (const rawItem of rawHistory) {
    const cleanItem = normalizeHistoryItem(rawItem);
    if (cleanItem) {
      eligible.push(cleanItem);
    }
  }

  const recentSuffix = maxHistoryItems > 0 ? eligible.slice(-maxHistoryItems) : [];
  // Envelope for adding ,"history":[...] is 13 UTF-8 bytes plus 1 byte comma per item after first.
  const remainingByteBudget = Math.max(0, maxBodyBytes - baseJsonBytes - 13);

  /** @type {ChatHistoryItem[]} */
  const selectedReversed = [];
  let accumulatedItemBytes = 0;

  for (let i = recentSuffix.length - 1; i >= 0; i -= 1) {
    const item = recentSuffix[i];
    const itemBytes = getUtf8ByteLength(JSON.stringify(item));
    const commaBytes = selectedReversed.length > 0 ? 1 : 0;
    if (accumulatedItemBytes + commaBytes + itemBytes > remainingByteBudget) {
      break;
    }
    selectedReversed.push(item);
    accumulatedItemBytes += commaBytes + itemBytes;
  }

  const selected = selectedReversed.reverse();

  /** @param {ChatHistoryItem[]} historySlice */
  const buildWithHistory = (historySlice) =>
    historySlice.length > 0 ? { ...baseBody, history: historySlice } : baseBody;

  let candidateBody = buildWithHistory(selected);
  let serializedBytes = getUtf8ByteLength(JSON.stringify(candidateBody));

  // Final exact byte check guarantees complete serialized payload stays within maxBodyBytes.
  while (selected.length > 0 && serializedBytes > maxBodyBytes) {
    selected.shift();
    candidateBody = buildWithHistory(selected);
    serializedBytes = getUtf8ByteLength(JSON.stringify(candidateBody));
  }

  return {
    ok: serializedBytes <= maxBodyBytes,
    exceedsLimit: serializedBytes > maxBodyBytes,
    maxBodyBytes,
    body: candidateBody,
    omittedCount: rawHistory.length - selected.length,
    serializedBytes,
  };
}

/**
 * Returns the browser's detected IANA timezone when available, or undefined.
 * @returns {string | undefined}
 */
export function getLocalTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetches server health status from GET /health.
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<HealthStatusResult>}
 */
export async function checkHealth(options = {}) {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchFn('/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        errorMessage: `Health check returned HTTP ${response.status}`,
      };
    }
    const data = /** @type {{ status?: string, service?: string, version?: string, timestamp?: string }} */ (
      await response.json()
    );
    return {
      ok: data?.status === 'ok',
      service: data?.service,
      version: data?.version,
      timestamp: data?.timestamp,
    };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Server unreachable',
    };
  }
}

/**
 * Sends a bounded, validated chat message to POST /api/chat.
 * Correctly distinguishes request/body cancellation, body read failures,
 * malformed JSON, 501 not-implemented responses, HTTP errors, and network failures.
 *
 * @param {ChatRequestPayload} payload
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, maxHistoryItems?: number, maxBodyBytes?: number }} [options]
 * @returns {Promise<ChatApiResult>}
 */
export async function sendChatRequest(payload, options = {}) {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  if (options.signal?.aborted) {
    return { kind: 'aborted' };
  }

  const bounded = buildBoundedChatBody(payload, {
    maxHistoryItems: options.maxHistoryItems,
    maxBodyBytes: options.maxBodyBytes,
  });

  if (bounded.exceedsLimit) {
    return {
      kind: 'http_error',
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: `Request payload (${bounded.serializedBytes.toLocaleString('en-US')} UTF-8 bytes) exceeds the ${bounded.maxBodyBytes.toLocaleString('en-US')}-byte limit. Shorten your message and try again.`,
      conversationId: payload.conversationId,
      omittedHistoryCount: bounded.omittedCount,
    };
  }

  const { body, omittedCount } = bounded;

  /** @type {Response} */
  let response;
  try {
    response = await fetchFn('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      return { kind: 'aborted' };
    }
    return {
      kind: 'network_error',
      code: 'NETWORK_ERROR',
      message: 'Couldn’t reach the server. Check your connection and try again.',
      omittedHistoryCount: omittedCount,
    };
  }

  const contentType = response.headers.get('content-type') || '';
  const headerRequestId = response.headers.get('x-request-id') || undefined;

  if (response.ok && contentType.includes('text/event-stream')) {
    return {
      kind: 'ok',
      status: response.status,
      contentType,
      requestId: headerRequestId,
      rawResponse: response,
      omittedHistoryCount: omittedCount,
    };
  }

  /** @type {string} */
  let rawText = '';
  try {
    rawText = await response.text();
  } catch (bodyError) {
    if (isAbortError(bodyError, options.signal)) {
      return { kind: 'aborted' };
    }
    return {
      kind: 'http_error',
      status: response.status,
      code: 'RESPONSE_READ_ERROR',
      message: 'Failed to read the server response body.',
      requestId: headerRequestId,
      conversationId: payload.conversationId,
      omittedHistoryCount: omittedCount,
    };
  }

  if (options.signal?.aborted) {
    return { kind: 'aborted' };
  }

  /** @type {any} */
  let parsed = null;
  let malformedJson = false;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
      malformedJson = true;
    }
  }

  if (malformedJson) {
    return {
      kind: 'http_error',
      status: response.status,
      code: 'MALFORMED_JSON',
      message: `Server returned an unreadable JSON payload (HTTP ${response.status}).`,
      requestId: headerRequestId,
      conversationId: payload.conversationId,
      omittedHistoryCount: omittedCount,
    };
  }

  if (response.status === 501) {
    const errorObj = parsed?.error;
    return {
      kind: 'not_implemented',
      status: 501,
      code: typeof errorObj?.code === 'string' ? errorObj.code : 'AGENT_NOT_IMPLEMENTED',
      message:
        typeof errorObj?.message === 'string'
          ? errorObj.message
          : 'Chat responses aren’t available yet. The interface is connected, but the agent is still being implemented.',
      requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : headerRequestId,
      conversationId:
        typeof parsed?.conversationId === 'string' ? parsed.conversationId : payload.conversationId,
      omittedHistoryCount: omittedCount,
    };
  }

  if (!response.ok) {
    const errorObj = parsed?.error;
    return {
      kind: 'http_error',
      status: response.status,
      code: typeof errorObj?.code === 'string' ? errorObj.code : `HTTP_${response.status}`,
      message:
        typeof errorObj?.message === 'string'
          ? errorObj.message
          : `Request failed with HTTP ${response.status}`,
      details: Array.isArray(errorObj?.details) ? errorObj.details : undefined,
      requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : headerRequestId,
      conversationId:
        typeof parsed?.conversationId === 'string' ? parsed.conversationId : payload.conversationId,
      omittedHistoryCount: omittedCount,
    };
  }

  return {
    kind: 'unsupported_response',
    status: response.status,
    code: 'UNSUPPORTED_RESPONSE_FORMAT',
    message: `Server returned HTTP ${response.status} without a supported chat response format for this build. No assistant reply was recorded.`,
    requestId: headerRequestId,
    conversationId: payload.conversationId,
    contentType,
    data: parsed,
    omittedHistoryCount: omittedCount,
  };
}
