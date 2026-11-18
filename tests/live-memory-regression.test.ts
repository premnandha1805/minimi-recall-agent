import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ConversationStore } from '../src/memory.js';
import { retrieveMemory, memoryKeywords } from '../src/context.js';
import { ModelProviderError, type ModelProvider, type ModelRequest } from '../src/model.js';
import { readChatStream } from '../public/api.js';
import { azureEnv } from './fixtures/chat-stream.js';
import { resolveYearlessEvent } from '../src/dates.js';
import { history, fixtureId } from './fixtures/universal-memory.js';

const apps: ReturnType<typeof buildServer>[] = [];
const roots: string[] = [];
const stores: ConversationStore[] = [];
const fact = 'I have an Infosys meeting on 23 August.';
type Mode = 'normal' | 'slow' | 'throwing' | '5xx';
async function setup(directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'recall-live-regression-'));
  if (!directory) roots.push(root);
  const state = { mode: 'normal' as Mode };
  const complete = vi.fn<ModelProvider['complete']>(async (request) => {
    if (state.mode === 'slow') return new Promise(() => {}); // deliberately ignores signal to test bounded waiting
    if (state.mode === 'throwing') throw new ModelProviderError('HTTP_ERROR', 401);
    if (state.mode === '5xx') throw new ModelProviderError('HTTP_ERROR', 503);
    await request.onText?.('Saved.');
    return { text: 'Saved.', finishReason: 'stop', toolCalls: [] };
  });
  const search = vi.fn<typeof fetch>(async () => { throw new Error('Recall must not search the web'); });
  const app = buildServer({ config: loadConfig(azureEnv), memoryDirectory: root, logger: false,
    provider: { contextWindowTokens: 65536, complete }, fetchImpl: search, modelTimeoutMs: 25 });
  apps.push(app);
  return { app, state, complete, search, directory: root };
}
async function chat(app: ReturnType<typeof buildServer>, message: string, id = randomUUID()) {
  const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: id, message, timezone: 'Asia/Kolkata' } });
  expect(response.statusCode).toBe(200);
  return { response, ...(await readChatStream(new Response(response.body))) };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('production memory flow through the real Fastify app', () => {
  it.each(['What meeting did I tell you about?', 'Do I have anything planned?', 'Do I have any meeting coming up?'])(
    'T1/T2: new conversation recalls Infosys: %s', async (question) => {
      const { app, complete, search } = await setup();
      const a = await chat(app, fact); const b = await chat(app, question);
      expect(a.response.headers['x-conversation-id']).not.toBe(b.response.headers['x-conversation-id']);
      expect(b.result?.message.content).toContain('Infosys'); expect(b.result?.message.content).toContain('23 August');
      expect(b.result?.memory?.earlierConversations).toBe(1); expect(b.error).toBeUndefined();
      expect(complete).toHaveBeenCalledTimes(2); expect(search).not.toHaveBeenCalled();
    });
  it('T3: a timed-out Chat A still persists the original and an assistant error before Chat B', async () => {
    const { app, state } = await setup(); state.mode = 'slow';
    const a = await chat(app, fact);
    const saved = (await app.inject(`/api/conversations/${a.response.headers['x-conversation-id']}`)).json();
    expect(saved.turns[0].user.content).toBe(fact);
    expect(saved.turns[0].attempts[0].errorMessage).toMatchObject({ role: 'assistant', status: 'error' });
    state.mode = 'normal';
    const b = await chat(app, 'What meeting did I tell you about?');
    expect(b.result?.message.content).toContain(fact);
  });
  it.each(['slow', 'throwing', '5xx'] as const)('T4: %s recall falls back to original evidence', async (mode) => {
    const { app, state, complete } = await setup(); await chat(app, fact); state.mode = mode;
    const b = await chat(app, 'What meeting did I tell you about?');
    expect(b.result?.message.content).toContain(fact); expect(b.error).toBeUndefined();
    expect(b.response.body).not.toMatch(/MODEL_TIMEOUT|MODEL_FAILED/);
    expect(b.result?.memory?.fallback).toBe(true);
    expect(complete).toHaveBeenCalledTimes(mode === 'throwing' ? 2 : 3);
  });
  it('T5: no evidence plus provider failure returns a friendly retry error', async () => {
    const { app, state } = await setup(); state.mode = 'throwing';
    const b = await chat(app, 'Explain recursion.');
    expect(b.result).toBeUndefined(); expect(b.error?.message).toMatch(/saved.*retry/i);
    expect(b.response.body).not.toMatch(/never (?:mentioned|told)/i);
  });
  it('T6: a new app process loads the same files and recalls the fact', async () => {
    const first = await setup(); await chat(first.app, fact); await first.app.close();
    const second = await setup(first.directory);
    expect((await chat(second.app, 'What meeting did I tell you about?')).result?.message.content).toContain(fact);
  });
  it('T7: notebook computer and laptop brand share lexical aliases', async () => {
    const { app } = await setup(); await chat(app, 'I purchased a notebook computer from Dell');
    expect((await chat(app, 'Which laptop brand did I buy?')).result?.message.content).toContain('Dell');
  });
  it('remembers a person and task while treating the initial statement as a new fact', async () => {
    const { app, complete, search } = await setup();
    const original = 'I asked Priya to review the deployment checklist for CedarRelease-9173.';
    await chat(app, original);
    const answer = await chat(app, 'Who did I ask to review the deployment checklist for CedarRelease-9173?');
    expect(answer.result?.message.content).toContain(original);
    expect(complete).toHaveBeenCalledTimes(2); expect(search).not.toHaveBeenCalled();
  });
  it('T8: an empty archive honestly says there is no saved history', async () => {
    const { app, complete } = await setup();
    expect((await chat(app, 'What meeting did I tell you about?')).result?.message.content).toMatch(/no saved history yet/i);
    expect(complete).not.toHaveBeenCalled();
  });
  it('T9: memory is outside src and is explicitly ignored by the watcher', async () => {
    const config = loadConfig({});
    expect(resolve(config.MEMORY_DIRECTORY).startsWith(resolve('src'))).toBe(false);
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.scripts.dev).toContain('--ignore ./.data/**'); expect(pkg.scripts.dev).toContain('--ignore ./.recall-data/**');
  });
  it('persists the user on disk before the provider can start', async () => {
    const { app, complete, directory } = await setup();
    complete.mockImplementationOnce(async (_request: ModelRequest) => {
      const files = (await readdir(directory)).filter((p) => p.endsWith('.json'));
      const saved = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
      expect(saved.turns[0].user.content).toBe(fact);
      return { text: 'Saved.', finishReason: 'stop', toolCalls: [] };
    });
    await chat(app, fact);
  });
  it('debug summary is local only and requires the production flag', async () => {
    const { app, directory } = await setup(); await chat(app, fact);
    const summary = (await app.inject('/api/debug/memory')).json();
    expect(summary).toMatchObject({ absolutePath: resolve(directory), conversationCount: 1 });
    expect(summary.conversations[0]).toMatchObject({ title: fact, messageCount: 2 });
    expect((await app.inject({ url: '/api/debug/memory', headers: { origin: 'https://attacker.example' } })).statusCode).toBe(403);
    const production = buildServer({ config: loadConfig({ ...azureEnv, NODE_ENV: 'production' }), memoryDirectory: directory, logger: false }); apps.push(production);
    expect((await production.inject('/api/debug/memory')).statusCode).toBe(404);
  });
  it('recovers malformed/empty JSON on restart using a backup, keeping damaged bytes', async () => {
    const { app, directory } = await setup(); const a = await chat(app, fact); await app.close();
    const id = String(a.response.headers['x-conversation-id']);
    const file = `${createHash('sha256').update(id).digest('hex')}.json`;
    await writeFile(join(directory, file), '');
    const restarted = await setup(directory);
    expect((await chat(restarted.app, 'What meeting did I tell you about?')).result?.message.content).toContain(fact);
    expect((await readdir(join(directory, '.backups'))).some((p) => p.endsWith('.corrupt'))).toBe(true);
  });
});

