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
 * @property {{key: string, attemptKey: string}} [turn]
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
 * @property {'not_implemented' | 'http_error' | 'network_error' | 'aborted' | 'unsupported_response' | 'protocol_error' | 'stream_error' | 'ok'} kind
 * @property {number} [status]
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} [requestId]
 * @property {string} [conversationId]
 * @property {ValidationDetail[]} [details]
 * @property {string} [contentType]
 * @property {Response} [rawResponse]
 * @property {unknown} [data]
 * @property {import('../src/contracts.js').ChatResult} [result]
 * @property {number} [omittedHistoryCount]
 * @property {{conversationId: string, turnId: string, attemptId: string}} [receipt]
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
    ...(payload.turn ? { turn: payload.turn } : {}),
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
async function sendChatRequestInner(payload, options = {}) {
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

  if (options.signal?.aborted) {
    void response.body?.cancel().catch(() => {});
    return { kind: 'aborted' };
  }
  const contentType = response.headers.get('content-type') || '';
  const headerRequestId = response.headers.get('x-request-id') || undefined;

  if (response.status === 200 && contentType.split(';')[0].trim().toLowerCase() === 'text/event-stream') {
    try {
      const streamed = await readChatStream(response, options);
      if ((headerRequestId && headerRequestId !== streamed.meta.requestId) ||
          (payload.conversationId && payload.conversationId !== streamed.meta.conversationId)) throw new Error('Identity mismatch');
      return { ...(streamed.result ? { kind: /** @type {const} */ ('ok'), result: streamed.result } : {
        kind: /** @type {const} */ ('stream_error'), code: streamed.error?.code, message: streamed.error?.message,
      }), status: 200, requestId: streamed.meta.requestId, conversationId: streamed.meta.conversationId,
      contentType, omittedHistoryCount: omittedCount,
      receipt: receiptIdentity(response) };
    } catch {
      return options.signal?.aborted ? { kind: 'aborted' } : { kind: 'protocol_error',
        code: 'INVALID_STREAM', message: 'The response was incomplete or invalid. No assistant reply was recorded.',
        requestId: headerRequestId, omittedHistoryCount: omittedCount };
    }
  }

  /** @type {string} */
  let rawText = '';
  try {
    rawText = await withAbort(response.text(), options.signal);
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

/** @typedef {import('../src/contracts.js').ChatEventPayloads} ChatEvents */
/** @typedef {{signal?: AbortSignal, fetchImpl?: typeof fetch, maxHistoryItems?: number,
 * maxBodyBytes?: number, onProgress?: (progress: ChatEvents['progress']) => void,
 * onDelta?: (text: string) => void, onDraftReset?: () => void}} ChatOptions */

/** A transport watchdog includes fetch and body reading, without extending the server deadline.
 * @param {ChatRequestPayload} payload @param {ChatOptions} [options]
 * @returns {Promise<ChatApiResult>} */
export async function sendChatRequest(payload, options = {}) {
  const controller = new AbortController();
  const forward = () => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted) forward();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    return await withAbort(sendChatRequestInner(payload, { ...options, signal: controller.signal }), controller.signal);
  } catch {
    return timedOut ? { kind: 'network_error', code: 'STREAM_TIMEOUT',
      message: 'The response timed out. No assistant reply was recorded.' } : { kind: 'aborted' };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', forward); controller.abort();
  }
}

