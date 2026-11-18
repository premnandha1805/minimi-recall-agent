import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readChatStream } from '../public/api.js';

const root = process.env.LIVE_URL ?? 'http://127.0.0.1:3000';
const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1] ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be 1..10');
const summaryResponse = await fetch(`${root}/api/debug/memory`);
if (!summaryResponse.ok) throw new Error('The local debug endpoint must be enabled to verify the real archive.');
const summary = await summaryResponse.json() as { absolutePath: string; conversationCount: number };
console.log(`Real server: ${root}; archive: ${summary.absolutePath}; initial conversations: ${summary.conversationCount}`);

async function send(message: string) {
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
const rows: Array<{ run: number; pair: string; status: string; totalMs: number; firstTokenA: number | null;
  firstTokenB: number | null; requestA?: string; requestB?: string; fallback?: boolean; error?: string }> = [];
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
      const a = await send(pair.fact); // wait for complete SSE, including durable result
      const b = await send(pair.question);
      const text = b.result?.message.content ?? '';
      const ok = !!a.result && !!b.result && !a.error && !b.error &&
        !/MODEL_TIMEOUT|MODEL_FAILED/.test(text) && pair.expected.every((word) => text.includes(word)) && a.conversationId !== b.conversationId;
      rows.push({ run, pair: pair.label, status: ok ? 'PASS' : 'FAIL', totalMs: Math.round(performance.now() - start),
        firstTokenA: a.firstTokenMs, firstTokenB: b.firstTokenMs, requestA: a.meta.requestId, requestB: b.meta.requestId,
        fallback: b.result?.memory?.fallback, ...(!ok ? { error: a.error?.code ?? b.error?.code ?? 'expected evidence missing' } : {}) });
    } catch (error) {
      rows.push({ run, pair: pair.label, status: 'FAIL', totalMs: Math.round(performance.now() - start), firstTokenA: null, firstTokenB: null,
        error: error instanceof Error ? error.message : 'request failed' });
    }
    const row = rows.at(-1)!;
    console.log(`run ${run} | ${pair.label.padEnd(16)} | ${row.status} | ${row.totalMs} ms | ${row.error ?? (row.fallback ? 'grounded fallback' : 'model + grounding')}`);
  }
}
console.table(rows.map(({ run, pair, status, totalMs, firstTokenA, firstTokenB, fallback }) => ({ run, pair, status, totalMs, firstTokenA, firstTokenB, fallback })));
const passed = rows.filter((row) => row.status === 'PASS').length;
console.log(`${passed}/${rows.length} pairs passed; ${runs} consecutive runs ${passed === rows.length ? 'PASS' : 'FAIL'}.`);
await writeFile('docs/live-e2e-results.json', JSON.stringify({ timestamp: new Date().toISOString(), provider: 'real configured provider',
  runs, passed, total: rows.length, rows }, null, 2) + '\n');
process.exitCode = passed === rows.length ? 0 : 1;
