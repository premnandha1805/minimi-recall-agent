import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent.js';
import { ChatResultSchema } from '../src/contracts.js';
import type { ModelProvider, ModelResponse } from '../src/model.js';
import { SearchSession, type SearchDocument, type WebSearch } from '../src/search.js';
import { assessSource, sourceUrlKey } from '../src/source-integrity.js';

const doc = (url: string, title = 'Frozen Nobel Prize physics 2025', text = 'Frozen Nobel Prize physics evidence'): SearchDocument =>
  ({ url, title, text, retrieved_at: '2026-11-14T00:00:00Z' });
const signal = () => new AbortController().signal;
const session = (search: WebSearch, intent = '') => new SearchSession(search, signal(), performance.now(), undefined, intent);
afterEach(() => vi.useRealTimers());

describe('conservative source URL keys (output URLs stay original)', () => {
  it.each([
    ['https://EXAMPLE.com:443/a', 'https://example.com/a', true],
    ['https://example.com', 'https://example.com/', true],
    ['https://example.com/a?utm_source=x&utm_medium=y', 'https://example.com/a', true],
    ['https://example.com/a?year=2025&utm_campaign=x', 'https://example.com/a?year=2025', true],
    ['https://example.com/a?year=2024', 'https://example.com/a?year=2025', false],
    ['https://example.com/a?lang=en', 'https://example.com/a?lang=fr', false],
    ['https://example.com/a?ref=one', 'https://example.com/a?ref=two', false],
    ['https://example.com/a?sig=abc&utm_source=x', 'https://example.com/a?sig=abc', false],
    ['https://example.com/a?x=1&x=2', 'https://example.com/a?x=2&x=1', false],
    ['https://example.com/a#part1', 'https://example.com/a#part2', false],
    ['https://example.com/a.pdf#page=1', 'https://example.com/a.pdf#page=2', false],
    ['https://example.com/a', 'https://example.com/a/', false],
    ['http://example.com/a', 'https://example.com/a', false],
    ['https://example.com/a?q=a%20b', 'https://example.com/a?q=a+b', false],
  ])('compares %s with %s as equivalent=%s', (a, b, equivalent) => {
    expect(sourceUrlKey(a) === sourceUrlKey(b)).toBe(equivalent);
  });
});

