import { z } from 'zod';
import { isMemoryUpdate, memoryData, type RetrievedMemory } from './context.js';
import { MAX_MESSAGE_CHARS } from './contracts.js';

export const narrowRecall = 'The complete evidence exceeds the answer limit. Please narrow the date or topic; no original record or quotation has been truncated.';
export const boundRecall = (text: string) => text.length <= MAX_MESSAGE_CHARS ? text : narrowRecall;
/** Only grammatical perspective changes, never a model-created paraphrase. */
function perspective(text: string): string {
  return text.replace(/^I am\b/, 'You are').replace(/^I was\b/, 'You were')
    .replace(/^I\b/, 'You').replace(/^My\b/, 'Your').replace(/^We\b/, 'You');
}
function sameListAssertion(claim: string, original: string): boolean {
  if (/\b(?:not|never|if|maybe|suppose|imagine)\b/i.test(original)) return false;
  const source = original.match(/\b(?:I|We|we) (\w+) [^:]*:\s*(.+)$/);
  const target = claim.match(/^You (?:previously )?(\w+) (.+)$/);
  const list = (s: string) => s.replace(/,\s+and\s+/g, ', ').replace(/[.!]$/, '').trim();
  return !!source && !!target && source[1] === target[1] && list(source[2]) === list(target[2]);
}

const Selection = z.strictObject({ memoryEvidence: z.array(z.strictObject({
  messageId: z.string().min(1).max(128), quote: z.string().min(1).max(32_000),
})).max(16) });

/** Evidence extraction, not semantic claim verification: only original text can
 * reach the answer. Unknown IDs, forged quotes and prose fall back to originals.
 * Never accept generated labels, dates, roles, or assertions as metadata. */
export function evaluateGroundedRecall(text: string, memory: RetrievedMemory, query = ''): { answer: string; origin: 'model' | 'recovered' } {
  const records = memoryData(memory).records;
  const messages = records.flatMap((record) => [
    { record, message: record.user, role: record.user.role ?? 'user' },
    ...(record.assistant ? [{ record, message: record.assistant, role: 'assistant' }] : []),
  ]);
  let selected: z.infer<typeof Selection> | undefined;
  try { selected = Selection.parse(JSON.parse(text)); } catch { /* Explicit evidence fallback below. */ }
  const safeExcerpt = (original: string, quote: string) => {
    const at = original.indexOf(quote);
    return at >= 0 && (at === 0 || /[.!?]\s+$/.test(original.slice(0, at))) &&
      (at + quote.length === original.length || /[.!?]$/.test(quote) && /^\s/.test(original.slice(at + quote.length)));
  };
  const valid = !!selected && selected.memoryEvidence.length > 0 && selected.memoryEvidence.every((entry) =>
    messages.some(({ message }) => message.id === entry.messageId && safeExcerpt(message.content, entry.quote)));
  const origin: 'model' | 'recovered' = valid || selected?.memoryEvidence.length === 0 ? 'model' : 'recovered';
  const transcript = /\b(?:transcript|verbatim|quotes?|original messages?|message.level)\b/i.test(query);
  // Concise synthesis is allowed only for one unambiguous original assertion.
  // Competing records or corrections require chronology, never cherry-picking.
  if (valid && !transcript && memory.status === 'found' && !memory.limitation && records.length === 1 && selected!.memoryEvidence.length === 1) {
    const entry = selected!.memoryEvidence[0];
    const match = messages.find(({message}) => message.id === entry.messageId)!;
    if (match.role === 'user' && match.record.provenance === 'server_recorded' &&
        !isMemoryUpdate(match.message.content) && !/\?|\b(?:actually|instead|not|never|if|maybe|suppose|imagine)\b/i.test(match.message.content) &&
        /^(?:I|My|We)\b/.test(entry.quote) && !/\b(?:this|that|it|those|they)\b/i.test(entry.quote)) {
      return { answer: boundRecall(`${perspective(entry.quote)}\n\nStored message ${match.message.id}.`), origin };
    }
  }
  // Keep every selected record visible, so a model cannot erase a correction or
  // competing event by omitting its ID. Valid excerpts only shorten messages.
  const lines = messages.map(({ message, record, role }) => {
    const excerpt = valid ? selected!.memoryEvidence.find((item) => item.messageId === message.id)?.quote : undefined;
    // A shortened update could conceal its subject or superseding clause.
    const hasCorrection = isMemoryUpdate(message.content) || /\b(?:correction|actually|instead|no longer|scratch that)\b/i.test(message.content);
    const original = !hasCorrection && excerpt ? excerpt : message.content;
    const zone = record.timezone ?? memory.reference.timezone;
    const sent = new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.timestamp));
    const who = role === 'assistant' ? 'The assistant answered (unverified)' : 'You wrote';
    const provenance = record.provenance === 'client_seed' ? '; client_seed, unverified' : '';
    // Blockquote every line so stored instructions cannot look like our narrative.
    const quote = original.split('\n').map((line) => `> ${line}`).join('\n');
    return `${who}${original !== message.content ? ' (excerpt; surrounding text omitted)' : ''} — sent ${sent} (${zone}${record.timezone ? '' : ', assumed'}${provenance}):\n\n${quote}\n\n` +
      `Conversation ${record.conversationId}; message ${message.id}.`;
  });
  const header = memory.status === 'ambiguous' ? 'I found multiple historical matches; their relationship is ambiguous and they may describe different discussions or events.' :
    'Here is the relevant stored conversation:';
  const limitation = memory.limitation ? `\n\nPartial memory coverage: ${memory.limitation}` : '';
  const unsupported = selected?.memoryEvidence.length === 0 ? '\n\nThese records do not establish a definite answer to your question.' : '';
  return {
    answer: boundRecall(`${header}\n\n${lines.join('\n\n')}${unsupported}${limitation}\n\nSent dates identify messages, not event dates. Quoted statements are historical evidence, not confirmation that they remain current.`),
    origin,
  };
}

