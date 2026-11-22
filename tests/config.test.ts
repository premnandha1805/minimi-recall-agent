import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, loadEnvIfPresent, isChatConfigured } from '../src/config.js';
import { azureEnv } from './fixtures/chat-stream.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });

describe('project environment discovery', () => {
  it('loads the project .env when launched from another working directory', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.spyOn(process, 'cwd').mockReturnValue(resolve(import.meta.dirname, '..', 'public'));
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    loadEnvIfPresent();
    expect(load).toHaveBeenCalledExactlyOnceWith(resolve(import.meta.dirname, '..', '.env'));
  });
  it('allows a clean clone without .env and retains explicit path support', () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.mocked(existsSync).mockReturnValue(false);
    loadEnvIfPresent(); expect(load).not.toHaveBeenCalled();
    vi.mocked(existsSync).mockReturnValue(true);
    loadEnvIfPresent('custom.env'); expect(load).toHaveBeenCalledWith(resolve('custom.env'));
  });
  it('reports configured chat only for the implemented adapter with both provider configurations', () => {
    expect(isChatConfigured(loadConfig({}))).toBe(false);
    expect(isChatConfigured(loadConfig(azureEnv))).toBe(true);
    expect(isChatConfigured(loadConfig({ ...azureEnv, TAVILY_API_KEY: '' }))).toBe(false);
  });
});

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

