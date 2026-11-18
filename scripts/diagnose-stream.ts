import { loadConfig, loadEnvIfPresent } from '../src/config.js';
import { createStreamingModelProvider } from '../src/streaming-model.js';
loadEnvIfPresent();
const config = loadConfig();
let tokens = 0; const started = performance.now();
const provider = createStreamingModelProvider(config, async (url, input) => {
  console.log({ stage: 'fetch_start', endpointMatches: String(url) === config.AZURE_OPENAI_CHAT_ENDPOINT });
  try {
    const response = await fetch(url, input);
    console.log({ stage: 'fetch_end', status: response.status, streaming: response.headers.get('content-type')?.includes('text/event-stream') });
    return response;
  } catch (error) {
    const detail = error as { name?: string; code?: string; cause?: { code?: string } };
    const code = detail.cause?.code ?? detail.code;
    console.log({ stage: 'fetch_end', error: 'network', type: detail.name === 'TypeError' ? 'TypeError' : 'other',
      code: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EACCES', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED',
        'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_CHAR', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].find((c) => c === code) });
    throw error;
  }
});
try {
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Say hello.' }], tools: [],
    maxOutputTokens: 64, signal: AbortSignal.timeout(15_000), onText: () => { tokens++; } });
  console.log({ success: true, chunks: tokens, characters: result.text.length, durationMs: Math.round(performance.now() - started) });
} catch (error) {
  console.log({ success: false, chunks: tokens, code: error instanceof Error ? error.message : 'failed', durationMs: Math.round(performance.now() - started) });
}
