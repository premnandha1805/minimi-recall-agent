import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isValidTimeZone } from './contracts.js';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional()
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(5_242_880).default(262_144),
  REQUEST_DEADLINE_MS: z.coerce.number().int().min(1000).max(25_000).default(25_000),
  MEMORY_DIRECTORY: z.string().trim().min(1).default(resolve(import.meta.dirname, '..', '.data', 'conversations'))
    .transform((path) => resolve(import.meta.dirname, '..', path)),
  DEBUG_MEMORY: z.enum(['0', '1']).default('0'),
  DEFAULT_TIMEZONE: z
    .string()
    .trim()
    .min(1)
    .default('Asia/Kolkata')
    .refine(isValidTimeZone, 'Invalid IANA timezone'),
  MODEL_PROVIDER: z
    .enum(['gemini', 'groq', 'openrouter', 'openai', 'anthropic', 'azure-openai-v1'])
    .default('gemini'),
  MODEL_NAME: z.string().trim().min(1).default('gemini-2.5-flash'),
  GEMINI_API_KEY: optionalNonEmptyString,
  GROQ_API_KEY: optionalNonEmptyString,
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENAI_API_KEY: optionalNonEmptyString,
  ANTHROPIC_API_KEY: optionalNonEmptyString,
  AZURE_OPENAI_API_KEY: optionalNonEmptyString,
  AZURE_OPENAI_DEPLOYMENT: optionalNonEmptyString,
  AZURE_OPENAI_CHAT_ENDPOINT: optionalNonEmptyString.refine((value) => {
    if (value === undefined) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname === '/openai/v1/chat/completions';
    } catch { return false; }
  }, 'Expected an HTTPS Azure OpenAI v1 chat completions URL without credentials or query parameters'),
  AZURE_OPENAI_CONTEXT_TOKENS: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.coerce.number().int().min(4096).max(1_000_000).optional()
  ),
  TAVILY_API_KEY: optionalNonEmptyString,
}).superRefine((config, context) => {
  if (config.MODEL_PROVIDER !== 'azure-openai-v1') return;
  for (const field of ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_CHAT_ENDPOINT', 'AZURE_OPENAI_CONTEXT_TOKENS'] as const) {
    if (!config[field]) context.addIssue({ code: 'custom', path: [field], message: 'Required for azure-openai-v1' });
  }
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** Configuration presence only; does not contact providers or claim valid credentials. */
export function isChatConfigured(config: AppConfig): boolean {
  return config.MODEL_PROVIDER === 'azure-openai-v1' && Boolean(config.AZURE_OPENAI_API_KEY &&
    config.AZURE_OPENAI_DEPLOYMENT && config.AZURE_OPENAI_CHAT_ENDPOINT &&
    config.AZURE_OPENAI_CONTEXT_TOKENS && config.TAVILY_API_KEY);
}

/**
 * Loads the project's .env regardless of launching cwd. Existing process variables win.
 * Explicit paths remain supported; absent files are allowed on a clean clone.
 */
export function loadEnvIfPresent(envPath = resolve(import.meta.dirname, '..', '.env')): void {
  const absolutePath = resolve(envPath);
  if (existsSync(absolutePath)) {
    process.loadEnvFile(absolutePath);
  }
}

/**
 * Validates environment variables via Zod and returns normalized configuration.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

