import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';
import { type AppConfig, loadConfig } from './config.js';
import { createExecution, runWithSignal, ExecutionTimeoutError } from './execution.js';
import { authoritativeHistory, installMemoryHttp } from './memory-http.js';
import { MemoryError } from './memory.js';
import { retrieveMemory, requestRecallIntent } from './context.js';
import { requestStage } from './request-log.js';
import type { StageObservation } from './observability.js';
import { runAgent } from './agent.js';
import { createModelProvider } from './model.js';
import type { ModelProvider } from './model.js';
import { modelFailureDiagnostic } from './model.js';
import { createStreamingModelProvider } from './streaming-model.js';
import { createTavilySearch, type WebSearch } from './search.js';
import { SseResponse, agentErrorCode } from './sse.js';
import {
  APP_NAME,
  APP_VERSION,
  type ApiErrorResponse,
  ChatRequestSchema,
  CHAT_STREAM_VERSION,
  ChatResultSchema,
  type HealthResponse,
  type ValidationErrorDetail,
} from './contracts.js';

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public');

interface StaticAssetEntry {
  file: string;
  contentType: string;
  cacheControl: string;
}

const STATIC_ASSETS: Record<string, StaticAssetEntry> = {
  '/': {
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-cache',
  },
  '/styles.css': {
    file: 'styles.css',
    contentType: 'text/css; charset=utf-8',
    cacheControl: 'no-cache',
  },
  '/api.js': {
    file: 'api.js',
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'no-cache',
  },
  '/app.js': {
    file: 'app.js',
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'no-cache',
  },
  '/manifest.webmanifest': {
    file: 'manifest.webmanifest',
    contentType: 'application/manifest+json; charset=utf-8',
    cacheControl: 'no-cache',
  },
  '/icons/favicon.png': {
    file: 'icons/favicon.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=3600',
  },
  '/icons/apple-touch-icon.png': {
    file: 'icons/apple-touch-icon.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=3600',
  },
};

export interface BuildServerOptions {
  config?: AppConfig;
  memoryDirectory?: string;
  logger?: boolean;
  logStream?: Writable;
  /** Injectable network boundary for offline integration tests; factories still validate config. */
  fetchImpl?: typeof fetch;
  /** Injectable provider for HTTP reliability tests; production uses the SDK stream adapter. */
  provider?: ModelProvider;
  search?: WebSearch;
  modelTimeoutMs?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    executionSignal: AbortSignal;
    executionStartedAt: number;
    sseResponse?: SseResponse;
  }
}

const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  '*.apiKey',
  '*.token',
  '*.secret',
  '*.GEMINI_API_KEY',
  '*.GROQ_API_KEY',
  '*.OPENROUTER_API_KEY',
  '*.OPENAI_API_KEY',
  '*.ANTHROPIC_API_KEY',
  '*.AZURE_OPENAI_API_KEY',
  '*.TAVILY_API_KEY',
];

const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'ZodError',
]);
const SAFE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'FST_ERR_REP_ALREADY_SENT',
]);

function serializeError(error: unknown) {
  let type = 'Error';
  let code: string | undefined;
  // Metadata is untrusted too. Only exact known literals may reach the log;
  // getters/proxies that throw must not break error handling.
  try {
    if (typeof error === 'object' && error !== null) {
      const name = 'name' in error ? error.name : undefined;
      if (typeof name === 'string' && SAFE_ERROR_NAMES.has(name)) type = name;
      const candidate = 'code' in error ? error.code : undefined;
      if (typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate)) code = candidate;
    }
  } catch {
    type = 'UninspectableError';
    code = undefined;
  }
  return { type, ...(code ? { code } : {}), message: 'Server operation failed', stack: '' };
}

function formatZodIssues(error: ZodError): ValidationErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : 'body',
    message: issue.message,
  }));
}

