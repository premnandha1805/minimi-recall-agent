import { describe, expect, it } from 'vitest';
import { retrieveMemory, type RetrievedMemory } from '../src/context.js';
import { evaluateGroundedRecall } from '../src/recall-answer.js';
import { runAgent } from '../src/agent.js';
import { history, fixtureId, referenceInstant } from './fixtures/universal-memory.js';

function memoryOf(facts: string[], status: RetrievedMemory['status'] = 'found'): RetrievedMemory {
  return { reference: { instant: referenceInstant, timezone: 'UTC' }, recall: true, memoryOnly: true,
    groundedRecall: true, status, matches: facts.length, records: facts.map((content, i) => ({
      conversationId: fixtureId(100 + i), turnId: fixtureId(200 + i), ordinal: 0,
      provenance: 'server_recorded', timezone: 'UTC', evidence: [],
      user: { id: fixtureId(300 + i), content, timestamp: `2026-11-${String(3 + i).padStart(2, '0')}T10:00:00.000Z` },
    })) };
}
function evaluate(memory: RetrievedMemory, answer: string, query: string, indices = [0], quotes?: string[]) {
  return evaluateGroundedRecall(JSON.stringify({ answer, memoryEvidence: indices.map((index, i) => ({
    messageId: memory.records[index].user.id, quote: quotes?.[i] ?? memory.records[index].user.content,
  })) }), memory, query);
}

