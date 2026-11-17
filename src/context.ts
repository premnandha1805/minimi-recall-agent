import { isChangeRequest } from './verification.js';
import { createTemporalResolver, type TemporalResult } from './dates.js';
import type { Conversation, ConversationStore } from './memory.js';
import { contextFits, type ModelMessage } from './model.js';
import { WEB_SEARCH_TOOL } from './search.js';
import { AGENT_SYSTEM_PROMPT, RECALL_OUTPUT_INSTRUCTIONS } from './prompts.js';
import { ExecutionTimeoutError, runWithSignal, createDeadlineScope } from './execution.js';
import { rankMemory, stem } from './memory-ranking.js';

export const RETRIEVAL_LIMITS = Object.freeze({ conversations: 100, scannedRecords: 150_000,
  selected: 8, contextBytes: 32_768 });
export interface HistoricalRecord {
  conversationId: string; turnId: string; ordinal: number; provenance: 'server_recorded' | 'client_seed';
  user: { id: string; content: string; timestamp: string; role?: 'user' | 'assistant' };
  assistant?: { id: string; content: string; timestamp: string };
  timezone?: string; selection?: 'match' | 'adjacent';
  evidence: NonNullable<Conversation['turns'][number]['attempts'][number]['answer']>['evidence'];
}
export interface RetrievedMemory {
  reference: { instant: string; timezone: string; localTime?: string }; recall: boolean; memoryOnly: boolean;
  status: 'found' | 'not_found' | 'ambiguous' | 'limited' | 'unsupported_date';
  records: HistoricalRecord[]; matches: number; limitation?: string;
  temporal?: TemporalResult;
  /** Enables the extractive evidence contract for production retrieval. */
  groundedRecall?: boolean;
}
const stopWords = new Set(('what did i you we our the a an on in at to from earlier previous past last discuss discussion discussed ask asked tell me ' +
  'which five tools shortlist shortlisted summarize summarise conversation conversations about and of was were with has have changed now current latest ' +
  'is have any product products prices price your recommendation correct major new feature launch launched since this discussed ' +
  'can could would please kindly recall remember remind us about tell share give again answer still valid accurate then ' +
  'today yesterday monday tuesday wednesday thursday friday saturday sunday week days ago november january february march april may june july august september october december ' +
  'my mine your yours our ours when where who how why do does got be am are been being say said mention mentioned state stated date dates time times day upcoming scheduled planned ' +
  'decide decided agree agreed choose chose chosen talked next recent currently previously before back had done been ' +
  'topic topics something anything everything it its that those these them they there here s ' +
  'month months year years discussion history interactions interaction regarding concerning related ' +
  'was were should will shall').split(' '));
