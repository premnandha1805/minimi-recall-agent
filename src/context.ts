import { isChangeRequest } from './verification.js';
import { createTemporalResolver, type TemporalResult } from './dates.js';
import type { Conversation, ConversationStore } from './memory.js';
import { contextFits, type ModelMessage } from './model.js';
import { WEB_SEARCH_TOOL } from './search.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import { ExecutionTimeoutError, runWithSignal, createDeadlineScope } from './execution.js';

export const RETRIEVAL_LIMITS = Object.freeze({ conversations: 100, scannedRecords: 150_000,
  selected: 8, contextBytes: 32_768 });
export interface HistoricalRecord {
  conversationId: string; turnId: string; ordinal: number; provenance: 'server_recorded' | 'client_seed';
  user: { id: string; content: string; timestamp: string };
  assistant?: { id: string; content: string; timestamp: string };
  timezone?: string; selection?: 'match' | 'adjacent';
  evidence: NonNullable<Conversation['turns'][number]['attempts'][number]['answer']>['evidence'];
}
export interface RetrievedMemory {
  reference: { instant: string; timezone: string; localTime?: string }; recall: boolean; memoryOnly: boolean;
  status: 'found' | 'not_found' | 'ambiguous' | 'limited' | 'unsupported_date';
  records: HistoricalRecord[]; matches: number; limitation?: string;
  temporal?: TemporalResult;
}
const stopWords = new Set(('what did i you we our the a an on in at to from earlier previous past last discuss discussion discussed ask asked tell me ' +
  'which five tools shortlist shortlisted summarize summarise conversation conversations about and of was were with has have changed now current latest ' +
  'is have any product products prices price your recommendation correct major new feature launch launched since this discussed ' +
  'can could would please kindly recall remember remind us about tell share give again answer still valid accurate then ' +
  'today yesterday monday tuesday wednesday thursday friday saturday sunday week days ago november january february march april may june july august september october december').split(' '));