describe('frozen request-local registries', () => {
  it.each([{ queries: 5, unique: 11 }, { queries: 3, unique: 7 }])(
    'retains $unique unique records from $queries three-result searches', async ({ queries, unique }) => {
      const urls = Array.from({ length: queries * 3 }, (_, i) => `https://example.com/evidence/${i % unique}`);
      const run = session(async (query) => urls.slice(Number(query) * 3, Number(query) * 3 + 3).map((url) => doc(url)));
      const outcomes = await run.runRound([Array.from({ length: queries }, (_, i) => String(i))]);
      expect(run.sources).toHaveLength(unique); expect(run.attempts).toBe(queries);
      expect(run.sources.map((source) => source.id)).toEqual(Array.from({ length: unique }, (_, i) => `S${i + 1}`));
      for (const outcome of outcomes.flat()) for (const source of outcome.sources) {
        expect(run.sources.find((registered) => registered.id === source.id)).toBe(source);
      }
    });

  it('retains one record across queries/rounds with first evidence and repeated query provenance', async () => {
    const first = doc('https://example.com/press?utm_source=first', 'First title', 'First exact text');
    const run = session(async (query) => [query === 'one' ? first : doc('https://example.com/press', 'Later title', 'Different later text')]);
    const a = await run.runRound([['one', 'two']]); const b = await run.runRound([['three']]);
    expect(run.sources).toEqual([{ ...first, id: 'S1', query: 'one' }]);
    expect(a[0].map((outcome) => [outcome.query, outcome.sources[0].id])).toEqual([['one', 'S1'], ['two', 'S1']]);
    expect(b[0][0].sources[0]).toBe(run.sources[0]);
    expect(b[0][0].sources[0].text).toBe(first.text);
    const other = session(async () => [doc('https://example.com/different-request')]);
    await other.runRound([['one']]); expect(other.sources).toHaveLength(1);
    expect(other.sources[0].id).toBe('S1'); expect(run.sources[0].url).toBe(first.url);
  });

  it('retains three distinct pages with repeated titles and collapses duplicates within one query', async () => {
    const run = session(async (query) => query === 'a' ? [doc('https://example.com/a'), doc('https://example.com/a'), doc('https://example.com/b')] :
      [doc('https://example.com/a/'), doc('https://example.com/b'), doc('https://example.com/b')]);
    const outcomes = await run.runRound([['a', 'b']]);
    expect(run.sources).toHaveLength(3);
    expect(outcomes[0].map((outcome) => outcome.sources.map((source) => source.id))).toEqual([['S1', 'S2'], ['S3', 'S2']]);
  });

  it('retains stable query-order IDs despite reversed network completion', async () => {
    let finish!: (docs: SearchDocument[]) => void;
    const run = session(async (query) => query === 'first' ? new Promise((yes) => { finish = yes; }) :
      [doc('https://example.com/shared'), doc('https://example.com/second')]);
    const pending = run.runRound([['first', 'second']]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    finish([doc('https://example.com/shared', 'First')]); await pending;
    expect(run.sources.map((source) => [source.id, source.title])).toEqual([['S1', 'First'], ['S2', 'Frozen Nobel Prize physics 2025']]);
  });

  it('reuses only registered IDs in model context and the unchanged SSE result schema', async () => {
    let calls = 0;
    const complete = vi.fn<ModelProvider['complete']>(async () => ++calls === 1 ?
      { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{"queries":["one","two"]}' }] } :
      { text: 'Evidence [S1]', finishReason: 'stop', toolCalls: [] });
    const result = await runAgent({ message: 'Nobel 2025' }, { provider: { contextWindowTokens: 65536, complete }, signal: signal(),
      search: async () => [doc('https://example.com/press')] });
    expect(result.reason).toBe('answer'); expect(result.sources).toHaveLength(1);
    const context = JSON.parse(complete.mock.calls[1][0].messages.at(-1)!.content);
    expect(context.map((outcome: { sources: { id: string }[] }) => outcome.sources[0].id)).toEqual(['S1', 'S1']);
    expect(ChatResultSchema.safeParse({ message: { id: 'answer', role: 'assistant', content: result.answer,
      timestamp: '2026-11-14T00:00:00Z' }, coverage: 'complete', issues: [],
      sources: result.sources.map(({ text: _text, ...source }) => source), evidenceCheck: 'citation_ids_only' }).success).toBe(true);
    const rejected = await runAgent({ message: 'Nobel' }, { provider: { contextWindowTokens: 65536,
      complete: async (): Promise<ModelResponse> => ({ text: 'Stale [S2]', toolCalls: [], finishReason: 'stop' }) }, signal: signal() });
    expect(rejected.reason).toBe('invalid_citation'); expect(rejected.sources).toHaveLength(0);
  });

  it('preserves existing query deduplication without merging different years or queries', async () => {
    const search = vi.fn<WebSearch>(async () => [doc('https://example.com/shared')]); const run = session(search);
    await run.runRound([['Nobel 2025', '  NOBEL   2025 ', 'Nobel 2024']]);
    await run.runRound([['Nobel 2025', 'Nobel physics 2025']]);
    expect(run.attempts).toBe(3); expect(search).toHaveBeenCalledTimes(3); expect(run.sources).toHaveLength(1);
  });

  it('rejects malformed URLs honestly and preserves valid undated sources after failed queries', async () => {
    const run = session(async (query) => {
      if (query === 'failure') throw new Error('Fixture failure');
      return [doc(query === 'bad' ? 'javascript:alert(1)' : 'https://example.com/undated')];
    });
    const results = await run.runRound([['bad', 'failure', 'undated']]);
    expect(results[0].map((outcome) => outcome.status)).toEqual(['invalid_results', 'failed', 'ok']);
    expect(run.sources).toHaveLength(1); expect(run.sources[0]).not.toHaveProperty('published_at');
  });

  it('does not register cancelled or late results', async () => {
    const controller = new AbortController(); let finish!: (docs: SearchDocument[]) => void;
    const run = new SearchSession(async () => new Promise((yes) => { finish = yes; }), controller.signal, performance.now());
    const pending = run.runRound([['one']]); const assertion = expect(pending).rejects.toThrow('Fixture cancellation');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    controller.abort(new Error('Fixture cancellation')); await assertion;
    finish([doc('https://example.com/late')]); await Promise.resolve(); expect(run.sources).toHaveLength(0);
  });
});

describe('advisory evidence relevance (three retained sources)', () => {
  it('prefers an explicit official-site query match and flags unrelated/wrong-year pages without deleting evidence', async () => {
    const intent = 'Nobel Prize physics 2025';
    const run = session(async () => [doc('https://example.com/football', 'Football league 2025', 'Football scores'),
      doc('https://nobelprize.org/prizes/physics/2024/press-release', 'Nobel Prize physics 2024'),
      { ...doc('https://nobelprize.org/prizes/physics/2025/press-release'), published_at: '2024-12-01' }], intent);
    const outcomes = await run.runRound([['Nobel physics 2025 site:nobelprize.org']]);
    expect(run.sources).toHaveLength(3);
    expect(run.sources[0].url).toContain('/2025/press-release');
    expect(outcomes[0][0].relevance).toMatchObject([
      { sourceId: 'S1', assessment: 'uncertain', year: 'match', requestedSite: true },
      { sourceId: 'S2', assessment: 'weak', requestedSite: false },
      { sourceId: 'S3', assessment: 'weak', year: 'conflict', requestedSite: true },
    ]);
    expect(run.sources[0].published_at).toBe('2024-12-01');
  });

  it('keeps comparisons and unknown dates uncertain, and respects hostname boundaries', () => {
    const source = { ...doc('https://nobelprize.org.attacker.example/2024', 'Physics background'), id: 'S1' };
    expect(assessSource('physics site:nobelprize.org', 'compare physics 2024 and 2025', source)).toMatchObject({
      year: 'unknown', requestedSite: false, assessment: 'uncertain' });
    expect(assessSource('physics 2025', '', { ...source, url: 'https://example.com/undated' })).toMatchObject({ year: 'unknown' });
  });

  it('flags weak entity/event overlap without claiming deterministic irrelevance', () => {
    expect(assessSource('Marie Curie Nobel chemistry 1911', '', {
      ...doc('https://example.com/sports', 'Sports prize', 'Football award scores'), id: 'S1',
    })).toMatchObject({ assessment: 'weak', queryTermsMatched: 0, year: 'unknown' });
  });
});
