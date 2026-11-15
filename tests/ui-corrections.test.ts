// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatApp, type ChatAppInstance } from '../public/app.js';
import { result, source, streamText, meta } from './fixtures/chat-stream.js';

const html = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const apps: ChatAppInstance[] = [];
const flush = () => new Promise<void>((yes) => setTimeout(yes, 0));
let originalScrollDescriptors: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = [];
beforeEach(() => {
  originalScrollDescriptors = [
    { target: document.documentElement, key: 'scrollHeight' },
    { target: window, key: 'scrollY' },
  ].map(({ target, key }) => ({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }));
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1];
});
afterEach(() => {
  try { apps.splice(0).forEach((app) => app.destroy()); }
  finally {
    vi.restoreAllMocks();
    for (const { target, key, descriptor } of originalScrollDescriptors) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptor);
    }
    document.body.innerHTML = '';
  }
});
async function mount(content: string, failSecond = false) {
  let call = 0;
  const app = createChatApp({ root: document, fetchImpl: async (url, init) => {
    if (url === '/health') return new Response('{"status":"ok"}');
    const body = JSON.parse(String(init?.body));
    const attempt = ++call;
    if (failSecond && attempt === 2) return new Response('{"error":{"code":"FIXTURE","message":"Failed"}}',
      { status: 500, headers: { 'content-type': 'application/json' } });
    if (failSecond && attempt === 3) return new Promise<Response>(() => {});
    return new Response(streamText({ ...result, sources: [source], message: { ...result.message,
      id: `answer_${attempt}`, content } }).replace(meta.conversationId, body.conversationId),
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  apps.push(app); await app.waitForInitialHealth();
  const send = async () => {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = `Question ${call}`; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  };
  await send(); return { app, send };
}

describe('literal-safe formatting and source reader state', () => {
  it.each(['a\\_b C:\\_private\\file x\\*y \\`literal',
    '``a\\_b \\` literal [S1] **bold**``',
  ])('preserves literal text and protected code: %s', async (text) => {
    await mount(text);
    const card = document.querySelector('.assistant-answer-card')!;
    if (text.startsWith('``')) {
      expect(card.querySelector('code')?.textContent).toBe(text.slice(2, -2));
      expect(card.querySelector('a')).toBeNull(); expect(card.querySelector('strong')).toBeNull();
    } else if (!text.startsWith('`')) expect(card.textContent).toBe(text);
  });

  it('preserves code characters exactly while formatting ordinary text around code', async () => {
    const code = 'a\\_b C:\\_private x\\*y \\';
    await mount('**Confirmed** `' + code + '` [S1]');
    const card = document.querySelector('.assistant-answer-card')!;
    expect(card.querySelector('code')?.textContent).toBe(code);
    expect(card.querySelector('strong')?.textContent).toBe('Confirmed');
    expect(card.querySelector('a')?.getAttribute('href')).toBe(source.url);
  });

  it('handles underscore bold, paired escaped bold, newline boundaries and malformed emphasis', async () => {
    await mount('__Confirmed__ __announcement__ **one** **two** ' + String.raw`\*\*Escaped\*\*` + '\n' +
      '__line\nbreak__ ____ __ __ a_b ' + 'a\\_b \\_literal\\_ \\');
    const card = document.querySelector('.assistant-answer-card')!;
    expect([...card.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['Confirmed', 'announcement', 'one', 'two', 'Escaped']);
    expect(card.textContent).toContain('__line\nbreak__ ____ __ __ a_b');
    expect(card.textContent).toContain('a\\_b \\_literal\\_ \\');
  });

  it('links escaped registered citations and keeps hostile HTML as text', async () => {
    await mount(String.raw`\[S1\] [S1\] \[S1] <img src=x onerror=alert(1)> <script>x</script>`);
    const card = document.querySelector('.assistant-answer-card')!;
    expect(card.querySelectorAll('a.citation-link')).toHaveLength(3);
    expect(card.querySelector('img,script')).toBeNull(); expect(card.textContent).toContain('<script>x</script>');
  });

  it.each([true, false])('opening Sources does not scroll the outer conversation; following=%s', async (following) => {
    const { app } = await mount('Long answer\n'.repeat(100));
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    if (!following) {
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 });
      document.dispatchEvent(new Event('scroll')); expect(app.isScrolledToBottom?.()).toBe(false);
    }
    const disclosure = document.querySelector<HTMLDetailsElement>('.answer-sources')!;
    disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); await flush();
    expect(scroll).not.toHaveBeenCalled();
    if (!following) expect(app.isScrolledToBottom?.()).toBe(false);
  });

  it('restores expanded disclosure and internal scroll across new-turn rerenders', async () => {
    const { send } = await mount('Answer [S1]');
    const disclosure = document.querySelector<HTMLDetailsElement>('.answer-sources')!;
    const list = disclosure.querySelector<HTMLElement>('.source-list')!;
    disclosure.open = true; list.scrollTop = 81; disclosure.dispatchEvent(new Event('toggle'));
    await send();
    const restored = document.querySelector<HTMLDetailsElement>('.answer-sources')!;
    expect(restored.open).toBe(true); expect(restored.querySelector<HTMLElement>('.source-list')!.scrollTop).toBe(81);
  });

  it('preserves the original source panel through a later failed turn, retry and cancellation', async () => {
    const { send } = await mount('Answer [S1]', true);
    const panel = document.querySelector<HTMLDetailsElement>('.answer-sources')!;
    panel.open = true; panel.querySelector<HTMLElement>('.source-list')!.scrollTop = 54;
    await send();
    document.querySelector<HTMLButtonElement>('[data-action="retry-request"]')!.click(); await flush();
    document.querySelector<HTMLButtonElement>('[data-action="cancel-request"]')!.click(); await flush();
    const restored = document.querySelector<HTMLDetailsElement>('.answer-sources')!;
    expect(restored.open).toBe(true); expect(restored.querySelector<HTMLElement>('.source-list')!.scrollTop).toBe(54);
    expect(document.getElementById('message-list')!.textContent).toContain('Request cancelled');
  });
});
