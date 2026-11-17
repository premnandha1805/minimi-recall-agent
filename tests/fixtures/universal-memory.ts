import type { Conversation } from '../../src/memory.js';
export const referenceInstant = '2026-11-17T12:00:00.000Z';
export const fixtureId = (n: number) => `11111111-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
export function history(n: number, contents: string[], timestamp = '2026-11-03T10:00:00.000Z'): Conversation {
  return { schemaVersion: 'recall.memory.v1', id: fixtureId(n), revision: 0, timezone: 'UTC',
    createdAtUtc: timestamp, updatedAtUtc: timestamp, seededMessages: [],
    turns: contents.map((content, i) => ({ id: fixtureId(n + i * 2 + 1), key: `t${i}`, ordinal: i,
      provenance: 'server_recorded', timezone: 'UTC', attempts: [],
      user: { id: fixtureId(n + i * 2 + 2), role: 'user', content, timestamp } })) };
}
export const archive = [
  history(100, ['We are comparing folding bicycles: Brompton, Tern, Dahon.', 'Those options must fit in the lift.']),
  history(200, ['My sister Leena leads the wetland restoration project.']),
  history(300, ['I prefer decaf coffee.', 'Actually, I prefer green tea now.']),
  history(400, ['The garden irrigation prototype uses gravity and clay pots.', 'I will present this topic at a seminar next month.']),
  history(500, ['We discussed migrating the Atlas service.', 'The migration decision is to keep SQLite.']),
  history(600, ['I am working on the lunar observatory proposal.'], '2026-10-15T10:00:00.000Z'),
  history(700, ['My dentist appointment is on 23 November.', 'Actually, make that 25 November.']),
  history(800, ['My dentist appointment is on 29 December.']),
  history(900, ['I asked about weaving a basket.'], '2026-11-16T21:00:00.000Z'),
  history(1000, ['The migration decision for Boreal is to use MariaDB.']),
];
export const recallCases = [
  { id: 'entities', query: 'What bicycles did we compare?', ids: [100] },
  { id: 'relationships', query: "What is my sister's project?", ids: [200] },
  { id: 'corrections', query: 'What did I say about coffee?', ids: [300] },
  // Reconstructed reported failure pattern; the original incident transcript was not supplied.
  { id: 'seminar-regression', query: 'What was my seminar topic?', ids: [400] },
  { id: 'paraphrase', query: 'Recall our Atlas migration decision', ids: [500] },
  { id: 'last-month', query: 'What was I working on last month?', ids: [600] },
  { id: 'multiple-events', query: 'When is my dentist appointment?', ids: [700, 800] },
  { id: 'yesterday-utc', query: 'What did we discuss yesterday?', ids: [900] },
  { id: 'entity-disambiguation', query: 'What did we decide about Boreal migration?', ids: [1000] },
  { id: 'unknown', query: 'What did we decide about the Andromeda telescope?', ids: [] },
] as const;
