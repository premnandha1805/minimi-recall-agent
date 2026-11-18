import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createModelProvider, MAX_MODEL_RESPONSE_BYTES, type ModelRequest } from '../src/model.js';
import { WEB_SEARCH_TOOL } from '../src/search.js';
import { buildServer } from '../src/server.js';

// Offline HTTP fixtures; no requests to Azure are made by these tests.
const azureEnv = {
  MODEL_PROVIDER: 'azure-openai-v1', AZURE_OPENAI_CHAT_ENDPOINT: 'https://test.openai.azure.com/openai/v1/chat/completions',
  AZURE_OPENAI_DEPLOYMENT: 'test-deployment', AZURE_OPENAI_API_KEY: 'test-secret-never-log', AZURE_OPENAI_CONTEXT_TOKENS: '32768',
};
const request = (): ModelRequest => ({ messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }],
  tools: [WEB_SEARCH_TOOL], maxOutputTokens: 100, signal: new AbortController().signal });
const wire = (content: string | null = 'Hello') => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Azure OpenAI v1 adapter (mock HTTP only)', () => {
  it.each([0, 1, undefined, -1, 'PRIVATE', null])('accepts only valid optional reasoning usage: %j', async (reasoning) => {
    const payload = wire();
    const provider = createModelProvider(loadConfig(azureEnv), async () => json({ ...payload,
      usage: { ...payload.usage, completion_tokens_details: { reasoning_tokens: reasoning } },
    }));
    const result = await provider.complete(request());
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2,
      ...(reasoning === 0 || reasoning === 1 ? { reasoningTokens: reasoning } : {}),
    });
  });

  it('maps configured endpoint, deployment, auth, output budget and the only tool without guessing API versions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(wire()));
    const provider = createModelProvider(loadConfig(azureEnv), fetchMock);
    const input = request(); const result = await provider.complete(input);
    expect(result).toEqual({ text: 'Hello', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(azureEnv.AZURE_OPENAI_CHAT_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: input.signal,
      headers: { 'api-key': azureEnv.AZURE_OPENAI_API_KEY, 'content-type': 'application/json' } });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'test-deployment', stream: false, max_completion_tokens: 100, tool_choice: 'auto' });
    expect(body.tools).toEqual([{ type: 'function', function: WEB_SEARCH_TOOL }]);
    expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('api-version');
  });

  it('maps assistant calls and tool results with matching IDs and disables tools for synthesis', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["x"]}' } }],
    } }] }));
    const provider = createModelProvider(loadConfig(azureEnv), fetchMock);
    const result = await provider.complete(request());
    expect(result).toEqual({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{"queries":["x"]}' }] });
    await provider.complete({ ...request(), tools: [], messages: [
      { role: 'assistant', content: '', toolCalls: result.toolCalls },
      { role: 'tool', toolCallId: 'c1', content: '{"status":"unavailable"}' },
    ] });
    const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(sent.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["x"]}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"unavailable"}' },
    ]);
    expect(sent.tool_choice).toBeUndefined(); expect(sent.tools).toBeUndefined();
  });

  it.each([401, 429, 500])('rejects HTTP %i without exposing provider bodies or retrying', async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ error: 'SECRET provider details' }, status));
    const provider = createModelProvider(loadConfig(azureEnv), fetchMock);
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'HTTP_ERROR', message: 'Model provider: HTTP_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { choices: [] }, { choices: [wire().choices[0], wire().choices[0]] },
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ type: 'function' }] } }] },
    { ...wire(), usage: { prompt_tokens: -1, completion_tokens: 2 } },
  ])('rejects invalid upstream response %j', async (payload) => {
    const provider = createModelProvider(loadConfig(azureEnv), async () => json(payload));
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('preserves empty output for the core to classify instead of fabricating an answer', async () => {
    const provider = createModelProvider(loadConfig(azureEnv), async () => json(wire(null)));
    expect((await provider.complete(request())).text).toBe('');
  });

  it('marks explicit refusal as filtered', async () => {
    const data = wire(null);
    const provider = createModelProvider(loadConfig(azureEnv), async () => json({ ...data,
      choices: [{ ...data.choices[0], message: { ...data.choices[0].message, refusal: 'Cannot comply' } }] }));
    expect((await provider.complete(request())).finishReason).toBe('content_filter');
  });

  it('rejects non-JSON content types and malformed JSON', async () => {
    for (const response of [new Response('SSE', { headers: { 'content-type': 'text/event-stream' } }),
      new Response('{', { headers: { 'content-type': 'application/json' } })]) {
      const provider = createModelProvider(loadConfig(azureEnv), async () => response);
      await expect(provider.complete(request())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('caps the actual streamed response bytes rather than trusting Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_MODEL_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    const provider = createModelProvider(loadConfig(azureEnv), async () => new Response(stream,
      { headers: { 'content-type': 'application/json', 'content-length': '2' } }));
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('aborts a stuck body reader and observes body-cancel rejection', async () => {
    const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return Promise.reject(new Error('cancel failure')); } });
    const provider = createModelProvider(loadConfig(azureEnv), async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const run = provider.complete({ ...request(), signal: controller.signal });
    const assertion = expect(run).rejects.toThrow('cancelled by test');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    controller.abort(new Error('cancelled by test'));
    await assertion;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('makes no request on pre-abort, excessive context or invalid output limits', async () => {
    const fetchMock = vi.fn<typeof fetch>(); const provider = createModelProvider(loadConfig(azureEnv), fetchMock);
    const controller = new AbortController(); controller.abort(new Error('Already cancelled'));
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toThrow('Already cancelled');
    await expect(provider.complete({ ...request(), maxOutputTokens: 2049 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.complete({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(65536) }] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails explicitly for reserved but unimplemented provider choices', () => {
    expect(() => createModelProvider(loadConfig({}))).toThrow('NOT_CONFIGURED');
  });

  it('sanitizes network failures without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('SECRET in upstream URL'); });
    const provider = createModelProvider(loadConfig(azureEnv), fetchMock);
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Model provider: NETWORK_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires Tavily before executing a configured model; no hidden live call', async () => {
    const fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock);
    const app = buildServer({ logger: false, config: loadConfig(azureEnv) });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: 'feature4', message: 'Hello' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'CHAT_NOT_CONFIGURED' }, conversationId: 'feature4', requestId: response.headers['x-request-id'] });
      expect(response.json()).not.toHaveProperty('answer'); expect(response.headers['content-type']).toContain('application/json');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe('Azure configuration validation', () => {
  it('requires an explicit endpoint, deployment, key, and known context window', () => {
    expect(loadConfig(azureEnv)).toMatchObject({ MODEL_PROVIDER: 'azure-openai-v1', AZURE_OPENAI_CONTEXT_TOKENS: 32768 });
    for (const field of ['AZURE_OPENAI_CHAT_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_CONTEXT_TOKENS']) {
      expect(() => loadConfig({ ...azureEnv, [field]: '' })).toThrow(field);
    }
  });
  it.each([
    'http://test.openai.azure.com/openai/v1/chat/completions',
    'https://test.openai.azure.com/openai/deployments/old/chat/completions?api-version=unknown',
    'https://test.openai.azure.com/models/chat/completions',
    'https://user:password@test.openai.azure.com/openai/v1/chat/completions',
  ])('rejects unsupported endpoint shape without exposing it: %s', (endpoint) => {
    try { loadConfig({ ...azureEnv, AZURE_OPENAI_CHAT_ENDPOINT: endpoint }); expect.unreachable(); }
    catch (error) { expect(String(error)).toContain('AZURE_OPENAI_CHAT_ENDPOINT'); expect(String(error)).not.toContain(endpoint); }
  });
});