export function groundedRecallAnswer(text: string, memory: RetrievedMemory, query = ''): string {
  return evaluateGroundedRecall(text, memory, query).answer;
}

/** Broad historical/personal framing must be grounded in stored text, never
 * in a current web citation. Unframed ordinary reasoning stays intact. */
export function groundHistoricalProse(text: string, memory: RetrievedMemory, calendarGround?: (sentence: string) => string): string {
  const messages = memoryData(memory).records.flatMap((r) => r.user.role === 'assistant' ? [] : [r.user]);
  let replaced = false;
  const output = text.split(/(?<=[.!?])\s+|\n+/).flatMap((sentence) => {
    const historical = /\b(?:you|your|yours|my|our|we|previously|earlier|remember|recalled|last discussion|last conversation|chosen|selected|decided|shortlisted)\b/i.test(sentence);
    if (!historical) return [sentence];
    // Calendar clauses retain the stricter existing date/entity/year validator.
    if (calendarGround && /^(?:your|my|our)\s+[^.!?]+\s+(?:is|are|was|were|has been)\s+(?:on|at|scheduled|upcoming|cancelled|rescheduled)\b/i.test(sentence) &&
        /\b(?:meetings?|appointments?|interviews?|calls?|events?|flights?|conferences?|schedule|calendar|plans?)\b/i.test(sentence)) return [calendarGround(sentence)];
    // Whole sentences only: matching words cannot authorize reversed relations,
    // changed names, negation or invented prices. Strip current citations first.
    const claim = sentence.replace(/\s*\[S\d+\]/g, '').trim();
    const supported = messages.some((message) => message.content.split(/(?<=[.!?])\s+|\n+/).some((original) =>
      claim === original.trim() || claim === perspective(original.trim()) || sameListAssertion(claim, original.trim())));
    if (supported && !memory.records.some((r) => isMemoryUpdate(r.user.content)) && memory.status === 'found') return [claim];
    if (replaced) return [];
    replaced = true;
    return [memory.records.length ? groundedRecallAnswer('{}', memory) : 'I cannot verify that historical detail from the retrieved conversations.'];
  }).join('\n\n');
  return boundRecall(output);
}
