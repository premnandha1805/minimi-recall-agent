import { z } from 'zod';
import type { AppConfig } from './config.js';
import { runWithSignal } from './execution.js';

export const MAX_MODEL_TEXT_CHARS = 16_000;
export const MAX_TOOL_CALLS_PER_RESPONSE = 5;
export const MAX_MODEL_RESPONSE_BYTES = 131_072;
export const MAX_CONTEXT_BYTES = 65_536;

export const ToolCallSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(64),
  arguments: z.string().max(4096),
});
export type ModelToolCall = z.infer<typeof ToolCallSchema>;
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ModelToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ModelTool {
  name: 'web_search';
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
}
export const ModelResponseSchema = z.strictObject({
  text: z.string().max(MAX_MODEL_TEXT_CHARS),
  toolCalls: z.array(ToolCallSchema).max(MAX_TOOL_CALLS_PER_RESPONSE),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().max(1_000_000),
    outputTokens: z.number().int().nonnegative().max(1_000_000),
    reasoningTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  }).optional(),
});
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export interface ModelProvider {
  /** Deployment-specific, not inferred from a model name. */
  readonly contextWindowTokens: number;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelProviderError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'INVALID_REQUEST') {
    super(`Model provider: ${code}`);
    this.name = 'ModelProviderError';
  }
}

/** Conservative UTF-8 byte upper bound plus room for message framing; no tokenizer claim. */
export function contextFits(request: Omit<ModelRequest, 'signal'>, contextWindowTokens: number): boolean {
  const bytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), 'utf8');
  return bytes <= MAX_CONTEXT_BYTES &&
    bytes + 64 * (request.messages.length + 1) + request.maxOutputTokens <= contextWindowTokens;
}

const AzureResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().max(MAX_MODEL_TEXT_CHARS).nullable(),
      refusal: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: ToolCallSchema.shape.id,
        type: z.literal('function'),
        function: z.object({ name: ToolCallSchema.shape.name, arguments: ToolCallSchema.shape.arguments }),
      })).max(MAX_TOOL_CALLS_PER_RESPONSE).optional(),
    }),
  })).length(1),
  usage: z.object({
    prompt_tokens: ModelResponseSchema.shape.usage.unwrap().shape.inputTokens,
    completion_tokens: ModelResponseSchema.shape.usage.unwrap().shape.outputTokens,
    // Optional telemetry must not invalidate an otherwise usable response.
    completion_tokens_details: z.object({
      reasoning_tokens: ModelResponseSchema.shape.usage.unwrap().shape.reasoningTokens,
    }).optional().catch(undefined),
  }).optional(),
});

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ModelProviderError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await runWithSignal(signal, () => reader.read());
      done = chunk.done;
      if (chunk.value) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_MODEL_RESPONSE_BYTES) throw new ModelProviderError('RESPONSE_TOO_LARGE');
        chunks.push(chunk.value);
      }
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ModelProviderError('INVALID_RESPONSE'); }
  } finally {
    // Do not wait forever for a broken stream's cancellation; observe its rejection.
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only Azure OpenAI v1 text Chat Completions with function tools and API-key auth.
 * No Responses API, legacy dated API, generic Azure inference, streaming, retries,
 * or automatic model/endpoint fallback. See docs/agent-core.md for the verified spec.
 */
export function createModelProvider(config: AppConfig, fetchImpl: typeof fetch = fetch): ModelProvider {
  if (config.MODEL_PROVIDER !== 'azure-openai-v1' || !config.AZURE_OPENAI_CHAT_ENDPOINT ||
      !config.AZURE_OPENAI_API_KEY || !config.AZURE_OPENAI_DEPLOYMENT || !config.AZURE_OPENAI_CONTEXT_TOKENS) {
    throw new ModelProviderError('NOT_CONFIGURED');
  }
  const endpoint = config.AZURE_OPENAI_CHAT_ENDPOINT;
  const apiKey = config.AZURE_OPENAI_API_KEY;
  const deployment = config.AZURE_OPENAI_DEPLOYMENT;
  const contextWindowTokens = config.AZURE_OPENAI_CONTEXT_TOKENS;
  return {
    contextWindowTokens,
    async complete(request) {
      if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
          request.maxOutputTokens > 2048 || !contextFits(request, contextWindowTokens)) {
        throw new ModelProviderError('INVALID_REQUEST');
      }
      const messages = request.messages.map((message) => {
        if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
        if (message.role === 'assistant' && message.toolCalls?.length) return {
          role: 'assistant', content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        };
        return { role: message.role, content: message.content };
      });
      return runWithSignal(request.signal, async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: request.signal,
          headers: { 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            model: deployment, messages, stream: false, max_completion_tokens: request.maxOutputTokens,
            ...(request.tools.length ? {
              tools: request.tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto',
            } : { tool_choice: 'none' }),
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ModelProviderError('HTTP_ERROR');
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          void response.body?.cancel().catch(() => {});
          throw new ModelProviderError('INVALID_RESPONSE');
        }
        const parsed = AzureResponseSchema.safeParse(await readBoundedJson(response, request.signal));
        if (!parsed.success) throw new ModelProviderError('INVALID_RESPONSE');
        const choice = parsed.data.choices[0];
        return {
          text: choice.message.content ?? '',
          toolCalls: (choice.message.tool_calls ?? []).map((call) => ({ id: call.id, ...call.function })),
          finishReason: choice.message.refusal ? 'content_filter' : choice.finish_reason,
          ...(parsed.data.usage ? { usage: {
            inputTokens: parsed.data.usage.prompt_tokens, outputTokens: parsed.data.usage.completion_tokens,
            ...(parsed.data.usage.completion_tokens_details?.reasoning_tokens !== undefined ? {
              reasoningTokens: parsed.data.usage.completion_tokens_details.reasoning_tokens,
            } : {}),
          } } : {}),
        };
      }).catch((error: unknown) => {
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof ModelProviderError) throw error;
        // Network/body-reader errors can contain URLs or credentials. Do not forward them.
        throw new ModelProviderError('NETWORK_ERROR');
      });
    },
  };
}
