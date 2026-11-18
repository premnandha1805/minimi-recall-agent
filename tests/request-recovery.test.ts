import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ConversationStore } from '../src/memory.js';
import { createFirstTokenScope, ExecutionTimeoutError } from '../src/execution.js';
import { readChatStream } from '../public/api.js';
import { azureEnv } from './fixtures/chat-stream.js';
import type { ModelProvider } from '../src/model.js';

it('keeps streaming after the first-token deadline while bounding the overall call', async () => {
  vi.useFakeTimers();
  const scope = createFirstTokenScope(new AbortController().signal, 24_000, 15_000);
  try {
    await vi.advanceTimersByTimeAsync(14_000); scope.markFirstToken();
    await vi.advanceTimersByTimeAsync(2000); expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(8000); expect(scope.signal.reason).toBeInstanceOf(ExecutionTimeoutError);
  } finally { scope.dispose(); vi.useRealTimers(); }
});

it('retrieves archive before model-driven web research, sharing source IDs and the search budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recall-parallel-'));
  const snapshot = vi.spyOn(ConversationStore.prototype, 'snapshot');
  const search = vi.fn(async () => [{ title: 'Current official fixture', url: 'https://example.com/current',
    text: 'Current external evidence.', retrieved_at: new Date().toISOString() }]);
  let calls = 0;
  const complete = vi.fn<ModelProvider['complete']>(async (request) => {
    if (++calls === 1) {
      expect(search).not.toHaveBeenCalled();
      expect(request.tools.map((t) => t.name)).toEqual(['web_search']);
      return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{"queries":["current external evidence"]}' }] };
    }
    await request.onText?.('Current evidence [S1].');
    return { text: 'Current evidence [S1].', finishReason: 'stop', toolCalls: [] };
  });
  const app = buildServer({ memoryDirectory: directory, logger: false, config: loadConfig(azureEnv),
    provider: { contextWindowTokens: 65536, complete }, search });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Search the web for current external evidence.' } });
    expect(snapshot).toHaveBeenCalledTimes(2); // persisted-stage summary + actual retrieval
    const deltas: string[] = [];
    const result = await readChatStream(new Response(response.body), { onDelta: (s) => { deltas.push(s); } });
    expect(result.result?.sources).toMatchObject([{ id: 'S1', url: 'https://example.com/current' }]);
    expect(deltas.join('')).toBe('Current evidence [S1].'); expect(search).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(2);
  } finally { await app.close(); snapshot.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
