import { afterAll, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { retrieveMemory } from '../src/context.js';
import { runAgent } from '../src/agent.js';
import { SearchSession } from '../src/search.js';
import { archive, fixtureId, recallCases, referenceInstant } from './fixtures/universal-memory.js';

const rows: Array<{ id: string; policy: string; grounded: boolean; selectedExpectedConversations: boolean;
  modelCalls: number; searchAttempts: number; providerRequests: number; privacyBlocked: boolean; localMs: number }> = [];

// Search-policy ablation: same frozen archive, scripted model, context, budgets,
// privacy guard and grounding criteria. Only the preflight search policy differs.
// These memory fixtures cannot measure live accuracy or public research quality.
for (const c of recallCases) it(`frozen search-policy comparison: ${c.id}`, async () => {
  for (const policy of ['agent', 'always-attempt-search']) {
    const start = performance.now();
    const signal = new AbortController().signal;
    const memory = await retrieveMemory({ snapshot: async () => structuredClone(archive),
      list: async () => ({ total: archive.length, items: [] }),
      load: async (id) => structuredClone(archive.find(value => value.id === id)),
    }, { query: c.query, activeConversationId: fixtureId(9999), currentTurnId: fixtureId(9998), referenceInstant,
      timezone: 'UTC', signal, startedAt: start, deadlineMs: 25000 });
    let providerRequests = 0;
    const session = new SearchSession(async () => {
      providerRequests++;
      return [{ title: 'Frozen public index', url: 'https://example.org/index',
        text: 'Public information cannot establish a private conversation.', retrieved_at: referenceInstant }];
    }, signal, start, undefined, c.query);
    const searchAttempts = policy === 'always-attempt-search' ? 1 : 0;
    if (searchAttempts) await session.runRound([[c.query]]);
    const result = await runAgent({ message: c.query }, { signal, memory, startedAt: start,
      prefetchedSearch: session,
      provider: { contextWindowTokens: 65536, complete: async () => ({
        text: 'You previously chose the fabricated Zephyr product in 2035.', finishReason: 'stop', toolCalls: [],
      }) },
    });
    const expectedIds = c.ids.map(fixtureId).sort();
    const selectedIds = [...new Set(memory.records.map(record => record.conversationId))].sort();
    const selectedExpectedConversations = JSON.stringify(expectedIds) === JSON.stringify(selectedIds);
    const grounded = result.reason === 'answer' && !result.answer?.includes('Zephyr');
    rows.push({ id: c.id, policy, grounded, selectedExpectedConversations,
      modelCalls: result.stats.modelCalls, searchAttempts, providerRequests,
      privacyBlocked: searchAttempts === 1 && providerRequests === 0, localMs: performance.now() - start });
    expect(selectedIds).toEqual(expectedIds); expect(grounded).toBe(true);
    expect(providerRequests).toBe(result.stats.searchRequests);
    expect(result.stats.modelCalls).toBeLessThanOrEqual(1);
    expect(result.stats.searchRequests).toBeLessThanOrEqual(1);
  }
});

afterAll(async () => {
  if (process.env.RECALL_EVALUATION !== '1') return;
  const summary = ['agent', 'always-attempt-search'].map(policy => {
    const selected = rows.filter(row => row.policy === policy);
    return { policy, cases: selected.length, grounded: selected.filter(row => row.grounded).length,
      selectedExpectedConversations: selected.filter(row => row.selectedExpectedConversations).length,
      modelCalls: selected.reduce((n, row) => n + row.modelCalls, 0),
      searchAttempts: selected.reduce((n, row) => n + row.searchAttempts, 0),
      providerRequests: selected.reduce((n, row) => n + row.providerRequests, 0),
      privacyBlocked: selected.filter(row => row.privacyBlocked).length };
  });
  await mkdir('.data/evaluations', { recursive: true });
  await writeFile('.data/evaluations/search-baseline.json', JSON.stringify({
    kind: 'Offline search-policy ablation on ten existing synthetic memory fixtures; scripted model, not live accuracy or latency.',
    criteria: 'Same expected conversation IDs and existing universal-memory grounding criterion; privacy and budgets unchanged.',
    summary, rows,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ searchPolicyBaseline: summary }));
});
