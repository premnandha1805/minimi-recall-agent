import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent.js';
import { retrieveMemory } from '../src/context.js';
import { ConversationSchema, type Conversation } from '../src/memory.js';
import { SourceMetadataSchema } from '../src/contracts.js';
import type { Source, SearchDocument } from '../src/search.js';
import { result as fixtureResult } from './fixtures/chat-stream.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function makeConvo(n: number, userContent: string, timestamp: string, assistantAnswer?: string, evidence?: Source[]): Conversation {
  const sources = (evidence ?? []).map((e) => {
    const { text: _text, ...meta } = e;
    return SourceMetadataSchema.parse(meta);
  });
  return ConversationSchema.parse({
    schemaVersion: 'recall.memory.v1', id: id(n), revision: 1,
    createdAtUtc: timestamp, updatedAtUtc: timestamp, timezone: 'UTC', seededMessages: [],
    turns: [{
      id: id(n + 1), key: `k${n}`, ordinal: 0, provenance: 'server_recorded',
      user: { id: id(n + 2), role: 'user', content: userContent, timestamp },
      attempts: [{
        id: id(n + 3), key: `a${n}`, startedAtUtc: timestamp, finishedAtUtc: timestamp,
        status: 'accepted',
        answer: {
          result: {
            ...fixtureResult,
            message: { ...fixtureResult.message, id: id(n + 4), content: assistantAnswer ?? 'Recorded.', timestamp },
            sources,
          },
          evidence: evidence ?? [],
        },
      }],
    }],
  });
}

function makeMultiTurnConvo(n: number, turns: Array<{ user: string; assistant?: string; timestamp: string }>): Conversation {
  const baseTime = turns[0].timestamp;
  return ConversationSchema.parse({
    schemaVersion: 'recall.memory.v1', id: id(n), revision: 1,
    createdAtUtc: baseTime, updatedAtUtc: baseTime, timezone: 'UTC', seededMessages: [],
    turns: turns.map((t, idx) => ({
      id: id(n * 100 + idx * 10 + 1), key: `k${idx}`, ordinal: idx, provenance: 'server_recorded',
      user: { id: id(n * 100 + idx * 10 + 2), role: 'user', content: t.user, timestamp: t.timestamp },
      attempts: [{
        id: id(n * 100 + idx * 10 + 3), key: `a${idx}`, startedAtUtc: t.timestamp, finishedAtUtc: t.timestamp,
        status: 'accepted',
        answer: {
          result: {
            ...fixtureResult,
            message: { ...fixtureResult.message, id: id(n * 100 + idx * 10 + 4), content: t.assistant ?? 'Recorded.', timestamp: t.timestamp },
            sources: [],
          },
          evidence: [],
        },
      }],
    })),
  });
}

function makeStore(convos: Conversation[]) {
  return {
    list: vi.fn(async ({ offset = 0, limit = 50 } = {}) => ({
      total: convos.length,
      items: convos.slice(offset, offset + limit).map((c) => ({
        id: c.id, createdAtUtc: c.createdAtUtc, updatedAtUtc: c.updatedAtUtc, turnCount: c.turns.length,
      })),
    })),
    load: vi.fn(async (cid: string) => convos.find((c) => c.id === cid)),
  };
}

const opts = (query: string, referenceInstant = '2026-11-16T12:00:00.000Z', timezone = 'UTC') => ({
  query, activeConversationId: id(9999), currentTurnId: id(9998), referenceInstant, timezone,
  signal: new AbortController().signal, startedAt: performance.now(), deadlineMs: 25_000,
});

