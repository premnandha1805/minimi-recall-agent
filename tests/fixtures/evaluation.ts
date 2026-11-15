/** Synthetic frozen evidence, not measurements or claims about real product pricing. */
export const instant = '2026-11-17T12:00:00.000Z';
export const oldInstant = '2026-11-16T12:00:00.000Z';
export const shortlist = 'HubSpot, Zoho, Pipedrive, Freshsales, Salesforce';
export const price = (amount: string, day: string, product = 'Neon', plan = 'Launch') =>
  `Product: ${product}; Plan: ${plan}; Region: US; Currency: USD; Price: ${amount}; Billing: monthly; Seats: 1; Basis: per-seat; Conditions: standard; Effective: ${day}.`;
export interface EvalCase { id: string; category: 'web' | 'recall' | 'comparison' | 'reliability';
  mode: string; query: string; expected: string; quality?: string; old?: string; fresh?: string; product?: string; timezone?: string; timestamp?: string;
  baselineQuestion?: string; historicalDay?: string }
const change = 'Have our Neon prices changed since Monday?';
export const cases: EvalCase[] = [
  { id: 'G7A1', category: 'comparison', mode: 'mixed-recall', query: 'On Monday we shortlisted five CRM tools. Have any changed pricing or released something important?', baselineQuestion: 'CRM shortlist', historicalDay: '2026-11-16', expected: 'Cannot verify' },
  { id: 'G7A2', category: 'comparison', mode: 'mixed-recall', query: 'What did I ask on 3 November? Is your answer still correct today?', baselineQuestion: 'Postgres hosting', historicalDay: '2026-11-03', timestamp: '2026-11-03T12:00:00.000Z', expected: 'Cannot verify' },
  { id: 'G7A3', category: 'comparison', mode: 'mixed-recall', query: 'Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?', baselineQuestion: 'Postgres hosting', historicalDay: '2026-11-10', timestamp: '2026-11-10T12:00:00.000Z', expected: 'Cannot verify' },
  { id: 'W1', category: 'web', mode: 'web', query: 'Research Postgres hosting', expected: 'Available [S1]' },
  { id: 'W2', category: 'web', mode: 'bad-id', query: 'Research Postgres hosting', expected: 'INVALID_CITATION' },
  { id: 'W3', category: 'web', mode: 'bad-quote', query: 'Research Postgres hosting', expected: 'quotation warning' },
  { id: 'W4', category: 'web', mode: 'injection', query: 'Research Postgres hosting', expected: 'Available [S1]' },
  ...[
    ['R1', 'Summarize our earlier CRM discussion.'], ['R2', 'Which five CRM tools did we shortlist on Monday?'],
    ['R3', 'What did we discuss on 16 November 2026?'], ['R4', 'What did we discuss yesterday?'],
    ['R5', 'What did we discuss last Tuesday?'], ['R6', 'What did we discuss yesterday?'],
  ].map(([id, query]): EvalCase => ({ id, query, category: 'recall', mode: 'recall', expected: shortlist,
    ...(id === 'R5' ? { timestamp: '2026-11-10T12:00:00.000Z' } : {}),
    ...(id === 'R6' ? { timezone: 'Pacific/Kiritimati', timestamp: '2026-11-17T02:00:00.000Z' } : {}) })),
  { id: 'R7', category: 'recall', mode: 'missing', query: 'Summarize our earlier CRM discussion.', expected: 'did not find' },
  { id: 'R8', category: 'recall', mode: 'ambiguous', query: 'Summarize our earlier CRM discussion.', expected: 'ambiguous' },
  { id: 'R9', category: 'recall', mode: 'stored-injection', query: 'Summarize our earlier CRM discussion.', expected: shortlist },
  ...[
    ['C1', '30', 'Confirmed change'], ['C2', '10', 'Confirmed change'], ['C3', '20', 'No confirmed change'],
  ].map(([id, amount, expected]): EvalCase => ({ id, category: 'comparison', mode: 'comparison', query: change, expected,
    old: price('20','2026-11-15'), fresh: price(amount,'2026-11-17') })),
  { id: 'C4', category: 'comparison', mode: 'comparison', query: change, expected: 'Not comparable', old: price('20','2026-11-15'), fresh: price('30','2026-11-17','Neon','Scale') },
  { id: 'C5', category: 'comparison', mode: 'comparison', query: change, expected: 'Not comparable', old: price('20','2026-11-15'), fresh: price('30','2026-11-17').replace('USD','EUR') },
  { id: 'C6', category: 'comparison', mode: 'comparison', query: change, expected: 'Confirmed change', old: 'The Neon Launch plan costs USD 20 per seat per month in the US, standard terms, effective 15 November 2026.', fresh: 'The Neon Launch plan costs USD 30 per seat per month in the US, standard terms, effective 17 November 2026.', quality: 'Confirmed change' },
  { id: 'C7', category: 'comparison', mode: 'comparison', query: change, expected: 'No confirmed change', old: 'The Neon Launch plan costs USD 20 per seat per month in the US, standard terms, effective 15 November 2026.', fresh: 'The Neon Launch plan costs USD 20 per seat per month in the US, standard terms, effective 17 November 2026.', quality: 'No confirmed change' },
  { id: 'C8', category: 'comparison', mode: 'comparison', query: 'Have our Acme prices changed since Monday?', product: 'Acme', expected: 'Cannot verify', old: price('20','2026-11-15','Acme'), fresh: price('30','2026-11-17','Acme'), quality: 'Confirmed change' },
  { id: 'C9', category: 'comparison', mode: 'no-baseline', query: change, expected: 'Cannot verify', fresh: price('30','2026-11-17') },
  { id: 'C10', category: 'comparison', mode: 'comparison', query: 'Is your previous Postgres recommendation still correct?', expected: 'Cannot verify', old: 'Neon is suitable for our small Postgres workload.', fresh: 'Neon supports PostgreSQL and branching.' },
  { id: 'C11', category: 'comparison', mode: 'comparison', query: change, expected: 'Cannot verify', old: price('20','2026-11-15'), fresh: 'Price: USD 30' },
  { id: 'F1', category: 'reliability', mode: 'provider-failure', query: 'Research Postgres hosting', expected: 'MODEL_FAILED' },
  { id: 'F2', category: 'reliability', mode: 'cancel', query: 'Research Postgres hosting', expected: 'cancelled' },
  { id: 'F3', category: 'reliability', mode: 'timeout', query: 'Research Postgres hosting', expected: 'model_timeout' },
  { id: 'F4', category: 'reliability', mode: 'recovery', query: 'Research Postgres hosting', expected: 'Available [S1]' },
];
