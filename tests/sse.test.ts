import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ChatEventSchemas, MAX_SSE_FRAME_BYTES, type ChatResult } from '../src/contracts.js';
import { encodeEvent, SseResponse } from '../src/sse.js';
import { ExecutionTimeoutError } from '../src/execution.js';
import { readChatStream, sendChatRequest, validChatEvent } from '../public/api.js';
import { meta, result, source, streamText } from './fixtures/chat-stream.js';

function response(text = streamText(), size = 11) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.useRealTimers());
describe('recall.chat.v1 browser parser and schema parity', () => {
  it.each([1, 2, 3, 11, 10000])('reads arbitrary %i-byte boundaries including split Unicode', async (size) => {
    const progress = vi.fn();
    expect(await readChatStream(response(streamText(), size), { onProgress: progress })).toEqual({ meta, result });
    expect(progress.mock.calls.map(([p]) => p.phase)).toEqual(['accepted', 'model_started']);
  });
  it.each(['\n', '\r\n', '\r'])('supports line endings %j and multiline data', async (newline) => {
    const text = streamText().replace('"role":"assistant",', '"role":"assistant",\ndata: ');
    expect((await readChatStream(response(text.replaceAll('\n', newline), 1))).result).toEqual(result);
  });
  it('accepts genuine source metadata and partial coverage', async () => {
    const partial: ChatResult = { ...result, message: { ...result.message, content: 'Evidence [S1]' },
      coverage: 'partial', issues: ['search_failed'], sources: [source] };
    expect((await readChatStream(response(streamText(partial)))).result).toEqual(partial);
  });
  it.each([
    (s: string) => s.replace('recall.chat.v1', 'recall.chat.v2'),
    (s: string) => s.replace('event: meta', 'event: unknown'),
    (s: string) => s.replace('event: meta', 'event: meta\nevent: meta'),
    (s: string) => s.replace('event: meta', 'event:\nevent: meta'),
    (s: string) => s.replace('"phase":"accepted"', '"phase":"invented"'),
    (s: string) => s.replace('"call":1', '"call":2'),
    (s: string) => s.replace('"outcome":"completed"', '"outcome":"partial"'),
    (s: string) => s.replace('"messageId":"msg_test"', '"messageId":"wrong"'),
    (s: string) => s.slice(0, s.indexOf('event: done')),
    (s: string) => s + encodeEvent('done', { outcome: 'completed', messageId: result.message.id }),
    (s: string) => s.slice(0, -1),
    (s: string) => s.replace('data: {', 'data: {BROKEN'),
    (s: string) => s.replace('event: result', 'event: error'),
    (s: string) => s.replace('event: result', 'id: replay\nevent: result'),
    (s: string) => s + ': trailing comment\n\n',
  ])('rejects malformed, unordered, duplicated or truncated events %#', async (modify) => {
    await expect(readChatStream(response(modify(streamText())))).rejects.toThrow();
  });
  it.each([
    { ...result, sources: [source, source] },
    { ...result, message: { ...result.message, content: 'Unknown [S999]' } },
    { ...result, sources: [{ ...source, url: 'javascript:alert(1)' }] },
    { ...result, sources: [{ ...source, url: 'https://user:password@example.com' }] },
    { ...result, sources: [{ ...source, published_at: '2026-02-30' }] },
    { ...result, sources: [{ ...source, effective_at: null }] },
    { ...result, coverage: 'partial' },
    { ...result, issues: ['search_failed', 'search_failed'] },
    { ...result, extra: true },
  ])('rejects invalid result with both server and browser validators %#', async (bad) => {
    expect(ChatEventSchemas.result.safeParse(bad).success).toBe(false);
    expect(validChatEvent('result', bad)).toBe(false);
  });
  it('rejects invalid UTF-8, oversized frames and oversized total streams', async () => {
    await expect(readChatStream(new Response(new Uint8Array([0xff])))).rejects.toThrow();
    await expect(readChatStream(response(':' + 'x'.repeat(MAX_SSE_FRAME_BYTES), 65536))).rejects.toThrow();
    await expect(readChatStream(response((': comment\n\n').repeat(200000), 65536))).rejects.toThrow();
  });
  it('does not accept HTTP 200 alone and maps a valid error stream', async () => {
    expect((await sendChatRequest({ message: 'hello' }, { fetchImpl: async () => jsonResponse('{}') })).kind).toBe('unsupported_response');
    const error = encodeEvent('meta', meta) + encodeEvent('progress', { phase: 'accepted' }) +
      encodeEvent('error', { code: 'MODEL_FAILED', message: 'Model failed' }) + encodeEvent('done', { outcome: 'failed' });
    expect(await sendChatRequest({ message: 'hello' }, { fetchImpl: async () => response(error) })).toMatchObject({ kind: 'stream_error', code: 'MODEL_FAILED' });
  });
  it('rejects identity mismatches and body failure even after a complete done frame', async () => {
    expect((await sendChatRequest({ message: 'hello', conversationId: 'wrong' }, { fetchImpl: async () => response() })).kind).toBe('protocol_error');
    const broken = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(streamText())); },
      pull(controller) { controller.error(new Error('Disconnected')); },
    });
    const received = await sendChatRequest({ message: 'hello' }, { fetchImpl: async () => new Response(broken,
      { headers: { 'content-type': 'text/event-stream' } }) });
    expect(received.kind).toBe('protocol_error'); expect(received.result).toBeUndefined();
  });
  it('cancels pending readers and clears watchdog/listeners', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(); const cancel = vi.fn();
    const run = sendChatRequest({ message: 'hello' }, { signal: controller.signal,
      fetchImpl: async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }) });
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect((await run).kind).toBe('aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('watchdog interrupts even a fetch ignoring abort and observes its late rejection', async () => {
    vi.useFakeTimers(); let reject!: (e: Error) => void;
    const run = sendChatRequest({ message: 'hello' }, { fetchImpl: () => new Promise((_, no) => { reject = no; }) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await run).toMatchObject({ kind: 'network_error', code: 'STREAM_TIMEOUT' });
    reject(new Error('late secret')); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  });
});
function jsonResponse(text: string) { return new Response(text, { headers: { 'content-type': 'application/json' } }); }

