import { isChangeRequest, isRecallAndVerifyRequest, formatRecallAndVerifyAnswer, COMPARISON_INSTRUCTIONS, verifyChangeAnswer, checkSourceQuotations } from './verification.js';
import { memoryData, prepareAgentContext, isMemoryUpdate, type RetrievedMemory } from './context.js';
import { z } from 'zod';
import { createTemporalResolver } from './dates.js';
import { ChatRequestSchema, citationIds, MAX_MESSAGE_CHARS, type ChatRequest } from './contracts.js';
import { createDeadlineScope, createFirstTokenScope, ExecutionTimeoutError, runWithSignal } from './execution.js';
import { contextFits, ModelResponseSchema, type ModelMessage, type ModelProvider, type ModelResponse } from './model.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import { abortOutcome, observeStage, sourceCounts, tokenUsage, type StageObserver, type StageOutcome, type ValidationCategory } from './observability.js';
import { SEARCH_LIMITS, SearchArgumentsSchema, SearchSession, WEB_SEARCH_TOOL, type Source, type WebSearch } from './search.js';
import { evaluateGroundedRecall, groundedRecallAnswer, groundHistoricalProse } from './recall-answer.js';
import { createResearchPolicy } from './research-policy.js';
import { modelFailureDiagnostic, type ModelFailureDiagnostic } from './model.js';

/** Select one exact contiguous excerpt; never join separated claims into a quotation. */
function excerpt(text: string, query: string, size: number, preserveLineStart = false): string {
  if (text.length <= size) return text;
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  let best = 0; let score = -1;
  const starts = preserveLineStart ? [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)] :
    Array.from({ length: Math.ceil(text.length / Math.max(1, Math.floor(size / 2))) }, (_, i) => i * Math.max(1, Math.floor(size / 2)));
  for (const start of starts) {
    // Comparison extraction must not turn "Not: The Neon ..." into an assertion
    // by dropping the start of its line. Ending fragments fail the full-record parser.
    const window = text.slice(start, start + size).toLowerCase();
    const overlap = terms.filter((term) => window.includes(term)).length;
    if (overlap > score) { best = start; score = overlap; }
  }
  return text.slice(best, best + size);
}

type MemoryRecord = RetrievedMemory['records'][number];
interface MemoryDate { day?: number; month?: number; year?: number }
const calendarMonths = 'January February March April May June July August September October November December'.split(' ');
const monthNames = calendarMonths.join('|');
const eventWords = /\b(?:meetings?|appointments?|interviews?|calls?|events?|flights?|conferences?|schedule|calendar|plans?)\b/i;
// Dates only: a price, identifier or quantity is never evidence for a calendar year.
function mentionedDates(text: string): MemoryDate[] {
  const pattern = new RegExp(`\\b(?:(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:,?\\s+(\\d{4}))?|(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?|(?:in|during|year)\\s+((?:19|20)\\d{2}))\\b`, 'gi');
  return [...text.matchAll(pattern)].map((m) => {
    if (m[1]) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    if (m[10]) return { year: Number(m[10]) };
    return { day: Number(m[4] ?? m[8]), month: calendarMonths.findIndex((v) => v.toLowerCase() === (m[5] ?? m[7]).toLowerCase()) + 1,
      ...((m[6] ?? m[9]) ? { year: Number(m[6] ?? m[9]) } : {}) };
  });
}
const framingWords = new Set(('i we my our you your have has had with the and for a an on in at to is are was were ' +
  'also recorded previously said mentioned scheduled upcoming meeting meetings appointment interview call event flight conference schedule calendar ' +
  'only original statement stored user gives without ' +
  'date day year time').split(' '));
function identityWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}]+/gu) ?? [])].filter((t) => t.length > 2 &&
    !framingWords.has(t) && !calendarMonths.some((m) => m.toLowerCase() === t));
}
// Split independent claims, preserving the comma within "August 23, 2027".
function evidenceClauses(text: string): string[] {
  return text.split(/[.!?;]\s+|\n+|\s+(?:and|but)\s+|,\s*(?!\d{4}\b)/i);
}
function sameDate(a: MemoryDate, b: MemoryDate): boolean {
  return a.day === b.day && a.month === b.month && a.year === b.year;
}
function buildDeterministicMemoryAnswer(memory: RetrievedMemory, records: MemoryRecord[], updates: boolean): string {
  // Project historical markers exactly as in model context; never mint current citations.
  const projected = memoryData(memory, records).records;
  const lines = projected.map((r, i) => {
    const dates = mentionedDates(r.user.content);
    const yearless = dates.some((d) => d.year === undefined) || (eventWords.test(r.user.content) && !dates.length);
    const note = yearless ? (records.length === 1 ? ' (the year was not specified; cannot verify if upcoming)' :
      ' (year not specified; cannot verify if upcoming)') : '';
    const label = isMemoryUpdate(r.user.content) ? 'Recorded update' : 'Original statement';
    const origin = `${r.provenance === 'client_seed' ? 'client_seed, unverified' : 'server_recorded'}; conversation ${r.conversationId}; turn ${r.turnId}`;
    return `${i + 1}. ${label}: \u201c${r.user.content}\u201d${note} [${origin}]`;
  });
  const header = memory.status === 'ambiguous' ? 'Historical matches are ambiguous; a single current event cannot be established.' :
    updates ? 'Stored statements and updates in recorded order; earlier dates are historical, not a confirmed current schedule.' :
      'You previously recorded the following original statements:';
  return `${header}\n${lines.join('\n')}`;
}

/** Conservative check of calendar claims, not a general factual verifier.
 * Unclear associations return labeled originals instead of rewriting model prose. */
