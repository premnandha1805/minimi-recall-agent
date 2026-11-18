import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ConversationStore } from '../src/memory.js';
import { retrieveMemory } from '../src/context.js';
import { createModelProvider, ModelProviderError, type ModelProvider, type ModelResponse, type ModelRequest } from '../src/model.js';
import { readChatStream } from '../public/api.js';
import { azureEnv, wire, json, meta, result as fixtureResult } from './fixtures/chat-stream.js';
import { encodeEvent } from '../src/sse.js';
import { runAgent } from '../src/agent.js';
import { COMPARISON_INSTRUCTIONS } from '../src/verification.js';
import { SearchSession } from '../src/search.js';
import { evaluateLivePair, type LiveTurnOutput } from '../scripts/live-e2e.js';

const roots: string[] = []; const apps: ReturnType<typeof buildServer>[] = []; const stores: ConversationStore[] = [];
const stop = (text: string): ModelResponse => ({ text, toolCalls: [], finishReason: 'stop' });
const tool = (queries: string[]): ModelResponse => ({
  text: '', finishReason: 'tool_calls', toolCalls: [
    { id: 'search_one', name: 'web_search', arguments: JSON.stringify({ queries }) }]
});
async function directory() { const root = await fs.mkdtemp(join(tmpdir(), 'recall-correctness-')); roots.push(root); return root; }
async function setup(facts: string[] = [], complete?: ModelProvider['complete']) {
  const root = await directory(); const store = await ConversationStore.open({ directory: root });
  for (const fact of facts) { const c = await store.create('UTC'); await store.addTurn(c.id, { key: randomUUID(), content: fact }); }
  await store.close();
  const model = vi.fn<ModelProvider['complete']>(complete ?? (async () => stop('Hello.')));
  const search = vi.fn(async (_query: string) => [{
    title: 'Public fixture', url: 'https://example.com/public',
    text: 'Public evidence.', retrieved_at: new Date().toISOString()
  }]);
  // No fetchImpl: this exercises production routing and recovery, not the legacy JSON path.
  const app = buildServer({
    config: loadConfig({ ...azureEnv, NODE_ENV: 'production' }), memoryDirectory: root,
    logger: false, provider: { contextWindowTokens: 65536, complete: model }, search
  }); apps.push(app);
  return { app, model, search, root };
}
async function chat(app: ReturnType<typeof buildServer>, message: string) {
  const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { message, timezone: 'UTC' } });
  expect(response.statusCode).toBe(200);
  return { response, ...(await readChatStream(new Response(response.body))) };
}
afterEach(async () => {
  vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('independent-review production regressions', () => {
  it('keeps web_search available for an ordinary public factual question', async () => {
    let calls = 0;
    const h = await setup([], async (input) => {
      if (++calls === 1) return input.tools.length ? tool(['2024 Nobel Prize Physics official winners']) : stop('Tool unavailable.');
      return stop('The official evidence is available [S1].');
    });
    const result = await chat(h.app, 'Who won the 2024 Nobel Prize in Physics?');
    expect(h.model.mock.calls[0][0].tools.map((t) => t.name)).toEqual(['web_search']);
    expect(h.search).toHaveBeenCalledTimes(1); expect(result.result?.sources).toHaveLength(1);
  });
  it('does not prefetch the raw mixed private prompt', async () => {
    const h = await setup([], async (input) => input.messages.some((m) => m.role === 'tool') ?
      stop('Public release notes [S1].') : tool(['PostgreSQL official release notes']));
    await chat(h.app, 'My confidential appointment with Leena has case code ZX-9182. Search the web for PostgreSQL release notes.');
    expect(h.search.mock.calls.length).toBeGreaterThan(0);
    expect(h.search.mock.calls.map(([q]) => q).join(' ')).not.toMatch(/Leena|ZX-9182|confidential|appointment/i);
  });
  it('resolves all five shortlist entities before consuming the first search round', async () => {
    const names = ['HubSpot', 'Zoho', 'Pipedrive', 'Freshsales', 'Salesforce']; let calls = 0;
    const h = await setup([`We shortlisted five public CRM tools: ${names.join(', ')}.`], async () =>
      ++calls === 1 ? tool(names.map((name) => `${name} official pricing`)) : stop('Cannot verify a pricing change from the available baseline [S1].'));
    await chat(h.app, 'Have those five CRM tools changed pricing?');
    const sent = h.search.mock.calls.map(([q]) => q);
    for (const name of names) expect(sent.some((q) => q.includes(name)), `${name} was not searched`).toBe(true);
    expect(sent).toHaveLength(5); expect(sent.join(' ')).not.toContain('those five');
  });
  it('aligns pure recall instructions, structured evidence, concise output and visible stream', async () => {
    const fact = 'I have an Infosys meeting on 23 August.';
    const h = await setup([fact], async (input) => {
      const data = JSON.parse(input.messages.find((m) => m.content.startsWith('{"untrustedHistoricalData"'))!.content).untrustedHistoricalData;
      if (!input.messages[0].content.includes('memoryEvidence')) {
        await input.onText?.('You have an Infosys meeting on 23 August.');
        return stop('You have an Infosys meeting on 23 August.');
      }
      const selected = data.records[0].user;
      const text = JSON.stringify({ memoryEvidence: [{ messageId: selected.id, quote: selected.content }] });
      await input.onText?.(text); return stop(text);
    });
    const r = await chat(h.app, 'What meeting did I tell you about?');
    expect(r.result?.message.content).toMatch(/^You have an Infosys meeting on 23 August\./);
    expect(r.result).toMatchObject({ generation: { origin: 'model' } });
    expect(h.search).not.toHaveBeenCalled();
    const visible: string[] = []; await readChatStream(new Response(r.response.body), { onDelta: (s) => { visible.push(s); } });
    expect(visible.join('')).toBe(r.result?.message.content);
  });
  it('does not stream an invented historical name or count rejected prose as model synthesis', async () => {
    const h = await setup(['I purchased a notebook computer from Dell.'], async (input) => {
      await input.onText?.('You bought an Apple laptop for 9000.'); return stop('You bought an Apple laptop for 9000.');
    });
    const r = await chat(h.app, 'Which laptop brand did I buy?');
    expect(r.response.body).not.toMatch(/Apple|9000/);
    expect(r.result).toMatchObject({ generation: { origin: 'recovered' }, memory: { fallback: true } });
  });
  it('fails ordinary generation honestly even when related archive text exists', async () => {
    const h = await setup(['My private recursion project password hint is MoonCedar.'], async () => { throw new ModelProviderError('HTTP_ERROR', 401); });
    const r = await chat(h.app, 'Explain recursion.');
    expect(r.result).toBeUndefined(); expect(r.error?.code).toBe('MODEL_FAILED');
    expect(r.response.body).not.toContain('MoonCedar');
    const c = (await h.app.inject(`/api/conversations/${r.response.headers['x-conversation-id']}`)).json();
    expect(c.turns[0].user.content).toBe('Explain recursion.'); expect(c.turns[0].attempts[0].status).toBe('failed');
    expect(c.turns[0].attempts[0].errorMessage.status).toBe('error');
  });
  it('omits tool_choice in JSON final synthesis after a real tool transcript', async () => {
    const network = vi.fn<typeof fetch>(async () => json(wire()));
    await createModelProvider(loadConfig(azureEnv), network).complete({
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'web_search', arguments: '{"queries":["official docs"]}' }] },
        { role: 'tool', toolCallId: 'one', content: 'Public evidence' }], tools: [], maxOutputTokens: 100, signal: new AbortController().signal
    });
    const body = JSON.parse(String(network.mock.calls[0][1]?.body)); expect(body.tool_choice).toBeUndefined(); expect(body.tools).toBeUndefined();
  });
  it('isolates a rejected B write from A snapshots and future flushes', async () => {
    const root = await directory(); const store = await ConversationStore.open({ directory: root, cachedSnapshots: true }); stores.push(store);
    const a = await store.create(); const b = await store.create(); await store.addTurn(a.id, { key: 'a', content: 'Healthy A.' });
    let entered!: () => void; const atRename = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    const original = fs.rename; const name = createHash('sha256').update(b.id).digest('hex');
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(to).endsWith(`${name}.json`)) { entered(); await held; throw new Error('Injected disk failure'); } return original(from, to); });
    const failed = store.addTurn(b.id, { key: 'b', content: 'Uncommitted B.' }); const observed = failed.catch((e) => e);
    await atRename; const snapshot = store.snapshot(); const flushed = store.flush();
    // Observe both promises immediately, so reproduction cannot create unhandled rejections.
    const results = Promise.allSettled([snapshot, flushed]); release(); expect((await observed).code).toBe('IO');
    const settled = await results; expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((settled[0] as PromiseFulfilledResult<any>).value.find((c: any) => c.id === a.id).turns[0].user.content).toBe('Healthy A.');
  });
  it('marks a direct synonym match as a match, not adjacent evidence', async () => {
    const root = await directory(); const store = await ConversationStore.open({ directory: root, cachedSnapshots: true }); stores.push(store);
    const c = await store.create(); await store.addTurn(c.id, { key: 'buy', content: 'I purchased a notebook computer from Dell.' });
    const found = await retrieveMemory(store, {
      query: 'What is my laptop brand?', activeConversationId: randomUUID(), currentTurnId: randomUUID(),
      referenceInstant: new Date().toISOString(), timezone: 'UTC', signal: new AbortController().signal, startedAt: performance.now(), deadlineMs: 25000, alwaysRetrieve: true
    });
    expect(found.records[0].selection).toBe('match');
  });
  it('limits discovery to root tests, excluding the existing nested clean checkout', () => {
    const listed = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly'], { encoding: 'utf8' });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split(/\r?\n/).every((file) => file.startsWith('tests/'))).toBe(true);
  });
  it('clears the previous draft when the next model attempt starts', async () => {
    const answer = { ...fixtureResult, message: { ...fixtureResult.message, content: 'Current answer.' } };
    const sse = encodeEvent('meta', meta) + encodeEvent('progress', { phase: 'accepted' }) +
      encodeEvent('progress', { phase: 'model_started', call: 1 }) + encodeEvent('delta', { text: 'Failed draft.' }) +
      encodeEvent('progress', { phase: 'model_started', call: 2 }) + encodeEvent('delta', { text: 'Current answer.' }) +
      encodeEvent('result', answer) + encodeEvent('done', { outcome: 'completed', messageId: answer.message.id });
    let visible = '';
    await readChatStream(new Response(sse), { onDelta: (text) => { visible += text; }, onDraftReset: () => { visible = ''; } });
    expect(visible).toBe('Current answer.');
  });
  it('preserves comparison instructions, original memory and web evidence on retry', async () => {
    const signal = new AbortController().signal;
    const session = new SearchSession(async () => [{
      title: 'Public baseline', url: 'https://example.com/pricing',
      text: 'Published pricing evidence.', retrieved_at: new Date().toISOString()
    }], signal, performance.now());
    await session.runRound([['Public pricing']]);
    let calls = 0; const requests: ModelRequest[] = [];
    const response = await runAgent({ message: 'Has PostgreSQL pricing changed since we last discussed it?' }, {
      signal, recoverRecall: true, prefetchedSearch: session,
      memory: {
        recall: true, memoryOnly: false, status: 'found', matches: 1, reference: { instant: new Date().toISOString(), timezone: 'UTC' },
        records: [{
          conversationId: randomUUID(), turnId: randomUUID(), ordinal: 0, provenance: 'server_recorded',
          user: { id: randomUUID(), content: 'We discussed PostgreSQL hosting.', timestamp: new Date().toISOString() }, evidence: session.sources
        }]
      },
      provider: {
        contextWindowTokens: 65536, complete: async (input) => {
          requests.push(input);
          if (++calls === 1) throw new ModelProviderError('HTTP_ERROR', 503);
          return stop('Cannot verify: insufficient comparable evidence [S1].');
        }
      }
    });
    expect(response.reason).toBe('answer'); expect(calls).toBe(2);
    expect(requests[0].messages.some((m) => m.role === 'system' && m.content === COMPARISON_INSTRUCTIONS)).toBe(true);
    expect(requests[1].messages.some((m) => m.role === 'system' && m.content === COMPARISON_INSTRUCTIONS)).toBe(true);
    expect(JSON.stringify(requests[1].messages)).toContain('untrustedWebSearchData');
    expect(JSON.stringify(requests[1].messages)).toContain('Published pricing evidence.');
  });
  it('refuses unbounded quarantine growth without deleting damaged originals', async () => {
    const root = await directory(); let db = await ConversationStore.open({ directory: root, recoverCorrupt: true });
    const c = await db.create(); await db.addTurn(c.id, { key: 'a', content: 'A fact.' }); await db.close();
    const name = createHash('sha256').update(c.id).digest('hex');
    for (let i = 0; i < 17; i++) await fs.writeFile(join(root, '.backups', `${name}.json.${randomUUID()}.corrupt`), '{broken');
    const reopened = ConversationStore.open({ directory: root, recoverCorrupt: true }).then((s) => { stores.push(s); return s; });
    await expect(reopened).rejects.toMatchObject({ code: 'LIMIT' });
    expect((await fs.readdir(join(root, '.backups'))).filter((f) => f.endsWith('.corrupt'))).toHaveLength(17);
  });

  // Blocker 1: Live E2E pair evaluation strictly distinguishes model synthesis from deterministic recovery.
  const turn = (id: string, content: string, extra: Partial<NonNullable<LiveTurnOutput['result']>> = {}): LiveTurnOutput => ({
    conversationId: id,
    firstTokenMs: 100,
    result: { ...fixtureResult, message: { ...fixtureResult.message, content }, ...extra },
  });

  it('live evaluator marks genuine validated model synthesis as PASS', () => {
    const verdict = evaluateLivePair(
      turn('conv-a', 'Saved.', { generation: { origin: 'model' } }),
      turn('conv-b', 'You have an Infosys meeting on 23 August.', {
        generation: { origin: 'model' },
        memory: { earlierConversations: 1, fallback: false },
      }),
      ['Infosys', '23 August'],
    );
    expect(verdict).toEqual({ status: 'PASS', origin: 'model', fallback: false });
  });

  it('live evaluator reports deterministic recovery as RECOVERED, never model PASS', () => {
    const recoveredByOrigin = evaluateLivePair(
      turn('conv-a', 'Saved.', { generation: { origin: 'model' } }),
      turn('conv-b', 'Here is the stored quote: Infosys on 23 August.', {
        generation: { origin: 'recovered' },
        memory: { earlierConversations: 1, fallback: true },
      }),
      ['Infosys', '23 August'],
    );
    expect(recoveredByOrigin).toEqual({ status: 'RECOVERED', origin: 'recovered', fallback: true });

    const recoveredByFlag = evaluateLivePair(
      turn('conv-a', 'Saved.'),
      turn('conv-b', 'Infosys on 23 August.', {
        generation: { origin: 'model' },
        memory: { earlierConversations: 1, fallback: true },
      }),
      ['Infosys', '23 August'],
    );
    expect(recoveredByFlag).toEqual({ status: 'RECOVERED', origin: 'model', fallback: true });
  });

  it('live evaluator fails incorrect model output even when generation.origin is model', () => {
    const verdict = evaluateLivePair(
      turn('conv-a', 'Saved.', { generation: { origin: 'model' } }),
      turn('conv-b', 'You have a dentist appointment on 5 May.', {
        generation: { origin: 'model' },
        memory: { earlierConversations: 1, fallback: false },
      }),
      ['Infosys', '23 August'],
    );
    expect(verdict.status).toBe('FAIL');
    expect(verdict.error).toBe('expected evidence missing');
  });

  it('live evaluator rejects missing or invalid generation metadata rather than claiming model success', () => {
    const missing = evaluateLivePair(
      turn('conv-a', 'Saved.'),
      turn('conv-b', 'Infosys on 23 August.', {
        memory: { earlierConversations: 1, fallback: false },
      }),
      ['Infosys', '23 August'],
    );
    expect(missing).toEqual({ status: 'FAIL', origin: 'missing', fallback: false, error: 'missing or invalid generation.origin metadata' });

    const invalid = evaluateLivePair(
      turn('conv-a', 'Saved.'),
      turn('conv-b', 'Infosys on 23 August.', {
        generation: { origin: 'unknown' as unknown as 'model' },
        memory: { earlierConversations: 1, fallback: false },
      }),
      ['Infosys', '23 August'],
    );
    expect(invalid.status).toBe('FAIL');
    expect(invalid.origin).toBe('missing');
  });

  // Blocker 2: Unvalidated streaming suppression for mixed recall and changeRequest, preserving ordinary streaming.
  it('suppresses unvalidated historical drafts during mixed recall and streams only final validated text', async () => {
    const h = await setup(['I chose PostgreSQL.'], async (input) => {
      await input.onText?.('You chose MongoDB. ');
      await input.onText?.('Recursion uses a base case.');
      return stop('You chose MongoDB. Recursion uses a base case.');
    });
    const r = await chat(h.app, 'Recall PostgreSQL and search the web for its documentation');
    expect(r.response.body).not.toContain('MongoDB');
    expect(r.result?.message.content).toContain('I chose PostgreSQL.');
    expect(r.result?.message.content).toContain('Recursion uses a base case.');
    const visible: string[] = [];
    await readChatStream(new Response(r.response.body), { onDelta: (s) => { visible.push(s); } });
    expect(visible.join('')).toBe(r.result?.message.content);
  });

  it('never streams intermediate changeRequest JSON as user-facing deltas and emits only the verified verdict', async () => {
    let calls = 0;
    const rawJson = JSON.stringify({ comparisons: [{ kind: 'price', product: 'Neon' }] });
    const h = await setup(['We discussed Neon pricing last week.'], async (input) => {
      if (++calls === 1) return tool(['Neon official pricing']);
      await input.onText?.(rawJson);
      return stop(rawJson);
    });
    const r = await chat(h.app, 'Have our Neon prices changed since we last discussed it?');
    expect(r.response.body).not.toContain('{"comparisons"');
    expect(r.result?.message.content).toContain('Cannot verify');
    const visible: string[] = [];
    await readChatStream(new Response(r.response.body), { onDelta: (s) => { visible.push(s); } });
    expect(visible.join('')).toBe(r.result?.message.content);
  });

  it('preserves incremental streaming for ordinary non-recall questions', async () => {
    const h = await setup([], async (input) => {
      await input.onText?.('Base ');
      await input.onText?.('case.');
      return stop('Base case.');
    });
    const r = await chat(h.app, 'Explain recursion.');
    const deltas: string[] = [];
    await readChatStream(new Response(r.response.body), { onDelta: (s) => { deltas.push(s); } });
    expect(deltas).toEqual(['Base ', 'case.']);
    expect(r.result?.message.content).toBe('Base case.');
  });

  it('suppresses failed partial drafts on transient retry during pure recall and streams validated retry output', async () => {
    let calls = 0;
    const fact = 'I have an Infosys meeting on 23 August.';
    const h = await setup([fact], async (input) => {
      if (++calls === 1) {
        await input.onText?.('Fabricated partial draft before 503.');
        throw new ModelProviderError('HTTP_ERROR', 503);
      }
      const data = JSON.parse(input.messages.find((m) => m.content.startsWith('{"untrustedHistoricalData"'))!.content).untrustedHistoricalData;
      const selected = data.records[0].user;
      const text = JSON.stringify({ memoryEvidence: [{ messageId: selected.id, quote: selected.content }] });
      await input.onText?.(text);
      return stop(text);
    });
    const r = await chat(h.app, 'What meeting did I tell you about?');
    expect(calls).toBe(2);
    expect(r.response.body).not.toContain('Fabricated partial draft');
    expect(r.result?.message.content).toMatch(/^You have an Infosys meeting on 23 August\./);
    expect(r.result?.generation).toEqual({ origin: 'model' });
    const visible: string[] = [];
    await readChatStream(new Response(r.response.body), { onDelta: (s) => { visible.push(s); } });
    expect(visible.join('')).toBe(r.result?.message.content);
  });
});