class FakeResponse extends EventEmitter {
  socket = { destroyed: false }; destroyed = false; writableEnded = false; writableNeedDrain = false;
  frames: string[] = []; writeHead = vi.fn();
  write(frame: string) { this.frames.push(frame); return !this.writableNeedDrain; }
  end(frame: string) { this.frames.push(frame); this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
describe('SSE response ownership', () => {
  it('waits for backpressure, validates before exposing result, and completes exactly once', async () => {
    const raw = new FakeResponse(); const parent = new AbortController();
    const owner = new SseResponse(raw as unknown as ServerResponse, parent.signal, meta);
    raw.writableNeedDrain = true; let resolved = false;
    const pending = owner.progress('model_started').then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    raw.writableNeedDrain = false; raw.emit('drain'); await pending;
    expect(() => owner.complete({ ...result, sources: [source, source] })).toThrow();
    expect(raw.frames.join('')).not.toContain('event: result');
    owner.complete(result); owner.fail('MODEL_FAILED'); owner.complete(result);
    expect(raw.frames.join('').match(/event: done/g)).toHaveLength(1);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });
  it('destroys a blocked socket at deadline and removes pending drain listeners', async () => {
    const raw = new FakeResponse(); const parent = new AbortController();
    const owner = new SseResponse(raw as unknown as ServerResponse, parent.signal, meta);
    raw.writableNeedDrain = true; const pending = owner.ready();
    const assertion = expect(pending).rejects.toThrow();
    parent.abort(new ExecutionTimeoutError()); await assertion;
    expect(raw.destroyed).toBe(true); expect(raw.listenerCount('drain')).toBe(0);
    owner.complete(result); expect(raw.frames.join('')).not.toContain('event: result');
  });
  it('handles write errors without exposing errors or sending another response', () => {
    const raw = new FakeResponse(); const parent = new AbortController();
    const owner = new SseResponse(raw as unknown as ServerResponse, parent.signal, meta);
    raw.emit('error', new Error('secret')); owner.fail('INTERNAL_ERROR');
    expect(raw.destroyed).toBe(true); expect(raw.frames.join('')).not.toContain('secret');
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });
  it('does not leave an unflushed timeout response open after the arrival timer expires', async () => {
    const raw = new FakeResponse(); const parent = new AbortController();
    raw.end = (frame: string) => { raw.frames.push(frame); raw.writableEnded = true; };
    new SseResponse(raw as unknown as ServerResponse, parent.signal, meta);
    parent.abort(new ExecutionTimeoutError());
    expect(raw.frames.join('').match(/event: done/g)).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.destroyed).toBe(true); expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });
});
