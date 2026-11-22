import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readChatStream, memoryId } from '../public/api.js';
import type { ChatEventPayloads } from '../src/contracts.js';
import { loadConfig, loadEnvIfPresent, isChatConfigured, type AppConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { ConversationSchema } from '../src/memory.js';
import { createStreamingModelProvider } from '../src/streaming-model.js';
import type { ModelMessage, ModelProvider, ModelResponse } from '../src/model.js';

interface SyntheticModelTrace {
  messages: ModelMessage[];
  tools: string[];
  elapsedMs: number;
  response?: ModelResponse;
  failure?: 'provider_or_timeout';
}

export type LivePairOutcome = 'PASS' | 'RECOVERED' | 'FAIL';

export interface LiveTurnOutput {
  conversationId: string;
  firstTokenMs: number | null;
  meta?: ChatEventPayloads['meta'];
  result?: ChatEventPayloads['result'];
  error?: ChatEventPayloads['error'];
}

export interface EvaluatedLivePair {
  status: LivePairOutcome;
  origin: 'model' | 'recovered' | 'missing';
  fallback: boolean;
  error?: string;
}

/** Deterministic evaluator for live recall pairs. Genuine PASS strictly requires
 * validated model synthesis (generation.origin === 'model' && memory.fallback !== true).
 * Deterministic recovery is reported separately and never counted as model PASS. */
export function evaluateLivePair(
  factTurn: LiveTurnOutput,
  recallTurn: LiveTurnOutput,
  expected: readonly string[],
): EvaluatedLivePair {
  const rawOrigin = recallTurn.result?.generation?.origin;
  const origin: 'model' | 'recovered' | 'missing' =
    rawOrigin === 'model' || rawOrigin === 'recovered' ? rawOrigin : 'missing';
  const fallback = recallTurn.result?.memory?.fallback === true || origin === 'recovered';
  const text = recallTurn.result?.message.content ?? '';

  if (!factTurn.result || factTurn.error) {
    return { status: 'FAIL', origin, fallback, error: factTurn.error?.code ?? 'fact turn missing result' };
  }
  if (!recallTurn.result || recallTurn.error) {
    return { status: 'FAIL', origin, fallback, error: recallTurn.error?.code ?? 'recall turn missing result' };
  }
  if (factTurn.result.coverage !== 'complete' || recallTurn.result.coverage !== 'complete') {
    return { status: 'FAIL', origin, fallback, error: 'partial coverage' };
  }
  if (factTurn.conversationId === recallTurn.conversationId) {
    return { status: 'FAIL', origin, fallback, error: 'recall reused fact conversation' };
  }
  if (/MODEL_TIMEOUT|MODEL_FAILED/.test(text) || !expected.every((word) => text.includes(word))) {
    return { status: 'FAIL', origin, fallback, error: 'expected evidence missing' };
  }
  if (origin === 'recovered' || fallback) {
    return { status: 'RECOVERED', origin, fallback: true };
  }
  if (origin !== 'model') {
    return { status: 'FAIL', origin: 'missing', fallback: false, error: 'missing or invalid generation.origin metadata' };
  }
  return { status: 'PASS', origin: 'model', fallback: false };
}

export function parseLiveOptions(args: readonly string[]): { runs: number; research: boolean } | undefined {
  if (!args.includes('--live')) return undefined;
  if (args.some((arg) => arg !== '--live' && arg !== '--research' && !arg.startsWith('--runs='))) throw new Error('Unsupported live-test option');
  const counts = args.filter((arg) => arg.startsWith('--runs='));
  const runs = Number(counts[0]?.slice('--runs='.length) ?? 1);
  if (counts.length > 1 || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be 1..10');
  return { runs, research: args.includes('--research') };
}

async function liveServer(config: AppConfig, directory: string, provider: ModelProvider) {
  const app = buildServer({ config, memoryDirectory: directory, provider, logger: false });
  const root = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, root };
}

async function runLiveE2e() {
  const options = parseLiveOptions(process.argv.slice(2));
  if (!options) {
    console.log('Not run: explicit --live is required. Check provider quota first. This harness always uses its own isolated archive.');
    process.exitCode = 1; return;
  }
  loadEnvIfPresent();
  const config = loadConfig();
  if (!isChatConfigured(config)) throw new Error('Live provider configuration is required');
  const directory = resolve(import.meta.dirname, '..', '.data', 'live-tests', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Only this owned synthetic archive is traced. Never capture configuration,
  // headers, provider errors or an arbitrary running user's conversations.
  let calls: SyntheticModelTrace[] = [];
  const upstream = createStreamingModelProvider(config);
  const provider: ModelProvider = { contextWindowTokens: upstream.contextWindowTokens, async complete(request) {
    const trace: SyntheticModelTrace = { messages: structuredClone(request.messages),
      tools: request.tools.map((tool) => tool.name), elapsedMs: 0 };
    calls.push(trace);
    const start = performance.now();
    try { const response = await upstream.complete(request); trace.response = response; return response; }
    catch (error) { trace.failure = 'provider_or_timeout'; throw error; }
    finally { trace.elapsedMs = Math.round(performance.now() - start); }
  } };
  let server = await liveServer(config, directory, provider);
  const traces: Array<{ run: number; pair: string; fact: string; question: string; expected: string[];
    factTurn: LiveTurnOutput; recallTurn: LiveTurnOutput; calls: SyntheticModelTrace[] }> = [];
  const rows: Array<{ run: number; pair: string; status: LivePairOutcome; totalMs: number; firstTokenA: number | null;
    firstTokenB: number | null; requestA?: string; requestB?: string; origin: 'model' | 'recovered' | 'missing';
    fallback: boolean; error?: string }> = [];
  let research: { status: 'PASS' | 'FAIL'; sources: number; deltas: number } | undefined;
  let restart: 'PASS' | 'FAIL' = 'FAIL';
  let executionFailed = false;
  let lastFactId = '';
  async function send(message: string): Promise<LiveTurnOutput & { durationMs: number; deltas: number }> {
    const created = await fetch(server.root + '/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!created.ok) throw new Error('Conversation creation failed');
    const { id } = ConversationSchema.parse(await created.json());
    const start = performance.now();
    const response = await fetch(server.root + '/api/chat', { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: id, message, timezone: 'Asia/Kolkata' }) });
    if (!response.ok) throw new Error('Chat request failed');
    let firstTokenMs: number | null = null, deltas = 0;
    const output = await readChatStream(response, { onDelta: () => { deltas++; firstTokenMs ??= Math.round(performance.now() - start); } });
    if (output.result && output.result.coverage === 'complete') {
      const turn = response.headers.get('x-turn-id'), attempt = response.headers.get('x-attempt-id');
      if (!turn || !attempt || !memoryId(turn) || !memoryId(attempt) || output.meta.conversationId !== id) throw new Error('Receipt identity missing');
      const receipt = await fetch(server.root + '/api/conversations/' + id + '/turns/' + turn + '/attempts/' + attempt + '/receipt', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: output.result.message.id }) });
      if (!receipt.ok || (await receipt.json() as { status: string }).status !== 'accepted') throw new Error('Receipt failed');
    }
    return { ...output, conversationId: id, firstTokenMs, durationMs: Math.round(performance.now() - start), deltas };
  }
  try {
    for (let run = 1; run <= options.runs; run++) {
      const tag = randomUUID().slice(0, 8);
      const pairs = [
        { label: 'meeting', fact: 'I have an Infosys meeting on 23 August.', question: 'What meeting did I tell you about?', expected: ['Infosys', '23 August'] },
        { label: 'project database', fact: 'I selected PostgreSQL as the database for my project CedarLedger-' + tag + '.',
          question: 'Which database did I select for CedarLedger-' + tag + '?', expected: ['PostgreSQL', 'CedarLedger-' + tag] },
        { label: 'laptop purchase', fact: 'I purchased a notebook computer from Dell for FieldKit-' + tag + '.',
          question: 'Which laptop brand did I buy for FieldKit-' + tag + '?', expected: ['Dell', 'FieldKit-' + tag] },
        { label: 'person and task', fact: 'I asked Priya to review the deployment checklist for CedarRelease-' + tag + '.',
          question: 'Who did I ask to review the deployment checklist for CedarRelease-' + tag + '?', expected: ['Priya', 'deployment checklist', 'CedarRelease-' + tag] },
      ];
      for (const pair of pairs) {
        const start = performance.now();
        try {
          calls = [];
          const a = await send(pair.fact); lastFactId = a.conversationId;
          const b = await send(pair.question); const verdict = evaluateLivePair(a, b, pair.expected);
          traces.push({ run, pair: pair.label, fact: pair.fact, question: pair.question, expected: pair.expected,
            factTurn: a, recallTurn: b, calls });
          rows.push({ run, pair: pair.label, status: verdict.status, totalMs: Math.round(performance.now() - start),
            firstTokenA: a.firstTokenMs, firstTokenB: b.firstTokenMs, requestA: a.meta?.requestId, requestB: b.meta?.requestId,
            origin: verdict.origin, fallback: verdict.fallback, ...(verdict.error ? { error: verdict.error } : {}) });
        } catch {
          rows.push({ run, pair: pair.label, status: 'FAIL', totalMs: Math.round(performance.now() - start),
            firstTokenA: null, firstTokenB: null, origin: 'missing', fallback: false, error: 'live_request_failed' });
        }
        const row = rows.at(-1)!;
        console.log(JSON.stringify({ run: row.run, pair: row.pair, status: row.status, totalMs: row.totalMs, origin: row.origin }));
      }
    }
    if (options.research) {
      const out = await send('Use one web search to check the official PostgreSQL about page. What is PostgreSQL? Give a brief answer citing your source.');
      const sources = out.result?.sources.length ?? 0;
      research = { status: out.result?.coverage === 'complete' && !out.error && sources > 0 && /\[S\d+\]/.test(out.result.message.content) && out.deltas > 0 ? 'PASS' : 'FAIL', sources, deltas: out.deltas };
      console.log(JSON.stringify({ research }));
    }
    await server.app.close();
    server = await liveServer(config, directory, provider);
    const saved = await fetch(server.root + '/api/conversations/' + lastFactId);
    if (saved.ok) {
      const record = ConversationSchema.parse(await saved.json());
      restart = record.turns.some((turn) => turn.attempts.some((attempt) => attempt.status === 'accepted')) ? 'PASS' : 'FAIL';
    }
    console.log(JSON.stringify({ persistenceAfterRestart: restart }));
  } catch { executionFailed = true; console.error('A live verification stage failed. Raw provider errors are withheld.'); }
  finally { await server.app.close(); }
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const recovered = rows.filter((row) => row.status === 'RECOVERED').length;
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  const report = { timestamp: new Date().toISOString(), provider: 'real configured Azure and Tavily', runs: options.runs,
    passed, recovered, failed, total: rows.length, rows, research, persistenceAfterRestart: restart,
    archive: directory, executionFailed, traces,
    timing: 'firstToken fields measure the first visible SSE delta, not the first upstream provider token' };
  const output = resolve(import.meta.dirname, '..', '.data', 'evaluations'); await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'live-e2e-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, recovered, failed, report: '.data/evaluations/live-e2e-results.json' }));
  process.exitCode = !executionFailed && passed === rows.length && restart === 'PASS' && (!research || research.status === 'PASS') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runLiveE2e(); }
  catch { console.error('Live verification failed; inspect configuration, provider availability, or the isolated archive. No raw provider error is printed.'); process.exitCode = 1; }
}
