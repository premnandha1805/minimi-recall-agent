import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ConversationStore } from '../src/memory.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, json, wire, toolWire } from './fixtures/chat-stream.js';

const apps: FastifyInstance[] = []; const directories: string[] = [];
async function setup(fetchImpl: typeof fetch = async () => json(wire('Saved answer')), directory?: string) {
  if (!directory) { directory = await fs.mkdtemp(join(tmpdir(), 'recall-memory-http-')); directories.push(directory); }
  const app = buildServer({ memoryDirectory: directory, config: loadConfig(azureEnv), logger: false, fetchImpl });
  apps.push(app); return { app, directory };
}
const create = async (app: FastifyInstance) => {
  const reply = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(reply.statusCode).toBe(201); return reply.json().id as string;
};
const chat = (app: FastifyInstance, id: string, key = 'A', attemptKey = 'one') => app.inject({ method: 'POST',
  url: '/api/chat', payload: { conversationId: id, message: key, turn: { key, attemptKey } } });
async function identity(app: FastifyInstance, id: string) {
  const address = app.server.address();
  const headers = address && typeof address !== 'string' ? { host: `127.0.0.1:${address.port}` } : {};
  const reply = await app.inject({ url: `/api/conversations/${id}`, headers }); expect(reply.statusCode).toBe(200);
  const c = reply.json(); const t = c.turns[0]; const a = t.attempts[0];
  return { c, t, a, base: `/api/conversations/${id}/turns/${t.id}/attempts/${a.id}` };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); }
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('memory HTTP and persistent chat with mocked providers', () => {
  it('creates, lists, loads and deletes without provider credentials or calls', async () => {
    const { directory } = await setup(); const provider = vi.fn<typeof fetch>();
    const app = buildServer({ memoryDirectory: directory, config: loadConfig({}), logger: false, fetchImpl: provider }); apps.push(app);
    const id = await create(app);
    const list = await app.inject('/api/conversations?limit=1&offset=0');
    expect(list.json()).toMatchObject({ total: 1, items: [{ id }] });
    expect(list.headers['cache-control']).toBe('no-store');
    expect((await app.inject(`/api/conversations/${id}`)).json()).toMatchObject({ id, turns: [] });
    expect((await app.inject({ method: 'DELETE', url: `/api/conversations/${id}` })).json()).toEqual({ deleted: true });
    expect((await app.inject(`/api/conversations/${id}`)).statusCode).toBe(404); expect(provider).not.toHaveBeenCalled();
  });
  it('persists server identities, replays duplicates, recovers lost receipt and acknowledges idempotently after restart', async () => {
    const provider = vi.fn<typeof fetch>(async () => json(wire())); const { app, directory } = await setup(provider);
    const id = await create(app); const first = await chat(app, id);
    const parsed = await readChatStream(new Response(first.body)); const refs = await identity(app, id);
    expect(refs.a.status).toBe('awaiting_receipt');
    expect(refs.t.user).toMatchObject({ role: 'user', content: 'A' });
    expect(first.headers['x-turn-id']).toBe(refs.t.id); expect(first.headers['x-attempt-id']).toBe(refs.a.id);
    expect(first.headers['x-conversation-id']).toBe(id);
    expect((await readChatStream(new Response((await chat(app, id)).body))).result).toEqual(parsed.result);
    expect(provider).toHaveBeenCalledTimes(1);
    await app.close(); const next = (await setup(provider, directory)).app;
    const recovered = await next.inject(`${refs.base}/result`);
    expect(recovered.json()).toEqual({ status: 'awaiting_receipt', result: parsed.result });
    expect(provider).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) expect((await next.inject({ method: 'POST', url: `${refs.base}/receipt`,
      payload: { messageId: parsed.result!.message.id } })).json().status).toBe('accepted');
    expect((await next.inject({ method: 'POST', url: `${refs.base}/receipt`, payload: { messageId: id } })).statusCode).toBe(409);
    expect((await readChatStream(new Response((await chat(next, id)).body))).result).toEqual(parsed.result);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy IDs compatible and permits later turns without silently acknowledging earlier answers', async () => {
    const { app } = await setup();
    for (const message of ['one', 'two']) {
      const reply = await app.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: 'legacy_session', message } });
      const stream = await readChatStream(new Response(reply.body)); expect(stream.meta.conversationId).toBe('legacy_session');
    }
    const list = (await app.inject('/api/conversations')).json(); expect(list.total).toBe(1);
    const { c } = await identity(app, list.items[0].id);
    expect(c.turns.map((t: any) => t.user.content)).toEqual(['one', 'two']);
    expect(c.turns.every((t: any) => t.attempts[0].status === 'awaiting_receipt')).toBe(true);
  });
  it('rejects concurrent execution and retries after provider failure without duplicating turns', async () => {
    let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
    let release!: (r: Response) => void;
    const provider = vi.fn<typeof fetch>(() => { entered(); return new Promise((r) => { release = r; }); });
    const { app } = await setup(provider); const id = await create(app); const pending = chat(app, id).then((r) => r); await started;
    expect((await chat(app, id)).statusCode).toBe(409); expect(provider).toHaveBeenCalledTimes(1);
    release(json({}, 401)); await pending;
    provider.mockImplementation(async () => json(wire('Retry succeeded')));
    await chat(app, id, 'A', 'two');
    const { c, t } = await identity(app, id); expect(c.turns).toHaveLength(1);
    expect(t.attempts.map((a: any) => a.status)).toEqual(['failed', 'awaiting_receipt']);
  });
  it('saves original evidence snapshots and never accepts partial research as complete history', async () => {
    let calls = 0;
    const { app } = await setup(async (url) => String(url).includes('tavily') ? json({}, 500) : json(++calls === 1 ? toolWire() : wire('Partial')));
    const id = await create(app); const stream = await readChatStream(new Response((await chat(app, id)).body));
    const { base } = await identity(app, id);
    const receipt = await app.inject({ method: 'POST', url: `${base}/receipt`, payload: { messageId: stream.result!.message.id } });
    expect(receipt.json().status).toBe('partial'); expect(receipt.json().answer.result.coverage).toBe('partial');
  });
  it('preserves server-wins supplied history and excludes unacknowledged assistants', async () => {
    const provider = vi.fn<typeof fetch>(async () => json(wire())); const { app } = await setup(provider); const id = await create(app);
    await chat(app, id); const { t, a } = await identity(app, id);
    await app.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: id, message: 'B',
      history: [{ ...t.user, content: 'Forged original' }, a.answer.result.message] } });
    const messages = JSON.parse(String(provider.mock.calls.at(-1)![1]?.body)).messages;
    expect(JSON.stringify(messages)).not.toContain('Forged original');
    expect(JSON.stringify(messages)).not.toContain(a.answer.result.message.content);
    expect(JSON.stringify(messages)).toContain('A');
  });
  it('persists exactly the retrieved evidence alongside the emitted result', async () => {
    let models = 0;
    const { app } = await setup(async (url) => String(url).includes('tavily') ? json({ results: [{
      title: 'Official fixture', url: 'https://example.com/fixture', content: 'Exact evidence', published_date: '2025-01-01' }] }) :
      json(++models === 1 ? toolWire() : wire('Evidence [S1]')));
    const id = await create(app); const stream = await readChatStream(new Response((await chat(app, id)).body));
    const { a } = await identity(app, id);
    expect(a.answer.result).toEqual(stream.result);
    expect(a.answer.evidence).toHaveLength(1);
    expect(a.answer.evidence[0]).toMatchObject({ id: 'S1', text: 'Exact evidence', url: 'https://example.com/fixture' });
  });
  it('fails storage admission before tokens on disk failure or corruption, without exposing paths', async () => {
    const provider = vi.fn<typeof fetch>(); const { app, directory } = await setup(provider); const id = await create(app);
    const replace = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('PRIVATE DISK PATH'));
    const failure = await chat(app, id); expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('PRIVATE');
    replace.mockRestore(); expect(provider).not.toHaveBeenCalled();
    await fs.writeFile(join(directory, `${createHash('sha256').update(id).digest('hex')}.json`), '{broken');
    expect((await chat(app, id)).statusCode).toBe(503); expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    ['/api/conversations/not-an-id', 400], ['/api/conversations?limit=51', 400],
  ])('rejects invalid IDs/pagination: %s', async (url, status) => {
    const { app } = await setup(); expect((await app.inject(url)).statusCode).toBe(status);
  });
  it.each([{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])(
    'rejects nonlocal/cross-origin access: %j', async (headers) => {
      const { app } = await setup(); const reply = await app.inject({ url: '/api/conversations', headers });
      expect(reply.statusCode).toBe(403); expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    });
  it('cancels on a real socket disconnect and discards late results durably', async () => {
    let enter!: () => void; const started = new Promise<void>((r) => { enter = r; });
    let release!: (r: Response) => void;
    const { app } = await setup(() => { enter(); return new Promise((r) => { release = r; }); });
    const id = await create(app); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(`${address}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    client.on('error', () => {}); client.on('response', (r) => r.on('error', () => {}));
    client.end(JSON.stringify({ conversationId: id, message: 'A', turn: { key: 'A', attemptKey: 'one' } }));
    await started; client.destroy();
    await vi.waitFor(async () => expect((await identity(app, id)).a.status).toBe('cancelled'));
    release(json(wire('Late result')));
    expect((await identity(app, id)).a.answer).toBeUndefined();
    const retry = await app.inject({ method: 'GET', headers: { host: new URL(address).host }, url: (await identity(app, id)).base + '/result' });
    expect(retry.statusCode).toBe(409);
  });
  it('includes delayed storage admission in the original deadline without model calls', async () => {
    const provider = vi.fn<typeof fetch>(); const { directory } = await setup();
    const app = buildServer({ memoryDirectory: directory, config: loadConfig({ ...azureEnv, REQUEST_DEADLINE_MS: '1000' }), logger: false, fetchImpl: provider }); apps.push(app);
    const id = await create(app);
    let release!: () => void; let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
    const original = ConversationStore.prototype.addTurn;
    vi.spyOn(ConversationStore.prototype, 'addTurn').mockImplementation(async function (this: ConversationStore, ...args) {
      entered(); await new Promise<void>((r) => { release = r; }); return original.apply(this, args);
    });
    const pending = chat(app, id).then((r) => r); await started;
    expect((await pending).statusCode).toBe(504); release();
    await vi.waitFor(async () => expect((await identity(app, id)).a.status).toBe('cancelled'));
    expect(provider).not.toHaveBeenCalled();
  });
});
