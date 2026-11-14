import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import type { ModelProvider, ModelResponse } from '../src/model.js';
import type { StageObservation } from '../src/observability.js';
import type { SearchDocument, WebSearch } from '../src/search.js';
import { buildServer } from '../src/server.js';
import { azureEnv, json, toolWire, wire } from './fixtures/chat-stream.js';

const answer: ModelResponse = { text: 'Offline answer', toolCalls: [], finishReason: 'stop' };
const research = (id: string, queries: string[]): ModelResponse => ({ text: '', finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'web_search', arguments: JSON.stringify({ queries }) }] });
const document: SearchDocument = { title: 'PRIVATE title', text: 'PRIVATE evidence',
  url: 'https://example.com/PRIVATE-path', retrieved_at: '2026-11-14T00:00:00Z' };
const signal = () => new AbortController().signal;
const provider = (complete: ModelProvider['complete']): ModelProvider => ({ contextWindowTokens: 65_536, complete });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function recording() {
  const events: StageObservation[] = [];
  return { events, observe: (event: StageObservation) => { events.push(event); } };
}
function clock() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded, privacy-safe agent stage observations (offline)', () => {
  it('measures a direct answer with monotonic time and actual usage, including zero reasoning tokens', async () => {
    clock(); const log = recording();
    const run = runAgent({ message: 'PRIVATE prompt' }, { signal: signal(), ...log,
      provider: provider(async () => { await pause(75); return { ...answer,
        usage: { inputTokens: 123, outputTokens: 20, reasoningTokens: 0 } }; }) });
    await vi.advanceTimersByTimeAsync(75);
    expect((await run).status).toBe('completed');
    expect(log.events).toEqual([
      { stage: 'model_call', call: 1, durationMs: 75, outcome: 'success',
        usage: { inputTokens: 123, completionTokens: 20, reasoningTokens: 0 } },
      { stage: 'final_synthesis', call: 1, durationMs: 75, outcome: 'success' },
      { stage: 'agent', durationMs: 75, outcome: 'success', agentStatus: 'completed', modelCalls: 1,
        searchCalls: 0, sourceCount: 0, uniqueSourceUrls: 0 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures concurrent calls and both rounds without changing 5+3 limits or counting duplicate queries', async () => {
    clock(); const log = recording(); let models = 0; let active = 0; let peak = 0;
    const search = vi.fn<WebSearch>(async () => {
      peak = Math.max(peak, ++active); await pause(20); active--; return [document];
    });
    const run = runAgent({ message: 'PRIVATE prompt' }, { signal: signal(), ...log, search,
      provider: provider(async () => {
        await pause(10); models++;
        return models === 1 ? research('one', ['a', 'a', 'b', 'c', 'd', 'e', 'extra']) :
          models === 2 ? research('two', ['f', 'g', 'h', 'extra2']) : { ...answer, text: 'Evidence [S1]' };
      }) });
    await vi.advanceTimersByTimeAsync(130);
    const result = await run;
    expect(result.stats).toMatchObject({ modelCalls: 3, searchRounds: 2, searchRequests: 8 });
    expect(peak).toBe(2); expect(search).toHaveBeenCalledTimes(8);
    expect(log.events.filter((e) => e.stage === 'search_provider')).toHaveLength(8);
    expect(log.events.filter((e) => e.stage === 'search_provider').map((e) => e.call).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(log.events.filter((e) => e.stage === 'search_provider').every((e) => e.durationMs === 20)).toBe(true);
    expect(log.events.filter((e) => e.stage === 'search_round')).toEqual([
      { stage: 'search_round', round: 1, durationMs: 60, outcome: 'failure', searchCalls: 5, sourceCount: 5, uniqueSourceUrls: 1 },
      { stage: 'search_round', round: 2, durationMs: 40, outcome: 'failure', searchCalls: 3, sourceCount: 3, uniqueSourceUrls: 1 },
    ]);
    expect(log.events.at(-1)).toMatchObject({ stage: 'agent', durationMs: 130, outcome: 'success',
      agentStatus: 'partial', sourceCount: 8, uniqueSourceUrls: 1, modelCalls: 3, searchCalls: 8 });
    expect(log.events.filter((e) => e.stage === 'final_synthesis')).toHaveLength(1);
    expect(JSON.stringify(log.events)).not.toMatch(/PRIVATE|https:|queries|Evidence/);
    expect(log.events.find((e) => e.stage === 'model_call')?.usage).toEqual({
      inputTokens: null, completionTokens: null, reasoningTokens: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['model_timeout', 'deadline', 'cancelled'] as const)('records %s once and ignores late completion', async (reason) => {
    clock(); const log = recording(); const controller = new AbortController();
    let resolve!: (value: ModelResponse) => void;
    const run = runAgent({ message: 'hello' }, { signal: controller.signal, ...log,
      // The original arrival time leaves only 500 ms of the unchanged 25 s deadline.
      ...(reason === 'deadline' ? { startedAt: performance.now() - 24_500 } : {}),
      provider: provider(() => new Promise((yes) => { resolve = yes; })) });
    await flush();
    const elapsed = reason === 'model_timeout' ? 10_000 : 500;
    await vi.advanceTimersByTimeAsync(elapsed);
    if (reason === 'cancelled') controller.abort(new Error('PRIVATE abort reason'));
    expect((await run).reason).toBe(reason);
    const outcome = reason === 'cancelled' ? 'abort' : 'timeout';
    expect(log.events.map((e) => [e.stage, e.outcome, e.durationMs])).toEqual([
      ['model_call', outcome, elapsed], ['agent', outcome, elapsed],
    ]);
    expect(log.events[0].usage).toEqual({ inputTokens: null, completionTokens: null, reasoningTokens: null });
    resolve({ ...answer, usage: { inputTokens: 10, outputTokens: 2 } }); await flush();
    expect(log.events).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'abort', 'failure', 'malformed'] as const)('records search %s and preserves partial/cancelled results', async (kind) => {
    clock(); const log = recording(); const controller = new AbortController(); let calls = 0;
    let reject!: (reason: unknown) => void;
    const run = runAgent({ message: 'search' }, { signal: controller.signal, ...log,
      provider: provider(async () => ++calls === 1 ? research('one', ['PRIVATE query']) : answer),
      search: () => kind === 'failure' ? Promise.reject(new Error('PRIVATE provider body')) :
        kind === 'malformed' ? Promise.resolve([{} as SearchDocument]) : new Promise((_yes, no) => { reject = no; }),
    });
    await flush();
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(4000);
    if (kind === 'abort') { await vi.advanceTimersByTimeAsync(150); controller.abort(new Error('PRIVATE')); }
    const result = await run;
    expect(result.status).toBe(kind === 'abort' ? 'cancelled' : 'partial');
    const outcome = kind === 'malformed' ? 'failure' : kind;
    expect(log.events.find((e) => e.stage === 'search_provider')).toMatchObject({ outcome,
      durationMs: kind === 'timeout' ? 4000 : kind === 'abort' ? 150 : 0, call: 1, sourceCount: 0 });
    expect(log.events.find((e) => e.stage === 'search_round')).toMatchObject({ outcome, searchCalls: 1 });
    expect(log.events.at(-1)).toMatchObject({ searchCalls: 1, modelCalls: kind === 'abort' ? 1 : 2 });
    const count = log.events.length;
    reject?.(new Error('PRIVATE late failure')); await flush();
    expect(log.events).toHaveLength(count); expect(JSON.stringify(log.events)).not.toContain('PRIVATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failure', 'malformed', 'invalid_citation'] as const)('distinguishes final agent rejection from provider return: %s', async (kind) => {
    const log = recording();
    const result = await runAgent({ message: 'hello' }, { signal: signal(), ...log,
      provider: provider(async () => {
        if (kind === 'failure') throw new Error('PRIVATE upstream body');
        return kind === 'malformed' ? {} as ModelResponse : { ...answer, text: 'Unknown [S99]' };
      }) });
    expect(result.status).toBe('failed');
    expect(log.events[0].outcome).toBe(kind === 'invalid_citation' ? 'success' : 'failure');
    expect(log.events.at(-1)).toMatchObject({ stage: 'agent', outcome: 'failure', modelCalls: 1 });
    expect(JSON.stringify(log.events)).not.toContain('PRIVATE');
  });

  it('does not let a failed logging sink change execution or cancellation', async () => {
    const observe = () => { throw new Error('Broken logger'); };
    const result = await runAgent({ message: 'hello' }, { provider: provider(async () => answer), signal: signal(), observe });
    expect(result.status).toBe('completed');
    const controller = new AbortController(); controller.abort();
    const complete = vi.fn<ModelProvider['complete']>();
    expect((await runAgent({ message: 'hello' }, { provider: provider(complete), signal: controller.signal, observe })).status).toBe('cancelled');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('Fastify operational logs with real adapters and mocked network', () => {
  it.each(['answer', 'research', 'failure'] as const)('correlates %s stages without leaking request or provider data', async (kind) => {
    let output = ''; let models = 0;
    const app = buildServer({ config: loadConfig({ ...azureEnv, LOG_LEVEL: 'info' }),
      logStream: new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }),
      fetchImpl: async (url) => {
        if (String(url).includes('tavily')) return json({ results: [{ title: 'PRIVATE title',
          url: document.url, content: 'PRIVATE source content' }] });
        if (kind === 'failure') return json({ error: 'PRIVATE raw upstream body' }, 401);
        if (kind === 'research' && ++models === 1) return json(toolWire());
        return json({ ...wire('PRIVATE answer'), usage: { prompt_tokens: 17, completion_tokens: 8,
          completion_tokens_details: { reasoning_tokens: 3, secret: 'PRIVATE extra metadata' } } });
      },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/chat',
        headers: { authorization: 'PRIVATE auth', 'x-request-id': 'PRIVATE client id' },
        payload: { message: 'PRIVATE prompt', conversationId: 'PRIVATE-session',
          history: [{ role: 'user', content: 'PRIVATE history', timestamp: '2026-11-14T00:00:00Z' }] } });
      expect(response.statusCode).toBe(200);
      const events = output.trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.stage);
      expect(events.length).toBeGreaterThan(1);
      expect(events.every((entry) => entry.requestId === response.headers['x-request-id'] && entry.durationMs >= 0)).toBe(true);
      expect(events.at(-1)).toMatchObject({ stage: 'agent', modelCalls: kind === 'research' ? 2 : 1,
        searchCalls: kind === 'research' ? 1 : 0, outcome: kind === 'failure' ? 'failure' : 'success' });
      expect(events.filter((e) => e.stage === 'model_call').at(-1).usage).toEqual(kind === 'failure' ?
        { inputTokens: null, completionTokens: null, reasoningTokens: null } :
        { inputTokens: 17, completionTokens: 8, reasoningTokens: 3 });
      expect(output).not.toMatch(/PRIVATE|offline-azure-secret|offline-tavily-secret|fixture\.openai|example\.com/);
      expect(response.body).not.toMatch(/durationMs|inputTokens|reasoningTokens|Agent stage completed/);
    } finally { await app.close(); }
  });
});