function keywords(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((v) => v === 'postgresql' ? 'postgres' : v === 'crms' ? 'crm' : v)
    .filter((v) => !stopWords.has(v) && !/^\d+$/.test(v) && v.length > 1);
}
/** Recognize recall intent only. External fact dates never silently select conversations. */
export function recallIntent(query: string) {
  const recall = isChangeRequest(query) || /\b(?:what did (?:i|we)|(?:i|we) (?:asked|discussed|shortlisted)|which .{0,80}did we|summari[sz]e our (?:earlier|previous)|earlier conversation|recall|remember|remind|our earlier)\b/i.test(query);
  const memoryOnly = recall && !isChangeRequest(query) && !/\b(?:now|current|latest|changed|compare|verify|update|still)\b/i.test(query);
  return { recall, memoryOnly };
}
/** Separate the remembered discussion from follow-up instructions, without a model call. */
function historicalLocator(query: string): string {
  const clauses = query.split(/[?!;]|\.(?=\s|$)|\b(?:and|but)\s+(?=(?:is|are|has|have|verify|check|compare|update)\b)/i);
  const locators = clauses.filter((clause) => /\b(?:what did (?:i|we)|(?:i|we) (?:asked|discussed|shortlisted)|did we|recall|remember|remind|our (?:earlier|previous))\b/i.test(clause));
  return locators.length ? locators.join('; ') : query;
}
const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
const weekdays = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
// Capture invalid numeric dates too: the resolver, not this extractor, validates calendars.
const dateExpressions = new RegExp(`\\b(?:\\d{1,4}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{1,4})?|\\d{1,2} (?:${months})(?: \\d{4})?|(?:${months}) \\d{1,2}(?:,? \\d{4})?|(?:last|next|this) (?:${weekdays}|week|month|year)|${weekdays}|yesterday|today|\\d+ days? ago)\\b`, 'gi');
function dateHint(locator: string): string | undefined {
  const spans = [...locator.matchAll(dateExpressions)];
  if (spans.length > 1) return 'unsupported multiple temporal references';
  if (spans.length) return spans[0][0];
  // An unrecognized explicit calendar locator must not become an unrestricted lookup.
  if (/\b(?:on|during)\s+\S/i.test(locator)) return 'unsupported calendar reference';
  return undefined;
}
const descriptiveTerms = new Set('options details notes information recommendations pricing cost costs services available affordable managed suitable comparison'.split(' '));
/** Originals are retained here. Only accepted server assistants are eligible. */
function records(value: Conversation): HistoricalRecord[] {
  return [
    ...value.seededMessages.map((m, ordinal): HistoricalRecord => ({ conversationId: value.id, turnId: m.id, ordinal,
      provenance: 'client_seed', user: m, timezone: value.timezone, evidence: [] })),
    ...value.turns.map((t): HistoricalRecord => {
      const accepted = t.attempts.find((a) => a.status === 'accepted')?.answer;
      return { conversationId: value.id, turnId: t.id, ordinal: t.ordinal, provenance: 'server_recorded',
        user: t.user, timezone: t.timezone ?? value.timezone, ...(accepted ? { assistant: accepted.result.message } : {}), evidence: accepted?.evidence ?? [] };
    }),
  ];
}
async function retrieveMemoryImpl(store: Pick<ConversationStore, 'list' | 'load'>, options: {
  query: string; activeConversationId: string; currentTurnId: string; referenceInstant: string; timezone: string;
  signal: AbortSignal; startedAt: number; deadlineMs: number;
}): Promise<RetrievedMemory> {
  const check = () => {
    options.signal.throwIfAborted();
    if (performance.now() - options.startedAt >= options.deadlineMs) throw new ExecutionTimeoutError();
  };
  const intent = recallIntent(options.query);
  const memory: RetrievedMemory = { ...intent, reference: { instant: options.referenceInstant, timezone: options.timezone }, status: 'not_found', records: [], matches: 0 };
  memory.reference.localTime = new Intl.DateTimeFormat('en-GB', { timeZone: options.timezone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(options.referenceInstant));
  const locator = historicalLocator(options.query);
  const hint = intent.recall ? dateHint(locator) : undefined;
  if (hint) {
    memory.temporal = createTemporalResolver({ referenceInstant: options.referenceInstant, timezone: options.timezone }).resolve(hint, 'conversation');
    if (memory.temporal.status !== 'resolved') { memory.status = 'unsupported_date'; return memory; }
  }
  const topic = keywords(locator.replace(dateExpressions, ' '));
  const anchors = topic.filter((word) => !descriptiveTerms.has(word));
  const candidates: Array<{ record: HistoricalRecord; score: number }> = [];
  let scanned = 0;
  const consider = (value: Conversation) => {
    const current = value.id === options.activeConversationId ? value.turns.find((t) => t.id === options.currentTurnId) : undefined;
    const all = records(value);
    const eligible = all.filter((r) => Date.parse(r.user.timestamp) <= Date.parse(options.referenceInstant) &&
      !(r.provenance === 'server_recorded' && current && r.ordinal >= current.ordinal));
    for (const r of eligible) {
      check(); if (++scanned > RETRIEVAL_LIMITS.scannedRecords) { memory.limitation = 'Stored record scan limit reached.'; break; }
      if (r.assistant && Date.parse(r.assistant.timestamp) > Date.parse(options.referenceInstant)) { delete r.assistant; r.evidence = []; }
      const time = Date.parse(r.user.timestamp);
      if (memory.temporal?.status === 'resolved' && (time < Date.parse(memory.temporal.startUtc) || time >= Date.parse(memory.temporal.endUtcExclusive))) continue;
      const haystack = new Set(keywords(`${r.user.content} ${r.assistant?.content ?? ''}`));
      const overlap = topic.filter((word) => haystack.has(word)).length;
      // Entity/topic anchors are mandatory; descriptive wording contributes to rank.
      // Generic words alone never establish a topic or authorize a date-free scan match.
      if (intent.recall && (topic.length ? !anchors.length || anchors.some((word) => !haystack.has(word)) ||
          overlap * 2 < topic.length : !memory.temporal)) continue;
      if (!intent.recall && r.conversationId !== options.activeConversationId) continue;
      r.selection = 'match';
      candidates.push({ record: r, score: overlap * 10 + (memory.temporal ? 100 : 0) });
    }
    if (intent.recall && topic.length) {
      const anchors = candidates.filter((v) => v.record.conversationId === value.id && v.record.provenance === 'server_recorded');
      for (const anchor of anchors) {
        check();
        const neighbor = eligible.find((r) => r.provenance === 'server_recorded' && r.ordinal === anchor.record.ordinal + 1 &&
          /^(?:and|those|they|it|also|why|how)\b/i.test(r.user.content));
        if (neighbor && !candidates.some((v) => v.record === neighbor) &&
            (memory.temporal?.status !== 'resolved' || Date.parse(neighbor.user.timestamp) < Date.parse(memory.temporal.endUtcExclusive))) {
          neighbor.selection = 'adjacent'; candidates.push({ record: neighbor, score: anchor.score - 1 });
        }
      }
    }
  };
  if (!intent.recall) {
    check(); const active = await runWithSignal(options.signal, () => store.load(options.activeConversationId));
    check(); if (active) consider(active);
  } else {
    for (const offset of [0, 50]) {
      check(); const page = await runWithSignal(options.signal, () => store.list({ offset, limit: 50 })); check();
      for (const item of page.items) {
        check(); const value = await runWithSignal(options.signal, () => store.load(item.id)); check();
        if (!value) throw new Error('Historical storage changed during retrieval');
        consider(value);
      }
      if (offset + page.items.length >= page.total) break;
    }
  }
  candidates.sort((a, b) => b.score - a.score || Date.parse(b.record.user.timestamp) - Date.parse(a.record.user.timestamp) ||
    a.record.conversationId.localeCompare(b.record.conversationId) || a.record.ordinal - b.record.ordinal || a.record.turnId.localeCompare(b.record.turnId));
  memory.matches = candidates.length;
  const maximum = intent.recall ? RETRIEVAL_LIMITS.selected : RETRIEVAL_LIMITS.scannedRecords;
  memory.records = candidates.slice(0, maximum).map((v) => v.record);
  if (candidates.length > maximum) memory.limitation = 'More matching whole turns exist than can be included. Narrow the date or topic.';
  // Only consecutive turns on the same local day can form one discussion. A gap,
  // another conversation, or another day retains ambiguity, regardless of rank.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const ordered = [...candidates].sort((a,b) => a.record.conversationId.localeCompare(b.record.conversationId) || a.record.ordinal - b.record.ordinal);
  let discussions = 0;
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i].record; const previous = ordered[i - 1]?.record;
    const previousTopics = new Set(previous ? keywords(previous.user.content).filter((word) => !descriptiveTerms.has(word)) : []);
    const related = anchors.length > 0 || /^(?:and|those|they|it|also|why|how)\b/i.test(r.user.content) ||
      keywords(r.user.content).some((word) => previousTopics.has(word));
    if (!previous || r.provenance !== 'server_recorded' || previous.provenance !== 'server_recorded' ||
        r.conversationId !== previous.conversationId || r.ordinal !== previous.ordinal + 1 ||
        !related || day.format(new Date(r.user.timestamp)) !== day.format(new Date(previous.user.timestamp))) discussions++;
  }
  memory.status = memory.limitation ? 'limited' : !memory.matches ? 'not_found' :
    intent.recall && discussions > 1 ? 'ambiguous' : 'found';
  memory.records.sort((a, b) => a.conversationId.localeCompare(b.conversationId) || (a.provenance === b.provenance ? 0 : a.provenance === 'client_seed' ? -1 : 1) || a.ordinal - b.ordinal || a.turnId.localeCompare(b.turnId));
  return memory;
}

