import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';
import { type AppConfig, loadConfig } from './config.js';
import { createExecution, runWithSignal } from './execution.js';
import {
  APP_NAME,
  APP_VERSION,
  type ApiErrorResponse,
  ChatRequestSchema,
  type HealthResponse,
  type ValidationErrorDetail,
} from './contracts.js';

export interface BuildServerOptions {
  config?: AppConfig;
  logger?: boolean;
  logStream?: Writable;
}

declare module 'fastify' {
  interface FastifyRequest {
    executionSignal: AbortSignal;
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
              path: request.url.split('?')[0],
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
  app.addHook('onRequest', async (request, reply) => {
    const execution = createExecution(request.raw, reply.raw, config.REQUEST_DEADLINE_MS, () => {
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

  app.get('/health', async (_request, reply): Promise<HealthResponse> => {
    return reply.status(200).send({
      status: 'ok',
      service: APP_NAME,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/chat', async (request, reply) => {
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
      'Validated chat request received while agent runtime is not yet implemented'
    );

    return reply.status(501).send(
      buildErrorResponse(
        'AGENT_NOT_IMPLEMENTED',
        'Chat agent execution is not implemented yet. Only the HTTP server and request validation foundation are active.',
        request.id,
        { conversationId: parsed.data.conversationId }
      )
    );
  });

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
