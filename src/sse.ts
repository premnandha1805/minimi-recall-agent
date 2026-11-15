import type { ServerResponse } from 'node:http';
import { ChatEventSchemas, MAX_SSE_FRAME_BYTES, MAX_SSE_STREAM_BYTES,
  type ChatEventPayloads, type ChatResult, type StreamErrorCode } from './contracts.js';
import { ExecutionTimeoutError } from './execution.js';
import type { AgentStopReason } from './agent.js';

export const STREAM_ERROR_MESSAGES: Record<StreamErrorCode, string> = {
  REQUEST_TIMEOUT: 'Request deadline exceeded. No answer was accepted.',
  MODEL_TIMEOUT: 'The model request timed out. No answer was accepted.',
  MODEL_FAILED: 'The model request failed. No answer was accepted.',
  INVALID_MODEL_OUTPUT: 'The model returned an unusable answer. No answer was accepted.',
  INVALID_CITATION: 'The answer referenced an unknown source. No answer was accepted.',
  CONTEXT_LIMIT: 'The supplied conversation exceeds the model context limit.',
  AGENT_LIMIT: 'The agent reached an execution limit. No answer was accepted.',
  CANCELLED: 'The request was cancelled. No answer was accepted.',
  INTERNAL_ERROR: 'The request could not be completed. No answer was accepted.',
};
export function agentErrorCode(reason: AgentStopReason): StreamErrorCode {
  switch (reason) {
    case 'deadline': return 'REQUEST_TIMEOUT';
    case 'model_timeout': return 'MODEL_TIMEOUT';
    case 'provider_error': return 'MODEL_FAILED';
    case 'invalid_citation': return 'INVALID_CITATION';
    case 'context_limit': return 'CONTEXT_LIMIT';
    case 'cancelled': return 'CANCELLED';
    case 'round_limit': case 'output_budget': return 'AGENT_LIMIT';
    case 'invalid_request': case 'answer': return 'INTERNAL_ERROR';
    default: return 'INVALID_MODEL_OUTPUT';
  }
}
export function encodeEvent<K extends keyof ChatEventPayloads>(event: K, payload: ChatEventPayloads[K]): string {
  const data = ChatEventSchemas[event].parse(payload);
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (Buffer.byteLength(frame) > MAX_SSE_FRAME_BYTES) throw new Error('SSE frame limit');
  return frame;
}

/** Sole raw-response owner after hijack. All terminal writes are synchronous and atomic
 * with respect to JS callbacks; delivery to a disconnected peer is never guaranteed. */
export class SseResponse {
  private terminal = false;
  private bytes = 0;
  private modelCalls = 0;
  private searches = 0;
  private readonly socket;
  constructor(private readonly response: ServerResponse, private readonly signal: AbortSignal,
    meta: ChatEventPayloads['meta']) {
    this.socket = response.socket;
    response.on('error', this.onError);
    response.once('close', this.cleanup);
    response.once('finish', this.cleanup);
    signal.addEventListener('abort', this.onAbort, { once: true });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': meta.requestId });
    this.write(encodeEvent('meta', meta) + encodeEvent('progress', { phase: 'accepted' }));
    if (signal.aborted) this.onAbort();
  }
  private writable(): boolean {
    return !this.response.destroyed && !this.socket?.destroyed && !this.response.writableEnded;
  }
  private cleanup = (): void => {
    this.signal.removeEventListener('abort', this.onAbort);
    this.response.off('finish', this.cleanup);
    // Retain the error handler until close: errors can follow end()/finish.
    if (this.response.destroyed) {
      this.response.off('close', this.cleanup);
      this.response.off('error', this.onError);
    }
  };
  private onError = (): void => { this.terminal = true; this.response.destroy(); };
  private onAbort = (): void => {
    if (this.signal.reason instanceof ExecutionTimeoutError) {
      if (this.terminal || this.response.writableNeedDrain) this.response.destroy();
      else {
        this.fail('REQUEST_TIMEOUT');
        // The arrival timer has expired and will not run again. Give the small
        // terminal frames one I/O turn, never leave an unfinished socket open.
        setImmediate(() => { if (!this.response.writableFinished) this.response.destroy(); });
      }
    } else { this.terminal = true; this.response.destroy(); }
  };
  private write(frame: string): void {
    if (!this.writable()) throw new Error('SSE closed');
    this.bytes += Buffer.byteLength(frame);
    if (this.bytes > MAX_SSE_STREAM_BYTES) throw new Error('SSE stream limit');
    this.response.write(frame);
  }
  /** No detached drain promises: callers await this and abort removes every listener. */
  async ready(): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.writable() || this.terminal) throw new Error('SSE closed');
    if (!this.response.writableNeedDrain) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        this.response.off('drain', drained); this.response.off('close', closed);
        this.response.off('error', closed); this.signal.removeEventListener('abort', closed);
      };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('SSE closed')); };
      this.response.once('drain', drained); this.response.once('close', closed);
      this.response.once('error', closed); this.signal.addEventListener('abort', closed, { once: true });
      if (this.signal.aborted || !this.writable()) closed();
    });
  }
  async progress(phase: 'model_started' | 'search_started'): Promise<void> {
    this.signal.throwIfAborted();
    if (this.terminal) throw new Error('SSE closed');
    const payload = phase === 'model_started' ? { phase, call: ++this.modelCalls } : { phase, attempt: ++this.searches };
    this.write(encodeEvent('progress', payload));
    await this.ready();
  }
  complete(result: ChatResult): void {
    if (this.terminal || !this.writable()) return;
    this.signal.throwIfAborted();
    // Validate BOTH frames before exposing any result bytes.
    const frame = encodeEvent('result', result) + encodeEvent('done', {
      outcome: result.coverage === 'complete' ? 'completed' : 'partial', messageId: result.message.id,
    });
    this.end(frame);
  }
  fail(code: StreamErrorCode): void {
    if (this.terminal || !this.writable()) return;
    this.end(encodeEvent('error', { code, message: STREAM_ERROR_MESSAGES[code] }) +
      encodeEvent('done', { outcome: code === 'CANCELLED' ? 'cancelled' : 'failed' }));
  }
  private end(frame: string): void {
    if (this.bytes + Buffer.byteLength(frame) > MAX_SSE_STREAM_BYTES) { this.onError(); return; }
    this.terminal = true;
    try { this.response.end(frame); } catch { this.onError(); }
  }
}