export function validateAndGroundMemoryAnswer(modelAnswer: string, memory: RetrievedMemory, _query?: string): string {
  const records = memory.records.filter((r) => r.user.role !== 'assistant');
  if (!records.length) return modelAnswer;
  const updates = records.some((r) => isMemoryUpdate(r.user.content));
  const fallback = () => buildDeterministicMemoryAnswer(memory, records, updates);
  // A lexical matcher cannot safely certify which earlier event an update changes.
  // Present the chronology explicitly rather than accept a stale or arbitrarily chosen date.
  if (updates) return fallback();
  const temporal = records.some((r) => eventWords.test(r.user.content) || mentionedDates(r.user.content).length) ||
    eventWords.test(modelAnswer) || mentionedDates(modelAnswer).length > 0;
  if (!temporal) return modelAnswer;
  if (memory.status === 'ambiguous') return fallback();

  const evidence = records.flatMap((r) => evidenceClauses(r.user.content).map((text) => ({
    text, dates: mentionedDates(text), identity: identityWords(text),
  }))).filter((e) => e.dates.length);
  const claims = evidenceClauses(modelAnswer);
  for (const text of claims) {
    const dates = mentionedDates(text);
    const identity = identityWords(text);
    for (const date of dates) {
      const candidates = evidence.filter((e) => e.dates.length === 1 && sameDate(e.dates[0], date));
      // Identity overlap must accompany a matching complete date; a global year
      // match or a second date elsewhere in the same message cannot authorize it.
      const supported = candidates.some((e) => identity.some((t) => e.identity.includes(t))) ||
        (evidence.length === 1 && candidates.length === 1 && !identity.length);
      if (!supported) return fallback();
    }
    // A bare year on an event claim is also uncertain, even if it occurs in a budget.
    if (eventWords.test(text) && /\b(?:19|20)\d{2}\b/.test(text) && !dates.some((d) => d.year !== undefined)) return fallback();

    const affirmative = text.replace(/\b(?:cannot|can't)\s+(?:verify|confirm|establish|determine)(?:\s+(?:if|whether)(?:\s+it is)?)?\s+upcoming\b/gi, '')
      .replace(/\b(?:is|are)\s+not\s+upcoming\b/gi, '');
    if (/\bupcoming\b/i.test(affirmative)) {
      const candidates = evidence.filter((e) => e.dates.length === 1 && e.dates[0].year !== undefined &&
        e.dates[0].month !== undefined && e.dates[0].day !== undefined &&
        (identity.some((t) => e.identity.includes(t)) || evidence.length === 1));
      if (candidates.length !== 1) return fallback();
      const d = candidates[0].dates[0];
      const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      const resolved = createTemporalResolver({ referenceInstant: memory.reference.instant, timezone: memory.reference.timezone }).resolve(date, 'external_event');
      if (resolved.status !== 'resolved' || Date.parse(resolved.startUtc) <= Date.parse(memory.reference.instant)) return fallback();
    }
  }
  return modelAnswer;
}

export const enforceTemporalSafety = validateAndGroundMemoryAnswer;

/** In mixed answers, public dates must not become evidence for private events.
 * Check explicitly personal event sentences separately, preserving other research
 * sentences and their request-local citations. Unclear combined sentences fall
 * back as a whole rather than editing a date inside a quotation or claim. */
function groundMixedMemoryAnswer(answer: string, memory: RetrievedMemory): string {
  let replacementShown = false;
  const grounded = answer.split(/(?<=[.!?])\s+|\n+/).flatMap((sentence) => {
    if (!eventWords.test(sentence) || !/\b(?:you|your|yours|my|our)\b/i.test(sentence)) return [sentence];
    const checked = memory.status === 'not_found' ? 'I did not find a suitable personal event record in the stored conversations.' :
      memory.status === 'limited' || memory.status === 'unsupported_date' ? 'The stored personal event history is limited or ambiguous; no current schedule can be confirmed.' :
        validateAndGroundMemoryAnswer(sentence, memory);
    if (checked === sentence) return [sentence];
    if (replacementShown) return [];
    replacementShown = true;
    return [checked];
  }).join('\n\n');
  return replacementShown ? grounded : answer;
}

export const AGENT_LIMITS = Object.freeze({ deadlineMs: 25_000, modelTimeoutMs: 15_000,
  modelCalls: 3, maxOutputTokens: 2048, totalOutputTokens: 6144 });
const RunOptionsSchema = z.strictObject({
  deadlineMs: z.number().int().min(1).max(AGENT_LIMITS.deadlineMs).default(AGENT_LIMITS.deadlineMs),
  modelTimeoutMs: z.number().int().min(1).max(AGENT_LIMITS.modelTimeoutMs).default(10_000),
  outputTokenBudget: z.number().int().min(1).max(AGENT_LIMITS.totalOutputTokens).default(AGENT_LIMITS.totalOutputTokens),
});
export type AgentStopReason = 'answer' | 'empty_output' | 'invalid_request' | 'invalid_response' |
  'invalid_tool_call' | 'unsupported_tool' | 'repeated_tool_call' | 'round_limit' | 'context_limit' |
  'output_budget' | 'output_limit' | 'content_filter' | 'invalid_citation' | 'provider_error' |
  'model_timeout' | 'deadline' | 'cancelled';
/** Internal result only. This is NOT a new POST /api/chat or SSE response contract. */
export interface AgentResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  reason: AgentStopReason;
  answer?: string;
  generationOrigin?: 'model' | 'recovered';
  sources: Source[];
  issues: string[];
  stats: { modelCalls: number; searchRounds: number; searchRequests: number; reservedOutputTokens: number };
  usage: NonNullable<ModelResponse['usage']>[];
}
export interface AgentOptions {
  provider: ModelProvider;
  memory?: RetrievedMemory;
  signal: AbortSignal;
  search?: WebSearch;
  /** Monotonic request-arrival time, if already known by the caller. */
  startedAt?: number;
  deadlineMs?: number;
  modelTimeoutMs?: number;
  outputTokenBudget?: number;
  observe?: StageObserver;
  /** HTTP recovery: one answer call normally, one shorter retry only for transient failures. */
  recoverRecall?: boolean;
  onText?: (text: string) => void | Promise<void>;
  allowWeb?: boolean;
  prefetchedSearch?: SearchSession;
  prefetchedIssues?: string[];
}

export async function runAgent(input: ChatRequest, options: AgentOptions): Promise<AgentResult> {
  const agentStartedAt = performance.now();
  const result: AgentResult = { status: 'failed', reason: 'invalid_request', sources: [], issues: [],
    stats: { modelCalls: 0, searchRounds: 0, searchRequests: 0, reservedOutputTokens: 0 }, usage: [] };
  let validationCategory: ValidationCategory | undefined;
  const observeTotal = () => observeStage(options.observe, agentStartedAt, {
    stage: 'agent', outcome: result.reason === 'answer' ? 'success' :
      ['model_timeout', 'deadline'].includes(result.reason) ? 'timeout' : result.reason === 'cancelled' ? 'abort' : 'failure',
    agentStatus: result.status, modelCalls: result.stats.modelCalls, searchCalls: result.stats.searchRequests,
    stopReason: result.reason, ...(validationCategory ? { validationCategory } : {}),
    ...sourceCounts(result.sources),
  });
  const limits = RunOptionsSchema.safeParse({ deadlineMs: options.deadlineMs,
    modelTimeoutMs: options.modelTimeoutMs, outputTokenBudget: options.outputTokenBudget });
  const parsed = ChatRequestSchema.safeParse(input);
  const now = performance.now();
  const startedAt = options.startedAt ?? now;
  if (!limits.success || !parsed.success || !Number.isFinite(startedAt) || startedAt > now ||
      !Number.isInteger(options.provider.contextWindowTokens) || options.provider.contextWindowTokens < 4096 ||
      options.provider.contextWindowTokens > 1_000_000) { observeTotal(); return result; }
  const deadline = createDeadlineScope(options.signal, Math.max(0, limits.data.deadlineMs - (now - startedAt)));
  const search = options.prefetchedSearch ?? new SearchSession(options.search, deadline.signal, startedAt, options.observe, parsed.data.message);
  const issues = new Set<string>(options.prefetchedIssues);
  const seenCallIds = new Set<string>();
  const shownSources = new Set<string>();
  const shownBodies = new Map<string, string>();
  let contextLimitation: string | undefined;
  let messages: ModelMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    // Preserve the supplied original history. Reject oversized context rather than silently
    // dropping anchors; date/keyword-based history selection belongs to the memory feature.
    ...(parsed.data.history ?? []).map((message): ModelMessage => ({ role: message.role,
      content: JSON.stringify({ timestamp: message.timestamp, content: message.content }) })),
    { role: 'user', content: parsed.data.message },
  ];
  let toolsEnabled = !options.memory?.memoryOnly && options.allowWeb !== false;
  const researchPolicy = createResearchPolicy(parsed.data.message, options.memory);
  const changeRequest = !options.memory?.memoryOnly && isChangeRequest(parsed.data.message);
  const dualRecallVerify = changeRequest && isRecallAndVerifyRequest(parsed.data.message);
  // Suppress raw unvalidated tokens for pure recall, mixed recall, and change
  // comparisons so intermediate JSON or ungrounded historical claims never stream.
  const suppressRawStream = changeRequest || !!options.memory?.recall || !!options.memory?.memoryOnly;
  const boundAnswer = (text: string) => text.length > MAX_MESSAGE_CHARS ?
    'The complete answer exceeds the answer limit. Please narrow the date or topic; no original record or quotation has been truncated.' : text;
  const finish = (reason: AgentStopReason, answer?: string): AgentResult => {
    if (options.recoverRecall && options.memory?.memoryOnly && options.memory.records.length &&
        ['model_timeout', 'provider_error', 'empty_output', 'invalid_response', 'output_limit', 'context_limit'].includes(reason) &&
        !options.signal.aborted) {
      reason = 'answer';
      result.generationOrigin = 'recovered';
      answer = groundedRecallAnswer('{}', options.memory, parsed.data.message) +
        '\n\nThe model was unavailable; this answer quotes the saved evidence directly.';
    }
    if (reason === 'answer' && !result.generationOrigin && result.stats.modelCalls > 0) {
      result.generationOrigin = 'model';
    }
    result.reason = reason;
    result.status = reason === 'cancelled' ? 'cancelled' :
      reason === 'answer' ? (issues.size ? 'partial' : 'completed') : 'failed';
    // Deterministic originals and appended notices can exceed the model's text
    // limit. Enforce the public answer contract without truncating evidence.
    if (answer !== undefined) result.answer = boundAnswer(answer);
    return result;
  };
  const reject = (reason: AgentStopReason, category: ValidationCategory): AgentResult => {
    validationCategory = category;
    return finish(reason);
  };
  try {
    deadline.signal.throwIfAborted();
    if (options.memory) {
      const memory = options.memory;
      if (memory.memoryOnly && memory.status === 'not_found') return finish('answer', options.recoverRecall ?
        (memory.earlierConversationCount ? `I searched ${memory.earlierConversationCount} earlier conversations and could not find that. That does not mean you never mentioned it.` :
          'There is no saved history yet for this question. Your current message has been saved.') :
        'I did not find a suitable record in the stored conversations. No historical details have been inferred.');
      if (memory.memoryOnly && memory.status === 'unsupported_date') return finish('answer', 'The historical date reference is ambiguous or unsupported. Please specify an ISO date or a supported calendar expression and timezone.');
      if (memory.memoryOnly && memory.status === 'ambiguous' && !memory.records.length) return finish('answer', memory.limitation ?? 'Which topic or date do you mean?');
      if (memory.memoryOnly && memory.status === 'limited' && (!memory.groundedRecall || !memory.records.length)) return finish('answer', memory.limitation ?? 'Historical coverage is limited. Please narrow the date or topic.');
      const prepared = prepareAgentContext(memory, parsed.data.message, options.provider.contextWindowTokens,
        Math.min(AGENT_LIMITS.maxOutputTokens, limits.data.outputTokenBudget));
      if (!prepared.messages.length) return finish('answer', (isChangeRequest(parsed.data.message) ? 'Cannot verify: ' : '') + prepared.limitation);
      messages = prepared.messages;
      contextLimitation = prepared.limitation;
    }
    if (changeRequest) messages.splice(1, 0, { role: 'system', content: COMPARISON_INSTRUCTIONS });
    if (options.prefetchedSearch?.sources.length) {
      messages.push({ role: 'user', content: JSON.stringify({ untrustedWebSearchData: options.prefetchedSearch.sources }) });
      for (const source of options.prefetchedSearch.sources) { shownSources.add(source.id); shownBodies.set(source.text, source.id); }
    }
    for (let step = 0; step < AGENT_LIMITS.modelCalls; step++) {
      if (performance.now() - startedAt >= limits.data.deadlineMs) return finish('deadline');
      deadline.signal.throwIfAborted();
      const remaining = limits.data.outputTokenBudget - result.stats.reservedOutputTokens;
      if (remaining <= 0) return finish('output_budget');
      const maxOutputTokens = Math.min(AGENT_LIMITS.maxOutputTokens, remaining);
      const tools = toolsEnabled && step < SEARCH_LIMITS.rounds && search.rounds < SEARCH_LIMITS.rounds ? [WEB_SEARCH_TOOL] : [];
      if (!contextFits({ messages, tools, maxOutputTokens }, options.provider.contextWindowTokens)) return finish('context_limit');
      // Keep time for a shorter retry, deterministic grounding, atomic saves and SSE.
      const availableMs = limits.data.deadlineMs - (performance.now() - startedAt) - (options.recoverRecall ? 1200 : 0);
      const modelScope = options.recoverRecall && options.onText ? createFirstTokenScope(deadline.signal,
        Math.max(0, availableMs), limits.data.modelTimeoutMs) :
        { ...createDeadlineScope(deadline.signal, Math.max(0, Math.min(limits.data.modelTimeoutMs, availableMs))), markFirstToken: () => {} };
      let response: ModelResponse | undefined;
      let modelStartedAt: number | undefined;
      let modelOutcome: StageOutcome = 'failure';
      let modelFailure: ModelFailureDiagnostic | undefined;
      try {
        const raw = await runWithSignal(modelScope.signal, () => {
          modelStartedAt = performance.now();
          result.stats.modelCalls++;
          // Reserve the maximum even if usage is absent or a request fails. No hidden retries.
          result.stats.reservedOutputTokens += maxOutputTokens;
          return options.provider.complete({ messages: structuredClone(messages), tools: structuredClone(tools),
            maxOutputTokens, signal: modelScope.signal, onFirstToken: modelScope.markFirstToken,
            ...(options.onText ? { onText: async (text) => {
              modelScope.signal.throwIfAborted(); modelScope.markFirstToken();
              if (!suppressRawStream) await options.onText!(text);
            } } : {}) });
        });
        deadline.signal.throwIfAborted();
        const validated = ModelResponseSchema.safeParse(raw);
        if (!validated.success) return reject('invalid_response', 'response_schema');
        response = validated.data;
        // Success here means a valid provider response, not factual/citation verification.
        modelOutcome = 'success';
      } catch (error) {
        modelOutcome = abortOutcome(modelScope.signal);
        if (modelOutcome === 'failure') modelFailure = modelFailureDiagnostic(error);
        if (deadline.signal.aborted) deadline.signal.throwIfAborted();
        const transient = modelScope.signal.reason instanceof ExecutionTimeoutError ||
          modelFailure?.httpStatus !== undefined && modelFailure.httpStatus >= 500;
        if (options.recoverRecall && step === 0 && transient &&
            limits.data.deadlineMs - (performance.now() - startedAt) > 1800) {
          // No LLM classifier/validator: retry this same answer once with less history,
          // preserving comparison rules, historical baselines and any prefetched web evidence.
          const shortened = options.memory ? prepareAgentContext({ ...options.memory,
            records: options.memory.records.slice(-2).map((r) => ({ ...r,
              evidence: changeRequest ? r.evidence : [],
              assistant: changeRequest ? r.assistant : undefined,
              user: { ...r.user, content: changeRequest ? r.user.content : r.user.content.slice(0, 800) } })) }, parsed.data.message,
            options.provider.contextWindowTokens, maxOutputTokens).messages : [];
          const nextMessages = shortened.length ? shortened : [messages[0], { role: 'user' as const, content: parsed.data.message }];
          if (changeRequest && !nextMessages.some((m) => m.role === 'system' && m.content === COMPARISON_INSTRUCTIONS)) {
            nextMessages.splice(1, 0, { role: 'system', content: COMPARISON_INSTRUCTIONS });
          }
          const webDataMessages = messages.filter((m) => m.role === 'user' && m.content.startsWith('{"untrustedWebSearchData"'));
          nextMessages.push(...webDataMessages);
          if (contextFits({ messages: nextMessages, tools, maxOutputTokens }, options.provider.contextWindowTokens)) {
            messages = nextMessages;
          }
          continue;
        }
        if (options.recoverRecall && options.memory?.records.length && options.memory.memoryOnly) {
          result.generationOrigin = 'recovered';
          return finish('answer', groundedRecallAnswer('{}', options.memory, parsed.data.message) +
            '\n\nThe model was unavailable; this answer quotes the saved evidence directly.');
        }
        return finish(modelScope.signal.reason instanceof ExecutionTimeoutError ? 'model_timeout' : 'provider_error');
      } finally {
        modelScope.dispose();
        if (modelStartedAt !== undefined) {
          const modelEndedAt = performance.now();
          const metrics = { outcome: modelOutcome, call: result.stats.modelCalls, usage: tokenUsage(response?.usage),
            ...(modelFailure ? { modelFailure } : {}) };
          observeStage(options.observe, modelStartedAt, { stage: 'model_call', ...metrics }, modelEndedAt);
          // Known before execution when tools are disabled, otherwise identified from
          // an answer response. A failed tool-enabled call has no inferable purpose.
          if (!tools.length || (response?.finishReason === 'stop' && !response.toolCalls.length)) {
            observeStage(options.observe, modelStartedAt,
              { stage: 'final_synthesis', outcome: modelOutcome, call: result.stats.modelCalls }, modelEndedAt);
          }
        }
      }
      if (response.usage) {
        result.usage.push(response.usage);
        if (response.usage.outputTokens > maxOutputTokens) return reject('output_limit', 'output_limit');
      }
      if (response.finishReason === 'content_filter') return reject('content_filter', 'content_filter');
      if (response.finishReason === 'length') return reject('output_limit', 'output_limit');
      if (!response.toolCalls.length) {
        if (response.finishReason !== 'stop') return reject('invalid_response', 'finish_tool_mismatch');
        if (!response.text.trim()) return reject('empty_output', 'empty_text');
        const knownIds = new Set(search.sources.map((source) => source.id));
        if (citationIds(response.text).some((id) => !knownIds.has(id))) return finish('invalid_citation');
        let answer = response.text;
        // Historical citation markers are projected in model context; verify that
        // exact representation rather than the untouched on-disk snapshots.
        if (changeRequest) {
          const verification = options.memory ? verifyChangeAnswer(response.text, memoryData(options.memory), search.sources, issues.size > 0, parsed.data.message) :
            'Cannot verify: no supported historical baseline was supplied.';
          answer = dualRecallVerify && options.memory ? formatRecallAndVerifyAnswer(options.memory, verification, parsed.data.message) : verification;
        } else if (/(?<!no )\bconfirmed change\b/i.test(answer)) answer = 'Cannot verify: a change verdict was not established by deterministic evidence comparison.';
        if (!checkSourceQuotations(answer, search.sources)) answer = 'Cannot verify: quotation warning: a cited quotation did not match the exact available source text. No unsupported quotation or change claim is accepted.';
        if (options.memory?.memoryOnly) {
          if (options.memory.groundedRecall) {
            const evaluated = evaluateGroundedRecall(response.text, options.memory, parsed.data.message);
            answer = evaluated.answer;
            result.generationOrigin = evaluated.origin;
          } else {
            answer = validateAndGroundMemoryAnswer(answer, options.memory, parsed.data.message);
          }
        } else if (options.memory?.recall && !changeRequest) {
          const memory = options.memory;
          answer = groundHistoricalProse(answer, memory, (sentence) => groundMixedMemoryAnswer(sentence, memory));
        }
        if (performance.now() - startedAt >= limits.data.deadlineMs) return finish('deadline');
        deadline.signal.throwIfAborted();
        if (citationIds(answer).some((id) => !knownIds.has(id))) return finish('invalid_citation');
        const finalText = boundAnswer(contextLimitation ? `${answer}\n\nContext limitation: ${contextLimitation}` : answer);
        if (suppressRawStream && options.onText && finalText) {
          await options.onText(finalText);
        }
        return finish('answer', finalText);
      }
      if (!tools.length) return finish('round_limit');
      if (response.finishReason !== 'tool_calls') return reject('invalid_response', 'finish_tool_mismatch');
      const groups: string[][] = [];
      for (const call of response.toolCalls) {
        if (call.name !== 'web_search') return reject('unsupported_tool', 'unsupported_tool');
        if (seenCallIds.has(call.id)) return reject('repeated_tool_call', 'repeated_tool_id');
        seenCallIds.add(call.id);
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { return reject('invalid_tool_call', 'tool_arguments_json'); }
        const valid = SearchArgumentsSchema.safeParse(args);
        if (!valid.success) return reject('invalid_tool_call', 'tool_arguments_schema');
        groups.push(researchPolicy.focus(valid.data.queries));
      }
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
      const outcomes = await search.runRound(groups);
      const fresh = search.sources.filter((s) => !shownSources.has(s.id));
      const originals = new Map(fresh.map((s) => [s.id, s.text]));
      const encode = () => {
        const ids = new Set(shownSources); const bodies = new Map(shownBodies);
        return outcomes.map((group, i): ModelMessage => ({ role: 'tool', toolCallId: response.toolCalls[i].id,
          content: JSON.stringify(group.map((outcome) => ({ ...outcome, sources: outcome.sources.map((s) => {
            if (ids.has(s.id)) return { id: s.id, previouslySupplied: true };
            ids.add(s.id);
            const textRef = bodies.get(s.text);
            if (textRef) { const { text: _text, ...metadata } = s; return { ...metadata, textRef }; }
            bodies.set(s.text, s.id); return s;
          }) }))) }));
      };
      // Preserve room for the second round's framing/evidence. Only new, never-yet
      // shown excerpts can change; registry, snapshots and checks use these exact texts.
      const reserve = search.rounds === 1 ? Math.min(8192, Math.floor(options.provider.contextWindowTokens / 4)) : 0;
      let toolMessages = encode();
      for (let size = 1000; !contextFits({ messages: [...messages, ...toolMessages], tools: [WEB_SEARCH_TOOL], maxOutputTokens: AGENT_LIMITS.maxOutputTokens }, options.provider.contextWindowTokens, reserve) && size >= 125; size = Math.floor(size / 2)) {
        for (const source of fresh) source.text = excerpt(originals.get(source.id)!, `${parsed.data.message} ${source.query}`, size, changeRequest);
        contextLimitation = 'Research excerpts were shortened to fit the context budget; omitted text was not checked.';
        toolMessages = encode();
      }
      if (!contextFits({ messages: [...messages, ...toolMessages], tools: [WEB_SEARCH_TOOL], maxOutputTokens: AGENT_LIMITS.maxOutputTokens }, options.provider.contextWindowTokens)) {
        search.sources.splice(0, search.sources.length, ...search.sources.filter((s) => shownSources.has(s.id)));
        return finish('answer', 'Cannot verify: essential history and research evidence cannot fit the context budget. Please narrow the question.');
      }
      for (const source of fresh) { shownSources.add(source.id); if (!shownBodies.has(source.text)) shownBodies.set(source.text, source.id); }
      for (let i = 0; i < outcomes.length; i++) {
        for (const outcome of outcomes[i]) {
          if (!['ok', 'duplicate'].includes(outcome.status)) issues.add(`search_${outcome.status}`);
        }
        messages.push(toolMessages[i]);
      }
      if (!options.search || performance.now() - startedAt >= SEARCH_LIMITS.cutoffMs || search.attempts >= SEARCH_LIMITS.total ||
          outcomes.flat().every((outcome) => outcome.status === 'duplicate')) toolsEnabled = false;
    }
    return finish('round_limit');
  } catch {
    return finish(options.signal.aborted ?
      (options.signal.reason instanceof ExecutionTimeoutError ? 'deadline' : 'cancelled') :
      deadline.signal.aborted ? 'deadline' : 'provider_error');
  } finally {
    deadline.dispose();
    result.sources = search.sources;
    result.issues = [...issues];
    result.stats.searchRounds = search.rounds;
    result.stats.searchRequests = search.attempts;
    observeTotal();
  }
}
