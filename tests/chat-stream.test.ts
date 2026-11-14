import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, wire, toolWire, json } from './fixtures/chat-stream.js';

const servers: FastifyInstance[] = [];
function server(fetchImpl: typeof fetch, env = {}) {
  const app = buildServer({ config: loadConfig({ ...azureEnv, ...env }), logger: false, fetchImpl });
  servers.push(app); return app;
}
const post = (app: FastifyInstance, payload: unknown = { message: 'hello' }) => app.inject({ method: 'POST', url: '/api/chat', payload: payload as object });
async function parse(app: FastifyInstance) {
  const reply = await post(app);
  expect(reply.statusCode).toBe(200);
  expect(reply.headers['content-type']).toContain('text/event-stream');
  expect(reply.headers['cache-control']).toBe('no-cache, no-transform');
  const parsed = await readChatStream(new Response(reply.body));
  expect(parsed.meta.requestId).toBe(reply.headers['x-request-id']);
  return { reply, ...parsed };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const app of servers.splice(0)) { app.server.closeAllConnections(); await app.close(); }
});
describe('HTTP → unchanged core → real adapters with mocked fetch', () => {
  it('answers without search and emits only factual model progress', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(wire()));
    const { result, reply } = await parse(server(fetchMock));
    expect(result).toMatchObject({ message: { content: 'Hello' }, sources: [], coverage: 'complete' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reply.body).not.toContain('search_started'); expect(reply.body.match(/event: done/g)).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(false);
  });
  it('adapts actual search fixtures to grounded sources and uses only web_search', async () => {
    let models = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('tavily')) return json({ results: [{ title: 'Fixture', url: 'https://example.com', content: 'Evidence' }] });
      const body = JSON.parse(String(init?.body));
      expect(body.tools?.map((t: { function: { name: string } }) => t.function.name)).toEqual(['web_search']);
      return json(++models === 1 ? toolWire() : wire('Evidence [S1]'));
    });
    const { result, reply } = await parse(server(fetchMock));
    expect(result?.sources).toMatchObject([{ id: 'S1', query: 'fixture', title: 'Fixture' }]);
    expect(result?.sources[0]).not.toHaveProperty('text'); expect(result?.sources[0]).not.toHaveProperty('published_at');
    expect(reply.body).toContain('search_started'); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each([401, 429, 432, 500])('discloses partial research for Tavily %i without leaking upstream text', async (status) => {
    let models = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => String(url).includes('tavily') ? json({ secret: 'PRIVATE' }, status) :
      json(++models === 1 ? toolWire() : wire('Research could not be completed.')));
    const { result, reply } = await parse(server(fetchMock));
    expect(result).toMatchObject({ coverage: 'partial', issues: ['search_failed'], sources: [] });
    expect(reply.body).not.toContain('PRIVATE');
  });
  it.each([400, 401, 429, 500])('sanitizes Azure %i as MODEL_FAILED with no retry', async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ error: 'PRIVATE upstream secret' }, status));
    const { error, reply } = await parse(server(fetchMock));
    expect(error?.code).toBe('MODEL_FAILED'); expect(reply.body).not.toContain('PRIVATE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['Claim [S9]', ''])('rejects unusable answer %j without a result event', async (content) => {
    const { error, reply } = await parse(server(async () => json(wire(content))));
    expect(error?.code).toBe(content ? 'INVALID_CITATION' : 'INVALID_MODEL_OUTPUT');
    expect(reply.body).not.toContain('event: result');
  });
  it.each([{ TAVILY_API_KEY: '' }, { TAVILY_API_KEY: 'your_tavily_api_key_here' },
    { MODEL_PROVIDER: 'gemini' }])('fails preflight with zero calls: %j', async (env) => {
    const fetchMock = vi.fn<typeof fetch>(); const reply = await post(server(fetchMock, env));
    expect(reply.statusCode).toBe(503); expect(reply.json().error.code).toBe('CHAT_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves JSON validation, size and media errors before SSE', async () => {
    const fetchMock = vi.fn<typeof fetch>(); const app = server(fetchMock, { MAX_BODY_BYTES: '1024' });
    expect((await post(app, {})).statusCode).toBe(400);
    expect((await post(app, { message: 'x'.repeat(2048) })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/chat', headers: { 'content-type': 'text/plain' }, payload: 'x' })).statusCode).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('bounds the overall deadline, aborts fetch and discards late completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void; const started = new Promise<void>((yes) => { entered = yes; });
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => { entered(); return new Promise((yes) => { resolve = yes; }); });
    const app = server(fetchMock, { REQUEST_DEADLINE_MS: '1000' });
    const pending = post(app).then((r) => r); await started;
    await vi.advanceTimersByTimeAsync(1000);
    const reply = await pending;
    expect((await readChatStream(new Response(reply.body))).error?.code).toBe('REQUEST_TIMEOUT');
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    resolve(json(wire('Late answer'))); await vi.advanceTimersByTimeAsync(0);
    expect(reply.body.match(/event: done/g)).toHaveLength(1); expect(reply.body).not.toContain('Late answer');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('inherits elapsed arrival time before handler execution', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(wire())); const app = server(fetchMock);
    app.addHook('preHandler', async (request) => { request.executionStartedAt -= 26000; });
    const { error } = await parse(app); expect(error?.code).toBe('REQUEST_TIMEOUT'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns HTTP 504 JSON when the deadline expires before SSE headers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let entered!: () => void; const started = new Promise<void>((yes) => { entered = yes; });
    const fetchMock = vi.fn<typeof fetch>(); const app = server(fetchMock, { REQUEST_DEADLINE_MS: '1000' });
    app.addHook('preHandler', async (request) => {
      entered(); await new Promise<void>((_, reject) => request.executionSignal.addEventListener('abort', () => reject(request.executionSignal.reason), { once: true }));
    });
    const pending = post(app).then((r) => r); await started; await vi.advanceTimersByTimeAsync(1000);
    const reply = await pending; expect(reply.statusCode).toBe(504);
    expect(reply.json().error.code).toBe('REQUEST_TIMEOUT'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports the model timeout without waiting for the overall deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void; const started = new Promise<void>((yes) => { entered = yes; });
    let rejectLate!: (e: Error) => void;
    const fetchMock = vi.fn<typeof fetch>(() => { entered(); return new Promise((_, no) => { rejectLate = no; }); });
    const app = server(fetchMock); const pending = post(app).then((r) => r); await started;
    await vi.advanceTimersByTimeAsync(10000);
    expect((await readChatStream(new Response((await pending).body))).error?.code).toBe('MODEL_TIMEOUT');
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    rejectLate(new Error('late')); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('synthesizes a partial answer after an actual adapter search timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void; const started = new Promise<void>((yes) => { entered = yes; });
    let rejectLate!: (e: Error) => void; let models = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (!String(url).includes('tavily')) return json(++models === 1 ? toolWire() : wire('Research timed out.'));
      entered(); return new Promise((_, no) => { rejectLate = no; });
    });
    const app = server(fetchMock); const pending = post(app).then((r) => r); await started;
    await vi.advanceTimersByTimeAsync(4000);
    const result = (await readChatStream(new Response((await pending).body))).result;
    expect(result).toMatchObject({ coverage: 'partial', issues: ['search_timeout'] });
    rejectLate(new Error('late')); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('streams immediately and cancels on an actual socket disconnect after POST body completion', async () => {
    let started!: (s: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((yes) => { started = yes; });
    let rejectLate!: (e: Error) => void;
    const app = server((_url, init) => { started(init!.signal!); return new Promise((_, no) => { rejectLate = no; }); });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    let client: ReturnType<typeof httpRequest>;
    const firstData = new Promise<string>((resolve, reject) => {
      client = httpRequest(address + '/api/chat', { method: 'POST', agent: false,
        headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', (chunk) => resolve(String(chunk))); res.on('error', () => {});
      });
      client.on('error', reject); client.end(JSON.stringify({ message: 'hello' }));
    });
    try {
      expect(await firstData).toContain('event: meta');
      const signal = await entered; expect(signal.aborted).toBe(false);
      const cancelled = new Promise<void>((yes) => signal.addEventListener('abort', () => yes(), { once: true }));
      client!.destroy(); await cancelled;
      expect(signal.aborted).toBe(true); rejectLate(new Error('PRIVATE late failure'));
      await new Promise((yes) => setImmediate(yes));
    } finally { client!.destroy(); }
  });
});
