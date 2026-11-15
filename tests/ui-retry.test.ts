// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChatApp, type ChatAppInstance } from '../public/app.js';
import { result, streamText, meta } from './fixtures/chat-stream.js';

type Body = { message: string; conversationId: string; history?: Array<{ role: string; content: string }> };
const html = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const flush = () => new Promise<void>((yes) => setTimeout(yes, 0));
const failure = () => new Response('{"error":{"code":"OFFLINE_FAILURE","message":"Fixture failure"}}',
  { status: 500, headers: { 'content-type': 'application/json' } });
function success(body: Body, coverage: 'complete' | 'partial' = 'complete') {
  return new Response(streamText({ ...result, message: { ...result.message,
    id: `answer_${body.message}`, content: `Answer ${body.message}` }, coverage,
    issues: coverage === 'partial' ? ['search_failed'] : [],
  }).replace(meta.conversationId, body.conversationId), { headers: { 'content-type': 'text/event-stream' } });
}
const apps: ChatAppInstance[] = [];
beforeEach(() => { document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1]; });
afterEach(() => { for (const app of apps.splice(0)) app.destroy(); document.body.innerHTML = ''; });
async function mount(respond: (body: Body, attempt: number) => Response | Promise<Response>,
  limits: { maxHistoryItems?: number; maxBodyBytes?: number } = {}) {
  const bodies: Body[] = [];
  const app = createChatApp({ persistence: false, root: document, ...limits, fetchImpl: async (url, init) => {
    if (url === '/health') return new Response('{"status":"ok"}');
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body); return respond(body, bodies.length);
  } });
  apps.push(app); await app.waitForInitialHealth();
  const send = async (message: string) => {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = message; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  };
  const retry = async (index = 0) => {
    const button = document.querySelectorAll<HTMLButtonElement>('[data-action="retry-request"]')[index];
    expect(button).toBeTruthy(); button.click(); await flush(); return button;
  };
  const history = () => app.getActiveSession().history.map((item) => item.content);
  return { app, bodies, send, retry, history };
}

