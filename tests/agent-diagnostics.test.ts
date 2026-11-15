import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runAgent, type AgentStopReason } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import type { StreamErrorCode } from '../src/contracts.js';
import type { ModelProvider, ModelResponse } from '../src/model.js';
import { observeStage, type StageObservation, type ValidationCategory } from '../src/observability.js';
import { buildServer } from '../src/server.js';
import { agentErrorCode } from '../src/sse.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, json } from './fixtures/chat-stream.js';

// Synthetic fixtures only. These sentinels must never reach operational logs.
const answer: ModelResponse = { text: 'PRIVATE_ANSWER', toolCalls: [], finishReason: 'stop',
  usage: { inputTokens: 520, outputTokens: 116, reasoningTokens: 0 } };
const call = { id: 'PRIVATE_ID', name: 'web_search', arguments: '{"queries":["PRIVATE_QUERY"]}' };
const tool = (...calls: ModelResponse['toolCalls']): ModelResponse => ({ ...answer, toolCalls: calls, finishReason: 'tool_calls' });
const cases: { label: string; response: unknown; reason: AgentStopReason; category: ValidationCategory }[] = [
  { label: 'response schema', response: { ...answer, PRIVATE_UNKNOWN_PROPERTY: 'PRIVATE_VALUE' },
    reason: 'invalid_response', category: 'response_schema' },
  { label: 'empty text', response: { ...answer, text: ' \n ' }, reason: 'empty_output', category: 'empty_text' },
  { label: 'tool finish without calls', response: tool(), reason: 'invalid_response', category: 'finish_tool_mismatch' },
  { label: 'stop finish with calls', response: { ...tool(call), finishReason: 'stop' },
    reason: 'invalid_response', category: 'finish_tool_mismatch' },
  { label: 'argument JSON', response: tool({ ...call, arguments: '{PRIVATE_BROKEN' }),
    reason: 'invalid_tool_call', category: 'tool_arguments_json' },
  { label: 'argument schema', response: tool({ ...call, arguments: '{"PRIVATE_UNKNOWN_KEY":"PRIVATE_VALUE"}' }),
    reason: 'invalid_tool_call', category: 'tool_arguments_schema' },
  { label: 'unsupported tool', response: tool({ ...call, name: 'PRIVATE_TOOL' }),
    reason: 'unsupported_tool', category: 'unsupported_tool' },
  { label: 'duplicate IDs in one response', response: tool(call, call),
    reason: 'repeated_tool_call', category: 'repeated_tool_id' },
  { label: 'length finish', response: { ...answer, finishReason: 'length' }, reason: 'output_limit', category: 'output_limit' },
  { label: 'reported token overrun', response: { ...answer, usage: { inputTokens: 520, outputTokens: 2049 } },
    reason: 'output_limit', category: 'output_limit' },
  { label: 'filter', response: { ...answer, finishReason: 'content_filter' }, reason: 'content_filter', category: 'content_filter' },
];

describe('terminal agent rejection diagnostics', () => {
  it.each(cases)('records the actual $label branch without leaking model data', async ({ response, reason, category }) => {
    const events: StageObservation[] = [];
    const complete = vi.fn<ModelProvider['complete']>(async () => response as ModelResponse);
    const search = vi.fn();
    const result = await runAgent({ message: 'PRIVATE_PROMPT', history: [{ role: 'user', content: 'PRIVATE_HISTORY',
      timestamp: '2026-11-14T00:00:00Z' }] }, {
      provider: { contextWindowTokens: 65_536, complete }, signal: new AbortController().signal,
      search, observe: (event) => { events.push(event); },
    });
    expect(result.reason).toBe(reason); expect(result.status).toBe('failed'); expect(result.answer).toBeUndefined();
    expect(result).not.toHaveProperty('validationCategory');
    expect(result.stats).toEqual({ modelCalls: 1, searchRounds: 0, searchRequests: 0, reservedOutputTokens: 2048 });
    expect(events.at(-1)).toMatchObject({ stage: 'agent', outcome: 'failure', stopReason: reason, validationCategory: category });
    expect(events.filter((event) => event.stopReason !== undefined || event.validationCategory !== undefined)).toHaveLength(1);
    const model = events.find((event) => event.stage === 'model_call')!;
    expect(model.outcome).toBe(category === 'response_schema' ? 'failure' : 'success');
    expect(model.usage).toEqual(category === 'response_schema' ?
      { inputTokens: null, completionTokens: null, reasoningTokens: null } :
      { inputTokens: 520, completionTokens: (response as ModelResponse).usage!.outputTokens,
        reasoningTokens: (response as ModelResponse).usage!.reasoningTokens ?? null });
    expect(complete).toHaveBeenCalledTimes(1); expect(search).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  });

  it.each(['answer', 'provider_error', 'invalid_citation', 'invalid_request', 'cancelled'] as const)(
    'omits the validation category for %s instead of guessing from outcome', async (reason) => {
      const events: StageObservation[] = []; const controller = new AbortController();
      if (reason === 'cancelled') controller.abort(new Error('PRIVATE_ABORT'));
      const complete = vi.fn<ModelProvider['complete']>(async () => {
        if (reason === 'provider_error') throw new Error('PRIVATE_PROVIDER');
        return { ...answer, text: reason === 'invalid_citation' ? 'PRIVATE_ANSWER [S99]' : answer.text };
      });
      const result = await runAgent({ message: reason === 'invalid_request' ? '' : 'PRIVATE_PROMPT' }, {
        provider: { contextWindowTokens: 65_536, complete }, signal: controller.signal,
        observe: (event) => { events.push(event); },
      });
      expect(result.reason).toBe(reason);
      expect(events.at(-1)?.stopReason).toBe(reason);
      expect(events.every((event) => !Object.hasOwn(event, 'validationCategory'))).toBe(true);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
    });

  it('keeps diagnostics optional for other observers and an absent observer', () => {
    const observe = vi.fn();
    const event = { stage: 'agent', outcome: 'failure' } as const;
    observeStage(observe, 10, event, 20);
    expect(observe).toHaveBeenCalledExactlyOnceWith({ ...event, durationMs: 10 });
    expect(() => observeStage(undefined, 10, event, 20)).not.toThrow();
  });
});

