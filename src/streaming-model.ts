import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, streamText, jsonSchema, tool, isStepCount, type ModelMessage as SdkMessage } from 'ai';
import type { AppConfig } from './config.js';
import { ModelProviderError, contextFits, type ModelProvider } from './model.js';

/** AI SDK 7.0.176 / @ai-sdk/openai pinned in package.json. One SDK step per
 * complete(); the existing agent owns the 5+3 search budget, not the SDK. */
export function createStreamingModelProvider(config: AppConfig, fetchImpl: typeof fetch = fetch): ModelProvider {
  if (config.MODEL_PROVIDER !== 'azure-openai-v1' || !config.AZURE_OPENAI_CHAT_ENDPOINT ||
      !config.AZURE_OPENAI_API_KEY || !config.AZURE_OPENAI_DEPLOYMENT || !config.AZURE_OPENAI_CONTEXT_TOKENS) {
    throw new ModelProviderError('NOT_CONFIGURED');
  }
  const endpoint = config.AZURE_OPENAI_CHAT_ENDPOINT;
  const azure = createOpenAI({ apiKey: config.AZURE_OPENAI_API_KEY,
    baseURL: endpoint.slice(0, -'/chat/completions'.length), headers: { 'api-key': config.AZURE_OPENAI_API_KEY },
    fetch: async (url, init) => {
      // Azure's configured v1 endpoint uses API-key auth. Never forward that
      // credential to any other URL, including redirects.
      if (String(url) !== endpoint) throw new ModelProviderError('INVALID_REQUEST');
      const headers = new Headers(init?.headers); headers.delete('authorization');
      return fetchImpl(url, { ...init, headers, redirect: 'error' });
    } });
  return { contextWindowTokens: config.AZURE_OPENAI_CONTEXT_TOKENS,
    async complete(request) {
      if (!contextFits(request, config.AZURE_OPENAI_CONTEXT_TOKENS!) || request.maxOutputTokens > 2048) throw new ModelProviderError('INVALID_REQUEST');
      const instructions = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages: SdkMessage[] = request.messages.filter((m) => m.role !== 'system').map((m): SdkMessage => {
        if (m.role === 'tool') return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.toolCallId,
          toolName: 'web_search', output: { type: 'text', value: m.content } }] };
        if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: JSON.parse(c.arguments) as unknown }))] };
        return { role: m.role, content: m.content };
      });
      try {
        const result = streamText({ model: azure.chat(config.AZURE_OPENAI_DEPLOYMENT!), messages, instructions,
          maxOutputTokens: request.maxOutputTokens, maxRetries: 0, stopWhen: isStepCount(1),
          abortSignal: request.signal, timeout: { firstChunkMs: 15_000 },
          ...(request.tools.length ? { tools: Object.fromEntries(request.tools.map((t) => [t.name,
            tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })])) } : {}),
          onError: () => { /* The fullStream error below owns failure reporting; no upstream text in logs. */ },
        });
        let text = '';
        for await (const part of result.fullStream) {
          request.signal.throwIfAborted();
          if (['text-delta', 'tool-input-delta', 'tool-call'].includes(part.type)) request.onFirstToken?.();
          if (part.type === 'error') throw part.error;
          if (part.type === 'text-delta') {
            text += part.text;
            if (text.length > 16_000) throw new ModelProviderError('RESPONSE_TOO_LARGE');
            await request.onText?.(part.text);
          }
        }
        const [calls, finishReason, usage] = await Promise.all([result.toolCalls, result.finishReason, result.usage]);
        return { text, toolCalls: calls.map((c) => ({ id: c.toolCallId, name: c.toolName, arguments: JSON.stringify(c.input) })),
          finishReason: finishReason === 'tool-calls' ? 'tool_calls' : finishReason === 'length' ? 'length' :
            finishReason === 'content-filter' ? 'content_filter' : 'stop',
          ...(usage.inputTokens !== undefined && usage.outputTokens !== undefined ? { usage: { inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens, ...(usage.outputTokenDetails.reasoningTokens !== undefined ? {
              reasoningTokens: usage.outputTokenDetails.reasoningTokens } : {}) } } : {}) };
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof ModelProviderError) throw error;
        if (APICallError.isInstance(error)) throw new ModelProviderError('HTTP_ERROR', error.statusCode);
        if (error instanceof Error && ['AI_InvalidPromptError', 'AI_InvalidArgumentError', 'AI_NoSuchModelError'].includes(error.name)) throw new ModelProviderError('INVALID_REQUEST');
        if (error instanceof Error && error.name === 'AI_TypeValidationError') throw new ModelProviderError('INVALID_RESPONSE');
        throw new ModelProviderError('NETWORK_ERROR');
      }
    } };
}
