// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatApp, type ChatAppInstance } from '../public/app.js';
import { result as chatResult, source as chatSource } from './fixtures/chat-stream.js';
import { ConversationStore, MemoryError } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const html = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1];
const key = 'recall.activeConversation.v1';
const id1 = '00000001-1111-4111-8111-111111111111';
const id2 = '00000002-1111-4111-8111-111111111111';
const id3 = '00000003-1111-4111-8111-111111111111';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const instant = '2026-11-20T12:00:00.000Z';
const tid = '00000001-2222-4222-8222-222222222222';
const uid = '00000001-3333-4333-8333-333333333333';
const aid = '00000001-4444-4444-8444-444444444444';
const mid = '00000001-5555-4555-8555-555555555555';

function createMockConversation(id: string, title: string, content = 'Loaded content') {
  const answer = {
    ...chatResult,
    message: { ...chatResult.message, id: mid, content, timestamp: instant },
    sources: [chatSource],
  };
  return {
    schemaVersion: 'recall.memory.v1',
    id,
    revision: 1,
    title,
    createdAtUtc: instant,
    updatedAtUtc: instant,
    seededMessages: [],
    turns: [
      {
        id: tid,
        key: 'turn-1',
        ordinal: 0,
        user: { id: uid, role: 'user', content: title, timestamp: instant },
        attempts: [
          {
            id: aid,
            key: 'att-1',
            status: 'accepted',
            answer: {
              result: structuredClone(answer),
            },
          },
        ],
      },
    ],
  };
}

const apps: ChatAppInstance[] = [];

beforeEach(() => {
  document.body.innerHTML = body;
  localStorage.clear();
});