describe('conversation turn order and retries (offline SSE)', () => {
  it('starts with empty history and preserves normal sequential turns', async () => {
    const h = await mount((body) => success(body));
    await h.send('A'); await h.send('B');
    expect(h.bodies[0].history).toBeUndefined();
    expect(h.bodies[1].history?.map((item) => item.content)).toEqual(['A', 'Answer A']);
    expect(h.history()).toEqual(['A', 'Answer A', 'B', 'Answer B']);
    expect(new Set(h.bodies.map((body) => body.conversationId)).size).toBe(1);
  });

  it('retries a failed message once without duplicating the user or accepting stale retry buttons', async () => {
    const h = await mount((body, attempt) => attempt === 1 ? failure() : success(body));
    await h.send('A'); const button = await h.retry();
    expect(h.history()).toEqual(['A', 'Answer A']);
    expect(h.bodies[1].history).toBeUndefined();
    button.click(); await flush();
    expect(h.bodies).toHaveLength(2); expect(document.querySelectorAll('.turn-user')).toHaveLength(1);
  });

  it('inserts an older retried answer beside its question in both visible and submitted history', async () => {
    const h = await mount((body, attempt) => attempt === 1 ? failure() : success(body));
    await h.send('A'); await h.send('B'); await h.retry();
    expect(h.bodies[2].message).toBe('A'); expect(h.bodies[2].history).toBeUndefined();
    expect(h.history()).toEqual(['A', 'Answer A', 'B', 'Answer B']);
    const visible = [...document.querySelectorAll('#message-list > article')].map((node) => node.textContent);
    expect(visible[0]).toContain('A'); expect(visible[1]).toContain('Answer A');
    expect(visible[2]).toContain('B'); expect(visible[3]).toContain('Answer B');
    await h.send('C');
    expect(h.bodies[3].history?.map((item) => item.content)).toEqual(['A', 'Answer A', 'B', 'Answer B']);
    expect(document.querySelectorAll('.turn-user')).toHaveLength(3);
    expect(document.querySelectorAll('.assistant-answer-card')).toHaveLength(3);
  });

  it('refreshes only preceding context when retrying multiple failed turns out of order', async () => {
    const h = await mount((body, attempt) => attempt <= 3 ? failure() : success(body));
    await h.send('A'); await h.send('B'); await h.send('C');
    await h.retry(1); // B succeeds before A.
    expect(h.bodies[3].history?.map((item) => item.content)).toEqual(['A']);
    await h.retry(0); // A is inserted before B.
    await h.retry(0); // C sees the newly completed A and B, not its old snapshot.
    expect(h.bodies[5].history?.map((item) => item.content)).toEqual(['A', 'Answer A', 'B', 'Answer B']);
    expect(h.history()).toEqual(['A', 'Answer A', 'B', 'Answer B', 'C', 'Answer C']);
  });

  it('excludes partial, failed and incomplete answers from later request history', async () => {
    const h = await mount((body, attempt) => attempt === 1 ? failure() :
      attempt === 2 ? success(body, 'partial') : success(body));
    await h.send('A'); await h.retry(); await h.send('B');
    expect(h.bodies[2].history?.map((item) => item.content)).toEqual(['A']);
    expect(h.history()).toEqual(['A', 'B', 'Answer B']);
  });

  it('keeps cancellation retryable and ignores a late response after a newer retry succeeds', async () => {
    let resolveLate!: (response: Response) => void;
    const h = await mount((body, attempt) => attempt === 1 ? failure() : attempt === 2 ?
      new Promise<Response>((yes) => { resolveLate = yes; }) : success(body));
    await h.send('A'); const staleButton = await h.retry();
    expect(h.history()).toEqual(['A']);
    document.querySelector<HTMLButtonElement>('[data-action="cancel-request"]')!.click(); await flush();
    expect(document.getElementById('message-list')!.textContent).toContain('Request cancelled');
    expect(h.history()).toEqual(['A']);
    await h.retry(); await h.send('B');
    const before = document.getElementById('message-list')!.textContent;
    resolveLate(success(h.bodies[1])); staleButton.click(); await flush();
    expect(h.bodies).toHaveLength(4);
    expect(h.history()).toEqual(['A', 'Answer A', 'B', 'Answer B']);
    expect(document.getElementById('message-list')!.textContent).toBe(before);
  });

  it('preserves ordered suffixes and full local history at the existing 100-message limit', async () => {
    const h = await mount((body, attempt) => attempt === 1 ? failure() : success(body));
    await h.send('Q0');
    for (let i = 1; i <= 51; i++) await h.send(`Q${i}`);
    await h.retry(); await h.send('Q52');
    expect(h.history().slice(0, 4)).toEqual(['Q0', 'Answer Q0', 'Q1', 'Answer Q1']);
    expect(h.bodies.at(-1)!.history?.map((item) => item.content)).toEqual(
      Array.from({ length: 50 }, (_, i) => [`Q${i + 2}`, `Answer Q${i + 2}`]).flat());
    expect(h.app.getActiveSession().omittedHistoryCount).toBe(4);
    expect(document.querySelectorAll('.turn-user')).toHaveLength(53);
  }, 20_000);

  it('retains the existing byte limit for large Unicode histories after an old retry', async () => {
    const h = await mount((body, attempt) => attempt === 1 ? failure() : success(body), { maxBodyBytes: 2000 });
    await h.send('A');
    for (let i = 0; i < 5; i++) await h.send(`Q${i}_${'न'.repeat(100)}`);
    await h.retry(); await h.send('End');
    const body = h.bodies.at(-1)!;
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(2000);
    expect(body.history!.map((item) => item.content)).toEqual(
      h.history().slice(0, -2).slice(-body.history!.length));
    expect(h.app.getActiveSession().omittedHistoryCount).toBeGreaterThan(0);
  });
});
