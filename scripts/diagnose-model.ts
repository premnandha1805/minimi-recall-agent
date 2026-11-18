import { loadConfig, loadEnvIfPresent } from '../src/config.js';
loadEnvIfPresent();
const c = loadConfig();
for (const withToolChoice of [true, false]) {
  const start = performance.now();
  try {
    const response = await fetch(c.AZURE_OPENAI_CHAT_ENDPOINT!, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', 'api-key': c.AZURE_OPENAI_API_KEY! },
      body: JSON.stringify({ model: c.AZURE_OPENAI_DEPLOYMENT, messages: [{ role: 'user', content: 'Say hello.' }],
        stream: false, max_completion_tokens: 32, ...(withToolChoice ? { tool_choice: 'none' } : {}) }),
    });
    const data = await response.json() as { error?: { code?: string; param?: string; message?: string }; choices?: unknown[] };
    // Only fixed categories, never arbitrary provider messages or credentials.
    console.log({ withToolChoice, status: response.status, durationMs: Math.round(performance.now() - start),
      code: ['invalid_request_error', 'unsupported_parameter', 'BadRequest'].find((code) => code === data.error?.code),
      param: ['tool_choice', 'tools', 'max_completion_tokens'].find((param) => param === data.error?.param),
      mentionsToolChoice: /tool_choice/i.test(data.error?.message ?? ''),
      mentionsTools: /tools/i.test(data.error?.message ?? ''), hasChoices: !!data.choices?.length });
  } catch { console.log({ withToolChoice, error: 'network_or_timeout', durationMs: Math.round(performance.now() - start) }); }
}
