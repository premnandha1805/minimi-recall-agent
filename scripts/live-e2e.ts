import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readChatStream } from '../public/api.js';
import type { ChatEventPayloads } from '../src/contracts.js';

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

async function runLiveE2e() {
  const root = process.env.LIVE_URL ?? 'http://127.0.0.1:3000';
  const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1] ?? 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be 1..10');
  const summaryResponse = await fetch(`${root}/api/debug/memory`);
  if (!summaryResponse.ok) throw new Error('The local debug endpoint must be enabled to verify the real archive.');
  const summary = await summaryResponse.json() as { absolutePath: string; conversationCount: number };
  console.log(`Real server: ${root}; archive: ${summary.absolutePath}; initial conversations: ${summary.conversationCount}`);

  async function send(message: string): Promise<LiveTurnOutput & { durationMs: number }> {
    const created = await fetch(`${root}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!created.ok) throw new Error(`Conversation creation HTTP ${created.status}`);
    const { id } = await created.json() as { id: string };
    const start = performance.now();
    const response = await fetch(`${root}/api/chat`, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: id, message, timezone: 'Asia/Kolkata' }) });
    if (!response.ok) throw new Error(`Chat HTTP ${response.status}`);
    let firstTokenMs: number | null = null;
    const result = await readChatStream(response, { onDelta: () => { firstTokenMs ??= Math.round(performance.now() - start); } });
    return { ...result, conversationId: id, firstTokenMs, durationMs: Math.round(performance.now() - start) };
  }

  const rows: Array<{ run: number; pair: string; status: LivePairOutcome; totalMs: number; firstTokenA: number | null;
    firstTokenB: number | null; requestA?: string; requestB?: string; origin: 'model' | 'recovered' | 'missing';
    fallback: boolean; error?: string }> = [];
  for (let run = 1; run <= runs; run++) {
    const tag = randomUUID().slice(0, 8);
    const pairs = [
      { label: 'meeting', fact: 'I have an Infosys meeting on 23 August.', question: 'What meeting did I tell you about?', expected: ['Infosys', '23 August'] },
      { label: 'project database', fact: `I selected PostgreSQL as the database for my project CedarLedger-${tag}.`,
        question: `Which database did I select for CedarLedger-${tag}?`, expected: ['PostgreSQL', `CedarLedger-${tag}`] },
      { label: 'laptop purchase', fact: `I purchased a notebook computer from Dell for FieldKit-${tag}.`,
        question: `Which laptop brand did I buy for FieldKit-${tag}?`, expected: ['Dell', `FieldKit-${tag}`] },
      { label: 'person and task', fact: `I asked Priya to review the deployment checklist for CedarRelease-${tag}.`,
        question: `Who did I ask to review the deployment checklist for CedarRelease-${tag}?`, expected: ['Priya', 'deployment checklist', `CedarRelease-${tag}`] },
    ];
    for (const pair of pairs) {
      const start = performance.now();
      try {
        const a = await send(pair.fact);
        const b = await send(pair.question);
        const verdict = evaluateLivePair(a, b, pair.expected);
        rows.push({ run, pair: pair.label, status: verdict.status, totalMs: Math.round(performance.now() - start),
          firstTokenA: a.firstTokenMs, firstTokenB: b.firstTokenMs, requestA: a.meta?.requestId, requestB: b.meta?.requestId,
          origin: verdict.origin, fallback: verdict.fallback, ...(verdict.error ? { error: verdict.error } : {}) });
      } catch (error) {
        rows.push({ run, pair: pair.label, status: 'FAIL', totalMs: Math.round(performance.now() - start), firstTokenA: null, firstTokenB: null,
          origin: 'missing', fallback: false, error: error instanceof Error ? error.message : 'request failed' });
      }
      const row = rows.at(-1)!;
      console.log(`run ${run} | ${pair.label.padEnd(16)} | ${row.status.padEnd(9)} | ${row.totalMs} ms | ${row.error ?? (row.status === 'RECOVERED' ? 'deterministic recovery' : 'model synthesis')}`);
    }
  }
  console.table(rows.map(({ run, pair, status, origin, fallback, totalMs, firstTokenA, firstTokenB }) => ({ run, pair, status, origin, fallback, totalMs, firstTokenA, firstTokenB })));
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const recovered = rows.filter((row) => row.status === 'RECOVERED').length;
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  console.log(`${passed}/${rows.length} model PASS, ${recovered} RECOVERED, ${failed} FAIL; ${runs} consecutive runs ${passed === rows.length ? 'PASS' : 'FAIL'}.`);
  await writeFile('docs/live-e2e-results.json', JSON.stringify({ timestamp: new Date().toISOString(), provider: 'real configured provider',
    runs, passed, recovered, failed, total: rows.length, rows }, null, 2) + '\n');
  process.exitCode = passed === rows.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runLiveE2e();
}
