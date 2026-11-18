import { expect, it, vi } from 'vitest';
import { createStreamingModelProvider } from '../src/streaming-model.js';
import { loadConfig } from '../src/config.js';
import { azureEnv } from './fixtures/chat-stream.js';

function response() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'world.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
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
