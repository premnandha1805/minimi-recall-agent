import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { runAgent } from '../src/agent.js';
import { createExecution } from '../src/execution.js';
import type { ModelProvider, ModelResponse } from '../src/model.js';
import type { SearchDocument, WebSearch } from '../src/search.js';

const answer = (text = 'A direct answer.'): ModelResponse => ({ text, toolCalls: [], finishReason: 'stop' });
const call = (id: string, queries: string[], name = 'web_search') => ({ id, name, arguments: JSON.stringify({ queries }) });
const tools = (...toolCalls: ModelResponse['toolCalls']): ModelResponse => ({ text: '', toolCalls, finishReason: 'tool_calls' });
// Frozen offline fixture, never presented as live web evidence.
const document = (query: string): SearchDocument => ({ title: `Fixture ${query}`, url: `https://example.com/${encodeURIComponent(query)}`,
  text: `Frozen evidence for ${query}`, retrieved_at: '2026-11-13T12:00:00Z' });
const fixtureSearch = vi.fn<WebSearch>(async (query) => [document(query)]);
function sequence(...responses: ModelResponse[]): ModelProvider & { complete: ReturnType<typeof vi.fn<ModelProvider['complete']>> } {
  return { contextWindowTokens: 65_536, complete: vi.fn<ModelProvider['complete']>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected extra model call');
    return next;
  }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const freshSignal = () => new AbortController().signal;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('bounded internal agent core (offline fixtures)', () => {
  it('Gate 7C references repeated IDs and identical bodies once without changing sources', async () => {
    const provider = sequence(tools(call('first', ['one','two'])), tools(call('second', ['three'])), answer('Evidence [S1] [S2]'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(), search: async (query) => [
      { ...document('same'), text: 'Identical source evidence' }, { ...document(query), text: 'Identical source evidence' }] });
    expect(result.reason).toBe('answer');
    const messages = provider.complete.mock.calls[2][0].messages.filter((m) => m.role === 'tool');
    expect(messages.map((m) => m.content).join(' ')).toContain('textRef');
    expect(messages.map((m) => m.content).join(' ')).toContain('previouslySupplied');
    expect(messages.map((m) => m.content).join(' ').match(/Identical source evidence/g)).toHaveLength(1);
    expect(result.sources.every((s) => s.text === 'Identical source evidence')).toBe(true);
  });
  it.each([true, false])('Gate 7C validates selected quotes and rejects discarded text (valid=%s)', async (valid) => {
    let seenText = '';
    const history = Array.from({ length: 10 }, (_, n) => ({ role: 'user' as const, content: `${n}` + 'h'.repeat(2500), timestamp: '2026-11-03T10:00:00Z' }));
    let calls = 0;
    const result = await runAgent({ message: 'hosting' , history }, { signal: freshSignal(),
      provider: { contextWindowTokens: 65536, complete: async (request) => {
        if (++calls === 1) return tools(call('search', ['one','two','three','four','five']));
        seenText = JSON.parse(request.messages.find((m) => m.role === 'tool')!.content)[0].sources[0].text;
        return answer(valid ? '“hosting one0” [S1]' : '“Discarded original statement” [S1]');
      } }, search: async (query) => Array.from({ length: 3 }, (_, n) => ({ ...document(`${query}${n}`),
        text: 'Discarded original statement ' + 'x'.repeat(1200) + ` hosting ${query}${n} ` + 'z'.repeat(700) })) });
    expect(seenText).not.toContain('Discarded original statement');
    expect(result.sources[0].text).toBe(seenText);
    expect(result.answer).toContain(valid ? 'hosting one0' : 'quotation warning');
    if (valid) expect(result.answer).not.toContain('quotation warning');
  });
  it('answers without search, preserves supplied history, and reports only actual usage', async () => {
    const provider = sequence({ ...answer(), usage: { inputTokens: 20, outputTokens: 5 } });
    const result = await runAgent({ message: 'those five?', history: [{ role: 'user', content: '  original shortlist  ',
      timestamp: '2026-11-12T12:00:00Z' }] }, { provider, signal: freshSignal(), search: fixtureSearch });
    expect(result).toMatchObject({ status: 'completed', reason: 'answer', answer: 'A direct answer.', sources: [],
      usage: [{ inputTokens: 20, outputTokens: 5 }], stats: { modelCalls: 1, searchRounds: 0, searchRequests: 0 } });
    const request = provider.complete.mock.calls[0][0];
    expect(JSON.parse(request.messages[1].content)).toEqual({ timestamp: '2026-11-12T12:00:00Z', content: '  original shortlist  ' });
    expect(request.tools.map((tool) => tool.name)).toEqual(['web_search']);
    expect(request.messages[0].content).toContain('untrusted data');
    expect(fixtureSearch).not.toHaveBeenCalled();
  });

  it('enforces 5+3 across multiple calls per round, counts failed searches, and disables tools for synthesis', async () => {
    const provider = sequence(tools(call('a', ['1', '2', '3', '4']), call('b', ['5', '6', '7'])),
      tools(call('c', ['8', '9']), call('d', ['10', '11', '12'])), answer('Verified some items [S1].'));
    const search = vi.fn<WebSearch>(async (query) => {
      if (query === '2') throw new Error('Provider search failure');
      return [document(query)];
    });
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(), search });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['1', '2', '3', '4', '5', '8', '9', '10']);
    expect(result).toMatchObject({ status: 'partial', stats: { modelCalls: 3, searchRounds: 2, searchRequests: 8 } });
    expect(result.issues).toEqual(expect.arrayContaining(['search_failed', 'search_budget_exhausted']));
    expect(result.sources.map((source) => source.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(provider.complete.mock.calls[2][0].tools).toEqual([]);
    expect(result.sources.every((source) => source.published_at === undefined && source.effective_at === undefined)).toBe(true);
  });

  it('terminates early after one research round and preserves tool-call/result correspondence', async () => {
    const provider = sequence(tools(call('a', ['first'])), answer('Evidence [S1]'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(), search: fixtureSearch });
    expect(result.stats).toMatchObject({ modelCalls: 2, searchRounds: 1, searchRequests: 1 });
    expect(provider.complete.mock.calls[1][0].messages.slice(-2)).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'a' }] }, { role: 'tool', toolCallId: 'a' },
    ]);
    expect(result.status).toBe('completed');
  });

  it('deduplicates normalized queries within and across rounds and then stops research', async () => {
    const provider = sequence(tools(call('a', ['hello world', ' HELLO   WORLD '])),
      tools(call('b', ['ＨＥＬＬＯ world'])), answer('Evidence [S1]'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(), search: fixtureSearch });
    expect(fixtureSearch).toHaveBeenCalledTimes(1);
    expect(result.stats.modelCalls).toBe(3);
    expect(provider.complete.mock.calls[2][0].messages.at(-1)?.content).toContain('duplicate');
    expect(provider.complete.mock.calls[2][0].tools).toEqual([]);
  });

  it('keeps concurrency at two and assigns source IDs in query order despite completion order', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<SearchDocument[]>());
    let active = 0; let peak = 0;
    const search = vi.fn<WebSearch>(async (query) => {
      peak = Math.max(peak, ++active);
      try { return await pending[Number(query)].promise; } finally { active--; }
    });
    const run = runAgent({ message: 'Research' }, { provider: sequence(tools(call('a', ['0', '1', '2', '3', '4'])), answer('Done [S1]')),
      signal: freshSignal(), search });
    await flush(); expect(search).toHaveBeenCalledTimes(2);
    pending[1].resolve([document('1')]); await flush(); expect(search).toHaveBeenCalledTimes(3);
    pending[2].resolve([document('2')]); await flush();
    pending[3].resolve([document('3')]); await flush();
    pending[4].resolve([document('4')]); pending[0].resolve([document('0')]);
    const result = await run;
    expect(peak).toBe(2);
    expect(result.sources.map(({ id, query }) => [id, query])).toEqual(['0', '1', '2', '3', '4'].map((q, i) => [`S${i + 1}`, q]));
  });

  it.each([
    [{ id: 'a', name: 'web_search', arguments: '{broken' }, 'invalid_tool_call'],
    [{ id: 'a', name: 'web_search', arguments: '{"queries":[]}' }, 'invalid_tool_call'],
    [{ id: 'a', name: 'web_search', arguments: '{"queries":["x"],"extra":1}' }, 'invalid_tool_call'],
    [call('a', ['x'], 'shell'), 'unsupported_tool'],
  ] as const)('rejects malformed or unsupported request %j before search', async (tool, reason) => {
    const result = await runAgent({ message: 'Test' }, { provider: sequence(tools(tool)), signal: freshSignal(), search: fixtureSearch });
    expect(result.reason).toBe(reason); expect(result.answer).toBeUndefined();
    expect(fixtureSearch).not.toHaveBeenCalled();
  });

  it('rejects repeated call IDs without repeating provider requests', async () => {
    const result = await runAgent({ message: 'Test' }, { provider: sequence(tools(call('same', ['a'])), tools(call('same', ['b']))),
      signal: freshSignal(), search: fixtureSearch });
    expect(result.reason).toBe('repeated_tool_call'); expect(fixtureSearch).toHaveBeenCalledTimes(1);
  });

  it('rejects a third tool round even if the model ignores tools disabled', async () => {
    const provider = sequence(tools(call('a', ['a'])), tools(call('b', ['b'])), tools(call('c', ['c'])));
    const result = await runAgent({ message: 'Test' }, { provider, signal: freshSignal(), search: fixtureSearch });
    expect(result.reason).toBe('round_limit'); expect(result.stats.modelCalls).toBe(3);
    expect(fixtureSearch).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable search explicitly, invents no sources, and allows one synthesis', async () => {
    const provider = sequence(tools(call('a', ['current facts'])), answer('I cannot verify current facts because search is unavailable.'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal() });
    expect(result).toMatchObject({ status: 'partial', sources: [], issues: ['search_unavailable'], stats: { searchRequests: 0, modelCalls: 2 } });
    expect(provider.complete.mock.calls[1][0].tools).toEqual([]);
    expect(provider.complete.mock.calls[1][0].messages.at(-1)?.content).toContain('unavailable');
  });

  it('rejects nonexistent citations rather than returning fabricated evidence', async () => {
    const result = await runAgent({ message: 'Research' }, { provider: sequence(answer('Claim [S1]')), signal: freshSignal() });
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid_citation', sources: [] });
    expect(result.answer).toBeUndefined();
  });

  it('uses the same truncated source text in model context and the registry', async () => {
    const provider = sequence(tools(call('a', ['test'])), answer('Evidence [S1]'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(),
      search: async () => [{ ...document('test'), text: 'x'.repeat(3000) }] });
    const outcome = JSON.parse(provider.complete.mock.calls[1][0].messages.at(-1)!.content)[0];
    expect(result.sources[0].text).toHaveLength(2000);
    expect(outcome.sources[0]).toEqual(result.sources[0]);
  });

  it('preserves explicit date-only evidence without inventing time or timezone', async () => {
    const result = await runAgent({ message: 'Research' }, {
      provider: sequence(tools(call('a', ['dated'])), answer('Evidence [S1]')),
      signal: freshSignal(), search: async () => [{ ...document('dated'), published_at: '2026-11-12', effective_at: '2026-12-01' }],
    });
    expect(result.sources[0]).toMatchObject({ published_at: '2026-11-12', effective_at: '2026-12-01' });
  });

  it('rejects invalid source URLs or missing retrieval dates instead of inventing replacements', async () => {
    const provider = sequence(tools(call('a', ['bad'])), answer('Could not verify.'));
    const result = await runAgent({ message: 'Research' }, { provider, signal: freshSignal(),
      search: async () => [{ ...document('bad'), url: 'javascript:alert(1)' }] });
    expect(result.sources).toEqual([]); expect(result.issues).toContain('search_invalid_results');
  });

  it.each([
    [answer('  '), 'empty_output'],
    [{ ...answer('truncated'), finishReason: 'length' }, 'output_limit'],
    [{ ...answer('blocked'), finishReason: 'content_filter' }, 'content_filter'],
    [{ ...answer(), text: 'x'.repeat(16_001) }, 'invalid_response'],
    [{ ...answer(), toolCalls: [call('a', ['x'])] }, 'invalid_response'],
    [{ ...answer(), usage: { inputTokens: 1, outputTokens: 2049 } }, 'output_limit'],
  ] as const)('handles invalid/empty/truncated/filtered output: %s', async (response, reason) => {
    const result = await runAgent({ message: 'Test' }, { provider: sequence(response as ModelResponse), signal: freshSignal() });
    expect(result.reason).toBe(reason); expect(result.answer).toBeUndefined();
  });

  it('contains provider failures without leaking provider secrets or retrying', async () => {
    const provider: ModelProvider = { contextWindowTokens: 65_536, complete: vi.fn(async () => { throw new Error('SECRET-KEY'); }) };
    const result = await runAgent({ message: 'Test' }, { provider, signal: freshSignal() });
    expect(result.reason).toBe('provider_error'); expect(JSON.stringify(result)).not.toContain('SECRET-KEY');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('reserves output budget even without usage and stops before another model request', async () => {
    const provider = sequence(tools(call('a', ['x'])), answer());
    const result = await runAgent({ message: 'Test' }, { provider, signal: freshSignal(), outputTokenBudget: 100, search: fixtureSearch });
    expect(result.reason).toBe('output_budget'); expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.complete.mock.calls[0][0].maxOutputTokens).toBe(100);
  });

  it('rejects oversized context without discarding supplied history or calling the model', async () => {
    const provider = { ...sequence(answer()), contextWindowTokens: 4096 };
    const result = await runAgent({ message: 'x'.repeat(4000) }, { provider, signal: freshSignal() });
    expect(result.reason).toBe('context_limit'); expect(provider.complete).not.toHaveBeenCalled();
  });

  it('cannot raise request limits above frozen caps or bypass input validation', async () => {
    const provider = sequence(answer());
    expect((await runAgent({ message: 'test' }, { provider, signal: freshSignal(), deadlineMs: 25_001 })).reason).toBe('invalid_request');
    expect((await runAgent({ message: 'test' }, { provider, signal: freshSignal(), outputTokenBudget: 6145 })).reason).toBe('invalid_request');
    expect((await runAgent({ message: '' }, { provider, signal: freshSignal() })).reason).toBe('invalid_request');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('times out a hung model, aborts its signal, clears timers, and observes late rejection', async () => {
    vi.useFakeTimers();
    const pending = deferred<ModelResponse>(); const parent = new AbortController();
    const complete = vi.fn<ModelProvider['complete']>(() => pending.promise);
    const run = runAgent({ message: 'Test' }, { provider: { contextWindowTokens: 65_536, complete }, signal: parent.signal, modelTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await run).reason).toBe('model_timeout');
    expect(complete.mock.calls[0][0].signal.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    pending.reject(new Error('Late provider failure')); await flush();
    expect(vi.getTimerCount()).toBe(0); // Vitest also fails on any unhandled rejection.
  });

  it('inherits cancellation from the existing server lifecycle and does no work after disconnect', async () => {
    const request = new IncomingMessage(new Socket()); const response = new ServerResponse(request);
    const execution = createExecution(request, response, 25_000, vi.fn());
    const pending = deferred<ModelResponse>(); const complete = vi.fn<ModelProvider['complete']>(() => pending.promise);
    const run = runAgent({ message: 'Test' }, { provider: { contextWindowTokens: 65_536, complete }, signal: execution.signal });
    await flush(); request.socket.emit('close');
    expect((await run).reason).toBe('cancelled'); expect(complete.mock.calls[0][0].signal.aborted).toBe(true);
    pending.reject(new Error('Late failure')); await flush(); execution.dispose();
    expect(getEventListeners(execution.signal, 'abort')).toHaveLength(0);
  });

  it('does not start work for a pre-aborted signal or an already expired arrival deadline', async () => {
    const provider = sequence(answer()); const controller = new AbortController(); controller.abort();
    expect((await runAgent({ message: 'Test' }, { provider, signal: controller.signal })).reason).toBe('cancelled');
    expect((await runAgent({ message: 'Test' }, { provider, signal: freshSignal(), startedAt: performance.now() - 26_000 })).reason).toBe('deadline');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('enforces the overall deadline across successive model calls rather than resetting it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let n = 0;
    const provider: ModelProvider = { contextWindowTokens: 65_536, complete: async () => {
      await new Promise((resolve) => setTimeout(resolve, 9000));
      return ++n <= 2 ? tools(call(`c${n}`, [`q${n}`])) : answer();
    } };
    const run = runAgent({ message: 'Test' }, { provider, signal: freshSignal(), search: fixtureSearch });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await run).toMatchObject({ reason: 'deadline', stats: { modelCalls: 3, searchRequests: 1 } });
    await vi.advanceTimersByTimeAsync(2000); // settle the deliberately uncooperative provider
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops new searches at 15 seconds but leaves time for synthesis', async () => {
    const provider = sequence(tools(call('a', ['current'])), answer('Research was incomplete.'));
    const result = await runAgent({ message: 'Test' }, { provider, signal: freshSignal(), search: fixtureSearch,
      startedAt: performance.now() - 15_001 });
    expect(result.issues).toContain('search_cutoff'); expect(result.status).toBe('partial');
    expect(fixtureSearch).not.toHaveBeenCalled(); expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('rechecks the cutoff for queued queries after earlier searches complete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const search = vi.fn<WebSearch>(async (query) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return [document(query)];
    });
    const run = runAgent({ message: 'Test' }, {
      provider: sequence(tools(call('a', ['1', '2', '3', '4', '5'])), answer('Only two searches completed [S1].')),
      signal: freshSignal(), search, startedAt: performance.now() - 14_000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run;
    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'partial', issues: ['search_cutoff'], stats: { searchRequests: 2 } });
  });

  it('recognizes the existing HTTP arrival deadline as a deadline, not a client cancellation', async () => {
    vi.useFakeTimers();
    const request = new IncomingMessage(new Socket()); const response = new ServerResponse(request);
    const onDeadline = vi.fn(); const execution = createExecution(request, response, 50, onDeadline);
    const pending = deferred<ModelResponse>();
    const complete = vi.fn<ModelProvider['complete']>(() => pending.promise);
    const run = runAgent({ message: 'Test' }, { provider: { contextWindowTokens: 65_536, complete }, signal: execution.signal });
    await vi.advanceTimersByTimeAsync(50);
    expect((await run).reason).toBe('deadline'); expect(onDeadline).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].signal.aborted).toBe(true);
    pending.resolve(answer('Late')); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('search timeout aborts signals, prevents replacement work, and permits honest synthesis', async () => {
    vi.useFakeTimers();
    const pending = deferred<SearchDocument[]>();
    const search = vi.fn<WebSearch>(() => pending.promise);
    const run = runAgent({ message: 'Test' }, { provider: sequence(tools(call('a', ['1', '2', '3', '4'])), answer('Unable to verify.')),
      signal: freshSignal(), search });
    await vi.advanceTimersByTimeAsync(4000);
    const result = await run;
    expect(result.issues).toContain('search_timeout'); expect(result.sources).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2); expect(search.mock.calls.every(([, { signal }]) => signal.aborted)).toBe(true);
    pending.reject(new Error('Late search failure')); await flush(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending search work and does not call synthesis afterwards', async () => {
    const pending = deferred<SearchDocument[]>(); const controller = new AbortController();
    const provider = sequence(tools(call('a', ['x', 'y', 'z'])), answer());
    const search = vi.fn<WebSearch>(() => pending.promise);
    const run = runAgent({ message: 'Test' }, { provider, signal: controller.signal, search });
    await flush(); controller.abort(); const result = await run;
    expect(result.reason).toBe('cancelled'); expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(2); expect(search.mock.calls.every(([, { signal }]) => signal.aborted)).toBe(true);
    pending.reject(new Error('Late search rejection')); await flush();
  });

});
