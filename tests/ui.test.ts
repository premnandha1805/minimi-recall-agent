// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const instance = appModule.createChatApp({
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
      return new Response('event: status\ndata: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'req-sse' },
      });
    });

    const sseResult = await sendChatRequest({ message: 'stream test' }, { fetchImpl: sseFetch });
    expect(sseResult.kind).toBe('ok');
    expect(sseResult.status).toBe(200);
    expect(sseResult.requestId).toBe('req-sse');
    expect(sseResult.contentType).toContain('text/event-stream');
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
});
