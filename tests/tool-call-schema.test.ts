import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SearchArgumentsSchema, WEB_SEARCH_TOOL, type SearchDocument } from '../src/search.js';
import { runAgent } from '../src/agent.js';
import type { ModelProvider } from '../src/model.js';
import type { RetrievedMemory } from '../src/context.js';
import type { Source } from '../src/search.js';
import { createStreamingModelProvider } from '../src/streaming-model.js';
import { loadConfig } from '../src/config.js';
import { ChatResultSchema } from '../src/contracts.js';
import { azureEnv } from './fixtures/chat-stream.js';

describe('Phase 5 — Web Search Tool Schema & Runtime Validation Regressions', () => {
  // 1. Valid normal web_search arguments
  it('1. accepts valid normal web_search arguments with queries array', () => {
    const parsed = SearchArgumentsSchema.safeParse({ queries: ['neon pricing'] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.queries).toEqual(['neon pricing']);
    }
  });

  // 2. Valid multiple-query tool calls
  it('2. accepts valid multiple-query tool calls up to the limit of 8', () => {
    const queries = ['neon pricing', 'supabase pricing', 'render pricing'];
    const parsed = SearchArgumentsSchema.safeParse({ queries });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.queries).toEqual(queries);
    }
  });

  // 3. Model/tool schema compatibility
  it('3. exposes compatible tool schema with description and bounded properties', async () => {
    expect(WEB_SEARCH_TOOL.name).toBe('web_search');
    expect(WEB_SEARCH_TOOL.parameters.type).toBe('object');
    const props = WEB_SEARCH_TOOL.parameters.properties as Record<string, { type: string; description?: string }>;
    expect(props.queries.type).toBe('array');
    expect(props.queries.description).toBeDefined();
    expect(props.query.type).toBe('string');
    expect(props.query.description).toBeDefined();

    // Verify streaming model provider generates tool array matching this schema
    let capturedBody: { tools?: Array<{ type: string; function: { name: string } }> } | undefined;
    const mockNetwork = vi.fn<typeof fetch>(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = createStreamingModelProvider(loadConfig(azureEnv), mockNetwork);
    await provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [WEB_SEARCH_TOOL],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    }).catch(() => {});

    expect(capturedBody?.tools).toBeDefined();
    expect(capturedBody?.tools?.[0].function.name).toBe('web_search');
  });

  // 4. Exact reproduced failing argument shape from live Scenario B
  it('4. accepts the exact reproduced failing argument shapes (singular query, string queries, bare string)', () => {
    // A: Singular { query: "Neon pricing" }
    const resA = SearchArgumentsSchema.safeParse({ query: 'Neon pricing' });
    expect(resA.success).toBe(true);
    if (resA.success) expect(resA.data.queries).toEqual(['Neon pricing']);

    // B: Coerced string { queries: "Neon pricing" }
    const resB = SearchArgumentsSchema.safeParse({ queries: 'Neon pricing' });
    expect(resB.success).toBe(true);
    if (resB.success) expect(resB.data.queries).toEqual(['Neon pricing']);

    // C: Bare string "Neon pricing"
    const resC = SearchArgumentsSchema.safeParse('Neon pricing');
    expect(resC.success).toBe(true);
    if (resC.success) expect(resC.data.queries).toEqual(['Neon pricing']);

    // D: Both queries and query supplied
    const resD = SearchArgumentsSchema.safeParse({ queries: ['Neon pricing'], query: 'Neon pricing' });
    expect(resD.success).toBe(true);
    if (resD.success) expect(resD.data.queries).toEqual(['Neon pricing']);
  });

  // 5. Missing required fields
  it('5. rejects empty objects and empty query lists', () => {
    expect(SearchArgumentsSchema.safeParse({}).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ queries: [] }).success).toBe(false);
  });

  // 6. Malformed JSON or wrong JSON types
  it('6. rejects malformed types, non-string items, and arbitrary unrecognized keys', () => {
    expect(SearchArgumentsSchema.safeParse({ queries: [123] }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ queries: [{ nested: 'query' }] }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ query: 123 }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ queries: ['neon'], unexpected_key: true }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse(null).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse(12345).success).toBe(false);
  });

  // 7. Too many requested queries (>8)
  it('7. rejects tool arguments requesting more than 8 search queries', () => {
    const nineQueries = Array.from({ length: 9 }, (_, i) => `query ${i + 1}`);
    expect(SearchArgumentsSchema.safeParse({ queries: nineQueries }).success).toBe(false);
  });

  // 8. Empty search query
  it('8. rejects empty and whitespace-only search query strings', () => {
    expect(SearchArgumentsSchema.safeParse({ queries: [''] }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ queries: ['   '] }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(SearchArgumentsSchema.safeParse({ query: '   ' }).success).toBe(false);
  });

  // 9. Private query rejected before network dispatch
  it('9. strips private-clause context before dispatching search queries', async () => {
    const searchMock = vi.fn(async (_query: string) => [] as Source[]);
    let step = 0;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => {
        step++;
        if (step === 1) {
          return {
            text: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_1',
                name: 'web_search',
                // Model attempts to search for a private phone/email
                arguments: JSON.stringify({ queries: ['my secret password secret123 official'] }),
              },
            ],
          };
        }
        return { text: 'No results found.', finishReason: 'stop', toolCalls: [] };
      },
    };

    await runAgent(
      { message: 'What did I tell you in my private meeting about secret123?' },
      {
        provider,
        search: searchMock,
        signal: new AbortController().signal,
      }
    );

    // Private terms were filtered: secret123 should never be in any dispatched query
    for (const call of searchMock.mock.calls) {
      expect(call[0]).not.toContain('secret123');
    }
  });

  // 10. Provider-generated invalid tool call
  it('10. safely records tool diagnostics when provider generates unsupported tool or malformed JSON', async () => {
    let capturedObservation: Record<string, unknown> | undefined;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => ({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_bad',
            name: 'unsupported_calculator',
            arguments: '{"expr":"2+2"}',
          },
        ],
      }),
    };

    const res = await runAgent(
      { message: 'Calculate 2+2' },
      {
        provider,
        signal: new AbortController().signal,
        observe: (ev) => {
          if (ev.stage === 'agent') capturedObservation = ev as unknown as Record<string, unknown>;
        },
      }
    );

    expect(res.status).toBe('failed');
    expect(res.reason).toBe('unsupported_tool');
    expect(capturedObservation?.validationCategory).toBe('unsupported_tool');
    const diag = capturedObservation?.toolDiagnostic as { toolName?: string } | undefined;
    expect(diag?.toolName).toBe('unsupported');
  });

  // 11. Correct SSE handling on validation failure for standard search
  it('11. returns failed status without streaming unvalidated tokens when search tool arguments are invalid', async () => {
    const textDeltas: string[] = [];
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => ({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_invalid_args',
            name: 'web_search',
            arguments: '{"invalid_field": 123}',
          },
        ],
      }),
    };

    const res = await runAgent(
      { message: 'What is the population of Tokyo?' },
      {
        provider,
        onText: (t) => { textDeltas.push(t); },
        signal: new AbortController().signal,
      }
    );

    expect(res.status).toBe('failed');
    expect(res.reason).toBe('invalid_tool_call');
    expect(textDeltas).toHaveLength(0); // Raw tokens never stream on failure
  });

  // 12. Mixed recall preserved when search fails
  it('12. preserves historical recall Q&A and returns honest verification notice when search fails', async () => {
    const memory: RetrievedMemory = {
      reference: { instant: '2026-11-19T12:00:00.000Z', timezone: 'UTC' },
      recall: true,
      memoryOnly: false,
      status: 'found',
      matches: 1,
      records: [
        {
          conversationId: 'conv-1103',
          turnId: 'turn-1103',
          ordinal: 0,
          provenance: 'server_recorded',
          user: {
            id: 'msg-u1',
            role: 'user',
            content: 'What is the standard pricing plan for Neon?',
            timestamp: '2026-11-03T10:00:00.000Z',
          },
          assistant: {
            id: 'msg-a1',
            content: "Neon's Launch plan costs USD 20 per seat per month in the US, standard terms, effective 2026-11-01.",
            timestamp: '2026-11-03T10:01:00.000Z',
          },
          evidence: [],
        },
      ],
    };

    const streamedDeltas: string[] = [];
    let callStep = 0;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => {
        callStep++;
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'call_malformed',
              name: 'web_search',
              // Completely malformed arguments
              arguments: '{"invalid": true}',
            },
          ],
        };
      },
    };

    const query = 'What did I ask on 3 November? Is your answer still correct today?';
    const res = await runAgent(
      { message: query },
      {
        memory,
        provider,
        onText: (t) => { streamedDeltas.push(t); },
        signal: new AbortController().signal,
      }
    );

    expect(res.status).toBe('partial');
    expect(res.reason).toBe('answer');
    expect(res.answer).toBeDefined();
    expect(res.generationOrigin).toBe('recovered');
    expect(res.stats.modelCalls).toBe(1);
    expect(res.issues).toContain('search_unavailable');

    // Verification of Phase 4 & 5 requirements:
    // 1. Preserves historical question and recorded response
    expect(res.answer).toContain('On November 3, 2026, you asked: "What is the standard pricing plan for Neon?"');
    expect(res.answer).toContain('Recorded response: "Neon\'s Launch plan costs USD 20 per seat per month in the US, standard terms, effective 2026-11-01."');
    // 2. Contains historical note caveat
    expect(res.answer).toContain('Past assistant responses reflect historical conversation records, not independently certified current facts.');
    // 3. Explicitly states current verification failed
    expect(res.answer).toContain('Cannot verify: Current verification could not be completed; web search verification was unavailable or returned an invalid request.');
    // 4. Never asserts confirmed change
    expect(res.answer).not.toContain('Confirmed change');
    // 5. Delivered via streamed onText
    expect(streamedDeltas.length).toBeGreaterThan(0);
    expect(streamedDeltas.join('')).toBe(res.answer);

    // 6. Truthful fallback metadata contract
    const serverResult = ChatResultSchema.parse({
      message: { id: randomUUID(), role: 'assistant', content: res.answer, timestamp: new Date().toISOString() },
      coverage: res.status === 'completed' ? 'complete' : 'partial',
      issues: res.issues,
      sources: res.sources.map(({ text: _text, ...metadata }) => metadata),
      evidenceCheck: 'citation_ids_only',
      memory: { earlierConversations: 1, fallback: res.generationOrigin === 'recovered' },
      generation: { origin: res.generationOrigin },
    });
    expect(serverResult.generation?.origin).toBe('recovered');
    expect(serverResult.memory?.fallback).toBe(true);
  });

  // 13. Tool results still require citation validation
  it('13. rejects ungrounded or invented citation IDs even when search succeeds', async () => {
    const validDoc: Source = {
      id: 'S1',
      query: 'neon pricing',
      title: 'Neon Pricing',
      url: 'https://neon.tech/pricing',
      text: 'Product: Neon; Plan: Launch; Region: US; Currency: USD; Price: 20; Billing: monthly; Seats: 1; Basis: per-seat; Conditions: standard; Effective: 2026-11-15.',
      retrieved_at: '2026-11-19T12:00:00.000Z',
    };

    let step = 0;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => {
        step++;
        if (step === 1) {
          return {
            text: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'web_search', arguments: JSON.stringify({ query: 'Neon pricing' }) }],
          };
        }
        // Step 2: Cites invented source [S99] not returned by search
        return {
          text: 'According to Neon pricing [S99], the price is $20.',
          finishReason: 'stop',
          toolCalls: [],
        };
      },
    };

    const res = await runAgent(
      { message: 'What is the current Neon price?' },
      {
        provider,
        search: async () => [validDoc],
        signal: new AbortController().signal,
      }
    );

    expect(res.status).toBe('failed');
    expect(res.reason).toBe('invalid_citation');
  });

  // 14. No extra provider calls after terminal failure
  it('14. stops immediately with zero extra provider calls after terminal tool validation failure', async () => {
    let callCount = 0;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => {
        callCount++;
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'web_search', arguments: 'not json' }],
        };
      },
    };

    await runAgent(
      { message: 'What is the current price?' },
      {
        provider,
        signal: new AbortController().signal,
      }
    );

    // Exactly 1 call was made; no retry or follow-up calls
    expect(callCount).toBe(1);
  });

  // 15. Valid model generation retains origin = model and fallback = false
  it('15. retains origin = model and fallback = false when model successfully synthesizes answer', async () => {
    const memory: RetrievedMemory = {
      reference: { instant: '2026-11-19T12:00:00.000Z', timezone: 'UTC' },
      recall: true,
      memoryOnly: false,
      status: 'found',
      matches: 1,
      records: [
        {
          conversationId: 'conv-1103',
          turnId: 'turn-1103',
          ordinal: 0,
          provenance: 'server_recorded',
          user: {
            id: 'msg-u1',
            role: 'user',
            content: 'What is the standard pricing plan for Neon?',
            timestamp: '2026-11-03T10:00:00.000Z',
          },
          assistant: {
            id: 'msg-a1',
            content: "Neon's Launch plan costs USD 20 per seat per month in the US, standard terms, effective 2026-11-01.",
            timestamp: '2026-11-03T10:01:00.000Z',
          },
          evidence: [],
        },
      ],
    };

    const searchDoc: SearchDocument = {
      title: 'Neon Pricing',
      url: 'https://neon.tech/pricing',
      text: 'Product: Neon; Plan: Launch; Region: US; Currency: USD; Price: 20; Billing: monthly; Seats: 1; Basis: per-seat; Conditions: standard; Effective: 2026-11-15.',
      retrieved_at: '2026-11-19T12:00:00.000Z',
    };

    let step = 0;
    const provider: ModelProvider = {
      contextWindowTokens: 65536,
      complete: async () => {
        step++;
        if (step === 1) {
          return {
            text: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'web_search', arguments: JSON.stringify({ query: 'Neon pricing' }) }],
          };
        }
        return {
          text: 'No confirmed change: Neon pricing remains USD 20 [S1].',
          finishReason: 'stop',
          toolCalls: [],
        };
      },
    };

    const query = 'What did I ask on 3 November? Is your answer still correct today?';
    const res = await runAgent(
      { message: query },
      {
        memory,
        provider,
        search: async () => [searchDoc],
        signal: new AbortController().signal,
      }
    );

    expect(res.status).toBe('completed');
    expect(res.reason).toBe('answer');
    expect(res.generationOrigin).toBe('model');
    expect(res.stats.modelCalls).toBe(2);

    const serverResult = ChatResultSchema.parse({
      message: { id: randomUUID(), role: 'assistant', content: res.answer, timestamp: new Date().toISOString() },
      coverage: res.status === 'completed' ? 'complete' : 'partial',
      issues: res.issues,
      sources: res.sources.map(({ text: _text, ...metadata }) => metadata),
      evidenceCheck: 'citation_ids_only',
      memory: { earlierConversations: 1, fallback: res.generationOrigin === 'recovered' },
      generation: { origin: res.generationOrigin },
    });
    expect(serverResult.generation?.origin).toBe('model');
    expect(serverResult.memory?.fallback).toBe(false);
  });
});