it('T10: deterministic retrieval over 500 committed conversations takes under 50 ms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recall-500-')); roots.push(directory);
  const timestamp = '2026-11-01T10:00:00.000Z';
  // Frozen on-disk documents exercise startup validation and the production snapshot.
  for (let i = 0; i < 500; i++) {
    const id = randomUUID();
    const value = { schemaVersion: 'recall.memory.v1', id, revision: 1, createdAtUtc: timestamp, updatedAtUtc: timestamp,
      seededMessages: [], turns: [{ id: randomUUID(), key: `fact-${i}`, ordinal: 0, provenance: 'server_recorded',
        user: { id: randomUUID(), role: 'user', content: i === 499 ? fact : `I chose database number ${i} for project ${i}.`, timestamp }, attempts: [] }] };
    await writeFile(join(directory, `${createHash('sha256').update(id).digest('hex')}.json`), JSON.stringify(value));
  }
  const store = await ConversationStore.open({ directory, cachedSnapshots: true, maxConversations: 1000 }); stores.push(store);
  const options = { query: 'What meeting did I tell you about?', activeConversationId: randomUUID(), currentTurnId: randomUUID(),
    referenceInstant: '2026-11-18T10:00:00.000Z', timezone: 'Asia/Kolkata', signal: new AbortController().signal,
    startedAt: performance.now(), deadlineMs: 25000, alwaysRetrieve: true };
  await retrieveMemory(store, options); // warm JIT and Intl; startup I/O is measured separately
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); const result = await retrieveMemory(store, { ...options, startedAt: start });
    times.push(performance.now() - start);
    expect(result.conversationsScanned).toBe(500); expect(result.records[0].user.content).toBe(fact);
  }
  console.log(`500-conversation retrieval ms: ${times.map((t) => t.toFixed(2)).join(', ')}`);
  expect(Math.max(...times)).toBeLessThan(50);
}, 20_000);