/** @template T @param {Promise<T>} work @param {AbortSignal} [signal] @returns {Promise<T>} */
async function withAbort(work, signal) {
  if (!signal) return work;
  /** @type {() => void} */ let abort = () => {};
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return /** @type {T} */ (await Promise.race([work, cancelled])); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Browser validators deliberately mirror src/contracts.ts; parity fixtures test both.
 * @param {any} v @param {string[]} required @param {string[]} [optional] */
function fields(v, required, optional = []) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
}
/** @param {any} v @param {number} max */
function textValue(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
/** @param {any} v */
function safeId(v) { return textValue(v, 128) && /^[a-zA-Z0-9_-]+$/.test(v); }
/** @param {any} value @param {boolean} [dateOnly] @param {boolean} [utcOnly] */
function isoDate(value, dateOnly = false, utcOnly = false) {
  if (typeof value !== 'string') return false;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!date) return false;
  const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (dateOnly && value.length === 10) return true;
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
    (!utcOnly || value.endsWith('Z'));
}
/** @param {any} value */
function safeUrl(value) {
  if (!textValue(value, 2048)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
const issues = ['search_budget_exhausted', 'search_cutoff', 'search_unavailable', 'search_timeout', 'search_failed', 'search_invalid_results'];
const errorCodes = ['REQUEST_TIMEOUT', 'MODEL_TIMEOUT', 'MODEL_FAILED', 'INVALID_MODEL_OUTPUT', 'INVALID_CITATION',
  'CONTEXT_LIMIT', 'AGENT_LIMIT', 'CANCELLED', 'INTERNAL_ERROR'];
/** @param {string} event @param {any} v */
export function validChatEvent(event, v) {
  switch (event) {
    case 'meta': return fields(v, ['version', 'requestId', 'conversationId', 'answerMode']) &&
      v.version === 'recall.chat.v1' && v.answerMode === 'final' && safeId(v.conversationId) &&
      typeof v.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.requestId);
    case 'progress': return fields(v, ['phase']) && v.phase === 'accepted' ||
      fields(v, ['phase', 'call']) && v.phase === 'model_started' && Number.isInteger(v.call) && v.call >= 1 && v.call <= 3 ||
      fields(v, ['phase', 'attempt']) && ['search_started', 'research_started'].includes(v.phase) && Number.isInteger(v.attempt) && v.attempt >= 1 && v.attempt <= 8;
    case 'error': return fields(v, ['code', 'message']) && errorCodes.includes(v.code) && textValue(v.message, 256);
    case 'delta': return fields(v, ['text']) && textValue(v.text, 16000);
    case 'done': return fields(v, ['outcome', 'messageId']) && ['completed', 'partial'].includes(v.outcome) && safeId(v.messageId) ||
      fields(v, ['outcome']) && ['failed', 'cancelled'].includes(v.outcome);
    case 'result': {
      if (!fields(v, ['message', 'coverage', 'issues', 'sources', 'evidenceCheck'], ['memory', 'generation']) ||
          !fields(v.message, ['id', 'role', 'content', 'timestamp']) || !safeId(v.message.id) || v.message.role !== 'assistant' ||
          !textValue(v.message.content, 16000) || !v.message.content.trim() || !isoDate(v.message.timestamp, false, true) ||
          !['complete', 'partial'].includes(v.coverage) || v.evidenceCheck !== 'citation_ids_only' ||
          !Array.isArray(v.issues) || v.issues.length > 6 || !v.issues.every((/** @type {any} */ i) => issues.includes(i)) ||
          new Set(v.issues).size !== v.issues.length || (v.coverage === 'complete') !== (v.issues.length === 0) ||
          !Array.isArray(v.sources) || v.sources.length > 24) return false;
      if ('memory' in v && (!fields(v.memory, ['earlierConversations', 'fallback']) ||
          !Number.isInteger(v.memory.earlierConversations) || v.memory.earlierConversations < 0 ||
          v.memory.earlierConversations > 1000 || typeof v.memory.fallback !== 'boolean')) return false;
      if ('generation' in v && (!fields(v.generation, ['origin']) ||
          !['model', 'recovered'].includes(v.generation.origin))) return false;
      const ids = new Set();
      for (const s of v.sources) {
        if (!fields(s, ['id', 'query', 'title', 'url', 'retrieved_at'], ['published_at', 'effective_at']) ||
            !textValue(s.id, 128) || !/^S[1-9]\d*$/.test(s.id) || ids.has(s.id) ||
            !textValue(s.query, 500) || !textValue(s.title, 500) || !safeUrl(s.url) || !isoDate(s.retrieved_at) ||
            ('published_at' in s && !isoDate(s.published_at, true)) || ('effective_at' in s && !isoDate(s.effective_at, true))) return false;
        ids.add(s.id);
      }
      // Same ordinary/bracket-escaped marker grammar as contracts.citationIds.
      return [...v.message.content.matchAll(/\\?\[(S\d+)\\?\]/g)].every((m) => ids.has(m[1]));
    }
    default: return false;
  }
}

/** Reads the narrow recall.chat.v1 SSE dialect. A result is returned only after clean EOF.
 * @param {Response} response @param {ChatOptions} [options]
 * @returns {Promise<{meta: ChatEvents['meta'], result?: ChatEvents['result'], error?: ChatEvents['error']}>} */
export async function readChatStream(response, options = {}) {
  if (!response.body) throw new Error('Missing stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, frameBytes = 0, previousFrameBytes = 0, line = '', event = '', data = '', hasData = false, afterCR = false;
  let accepted = false, done = false, eof = false, hasEvent = false, modelCalls = 0, searchAttempts = 0;
  /** @type {ChatEvents['meta'] | undefined} */ let meta;
  /** @type {ChatEvents['result'] | undefined} */ let result;
  /** @type {ChatEvents['error'] | undefined} */ let error;
  const invalid = () => { throw new Error('Invalid chat stream'); };
  const dispatch = () => {
    if (!hasEvent && !hasData) return;
    const value = JSON.parse(data);
    if (done || !validChatEvent(event, value)) invalid();
    if (!meta) { if (event !== 'meta') invalid(); meta = value; }
    else if (event === 'progress' && !result && !error) {
      if (value.phase === 'accepted') { if (accepted) invalid(); accepted = true; }
      else {
        if (!accepted) invalid();
        if (value.phase === 'model_started') {
          if (value.call !== ++modelCalls) invalid();
          if (modelCalls > 1) options.onDraftReset?.();
        }
        else { if (value.phase === 'search_started' && !modelCalls || value.attempt !== ++searchAttempts) invalid(); }
      }
      options.onProgress?.(value);
    } else if (event === 'delta' && accepted && modelCalls > 0 && !result && !error) {
      options.onDelta?.(value.text);
    } else if (event === 'result' && accepted && !result && !error) result = value;
    else if (event === 'error' && accepted && !result && !error) error = value;
    else if (event === 'done') {
      if (result) {
        if (value.messageId !== result.message.id || value.outcome !== (result.coverage === 'complete' ? 'completed' : 'partial')) invalid();
      } else if (!error || value.outcome !== (error.code === 'CANCELLED' ? 'cancelled' : 'failed')) invalid();
      done = true;
    } else invalid();
  };
  const consumeLine = () => {
    if (!line) { dispatch(); event = ''; data = ''; hasData = false; hasEvent = false; previousFrameBytes = frameBytes; frameBytes = 0; return; }
    if (done) invalid();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event' && !hasEvent) { event = value; hasEvent = true; }
    else if (field === 'data') { data += (hasData ? '\n' : '') + value; hasData = true; }
    else invalid();
  };
  /** @param {string} text */
  const consume = (text) => {
    for (const char of text) {
      if (afterCR && char === '\n') {
        if ((frameBytes ? ++frameBytes : previousFrameBytes + 1) > 1_048_576) invalid();
        afterCR = false; continue;
      }
      afterCR = false;
      const point = /** @type {number} */ (char.codePointAt(0));
      frameBytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (frameBytes > 1_048_576) invalid();
      if (char === '\r' || char === '\n') { consumeLine(); line = ''; afterCR = char === '\r'; }
      else line += char;
    }
  };
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), options.signal);
      if (options.signal?.aborted) invalid();
      if (chunk.done) { eof = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > 2_097_152) invalid();
      consume(decoder.decode(chunk.value, { stream: true }));
    }
    consume(decoder.decode());
    if (!done || !meta || line || hasEvent || hasData) invalid();
    return { meta: /** @type {ChatEvents['meta']} */ (meta), ...(result ? { result } : { error }) };
  } finally {
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** @param {string | null} value */
export function memoryId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
/** @param {Response} response */
function receiptIdentity(response) {
  const conversationId = response.headers.get('x-conversation-id');
  const turnId = response.headers.get('x-turn-id'); const attemptId = response.headers.get('x-attempt-id');
  return memoryId(conversationId) && memoryId(turnId) && memoryId(attemptId) ?
    { conversationId: /** @type {string} */ (conversationId), turnId: /** @type {string} */ (turnId), attemptId: /** @type {string} */ (attemptId) } : undefined;
}
export class MemoryApiError extends Error {
  /** @param {number} status */
  constructor(status) { super('Conversation storage is unavailable or returned invalid data.'); this.status = status; }
}
/** Bounded JSON transport; no provider calls. @param {string} path
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, method?: string, body?: object}} [options]
 * @returns {Promise<any>} */
export async function memoryRequest(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 10000);
  let reader;
  try {
    const response = await withAbort((options.fetchImpl ?? globalThis.fetch)(path, { method: options.method ?? 'GET',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: controller.signal,
      credentials: 'same-origin', cache: 'no-store', redirect: 'error' }), controller.signal);
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel(); throw new MemoryApiError(response.status);
    }
    reader = response.body?.getReader(); if (!reader) throw new MemoryApiError(0);
    const decoder = new TextDecoder('utf-8', { fatal: true }); let text = ''; let size = 0;
    while (true) {
      const chunk = await withAbort(reader.read(), controller.signal);
      if (chunk.done) break;
      size += chunk.value.byteLength; if (size > 5 * 1024 * 1024) throw new MemoryApiError(0);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode(); return JSON.parse(text);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
/** Validate the browser-consumed storage fields before DOM/history use.
 * @param {any} v @returns {v is import('./api.js').StoredConversation} */
export function validConversation(v) {
  const message = (/** @type {any} */ m) => m && memoryId(m.id) && ['user','assistant'].includes(m.role) &&
    typeof m.content === 'string' && m.content.trim() && m.content.length <= 32000 && isoDate(m.timestamp, false, true);
  if (!v || v.schemaVersion !== 'recall.memory.v1' || !memoryId(v.id) || !Array.isArray(v.turns) || v.turns.length > 500 ||
      !Array.isArray(v.seededMessages) || v.seededMessages.length > 1000 || !v.seededMessages.every(message)) return false;
  const ids = new Set([v.id]); const unique = (/** @type {string} */ id) => { if (ids.has(id)) return false; ids.add(id); return true; };
  if (!v.seededMessages.every((/** @type {any} */ m) => unique(m.id))) return false;
  return v.turns.every((/** @type {any} */ t, /** @type {number} */ i) => memoryId(t.id) && unique(t.id) && t.ordinal === i && message(t.user) && unique(t.user.id) && t.user.role === 'user' &&
    typeof t.key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(t.key) && Array.isArray(t.attempts) && t.attempts.length <= 8 &&
    t.attempts.every((/** @type {any} */ a) => memoryId(a.id) && unique(a.id) && typeof a.key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(a.key) &&
      ['running','generated','awaiting_receipt','accepted','partial','failed','cancelled','interrupted'].includes(a.status) &&
      (!a.answer || validChatEvent('result', a.answer.result) && memoryId(a.answer.result.message.id) && unique(a.answer.result.message.id)) &&
      (!['accepted','partial','generated','awaiting_receipt'].includes(a.status) || a.answer) &&
      (a.status !== 'accepted' || a.answer.result.coverage === 'complete') && (a.status !== 'partial' || a.answer.result.coverage === 'partial')));
}
