import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent.js';
import { ChatResultSchema } from '../src/contracts.js';
import { validChatEvent } from '../public/api.js';
import { sourceUrlKey } from '../src/source-integrity.js';
import { SearchSession } from '../src/search.js';
import { result, source } from './fixtures/chat-stream.js';

describe('escaped citation parity and signed URL preservation', () => {
  it.each(['[S999]', String.raw`\[S999\]`, String.raw`[S999\]`, String.raw`\[S999]`])(
    'rejects an unregistered reference in every validator: %s', async (content) => {
      const payload = { ...result, message: { ...result.message, content } };
      expect(ChatResultSchema.safeParse(payload).success).toBe(false);
      expect(validChatEvent('result', payload)).toBe(false);
      const answer = await runAgent({ message: 'Offline' }, { signal: new AbortController().signal,
        provider: { contextWindowTokens: 65536, complete: async () => ({ text: content, finishReason: 'stop', toolCalls: [] }) } });
      expect(answer.reason).toBe('invalid_citation');
    });
  it.each(['[S1]', String.raw`\[S1\]`, String.raw`[S1\]`, String.raw`\[S1]`])('accepts only registered references: %s', (content) => {
    const payload = { ...result, sources: [source], message: { ...result.message, content } };
    expect(ChatResultSchema.safeParse(payload).success).toBe(true); expect(validChatEvent('result', payload)).toBe(true);
  });
  it('rejects unsafe citation destinations even for escaped markers', () => {
    const payload = { ...result, sources: [{ ...source, url: 'javascript:alert(1)' }],
      message: { ...result.message, content: String.raw`\[S1\]` } };
    expect(ChatResultSchema.safeParse(payload).success).toBe(false); expect(validChatEvent('result', payload)).toBe(false);
  });
  it.each(['%73ig', '%53ignature', 'x-amz-%73ignature', '%74oken', '%E0%A4%A'])('preserves tracking when a signing key is encoded or undecodable: %s', (key) => {
    const url = `https://example.com/file?${key}=abc&utm_source=one`;
    expect(sourceUrlKey(url)).toBe(url);
    expect(sourceUrlKey(url)).not.toBe(sourceUrlKey(url.replace('one', 'two')));
  });
  it('keeps unsigned UTM deduplication while preserving signed IDs across rounds', async () => {
    const run = new SearchSession(async (query) => [{ title: 'Fixture', text: 'Frozen text', retrieved_at: '2026-11-14T00:00:00Z',
      url: query === 'plain' ? 'https://example.com/press?utm_source=x' : query === 'again' ? 'https://example.com/press' :
        `https://example.com/file?%73ig=abc&utm_source=${query}` }], new AbortController().signal, performance.now());
    await run.runRound([['plain', 'one']]); const original = run.sources.map((entry) => ({ ...entry }));
    await run.runRound([['again', 'two']]);
    expect(run.sources).toHaveLength(3); expect(run.sources.slice(0, 2)).toEqual(original);
    expect(run.sources.map((entry) => entry.id)).toEqual(['S1', 'S2', 'S3']);
  });
});