function buildErrorResponse(
  code: string,
  message: string,
  requestId: string,
  extra?: { details?: ValidationErrorDetail[]; conversationId?: string }
): ApiErrorResponse {
  const response: ApiErrorResponse = {
    error: {
      code,
      message,
      ...(extra?.details ? { details: extra.details } : {}),
    },
    requestId,
  };

  if (extra?.conversationId !== undefined) {
    response.conversationId = extra.conversationId;
  }

  return response;
}

/**
 * Creates and configures the Fastify server instance without binding a port.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();

  const loggerOption =
    options.logger === false
      ? false
      : {
          level: config.LOG_LEVEL,
          ...(options.logStream ? { stream: options.logStream } : {}),
          serializers: {
            req: (request: { method: string; url: string }) => ({
              method: request.method,
              path: request.url.split('?')[0].startsWith('/api/conversations') ? '/api/conversations' : request.url.split('?')[0],
            }),
            // Error messages/stacks/causes may contain provider URLs or input.
            err: serializeError,
          },
          redact: {
            paths: LOG_REDACT_PATHS,
            censor: '[REDACTED]',
          },
        };

  const app = Fastify({
    logger: loggerOption,
    bodyLimit: config.MAX_BODY_BYTES,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.decorateRequest('executionSignal');
  app.decorateRequest('executionStartedAt', 0);
  app.decorateRequest('sseResponse');
  app.addHook('onRequest', async (request, reply) => {
    request.executionStartedAt = performance.now();
    const execution = createExecution(request.raw, reply.raw, config.REQUEST_DEADLINE_MS, () => {
      if (request.sseResponse) { request.sseResponse.fail('REQUEST_TIMEOUT'); return; }
      if (!reply.sent && !reply.raw.destroyed && !request.raw.socket.destroyed) {
        reply.status(504).send(buildErrorResponse('REQUEST_TIMEOUT', 'Request deadline exceeded', request.id));
      }
    });
    request.executionSignal = execution.signal;
  });
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      try {
        return await runWithSignal(request.executionSignal, () => handler.call(this, request, reply));
      } catch (error) {
        if (request.executionSignal.aborted) {
          // Timeout already owns the response; a disconnected socket cannot receive one.
          if ((reply.raw.destroyed || request.raw.socket.destroyed) && !reply.sent) reply.hijack();
          return reply;
        }
        throw error;
      }
    };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  for (const [routePath, asset] of Object.entries(STATIC_ASSETS)) {
    const assetPath = resolve(PUBLIC_DIR, asset.file);
    app.get(routePath, async (_request, reply) => {
      const content = await readFile(assetPath);
      return reply
        .status(200)
        .header('Content-Type', asset.contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', asset.cacheControl)
        .send(content);
    });
  }

  app.get('/health', async (_request, reply): Promise<HealthResponse> => {
    return reply.status(200).send({
      status: 'ok',
      service: APP_NAME,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    });
  });

  const memoryDirectory = resolve(options.memoryDirectory ?? config.MEMORY_DIRECTORY);
  const defaultDirectory = resolve(import.meta.dirname, '..', '.data', 'conversations');
  const memory = installMemoryHttp(app, memoryDirectory, config.NODE_ENV !== 'production' || config.DEBUG_MEMORY === '1',
    !options.memoryDirectory && memoryDirectory === defaultDirectory);
  app.addHook('onReady', async () => { app.log.info({ event: 'memory_startup', reqId: 'startup', pid: process.pid,
    cwd: process.cwd(), absolutePath: memoryDirectory }, 'Memory storage ready'); });
  app.post('/api/chat', async (request, reply) => memory.track((async () => {
    const contentType = request.headers['content-type'];
    if (contentType && !contentType.toLowerCase().includes('application/json')) {
      return reply
        .status(415)
        .send(
          buildErrorResponse(
            'UNSUPPORTED_MEDIA_TYPE',
            'Content-Type must be application/json',
            request.id
          )
        );
    }

    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(
        buildErrorResponse('VALIDATION_ERROR', 'Invalid chat request payload', request.id, {
          details: formatZodIssues(parsed.error),
        })
      );
    }

    request.log.info(
      {
        requestId: request.id,
        hasConversationId: Boolean(parsed.data.conversationId),
        historyCount: parsed.data.history?.length ?? 0,
      },
      'Validated chat request'
    );

    request.executionSignal.throwIfAborted();
    let provider;
    let search;
    try {
      provider = options.provider ?? (options.fetchImpl ? createModelProvider(config, options.fetchImpl) : createStreamingModelProvider(config));
      search = options.search ?? createTavilySearch(config, options.fetchImpl);
    } catch {
      return reply.status(503).send(buildErrorResponse('CHAT_NOT_CONFIGURED',
        'Chat requires a supported Azure model configuration and Tavily credentials.', request.id,
        { conversationId: parsed.data.conversationId }));
    }
    const store = await memory.getStore();
    request.executionSignal.throwIfAborted();
    const conversation = await store.resolveClientConversation(parsed.data.conversationId ?? randomUUID(), parsed.data.timezone);
    const conversationId = parsed.data.conversationId ?? conversation.id;
    requestStage(request, conversation.id, 'request_received', request.executionStartedAt);
    if (memory.executing.has(conversation.id)) throw new MemoryError('CONFLICT');
    memory.executing.add(conversation.id);
    let turnId: string | undefined;
    let attemptId: string | undefined;
    let awaitingReceipt = false;
    let storageFailure: 'STORAGE' | 'TIMEOUT' = 'STORAGE';
    let agentObservation: StageObservation | undefined;
    const sent = (outcome: string) => {
      requestStage(request, conversation.id, 'response_sent', request.executionStartedAt, { outcome });
      if (agentObservation) {
        request.log.info({ requestId: request.id, conversationId: conversation.id, ...agentObservation }, 'Agent stage completed');
        agentObservation = undefined;
      }
      memory.executing.delete(conversation.id);
    };
    try {
      request.executionSignal.throwIfAborted();
      if (parsed.data.history) await store.seed(conversation.id, parsed.data.history);
      request.executionSignal.throwIfAborted();
      const turn = await store.addTurn(conversation.id, { key: parsed.data.turn?.key ?? randomUUID(),
        content: parsed.data.message, timezone: parsed.data.timezone ?? conversation.timezone ?? 'UTC' });
      turnId = turn.id;
      await store.flush();
      const persisted = await store.diagnostics();
      requestStage(request, conversation.id, 'user_message_persisted', request.executionStartedAt,
        { conversationCount: persisted.conversationCount, messageCount: persisted.messageCount, absolutePath: store.directory });
      const attempt = await store.startAttempt(conversation.id, turn.id, parsed.data.turn?.attemptKey ?? randomUUID());
      attemptId = attempt.id;
      request.executionSignal.throwIfAborted();
      reply.raw.setHeader('X-Conversation-Id', conversation.id);
      reply.raw.setHeader('X-Turn-Id', turn.id);
      reply.raw.setHeader('X-Attempt-Id', attempt.id);
      if (attempt.answer && ['awaiting_receipt', 'accepted', 'partial'].includes(attempt.status)) {
        awaitingReceipt = true;
        reply.hijack();
        try {
        const replay = new SseResponse(reply.raw, request.executionSignal, {
          version: CHAT_STREAM_VERSION, requestId: request.id, conversationId, answerMode: 'final' });
        request.sseResponse = replay;
        await replay.ready(); replay.complete(attempt.answer.result);
        } catch { reply.raw.destroy(); }
        return reply;
      }
      if (attempt.status !== 'running') throw new MemoryError('CONFLICT');
      reply.hijack();
      let stream: SseResponse | undefined;
      try {
        stream = new SseResponse(reply.raw, request.executionSignal, {
          version: CHAT_STREAM_VERSION, requestId: request.id, conversationId, answerMode: 'final',
        });
        request.sseResponse = stream;
        await stream.ready();
        const owner = stream;
        const { turn: _turn, ...agentInput } = parsed.data;
        const retrievalStarted = performance.now();
        const intent = requestRecallIntent(turn.user.content);
        requestStage(request, conversation.id, 'recall_intent', retrievalStarted,
          { detected: intent.recall, memoryOnly: intent.memoryOnly, why: intent.recall ? 'lexical recall cue' : 'no recognized recall cue' });
        const measuredSearch = async (query: string, input: Parameters<typeof search>[1]) => {
          const started = performance.now(); requestStage(request, conversation.id, 'web_search_start', started);
          try { await owner.progress('search_started'); input.signal.throwIfAborted(); return await search(query, input); }
          finally { requestStage(request, conversation.id, 'web_search_end', started); }
        };
        let retrievalDurationMs = 0;
        const historical = await retrieveMemory(store, { query: turn.user.content, activeConversationId: conversation.id, currentTurnId: turn.id,
          referenceInstant: turn.user.timestamp, timezone: turn.timezone ?? conversation.timezone ?? 'UTC',
          signal: request.executionSignal, startedAt: request.executionStartedAt, deadlineMs: config.REQUEST_DEADLINE_MS, alwaysRetrieve: true })
          .then((value) => { retrievalDurationMs = performance.now() - retrievalStarted; return value; });
        requestStage(request, conversation.id, 'retrieval', retrievalStarted, { conversationsScanned: historical.conversationsScanned,
          durationMs: Math.round(retrievalDurationMs * 100) / 100,
          messagesScanned: historical.messagesScanned, status: historical.status,
          hits: historical.records.slice(0, 8).map((r) => ({ score: r.score, conversationId: r.conversationId,
            preview: config.DEBUG_MEMORY === '1' ? r.user.content.slice(0, 80) : '[enable DEBUG_MEMORY=1 for local excerpts]' })) });
        const history = authoritativeHistory((await store.load(conversation.id))!, parsed.data.history ?? [], turn.ordinal);
        request.executionSignal.throwIfAborted();
        const result = await runAgent({ ...agentInput, history, message: turn.user.content }, {
          memory: historical,
          recoverRecall: !options.fetchImpl || !!options.provider,
          modelTimeoutMs: options.modelTimeoutMs ?? (!options.fetchImpl ? 15_000 : undefined),
          onText: async (text) => { await owner.delta(text); },
          provider: { contextWindowTokens: provider.contextWindowTokens, complete: async (input) => {
            const started = performance.now();
            const characters = input.messages.reduce((n, m) => n + m.content.length, 0);
            requestStage(request, conversation.id, 'context_built', started, { characters, tokenEstimate: Math.ceil(characters / 4) });
            requestStage(request, conversation.id, 'model_call_start', started);
            try {
              await owner.progress('model_started'); input.signal.throwIfAborted();
              const response = await provider.complete(input);
              requestStage(request, conversation.id, 'model_call_end', started, { errorCode: null, errorMessage: null });
              return response;
            } catch (error) {
              const diagnostic = modelFailureDiagnostic(error);
              requestStage(request, conversation.id, 'model_call_end', started, { errorCode: input.signal.aborted ? 'TIMEOUT_OR_ABORT' : diagnostic?.code ?? 'MODEL_FAILED',
                errorMessage: input.signal.aborted ? 'Model deadline or cancellation' : diagnostic?.httpStatus ? `Provider HTTP ${diagnostic.httpStatus}` : 'Provider operation failed',
                ...(diagnostic ? { diagnostic } : {}) });
              throw error;
            }
          } },
          search: measuredSearch,
          signal: request.executionSignal, startedAt: request.executionStartedAt,
          deadlineMs: config.REQUEST_DEADLINE_MS,
          observe: (event) => {
            if (event.stage === 'agent') agentObservation = event;
            else request.log.info({ requestId: request.id, conversationId: conversation.id, ...event }, 'Agent stage completed');
          },
        });
        if (result.reason === 'answer') {
          const answer = ChatResultSchema.parse({
            message: { id: randomUUID(), role: 'assistant', content: result.answer, timestamp: new Date().toISOString() },
            coverage: result.status === 'completed' ? 'complete' : 'partial', issues: result.issues,
            sources: result.sources.map(({ text: _text, ...metadata }) => metadata), evidenceCheck: 'citation_ids_only',
            ...(historical.recall && historical.records.length ? { memory: {
              earlierConversations: new Set(historical.records.filter((r) => r.conversationId !== conversation.id).map((r) => r.conversationId)).size,
              fallback: result.generationOrigin === 'recovered' } } : {}),
            ...(result.generationOrigin ? { generation: { origin: result.generationOrigin } } : {}),
          });
          request.executionSignal.throwIfAborted();
          const saved = await store.saveGenerated(conversation.id, turn.id, attempt.id, { result: answer, evidence: result.sources });
          request.executionSignal.throwIfAborted();
          await store.markAwaitingReceipt(conversation.id, turn.id, attempt.id);
          awaitingReceipt = true;
          request.executionSignal.throwIfAborted();
          sent('answer');
          stream.complete(saved.answer!.result);
        } else {
          await store.stopAttempt(conversation.id, turn.id, attempt.id,
            result.reason === 'cancelled' ? 'cancelled' : 'failed', result.reason === 'deadline' || result.reason === 'model_timeout' ? 'TIMEOUT' : 'MODEL_FAILED');
          sent(result.reason);
          stream.fail(agentErrorCode(result.reason));
        }
      } catch (error) {
        if (error instanceof ExecutionTimeoutError) storageFailure = 'TIMEOUT';
        if (stream) stream.fail(storageFailure === 'TIMEOUT' ? 'REQUEST_TIMEOUT' : 'INTERNAL_ERROR');
        else reply.raw.destroy();
      }
      return reply;
    } finally {
      try {
        if (turnId && attemptId && !awaitingReceipt) await store.stopAttempt(conversation.id, turnId, attemptId,
          request.executionSignal.aborted ? 'cancelled' : 'failed', request.executionSignal.aborted ? 'CANCELLED' : storageFailure);
      } catch { request.log.error({ requestId: request.id }, 'Conversation finalization failed'); }
      memory.executing.delete(conversation.id);
      if (agentObservation) request.log.info({ requestId: request.id, conversationId: conversation.id, ...agentObservation }, 'Agent stage completed');
    }
  })()));

  app.setNotFoundHandler(async (request, reply) => {
    return reply
      .status(404)
      .send(
        buildErrorResponse(
          'NOT_FOUND',
          'Route not found',
          request.id
        )
      );
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof MemoryError) {
      const status = error.code === 'INVALID_INPUT' ? 400 : error.code === 'NOT_FOUND' ? 404 :
        error.code === 'CONFLICT' ? 409 : error.code === 'LIMIT' ? 507 : 503;
      return reply.code(status).send(buildErrorResponse(`MEMORY_${error.code}`, 'Conversation storage operation could not be completed.', request.id));
    }
    if (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return reply
        .status(400)
        .send(
          buildErrorResponse(
            'MALFORMED_JSON',
            'Request body must be valid non-empty JSON',
            request.id
          )
        );
    }

    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
      return reply
        .status(413)
        .send(
          buildErrorResponse(
            'PAYLOAD_TOO_LARGE',
            `Request body exceeds maximum allowed size of ${config.MAX_BODY_BYTES} bytes`,
            request.id
          )
        );
    }

    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.statusCode === 415) {
      return reply
        .status(415)
        .send(
          buildErrorResponse(
            'UNSUPPORTED_MEDIA_TYPE',
            'Content-Type must be application/json',
            request.id
          )
        );
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'Unhandled server error');
      return reply
        .status(500)
        .send(buildErrorResponse('INTERNAL_ERROR', 'Internal server error', request.id));
    }

    return reply
      .status(statusCode)
      .send(buildErrorResponse(error.code || 'BAD_REQUEST', error.message, request.id));
  });

  return app;
}
