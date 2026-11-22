import { describe, expect, it } from 'vitest';
import { parseLiveOptions, evaluateLivePair, type LiveTurnOutput } from '../scripts/live-e2e.js';
import { result } from './fixtures/chat-stream.js';

describe('safe opt-in live verification', () => {
  it.each([[], ['--runs=1'], ['--research']].map((args) => ({ args })))('requires --live before enabling any provider requests: $args', ({ args }) => {
    expect(parseLiveOptions(args)).toBeUndefined();
  });
  it('defaults to one isolated run and preserves an explicit research opt-in', () => {
    expect(parseLiveOptions(['--live'])).toEqual({ runs: 1, research: false });
    expect(parseLiveOptions(['--live', '--runs=2', '--research'])).toEqual({ runs: 2, research: true });
  });
  it.each([['--runs=0'], ['--runs=11'], ['--runs=1.5'], ['--runs=1', '--runs=2'], ['--unexpected']].map((args) => ({ args })))('rejects invalid live limits $args', ({ args }) => {
    expect(() => parseLiveOptions(['--live', ...args])).toThrow();
  });
  it('never counts partial answers as a model pass', () => {
    const turn = (id: string): LiveTurnOutput => ({ conversationId: id, firstTokenMs: 1,
      result: { ...result, message: { ...result.message, content: 'PostgreSQL' }, coverage: 'complete', generation: { origin: 'model' } } });
    const fact = turn('fact'), recall = turn('recall');
    recall.result!.coverage = 'partial'; recall.result!.issues = ['search_failed'];
    expect(evaluateLivePair(fact, recall, ['PostgreSQL'])).toMatchObject({ status: 'FAIL', error: 'partial coverage' });
  });
});
