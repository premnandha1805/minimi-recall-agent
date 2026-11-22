import { describe, expect, it } from 'vitest';
import { retrieveMemory } from '../src/context.js';
import { evaluateGroundedRecall, groundedRecallAnswer, groundHistoricalProse } from '../src/recall-answer.js';
import { runAgent } from '../src/agent.js';
import { history, fixtureId, referenceInstant } from './fixtures/universal-memory.js';

const opts = (query: string) => ({
  query,
  activeConversationId: fixtureId(999),
  currentTurnId: fixtureId(998),
  referenceInstant,
  timezone: 'UTC',
  signal: new AbortController().signal,
  startedAt: performance.now(),
  deadlineMs: 25000,
  alwaysRetrieve: true,
});

const frozen = (conversations: ReturnType<typeof history>[]) => ({
  load: async (id: string) => conversations.find((c) => c.id === id),
  list: async () => ({
    total: conversations.length,
    items: conversations.map((v) => ({
      id: v.id,
      createdAtUtc: v.createdAtUtc,
      updatedAtUtc: v.updatedAtUtc,
      turnCount: v.turns.length,
    })),
  }),
  snapshot: async () => conversations,
});

describe('Recall Agent Synthesis & Grounding Regressions (Tasks 1-8)', () => {
  it('accepts grounded JSON alone but never leaks a prose preamble around valid evidence', async () => {
    const conversation = history(10, ['I selected PostgreSQL as the database for CedarLedger.']);
    const query = 'Which database did I select for CedarLedger?';
    const memory = await retrieveMemory(frozen([conversation]), opts(query));
    const json = JSON.stringify({ answer: 'You selected PostgreSQL as the database for CedarLedger.',
      memoryEvidence: [{ messageId: conversation.turns[0].user.id, quote: conversation.turns[0].user.content }] });
    expect(evaluateGroundedRecall(json, memory, query)).toMatchObject({ origin: 'model' });
    const prefixed = evaluateGroundedRecall('You selected MongoDB.\n\n' + json, memory, query);
    expect(prefixed.origin).toBe('recovered');
    expect(prefixed.answer).not.toContain('MongoDB');
    expect(prefixed.answer).toContain('PostgreSQL');
  });
  // 1. Multi-conversation natural synthesis
  it('1. multi-conversation natural synthesis produces concise answer without irrelevant transcript dumps', async () => {
    const convA = history(10, ['I have an Infosys meeting on 23 August.']);
    const convB = history(20, ['I have a Booking Holdings interview on 15 September.'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), opts('When is my Booking Holdings interview?'));

    const modelJson = JSON.stringify({
      answer: 'Your Booking Holdings interview is on 15 September.',
      memoryEvidence: [{ messageId: convB.turns[0].user.id, quote: 'I have a Booking Holdings interview on 15 September.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'When is my Booking Holdings interview?');

    expect(result.origin).toBe('model');
    expect(result.answer).toContain('Booking Holdings interview is on 15 September');
    expect(result.answer).not.toContain('Infosys');
    expect(result.answer).not.toContain('Conversation ');
    expect(result.answer).not.toContain('> ');
  });

  // 2. Historical corrections and superseded decisions
  it('2. synthesizes historical corrections and superseded decisions chronologically', async () => {
    const conv = history(10, ['I chose MongoDB as my database.', 'Actually, use PostgreSQL instead.']);
    const memory = await retrieveMemory(frozen([conv]), opts('Which database did I finally choose?'));

    const modelJson = JSON.stringify({
      answer: 'You initially chose MongoDB but later changed the decision to PostgreSQL.',
      memoryEvidence: [
        { messageId: conv.turns[0].user.id, quote: 'I chose MongoDB as my database.' },
        { messageId: conv.turns[1].user.id, quote: 'Actually, use PostgreSQL instead.' },
      ],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Which database did I finally choose?');

    expect(result.origin).toBe('model');
    expect(result.answer).toContain('MongoDB');
    expect(result.answer).toContain('PostgreSQL');
    expect(result.answer).not.toContain('> ');
  });

  // 3. Questions versus factual statements
  it('3. does not treat historical questions as facts when answering factual queries', async () => {
    const convA = history(10, ['What is a good interview question for Amazon?']);
    const convB = history(20, ['I have an interview with Amazon on December 10.'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), opts('When is my Amazon interview?'));

    expect(memory.records.length).toBeGreaterThanOrEqual(1);
    expect(memory.records[0].user.content).toContain('December 10');
  });

  // 4. Unsupported earlier assistant claims
  it('4. treats unverified assistant claims as unverified rather than user facts', async () => {
    const conv = history(10, ['Compare weaving materials.']);
    conv.seededMessages.push({
      id: fixtureId(99),
      role: 'assistant',
      content: 'Cotton, flax, hemp, jute, wool.',
      timestamp: conv.createdAtUtc,
      provenance: 'client_seed',
      mergeKey: 'list',
      receivedAtUtc: conv.createdAtUtc,
    });
    const memory = await retrieveMemory(frozen([conv]), opts('Recall our wool comparison'));
    const answer = groundedRecallAnswer('You chose silk.', memory);

    expect(answer).toContain('Cotton, flax, hemp, jute, wool.');
    expect(answer).toContain('assistant answered (unverified)');
    expect(answer).not.toContain('silk');
  });

  // 5. References within the same conversation
  it('5. resolves contextual references like "that company" within the same conversation', async () => {
    const conv = history(10, ['I am applying to Acme Corp.', 'My interview for that company is on December 10.']);
    const memory = await retrieveMemory(frozen([conv]), opts('When is my interview at Acme Corp?'));

    const modelJson = JSON.stringify({
      answer: 'Your interview at Acme Corp is on December 10.',
      memoryEvidence: [
        { messageId: conv.turns[0].user.id, quote: 'I am applying to Acme Corp.' },
        { messageId: conv.turns[1].user.id, quote: 'My interview for that company is on December 10.' },
      ],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'When is my interview at Acme Corp?');

    expect(result.origin).toBe('model');
    expect(result.answer).toContain('Acme Corp is on December 10');
  });

  // 6. References across conversations when supported
  it('6. resolves cross-conversation topic references when explicitly supported', async () => {
    const convA = history(10, ['I am building the Atlas project.']);
    const convB = history(20, ['The Atlas project database was chosen as PostgreSQL.'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), opts('What database did I choose for Atlas?'));

    expect(memory.records.map((r) => r.user.content)).toContain('The Atlas project database was chosen as PostgreSQL.');
  });

  // 7. Similar but unrelated events remain distinct
  it('7. distinguishes meetings and interviews without alias collision', async () => {
    const convA = history(10, ['I have an Infosys meeting on 23 August.']);
    const convB = history(20, ['I have an interview on November 23.'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), opts('When is my interview?'));

    expect(memory.records[0].user.content).toContain('interview on November 23');
    expect(memory.records[0].user.content).not.toContain('Infosys');
  });

  // 8. Multiple interviews on different dates
  it('8. naturally synthesizes multiple distinct events without dumping transcripts', async () => {
    const conv = history(10, [
      'I have a Google interview on December 5.',
      'I have a Microsoft interview on December 10.',
    ]);
    const memory = await retrieveMemory(frozen([conv]), opts('What interviews do I have scheduled?'));

    const modelJson = JSON.stringify({
      answer: 'You have a Google interview on December 5 and a Microsoft interview on December 10.',
      memoryEvidence: [
        { messageId: conv.turns[0].user.id, quote: 'I have a Google interview on December 5.' },
        { messageId: conv.turns[1].user.id, quote: 'I have a Microsoft interview on December 10.' },
      ],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'What interviews do I have scheduled?');

    expect(result.origin).toBe('model');
    expect(result.answer).toContain('Google interview on December 5');
    expect(result.answer).toContain('Microsoft interview on December 10');
    expect(result.answer).not.toContain('Conversation ');
  });

  // 9. Negated or contradictory evidence
  it('9. blocks fabrication of contradicted or negated personal statements', () => {
    const conv = history(10, ['I chose PostgreSQL.']);
    const memory: Parameters<typeof groundHistoricalProse>[1] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'found',
      records: [{
        conversationId: conv.id,
        turnId: conv.turns[0].id,
        ordinal: 0,
        provenance: 'server_recorded',
        user: conv.turns[0].user,
        evidence: [],
      }],
      matches: 1,
    };
    const fabricatedClaim = 'You chose MongoDB. PostgreSQL is a relational database.';
    const result = groundHistoricalProse(fabricatedClaim, memory);

    expect(result).not.toContain('You chose MongoDB');
    expect(result).toContain('PostgreSQL is a relational database');
  });

  // 10. Unrelated distracting conversations
  it('10. ignores unrelated casual questions during factual memory retrieval', async () => {
    const convA = history(10, ['I bought a notebook computer from Dell.']);
    const convB = history(20, ['What is the weather like in Mumbai?'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), { ...opts('Which laptop brand did I buy?'), alwaysRetrieve: true });

    expect(memory.records.length).toBe(1);
    expect(memory.records[0].user.content).toContain('Dell');
    expect(memory.status).toBe('found');
  });

  // 11. Ambiguous historical references
  it('11. marks status ambiguous when historical references have competing candidates', async () => {
    const convA = history(10, ['My interview is on November 23.']);
    const convB = history(20, ['My interview is on December 5.'], '2026-11-04T10:00:00.000Z');
    const memory = await retrieveMemory(frozen([convA, convB]), opts('When is my interview?'));

    expect(memory.status).toBe('ambiguous');
  });

  // 12. Explicit verbatim transcript requests
  it('12. preserves exact blockquoted transcripts when explicitly requested', () => {
    const conv = history(10, ['I chose PostgreSQL.']);
    const memory: Parameters<typeof evaluateGroundedRecall>[1] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'found',
      records: [{
        conversationId: conv.id,
        turnId: conv.turns[0].id,
        ordinal: 0,
        provenance: 'server_recorded',
        user: conv.turns[0].user,
        evidence: [],
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You chose PostgreSQL.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I chose PostgreSQL.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Show me the original transcript');

    expect(result.answer).toContain('> I chose PostgreSQL.');
    expect(result.answer).toContain(`message ${conv.turns[0].user.id}`);
  });

  // 13. Missing historical evidence
  it('13. handles missing historical evidence with explicit unsupported outcome', () => {
    const memory: Parameters<typeof evaluateGroundedRecall>[1] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'not_found',
      records: [],
      matches: 0,
    };
    const modelJson = JSON.stringify({ answer: '', memoryEvidence: [] });
    const result = evaluateGroundedRecall(modelJson, memory, 'Where did I buy my jacket?');

    expect(result.origin).toBe('recovered');
    expect(result.answer).toContain('do not establish a definite answer');
  });

  // 14. Unsupported model-generated conclusions
  it('14. catches ungrounded entities in model answer and falls back to recovered', () => {
    const conv = history(10, ['My favorite fabric is linen.']);
    const memory: Parameters<typeof evaluateGroundedRecall>[1] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'found',
      records: [{
        conversationId: conv.id,
        turnId: conv.turns[0].id,
        ordinal: 0,
        provenance: 'server_recorded',
        user: conv.turns[0].user,
        evidence: [],
      }],
      matches: 1,
    };
    // The answer introduces Ferrari which appears nowhere in the evidence quote
    const modelJson = JSON.stringify({
      answer: 'You bought a red Ferrari.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'My favorite fabric is linen.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'What car did I buy?');

    // Because Ferrari is ungrounded, evaluateGroundedRecall falls back to the blockquote transcript
    expect(result.answer).toContain('Here is the relevant stored conversation:');
    expect(result.answer).toContain('> My favorite fabric is linen.');
    expect(result.answer).not.toContain('Ferrari');
  });

  // 15. Memory after failed model requests
  it('15. returns recovered historical evidence when model fails or throws', async () => {
    const conv = history(10, ['I chose PostgreSQL.']);
    const memory: Parameters<typeof runAgent>[1]['memory'] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'found',
      records: [{
        conversationId: conv.id,
        turnId: conv.turns[0].id,
        ordinal: 0,
        provenance: 'server_recorded',
        user: conv.turns[0].user,
        evidence: [],
      }],
      matches: 1,
      groundedRecall: true,
    };

    const res = await runAgent(
      { message: 'Which database did I choose?' },
      {
        memory,
        recoverRecall: true,
        signal: new AbortController().signal,
        provider: {
          contextWindowTokens: 65536,
          complete: async () => {
            throw new Error('Upstream provider unavailable');
          },
        },
      }
    );

    expect(res.status).toBe('completed');
    expect(res.generationOrigin).toBe('recovered');
    expect(res.answer).toContain('PostgreSQL');
    expect(res.answer).toContain('model was unavailable');
  });

  // 16. Preservation of streaming and retry behavior
  it('16. suppresses raw JSON stream during recall and streams only validated final answer', async () => {
    const conv = history(10, ['I selected PostgreSQL.']);
    const memory: Parameters<typeof runAgent>[1]['memory'] = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true,
      memoryOnly: true,
      status: 'found',
      records: [{
        conversationId: conv.id,
        turnId: conv.turns[0].id,
        ordinal: 0,
        provenance: 'server_recorded',
        user: conv.turns[0].user,
        evidence: [],
      }],
      matches: 1,
      groundedRecall: true,
    };

    const streamedDeltas: string[] = [];
    const modelJson = JSON.stringify({
      answer: 'You selected PostgreSQL.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I selected PostgreSQL.' }],
    });

    const res = await runAgent(
      { message: 'What database did I select?' },
      {
        memory,
        signal: new AbortController().signal,
        onText: async (text) => {
          streamedDeltas.push(text);
        },
        provider: {
          contextWindowTokens: 65536,
          complete: async (req) => {
            // Raw streaming callback from model
            await req.onText?.(modelJson);
            return { text: modelJson, finishReason: 'stop', toolCalls: [] };
          },
        },
      }
    );

    expect(res.status).toBe('completed');
    expect(res.answer).toBe('You selected PostgreSQL.');
    // Intermediate JSON should NOT have been streamed to onText
    expect(streamedDeltas.some((d) => d.includes('{"answer"'))).toBe(false);
    // The final validated answer should have been delivered
    expect(streamedDeltas).toContain('You selected PostgreSQL.');
  });
});

// Phase 1 Adversarial Factual-Grounding Regressions
describe('Phase 1 Adversarial Factual-Grounding Regressions', () => {
  // 1. Subject-object relationship reversal
  it('1. rejects subject-object relationship reversal (Alice hired Bob vs Bob hired Alice)', () => {
    const conv = history(10, ['Alice hired Bob at Google.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'Bob hired Alice at Google.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'Alice hired Bob at Google.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Who hired whom?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('Bob hired Alice at Google.');
  });

  // 2. Numerical predicate binding
  it('2. rejects wrong salary/number assignment (Offered 120000, requested 150000 vs Offered 150000)', () => {
    const conv = history(10, ['I was offered 120000 but I asked for 150000.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You were offered 150000.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I was offered 120000 but I asked for 150000.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'What was I offered?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You were offered 150000.');
  });

  // 3. Lowercase entity fabrication
  it('3. rejects fabricated lowercase entity (I chose sqlite vs I selected postgres)', () => {
    const conv = history(10, ['I chose sqlite.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You selected postgres.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I chose sqlite.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Which database did I choose?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You selected postgres.');
  });

  // 4. Cancelled event described as upcoming/active
  it('4. rejects cancelled event presented as upcoming (Cancelled interview presented as active)', () => {
    const conv = history(10, ['My Google interview on December 5 was cancelled.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You have a Google interview on December 5.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'My Google interview on December 5 was cancelled.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'When is my Google interview?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You have a Google interview on December 5.');
  });

  // 5. Explicit negation reversed
  it('5. rejects explicit negation reversed (No interview presented as scheduled)', () => {
    const conv = history(10, ['I have no interview scheduled with Google.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You have an interview scheduled with Google.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I have no interview scheduled with Google.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Do I have an interview with Google?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You have an interview scheduled with Google.');
  });

  // 6. Entity-date swapping across distinct records
  it('6. rejects entity-date swapping across distinct records (Google Dec 5 and Microsoft Dec 10 swapped)', () => {
    const convA = history(10, ['I have a Google interview on December 5th.']);
    const convB = history(20, ['I have a Microsoft interview on December 10th.'], '2026-11-04T10:00:00.000Z');
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [
        { conversationId: convA.id, turnId: convA.turns[0].id, ordinal: 0, provenance: 'server_recorded' as const, user: convA.turns[0].user, evidence: [] },
        { conversationId: convB.id, turnId: convB.turns[0].id, ordinal: 0, provenance: 'server_recorded' as const, user: convB.turns[0].user, evidence: [] },
      ],
      matches: 2,
    };
    const modelJson = JSON.stringify({
      answer: 'Your Google interview is on December 10.',
      memoryEvidence: [
        { messageId: convA.turns[0].user.id, quote: 'I have a Google interview on December 5th.' },
        { messageId: convB.turns[0].user.id, quote: 'I have a Microsoft interview on December 10th.' },
      ],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'When is my Google interview?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('Your Google interview is on December 10.');
  });

  // 7. Reversed chronological correction
  it('7. rejects reversed chronological correction (MongoDB -> PostgreSQL correction reversed)', () => {
    const conv = history(10, ['I chose MongoDB as my database.', 'Actually, use PostgreSQL instead.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [
        { conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0, provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: [] },
        { conversationId: conv.id, turnId: conv.turns[1].id, ordinal: 1, provenance: 'server_recorded' as const, user: conv.turns[1].user, evidence: [] },
      ],
      matches: 2,
    };
    const modelJson = JSON.stringify({
      answer: 'You chose PostgreSQL, but changed to MongoDB.',
      memoryEvidence: [
        { messageId: conv.turns[0].user.id, quote: 'I chose MongoDB as my database.' },
        { messageId: conv.turns[1].user.id, quote: 'Actually, use PostgreSQL instead.' },
      ],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Which database did I choose?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You chose PostgreSQL, but changed to MongoDB.');
  });

  // 8. Researched vs selected
  it('8. rejects researching presented as selected (Researched Redis presented as selected/opted)', () => {
    const conv = history(10, ['I researched Redis and DynamoDB.']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'You opted for Redis.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'I researched Redis and DynamoDB.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Which database did I select?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You opted for Redis.');
  });

  // 9. Assistant suggestion as user choice
  it('9. rejects assistant suggestion presented as user choice (Assistant DynamoDB suggestion presented as user database)', () => {
    const conv = history(10, ['What database should I consider?']);
    const asstMsg = {
      id: fixtureId(50),
      content: 'You could choose AWS DynamoDB.',
      timestamp: '2026-11-03T10:01:00.000Z',
    };
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user,
        assistant: asstMsg, evidence: [],
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'Your database is AWS DynamoDB.',
      memoryEvidence: [{ messageId: asstMsg.id, quote: 'You could choose AWS DynamoDB.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'What database did I confirm?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('Your database is AWS DynamoDB.');
  });

  // 10. User question as completed purchase
  it('10. rejects user question presented as completed purchase (Should I buy Dell laptop presented as completed purchase)', () => {
    const conv = history(10, ['Should I buy the Dell laptop?']);
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'found' as const,
      records: [{
        conversationId: conv.id, turnId: conv.turns[0].id, ordinal: 0,
        provenance: 'server_recorded' as const, user: conv.turns[0].user, evidence: []
      }],
      matches: 1,
    };
    const modelJson = JSON.stringify({
      answer: 'The Dell laptop was your choice.',
      memoryEvidence: [{ messageId: conv.turns[0].user.id, quote: 'Should I buy the Dell laptop?' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Which laptop did I buy?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('The Dell laptop was your choice.');
  });

  // 11. Ambiguous records resolved arbitrarily
  it('11. rejects arbitrary choice among ambiguous records (Ambiguous Dell/Lenovo records resolved arbitrarily)', () => {
    const convA = history(10, ['I bought a laptop from Dell.']);
    const convB = history(20, ['I bought a laptop from Lenovo.'], '2026-11-04T10:00:00.000Z');
    const memory = {
      reference: { instant: referenceInstant, timezone: 'UTC' },
      recall: true, memoryOnly: true, status: 'ambiguous' as const,
      records: [
        { conversationId: convA.id, turnId: convA.turns[0].id, ordinal: 0, provenance: 'server_recorded' as const, user: convA.turns[0].user, evidence: [] },
        { conversationId: convB.id, turnId: convB.turns[0].id, ordinal: 0, provenance: 'server_recorded' as const, user: convB.turns[0].user, evidence: [] },
      ],
      matches: 2,
    };
    const modelJson = JSON.stringify({
      answer: 'You bought a laptop from Dell.',
      memoryEvidence: [{ messageId: convA.turns[0].user.id, quote: 'I bought a laptop from Dell.' }],
    });
    const result = evaluateGroundedRecall(modelJson, memory, 'Where did I buy my laptop?');
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toBe('You bought a laptop from Dell.');
  });
});
