import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { Agent, IncomingMessage, ServerResponse, request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { ChatHistoryMessageSchema } from '../src/contracts.js';
import { createExecution, runWithSignal } from '../src/execution.js';
import { buildServer } from '../src/server.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Socket lifecycle did not settle within 1500ms')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(() => vi.useRealTimers());

describe('request execution lifecycle', () => {
  function lifecycle() {
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    const deadline = vi.fn();
    const execution = createExecution(request, response, 1000, deadline);
    return { request, response, deadline, ...execution };
  }

  it('aborts at the exact deadline and removes timers and listeners', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scope = lifecycle();
    const cancelled = vi.fn();
    scope.signal.addEventListener('abort', cancelled, { once: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scope.signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(scope.deadline).toHaveBeenCalledTimes(1);
    expect(scope.request.listenerCount('aborted')).toBe(0);
    expect(scope.response.listenerCount('close')).toBe(0);
    expect(scope.response.listenerCount('finish')).toBe(0);
    expect(scope.request.socket.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('normal finish cleans up without cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scope = lifecycle();
    expect(await runWithSignal(scope.signal, async () => 'done')).toBe('done');
    scope.response.emit('finish');
    scope.response.emit('close');
    scope.request.socket.emit('close');
    await vi.advanceTimersByTimeAsync(2000);
    expect(scope.signal.aborted).toBe(false);
    expect(scope.deadline).not.toHaveBeenCalled();
    expect(getEventListeners(scope.signal, 'abort')).toHaveLength(0);
    expect(scope.request.listenerCount('aborted')).toBe(0);
    expect(scope.response.listenerCount('close')).toBe(0);
    expect(scope.request.socket.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['aborted', 'close', 'socket close'])('cancels on premature %s and removes the deadline', (event) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scope = lifecycle();
    if (event === 'aborted') scope.request.emit(event);
    else if (event === 'socket close') scope.request.socket.emit('close');
    else scope.response.emit(event);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.deadline).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(scope.request.listenerCount('aborted')).toBe(0);
    expect(scope.response.listenerCount('finish')).toBe(0);
    expect(scope.request.socket.listenerCount('close')).toBe(0);
  });

  it('ignores body completion and resolves disconnect/deadline races only once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scope = lifecycle();
    const cancelled = vi.fn();
    scope.signal.addEventListener('abort', cancelled);
    scope.request.emit('close');
    expect(scope.signal.aborted).toBe(false);
    scope.request.socket.emit('close');
    scope.response.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(scope.deadline).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detects a socket already closed before listener registration', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new Socket();
    socket.destroy();
    const request = new IncomingMessage(socket);
    const response = new ServerResponse(request);
    const deadline = vi.fn();
    const scope = createExecution(request, response, 1000, deadline);
    expect(scope.signal.aborted).toBe(true);
    expect(socket.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(deadline).not.toHaveBeenCalled();
  });

  it('does not send a timeout if socket destruction precedes its close notification', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scope = lifecycle();
    // Delay the event notification, while exposing the real destroyed state.
    Object.defineProperty(scope.request.socket, 'destroyed', { value: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(scope.signal.reason.message).toBe('Client disconnected');
    expect(scope.deadline).not.toHaveBeenCalled();
    expect(scope.request.socket.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes a late rejection after cancellation and detaches its abort listener', async () => {
    const controller = new AbortController();
    const work = deferred<string>();
    const result = runWithSignal(controller.signal, () => work.promise);
    await Promise.resolve();
    const rejected = expect(result).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    work.reject(new Error('late failure'));
    await Promise.resolve();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cleans up the execution listener on synchronous and asynchronous failures', async () => {
    const controller = new AbortController();
    for (const work of [() => { throw new Error('failure'); }, async () => { throw new Error('failure'); }]) {
      await expect(runWithSignal(controller.signal, work)).rejects.toThrow('failure');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    controller.abort();
    const work = vi.fn();
    await expect(runWithSignal(controller.signal, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });
});

describe('HTTP safeguards', () => {
  it('enforces the configured deadline on asynchronous routes and cancels work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const app = buildServer({ config: loadConfig({ REQUEST_DEADLINE_MS: '1000' }), logger: false });
    const entered = deferred<AbortSignal>();
    const cancelled = vi.fn();
    app.get('/slow', async (request) => {
      entered.resolve(request.executionSignal);
      return new Promise((_resolve, reject) => {
        request.executionSignal.addEventListener('abort', () => {
          cancelled();
          reject(request.executionSignal.reason);
        }, { once: true });
      });
    });
    try {
      await app.ready();
      const response = app.inject('/slow').then((value) => value);
      const signal = await entered.promise;
      await vi.advanceTimersByTimeAsync(999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await response;
      expect(result.statusCode).toBe(504);
      expect(result.json()).toEqual({ error: { code: 'REQUEST_TIMEOUT', message: 'Request deadline exceeded' }, requestId: result.headers['x-request-id'] });
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await app.close(); }
  });

  it('propagates a real socket disconnect after the request body has completed', async () => {
    const app = buildServer({ config: loadConfig({}), logger: false });
    const entered = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const closed = deferred<void>();
    const events: string[] = [];
    const sent = vi.fn();
    app.addHook('onSend', async (_request, _reply, payload) => { sent(); return payload; });
    app.addHook('onRequest', async (request, reply) => {
      request.raw.once('close', () => events.push('request close'));
      request.raw.once('aborted', () => events.push('request aborted'));
      reply.raw.once('finish', () => events.push('response finish'));
      reply.raw.once('close', () => events.push('response close'));
      request.raw.socket.once('close', () => { events.push('socket close'); closed.resolve(); });
    });
    app.post('/waiting', async (request) => {
      expect(request.body).toEqual({ message: 'body completed' });
      expect(request.raw.complete).toBe(true);
      return new Promise((_resolve, reject) => {
        request.executionSignal.addEventListener('abort', () => {
          events.push('signal abort');
          aborted.resolve();
          reject(request.executionSignal.reason);
        }, { once: true });
        entered.resolve(request.executionSignal);
      });
    });
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      client = httpRequest(address + '/waiting', { method: 'POST', agent: false, headers: { 'content-type': 'application/json' } });
      client.on('error', () => {}); // Expected ECONNRESET from our deliberate disconnect.
      client.end(JSON.stringify({ message: 'body completed' }));
      const signal = await bounded(entered.promise);
      expect(signal.aborted).toBe(false);
      expect(client.socket).not.toBeNull();
      client.socket!.destroy(); // Close the actual transport, not a synthetic event.
      await bounded(Promise.all([closed.promise, aborted.promise]));
      expect(signal.reason.message).toBe('Client disconnected');
      expect(events).toContain('request close');
      expect(events).not.toContain('request aborted');
      expect(events).not.toContain('response finish');
      expect(sent).not.toHaveBeenCalled();
    } finally {
      client?.destroy();
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it('does not abort successful requests when a keep-alive socket is reused or closed', async () => {
    const app = buildServer({ logger: false });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const signals: AbortSignal[] = [];
    const sockets: Socket[] = [];
    app.addHook('onRequest', async (request) => {
      signals.push(request.executionSignal);
      sockets.push(request.raw.socket);
    });
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      for (let index = 0; index < 2; index++) {
        await bounded(new Promise<void>((resolve, reject) => {
          const client = httpRequest(address + '/health', { agent }, (response) => {
            expect(response.statusCode).toBe(200);
            response.resume();
            response.on('end', resolve);
            response.on('error', reject);
          });
          client.on('error', reject);
          client.end();
        }));
      }
      expect(sockets[0]).toBe(sockets[1]);
      const closed = new Promise<void>((resolve) => sockets[0]!.once('close', resolve));
      agent.destroy();
      await bounded(closed);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
    } finally { agent.destroy(); app.server.closeAllConnections(); await app.close(); }
  });

  it('discards late results from work that ignores cancellation without sending twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const app = buildServer({ config: loadConfig({ REQUEST_DEADLINE_MS: '1000' }), logger: false });
    const entered = deferred<void>();
    const work = deferred<{ late: boolean }>();
    const sent = vi.fn();
    app.addHook('onSend', async (_request, _reply, payload) => { sent(); return payload; });
    app.get('/late', async () => { entered.resolve(); return work.promise; });
    try {
      await app.ready();
      const pending = app.inject('/late').then((result) => result);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending).statusCode).toBe(504);
      work.resolve({ late: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await app.close(); }
  });

  it('keeps successful, validation, and internal-error completions free of deadline timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const app = buildServer({ logger: false });
    const signals: AbortSignal[] = [];
    app.addHook('preHandler', async (request) => { signals.push(request.executionSignal); });
    app.get('/boom', async () => { throw new Error('failure'); });
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/chat', payload: {} })).statusCode).toBe(400);
      expect((await app.inject('/boom')).statusCode).toBe(500);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(25000);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(signals.every((signal) => getEventListeners(signal, 'abort').length === 0)).toBe(true);
    } finally { await app.close(); }
  });

  it('omits arbitrary query secrets from automatic and error logs', async () => {
    const records: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { records.push(String(chunk)); callback(); } });
    const app = buildServer({ config: loadConfig({ LOG_LEVEL: 'info' }), logStream: stream });
    const secret = 'REVIEW_SENTINEL_NOT_A_REAL_KEY';
    app.get('/boom', async (request) => { throw new Error(request.url); });
    app.get('/typed', async (request) => { throw new TypeError(request.url); });
    app.get('/network', async (request) => { throw Object.assign(new Error(request.url), { code: 'ECONNRESET' }); });
    app.get('/untrusted', async (request) => { throw Object.assign(new Error(request.url), { name: secret, code: secret }); });
    app.get('/metadata', async (request) => {
      const error = Object.defineProperty({}, 'name', { get() { throw new Error(secret); } });
      request.log.error({ err: error }, 'Uninspectable metadata probe');
      return { ok: true };
    });
    try {
      for (const path of ['/health', '/missing', '/boom', '/typed', '/network', '/untrusted', '/metadata']) {
        const response = await app.inject(path + '?arbitrary=' + secret);
        expect(response.body).not.toContain(secret);
        if (path === '/missing') {
          expect(response.statusCode).toBe(404);
          expect(response.json().error).toEqual({ code: 'NOT_FOUND', message: 'Route not found' });
        }
        if (['/boom', '/typed', '/network', '/untrusted'].includes(path)) {
          expect(response.statusCode).toBe(500);
          expect(response.json().error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
        }
      }
      const output = records.join('');
      expect(output).not.toContain(secret);
      const logs = records.flatMap((record) => record.trim().split('\n').map((line: string) => JSON.parse(line)));
      expect(logs.some((record) => record.msg === 'incoming request')).toBe(true);
      expect(logs.some((record) => record.msg === 'Unhandled server error')).toBe(true);
      expect(logs.every((record) => typeof record.reqId === 'string')).toBe(true);
      const errors = logs.filter((record) => record.msg === 'Unhandled server error').map((record) => record.err);
      expect(errors.map((error) => error.type)).toEqual(['Error', 'TypeError', 'Error', 'Error']);
      expect(errors[2].code).toBe('ECONNRESET');
      expect(errors[3].code).toBeUndefined();
      expect(errors.every((error) => error.stack === '' && error.message === 'Server operation failed')).toBe(true);
      expect(logs.find((record) => record.msg === 'Uninspectable metadata probe').err.type).toBe('UninspectableError');
    } finally { await app.close(); }
  });

  it('always generates unique server IDs, ignoring missing, malicious, duplicate and long client IDs', async () => {
    const app = buildServer({ logger: false });
    const ids = new Set<string>();
    try {
      for (const supplied of [undefined, '<script>bad</script>', ['a', 'b'], 'x'.repeat(8000), 'reused', 'reused']) {
        const result = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'ok' }, headers: supplied === undefined ? {} : { 'x-request-id': supplied } });
        expect(result.statusCode).toBe(503);
        const id: string = result.json().requestId;
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(result.headers['x-request-id']).toBe(id);
        ids.add(id);
      }
      expect(ids.size).toBe(6);
    } finally { await app.close(); }
  });
});

it('preserves original history text and rejects blank content', () => {
  const message = { role: 'user', content: '  original\n', timestamp: '2026-11-12T00:00:00Z' };
  expect(ChatHistoryMessageSchema.parse(message).content).toBe(message.content);
  expect(ChatHistoryMessageSchema.safeParse({ ...message, content: ' \t\r\n' }).success).toBe(false);
});

it('rejects deadlines exceeding 25 seconds and invalid numeric limits', () => {
  for (const value of ['25001', '120000', '0', '-1', 'NaN', '1000.5']) {
    expect(() => loadConfig({ REQUEST_DEADLINE_MS: value })).toThrow(/REQUEST_DEADLINE_MS/);
  }
  expect(loadConfig({ REQUEST_DEADLINE_MS: '25000' }).REQUEST_DEADLINE_MS).toBe(25000);
});