const synonyms: Readonly<Record<string, string>> = Object.freeze({
  bought: 'buy', purchased: 'buy', purchase: 'buy', learnt: 'learn',
  selected: 'select', chosen: 'choose', chose: 'choose',
  postgresql: 'postgres',
  crms: 'crm',
  meetings: 'meeting',
  appointments: 'appointment',
  calls: 'call',
  interviews: 'interview',
  events: 'event',
  plans: 'plan',
  discussions: 'discussion',
  preferred: 'prefer', preferences: 'prefer', preference: 'prefer',
  favourite: 'favorite', favourites: 'favorite', favorites: 'favorite',
  projects: 'project', budgets: 'budget', working: 'work', living: 'live',
  called: 'name', named: 'name', names: 'name',
  stocks: 'stock',
});
function keywords(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .map((v) => synonyms[v] ?? v)
    .filter((v) => !stopWords.has(v) && !/^\d+$/.test(v) && v.length > 1).map(stem);
}
const scheduleTerms = 'meetings?|appointments?|calls?|interviews?|events?|plans?|schedule|calendar';
function isPersonalRecall(query: string): boolean {
  if (/\b(?:what|when|where|which|how)\b[^?!;.]{0,40}\bdid (?:i|we) (?:ask|discuss|shortlist|decide|choose|agree|talk|say|mention)\b/i.test(query)) return false;
  if (/\b(?:did we|did i)\s+(?:discuss|decide|choose|agree|shortlist|ask|talk about)\b/i.test(query)) return false;
  // Exclude device/network/runtime queries:
  if (/\b(?:my|our)\s+(?:ip|ip address|ip-address|current ip|public ip|location|current location|device|browser|screen|battery|network|wifi|connection|system|hardware|operating system)\b/i.test(query)) return false;
  // General personal queries (preferences, attributes, schedule, etc.):
  if (/\b(?:what|which|who|when|where)\b[^?!;.]{0,80}\b(?:my|our)\b/i.test(query) ||
      /\b(?:where|when)\s+(?:do|did|am|are|was|were)\s+(?:i|we)\b/i.test(query) ||
      /\b(?:what|which)\b[^?!;.]{0,60}\b(?:do|did)\s+(?:i|we)\s+(?:prefer|like|love|use|own)\b/i.test(query)) return true;
  // Possessive interrogatives and first-person past questions are independent
  // of the subject noun. Runtime/device exclusions above remain deliberate.
  if (/\b(?:who|what|which|where|when|how)\b[^?!;.]{0,100}\bdid\s+(?:i|we)\b/i.test(query)) return true;
  if (/\b(?:what (?:date|time|day) (?:is (?:my|our)|do (?:i|we) have)|when (?:is (?:my|our|the)|do (?:i|we) have)|do (?:i|we) have (?:any|a)|have (?:i|we) got (?:any|a)|did (?:i|we) (?:mention|schedule|plan|have|say)|what did (?:i|we) (?:say|mention|schedule|plan)|what (?:are )?(?:my|our))\b/i.test(query) &&
      new RegExp(`\\b(?:${scheduleTerms})\\b`, 'i').test(query)) {
    return true;
  }
  if (new RegExp(`\\b(?:my|our)\\s+(?:[\\p{L}\\p{N} -]{0,30}\\s+)?(?:${scheduleTerms})\\b`, 'iu').test(query) &&
      /\b(?:when|what|where|which|do|did|have|has|is|are|tell|check|show|find|list|remind|recall|any|upcoming|next)\b/i.test(query)) {
    return true;
  }
  if (new RegExp(`\\b(?:any|upcoming|next|scheduled)\\s+(?:${scheduleTerms})\\b`, 'i').test(query) &&
      /\b(?:do (?:i|we) have|have (?:i|we)|for me|for us|my|our)\b/i.test(query)) {
    return true;
  }
  return false;
}
export function isExternalRequest(query: string): boolean {
  const hasExplicitExternalIntent =
    /\b(?:latest|current|up.to.date)\b/i.test(query) && !/\b(?:my|our)\s+(?:meeting|appointment|schedule|plan)\b/i.test(query) ||
    /\b(?:current|latest|today'?s?|live|real-time|market)\s+(?:price|prices|quote|quotes|value|trading)\b/i.test(query) ||
    /\b(?:stock price|share price)\b/i.test(query) ||
    /\b(?:latest|today'?s?|breaking)\b[^?!;.]{0,40}\bnews\b/i.test(query) ||
    /\b(?:weather|temperature|forecast)\b/i.test(query) ||
    /\b(?:search the (?:web|internet)|look up (?:online|on the web)|google|browse the web)\b/i.test(query) ||
    /\b(?:has|have)\s+(?!my\b|our\b)[\p{L}\p{N} ]{1,40}\s+(?:changed|released|updated|announced)\b/iu.test(query);

  if (hasExplicitExternalIntent) return true;

  if (isChangeRequest(query)) {
    const isPrivateSchedule = new RegExp(`\\b(?:${scheduleTerms})\\b`, 'i').test(query) &&
      /\b(?:my|our)\b/i.test(query) && !/\b(?:public|agm|board meeting|investor)\b/i.test(query);
    return !isPrivateSchedule;
  }

  return false;
}
/** Recognize recall intent only. External fact dates never silently select conversations. */
export function recallIntent(query: string) {
  const isPersonal = isPersonalRecall(query);
  const recall = isChangeRequest(query) || isPersonal ||
    /\b(?:what|which)\b[^?!;.]{0,80}\bdid (?:i|we)\b/i.test(query) ||
    /\b(?:those|these)\s+(?:\w+\s+)?(?:options|tools|recommendations)\b|\bwhat (?:was|were) (?:it|they)\b/i.test(query) ||
    /\b(?:what (?:was|were|have|had) (?:i|we)|(?:last|previous|earlier|past) (?:chat|conversation|discussion)|(?:you|we) (?:recommended|suggested)|(?:those|that|these) (?:options|tools|project|topic)|continue (?:our|the|that|previous))\b/i.test(query) ||
    /\b(?:(?:what|when|where|which|how) did (?:i|we)|(?:i|we) (?:asked|discussed|shortlisted)|which .{0,80}did we|summari[sz]e our (?:earlier|previous)|earlier conversation|recall|remember|remind|our earlier)\b/i.test(query);
  const memoryOnly = recall && !isExternalRequest(query) && (isPersonal ? true :
    !isChangeRequest(query) && !/\b(?:now|current|latest|changed|verify|update|still)\b/i.test(query));
  return { recall, memoryOnly };
}
/** Separate the remembered discussion from follow-up instructions, without a model call. */
function historicalLocator(query: string): string {
  const clauses = query.split(/[?!;]|\.(?=\s|$)|\b(?:and|but)\s+(?=(?:what|who|when|where|is|are|has|have|verify|check|compare|update|search|find)\b)/i);
  const locators = clauses.filter((clause) =>
    isPersonalRecall(clause) ||
    /\b(?:(?:what|when|where|which|how) did (?:i|we)|(?:i|we) (?:asked|discussed|shortlisted)|did we|recall|remember|remind|our (?:earlier|previous))\b/i.test(clause)
  );
  return locators.length ? locators.join('; ') : query;
}
const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
const weekdays = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
// Capture invalid numeric dates too: the resolver, not this extractor, validates calendars.
const dateExpressions = new RegExp(`\\b(?:\\d{1,4}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{1,4})?|\\d{1,2} (?:${months})(?: \\d{4})?|(?:${months}) \\d{1,2}(?:,? \\d{4})?|(?:last|next|this) (?:${weekdays}|week|month|year)|${weekdays}|yesterday|today|\\d+ days? ago)\\b`, 'gi');
function dateHint(locator: string): string | undefined {
  const spans = [...locator.matchAll(dateExpressions)];
  if (spans.length > 1) return 'unsupported multiple temporal references';
  if (spans.length && /\bon\s+(?:the\s+)?\d+(?:st|nd|rd|th)\b/i.test(locator)) return 'unsupported partial calendar reference';
  if (spans.length) return spans[0][0];
  // A preposition alone is not a date: "working on Atlas" is a topic locator.
  // Unsupported explicit holiday/partial-date expressions still need clarification.
  if (/\b(?:on|during)\s+(?:the\s+)?(?:\d|Christmas|Easter|Thanksgiving|New Year's)\b/i.test(locator)) return 'unsupported calendar reference';
  return undefined;
}
const descriptiveTerms = new Set('options details notes information recommendations pricing cost costs services available affordable managed suitable comparison'.split(' '));
const eventUpdate = /\b(?:meeting|appointment|interview|call|event|plan)\b[^?!;.]{0,80}\b(?:rescheduled|moved|postponed|cancelled|canceled)\b/i;
const adjacentCorrection = new RegExp(
  '^(?:' +
    '(?:actually|correction|sorry|scratch that|no,?\\s+(?:make that|i meant)?|instead|rather)\\b|' +
    '(?:please\\s+)?(?:make (?:it|that)|change (?:it|that|the date)|reschedule(?:d)?|move(?:d)?|postpone(?:d)?|cancel(?:led|ed)?|call(?:ing)? off|push (?:it )?back to)\\b|' +
    '(?:it|that|(?:my|our|the|that)\\s+(?:meeting|appointment|interview|call|event|plan))\\s+(?:(?:is|was|has been|got)\\s+)?(?:rescheduled|moved|postponed|cancelled|canceled|changed)\\b' +
  ')',
  'i'
);
/** Shared by retrieval and answer validation; updates remain original evidence. */
export function isMemoryUpdate(content: string): boolean {
  return adjacentCorrection.test(content.trim()) || eventUpdate.test(content) ||
    /\b(?:is|was|has been|got)\s+(?:cancelled|canceled|rescheduled|postponed|renamed|replaced)\b/i.test(content);
}
function isPersonalAssertion(content: string, query = ''): boolean {
  const trimmed = content.trim();
  if (/\?\s*$/.test(trimmed)) return false;
  if (/^(?:what|which|when|where|who|whom|whose|why|how|do|does|did|is|are|am|was|were|has|have|had|can|could|would|should|shall|will|may|might|must)\b/i.test(trimmed)) return false;
  if (/\b(?:tell me|let me know|wondering|asking|curious|advise|recommend|suggest)\b/i.test(trimmed)) return false;
  if (/\b(?:whether|if)\s+(?:i|we)\s+(?:should|would|could|ought|can|might)\b/i.test(trimmed)) return false;
  if (/\b(?:imagine|suppose|assuming|assume|hypothetically|pretend|what if|fictional|example)\b/i.test(trimmed)) return false;
  if (/^(?:if|unless|in case)\b/i.test(trimmed)) return false;
  if (/\b(?:maybe|perhaps|not sure|dont know|don't know|might be|doubt)\b/i.test(trimmed)) return false;
  const relation = trimmed.match(/\b(?:my|our)\s+(brother|sister|mother|father|mom|dad|parent|parents|friend|friends|colleague|colleagues|coworker|coworkers|boss|manager|client|clients|wife|husband|partner|son|daughter|cousin|family)\b/i)?.[1];
  if (relation && !keywords(query).includes(stem(relation.toLowerCase()))) return false;
  return true; // Any other declarative text is evidence, not a domain whitelist.
}
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
async function retrieveMemoryImpl(store: Pick<ConversationStore, 'list' | 'load'> & Partial<Pick<ConversationStore, 'snapshot'>>, options: {
  query: string; activeConversationId: string; currentTurnId: string; referenceInstant: string; timezone: string;
  signal: AbortSignal; startedAt: number; deadlineMs: number;
}): Promise<RetrievedMemory> {
  const check = () => {
    options.signal.throwIfAborted();
    if (performance.now() - options.startedAt >= options.deadlineMs) throw new ExecutionTimeoutError();
  };
  const intent = recallIntent(options.query);
  const memory: RetrievedMemory = { ...intent, reference: { instant: options.referenceInstant, timezone: options.timezone }, status: 'not_found', records: [], matches: 0, groundedRecall: true };
  memory.reference.localTime = new Intl.DateTimeFormat('en-GB', { timeZone: options.timezone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(options.referenceInstant));
  const locator = historicalLocator(options.query);
  const personal = isPersonalRecall(locator);
  // In a personal question a date describes the event, not when it was stored.
  const hint = intent.recall && !personal ? dateHint(locator) : undefined;
  if (hint) {
    memory.temporal = createTemporalResolver({ referenceInstant: options.referenceInstant, timezone: options.timezone }).resolve(hint, 'conversation');
    if (memory.temporal.status !== 'resolved') { memory.status = 'unsupported_date'; return memory; }
  }
  const topic = keywords(locator.replace(dateExpressions, ' '));
  const descriptive = new Set([...descriptiveTerms].map(stem));
  let anchors = [...new Set(topic.filter((word) => !descriptive.has(word)))];
  if (anchors.length > 64) {
    memory.status = 'limited'; memory.limitation = 'Narrow the question to at most 64 distinct lookup terms; historical retrieval was not completed.';
    return memory;
  }
  const broadChronology = !!memory.temporal || /\b(?:what did (?:i|we) (?:discuss|ask)|summari[sz]e (?:our|my) (?:history|conversations?)|message.level|transcript)\b/i.test(locator);
  const candidates: Array<{ record: HistoricalRecord; score: number }> = [];
  const values: Conversation[] = [];
  if (!intent.recall) {
    check(); const active = await runWithSignal(options.signal, () => store.load(options.activeConversationId));
    check(); if (active) values.push(active);
  } else if (store.snapshot) {
    values.push(...await runWithSignal(options.signal, () => store.snapshot!(options.signal))); check();
  } else {
    // Compatibility with small injectable stores; production uses one snapshot.
    for (const offset of [0, 50]) {
      check(); const page = await runWithSignal(options.signal, () => store.list({ offset, limit: 50 })); check();
      for (const item of page.items) {
        const value = await runWithSignal(options.signal, () => store.load(item.id)); check();
        if (!value) throw new Error('Historical storage changed during retrieval');
        values.push(value);
      }
      if (offset + page.items.length >= page.total) break;
    }
  }
  const eligible: HistoricalRecord[] = [];
  for (const value of values) {
    const current = value.id === options.activeConversationId ? value.turns.find((t) => t.id === options.currentTurnId) : undefined;
    for (const r of records(value)) {
      check();
      if (Date.parse(r.user.timestamp) > Date.parse(options.referenceInstant) ||
          (current && r.provenance === 'server_recorded' && r.ordinal >= current.ordinal)) continue;
      if (r.assistant && Date.parse(r.assistant.timestamp) > Date.parse(options.referenceInstant)) { delete r.assistant; r.evidence = []; }
      eligible.push(r);
      if (eligible.length > RETRIEVAL_LIMITS.scannedRecords) {
        memory.status = 'limited'; memory.limitation = 'Stored record scan limit reached; retrieval was not completed.'; return memory;
      }
    }
  }
  // A pronoun can use recent active context as a locator, but never a random
  // other conversation. Without an active antecedent the matches stay ambiguous.
  if (intent.recall && /\b(?:those|these|that|this|it)\b/i.test(locator)) {
    const active = eligible.filter((r) => r.conversationId === options.activeConversationId).slice(-2);
    if (active.length && anchors.length === 0) anchors = [...new Set(active.flatMap((r) => keywords(r.user.content)))];
  }
  if (anchors.length > 64) {
    memory.status = 'limited'; memory.limitation = 'Narrow the reference; its antecedent exceeds 64 lookup terms.'; return memory;
  }
  if (intent.recall && !anchors.length && !broadChronology) {
    memory.status = 'ambiguous'; memory.limitation = 'Which topic or conversation do you mean? Please give a subject or date.';
    return memory;
  }
  const inDate = (r: HistoricalRecord) => memory.temporal?.status !== 'resolved' ||
    (Date.parse(r.user.timestamp) >= Date.parse(memory.temporal.startUtc) && Date.parse(r.user.timestamp) < Date.parse(memory.temporal.endUtcExclusive));
  const relatedReference = (text: string) => /^(?:and|those|they|it|also|why|how|which one)\b|\b(?:this|that|those|these)\s+(?:topic|project|option|one|technology|idea)\b/i.test(text);
  const neighbors = new Map<string, HistoricalRecord>();
  for (const r of eligible) neighbors.set(`${r.conversationId}:${r.provenance}:${r.ordinal}`, r);
  const neighbor = (r: HistoricalRecord, delta: number) => neighbors.get(`${r.conversationId}:${r.provenance}:${r.ordinal + delta}`);
  const sharesTopic = (a: HistoricalRecord, b: HistoricalRecord) => {
    const terms = new Set(keywords(a.user.content));
    return keywords(b.user.content).some((term) => !descriptive.has(term) && terms.has(term));
  };
  const pool = eligible.filter((r) => inDate(r) && (!personal || r.user.role !== 'assistant' && isPersonalAssertion(r.user.content, locator)));
  const documents = pool.map((r) => {
    // Rank a reference with its antecedent, but keep the originals separate.
    const previous = neighbor(r, -1);
    const before = previous && (relatedReference(r.user.content) || !personal && sharesTopic(previous, r)) ? previous : undefined;
    return keywords([r.user.content, personal ? '' : r.assistant?.content ?? '',
      before?.user.content ?? '', before?.assistant?.content ?? ''].join(' '));
  });
  const namedAnchors = [...locator.matchAll(/\b[A-Z][a-zA-Z0-9]+\b/g)].flatMap((match) => keywords(match[0])).filter((term) => anchors.includes(term));
  const scores = intent.recall && anchors.length ? rankMemory(anchors, documents) : pool.map(() => 1);
  const recentMatches = new Map<string, HistoricalRecord[]>();
  pool.forEach((r, index) => {
    check();
    if (!scores[index] || intent.recall && namedAnchors.some((term) => !documents[index].includes(term))) return;
    const ownTerms = new Set(keywords(`${r.user.content} ${personal ? '' : r.assistant?.content ?? ''}`));
    r.selection = anchors.length && !anchors.some((term) => ownTerms.has(term)) ? 'adjacent' : 'match';
    const previousMatches = recentMatches.get(r.conversationId) ?? [];
    if (isMemoryUpdate(r.user.content) && previousMatches.some((previous) => sharesTopic(previous, r))) r.selection = 'adjacent';
    recentMatches.set(r.conversationId, [...previousMatches.slice(-1), r]);
    candidates.push({ record: r, score: scores[index] });
  });
  // Preserve contiguous references and corrections in both directions. Only
  // server turns have known relationships; imports remain separate provenance.
  if (intent.recall && anchors.length) {
    const selected = new Set(candidates.map((c) => c.record));
    for (let i = 0; i < candidates.length; i++) {
      check(); const anchor = candidates[i]; const r = anchor.record;
      if (r.provenance !== 'server_recorded') continue;
      for (const delta of [-1, 1]) {
        const next = neighbor(r, delta);
        if (!next || selected.has(next) || !inDate(next)) continue;
        const reference = delta === -1 ? r : next;
        const before = neighbor(r, -1);
        const bridgesReference = delta === 1 && before && relatedReference(r.user.content) && sharesTopic(before, next);
        if (!relatedReference(reference.user.content) && !isMemoryUpdate(reference.user.content) && (personal || !sharesTopic(r, next) && !bridgesReference)) continue;
        // A named different event must not inherit the previous event's identity.
        const kind = reference.user.content.match(/^(?:my|our|the|that)\s+(meeting|appointment|interview|call|event|plan)\b/i)?.[1];
        const antecedent = delta === -1 ? next : r;
        if (kind && !keywords(antecedent.user.content).includes(stem(kind))) continue;
        if (personal && delta === -1 && !relatedReference(r.user.content)) continue;
        next.selection = 'adjacent'; selected.add(next);
        candidates.push({ record: next, score: anchor.score - 0.001 });
      }
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
    const related = r.selection === 'adjacent' || anchors.length > 0 || /^(?:and|those|they|it|also|why|how)\b/i.test(r.user.content) ||
      keywords(r.user.content).some((word) => previousTopics.has(word));
    if (!previous || r.provenance !== 'server_recorded' || previous.provenance !== 'server_recorded' ||
        r.conversationId !== previous.conversationId || r.ordinal !== previous.ordinal + 1 ||
        (personal ? r.selection !== 'adjacent' : !related || day.format(new Date(r.user.timestamp)) !== day.format(new Date(previous.user.timestamp)))) discussions++;
  }
  memory.status = memory.limitation ? 'limited' : !memory.matches ? 'not_found' :
    intent.recall && discussions > 1 ? 'ambiguous' : 'found';
  memory.records.sort((a, b) => (personal ? Date.parse(a.user.timestamp) - Date.parse(b.user.timestamp) : 0) ||
    a.conversationId.localeCompare(b.conversationId) || (a.provenance === b.provenance ? 0 : a.provenance === 'client_seed' ? -1 : 1) || a.ordinal - b.ordinal || a.turnId.localeCompare(b.turnId));
  return memory;
}

/** Inherit arrival time; bound stalled storage even if it ignores cancellation. */
export async function retrieveMemory(store: Pick<ConversationStore, 'list' | 'load'> & Partial<Pick<ConversationStore, 'snapshot'>>, options: Parameters<typeof retrieveMemoryImpl>[1]): Promise<RetrievedMemory> {
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
      // Relative phrases carry an original-message reference. A named date
      // without a year remains yearless; do not manufacture an event year.
      mentions: (m.content.match(dateExpressions) ?? []).filter((expression) => /^(?:yesterday|today|last |next |this |\d+ days? ago)/i.test(expression)).slice(0, 4).map((expression) => ({
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
    { role: 'system', content: AGENT_SYSTEM_PROMPT + (memory.memoryOnly && memory.groundedRecall ? '\n' + RECALL_OUTPUT_INSTRUCTIONS : '') },
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
