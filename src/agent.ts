import { isChangeRequest, COMPARISON_INSTRUCTIONS, verifyChangeAnswer, checkSourceQuotations } from './verification.js';
import { memoryData, prepareAgentContext, type RetrievedMemory } from './context.js';
import { z } from 'zod';
import { ChatRequestSchema, citationIds, type ChatRequest } from './contracts.js';
import { createDeadlineScope, ExecutionTimeoutError, runWithSignal } from './execution.js';
import { contextFits, ModelResponseSchema, type ModelMessage, type ModelProvider, type ModelResponse } from './model.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import { abortOutcome, observeStage, sourceCounts, tokenUsage, type StageObserver, type StageOutcome, type ValidationCategory } from './observability.js';
import { SEARCH_LIMITS, SearchArgumentsSchema, SearchSession, WEB_SEARCH_TOOL, type Source, type WebSearch } from './search.js';

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

export const AGENT_LIMITS = Object.freeze({ deadlineMs: 25_000, modelTimeoutMs: 10_000,
  modelCalls: 3, maxOutputTokens: 2048, totalOutputTokens: 6144 });
const RunOptionsSchema = z.strictObject({
  deadlineMs: z.number().int().min(1).max(AGENT_LIMITS.deadlineMs).default(AGENT_LIMITS.deadlineMs),
  modelTimeoutMs: z.number().int().min(1).max(AGENT_LIMITS.modelTimeoutMs).default(AGENT_LIMITS.modelTimeoutMs),
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
  const search = new SearchSession(options.search, deadline.signal, startedAt, options.observe, parsed.data.message);
  const issues = new Set<string>();
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
  let toolsEnabled = !options.memory?.memoryOnly;
  const finish = (reason: AgentStopReason, answer?: string): AgentResult => {
    result.reason = reason;
    result.status = reason === 'cancelled' ? 'cancelled' :
      reason === 'answer' ? (issues.size ? 'partial' : 'completed') : 'failed';
    if (answer !== undefined) result.answer = answer;
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
      if (memory.memoryOnly && memory.status === 'not_found') return finish('answer', 'I did not find a suitable record in the stored conversations. No historical details have been inferred.');
      if (memory.memoryOnly && memory.status === 'unsupported_date') return finish('answer', 'The historical date reference is ambiguous or unsupported. Please specify an ISO date or a supported calendar expression and timezone.');
      if (memory.memoryOnly && memory.status === 'limited') return finish('answer', memory.limitation ?? 'Historical coverage is limited. Please narrow the date or topic.');
      const prepared = prepareAgentContext(memory, parsed.data.message, options.provider.contextWindowTokens,
        Math.min(AGENT_LIMITS.maxOutputTokens, limits.data.outputTokenBudget));
      if (!prepared.messages.length) return finish('answer', (isChangeRequest(parsed.data.message) ? 'Cannot verify: ' : '') + prepared.limitation);
      messages = prepared.messages;
      contextLimitation = prepared.limitation;
    }
    const changeRequest = isChangeRequest(parsed.data.message);
    if (changeRequest) messages.splice(1, 0, { role: 'system', content: COMPARISON_INSTRUCTIONS });
    for (let step = 0; step < AGENT_LIMITS.modelCalls; step++) {
      if (performance.now() - startedAt >= limits.data.deadlineMs) return finish('deadline');
      deadline.signal.throwIfAborted();
      const remaining = limits.data.outputTokenBudget - result.stats.reservedOutputTokens;
      if (remaining <= 0) return finish('output_budget');
      const maxOutputTokens = Math.min(AGENT_LIMITS.maxOutputTokens, remaining);
      const tools = toolsEnabled && step < SEARCH_LIMITS.rounds ? [WEB_SEARCH_TOOL] : [];
      if (!contextFits({ messages, tools, maxOutputTokens }, options.provider.contextWindowTokens)) return finish('context_limit');
      const modelScope = createDeadlineScope(deadline.signal, limits.data.modelTimeoutMs);
      let response: ModelResponse | undefined;
      let modelStartedAt: number | undefined;
      let modelOutcome: StageOutcome = 'failure';
      try {
        const raw = await runWithSignal(modelScope.signal, () => {
          modelStartedAt = performance.now();
          result.stats.modelCalls++;
          // Reserve the maximum even if usage is absent or a request fails. No hidden retries.
          result.stats.reservedOutputTokens += maxOutputTokens;
          return options.provider.complete({ messages: structuredClone(messages), tools: structuredClone(tools),
            maxOutputTokens, signal: modelScope.signal });
        });
        deadline.signal.throwIfAborted();
        const validated = ModelResponseSchema.safeParse(raw);
        if (!validated.success) return reject('invalid_response', 'response_schema');
        response = validated.data;
        // Success here means a valid provider response, not factual/citation verification.
        modelOutcome = 'success';
      } catch {
        modelOutcome = abortOutcome(modelScope.signal);
        if (deadline.signal.aborted) deadline.signal.throwIfAborted();
        return finish(modelScope.signal.reason instanceof ExecutionTimeoutError ? 'model_timeout' : 'provider_error');
      } finally {
        modelScope.dispose();
        if (modelStartedAt !== undefined) {
          const modelEndedAt = performance.now();
          const metrics = { outcome: modelOutcome, call: result.stats.modelCalls, usage: tokenUsage(response?.usage) };
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
        if (changeRequest) answer = options.memory ? verifyChangeAnswer(response.text, memoryData(options.memory), search.sources, issues.size > 0, parsed.data.message) :
          'Cannot verify: no supported historical baseline was supplied.';
        else if (/(?<!no )\bconfirmed change\b/i.test(answer)) answer = 'Cannot verify: a change verdict was not established by deterministic evidence comparison.';
        if (!checkSourceQuotations(answer, search.sources)) answer = 'Cannot verify: quotation warning: a cited quotation did not match the exact available source text. No unsupported quotation or change claim is accepted.';
        if (performance.now() - startedAt >= limits.data.deadlineMs) return finish('deadline');
        deadline.signal.throwIfAborted();
        if (citationIds(answer).some((id) => !knownIds.has(id))) return finish('invalid_citation');
        return finish('answer', contextLimitation ? `${answer}\n\nContext limitation: ${contextLimitation}` : answer);
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
        groups.push(valid.data.queries);
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