describe('recall preserves material associations, not just supported words', () => {
  it.each([
    ['Orion-X19', 'Framework'], ['harbor_72', 'Acer'], ['QuasarFleet', 'System76'],
  ])('recovers a correct entity missing its requested identifier: %s', (project, brand) => {
    const memory = memoryOf([`I purchased a computer from ${brand} for ${project}.`]);
    const result = evaluate(memory, brand, `Which computer brand did I buy for ${project}?`);
    expect(result.origin).toBe('recovered');
    expect(result.answer).toContain(brand); expect(result.answer).toContain(project);
  });
  it('accepts complete grounded synthesis without an extra model call', () => {
    const memory = memoryOf(['I purchased a computer from Framework for Orion-X19.']);
    expect(evaluate(memory, 'You purchased a Framework computer for Orion-X19.',
      'Which computer brand did I buy for Orion-X19?').origin).toBe('model');
  });
  it('allows harmless recall framing without relaxing factual token grounding', () => {
    const memory = memoryOf(['I have an Acme meeting on 23 August.']);
    expect(evaluate(memory, 'You told me about an Acme meeting on 23 August.',
      'What meeting did I tell you about?').origin).toBe('model');
  });
  it('recovers incomplete synthesis in one model call with zero search requests', async () => {
    const memory = memoryOf(['I selected Atlas for Orbit-A.']);
    let calls = 0;
    const result = await runAgent({ message: 'Which provider did I select for Orbit-A?' }, {
      memory, signal: new AbortController().signal, recoverRecall: true,
      provider: { contextWindowTokens: 65536, complete: async () => {
        calls++;
        return { text: JSON.stringify({ answer: 'Atlas', memoryEvidence: [{
          messageId: memory.records[0].user.id, quote: memory.records[0].user.content }] }),
        finishReason: 'stop', toolCalls: [] };
      } },
      search: async () => { throw new Error('Pure recall must not search'); },
    });
    expect(calls).toBe(1); expect(result.stats).toMatchObject({ modelCalls: 1, searchRequests: 0 });
    expect(result.generationOrigin).toBe('recovered'); expect(result.answer).toContain('Atlas for Orbit-A');
  });
  it('recovers from an invented message ID even when its quotation and answer are correct', () => {
    const memory = memoryOf(['I selected Atlas for Orbit-A.']);
    const result = evaluateGroundedRecall(JSON.stringify({ answer: 'You selected Atlas for Orbit-A.',
      memoryEvidence: [{ messageId: fixtureId(900), quote: memory.records[0].user.content }] }), memory,
    'Which provider did I select for Orbit-A?');
    expect(result).toMatchObject({ origin: 'recovered', decision: 'evidence_reference' });
    expect(result.answer).toContain('Atlas for Orbit-A');
  });
  it('does not confuse a real turn ID with a user message ID', () => {
    const memory = memoryOf(['I have an Acme meeting on 23 August.']);
    const result = evaluateGroundedRecall(JSON.stringify({ answer: 'You told me about an Acme meeting on 23 August.',
      memoryEvidence: [{ messageId: memory.records[0].turnId, quote: memory.records[0].user.content }] }), memory,
    'What meeting did I tell you about?');
    expect(result).toMatchObject({ origin: 'recovered', decision: 'evidence_reference' });
    expect(result.answer).toContain('Acme meeting on 23 August');
  });
  it('retains conservative recovery for a purchase paraphrase instead of claiming model acceptance', () => {
    const memory = memoryOf(['I purchased a Framework computer for Orion-X19.']);
    const result = evaluate(memory, 'You bought a Framework computer for Orion-X19.',
      'Which computer brand did I buy for Orion-X19?');
    expect(result).toMatchObject({ origin: 'recovered', decision: 'grounding_rejected' });
    expect(result.answer).toContain('Framework computer for Orion-X19');
  });
  it('does not confuse the same entity used by two projects', () => {
    const memory = memoryOf(['I selected Redis for Orbit-A.', 'I selected Redis for Harbor-B.']);
    const result = evaluate(memory, 'You selected Redis for Harbor-B.', 'Which database did I select for Orbit-A?', [1]);
    expect(result.origin).toBe('recovered');
    expect(result.answer).toContain('Redis for Orbit-A');
    expect(result.answer).toContain('Redis for Harbor-B');
  });
  it('rejects an entity/identifier combination assembled from different conversations', () => {
    const memory = memoryOf(['I selected Atlas for Orbit-A.', 'I selected Nimbus for Harbor-B.']);
    const result = evaluate(memory, 'You selected Nimbus for Orbit-A.', 'Which provider did I select for Orbit-A?', [0, 1]);
    expect(result.origin).toBe('recovered');
    expect(result.answer).not.toContain('You selected Nimbus for Orbit-A.');
  });
  it('does not bypass relationship checks by lowercasing a supported entity', () => {
    const memory = memoryOf(['I selected Atlas for Orbit-A.', 'I selected Nimbus for Harbor-B.']);
    const result = evaluate(memory, 'You selected nimbus for Orbit-A.', 'Which provider did I select for Orbit-A?', [0, 1]);
    expect(result.origin).toBe('recovered');
  });
  it('accepts two independently grounded relationships in separate clauses', () => {
    const memory = memoryOf(['I selected Atlas for Orbit-A.', 'I selected Nimbus for Harbor-B.']);
    expect(evaluate(memory, 'You selected Atlas for Orbit-A and Nimbus for Harbor-B.',
      'What did I select for Orbit-A and Harbor-B?', [0, 1]).origin).toBe('model');
  });
  it('does not use omitted model excerpts to hide the identifier during recovery', () => {
    const memory = memoryOf(['I purchased a Framework computer. It was for Orion-X19.']);
    const result = evaluate(memory, 'Framework', 'Which computer brand did I buy for Orion-X19?', [0], ['I purchased a Framework computer.']);
    expect(result.origin).toBe('recovered'); expect(result.answer).toContain('Orion-X19');
  });
  it('never invents a requested identifier absent from the original evidence', () => {
    const memory = memoryOf(['I purchased a Framework computer.']);
    const result = evaluate(memory, 'Framework', 'Which computer brand did I buy for Unknown-X93?');
    expect(result.origin).toBe('recovered'); expect(result.answer).not.toContain('Unknown-X93');
  });
  it('keeps ambiguous evidence visible instead of manufacturing an association', () => {
    const memory = memoryOf(['I bought an Acer computer.', 'I bought an Asus computer.'], 'ambiguous');
    const result = evaluate(memory, 'You bought an Acer computer.', 'Which computer did I buy?', [0]);
    expect(result.origin).toBe('recovered'); expect(result.answer).toContain('ambiguous');
    expect(result.answer).toContain('Acer'); expect(result.answer).toContain('Asus');
  });
  it('retains the original question/assistant pairing without promoting a suggestion to a user decision', () => {
    const memory = memoryOf(['Which provider should I choose for Orbit-A?']);
    memory.records[0].assistant = { id: fixtureId(500), content: 'Consider Atlas for Orbit-A.', timestamp: '2026-11-03T10:01:00.000Z' };
    const text = JSON.stringify({ answer: 'You selected Atlas for Orbit-A.', memoryEvidence: [
      { messageId: memory.records[0].user.id, quote: memory.records[0].user.content },
      { messageId: fixtureId(500), quote: 'Consider Atlas for Orbit-A.' },
    ] });
    const result = evaluateGroundedRecall(text, memory, 'Which provider did I choose for Orbit-A?');
    expect(result.origin).toBe('recovered'); expect(result.answer).toContain('Which provider should I choose');
    expect(result.answer).toContain('assistant answered (unverified)');
  });
  it('preserves date-specific selection and cross-conversation association through actual retrieval', async () => {
    const conversations = [history(10, ['I selected Atlas for Orbit-A.'], '2026-11-03T10:00:00.000Z'),
      history(20, ['I selected Nimbus for Harbor-B.'], '2026-11-04T10:00:00.000Z')];
    const query = 'Which provider did I select for Orbit-A on 3 November 2026?';
    const memory = await retrieveMemory({ snapshot: async () => conversations,
      load: async (id) => conversations.find(c => c.id === id), list: async () => ({ total: 2, items: [] }) }, {
      query, activeConversationId: fixtureId(999), currentTurnId: fixtureId(998), referenceInstant, timezone: 'UTC',
      signal: new AbortController().signal, startedAt: performance.now(), deadlineMs: 25000, alwaysRetrieve: true,
    });
    expect(memory.records.some(r => r.user.content.includes('Orbit-A'))).toBe(true);
    const text = JSON.stringify({ answer: 'You selected Atlas for Orbit-A.', memoryEvidence: [{
      messageId: conversations[0].turns[0].user.id, quote: conversations[0].turns[0].user.content }] });
    const result = evaluateGroundedRecall(text, memory, query);
    expect(result.answer).toContain('Atlas'); expect(result.answer).toContain('Orbit-A');
    expect(result.answer).not.toContain('Nimbus for Orbit-A');
  });
});