describe('Adversarial Capability Evaluation for Minimi Hiring Challenge', () => {
  // Scenario 1: Cross-conversation recall with paraphrased follow-up questions
  it('Scenario 1: cross-conversation recall with paraphrased question', async () => {
    const convoA = makeConvo(10, 'We selected ClickHouse for telemetry analytics after comparing alternatives.', '2026-11-10T10:00:00.000Z');
    const store = makeStore([convoA]);

    // Paraphrased follow-up asking about the previous discussion topic
    const query = 'Which telemetry analytics did we discuss earlier?';
    const memory = await retrieveMemory(store, opts(query));

    expect(memory.recall).toBe(true);
    expect(memory.memoryOnly).toBe(true);
    expect(memory.status).toBe('found');
    expect(memory.records[0].user.content).toContain('ClickHouse');

    const searchMock = vi.fn();
    const agentRes = await runAgent({ message: query }, {
      memory, search: searchMock, signal: new AbortController().signal,
      provider: {
        contextWindowTokens: 65536,
        complete: async () => ({
          text: 'You previously selected ClickHouse for telemetry analytics.',
          finishReason: 'stop', toolCalls: [],
        }),
      },
    });

    expect(agentRes.status).toBe('completed');
    expect(agentRes.stats.modelCalls).toBe(1);
    expect(searchMock).not.toHaveBeenCalled();
    expect(agentRes.answer).toContain('ClickHouse');
  });

  // Scenario 2: Relative-date historical retrieval and correct discussion selection
  it('Scenario 2: relative-date historical retrieval selects correct past discussion', async () => {
    // Discussion 1: Wednesday 2026-11-11
    const convoWed = makeConvo(20, 'Let us evaluate Redis caching options including Dragonfly and Upstash.', '2026-11-11T14:00:00.000Z');
    // Discussion 2: Friday 2026-11-13
    const convoFri = makeConvo(25, 'What are our Kafka event streaming options?', '2026-11-13T14:00:00.000Z');
    const store = makeStore([convoWed, convoFri]);

    // Reference instant: Monday 2026-11-16 in Europe/London
    const query = 'What did we discuss last Wednesday?';
    const memory = await retrieveMemory(store, opts(query, '2026-11-16T12:00:00.000Z', 'Europe/London'));

    expect(memory.recall).toBe(true);
    expect(memory.memoryOnly).toBe(true);
    expect(memory.status).toBe('found');
    expect(memory.records).toHaveLength(1);
    expect(memory.records[0].user.content).toContain('Redis caching');
    expect(memory.records[0].user.content).not.toContain('Kafka');

    const searchMock = vi.fn();
    const agentRes = await runAgent({ message: query }, {
      memory, search: searchMock, signal: new AbortController().signal,
      provider: {
        contextWindowTokens: 65536,
        complete: async () => ({
          text: 'Last Wednesday, you discussed Redis caching options, specifically Dragonfly and Upstash.',
          finishReason: 'stop', toolCalls: [],
        }),
      },
    });

    expect(agentRes.stats.modelCalls).toBe(1);
    expect(searchMock).not.toHaveBeenCalled();
    expect(agentRes.answer).toContain('Redis');
    expect(agentRes.answer).not.toContain('Kafka');
  });

  // Scenario 3: CRM shortlist retrieval followed by fresh pricing research
  it('Scenario 3: CRM shortlist retrieval followed by fresh pricing research', async () => {
    const convo = makeConvo(30, 'On Monday we shortlisted five CRM tools: Attio, Folk, Capsule, Insightly, Copper.', '2026-11-09T10:00:00.000Z');
    const store = makeStore([convo]);

    const query = 'Which five CRM tools did we shortlist last Monday? What is Attio current entry price?';
    const memory = await retrieveMemory(store, opts(query, '2026-11-16T12:00:00.000Z', 'UTC'));

    expect(memory.recall).toBe(true);
    expect(memory.memoryOnly).toBe(false); // Mixed query requires web research
    expect(memory.status).toBe('found');

    const mockDoc: SearchDocument = {
      title: 'Attio Pricing Plans',
      url: 'https://attio.com/pricing',
      retrieved_at: '2026-11-16T12:00:00.000Z',
      text: 'Attio Starter plan costs USD 29 per user per month as of November 2026.',
    };

    let step = 0;
    const agentRes = await runAgent({ message: query }, {
      memory, signal: new AbortController().signal,
      search: async () => [mockDoc],
      provider: {
        contextWindowTokens: 65536,
        complete: async () => {
          step++;
          if (step === 1) {
            return {
              text: '', finishReason: 'tool_calls',
              toolCalls: [{ id: 'call_1', name: 'web_search', arguments: JSON.stringify({ queries: ['Attio current pricing'] }) }],
            };
          }
          return {
            text: 'You previously shortlisted Attio, Folk, Capsule, Insightly, and Copper. Fresh research shows Attio Starter is USD 29 per user per month [S1].',
            finishReason: 'stop', toolCalls: [],
          };
        },
      },
    });

    expect(agentRes.stats.modelCalls).toBe(2);
    expect(agentRes.stats.searchRequests).toBe(1);
    expect(agentRes.sources).toHaveLength(1);
    expect(agentRes.answer).toContain('Attio, Folk, Capsule, Insightly, and Copper');
    expect(agentRes.answer).toContain('[S1]');
  });

  // Scenario 4: PostgreSQL hosting comparison across old and new evidence
  it('Scenario 4: PostgreSQL hosting comparison across old and new evidence', async () => {
    const historicalEvidence: Source = {
      id: 'S1', query: 'Supabase pricing baseline', title: 'Supabase Pricing', url: 'https://supabase.com/pricing',
      text: 'Product: Supabase; Plan: Pro; Region: US; Currency: USD; Price: 25; Billing: monthly; Seats: 1; Basis: total; Conditions: standard; Effective: 2026-10-25.',
      retrieved_at: '2026-10-25T10:00:00.000Z',
    };
    const convo = makeConvo(40, 'Supabase Postgres pricing recommendation', '2026-10-25T10:00:00.000Z', 'Supabase Pro costs $25 per month [S1].', [historicalEvidence]);
    const store = makeStore([convo]);

    const query = 'On 25 October I asked about Supabase Postgres pricing. Has any pricing changed since then?';
    const memory = await retrieveMemory(store, opts(query, '2026-11-16T12:00:00.000Z', 'UTC'));

    expect(memory.recall).toBe(true);
    expect(memory.memoryOnly).toBe(false);
    expect(memory.status).toBe('found');

    const currentDoc: SearchDocument = {
      title: 'Supabase Current Pricing',
      url: 'https://supabase.com/pricing',
      retrieved_at: '2026-11-16T12:00:00.000Z',
      text: 'Product: Supabase; Plan: Pro; Region: US; Currency: USD; Price: 35; Billing: monthly; Seats: 1; Basis: total; Conditions: standard; Effective: 2026-11-16.',
    };

    let step = 0;
    const agentRes = await runAgent({ message: query }, {
      memory, signal: new AbortController().signal,
      search: async () => [currentDoc],
      provider: {
        contextWindowTokens: 65536,
        complete: async () => {
          step++;
          if (step === 1) {
            return {
              text: '', finishReason: 'tool_calls',
              toolCalls: [{ id: 'call_pg', name: 'web_search', arguments: JSON.stringify({ queries: ['Supabase pricing current'] }) }],
            };
          }
          // COMPARISON_INSTRUCTIONS format
          return {
            text: JSON.stringify({
              comparisons: [{
                kind: 'price',
                product: 'supabase',
                historical: {
                  conversationId: id(40),
                  turnId: id(41),
                  sourceId: 'S1',
                  quote: 'Product: Supabase; Plan: Pro; Region: US; Currency: USD; Price: 25; Billing: monthly; Seats: 1; Basis: total; Conditions: standard; Effective: 2026-10-25.',
                },
                current: {
                  sourceId: 'S1',
                  quote: 'Product: Supabase; Plan: Pro; Region: US; Currency: USD; Price: 35; Billing: monthly; Seats: 1; Basis: total; Conditions: standard; Effective: 2026-11-16.',
                },
              }],
            }),
            finishReason: 'stop', toolCalls: [],
          };
        },
      },
    });

    expect(agentRes.status).toBe('completed');
    expect(agentRes.answer).toContain('Confirmed change — supabase');
    expect(agentRes.answer).toContain('[S1]');
  });

  // Scenario 5: No false personal facts from hypotheticals or previous questions
  it('Scenario 5: rejects hypotheticals, questions, and third-party events as personal facts', async () => {
    const convo = makeMultiTurnConvo(50, [
      { user: 'Imagine I have a flight to Tokyo on 12 December.', timestamp: '2026-11-01T10:00:00.000Z' },
      { user: 'Should I attend the AWS Summit on 15 December?', timestamp: '2026-11-01T11:00:00.000Z' },
      { user: 'My brother has a flight to Berlin on 18 December.', timestamp: '2026-11-01T12:00:00.000Z' },
    ]);
    const store = makeStore([convo]);

    const query = 'When is my flight?';
    const memory = await retrieveMemory(store, opts(query));

    expect(memory.recall).toBe(true);
    expect(memory.memoryOnly).toBe(true);
    expect(memory.status).toBe('not_found'); // Fail-closed assertion gate

    const searchMock = vi.fn();
    const agentRes = await runAgent({ message: query }, {
      memory, search: searchMock, signal: new AbortController().signal,
      provider: { contextWindowTokens: 65536, complete: vi.fn() },
    });

    expect(searchMock).not.toHaveBeenCalled();
    expect(agentRes.stats.modelCalls).toBe(0);
    expect(agentRes.answer).toContain('I did not find a suitable record in the stored conversations.');
  });

  // Scenario 6: Rescheduled meetings, cancellations and competing events
  it('Scenario 6: chronological ordering of corrections and cancellations', async () => {
    const convo = makeMultiTurnConvo(60, [
      { user: 'I have a design review with Figma on 14 September.', timestamp: '2026-08-01T10:00:00.000Z' },
      { user: 'Actually, make that 18 September.', timestamp: '2026-08-01T11:00:00.000Z' },
      { user: 'The Figma design review was cancelled.', timestamp: '2026-08-01T12:00:00.000Z' },
    ]);
    const store = makeStore([convo]);

    const query = 'When is my Figma design review?';
    const memory = await retrieveMemory(store, opts(query));

    expect(memory.status).toBe('found');
    expect(memory.records.length).toBeGreaterThanOrEqual(2);

    const agentRes = await runAgent({ message: query }, {
      memory, search: vi.fn(), signal: new AbortController().signal,
      provider: {
        contextWindowTokens: 65536,
        complete: async () => ({
          text: 'Your Figma design review was initially set for 14 September, rescheduled to 18 September, and subsequently cancelled.',
          finishReason: 'stop', toolCalls: [],
        }),
      },
    });

    expect(agentRes.answer).toContain('18 September');
    expect(agentRes.answer).not.toMatch(/September 202[67]/); // Sent dates are not event years.
  });

  // Scenario 7: Conflicting web evidence and unsupported quotations
  it('Scenario 7: rejects unsupported quotations and preserves quotation integrity', async () => {
    const currentDoc: SearchDocument = {
      title: 'Grafana Pricing', url: 'https://grafana.com/pricing',
      text: 'Grafana Cloud Pro starts at $19 per month for active users.',
      retrieved_at: '2026-11-16T12:00:00.000Z',
    };

    let step = 0;
    const agentRes = await runAgent({ message: 'What is the current Grafana price?' }, {
      signal: new AbortController().signal,
      search: async () => [currentDoc],
      provider: {
        contextWindowTokens: 65536,
        complete: async () => {
          step++;
          if (step === 1) {
            return {
              text: '', finishReason: 'tool_calls',
              toolCalls: [{ id: 'call_g', name: 'web_search', arguments: JSON.stringify({ queries: ['Grafana pricing'] }) }],
            };
          }
          // Deliberately hallucinate a non-matching quote:
          return {
            text: 'Grafana Cloud Pro costs “$99 per month for enterprise users” [S1].',
            finishReason: 'stop', toolCalls: [],
          };
        },
      },
    });

    // checkSourceQuotations catches the mismatched quote:
    expect(agentRes.answer).toContain('quotation warning: a cited quotation did not match the exact available source text');
  });

  // Scenario 8: Incomplete or failed Tavily searches
  it('Scenario 8: honest disclosure of incomplete or failed Tavily search', async () => {
    let step = 0;
    const agentRes = await runAgent({ message: 'What is the latest Datadog APM pricing?' }, {
      signal: new AbortController().signal,
      search: async () => {
        throw new Error('Tavily 500 internal server error');
      },
      provider: {
        contextWindowTokens: 65536,
        complete: async () => {
          step++;
          if (step === 1) {
            return {
              text: '', finishReason: 'tool_calls',
              toolCalls: [{ id: 'call_dd', name: 'web_search', arguments: JSON.stringify({ queries: ['Datadog pricing'] }) }],
            };
          }
          return {
            text: 'I could not verify Datadog pricing because live search was unavailable.',
            finishReason: 'stop', toolCalls: [],
          };
        },
      },
    });

    expect(agentRes.status).toBe('partial');
    expect(agentRes.issues).toContain('search_failed');
    expect(agentRes.answer).toContain('search was unavailable');
  });

  // Scenario 9: Long-history context budgeting preserves essential record
  it('Scenario 9: long-history context budgeting preserves essential record', async () => {
    const turns: Array<{ user: string; timestamp: string }> = [
      { user: 'We shortlisted five database proxies: ProxySQL, MaxScale, PgBouncer, Odyssey, HAProxy.', timestamp: '2026-11-01T10:00:00.000Z' },
    ];
    for (let i = 1; i <= 20; i++) {
      turns.push({
        user: `Detailed discussion ${i} on network topologies: ${'packet routing '.repeat(100)}`,
        timestamp: `2026-11-01T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }

    const convo = makeMultiTurnConvo(90, turns);
    const store = makeStore([convo]);

    const query = 'Which five database proxies did we shortlist?';
    const memory = await retrieveMemory(store, opts(query));

    expect(memory.recall).toBe(true);
    expect(memory.status).toBe('found');
    expect(memory.records[0].user.content).toContain('database proxies');

    const agentRes = await runAgent({ message: query }, {
      memory, search: vi.fn(), signal: new AbortController().signal,
      provider: {
        contextWindowTokens: 8192,
        complete: async (req) => {
          expect(req.messages[1].content).toContain('ProxySQL');
          return {
            text: 'You shortlisted five database proxies: ProxySQL, MaxScale, PgBouncer, Odyssey, and HAProxy.',
            finishReason: 'stop', toolCalls: [],
          };
        },
      },
    });

    expect(agentRes.status).toBe('completed');
    expect(agentRes.answer).toContain('PgBouncer');
  });

  // Scenario 10: Natural multi-turn follow-ups missing explicit topic names
  it('Scenario 10: natural multi-turn follow-ups missing explicit topic names', async () => {
    const convo = makeMultiTurnConvo(100, [
      { user: 'Let us evaluate Elasticsearch vs OpenSearch for our log cluster.', timestamp: '2026-11-05T10:00:00.000Z' },
      { user: 'Which one has better cold-tier pricing?', timestamp: '2026-11-05T10:05:00.000Z' },
      { user: 'We decided to proceed with OpenSearch due to licensing.', timestamp: '2026-11-05T10:10:00.000Z' },
    ]);
    const store = makeStore([convo]);

    const query = 'What did we decide about our log cluster?';
    const memory = await retrieveMemory(store, opts(query));

    expect(memory.status).toBe('found');
    expect(memory.memoryOnly).toBe(true);

    const agentRes = await runAgent({ message: query }, {
      memory, search: vi.fn(), signal: new AbortController().signal,
      provider: {
        contextWindowTokens: 65536,
        complete: async () => ({
          text: 'You decided to proceed with OpenSearch for your log cluster due to licensing.',
          finishReason: 'stop', toolCalls: [],
        }),
      },
    });

    expect(agentRes.stats.modelCalls).toBe(1);
    expect(agentRes.answer).toContain('OpenSearch');
    expect(agentRes.answer).toContain('licensing');
  });
});
