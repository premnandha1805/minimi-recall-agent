import type { IncomingMessage, ServerResponse } from 'node:http';

export class ExecutionTimeoutError extends Error {
  constructor(message = 'Operation deadline exceeded') { super(message); this.name = 'ExecutionTimeoutError'; }
}

/** A disposable child deadline; parent disconnect/deadline always wins. */
export function createDeadlineScope(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal; dispose: () => void;
} {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 25_000) {
    throw new RangeError('Deadline must be between 0 and 25000 ms');
  }
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(new ExecutionTimeoutError()), timeoutMs);
  if (parent.aborted) forward();
  else if (timeoutMs === 0) controller.abort(new ExecutionTimeoutError());
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', forward); },
  };
}

/** Starts at request arrival and ends when the response finishes or the client leaves. */
export function createExecution(
  request: IncomingMessage,
  response: ServerResponse,
  deadlineMs: number,
  onDeadline: () => void
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  // Keep the original socket: Node can detach response.socket on completion.
  const socket = request.socket;
  let disposed = false;
  const timer = setTimeout(() => {
    if (disposed) return;
    // A close/finish notification may still be queued when this timer runs.
    if (socket.destroyed || request.aborted || response.destroyed || response.writableFinished) {
      close();
      return;
    }
    dispose();
    controller.abort(new ExecutionTimeoutError('Request deadline exceeded'));
    onDeadline();
  }, deadlineMs);
  timer.unref();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    socket.off('close', close);
    request.off('aborted', disconnect);
    response.off('close', close);
    response.off('finish', dispose);
  }
  function disconnect(): void {
    if (disposed) return;
    dispose();
    controller.abort(new Error('Client disconnected'));
  }
  function close(): void {
    if (!response.writableFinished) disconnect();
    else dispose();
  }
  request.once('aborted', disconnect);
  // IncomingMessage.close also occurs after a normally consumed body. Only
  // transport close (or premature response close) means a pending caller left.
  socket.once('close', close);
  response.once('close', close);
  response.once('finish', dispose);
  if (response.writableFinished) dispose();
  else if (request.aborted || socket.destroyed || response.destroyed) disconnect();
  return { signal: controller.signal, dispose };
}

/**
 * Bounds waiting and observes late failures. Work MUST pass the signal to I/O and
 * check it before side effects. Cancellation is cooperative: this cannot stop
 * synchronous CPU work or a provider that ignores AbortSignal.
 */
export async function runWithSignal<T>(signal: AbortSignal, work: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
