import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MAX_MESSAGE_CHARS } from '../src/contracts.js';
import { buildServer } from '../src/server.js';

describe('HTTP server and Chat API foundation', () => {
  const servers: FastifyInstance[] = [];

  function createTestServer(overrides: Record<string, string> = {}): FastifyInstance {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
    const app = buildServer({ config, logger: false });
    servers.push(app);
    return app;
  }

  afterEach(async () => {
    while (servers.length > 0) {
      const app = servers.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it('GET /health returns 200 with service status and x-request-id header', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('minimi-recall-agent');
    expect(body.version).toBe('1.0.0');
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('POST /api/chat accepts valid minimal payload and returns explicit 503 without configuration', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        message: 'On Monday we shortlisted five CRMs. Has anything changed?',
      },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe('CHAT_NOT_CONFIGURED');
    expect(body.error.message).toMatch(/configuration/i);
    expect(typeof body.requestId).toBe('string');
    expect(body.conversationId).toBeUndefined();
  });

  it('POST /api/chat accepts valid full payload with conversationId, timezone, and history', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: {
        'x-request-id': 'req-custom-123',
      },
      payload: {
        conversationId: 'crm-shortlist_2026',
        message: 'Has anything changed?',
        timezone: 'Asia/Kolkata',
        history: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Let us shortlist HubSpot, Pipedrive, Zoho, Freshsales, and Close.',
            timestamp: '2026-11-09T09:30:00Z',
          },
          {
            role: 'assistant',
            content: 'Got it. Noted those five CRMs.',
            timestamp: '2026-11-09T09:30:05+05:30',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['x-request-id']).not.toBe('req-custom-123');
    const body = response.json();
    expect(body.error.code).toBe('CHAT_NOT_CONFIGURED');
    expect(body.requestId).toBe(response.headers['x-request-id']);
    expect(body.conversationId).toBe('crm-shortlist_2026');
  });

  it('POST /api/chat rejects malformed JSON with 400 MALFORMED_JSON', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{"message": "hello"',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('MALFORMED_JSON');
    expect(typeof body.requestId).toBe('string');
  });

  it('POST /api/chat rejects empty JSON body with 400 MALFORMED_JSON', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: {
        'content-type': 'application/json',
      },
      payload: '',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('MALFORMED_JSON');
  });

  it('POST /api/chat rejects non-JSON Content-Type with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: {
        'content-type': 'text/plain',
      },
      payload: 'message=hello',
    });

    expect(response.statusCode).toBe(415);
    const body = response.json();
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('POST /api/chat rejects missing, empty, wrong-type, and unknown fields with 400 VALIDATION_ERROR', async () => {
    const app = createTestServer();

    const invalidPayloads = [
      {},
      { message: '   ' },
      { message: 123 },
      { message: 'ok', unexpectedField: true },
      { message: 'ok', conversationId: '../secret' },
      { message: 'ok', timezone: 'Mars/Phobos' },
      {
        message: 'ok',
        history: [{ role: 'user', content: 'hi', timestamp: '2026-11-09 10:00:00' }],
      },
      { message: 'a'.repeat(MAX_MESSAGE_CHARS + 1) },
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details.length).toBeGreaterThan(0);
    }
  });

  it('POST /api/chat enforces MAX_BODY_BYTES with 413 PAYLOAD_TOO_LARGE', async () => {
    const app = createTestServer({ MAX_BODY_BYTES: '1024' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        message: 'x'.repeat(2048),
      },
    });

    expect(response.statusCode).toBe(413);
    const body = response.json();
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 404 NOT_FOUND for unknown routes', async () => {
    const app = createTestServer();

    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.requestId).toBe('string');
  });

  it('handles unexpected internal errors safely without leaking stack traces or secrets', async () => {
    const secretToken = 'secret-should-not-appear';
    const app = createTestServer({ GEMINI_API_KEY: secretToken });

    app.get('/boom', async () => {
      throw new Error('Unexpected failure');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/boom',
    });

    expect(response.statusCode).toBe(500);
    const raw = response.body;
    expect(raw).not.toContain(secretToken);
    expect(raw).not.toContain('Unexpected failure');

    const body = response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(typeof body.requestId).toBe('string');
  });

  it('serves the static chat UI and assets from public/ with strict MIME types', async () => {
    const app = createTestServer();

    const routes: Array<{ url: string; contentType: string; contains?: string }> = [
      { url: '/', contentType: 'text/html', contains: 'Recall Agent' },
      { url: '/styles.css', contentType: 'text/css', contains: '--bg-surface' },
      { url: '/api.js', contentType: 'application/javascript', contains: 'sendChatRequest' },
      { url: '/app.js', contentType: 'application/javascript', contains: 'createChatApp' },
      { url: '/manifest.webmanifest', contentType: 'application/manifest+json', contains: 'Recall Agent' },
      { url: '/icons/favicon.png', contentType: 'image/png' },
      { url: '/icons/apple-touch-icon.png', contentType: 'image/png' },
    ];

    for (const route of routes) {
      const response = await app.inject({ method: 'GET', url: route.url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(route.contentType);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      if (route.contains) {
        expect(response.body).toContain(route.contains);
      } else {
        expect(response.rawPayload.byteLength).toBeGreaterThan(0);
      }
    }
  });
});

