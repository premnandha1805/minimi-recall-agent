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

it('runs fresh web research and archive retrieval concurrently, sharing source IDs and the search budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recall-parallel-'));
  let entered!: () => void; const searching = new Promise<void>((r) => { entered = r; });
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  const snapshot = vi.spyOn(ConversationStore.prototype, 'snapshot');
  const search = vi.fn(async () => { entered(); await hold; return [{ title: 'Current official fixture', url: 'https://example.com/current',
    text: 'Current external evidence.', retrieved_at: new Date().toISOString() }]; });
  const complete = vi.fn<ModelProvider['complete']>(async (request) => {
    expect(JSON.stringify(request.messages)).toContain('untrustedWebSearchData');
    await request.onText?.('Current evidence [S1].');
    return { text: 'Current evidence [S1].', finishReason: 'stop', toolCalls: [] };
  });
  const app = buildServer({ memoryDirectory: directory, logger: false, config: loadConfig(azureEnv),
    provider: { contextWindowTokens: 65536, complete }, search });
  try {
    const pending = app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Search the web for current external evidence.' } }).then((r) => r);
    await searching;
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2)); // persisted-stage summary + actual retrieval, while search is blocked
    expect(complete).not.toHaveBeenCalled(); release();
    const response = await pending; const deltas: string[] = [];
    const result = await readChatStream(new Response(response.body), { onDelta: (s) => { deltas.push(s); } });
    expect(result.result?.sources).toMatchObject([{ id: 'S1', url: 'https://example.com/current' }]);
    expect(deltas.join('')).toBe('Current evidence [S1].'); expect(search).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
  } finally { release(); await app.close(); snapshot.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