it.each([
  ['23 August', '2026-08-01T10:00:00Z', '2026-08-23'],
  ['3 January', '2026-12-28T10:00:00Z', '2027-01-03'],
  ['29 February', '2025-02-01T10:00:00Z', '2024-02-29'],
])('resolves yearless event %s relative to its original message', (expression, instant, expected) => {
  expect(resolveYearlessEvent(expression, { instant, timezone: 'Asia/Kolkata' })).toMatchObject({ status: 'resolved', localStart: expected });
});

it('normalizes the required aliases without embeddings', () => {
  for (const [a, b] of [['laptop', 'notebook computer'], ['meeting', 'catch-up'], ['college', 'university'],
    ['project', 'assignment'], ['db', 'database'], ['job', 'work']]) expect(memoryKeywords(a)).toEqual(memoryKeywords(b));
});

it('keeps the whole active conversation when strong archive matches compete for context', async () => {
  const active = history(1000, ['Keep the cover green.', 'Include the original shortlist.']);
  const values = [active, ...Array.from({ length: 12 }, (_, i) => history(2000 + i * 100, ['A deployment plan uses blueprints.']))];
  const store = { snapshot: async () => values, list: vi.fn(), load: vi.fn() };
  const result = await retrieveMemory(store, { query: 'Continue the deployment plan', activeConversationId: active.id,
    currentTurnId: fixtureId(99999), referenceInstant: '2026-11-18T10:00:00Z', timezone: 'UTC',
    signal: new AbortController().signal, startedAt: performance.now(), deadlineMs: 25000, alwaysRetrieve: true });
  expect(result.records.filter((r) => r.conversationId === active.id).map((r) => r.user.content)).toEqual(active.turns.map((t) => t.user.content));
  expect(result.records.filter((r) => r.conversationId !== active.id)).toHaveLength(8);
});
