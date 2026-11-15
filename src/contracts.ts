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
  turn: z.strictObject({ key: z.string().min(1).max(128).regex(CONVERSATION_ID_PATTERN),
    attemptKey: z.string().min(1).max(128).regex(CONVERSATION_ID_PATTERN) }).optional(),
});

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Ordinary or bracket-escaped source markers. Keep browser validation in parity.
 * Code spans are still checked: literal formatting never authorizes unknown IDs. */
export function citationIds(text: string): string[] {
  return [...text.matchAll(/\\?\[(S\d+)\\?\]/g)].map((match) => match[1]);
}

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

export const CHAT_STREAM_VERSION = 'recall.chat.v1';
export const MAX_SSE_FRAME_BYTES = 1_048_576;
export const MAX_SSE_STREAM_BYTES = 2_097_152;
const SafeIdSchema = z.string().min(1).max(128).regex(CONVERSATION_ID_PATTERN);
const EvidenceDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const ResearchIssueSchema = z.enum(['search_budget_exhausted', 'search_cutoff',
  'search_unavailable', 'search_timeout', 'search_failed', 'search_invalid_results']);
export const StreamErrorCodeSchema = z.enum(['REQUEST_TIMEOUT', 'MODEL_TIMEOUT', 'MODEL_FAILED',
  'INVALID_MODEL_OUTPUT', 'INVALID_CITATION', 'CONTEXT_LIMIT', 'AGENT_LIMIT', 'CANCELLED', 'INTERNAL_ERROR']);
export type StreamErrorCode = z.infer<typeof StreamErrorCodeSchema>;
export const SourceMetadataSchema = z.strictObject({
  id: z.string().max(128).regex(/^S[1-9]\d*$/),
  query: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  url: z.string().max(2048).url().refine((value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  }),
  retrieved_at: z.iso.datetime({ offset: true }),
  published_at: EvidenceDateSchema.optional(),
  effective_at: EvidenceDateSchema.optional(),
});
export const ChatResultSchema = z.strictObject({
  message: z.strictObject({ id: SafeIdSchema, role: z.literal('assistant'),
    content: z.string().max(MAX_MESSAGE_CHARS).refine((s) => s.trim().length > 0),
    timestamp: z.iso.datetime() }),
  coverage: z.enum(['complete', 'partial']),
  issues: z.array(ResearchIssueSchema).max(6),
  sources: z.array(SourceMetadataSchema).max(24),
  evidenceCheck: z.literal('citation_ids_only'),
}).superRefine((value, ctx) => {
  const ids = new Set(value.sources.map((s) => s.id));
  if (ids.size !== value.sources.length || new Set(value.issues).size !== value.issues.length ||
      (value.coverage === 'complete') !== (value.issues.length === 0) ||
      citationIds(value.message.content).some((id) => !ids.has(id))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid evidence registry or coverage' });
  }
});
export const ChatEventSchemas = {
  meta: z.strictObject({ version: z.literal(CHAT_STREAM_VERSION), requestId: z.uuid(),
    conversationId: SafeIdSchema, answerMode: z.literal('final') }),
  progress: z.discriminatedUnion('phase', [
    z.strictObject({ phase: z.literal('accepted') }),
    z.strictObject({ phase: z.literal('model_started'), call: z.number().int().min(1).max(3) }),
    z.strictObject({ phase: z.literal('search_started'), attempt: z.number().int().min(1).max(8) }),
  ]),
  result: ChatResultSchema,
  error: z.strictObject({ code: StreamErrorCodeSchema, message: z.string().min(1).max(256) }),
  done: z.union([
    z.strictObject({ outcome: z.enum(['completed', 'partial']), messageId: SafeIdSchema }),
    z.strictObject({ outcome: z.enum(['failed', 'cancelled']) }),
  ]),
};
export type ChatEventPayloads = { [K in keyof typeof ChatEventSchemas]: z.infer<(typeof ChatEventSchemas)[K]> };
export type ChatResult = ChatEventPayloads['result'];