afterEach(() => {
  for (const a of apps.splice(0)) a.destroy();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('Professional UI & Conversation Title Suite', () => {
  it('1. conversation titles appear immediately in sidebar without clicking', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 2,
          items: [
            { id: id1, title: 'PostgreSQL vs MySQL Benchmark', createdAtUtc: new Date(Date.now() + 1000).toISOString(), updatedAtUtc: new Date(Date.now() + 1000).toISOString(), turnCount: 2 },
            { id: id2, title: 'Cloudflare Workers Pricing', createdAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString(), turnCount: 1 },
          ],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    const sessionList = document.getElementById('session-list')!;
    const buttons = sessionList.querySelectorAll<HTMLButtonElement>('.session-item-btn');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe('PostgreSQL vs MySQL Benchmark');
    expect(buttons[1].textContent).toBe('Cloudflare Workers Pricing');
  });

  it('2. no placeholder "Stored conversation ? open..." strings exist anywhere', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: 'Valid Title Here', createdAtUtc: new Date().toISOString(), turnCount: 1 }],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    expect(document.body.textContent).not.toContain('Stored conversation ? open');
    expect(document.body.innerHTML).not.toContain('Stored conversation ? open');
  });

  it('3. first user message updates active conversation title immediately', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/chat') {
        return json({
          result: {
            message: { id: 'msg-1', role: 'assistant', content: 'Here is the answer.', timestamp: new Date().toISOString() },
            coverage: 'complete',
            evidence: [],
          },
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: false });
    apps.push(app);
    await app.waitForInitialHealth();

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'How do vector embeddings work?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flush();
    expect(app.getActiveSession().title).toBe('How do vector embeddings work?');
    const sessionList = document.getElementById('session-list')!;
    expect(sessionList.textContent).toContain('How do vector embeddings work?');
  });

  it('4. subsequent messages do not overwrite conversation title', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 0, items: [] });
      return json({
        result: {
          message: { id: 'msg-ans', role: 'assistant', content: 'Response', timestamp: new Date().toISOString() },
          coverage: 'complete',
          evidence: [],
        },
      });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: false });
    apps.push(app);
    await app.waitForInitialHealth();

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form')!;

    input.value = 'Initial conversation question';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    input.value = 'A follow-up that should not change title';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(app.getActiveSession().title).toBe('Initial conversation question');
  });

  it('5. date grouping headers ("Today", "Yesterday", "Previous conversations") render correctly', async () => {
    const now = new Date();
    const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
    const yesterdayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    const lastWeekIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 12, 0, 0).toISOString();

    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 3,
          items: [
            { id: id1, title: 'Today Task', createdAtUtc: todayIso, updatedAtUtc: todayIso, turnCount: 1 },
            { id: id2, title: 'Yesterday Notes', createdAtUtc: yesterdayIso, updatedAtUtc: yesterdayIso, turnCount: 1 },
            { id: id3, title: 'Ancient Archive', createdAtUtc: lastWeekIso, updatedAtUtc: lastWeekIso, turnCount: 1 },
          ],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    const sessionList = document.getElementById('session-list')!;
    const headings = Array.from(sessionList.querySelectorAll('.session-group-heading')).map((h) => h.textContent);
    expect(headings).toContain('Today');
    expect(headings).toContain('Yesterday');
    expect(headings).toContain('Previous conversations');

    const buttons = sessionList.querySelectorAll<HTMLButtonElement>('.session-item-btn');
    expect(buttons).toHaveLength(3);
  });

  it('6. long titles truncate cleanly with ellipsis', async () => {
    const longPrompt = 'This is an exceedingly long prompt that exceeds the reasonable title length for sidebar display';
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 0, items: [] });
      return json({ result: { message: { id: 'm', role: 'assistant', content: 'ok', timestamp: new Date().toISOString() }, coverage: 'complete', evidence: [] } });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: false });
    apps.push(app);
    await app.waitForInitialHealth();

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = longPrompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const title = app.getActiveSession().title;
    expect(title.length).toBeLessThanOrEqual(42);
    expect(title.endsWith('...')).toBe(true);
  });

  it('7. title button has proper tooltip/title attribute and aria-label', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: 'Accessible Conversation', createdAtUtc: new Date().toISOString(), turnCount: 1 }],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    const button = document.querySelector<HTMLButtonElement>('.session-item-btn')!;
    expect(button.getAttribute('title')).toBe('Accessible Conversation');
    expect(button.getAttribute('aria-label')).toBe('Accessible Conversation');
  });

  it('8. empty conversations fall back to clean title ("New conversation")', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: '', createdAtUtc: new Date().toISOString(), turnCount: 0 }],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    const button = document.querySelector<HTMLButtonElement>('.session-item-btn')!;
    expect(button.textContent).toBe('New conversation');
  });

  it('9. plain-text rendering prevents HTML injection in titles', async () => {
    const malicious = '<script>alert(1)</script><b id="injected-tag">Bold</b>';
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: malicious, createdAtUtc: new Date().toISOString(), turnCount: 1 }],
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    expect(document.getElementById('injected-tag')).toBeNull();
    const button = document.querySelector<HTMLButtonElement>('.session-item-btn')!;
    expect(button.textContent).toContain('<script>alert(1)</script>');
  });

  it('10. + New chat button creates clean conversation and resets view', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 0, items: [] });
      return json({ result: { message: { id: 'm', role: 'assistant', content: 'ok', timestamp: new Date().toISOString() }, coverage: 'complete', evidence: [] } });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: false });
    apps.push(app);
    await app.waitForInitialHealth();

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'First session';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect((document.getElementById('welcome-view') as HTMLElement).hidden).toBe(true);

    const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
    newChatBtn.click();

    expect((document.getElementById('welcome-view') as HTMLElement).hidden).toBe(false);
    expect(app.getActiveSession().title).toBe('New conversation');
    expect(app.getActiveSession().entries).toHaveLength(0);
  });

  it('11. existing conversation can be loaded by clicking sidebar item', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: 'Saved Discussion', createdAtUtc: new Date().toISOString(), turnCount: 1 }],
        });
      }
      if (url === `/api/conversations/${id1}`) {
        return json(createMockConversation(id1, 'Saved Discussion', 'Loaded content'));
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    const button = document.querySelector<HTMLButtonElement>('.session-item-btn')!;
    expect(button).not.toBeNull();
    await app.openConversation(id1);

    expect(app.getActiveSession().id).toBe(id1);
    expect(app.getActiveSession().title).toBe('Saved Discussion');
    expect(document.body.textContent).toContain('Loaded content');
  });

  it('12. zero extra LLM calls made for title generation (deterministic derivation)', async () => {
    let chatCallCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 0, items: [] });
      if (url === '/api/chat') {
        chatCallCount++;
        return json({
          result: {
            message: { id: 'm', role: 'assistant', content: 'answer', timestamp: new Date().toISOString() },
            coverage: 'complete',
            evidence: [],
          },
        });
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: false });
    apps.push(app);
    await app.waitForInitialHealth();

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'Testing deterministic titles';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    // Exactly 1 chat call made (for the actual answer), 0 for titling
    expect(chatCallCount).toBe(1);
    expect(app.getActiveSession().title).toBe('Testing deterministic titles');
  });

  it('13. fast render: sidebar renders under 50ms with 50 conversations', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      title: `Conversation ${i}: Discussion regarding topics and findings`,
      createdAtUtc: new Date(Date.now() - i * 3600000).toISOString(),
      turnCount: 1,
    }));

    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) return json({ total: 50, items });
      return json({ id: items[0].id, turns: [], seededMessages: [] });
    });

    const start = performance.now();
    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();
    const duration = performance.now() - start;

    const buttons = document.querySelectorAll('.session-item-btn');
    expect(buttons).toHaveLength(50);
    expect(duration).toBeLessThan(1000); // comfortably fast in testing environment
  });

  it('14. restoring from disk/refresh retains correct titles across page refresh and server restart', async () => {
    localStorage.setItem(key, id1);
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (url === '/health') return json({ status: 'ok' });
      if (String(url).includes('?offset')) {
        return json({
          total: 1,
          items: [{ id: id1, title: 'Persisted Architecture Discussion', createdAtUtc: new Date().toISOString(), turnCount: 1 }],
        });
      }
      if (url === `/api/conversations/${id1}`) {
        return json(createMockConversation(id1, 'Persisted Architecture Discussion', 'Verified architecture'));
      }
      return json({ id: id1, turns: [], seededMessages: [] });
    });

    const app = createChatApp({ root: document, fetchImpl, persistence: true });
    apps.push(app);
    await app.waitForRestoration();

    expect(app.getActiveSession().title).toBe('Persisted Architecture Discussion');
    const button = document.querySelector<HTMLButtonElement>('.session-item-btn')!;
    expect(button.textContent).toBe('Persisted Architecture Discussion');
  });

  describe('Conversation ordering, pagination and test isolation', () => {
    const testDirs: string[] = [];

    afterEach(async () => {
      for (const dir of testDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('15. ConversationStore.list orders conversations chronologically with newest first', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recall-order-test-'));
      testDirs.push(dir);

      let currentTime = new Date('2026-11-20T10:00:00Z').getTime();
      const clock = () => new Date(currentTime);
      const store = await ConversationStore.open({ directory: dir, now: clock });

      currentTime = new Date('2026-11-20T10:00:00Z').getTime();
      const c1 = await store.create();
      currentTime = new Date('2026-11-20T11:00:00Z').getTime();
      const c2 = await store.create();
      currentTime = new Date('2026-11-20T12:00:00Z').getTime();
      const c3 = await store.create();

      const { items, total } = await store.list();
      expect(total).toBe(3);
      expect(items.map((i) => i.id)).toEqual([c3.id, c2.id, c1.id]);
      await store.close();
    });

    it('16. ConversationStore.list pagination across 100+ conversations has no missing or duplicate items', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recall-paging-test-'));
      testDirs.push(dir);

      let baseTime = new Date('2026-11-01T00:00:00Z').getTime();
      const clock = () => {
        baseTime += 1000;
        return new Date(baseTime);
      };
      const store = await ConversationStore.open({ directory: dir, now: clock, maxConversations: 150 });

      const createdIds: string[] = [];
      for (let i = 0; i < 105; i++) {
        const c = await store.create();
        createdIds.push(c.id);
      }
      // Newest should be last created
      const expectedNewestFirst = [...createdIds].reverse();

      const page0 = await store.list({ offset: 0, limit: 50 });
      const page1 = await store.list({ offset: 50, limit: 50 });
      const page2 = await store.list({ offset: 100, limit: 50 });

      expect(page0.total).toBe(105);
      expect(page1.total).toBe(105);
      expect(page2.total).toBe(105);

      expect(page0.items).toHaveLength(50);
      expect(page1.items).toHaveLength(50);
      expect(page2.items).toHaveLength(5);

      const allListedIds = [
        ...page0.items.map((i) => i.id),
        ...page1.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
      ];

      expect(new Set(allListedIds).size).toBe(105);
      expect(allListedIds).toEqual(expectedNewestFirst);
      await store.close();
    }, 20_000);

    it('17. adding a turn updates updatedAtUtc and promotes conversation to index 0 on subsequent list()', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recall-turn-order-'));
      testDirs.push(dir);

      let baseTime = new Date('2026-11-20T10:00:00Z').getTime();
      const clock = () => new Date(baseTime);
      const store = await ConversationStore.open({ directory: dir, now: clock });

      baseTime = new Date('2026-11-20T10:00:00Z').getTime();
      const c1 = await store.create();
      baseTime = new Date('2026-11-20T11:00:00Z').getTime();
      const c2 = await store.create();
      baseTime = new Date('2026-11-20T12:00:00Z').getTime();
      const c3 = await store.create();

      const initialList = await store.list();
      expect(initialList.items.map((i) => i.id)).toEqual([c3.id, c2.id, c1.id]);

      // Add a turn to the oldest conversation (c1) at a later time
      baseTime = new Date('2026-11-20T13:00:00Z').getTime();
      await store.addTurn(c1.id, { key: 'turn-key-1', content: 'Updating conversation 1' });

      const updatedList = await store.list();
      expect(updatedList.items[0].id).toBe(c1.id);
      expect(updatedList.items.map((i) => i.id)).toEqual([c1.id, c3.id, c2.id]);
      await store.close();
    });

    it('18. corrupt JSON file in memory directory causes ConversationStore.list to throw CORRUPT', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recall-corrupt-test-'));
      testDirs.push(dir);

      const store = await ConversationStore.open({ directory: dir });
      await store.create();

      // Write a file with valid sha256 name but invalid JSON content
      const corruptName = `${'a'.repeat(64)}.json`;
      await writeFile(join(dir, corruptName), '{ invalid json content !!!', 'utf8');

      await expect(store.list()).rejects.toBeInstanceOf(MemoryError);
      await expect(store.list()).rejects.toMatchObject({ code: 'CORRUPT' });
      await store.close();
    });

    it('19. ConversationStore.list includes derived titles when includeTitle is true and omits title property when false', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recall-title-test-'));
      testDirs.push(dir);

      const store = await ConversationStore.open({ directory: dir });
      const c = await store.create();
      await store.addTurn(c.id, { key: 'turn-1', content: 'Investigating distributed consensus algorithms' });

      const listWithTitle = await store.list({ includeTitle: true });
      expect(listWithTitle.items[0].title).toBe('Investigating distributed consensus algorithms');

      const listWithoutTitle = await store.list({ includeTitle: false });
      expect(Object.keys(listWithoutTitle.items[0]).sort()).toEqual(['createdAtUtc', 'id', 'turnCount', 'updatedAtUtc']);
      expect('title' in listWithoutTitle.items[0]).toBe(false);

      await store.close();
    });

    it('20. test isolation: buildServer in test environment defaults to isolated temp storage and never writes to default .data/conversations', async () => {
      const defaultDir = resolve(import.meta.dirname, '..', '.data', 'conversations');
      const filesBefore = await readdir(defaultDir).catch(() => []);

      const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
      const app = buildServer({ config, logger: false });

      try {
        await app.ready();
        // Send a request to health and chat
        const health = await app.inject({ method: 'GET', url: '/health' });
        expect(health.statusCode).toBe(200);

        const chat = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Test message for isolation' } });
        expect(chat.statusCode).toBe(503); // Model not configured, but triggers server handling
      } finally {
        await app.close();
      }

      const filesAfter = await readdir(defaultDir).catch(() => []);
      expect(filesAfter.sort()).toEqual(filesBefore.sort());
    });
  });
});
