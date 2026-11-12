import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies documented defaults when environment variables are omitted', () => {
    const config = loadConfig({});

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MAX_BODY_BYTES).toBe(262_144);
    expect(config.REQUEST_DEADLINE_MS).toBe(25_000);
    expect(config.DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
    expect(config.MODEL_PROVIDER).toBe('gemini');
    expect(config.MODEL_NAME).toBe('gemini-2.5-flash');
    expect(config.GEMINI_API_KEY).toBeUndefined();
    expect(config.TAVILY_API_KEY).toBeUndefined();
  });

  it('accepts valid custom configuration and treats blank optional keys as undefined', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'warn',
      MAX_BODY_BYTES: '65536',
      REQUEST_DEADLINE_MS: '20000',
      DEFAULT_TIMEZONE: 'America/New_York',
      MODEL_PROVIDER: 'groq',
      MODEL_NAME: 'llama-3.3-70b-versatile',
      GEMINI_API_KEY: '   ',
      TAVILY_API_KEY: 'tvly-test-placeholder',
    });

    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.LOG_LEVEL).toBe('warn');
    expect(config.MAX_BODY_BYTES).toBe(65_536);
    expect(config.REQUEST_DEADLINE_MS).toBe(20_000);
    expect(config.DEFAULT_TIMEZONE).toBe('America/New_York');
    expect(config.MODEL_PROVIDER).toBe('groq');
    expect(config.GEMINI_API_KEY).toBeUndefined();
    expect(config.TAVILY_API_KEY).toBe('tvly-test-placeholder');
  });

  it('rejects invalid port and timezone without exposing secret values', () => {
    const secretSentinel = 'super-secret-value-do-not-leak';

    expect(() =>
      loadConfig({
        PORT: '99999',
        GEMINI_API_KEY: secretSentinel,
      })
    ).toThrowError(/PORT/);

    try {
      loadConfig({
        DEFAULT_TIMEZONE: 'Mars/Olympus_Mons',
        GEMINI_API_KEY: secretSentinel,
      });
      expect.unreachable('Expected loadConfig to throw on invalid timezone');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('DEFAULT_TIMEZONE');
      expect(message).not.toContain(secretSentinel);
    }
  });
});