/** Inherit arrival time; bound stalled storage even if it ignores cancellation. */
export async function retrieveMemory(store: Pick<ConversationStore, 'list' | 'load'>, options: Parameters<typeof retrieveMemoryImpl>[1]): Promise<RetrievedMemory> {
  const scope = createDeadlineScope(options.signal, Math.max(0, options.deadlineMs - (performance.now() - options.startedAt)));
  try { scope.signal.throwIfAborted(); return await retrieveMemoryImpl(store, { ...options, signal: scope.signal }); }
  finally { scope.dispose(); }
}

/** Marker projection is explicit and reversible; stored originals are never rewritten.
 * No historical source enters SearchSession or the current answer's source registry. */
export function memoryData(memory: RetrievedMemory, selected = memory.records) {
  return { ...memory, records: selected.map((r) => {
    const qualify = (text: string) => text.replace(/\\?\[(S\d+)\\?\]/g, (_m, id: string) => `【history:${r.conversationId}:${r.turnId}:${id}】`);
    const originalTimeReferences = [r.user, ...(r.assistant ? [r.assistant] : [])].map((m) => ({
      messageId: m.id, reference: { instant: m.timestamp, timezone: r.timezone ?? memory.reference.timezone }, assumedTimezone: !r.timezone,
      mentions: (m.content.match(/\b(?:yesterday|today|last Tuesday|last week|\d+ days? ago)\b/gi) ?? []).slice(0, 4).map((expression) => ({
        expression, result: createTemporalResolver({ referenceInstant: m.timestamp, timezone: r.timezone ?? memory.reference.timezone }).resolve(expression, 'external_event') })),
    }));
    return { ...r, originalTimeReferences, user: { ...r.user, content: qualify(r.user.content) },
      ...(r.assistant ? { assistant: { ...r.assistant, content: qualify(r.assistant.content) } } : {}),
      evidence: r.evidence.map((s) => ({ ...s, text: qualify(s.text), historicalId: `history:${r.conversationId}:${r.turnId}:${s.id}` })) };
  }) };
}
export function prepareAgentContext(memory: RetrievedMemory, query: string, contextWindowTokens: number,
  maxOutputTokens: number): { messages: ModelMessage[]; limitation?: string } {
  const build = (selected: HistoricalRecord[]): ModelMessage[] => [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ untrustedHistoricalData: { ...memoryData(memory, selected), contextOmitted: memory.records.length - selected.length } }) },
    { role: 'user', content: query },
  ];
  const fits = (selected: HistoricalRecord[]) => (!memory.recall || Buffer.byteLength(JSON.stringify(memoryData(memory, selected))) <= RETRIEVAL_LIMITS.contextBytes) &&
    contextFits({ messages: build(selected), tools: memory.memoryOnly ? [] : [WEB_SEARCH_TOOL], maxOutputTokens }, contextWindowTokens,
      memory.memoryOnly ? 0 : Math.min(28_672, Math.floor(contextWindowTokens / 2)));
  if (fits(memory.records)) return { messages: build(memory.records) };
  if (memory.recall) return { messages: [], limitation: 'The essential historical turns exceed the context limit. Narrow the date or topic; no shortlist was truncated.' };
  // Explicit shortlist references keep their whole original anchor even when old.
  const anchors = /\b(?:those|these|shortlist|five|options)\b/i.test(query) ? memory.records.filter((r) =>
    /\bshortlist(?:ed)?\b/i.test(`${r.user.content} ${r.assistant?.content ?? ''}`)) : [];
  if (!fits(anchors)) return { messages: [], limitation: 'The essential shortlist turns exceed the context limit. Narrow the question; no shortlist was truncated.' };
  const selected = [...anchors];
  for (const record of [...memory.records].reverse()) {
    if (selected.includes(record)) continue;
    const next = memory.records.filter((r) => r === record || selected.includes(r));
    if (!fits(next)) break;
    selected.splice(0, selected.length, ...next);
  }
  return { messages: build(selected), limitation: `${memory.records.length - selected.length} older whole turns omitted from context.` };
}
