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
  DEFAULT_TIMEZONE: z
    .string()
    .trim()
    .min(1)
    .default('Asia/Kolkata')
    .refine(isValidTimeZone, 'Invalid IANA timezone'),
  MODEL_PROVIDER: z
    .enum(['gemini', 'groq', 'openrouter', 'openai', 'anthropic'])
    .default('gemini'),
  MODEL_NAME: z.string().trim().min(1).default('gemini-2.5-flash'),
  GEMINI_API_KEY: optionalNonEmptyString,
  GROQ_API_KEY: optionalNonEmptyString,
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENAI_API_KEY: optionalNonEmptyString,
  ANTHROPIC_API_KEY: optionalNonEmptyString,
  TAVILY_API_KEY: optionalNonEmptyString,
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Loads a local .env file into process.env when present without failing on a clean clone.
 */
export function loadEnvIfPresent(envPath = '.env'): void {
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

