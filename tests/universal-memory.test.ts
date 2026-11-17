import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archive, history, fixtureId, recallCases, referenceInstant } from './fixtures/universal-memory.js';
import { retrieveMemory, prepareAgentContext, recallIntent, type RetrievedMemory } from '../src/context.js';
import { ConversationStore, type Conversation } from '../src/memory.js';
import { groundedRecallAnswer } from '../src/recall-answer.js';
import { createTemporalResolver } from '../src/dates.js';
import { runAgent } from '../src/agent.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, json, wire } from './fixtures/chat-stream.js';

const opts = (query: string) => ({ query, activeConversationId: fixtureId(9999), currentTurnId: fixtureId(9998),
  referenceInstant, timezone: 'UTC', signal: new AbortController().signal, startedAt: performance.now(), deadlineMs: 25000 });
const frozen = (values: Conversation[]) => ({
  list: async ({ offset = 0, limit = 50 } = {}) => ({ total: values.length, items: values.slice(offset, offset + limit).map((v) => ({
    id: v.id, createdAtUtc: v.createdAtUtc, updatedAtUtc: v.updatedAtUtc, turnCount: v.turns.length })) }),
  load: async (id: string) => structuredClone(values.find((v) => v.id === id)),
});
const roots: string[] = []; const stores: ConversationStore[] = [];
async function disk() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'recall-universal-')); roots.push(directory);
  const db = await ConversationStore.open({ directory, now: () => new Date('2026-11-03T10:00:00Z') }); stores.push(db);
  return db;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of stores.splice(0)) await db.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const measurements: { id: string; expected: number; retrieved: number; relevant: number; retrievalMs: number; grounded: boolean }[] = [];
