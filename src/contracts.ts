import { z } from 'zod';

export const APP_NAME = 'minimi-recall-agent';
export const APP_VERSION = '1.0.0';

export const MAX_CONVERSATION_ID_CHARS = 128;
export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_HISTORY_ITEMS = 100;
export const MAX_HISTORY_CONTENT_CHARS = 32_000;

export const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates that a string is a recognized IANA time zone identifier.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const ChatHistoryMessageSchema = z.strictObject({
  id: z.string().trim().min(1).max(MAX_CONVERSATION_ID_CHARS).optional(),
  role: z.enum(['user', 'assistant']),
  content: z
    .string()
    .refine((content) => content.trim().length > 0, 'history content must not be empty')
    .max(
      MAX_HISTORY_CONTENT_CHARS,
      `history content must be at most ${MAX_HISTORY_CONTENT_CHARS} characters`
    ),
  timestamp: z.iso.datetime({
    offset: true,
    message: 'history timestamp must be an ISO 8601 datetime with timezone offset or Z',
  }),
});

export const ChatRequestSchema = z.strictObject({
  conversationId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CONVERSATION_ID_CHARS)
    .regex(
      CONVERSATION_ID_PATTERN,
      'conversationId may only contain letters, numbers, underscores, and hyphens'
    )
    .optional(),
  message: z
    .string()
    .trim()
    .min(1, 'message is required and cannot be empty')
    .max(MAX_MESSAGE_CHARS, `message must be at most ${MAX_MESSAGE_CHARS} characters`),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'timezone must be a valid IANA timezone identifier')
    .optional(),
  history: z
    .array(ChatHistoryMessageSchema)
    .max(MAX_HISTORY_ITEMS, `history may contain at most ${MAX_HISTORY_ITEMS} messages`)
    .optional(),
});

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
}

export interface ValidationErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ValidationErrorDetail[];
  };
  requestId: string;
  conversationId?: string;
}

