// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { result as chatResult, source as chatSource, meta as chatMeta, streamText } from './fixtures/chat-stream.js';
import {
  MAX_HISTORY_CONTENT_CHARS as CONTRACT_MAX_HISTORY_CONTENT_CHARS,
  MAX_HISTORY_ITEMS as CONTRACT_MAX_HISTORY_ITEMS,
  MAX_MESSAGE_CHARS as CONTRACT_MAX_MESSAGE_CHARS,
} from '../src/contracts.js';

interface CreateChatAppResult {
  refreshHealth: () => Promise<{ ok: boolean; service?: string; version?: string; timestamp?: string }>;
  startNewConversation: () => void;
  getActiveSession: () => {
    id: string;
    title: string;
    entries: Array<{ id: string; kind: string }>;
    history: Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp: string }>;
    omittedHistoryCount: number;
  };
  getSessions: () => Array<{ id: string; title: string }>;
  waitForInitialHealth: () => Promise<unknown>;
  destroy: () => void;
  isScrolledToBottom?: () => boolean;
  scrollToBottom?: (options?: { force?: boolean }) => void;
}

const INDEX_HTML = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');

function extractBodyHtml(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match?.[1]) {
    throw new Error('Could not extract <body> from public/index.html');
  }
  return match[1];
}

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Recall Agent Chat UI (public/index.html + app.js + api.js)', () => {
  const mountedApps: CreateChatAppResult[] = [];
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__RECALL_TEST_ENV__ = true;
    document.body.innerHTML = extractBodyHtml(INDEX_HTML);
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    while (mountedApps.length > 0) {
      mountedApps.pop()?.destroy();
    }
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function mountApp(
    fetchMock: typeof fetch,
    overrides?: { maxHistoryItems?: number; maxBodyBytes?: number },
  ): Promise<CreateChatAppResult> {
    const appModule = await import('../public/app.js');
    expect(appModule.MAX_MESSAGE_CHARS).toBe(CONTRACT_MAX_MESSAGE_CHARS);
    const instance = appModule.createChatApp({ persistence: false,
      root: document,
      fetchImpl: fetchMock,
      maxHistoryItems: overrides?.maxHistoryItems,
      maxBodyBytes: overrides?.maxBodyBytes,
    });
    mountedApps.push(instance);
    await instance.waitForInitialHealth();
    return instance;
  }

  it('1. renders initial welcome UI, starter prompts, and live server health status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(input).toBe('/health');
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'minimi-recall-agent',
          version: '1.0.0',
          timestamp: '2026-11-12T10:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await mountApp(fetchMock);

    const welcomeView = document.getElementById('welcome-view') as HTMLElement;
    const threadView = document.getElementById('thread-view') as HTMLElement;
    const connectionText = document.getElementById('connection-text') as HTMLElement;
    const connectionDot = document.getElementById('connection-dot') as HTMLElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const starterCards = document.querySelectorAll('.starter-card');

    expect(welcomeView.hidden).toBe(false);
    expect(threadView.hidden).toBe(true);
    expect(connectionDot.classList.contains('is-online')).toBe(true);
    expect(connectionText.textContent).toContain('Connected');
    expect(sendButton.disabled).toBe(true);
    expect(starterCards).toHaveLength(3);
  });

  it('2. populates composer when clicking a starter card without auto-submitting', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), { status: 200 });
    });

    await mountApp(fetchMock);

    const firstCard = document.querySelector('.starter-card') as HTMLButtonElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;

    firstCard.click();

    expect(chatInput.value).toBe('What did we discuss about Postgres hosting?');
    expect(sendButton.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Only /health was called
  });

  it('3. prevents empty/whitespace submission and rejects over-limit input', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await mountApp(fetchMock);

    const form = document.getElementById('composer-form') as HTMLFormElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const charCounter = document.getElementById('char-counter') as HTMLElement;

    chatInput.value = '   \n\t  ';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sendButton.disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    chatInput.value = 'a'.repeat(CONTRACT_MAX_MESSAGE_CHARS + 1);
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sendButton.disabled).toBe(true);
    expect(charCounter.classList.contains('is-over')).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4. sends POST /api/chat with exact backend contract fields (conversationId, message, timezone, history)', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), { status: 200 });
      }
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          error: {
            code: 'AGENT_NOT_IMPLEMENTED',
            message: 'Chat agent pipeline is not implemented yet.',
          },
          requestId: 'req-contract-1',
          conversationId: 'conv-test',
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'What happened on November 3?';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(capturedBodies).toHaveLength(1);
    const firstPayload = capturedBodies[0];
    expect(typeof firstPayload.conversationId).toBe('string');
    expect(firstPayload.conversationId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(firstPayload.message).toBe('What happened on November 3?');
    expect(firstPayload.history).toBeUndefined(); // No prior turns yet

    // Send second message in same session -> includes history of turn 1
    chatInput.value = 'Compare with yesterday.';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(capturedBodies).toHaveLength(2);
    const secondPayload = capturedBodies[1];
    expect(Array.isArray(secondPayload.history)).toBe(true);
    const history = secondPayload.history as Array<{ role: string; content: string; timestamp: string }>;
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What happened on November 3?');
    expect(Number.isNaN(Date.parse(history[0].timestamp))).toBe(false);
  });

  it('5. displays honest HTTP 501 notice card with requestId, expandable payload, and working retry', async () => {
    let chatAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      chatAttempts += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 'AGENT_NOT_IMPLEMENTED',
            message: 'Chat agent pipeline is not implemented yet.',
          },
          requestId: `req-501-${chatAttempts}`,
          conversationId: 'sess-501',
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    chatInput.value = 'Check Postgres comparison';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const messageList = document.getElementById('message-list') as HTMLElement;
    expect(messageList.textContent).toContain('HTTP 501');
    expect(messageList.textContent).toContain('AGENT_NOT_IMPLEMENTED');
    expect(messageList.textContent).toContain('req-501-1');
    expect(messageList.textContent).toContain('Chat responses aren’t available yet');

    const toggleBtn = messageList.querySelector('.telemetry-toggle-btn') as HTMLButtonElement;
    const pre = messageList.querySelector('.telemetry-pre') as HTMLElement;
    expect(pre.hidden).toBe(true);
    toggleBtn.click();
    expect(pre.hidden).toBe(false);

    // Retry re-invokes POST /api/chat without duplicating the user bubble
    const retryBtn = messageList.querySelector('[data-action="retry-request"]') as HTMLButtonElement;
    retryBtn.click();
    await flushMicrotasks();

    expect(chatAttempts).toBe(2);
    expect(messageList.querySelectorAll('.turn-user')).toHaveLength(1);
    expect(messageList.textContent).toContain('req-501-2');
  });

  it('6. handles network failure honestly and recovers on retry', async () => {
    let failNetwork = true;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (failNetwork) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Not implemented yet.' },
          requestId: 'req-recovered',
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    chatInput.value = 'Test network retry';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const messageList = document.getElementById('message-list') as HTMLElement;
    expect(messageList.textContent).toContain('Network Error');
    expect(messageList.textContent).toContain('Couldn’t reach the server');

    failNetwork = false;
    const retryBtn = messageList.querySelector('[data-action="retry-request"]') as HTMLButtonElement;
    retryBtn.click();
    await flushMicrotasks();

    expect(messageList.textContent).toContain('req-recovered');
  });

  it('7. locks composer to prevent duplicate concurrent submissions and supports cancel/abort', async () => {
    const deferred = createDeferred<Response>();
    let chatCalls = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      chatCalls += 1;
      init?.signal?.addEventListener('abort', () => {
        const abortError = new Error('The user aborted a request.');
        abortError.name = 'AbortError';
        deferred.reject(abortError);
      });
      return deferred.promise;
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'In-flight request test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // While in flight: input and send button disabled, duplicate submit ignored
    expect(chatInput.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(chatCalls).toBe(1);

    // Clicking Cancel aborts fetch and renders honest Cancelled notice
    const cancelBtn = document.querySelector('[data-action="cancel-request"]') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    await flushMicrotasks();

    expect(chatInput.disabled).toBe(false);
    expect(document.getElementById('message-list')?.textContent).toContain('Request cancelled');
  });

  it('8. New conversation resets welcome state while retaining prior session in session list', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Not implemented' },
          requestId: 'req-reset',
        }),
        { status: 501 },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
    const welcomeView = document.getElementById('welcome-view') as HTMLElement;
    const threadView = document.getElementById('thread-view') as HTMLElement;
    const sessionList = document.getElementById('session-list') as HTMLElement;

    chatInput.value = 'First session prompt';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(welcomeView.hidden).toBe(true);
    expect(threadView.hidden).toBe(false);
    expect(sessionList.textContent).toContain('First session prompt');

    newChatBtn.click();

    expect(welcomeView.hidden).toBe(false);
    expect(threadView.hidden).toBe(true);
    expect(chatInput.value).toBe('');
  });

  it('9. renders arbitrary user and server error text via textContent without HTML/script injection', async () => {
    const xssMessage = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'VALIDATION_ERROR', message: xssMessage },
          requestId: 'req-xss',
        }),
        { status: 400 },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    chatInput.value = xssMessage;
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const messageList = document.getElementById('message-list') as HTMLElement;
    expect(messageList.querySelector('script')).toBeNull();
    expect(messageList.querySelector('img[src="x"]')).toBeNull();
    expect(messageList.textContent).toContain(xssMessage);
  });

  it('10. Enter submits, Shift+Enter preserves newline, and IME composing Enter does not submit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Pending' },
          requestId: 'req-keys',
        }),
        { status: 501 },
      );
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    chatInput.value = 'Keyboard handling check';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Shift+Enter -> no submit
    chatInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // IME composition Enter -> no submit
    chatInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Plain Enter -> submits to POST /api/chat
    chatInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('11. sendChatRequest handles 400 validation details and future 200/SSE responses cleanly', async () => {
    const { sendChatRequest } = await import('../public/api.js');

    const validationFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request payload',
            details: [{ path: 'message', message: 'Required' }],
          },
          requestId: 'req-400',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const errResult = await sendChatRequest({ message: 'hi' }, { fetchImpl: validationFetch });
    expect(errResult.kind).toBe('http_error');
    expect(errResult.status).toBe(400);
    expect(errResult.details).toEqual([{ path: 'message', message: 'Required' }]);
    expect(errResult.requestId).toBe('req-400');

    const sseFetch = vi.fn<typeof fetch>(async () => {
      return new Response(streamText(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': chatMeta.requestId },
      });
    });

    const sseResult = await sendChatRequest({ message: 'stream test' }, { fetchImpl: sseFetch });
    expect(sseResult.kind).toBe('ok');
    expect(sseResult.status).toBe(200);
    expect(sseResult.requestId).toBe(chatMeta.requestId);
    expect(sseResult.contentType).toContain('text/event-stream');
  });

  it.each(['complete', 'partial'] as const)('renders real %s answers safely and applies history policy', async (coverage) => {
    const bodies: Array<{ conversationId: string; history?: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (url === '/health') return new Response('{"status":"ok"}');
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return new Response(streamText({ ...chatResult,
        message: { ...chatResult.message, content: '<script>alert(1)</script> Evidence [S1]' },
        sources: [chatSource], coverage, issues: coverage === 'partial' ? ['search_failed'] : [],
      }).replace(chatMeta.conversationId, body.conversationId), { headers: { 'content-type': 'text/event-stream' } });
    });
    const app = await mountApp(fetchMock);
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    for (const prompt of ['first', 'followup']) {
      input.value = prompt; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    }
    const answer = document.querySelector('.assistant-answer-card')!;
    expect(answer.textContent).toContain('<script>alert(1)</script>'); expect(answer.querySelector('script')).toBeNull();
    const link = answer.querySelector('a')!; expect(link.href).toBe(chatSource.url); expect(link.rel).toContain('noopener');
    expect(document.querySelector('.answer-sources')?.textContent).toContain(chatSource.title);
    expect(document.querySelector('.answer-sources img')).toBeNull();
    expect(document.querySelector('.answer-sources')?.textContent).not.toContain('Effective:');
    expect(Boolean(document.querySelector('.research-limitation'))).toBe(coverage === 'partial');
    expect(bodies[1].history?.some((h) => h.role === 'assistant')).toBe(coverage === 'complete');
    expect(app.getActiveSession().history.filter((h) => h.role === 'assistant')).toHaveLength(coverage === 'complete' ? 1 : 0);
  });

  it('does not record an answer before completion and clean EOF, or after cancellation', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (url === '/health') return new Response('{"status":"ok"}');
      const body = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({ start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode(streamText().replace(chatMeta.conversationId, body.conversationId)));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const app = await mountApp(fetchMock);
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'hello'; document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(app.getActiveSession().history.some((h) => h.role === 'assistant')).toBe(false);
    expect(document.querySelector('.assistant-answer-card')).toBeNull();
    (document.querySelector('[data-action="cancel-request"]') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(app.getActiveSession().history.some((h) => h.role === 'assistant')).toBe(false);
    expect(document.getElementById('message-list')?.textContent).toContain('Request cancelled');
    expect(streamController).toBeDefined();
  });

  it('12. makes compact/collapsed sidebar inert, synchronizes aria-expanded, and manages focus across open, Escape, New Chat, and resize', async () => {
    let isCompact = true;
    const changeListeners = new Set<(event: MediaQueryListEvent) => void>();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('960px') ? isCompact : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          changeListeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          changeListeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }));

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await mountApp(fetchMock);

    const appShell = document.getElementById('app-shell') as HTMLElement;
    const sidebar = document.getElementById('sidebar') as HTMLElement;
    const toggleBtn = document.getElementById('sidebar-toggle-btn') as HTMLButtonElement;
    const closeBtn = document.getElementById('sidebar-close-btn') as HTMLButtonElement;
    const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

    // Initial compact state: drawer closed, inert, aria-hidden="true", aria-expanded="false"
    expect(appShell.classList.contains('drawer-open')).toBe(false);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(true);

    // Open mobile drawer: removes inert and moves focus inside sidebar
    toggleBtn.focus();
    toggleBtn.click();
    expect(appShell.classList.contains('drawer-open')).toBe(true);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(closeBtn);

    // Escape closes drawer and restores focus to toggle button
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(appShell.classList.contains('drawer-open')).toBe(false);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(toggleBtn);

    // Open drawer and click New conversation: closes drawer cleanly and moves focus to chatInput
    toggleBtn.click();
    newChatBtn.focus();
    newChatBtn.click();
    expect(appShell.classList.contains('drawer-open')).toBe(false);
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(chatInput);

    // Transition to desktop (>960px) -> sidebar becomes visible & interactive;
    // focusing inside desktop sidebar and shrinking back to compact moves focus out before inerting
    isCompact = false;
    window.dispatchEvent(new Event('resize'));
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    newChatBtn.focus();
    expect(sidebar.contains(document.activeElement)).toBe(true);

    isCompact = true;
    for (const listener of changeListeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(sidebar.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('13. returns aborted when AbortController cancels while reading an HTTP 501 response body', async () => {
    const { sendChatRequest } = await import('../public/api.js');
    const controller = new AbortController();

    const abortDuringBodyFetch = vi.fn<typeof fetch>(async () => {
      return {
        ok: false,
        status: 501,
        headers: new Headers({ 'content-type': 'application/json', 'x-request-id': 'req-abort-body' }),
        text: async () => {
          controller.abort();
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          throw err;
        },
      } as unknown as Response;
    });

    const result = await sendChatRequest(
      { message: 'Cancel during body' },
      { signal: controller.signal, fetchImpl: abortDuringBodyFetch },
    );

    expect(result.kind).toBe('aborted');
  });

  it('14. distinguishes non-abort body read errors from malformed JSON and genuine 501 AGENT_NOT_IMPLEMENTED', async () => {
    const { sendChatRequest } = await import('../public/api.js');

    const unreadableBodyFetch = vi.fn<typeof fetch>(async () => {
      return {
        ok: false,
        status: 501,
        headers: new Headers({ 'content-type': 'application/json', 'x-request-id': 'req-read-err' }),
        text: async () => {
          throw new TypeError('Stream interrupted');
        },
      } as unknown as Response;
    });

    const readErr = await sendChatRequest({ message: 'Read fail' }, { fetchImpl: unreadableBodyFetch });
    expect(readErr.kind).toBe('http_error');
    expect(readErr.status).toBe(501);
    expect(readErr.code).toBe('RESPONSE_READ_ERROR');

    const malformedJsonFetch = vi.fn<typeof fetch>(async () => {
      return new Response('<html>501 Gateway page</html>', {
        status: 501,
        headers: { 'content-type': 'text/html', 'x-request-id': 'req-malformed' },
      });
    });

    const malformed = await sendChatRequest({ message: 'Malformed' }, { fetchImpl: malformedJsonFetch });
    expect(malformed.kind).toBe('http_error');
    expect(malformed.status).toBe(501);
    expect(malformed.code).toBe('MALFORMED_JSON');

    const real501Fetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Not active yet.' },
          requestId: 'req-real-501',
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });

    const real501 = await sendChatRequest({ message: 'Honest 501' }, { fetchImpl: real501Fetch });
    expect(real501.kind).toBe('not_implemented');
    expect(real501.code).toBe('AGENT_NOT_IMPLEMENTED');
    expect(real501.requestId).toBe('req-real-501');
  });

  it('15. enforces 100-item ceiling, exact UTF-8 byte ceiling under 262,144 bytes, and preserves original content', async () => {
    const { buildBoundedChatBody, getUtf8ByteLength } = await import('../public/api.js');

    const makeItems = (count: number, textForIndex: (idx: number) => string) =>
      Array.from({ length: count }, (_, idx) => ({
        id: `msg_${idx}`,
        role: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: textForIndex(idx),
        timestamp: new Date(1700000000000 + idx * 1000).toISOString(),
      }));

    // Exactly 100 items fits intact
    const exact100 = buildBoundedChatBody({
      conversationId: 'conv_100',
      message: 'Turn 101',
      timezone: 'Asia/Kolkata',
      history: makeItems(CONTRACT_MAX_HISTORY_ITEMS, (i) => `Turn ${i}`),
    });
    expect(exact100.body.history).toHaveLength(100);
    expect(exact100.omittedCount).toBe(0);
    expect(exact100.body.history?.[0].content).toBe('Turn 0');
    expect(exact100.body.history?.[99].content).toBe('Turn 99');

    // 105 items drops oldest 5, preserves newest 100 intact
    const over100 = buildBoundedChatBody({
      conversationId: 'conv_105',
      message: 'Current turn',
      timezone: 'Asia/Kolkata',
      history: makeItems(CONTRACT_MAX_HISTORY_ITEMS + 5, (i) => `Item-${i}`),
    });
    expect(over100.body.history).toHaveLength(CONTRACT_MAX_HISTORY_ITEMS);
    expect(over100.omittedCount).toBe(5);
    expect(over100.body.history?.[0].content).toBe('Item-5');
    expect(over100.body.history?.[99].content).toBe('Item-104');

    // Multi-byte UTF-8 test: emoji '🚀' (4 UTF-8 bytes vs 2 JS chars) and Devanagari 'क' (3 UTF-8 bytes vs 1 JS char)
    // 20 history items x ~18,000 UTF-8 bytes each > 262,144 total bytes even though count=20 <= 100
    const multiByteContent = '🚀'.repeat(4000) + 'क'.repeat(600); // 16000 + 1800 = 17,800 UTF-8 bytes, 8,600 chars
    expect(multiByteContent.length).toBeLessThanOrEqual(CONTRACT_MAX_HISTORY_CONTENT_CHARS);

    const utf8Heavy = buildBoundedChatBody({
      conversationId: 'conv_utf8_heavy',
      message: '🚀'.repeat(2000),
      timezone: 'Asia/Kolkata',
      history: makeItems(20, (i) => `${i}:${multiByteContent}`),
    });

    expect(utf8Heavy.serializedBytes).toBeLessThan(262_144);
    expect(getUtf8ByteLength(JSON.stringify(utf8Heavy.body))).toBeLessThan(262_144);
    expect(utf8Heavy.omittedCount).toBeGreaterThan(0);
    expect(utf8Heavy.body.history && utf8Heavy.body.history.length).toBeGreaterThan(0);
    // Every retained item keeps its full original multi-byte content unchanged
    const lastRetained = utf8Heavy.body.history![utf8Heavy.body.history!.length - 1];
    expect(lastRetained.content).toBe(`19:${multiByteContent}`);
  });

  it('16. omits oldest context in UI requests, keeps full display thread, shows omission note, and excludes 501/error notices from history', async () => {
    const sentPayloads: Array<{ message: string; history?: Array<{ role: string; content: string }> }> = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      const parsed = JSON.parse(String(init?.body)) as {
        message: string;
        history?: Array<{ role: string; content: string }>;
      };
      sentPayloads.push(parsed);
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Pending implementation' },
          requestId: `req-hist-${sentPayloads.length}`,
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });

    const app = await mountApp(fetchMock, { maxHistoryItems: 2 });
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    const omittedNote = document.getElementById('omitted-history-note') as HTMLElement;

    for (const msg of ['Prompt 1', 'Prompt 2', 'Prompt 3', 'Prompt 4']) {
      chatInput.value = msg;
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    }

    // Full display stays in UI and full session history stays in memory (user messages only, no 501 placeholder assistant entries)
    expect(document.querySelectorAll('.turn-user')).toHaveLength(4);
    const activeHistory = app.getActiveSession().history;
    expect(activeHistory).toHaveLength(4);
    expect(activeHistory.every((h) => h.role === 'user')).toBe(true);

    // 4th request can send at most maxHistoryItems=2 prior turns ('Prompt 2', 'Prompt 3') -> 1 omitted
    const fourthPayload = sentPayloads[3];
    expect(fourthPayload.message).toBe('Prompt 4');
    expect(fourthPayload.history?.map((h) => h.content)).toEqual(['Prompt 2', 'Prompt 3']);
    expect(omittedNote.hidden).toBe(false);
    expect(omittedNote.textContent).toContain('1 earlier session message was omitted');
  });

  it('17. does not overwrite New conversation live-status announcement when an old aborted request settles', async () => {
    const deferred = createDeferred<Response>();

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      init?.signal?.addEventListener('abort', () => {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        deferred.reject(abortErr);
      });
      return deferred.promise;
    });

    await mountApp(fetchMock);

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
    const liveStatus = document.getElementById('live-status') as HTMLElement;
    const sessionList = document.getElementById('session-list') as HTMLElement;

    chatInput.value = 'In-flight before New Chat';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Trigger New Chat while request is pending
    newChatBtn.click();
    expect(liveStatus.textContent).toBe('Started a new conversation.');

    // Let aborted Session A promise finish asynchronously
    await flushMicrotasks();

    // Active announcement MUST NOT be overwritten by stale "Chat request cancelled."
    expect(liveStatus.textContent).toBe('Started a new conversation.');
    expect((document.getElementById('welcome-view') as HTMLElement).hidden).toBe(false);

    // Switching back to Session A shows its Request cancelled card
    const oldSessionBtn = sessionList.querySelector('.session-item-btn') as HTMLButtonElement;
    oldSessionBtn.click();
    expect(document.getElementById('message-list')?.textContent).toContain('Request cancelled');
  });

  it('18. manifest.webmanifest icon sizes match actual PNG dimensions on disk', () => {
    const manifestRaw = readFileSync(
      resolve(import.meta.dirname, '..', 'public', 'manifest.webmanifest'),
      'utf8',
    );
    const manifest = JSON.parse(manifestRaw) as {
      icons: Array<{ src: string; sizes: string }>;
    };

    for (const icon of manifest.icons) {
      const relativeFile = icon.src.replace(/^\//, '');
      const bytes = readFileSync(resolve(import.meta.dirname, '..', 'public', relativeFile));
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(icon.sizes).toBe(`${width}x${height}`);
      expect(icon.sizes).toBe('1024x1024');
    }
  });

  it('19. blocks oversized message-only and UTF-8/metadata envelopes above maxBodyBytes with zero fetch calls', async () => {
    const { buildBoundedChatBody, getUtf8ByteLength, sendChatRequest } = await import('../public/api.js');

    // Exact Codex reproduction: maxBodyBytes=1024, 2000 ASCII chars -> 2014 serialized bytes -> blocked
    const message2000 = 'a'.repeat(2000);
    const overBase = buildBoundedChatBody({ message: message2000 }, { maxBodyBytes: 1024 });
    expect(overBase.ok).toBe(false);
    expect(overBase.exceedsLimit).toBe(true);
    expect(overBase.serializedBytes).toBe(2014);
    expect(overBase.body.message).toBe(message2000); // Never truncated

    const neverCalledFetch = vi.fn<typeof fetch>();
    const blockedResult = await sendChatRequest(
      { message: message2000 },
      { maxBodyBytes: 1024, fetchImpl: neverCalledFetch },
    );
    expect(neverCalledFetch).not.toHaveBeenCalled();
    expect(blockedResult.kind).toBe('http_error');
    expect(blockedResult.status).toBe(413);
    expect(blockedResult.code).toBe('PAYLOAD_TOO_LARGE');

    // Non-ASCII multi-byte emoji message: 300 '🚀' = 600 JS chars (< 1024) but 1,214 UTF-8 bytes (> 1024)
    const emojiMessage = '🚀'.repeat(300);
    expect(emojiMessage.length).toBe(600);
    const emojiCheck = buildBoundedChatBody({ message: emojiMessage }, { maxBodyBytes: 1024 });
    expect(emojiCheck.exceedsLimit).toBe(true);
    expect(emojiCheck.serializedBytes).toBe(1214);
    await sendChatRequest({ message: emojiMessage }, { maxBodyBytes: 1024, fetchImpl: neverCalledFetch });
    expect(neverCalledFetch).not.toHaveBeenCalled();

    // Oversized base envelope caused by metadata (conversationId + timezone + JSON overhead)
    const metadataOver = buildBoundedChatBody(
      {
        conversationId: 'c'.repeat(128),
        timezone: 'America/Argentina/ComodRivadavia',
        message: 'm'.repeat(900),
      },
      { maxBodyBytes: 1024 },
    );
    expect(metadataOver.exceedsLimit).toBe(true);
    expect(metadataOver.serializedBytes).toBe(
      getUtf8ByteLength(JSON.stringify(metadataOver.body)),
    );
    expect(metadataOver.serializedBytes).toBeGreaterThan(1024);

    // Message-only request within 1024 bytes IS permitted and invokes fetch once
    const allowedFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Pending' } }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });
    const okResult = await sendChatRequest(
      { message: 'm'.repeat(500) },
      { maxBodyBytes: 1024, fetchImpl: allowedFetch },
    );
    expect(allowedFetch).toHaveBeenCalledTimes(1);
    expect(okResult.kind).toBe('not_implemented');
  });

  it('20. UI composer rejects oversized drafts before calling fetch while preserving user draft for editing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Pending' },
          requestId: 'req-shortened',
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });

    await mountApp(fetchMock, { maxBodyBytes: 1024 });

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    const composerError = document.getElementById('composer-error') as HTMLElement;

    const longDraft = 'x'.repeat(2000);
    chatInput.value = longDraft;
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Only /health was called; /api/chat was NEVER invoked
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(composerError.hidden).toBe(false);
    expect(composerError.textContent).toContain('too large');
    expect(chatInput.value).toBe(longDraft); // Draft preserved intact
    expect(document.querySelectorAll('.turn-user')).toHaveLength(0);

    // User shortens draft -> error clears on input and submission proceeds
    chatInput.value = 'Short prompt now';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(composerError.hidden).toBe(true);

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.getElementById('message-list')?.textContent).toContain('HTTP 501');
  });

  it('21. never invents assistant messages or contaminates history when HTTP 200 returns {} or unsupported payloads', async () => {
    const sentBodies: Array<{ message: string; history?: Array<{ role: string; content: string }> }> = [];
    let turnIndex = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      turnIndex += 1;
      sentBodies.push(
        JSON.parse(String(init?.body)) as {
          message: string;
          history?: Array<{ role: string; content: string }>;
        },
      );
      if (turnIndex === 1) {
        // Codex reproduction: HTTP 200 with {}
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-empty-200' },
        });
      }
      if (turnIndex === 2) {
        // Uncontracted JSON payload (neither DESIGN.md nor contracts.ts defines this)
        return new Response(JSON.stringify({ answer: 'Uncontracted reply', message: 'Also unsupported' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-uncontracted-200' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Pending' },
          requestId: 'req-turn3-501',
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;
    const messageList = document.getElementById('message-list') as HTMLElement;

    // Turn 1 -> HTTP 200 {}
    chatInput.value = 'Turn 1 empty 200';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(messageList.querySelector('.assistant-answer-card')).toBeNull();
    expect(messageList.textContent).toContain('Unsupported server response');
    expect(messageList.textContent).not.toContain('Connected to /api/chat, and the server returned an HTTP 200 response.');
    expect(app.getActiveSession().history.map((h) => [h.role, h.content])).toEqual([
      ['user', 'Turn 1 empty 200'],
    ]);

    // Turn 2 -> HTTP 200 with uncontracted keys
    chatInput.value = 'Turn 2 unsupported payload';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(sentBodies[1].history?.map((h) => [h.role, h.content])).toEqual([
      ['user', 'Turn 1 empty 200'],
    ]);
    expect(messageList.querySelector('.assistant-answer-card')).toBeNull();

    // Turn 3 -> genuine 501 still works; history contains ONLY user turns
    chatInput.value = 'Turn 3 genuine 501';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(sentBodies[2].history?.map((h) => [h.role, h.content])).toEqual([
      ['user', 'Turn 1 empty 200'],
      ['user', 'Turn 2 unsupported payload'],
    ]);
    expect(messageList.textContent).toContain('Chat responses aren’t available yet');
    expect(app.getActiveSession().history.some((h) => h.role === 'assistant')).toBe(false);
  });

  it('22. clicking composer form padding or non-interactive areas delegates focus to chat input', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await mountApp(fetchMock);

    const form = document.getElementById('composer-form') as HTMLFormElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const charCounter = document.getElementById('char-counter') as HTMLElement;
    const keyboardHint = document.querySelector('.keyboard-hint') as HTMLElement;
    const sendButton = document.getElementById('send-button') as HTMLButtonElement;

    // Start with something else focused or unfocused
    document.body.focus();
    expect(document.activeElement).not.toBe(chatInput);

    // Clicking on form card background focuses chatInput
    form.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chatInput);

    // Blur and test clicking keyboard hint
    chatInput.blur();
    expect(document.activeElement).not.toBe(chatInput);
    keyboardHint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chatInput);

    // Blur and test clicking char counter
    chatInput.blur();
    expect(document.activeElement).not.toBe(chatInput);
    charCounter.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chatInput);

    // Selection position is placed at end
    chatInput.value = 'Existing text';
    chatInput.blur();
    form.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(chatInput);
    expect(chatInput.selectionStart).toBe('Existing text'.length);
    expect(chatInput.selectionEnd).toBe('Existing text'.length);

    // Clicking send button when disabled does not trigger error
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // If chatInput is disabled during active request, clicking form does not focus
    document.body.focus();
    chatInput.disabled = true;
    expect(document.activeElement).not.toBe(chatInput);
    form.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(chatInput);
  });

  it('23. verifies CSS layout rules for root scrolling and composer affordance', () => {
    const cssPath = resolve(import.meta.dirname, '..', 'public', 'styles.css');
    const css = readFileSync(cssPath, 'utf8');

    // html must be the viewport scroll container
    expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*hidden;/);
    expect(css).toMatch(/html\s*\{[^}]*overflow-y:\s*auto;/);

    // body must have overflow: visible to prevent trapping scroll/wheel events
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*visible;/);
    // body must NOT have overscroll-behavior: none which cancels wheel bubbling
    expect(css).not.toMatch(/body\s*\{[^}]*overscroll-behavior:\s*none;/);

    // composer-form must have cursor: text and pointer-events: auto
    expect(css).toMatch(/\.composer-form\s*\{[^}]*pointer-events:\s*auto;/);
    expect(css).toMatch(/\.composer-form\s*\{[^}]*cursor:\s*text;/);

    // composer-dock has pointer-events: none so clicks outside form pass through
    expect(css).toMatch(/\.composer-dock\s*\{[^}]*pointer-events:\s*none;/);
  });

  it('24. maintains chat input focus after new chat and submission recovery', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AGENT_NOT_IMPLEMENTED', message: 'Chat agent is under construction' },
          requestId: 'req-501',
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      );
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    // Submit message
    chatInput.value = 'Hello';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // After 501, chatInput should be re-enabled and focused
    expect(chatInput.disabled).toBe(false);
    expect(document.activeElement).toBe(chatInput);

    // Start New Conversation focuses chatInput
    chatInput.blur();
    expect(document.activeElement).not.toBe(chatInput);
    app.startNewConversation();
    expect(document.activeElement).toBe(chatInput);
  });

  it('25. automatically scrolls to latest message when user sends a prompt and tracks bottom state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(streamText().replace(chatMeta.conversationId, body.conversationId), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    expect(app.isScrolledToBottom?.()).toBe(true);

    chatInput.value = 'First prompt';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.assistant-answer-card')).not.toBeNull();
  });

  it('26. keeps view scrolled to bottom as streaming progress updates arrive', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let conversationId = '';
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const encoder = new TextEncoder();

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      conversationId = body.conversationId;
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Stream progress test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Stream meta + accepted
    controller.enqueue(encoder.encode(
      `event: meta\ndata: {"version":"recall.chat.v1","requestId":"11111111-1111-4111-8111-111111111111","conversationId":"${conversationId}","answerMode":"final"}\n\n` +
      'event: progress\ndata: {"phase":"accepted"}\n\n'
    ));
    await flushMicrotasks();
    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.loading-label')?.textContent).toBe('Request accepted');

    // Stream model progress
    controller.enqueue(encoder.encode(
      'event: progress\ndata: {"phase":"model_started","call":1}\n\n'
    ));
    await flushMicrotasks();
    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.loading-label')?.textContent).toBe('Waiting for the model response…');

    // Stream search progress
    controller.enqueue(encoder.encode(
      'event: progress\ndata: {"phase":"search_started","attempt":1}\n\n'
    ));
    await flushMicrotasks();
    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.loading-label')?.textContent).toBe('Searching the web…');

    // Stream result + done
    controller.enqueue(encoder.encode(
      'event: result\ndata: {"message":{"id":"msg_test","role":"assistant","content":"Done [S1]","timestamp":"2026-11-14T00:00:00.000Z"},"coverage":"complete","issues":[],"sources":[{"id":"S1","query":"q","title":"T","url":"https://example.com","retrieved_at":"2026-11-14T00:00:00Z"}],"evidenceCheck":"citation_ids_only"}\n\n' +
      'event: done\ndata: {"outcome":"completed","messageId":"msg_test"}\n\n'
    ));
    controller.close();
    await flushMicrotasks();

    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.assistant-answer-card')).not.toBeNull();
  });

  it('27. preserves user scroll position when manually scrolled up during streaming and completion', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let conversationId = '';
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const encoder = new TextEncoder();

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      conversationId = body.conversationId;
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Scroll up test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Stream meta + accepted
    controller.enqueue(encoder.encode(
      `event: meta\ndata: {"version":"recall.chat.v1","requestId":"11111111-1111-4111-8111-111111111111","conversationId":"${conversationId}","answerMode":"final"}\n\n` +
      'event: progress\ndata: {"phase":"accepted"}\n\n'
    ));
    await flushMicrotasks();

    // Simulate user manually scrolling up (e.g. reading past messages)
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 500, configurable: true });
    document.documentElement.scrollTop = 200;
    document.dispatchEvent(new Event('scroll'));

    expect(app.isScrolledToBottom?.()).toBe(false);

    // Stream progress while user is scrolled up
    controller.enqueue(encoder.encode(
      'event: progress\ndata: {"phase":"model_started","call":1}\n\n'
    ));
    await flushMicrotasks();

    // Scroll position should NOT be forced to bottom
    expect(document.documentElement.scrollTop).toBe(200);
    expect(app.isScrolledToBottom?.()).toBe(false);

    // Complete response while user is scrolled up
    controller.enqueue(encoder.encode(
      'event: result\ndata: {"message":{"id":"msg_test","role":"assistant","content":"Done [S1]","timestamp":"2026-11-14T00:00:00.000Z"},"coverage":"complete","issues":[],"sources":[{"id":"S1","query":"q","title":"T","url":"https://example.com","retrieved_at":"2026-11-14T00:00:00Z"}],"evidenceCheck":"citation_ids_only"}\n\n' +
      'event: done\ndata: {"outcome":"completed","messageId":"msg_test"}\n\n'
    ));
    controller.close();
    await flushMicrotasks();

    // Answer rendered, but user scroll position preserved at 200
    expect(document.documentElement.scrollTop).toBe(200);
    expect(app.isScrolledToBottom?.()).toBe(false);
    expect(document.querySelector('.assistant-answer-card')).not.toBeNull();
  });

  it('28. resumes auto-scrolling when user scrolls back near the bottom', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let conversationId = '';
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const encoder = new TextEncoder();

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      conversationId = body.conversationId;
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Resume scroll test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Simulate scrolled up
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 500, configurable: true });
    document.documentElement.scrollTop = 200;
    document.dispatchEvent(new Event('scroll'));
    expect(app.isScrolledToBottom?.()).toBe(false);

    // User scrolls back near bottom: scrollTop = 1450 (distanceFromBottom = 2000 - 1950 = 50 <= 120)
    document.documentElement.scrollTop = 1450;
    document.dispatchEvent(new Event('scroll'));
    expect(app.isScrolledToBottom?.()).toBe(true);

    // Next progress update automatically scrolls to bottom
    controller.enqueue(encoder.encode(
      `event: meta\ndata: {"version":"recall.chat.v1","requestId":"11111111-1111-4111-8111-111111111111","conversationId":"${conversationId}","answerMode":"final"}\n\n` +
      'event: progress\ndata: {"phase":"accepted"}\n\n'
    ));
    await flushMicrotasks();

    expect(document.documentElement.scrollTop).toBe(2000);
    expect(app.isScrolledToBottom?.()).toBe(true);
    controller.close();
  });

  it('29. handles retry actions by resetting isUserNearBottom and scrolling to bottom', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'TEST_ERROR', message: 'Fail' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Retry test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Notice card is rendered
    const retryBtn = document.querySelector('[data-action="retry-request"]') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    // Simulate scrolled up
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 1500, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 500, configurable: true });
    document.documentElement.scrollTop = 100;
    document.dispatchEvent(new Event('scroll'));
    expect(app.isScrolledToBottom?.()).toBe(false);

    // Click retry
    retryBtn.click();
    await flushMicrotasks();

    // Auto-scroll forced to bottom on retry
    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.documentElement.scrollTop).toBe(1500);
  });

  it('30. avoids scrollIntoView and scrolls container directly without page jitter', async () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      return new Response(streamText(), { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'No scrollIntoView test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(app.isScrolledToBottom?.()).toBe(true);
  });

  it('31. handles initial short conversation with auto-scroll and clean answer presentation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(
        streamText({
          ...chatResult,
          message: { id: 'msg_short', role: 'assistant', content: 'Short answer.', timestamp: '2026-11-14T00:00:00.000Z' },
        }).replace(chatMeta.conversationId, body.conversationId),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Short question';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const welcomeView = document.getElementById('welcome-view') as HTMLElement;
    const threadView = document.getElementById('thread-view') as HTMLElement;
    expect(welcomeView.hidden).toBe(true);
    expect(threadView.hidden).toBe(false);

    const assistantCard = document.querySelector('.assistant-answer-card');
    expect(assistantCard?.textContent).toContain('Short answer.');
    expect(app.isScrolledToBottom?.()).toBe(true);
  });

  it('32. handles long answers with sticky scrolling and respects user reading from top', async () => {
    const longContent = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}: detailed evidence and findings.`).join('\n\n');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(
        streamText({
          ...chatResult,
          message: { id: 'msg_long', role: 'assistant', content: longContent, timestamp: '2026-11-14T00:00:00.000Z' },
        }).replace(chatMeta.conversationId, body.conversationId),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Give me a long answer';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(app.isScrolledToBottom?.()).toBe(true);

    // Simulate reading from top (user scrolls up)
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 600, configurable: true });
    document.documentElement.scrollTop = 150;
    document.dispatchEvent(new Event('scroll'));

    expect(app.isScrolledToBottom?.()).toBe(false);
    expect(document.documentElement.scrollTop).toBe(150);

    // Unforced scrollToBottom does NOT jump user away from reading position
    app.scrollToBottom?.();
    expect(document.documentElement.scrollTop).toBe(150);
    expect(app.isScrolledToBottom?.()).toBe(false);
  });

  it('33. dynamically adjusts canvas padding-bottom for fixed composer clearance', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      return new Response(streamText(), { headers: { 'Content-Type': 'text/event-stream' } });
    });

    await mountApp(fetchMock);
    const mainCanvas = document.getElementById('main-canvas') as HTMLElement;
    const composerDock = document.querySelector('.composer-dock') as HTMLElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

    expect(mainCanvas.style.paddingBottom).toBe('164px');

    // Simulate composer expanding in height (e.g. multiline prompt)
    Object.defineProperty(composerDock, 'offsetHeight', { value: 210, configurable: true });
    chatInput.value = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Padding increases dynamically to 210 + 24 = 234px
    expect(parseInt(mainCanvas.style.paddingBottom, 10)).toBeGreaterThanOrEqual(234);
  });

  it('34. contains long source lists in a bounded scrollable panel and keeps view anchored on toggle', async () => {
    const multiSources = Array.from({ length: 6 }, (_, i) => ({
      id: `S${i + 1}`,
      query: `CRM pricing query ${i + 1}`,
      title: `Source Title ${i + 1}`,
      url: `https://example.com/source-${i + 1}`,
      retrieved_at: '2026-11-14T00:00:00Z',
    }));

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(
        streamText({
          ...chatResult,
          message: { id: 'msg_src', role: 'assistant', content: 'Verified [S1] and [S2].', timestamp: '2026-11-14T00:00:00.000Z' },
          sources: multiSources,
        }).replace(chatMeta.conversationId, body.conversationId),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Show many sources';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const disclosure = document.querySelector('details.answer-sources') as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();

    const sourceList = disclosure.querySelector('.source-list') as HTMLElement;
    expect(sourceList).not.toBeNull();
    expect(sourceList.querySelectorAll('.source-entry')).toHaveLength(6);

    const disclaimer = disclosure.querySelector('.sources-disclaimer') as HTMLElement;
    expect(disclaimer.textContent).toContain('Citation IDs checked only. Quotations and factual claims have not been verified.');

    // Toggle details open when near bottom
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));

    expect(app.isScrolledToBottom?.()).toBe(true);
  });

  it('35. safely formats markdown bold, inline code, escaped markdown and citation brackets without HTML injection or indiscriminate backslash removal', async () => {
    const trickyContent =
      '**Confirmed change**: Pricing increased to $20/mo [S1].\n' +
      '\\*\\*No confirmed change\\*\\* for tool 2 \\[S2\\].\n' +
      'File path C:\\Users\\test\\config.json with `npm run test` command.\n' +
      '<script>alert("xss")</script><img src="x" onerror="alert(1)">';

    const testSources = [
      { id: 'S1', query: 'q1', title: 'Source One', url: 'https://example.com/one', retrieved_at: '2026-11-14T00:00:00Z' },
      { id: 'S2', query: 'q2', title: 'Source Two', url: 'https://example.com/two', retrieved_at: '2026-11-14T00:00:00Z' },
    ];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(
        streamText({
          ...chatResult,
          message: { id: 'msg_md', role: 'assistant', content: trickyContent, timestamp: '2026-11-14T00:00:00.000Z' },
          sources: testSources,
        }).replace(chatMeta.conversationId, body.conversationId),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    chatInput.value = 'Markdown formatting test';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    const answerCard = document.querySelector('.assistant-answer-card') as HTMLElement;
    expect(answerCard).not.toBeNull();

    // Bold elements are created
    const bolds = answerCard.querySelectorAll('strong.answer-bold');
    expect(bolds.length).toBeGreaterThanOrEqual(2);
    expect(Array.from(bolds).map((b) => b.textContent)).toContain('Confirmed change');
    expect(Array.from(bolds).map((b) => b.textContent)).toContain('No confirmed change');

    // Inline code element
    const code = answerCard.querySelector('code.code-inline') as HTMLElement;
    expect(code).not.toBeNull();
    expect(code.textContent).toBe('npm run test');

    // Citation links
    const links = answerCard.querySelectorAll('a.citation-link') as NodeListOf<HTMLAnchorElement>;
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('[S1]');
    expect(links[0].href).toBe('https://example.com/one');
    expect(links[0].target).toBe('_blank');
    expect(links[0].rel).toBe('noopener noreferrer');
    expect(links[1].textContent).toBe('[S2]');
    expect(links[1].href).toBe('https://example.com/two');

    // Windows path preserved without backslash destruction
    expect(answerCard.textContent).toContain('C:\\Users\\test\\config.json');

    // XSS injection prevented: script and img are NOT DOM elements, but safe text
    expect(answerCard.querySelector('script')).toBeNull();
    expect(answerCard.querySelector('img')).toBeNull();
    expect(answerCard.textContent).toContain('<script>alert("xss")</script>');
  });

  it('36. handles mobile viewport resizing and maintains sticky scrolling', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (input === '/health') return new Response('{"status":"ok"}', { status: 200 });
      const body = JSON.parse(String(init?.body));
      return new Response(streamText().replace(chatMeta.conversationId, body.conversationId), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const app = await mountApp(fetchMock);
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const form = document.getElementById('composer-form') as HTMLFormElement;

    // Simulate mobile viewport
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 667, configurable: true });
    window.dispatchEvent(new Event('resize'));

    chatInput.value = 'Mobile test message';
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(app.isScrolledToBottom?.()).toBe(true);
    expect(document.querySelector('.assistant-answer-card')).not.toBeNull();
  });
});