const integrationTimes: number[] = [];
afterAll(async () => {
  if (process.env.RECALL_MEMORY_EVALUATION !== '1') return;
  const times = measurements.map((r) => r.retrievalMs).sort((a,b) => a-b);
  const report = { kind: 'Synthetic frozen history, mocked model; not live model accuracy',
    rows: measurements, summary: {
      cases: measurements.length,
      expectedConversations: measurements.reduce((n,r) => n+r.expected, 0),
      relevantRetrievedConversations: measurements.reduce((n,r) => n+r.relevant, 0),
      unrelatedRetrievedConversations: measurements.reduce((n,r) => n+r.retrieved-r.relevant, 0),
      groundedCases: measurements.filter((r) => r.grounded).length,
      retrievalP50Ms: times[Math.floor(times.length * .5)], retrievalP95Ms: times[Math.min(times.length-1, Math.floor(times.length*.95))],
      mockedHttpMs: integrationTimes,
    } };
  await fs.writeFile('docs/memory-evaluation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
});

describe('general cross-conversation retrieval evaluation', () => {
  for (const row of recallCases) it(row.id, async () => {
    const start = performance.now(); const memory = await retrieveMemory(frozen(archive), opts(row.query));
    const elapsed = performance.now() - start;
    const ids = [...new Set(memory.records.map((r) => r.conversationId))].sort();
    const expected: string[] = row.ids.map(fixtureId).sort();
    const provider = { contextWindowTokens: 65536, complete: vi.fn(async () => ({
      text: 'You previously chose the fabricated Zephyr product in 2035.', finishReason: 'stop' as const, toolCalls: [],
    })) };
    const response = await runAgent({ message: row.query }, { provider, memory, signal: new AbortController().signal });
    const grounded = !response.answer?.includes('Zephyr') && response.reason === 'answer';
    measurements.push({ id: row.id, expected: expected.length, retrieved: ids.length,
      relevant: ids.filter((id) => expected.includes(id)).length, retrievalMs: elapsed, grounded });
    expect(ids).toEqual(expected); expect(grounded).toBe(true); expect(response.stats.searchRequests).toBe(0);
    if (!expected.length) expect(provider.complete).not.toHaveBeenCalled();
  });

  it('preserves preceding topic and following references without rewriting originals', async () => {
    const memory = await retrieveMemory(frozen(archive), opts('What was my seminar topic?'));
    expect(memory.records.map((r) => r.user.content)).toEqual(archive[3].turns.map((t) => t.user.content));
    expect(memory.records[0].selection).toBe('adjacent');
    expect(JSON.stringify(prepareAgentContext(memory, 'Recall', 65536, 2048))).toContain('gravity and clay pots');
  });
  it('keeps questions about arbitrary subjects as discussion evidence, not established personal facts', async () => {
    const records = [history(10, ['Could my neighbor own an alpaca?'])];
    expect((await retrieveMemory(frozen(records), opts('What did I ask about an alpaca?'))).records).toHaveLength(1);
    expect((await retrieveMemory(frozen(records), opts('What is my alpaca called?'))).status).toBe('not_found');
  });
  it('keeps assistant answers separately labeled, including unverified entity lists', async () => {
    const value = history(10, ['Compare weaving materials.']);
    value.seededMessages.push({ id: fixtureId(99), role: 'assistant', content: 'Cotton, flax, hemp, jute, wool.',
      timestamp: value.createdAtUtc, provenance: 'client_seed', mergeKey: 'list', receivedAtUtc: value.createdAtUtc });
    const memory = await retrieveMemory(frozen([value]), opts('Recall our wool comparison'));
    const answer = groundedRecallAnswer('You chose silk.', memory);
    expect(answer).toContain('Cotton, flax, hemp, jute, wool.'); expect(answer).toContain('assistant answered (unverified)');
    expect(answer).not.toContain('silk');
  });
  it('broad history questions return bounded evidence and disclose omitted matches', async () => {
    const memory = await retrieveMemory(frozen(archive), opts('What did we discuss?'));
    expect(memory.status).toBe('limited'); expect(memory.records).toHaveLength(8);
    const response = await runAgent({ message: 'What did we discuss?' }, { memory, signal: new AbortController().signal,
      provider: { contextWindowTokens: 65536, complete: async () => ({ text: '{}', finishReason: 'stop', toolCalls: [] }) } });
    expect(response.answer).toContain('Partial memory coverage'); expect(response.answer).toContain('> ');
  });
  it('same-conversation continuity includes originals without relying on supplied HTTP history', async () => {
    const a = history(10, ['Use linen for the cover.', 'Make it blue.', 'Continue']);
    const memory = await retrieveMemory(frozen([a]), { ...opts('Continue'), activeConversationId: a.id, currentTurnId: a.turns[2].id });
    expect(memory.records.map((r) => r.user.content)).toEqual(['Use linen for the cover.', 'Make it blue.']);
  });
  it('same evidence yields the same ranking despite changed file/list order', async () => {
    const one = await retrieveMemory(frozen(archive), opts('Recall our migration decision'));
    const two = await retrieveMemory(frozen([...archive].reverse()), opts('Recall our migration decision'));
    expect(two).toEqual(one); expect(one.status).toBe('ambiguous');
  });
  it('does not mistake working on a named project for an unsupported date', async () => {
    const memory = await retrieveMemory(frozen([history(10, ['I was working on Atlas.'])]), opts('What was I working on Atlas?'));
    expect(memory.status).toBe('found'); expect(memory.temporal).toBeUndefined();
  });
});

describe('calendar ranges and evidence grounding', () => {
  it.each([
    ['last month','2026-01-02T12:00:00Z','2025-12-01','2026-01-01'],
    ['last month','2024-03-15T12:00:00Z','2024-02-01','2024-03-01'],
    ['last year','2026-11-17T12:00:00Z','2025-01-01','2026-01-01'],
    ['next month','2026-12-01T12:00:00Z','2027-01-01','2027-02-01'],
    ['next week','2026-11-17T12:00:00Z','2026-11-23','2026-11-30'],
  ])('%s from %s', (expression, instant, start, end) => {
    expect(createTemporalResolver({ referenceInstant: instant, timezone: 'Asia/Kolkata' }).resolve(expression, 'conversation'))
      .toMatchObject({ status: 'resolved', localStart: start, localEndExclusive: end });
  });
  it('uses local sent dates and resolves relative event dates from original message time', async () => {
    const memory = await retrieveMemory(frozen(archive), { ...opts('What did we discuss yesterday?'), timezone: 'Asia/Kolkata' });
    expect(memory.status).toBe('not_found'); // The UTC-yesterday message was sent today locally.
    const seminar = await retrieveMemory(frozen(archive), opts('Recall our seminar'));
    const data = JSON.parse(prepareAgentContext(seminar, 'Recall', 65536, 2048).messages[1].content).untrustedHistoricalData;
    expect(data.records[1].originalTimeReferences[0].mentions[0].result).toMatchObject({ localStart: '2026-12-01', scope: 'external_event' });
  });
  it.each(['You chose silk.', '{bad json', '{"memoryEvidence":[{"messageId":"fake","quote":"silk"}]}'])('rejects unsupported model output: %s', async (text) => {
    const memory = await retrieveMemory(frozen([history(10, ['My favorite fabric is linen.'])]), opts('What is my favorite fabric?'));
    const answer = groundedRecallAnswer(text, memory);
    expect(answer).toContain('> My favorite fabric is linen.'); expect(answer).not.toContain('silk');
  });
  it('validates sentence boundaries and retains later corrections despite model omission', async () => {
    const value = history(10, ['My budget is 40. It is not 50.', 'Actually, my budget is 60.']);
    const memory = await retrieveMemory(frozen([value]), opts('What is my budget?'));
    const answer = groundedRecallAnswer(JSON.stringify({ memoryEvidence: [{ messageId: value.turns[0].user.id, quote: '50.' }] }), memory);
    expect(answer).toContain('> My budget is 40. It is not 50.'); expect(answer).toContain('> Actually, my budget is 60.');
  });
  it('accepts an exact complete sentence and keeps source identity authoritative', async () => {
    const value = history(10, ['My favorite fabric is linen. I also own a loom.']);
    const memory = await retrieveMemory(frozen([value]), opts('What is my favorite fabric?'));
    const answer = groundedRecallAnswer(JSON.stringify({ memoryEvidence: [{ messageId: value.turns[0].user.id, quote: 'My favorite fabric is linen.' }] }), memory);
    expect(answer).toContain(value.turns[0].user.id); expect(answer).not.toContain('loom');
  });
  it('does not let excerpt selection hide a correction inside the same message', async () => {
    const value = history(10, ['My budget is 40. Actually, my budget is 60.']);
    const memory = await retrieveMemory(frozen([value]), opts('What is my budget?'));
    const answer = groundedRecallAnswer(JSON.stringify({ memoryEvidence: [{ messageId: value.turns[0].user.id, quote: 'My budget is 40.' }] }), memory);
    expect(answer).toContain('Actually, my budget is 60.');
  });
  it('does not resolve an unspecified event year from its sent year', async () => {
    const value = history(10, ['My appointment is on 23 August.']);
    const memory = await retrieveMemory(frozen([value]), opts('When is my appointment?'));
    const data = JSON.parse(prepareAgentContext(memory, 'Recall', 65536, 2048).messages[1].content).untrustedHistoricalData;
    expect(data.records[0].originalTimeReferences[0].mentions).toEqual([]);
  });
  it.each([
    ['What did we discuss?', true, true], ['What is the latest pricing?', false, false],
    ['Has the pricing changed since our last discussion?', true, false], ['Explain recursion', false, false],
  ])('routes %s', (query, recall, memoryOnly) => expect(recallIntent(query)).toEqual({ recall, memoryOnly }));
});

describe('persistence, failures and supported identity boundary', () => {
  it('snapshot waits for queued writes, supports concurrent persistence and survives restart', async () => {
    let db = await disk(); const c = await db.create('UTC');
    const writes = Array.from({length: 12}, (_, i) => db.addTurn(c.id, { key: `k${i}`, content: `Project item ${i}` }));
    const snapshot = db.snapshot(); await Promise.all(writes);
    expect((await snapshot)[0].turns).toHaveLength(12);
    await db.close(); db = await ConversationStore.open({ directory: db.directory }); stores.push(db);
    expect((await db.snapshot())[0].turns.map((t) => t.ordinal)).toEqual(Array.from({length:12}, (_,i) => i));
  });
  it('loads beyond the 100-message API limit and retrieves an old anchor', async () => {
    const db = await disk(); const c = await db.create('UTC');
    const seeds = Array.from({length:150}, (_, i) => ({ role: 'user', id: `seed${i}`, content: i === 0 ? 'My project uses a brass astrolabe.' : `Unrelated entry ${i}`,
      timestamp: '2026-11-03T10:00:00.000Z' }));
    await db.seed(c.id, seeds.slice(0,100)); await db.seed(c.id, seeds.slice(100));
    const memory = await retrieveMemory(db, opts('Recall my astrolabe project'));
    expect(memory.records).toHaveLength(1); expect(memory.records[0].user.content).toContain('brass astrolabe');
  });
  it('never crosses separate private user roots, even if given another root conversation ID', async () => {
    const alice = await disk(); const bob = await disk(); const c = await alice.create();
    await alice.addTurn(c.id, {key:'private',content:'My private project is the brass astrolabe.'});
    expect(await bob.load(c.id)).toBeUndefined();
    const memory = await retrieveMemory(bob, { ...opts('Recall my astrolabe project'), activeConversationId: c.id });
    expect(memory.status).toBe('not_found');
  });
  it('throws on corrupt storage and storage search failure, never returning not_found', async () => {
    const db = await disk(); const c = await db.create(); await db.addTurn(c.id, {key:'a', content:'A record'});
    const [file] = await fs.readdir(db.directory); await fs.writeFile(join(db.directory,file), '{broken');
    await expect(retrieveMemory(db, opts('What did we discuss?'))).rejects.toThrow();
    const broken = { ...frozen([]), snapshot: async () => { throw new Error('Storage unavailable'); } };
    await expect(retrieveMemory(broken, opts('Recall'))).rejects.toThrow('Storage unavailable');
  });
  it('restart + new HTTP conversation uses disk evidence, guards forged user IDs and origin', async () => {
    const db = await disk(); const c = await db.create('UTC');
    await db.addTurn(c.id, { key:'original', content:'My favorite fabric is linen.' }); await db.close();
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const record = JSON.parse(body.messages[1].content).untrustedHistoricalData.records[0];
      expect(record.conversationId).toBe(c.id); expect(body.tools).toBeUndefined();
      return json(wire(JSON.stringify({ memoryEvidence: [{ messageId:record.user.id, quote:record.user.content }] })));
    });
    const app = buildServer({memoryDirectory:db.directory, config:loadConfig(azureEnv), logger:false, fetchImpl:network});
    try {
      const start = performance.now();
      const response = await app.inject({method:'POST',url:'/api/chat',payload:{message:'What is my favorite fabric?',timezone:'UTC'}});
      const stream = await readChatStream(new Response(response.body)); integrationTimes.push(performance.now()-start);
      expect(stream.result?.message.content).toContain('Your favorite fabric is linen.');
      expect(stream.result?.message.content).toContain(c.turns?.[0]?.user?.id ?? 'Stored message');
      expect(response.headers['x-conversation-id']).not.toBe(c.id); expect(network).toHaveBeenCalledTimes(1);
      const restored = (await app.inject(`/api/conversations/${response.headers['x-conversation-id']}`)).json();
      expect(restored.turns[0].attempts[0].status).toBe('awaiting_receipt');
      expect((await app.inject({method:'POST',url:'/api/chat',payload:{message:'Recall',userId:'alice'}})).statusCode).toBe(400);
      expect((await app.inject({url:`/api/conversations/${c.id}`,headers:{origin:'https://other.example'}})).statusCode).toBe(403);
      expect((await app.inject({url:`/api/conversations/${c.id}`,remoteAddress:'192.0.2.10'})).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
