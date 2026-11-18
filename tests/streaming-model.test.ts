import { expect, it, vi } from 'vitest';
import { createStreamingModelProvider } from '../src/streaming-model.js';
import { loadConfig } from '../src/config.js';
import { WEB_SEARCH_TOOL } from '../src/search.js';
import { azureEnv } from './fixtures/chat-stream.js';

function streamOf(chunks: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function response() {
  return streamOf([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'world.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
  ]);
}
it('streams real SDK chunks with no tool_choice when tools are absent', async () => {
  const network = vi.fn<typeof fetch>(async () => response());
  const provider = createStreamingModelProvider(loadConfig(azureEnv), network);
  const deltas: string[] = [];
  const result = await provider.complete({ messages: [{ role: 'system', content: 'Trusted app instructions.' }, { role: 'user', content: 'Hello' }], tools: [],
    maxOutputTokens: 100, signal: new AbortController().signal, onText: (text) => { deltas.push(text); } });
  expect(result.text).toBe('Hello world.'); expect(deltas).toEqual(['Hello ', 'world.']);
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(body.stream).toBe(true); expect(body.tool_choice).toBeUndefined(); expect(body.tools).toBeUndefined();
  expect(body.messages[0]).toEqual({ role: 'system', content: 'Trusted app instructions.' });
  expect(network.mock.calls[0][1]?.redirect).toBe('error');
});

it('sends tool_choice auto when web_search is enabled and parses streamed tool calls', async () => {
  const network = vi.fn<typeof fetch>(async () => streamOf([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"queries":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '["postgresql pricing"]}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]));
  const provider = createStreamingModelProvider(loadConfig(azureEnv), network);
  const result = await provider.complete({ messages: [{ role: 'system', content: 'Trusted app instructions.' }, { role: 'user', content: 'Search pricing' }],
    tools: [WEB_SEARCH_TOOL], maxOutputTokens: 100, signal: new AbortController().signal });
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(body.tool_choice).toBe('auto'); expect(body.tools).toHaveLength(1);
  expect(result.finishReason).toBe('tool_calls');
  expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'web_search', arguments: '{"queries":["postgresql pricing"]}' }]);
});

it('omits tool_choice in streamed final synthesis after tool history when tools are disabled', async () => {
  const network = vi.fn<typeof fetch>(async () => response());
  const provider = createStreamingModelProvider(loadConfig(azureEnv), network);
  await provider.complete({ messages: [
    { role: 'system', content: 'Trusted app instructions.' },
    { role: 'user', content: 'Search pricing' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"queries":["postgresql pricing"]}' }] },
    { role: 'tool', toolCallId: 'call_1', content: '{"status":"ok","sources":[]}' },
  ], tools: [], maxOutputTokens: 100, signal: new AbortController().signal });
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(body.tool_choice).toBeUndefined(); expect(body.tools).toBeUndefined();
});
