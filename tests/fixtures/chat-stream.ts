import type { ChatEventPayloads, ChatResult } from '../../src/contracts.js';
import { encodeEvent } from '../../src/sse.js';
export const meta: ChatEventPayloads['meta'] = { version: 'recall.chat.v1',
  requestId: '11111111-1111-4111-8111-111111111111', conversationId: 'session_test', answerMode: 'final' };
export const result: ChatResult = { message: { id: 'msg_test', role: 'assistant', content: 'Hello नमस्ते 🌍',
  timestamp: '2026-11-14T00:00:00.000Z' }, coverage: 'complete', issues: [], sources: [], evidenceCheck: 'citation_ids_only' };
export const source = { id: 'S1', query: 'fixture', title: '<img src=x onerror=alert(1)>',
  url: 'https://example.com/fixture', retrieved_at: '2026-11-14T00:00:00Z', published_at: '2026-11-13' };
export function streamText(answer: ChatResult = result): string {
  return encodeEvent('meta', meta) + encodeEvent('progress', { phase: 'accepted' }) +
    encodeEvent('progress', { phase: 'model_started', call: 1 }) + encodeEvent('result', answer) +
    encodeEvent('done', { outcome: answer.coverage === 'complete' ? 'completed' : 'partial', messageId: answer.message.id });
}
export const azureEnv = { MODEL_PROVIDER: 'azure-openai-v1',
  AZURE_OPENAI_CHAT_ENDPOINT: 'https://fixture.openai.azure.com/openai/v1/chat/completions',
  AZURE_OPENAI_DEPLOYMENT: 'fixture', AZURE_OPENAI_CONTEXT_TOKENS: '65536',
  AZURE_OPENAI_API_KEY: 'offline-azure-secret', TAVILY_API_KEY: 'offline-tavily-secret' };
export function wire(content = 'Hello') {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] };
}
export function toolWire() {
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["fixture"]}' } }] } }] };
}
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
