import type { FastifyRequest } from 'fastify';

/** Operational metadata only; callers must never supply conversation text or provider bodies. */
export function requestStage(request: FastifyRequest, conversationId: string, stage: string,
  startedAt: number, details: Record<string, unknown> = {}): void {
  request.log.info({ requestId: request.id, conversationId, stage,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100, ...details }, stage);
}
