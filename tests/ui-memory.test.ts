// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatApp, type ChatAppInstance } from '../public/app.js';
import { memoryRequest, validConversation } from '../public/api.js';
import { result, source, streamText, meta } from './fixtures/chat-stream.js';
const id = '11111111-1111-4111-8111-111111111111';
const tid = '22222222-2222-4222-8222-222222222222';
const aid = '33333333-3333-4333-8333-333333333333';
const uid = '44444444-4444-4444-8444-444444444444';
const mid = '55555555-5555-4555-8555-555555555555';
const other = '66666666-6666-4666-8666-666666666666';
const key = 'recall.activeConversation.v1';
const html = readFileSync(resolve(import.meta.dirname, '..', 'public/index.html'), 'utf8');
const answer = { ...result, message: { ...result.message, id: mid, content: 'Saved **answer** [S1]' }, sources: [source] };
function conversation(status = 'accepted', cid = id): any {
  return { schemaVersion: 'recall.memory.v1', id: cid, seededMessages: [], turns: [{ id: tid, ordinal: 0, key: 'original-turn',
    user: { id: uid, role: 'user', content: 'Original question', timestamp: result.message.timestamp },
    attempts: [{ id: aid, key: 'original-attempt', status, ...(['accepted','awaiting_receipt','partial'].includes(status) ? { answer: { result: structuredClone(answer) } } : {}) }] }] };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const apps: ChatAppInstance[] = [];
beforeEach(() => { document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1]; localStorage.clear(); });
afterEach(() => { for (const a of apps.splice(0)) a.destroy(); vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = ''; });
async function mount(handler?: (url: string, init?: RequestInit) => Promise<Response>, saved = true) {
  if (saved) localStorage.setItem(key, id);
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/health') return json({ status: 'ok' });
    if (handler) return handler(String(url), init);
    if (String(url).includes('?offset')) return json({ total: 1, items: [{ id }] });
    return json(conversation());
  });
  const app = createChatApp({ root: document, fetchImpl }); apps.push(app); await app.waitForRestoration();
  return { app, fetchImpl };
}
async function send(text = 'Original question') {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush(); await flush();
}
describe('server-authoritative browser restoration and receipts', () => {
  it.each([109, 1000])('lists all %s saved conversations across every page and refreshes successfully', async (total) => {
    const ids = Array.from({ length: total }, (_, n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const { app, fetchImpl } = await mount(async (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return json({ total, items: ids.slice(offset, offset + 50).map((id) => ({ id })) });
    }, false);
    expect(ids.every((id) => app.getSessions().some((s) => s.id === id))).toBe(true);
    expect(document.body.textContent).not.toContain('could not be listed');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('?offset'))).toHaveLength(Math.ceil(total / 50));
    await app.refreshConversations();
    expect(app.getSessions().filter((s) => ids.includes(s.id))).toHaveLength(total);
  });
  it('rejects empty intermediate pages without looping or discarding the active view', async () => {
    const { app, fetchImpl } = await mount(async () => json({ total: 109, items: [] }), false);
    expect(document.body.textContent).toContain('could not be listed');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('?offset'))).toHaveLength(1);
    expect(app.getActiveSession().history).toEqual([]);
  });
  it('discloses missing chat configuration even when the HTTP server is connected', async () => {
    const app = createChatApp({ root: document, persistence: false,
      fetchImpl: async () => json({ status: 'ok', version: '1.0.0', chatConfigured: false }) });
    apps.push(app); await app.waitForInitialHealth();
    expect(document.body.textContent).toContain('Chat not configured');
  });
  it('ends the pending-save state when chat is rejected before persistence', async () => {
    await mount(async (url) => url.includes('?offset') ? json({ total: 0, items: [] }) : url === '/api/chat' ?
      json({ error: { code: 'CHAT_NOT_CONFIGURED', message: 'Chat configuration missing.' } }, 503) :
      json({ ...conversation(), turns: [] }), false);
    await send('Please help');
    expect(document.body.textContent).toContain('Not saved');
    expect(document.body.textContent).not.toContain('Submission pending');
    expect(document.body.textContent).toContain('rejected before saving');
    expect(document.querySelector('[data-action="retry-request"]')).not.toBeNull();
  });
  it.each([false, true])('Gate 7C keeps visible failed receipts recoverable and ignores navigation (navigate=%s)', async (navigate) => {
    let body: any; let release!: () => void;
    const { app } = await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/conversations') return json({ ...conversation(), turns: [] });
      if (url === '/api/chat') {
        body = JSON.parse(String(init?.body)); return new Response(streamText(answer).replace(meta.conversationId, body.conversationId), { headers: {
          'content-type': 'text/event-stream', 'x-conversation-id': id, 'x-turn-id': tid, 'x-attempt-id': aid } });
      }
      if (url.endsWith('/receipt')) return new Promise((r) => { release = () => r(json({}, 503)); });
      const value = conversation('awaiting_receipt'); value.turns[0].key = body.turn.key; return json(value);
    }, false);
    await send(); expect(document.querySelector('.assistant-answer-card')?.textContent).toContain('Saved');
    const owner = app.getActiveSession();
    if (navigate) app.startNewConversation();
    release(); await flush(); await flush();
    expect(owner.history.some((m) => m.role === 'assistant')).toBe(false);
    if (navigate) { expect(app.getActiveSession()).not.toBe(owner); expect(app.getActiveSession().history).toEqual([]); }
    else { expect(document.body.textContent).toContain('receipt was not confirmed'); expect(document.querySelector('[data-action="recover-receipt"]')).not.toBeNull(); }
  });
  it('Gate 7C displays validated answers before synchronization and receipt, accepting only after receipt', async () => {
    let body: any; let releaseSync!: () => void; let releaseReceipt!: () => void;
    const { app } = await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/conversations') return json({ ...conversation(), turns: [] });
      if (url === '/api/chat') {
        body = JSON.parse(String(init?.body)); return new Response(streamText(answer).replace(meta.conversationId, body.conversationId), { headers: {
          'content-type': 'text/event-stream', 'x-conversation-id': id, 'x-turn-id': tid, 'x-attempt-id': aid } });
      }
      if (url.endsWith('/receipt')) return new Promise((r) => { releaseReceipt = () => r(json({ status: 'accepted', answer: { result: answer } })); });
      const value = conversation('awaiting_receipt'); value.turns[0].key = body.turn.key;
      return new Promise((r) => { releaseSync = () => r(json(value)); });
    }, false);
    await send(); expect(document.querySelector('.assistant-answer-card')?.textContent).toContain('Saved');
    expect(app.getActiveSession().history.some((m) => m.role === 'assistant')).toBe(false);
    releaseSync(); await flush(); await flush();
    expect(document.querySelector('.assistant-answer-card')?.textContent).toContain('Saved');
    expect(app.getActiveSession().history.some((m) => m.role === 'assistant')).toBe(false);
    releaseReceipt(); await flush(); await flush();
    expect(app.getActiveSession().history.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
  it('discloses backend disk persistence after restoration and on errors', async () => {
    await mount(async (url) => url.includes('?offset') ? json({ total: 1, items: [{ id }] }) : url === '/api/chat' ? json({}, 503) : json(conversation()));
    expect(document.body.textContent).toContain('Saved locally on this server');
    expect(document.body.textContent).not.toMatch(/Session only|Not saved to disk|Conversations stay in this browser tab|memory are not enabled/);
    await send('Another question');
    expect(document.body.textContent).toContain('may already be saved');
  });
  it('uses browser-session messaging only when restoration is disabled, without denying backend saves', async () => {
    const app = createChatApp({ root: document, persistence: false, fetchImpl: async () => json({ status: 'ok' }) }); apps.push(app);
    expect(document.body.textContent).toContain('Browser session');
    expect(document.body.textContent).toContain('server may still save submitted messages');
    expect(document.body.textContent).not.toContain('Not saved to disk');
  });
  it('resubmits restored seeds using their canonical identity and original role', async () => {
    let body: any;
    const seed = { id: other, role: 'assistant', content: 'Imported shortlist', timestamp: result.message.timestamp };
    await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 1, items: [{ id }] });
      if (url === '/api/chat') { body = JSON.parse(String(init?.body)); return json({}, 503); }
      return json({ ...conversation(), seededMessages: [seed] });
    });
    expect(document.body.textContent).toContain('Imported historical text');
    await send('Continue');
    expect(body.history.filter((m: any) => m.id === other)).toEqual([seed]);
  });
  it('restores after refresh with original order, timestamps and source links; stores only an ID', async () => {
    const { app, fetchImpl } = await mount();
    expect(app.getActiveSession().history.map((m) => m.content)).toEqual(['Original question', answer.message.content]);
    expect(document.querySelector('.citation-link')?.getAttribute('href')).toBe(source.url);
    expect(document.querySelector('strong')?.textContent).toBe('answer');
    expect(localStorage.length).toBe(1); expect(localStorage.getItem(key)).toBe(id);
    expect(fetchImpl.mock.calls.some(([u]) => u === '/api/chat')).toBe(false);
  });
  it('lists and reopens older conversations, fetching their authoritative records', async () => {
    const { app } = await mount(async (url) => url.includes('?offset') ? json({ total: 2, items: [{ id }, { id: other }] }) : json(conversation('accepted', url.split('/').at(-1))));
    expect(app.getSessions()).toHaveLength(2);
    await app.openConversation(other); expect(app.getActiveSession().id).toBe(other); expect(localStorage.getItem(key)).toBe(other);
  });
  it('does not acknowledge restored pending answers until explicit recovery, then deduplicates receipts/history', async () => {
    let receipts = 0;
    const { app, fetchImpl } = await mount(async (url) => {
      if (url.includes('?offset')) return json({ total: 1, items: [{ id }] });
      if (url.endsWith('/receipt')) { receipts++; return json({ status: 'accepted', answer: { result: answer } }); }
      if (url.endsWith('/result')) return json({ status: 'awaiting_receipt', result: answer });
      return json(conversation('awaiting_receipt'));
    });
    expect(receipts).toBe(0); expect(app.getActiveSession().history).toHaveLength(1);
    const button = document.querySelector<HTMLButtonElement>('[data-action="recover-receipt"]')!;
    button.click(); button.click(); await flush(); await flush();
    expect(receipts).toBe(2); expect(app.getActiveSession().history).toHaveLength(2);
    expect(fetchImpl.mock.calls.some(([u]) => u === '/api/chat')).toBe(false);
  });
  it('keeps failed acknowledgments visible and excluded from history until retry succeeds', async () => {
    let fail = true;
    const { app } = await mount(async (url) => {
      if (url.includes('?offset')) return json({ total: 1, items: [{ id }] });
      if (url.endsWith('/receipt')) return fail ? json({}, 503) : json({ status: 'accepted', answer: { result: answer } });
      if (url.endsWith('/result')) return json({ status: 'awaiting_receipt', result: answer });
      return json(conversation('awaiting_receipt'));
    });
    document.querySelector<HTMLButtonElement>('[data-action="recover-receipt"]')!.click(); await flush(); await flush();
    expect(document.body.textContent).toContain('receipt was not confirmed'); expect(app.getActiveSession().history).toHaveLength(1);
    fail = false; document.querySelector<HTMLButtonElement>('[data-action="recover-receipt"]')!.click(); await flush(); await flush();
    expect(app.getActiveSession().history).toHaveLength(2);
  });
  it('sends stable keys and acknowledges only after valid terminal SSE/EOF and server identity synchronization', async () => {
    let body: any; let receipts = 0;
    const { app } = await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/chat') {
        body = JSON.parse(String(init?.body));
        return new Response(streamText(answer).replace(meta.conversationId, body.conversationId), { headers: {
          'content-type': 'text/event-stream', 'x-conversation-id': id, 'x-turn-id': tid, 'x-attempt-id': aid } });
      }
      if (url.endsWith('/receipt')) { receipts++; return json({ status: 'accepted', answer: { result: answer } }); }
      const value = conversation('awaiting_receipt'); value.turns[0].key = body?.turn.key ?? 'original-turn'; return json(value);
    }, false);
    await send();
    expect(body.turn.key).toBeTruthy(); expect(body.turn.attemptKey).toBeTruthy(); expect(receipts).toBe(1);
    expect(app.getActiveSession().history.map((m) => m.id)).toEqual([uid, mid]);
    expect(localStorage.getItem(key)).toBe(id);
  });
  it.each(['partial','malformed','cancelled'] as const)('never acknowledges %s delivery', async (kind) => {
    let receipts = 0;
    const { app } = await mount(async (url) => {
      if (url.includes('?offset')) return json({ total: 1, items: [{ id }] });
      if (url.endsWith('/receipt')) { receipts++; return json({}); }
      const v = conversation(kind === 'cancelled' ? 'cancelled' : 'partial');
      if (kind === 'partial') { v.turns[0].attempts[0].answer.result.coverage = 'partial'; v.turns[0].attempts[0].answer.result.issues = ['search_failed']; }
      if (kind === 'malformed') v.turns[0].attempts[0].answer.result.message.content = '[S999]';
      return json(v);
    });
    expect(receipts).toBe(0); expect(app.getActiveSession().history.every((m) => m.role === 'user')).toBe(true);
  });
  it('restores a failed turn and retries with its original key and a fresh attempt key', async () => {
    let body: any;
    await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 1, items: [{ id }] });
      if (url === '/api/chat') { body = JSON.parse(String(init?.body)); return json({}, 503); }
      return json(conversation('failed'));
    });
    document.querySelector<HTMLButtonElement>('[data-action="retry-request"]')!.click(); await flush();
    expect(body.turn.key).toBe('original-turn'); expect(body.turn.attemptKey).not.toBe('original-attempt');
  });
  it('preserves the view on offline errors, and reports a deleted conversation without fabricating history', async () => {
    const { app } = await mount(async (url) => url.includes('?offset') ? json({ total: 1, items: [{ id }] }) : json({}, 404));
    expect(document.body.textContent).toContain('deleted or is unavailable'); expect(app.getActiveSession().history).toEqual([]);
    expect(localStorage.getItem(key)).toBeNull();
    const second = await mount(async () => { throw new Error('Offline'); }, false);
    expect(document.body.textContent).toContain('could not be listed'); expect(second.app.getActiveSession().history).toEqual([]);
  });
  it('ignores stale navigation loads and never silently switches due to another tab', async () => {
    let release!: (r: Response) => void;
    const { app } = await mount(async (url) => url.includes('?offset') ? json({ total: 0, items: [] }) : new Promise((r) => { release = r; }), false);
    const pending = app.openConversation(id); await flush(); app.startNewConversation(); release(json(conversation())); await pending;
    expect(app.getActiveSession().id).not.toBe(id);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: other }));
    expect(document.body.textContent).toContain('Another tab'); expect(app.getActiveSession().id).not.toBe(other);
  });
  it('rejects malformed records and bounds JSON stream size', async () => {
    const bad = conversation(); bad.turns[0].ordinal = 9; expect(validConversation(bad)).toBe(false);
    await expect(memoryRequest('/fixture', { fetchImpl: async () => new Response('x'.repeat(5 * 1024 * 1024 + 1),
      { headers: { 'content-type': 'application/json' } }) })).rejects.toBeTruthy();
  });
  it('never acknowledges an interrupted SSE delivery and remembers the conversation for refresh recovery', async () => {
    let receipts = 0;
    const { app } = await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 0, items: [] });
      if (url.endsWith('/receipt')) { receipts++; return json({}); }
      if (url === '/api/chat') {
        const body = JSON.parse(String(init?.body));
        return new Response(streamText(answer).replace(meta.conversationId, body.conversationId).split('event: done')[0],
          { headers: { 'content-type': 'text/event-stream' } });
      }
      return json(conversation('awaiting_receipt'));
    }, false);
    await send(); expect(receipts).toBe(0); expect(localStorage.getItem(key)).toBe(id);
    expect(app.getActiveSession().history.every((m) => m.role === 'user')).toBe(true);
  });
  it('cancels during server identity synchronization without acknowledging or accepting the answer', async () => {
    let entered!: () => void; const synchronizing = new Promise<void>((r) => { entered = r; });
    let receipts = 0;
    const { app } = await mount(async (url, init) => {
      if (url.includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/conversations') return json({ ...conversation(), turns: [] });
      if (url === '/api/chat') {
        const body = JSON.parse(String(init?.body));
        return new Response(streamText(answer).replace(meta.conversationId, body.conversationId), { headers: {
          'content-type': 'text/event-stream', 'x-conversation-id': id, 'x-turn-id': tid, 'x-attempt-id': aid } });
      }
      if (url.endsWith('/receipt')) { receipts++; return json({}); }
      entered(); return new Promise<Response>(() => {});
    }, false);
    void send(); await synchronizing;
    document.querySelector<HTMLButtonElement>('[data-action="cancel-request"]')!.click(); await flush(); await flush();
    expect(receipts).toBe(0); expect(document.body.textContent).toContain('Request cancelled');
    expect(app.getActiveSession().history.every((m) => m.role === 'user')).toBe(true);
  });
});
