import { ExecutionTimeoutError } from './execution.js';
import type { ModelResponse } from './model.js';

export type StageOutcome = 'success' | 'timeout' | 'abort' | 'failure';
export interface TokenUsage {
  inputTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}
/** Internal log record only; never part of the HTTP/SSE contract. No free-text data.
 * Usage belongs only to model_call; completion tokens already include reasoning.
 * Agent success includes honest partial answers (see agentStatus), not SSE delivery.
 * Source counts describe validated provider documents or registered round/agent sources. */
export interface StageObservation {
  stage: 'agent' | 'model_call' | 'search_round' | 'search_provider' | 'final_synthesis';
  durationMs: number;
  outcome: StageOutcome;
  call?: number;
  round?: number;
  modelCalls?: number;
  searchCalls?: number;
  sourceCount?: number;
  uniqueSourceUrls?: number;
  agentStatus?: 'completed' | 'partial' | 'failed' | 'cancelled';
  usage?: TokenUsage;
}
export type StageObserver = (event: StageObservation) => void;

export function abortOutcome(signal: AbortSignal): StageOutcome {
  return signal.aborted ? (signal.reason instanceof ExecutionTimeoutError ? 'timeout' : 'abort') : 'failure';
}

/** null means unavailable, including failed/timed-out calls; never estimate token use. */
export function tokenUsage(usage?: ModelResponse['usage']): TokenUsage {
  return { inputTokens: usage?.inputTokens ?? null, completionTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null };
}

export function sourceCounts(sources: readonly { url: string }[]) {
  // Exact URL equality measures registry duplication without changing source identity.
  return { sourceCount: sources.length, uniqueSourceUrls: new Set(sources.map((source) => source.url)).size };
}

/** Measures bounded caller wait, not remote compute after cancellation. Synthesis is
 * an overlapping model-call interval; durations must not be summed across stages.
 * Observers are synchronous/best-effort and cannot take ownership of execution. */
export function observeStage(observer: StageObserver | undefined, startedAt: number,
  event: Omit<StageObservation, 'durationMs'>, endedAt = performance.now()): void {
  if (!observer) return;
  try { observer({ ...event, durationMs: Math.max(0, endedAt - startedAt) }); }
  catch { /* A logging sink failure must not change answers, budgets or cancellation. */ }
}