describe('existing stop-reason to SSE mappings', () => {
  const mappings = {
    answer: 'INTERNAL_ERROR', empty_output: 'INVALID_MODEL_OUTPUT', invalid_request: 'INTERNAL_ERROR',
    invalid_response: 'INVALID_MODEL_OUTPUT', invalid_tool_call: 'INVALID_MODEL_OUTPUT',
    unsupported_tool: 'INVALID_MODEL_OUTPUT', repeated_tool_call: 'INVALID_MODEL_OUTPUT',
    round_limit: 'AGENT_LIMIT', context_limit: 'CONTEXT_LIMIT', output_budget: 'AGENT_LIMIT',
    output_limit: 'INVALID_MODEL_OUTPUT', content_filter: 'INVALID_MODEL_OUTPUT', invalid_citation: 'INVALID_CITATION',
    provider_error: 'MODEL_FAILED', model_timeout: 'MODEL_TIMEOUT', deadline: 'REQUEST_TIMEOUT', cancelled: 'CANCELLED',
  } satisfies Record<AgentStopReason, StreamErrorCode>;
  it.each(Object.entries(mappings))('preserves %s → %s', (reason, code) => {
    expect(agentErrorCode(reason as AgentStopReason)).toBe(code);
  });
});

describe('diagnostics through Azure adapter and Fastify logs (mock network)', () => {
  it.each(cases.filter((test) => test.category !== 'response_schema'))(
    'keeps HTTP/SSE public and logs private for $label', async ({ response, reason, category }) => {
      let output = '';
      const model = response as ModelResponse;
      const fetchImpl = vi.fn<typeof fetch>(async () => json({ choices: [{ finish_reason: model.finishReason,
        message: { role: 'assistant', content: model.text,
          ...(category === 'content_filter' ? { refusal: 'PRIVATE_REFUSAL' } : {}),
          tool_calls: model.toolCalls.map((entry) => ({ id: entry.id, type: 'function',
            function: { name: entry.name, arguments: entry.arguments } })),
        },
      }], usage: { prompt_tokens: 520, completion_tokens: model.usage!.outputTokens,
        completion_tokens_details: { reasoning_tokens: 0 } }, PRIVATE_UPSTREAM_PROPERTY: 'PRIVATE_VALUE' }));
      const memoryDirectory = mkdtempSync(join(tmpdir(), 'recall-http-offline-'));
    const app = buildServer({ memoryDirectory, config: loadConfig(azureEnv), fetchImpl,
        logStream: new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }),
      });
      try {
        const reply = await app.inject({ method: 'POST', url: '/api/chat',
          headers: { authorization: 'PRIVATE_HEADER', 'api-key': 'PRIVATE_KEY' },
          payload: { message: 'PRIVATE_PROMPT', history: [{ role: 'assistant', content: 'PRIVATE_HISTORY',
            timestamp: '2026-11-14T00:00:00Z' }] },
        });
        expect(reply.statusCode).toBe(200);
        const parsed = await readChatStream(new Response(reply.body));
        expect(parsed.error?.code).toBe('INVALID_MODEL_OUTPUT');
        expect(reply.body.match(/event: done/g)).toHaveLength(1);
        expect(reply.body).not.toMatch(/event: result|stopReason|validationCategory|PRIVATE/);
        const events = output.trim().split('\n').map((line) => JSON.parse(line));
        expect(events.find((event) => event.stage === 'agent')).toMatchObject({ requestId: parsed.meta.requestId,
          stopReason: reason, validationCategory: category, modelCalls: 1, searchCalls: 0 });
        expect(output).not.toMatch(/PRIVATE|offline-azure-secret|offline-tavily-secret|https:\/\//);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally { await app.close(); await rm(memoryDirectory, { recursive: true, force: true }); }
    });
});
