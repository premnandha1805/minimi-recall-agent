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

const Selection = z.strictObject({
  answer: z.string().max(2000).optional(),
  memoryEvidence: z.array(z.strictObject({
    messageId: z.string().min(1).max(128),
    quote: z.string().min(1).max(32_000),
  })).max(16),
});

const framingTokens = new Set([
  'you', 'your', 'yours', 'we', 'our', 'ours', 'i', 'my', 'me', 'the', 'a', 'an',
  'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'initially', 'originally', 'previously', 'earlier', 'later', 'then', 'after',
  'first', 'second', 'currently', 'now', 'since', 'also', 'however', 'although',
  'actually', 'instead', 'rather', 'both', 'either',
  'yes', 'that', 'this', 'these', 'those', 'there', 'here', 'when', 'where',
  'what', 'which', 'who', 'why', 'how', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'would', 'should',
  'mentioned', 'stated', 'said', 'asked', 'discussed', 'decision', 'choice',
  'scheduled', 'interview', 'interviews', 'meeting', 'meetings', 'appointment', 'appointments',
  'changed', 'updated', 'switched',
  'it', 'its', 'as', 'into', 'about', 'over', 'between', 'during',
]);

const NEGATIVE_WORDS = /\b(?:not|never|no|no longer|none|neither|nor|without|didn't|don't|isn't|aren't|wasn't|weren't|won't|cannot|can't)\b/i;
const CANCELLATION_WORDS = /\b(?:cancelled|canceled|rescheduled|postponed|skipped|rejected|declined)\b/i;
const DECISION_WORDS = /\b(?:decided|chose|chosen|selected|picked|bought|purchased|committed|confirmed|opted|went with|settled on)\b/i;
const QUOTE_DECISION_WORDS = /\b(?:decided|chose|chosen|selected|picked|bought|purchased|committed|confirmed|opted|going with|went with|settled on|will use|using)\b/i;
const DATE_REGEX = /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/gi;
const MONTH_OR_DAY = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;

function extractDatesNormalized(text: string): string[] {
  return [...text.matchAll(DATE_REGEX)].map(m => m[0].toLowerCase().replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1').trim());
}

function extractEntities(text: string): string[] {
  return [...text.matchAll(/\b[A-Z][a-zA-Z0-9_-]+\b/g)]
    .map(m => m[0])
    .filter(e => e.length >= 2 && !framingTokens.has(e.toLowerCase()) && !MONTH_OR_DAY.test(e));
}

function isQuestionEvidence(quote: string, messageContent?: string): boolean {
  if (/\?\s*$/.test(quote.trim())) return true;
  if (messageContent && /\?\s*$/.test(messageContent.trim())) return true;
  if (/^(?:should\s+i|could\s+i|can\s+i|what\s+if|how\s+about|would\s+it\s+be|is\s+it|do\s+i|does\s+it|what\s+is|where\s+is)\b/i.test(quote.trim())) return true;
  return false;
}

function isNaturallyGrounded(
  answer: string,
  selectedEvidence: Array<{ messageId: string; quote: string }>,
  messages: Array<{ record: any; message: any; role: string }>,
  memory: RetrievedMemory
): boolean {
  if (!answer.trim()) return false;

  // 1. Ambiguity preservation: if memory status is ambiguous, answer MUST acknowledge ambiguity
  if (memory.status === 'ambiguous') {
    const acknowledges = /\b(?:multiple|different|two|both|either|ambiguous|competing|which one|or)\b/i.test(answer);
    if (!acknowledges) return false;
  }

  // Map each evidence item to its original message and record
  const evidenceDetails = selectedEvidence.map(e => {
    const matched = messages.find(({ message }) => message.id === e.messageId);
    return {
      quote: e.quote,
      message: matched?.message,
      record: matched?.record,
      role: matched?.role ?? 'user',
      timestamp: matched?.message ? Date.parse(matched.message.timestamp) : 0,
      ordinal: matched?.record?.ordinal ?? 0,
      dates: extractDatesNormalized(e.quote),
      entities: extractEntities(e.quote),
      hasNegation: NEGATIVE_WORDS.test(e.quote),
      hasCancellation: CANCELLATION_WORDS.test(e.quote),
      isQuestion: isQuestionEvidence(e.quote, matched?.message?.content),
    };
  });

  const combinedQuotes = evidenceDetails.map(d => d.quote).join(' ').toLowerCase();

  // 2. Token inclusion check: every substantive content token in answer must be present in quotes
  const answerContentTokens = [...answer.toLowerCase().matchAll(/\b[a-z0-9_-]{2,}\b/g)]
    .map(m => m[0])
    .filter(t => !framingTokens.has(t) && !MONTH_OR_DAY.test(t));
  if (!answerContentTokens.every(t => combinedQuotes.includes(t))) {
    return false;
  }

  // Numbers check: every number in answer must appear in quotes
  const answerNumbers = [...answer.matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map(m => m[0].replace(/[,.]/g, ''));
  const quoteNumbers = [...combinedQuotes.matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map(m => m[0].replace(/[,.]/g, ''));
  if (!answerNumbers.every(n => quoteNumbers.includes(n))) {
    return false;
  }

  // 3. Assistant speculation vs User fact:
  // Claims about user choices/actions/facts cannot rely purely on assistant suggestions
  const claimsUserFact = /\b(?:you|your|we|our|my|i)\b/i.test(answer) ||
    /\b(?:chose|chosen|selected|picked|bought|purchased|confirmed|have|scheduled|decided|is|was|are|were)\b/i.test(answer);
  if (claimsUserFact && evidenceDetails.every(d => d.role === 'assistant')) {
    return false;
  }

  // 4. User questions vs Factual statements:
  // If all supporting quotes are questions, the answer cannot assert facts/choices/purchases
  if (evidenceDetails.every(d => d.isQuestion)) {
    return false;
  }

  // 5. Negation and Cancellation consistency:
  const answerHasNegation = NEGATIVE_WORDS.test(answer);
  const answerHasCancellation = CANCELLATION_WORDS.test(answer);

  // If any quote mentions cancellation/rescheduling, answer cannot state it as an active schedule
  if (evidenceDetails.some(d => d.hasCancellation)) {
    const assertsActive = /\b(?:have|scheduled|upcoming|is on|are on|interview on|meeting on)\b/i.test(answer);
    if (assertsActive && !answerHasCancellation && !answerHasNegation) {
      return false;
    }
  }

  // If quote has negation, answer cannot state it affirmatively
  if (evidenceDetails.every(d => d.hasNegation)) {
    if (!answerHasNegation && !answerHasCancellation) {
      return false;
    }
  }

  // If none of quotes have negation or cancellation, answer cannot introduce negation or cancellation
  if (!evidenceDetails.some(d => d.hasNegation || d.hasCancellation)) {
    if (answerHasNegation || answerHasCancellation) {
      return false;
    }
  }

  // 6. Invented state transitions / decisions:
  if (DECISION_WORDS.test(answer)) {
    const hasQuoteDecision = evidenceDetails.some(d => QUOTE_DECISION_WORDS.test(d.quote));
    if (!hasQuoteDecision) return false;
  }

  // 7. Numerical predicate binding (e.g. offered 120000 but asked 150000 vs offered 150000):
  for (const d of evidenceDetails) {
    const quotePredNumMatches = [...d.quote.matchAll(/\b([a-zA-Z]+)\s+(?:for\s+)?(\d+(?:[.,]\d+)*)\b/gi)];
    if (quotePredNumMatches.length > 1) {
      const answerPredNumMatches = [...answer.matchAll(/\b([a-zA-Z]+)\s+(?:for\s+)?(\d+(?:[.,]\d+)*)\b/gi)];
      for (const [_, ansPred, ansNum] of answerPredNumMatches) {
        const cleanAnsNum = ansNum.replace(/[,.]/g, '');
        const matchingQuotePred = quotePredNumMatches.find(([__, qPred]) => qPred.toLowerCase() === ansPred.toLowerCase());
        if (matchingQuotePred) {
          const cleanQuoteNum = matchingQuotePred[2].replace(/[,.]/g, '');
          if (cleanQuoteNum !== cleanAnsNum) {
            return false;
          }
        }
      }
    }
  }

  // 8. Transitive relationship / Subject-Object reversal (e.g. Alice hired Bob vs Bob hired Alice):
  for (const d of evidenceDetails) {
    const entities = extractEntities(d.quote);
    if (entities.length >= 2) {
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const e1 = entities[i];
          const e2 = entities[j];
          const e1Idx = d.quote.indexOf(e1);
          const e2Idx = d.quote.indexOf(e2);
          if (e1Idx !== -1 && e2Idx !== -1 && e1Idx < e2Idx) {
            const betweenQuote = d.quote.slice(e1Idx + e1.length, e2Idx).trim();
            const relMatch = betweenQuote.match(/\b([a-zA-Z]{3,})\b/);
            if (relMatch) {
              const relWord = relMatch[1].toLowerCase();
              if (!framingTokens.has(relWord)) {
                const ansE1Idx = answer.indexOf(e1);
                const ansE2Idx = answer.indexOf(e2);
                const ansRelIdx = answer.toLowerCase().indexOf(relWord);
                if (ansE1Idx !== -1 && ansE2Idx !== -1 && ansRelIdx !== -1) {
                  if (ansE2Idx < ansRelIdx && ansRelIdx < ansE1Idx) {
                    return false;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 9. Cross-record date and entity swapping:
  for (let i = 0; i < evidenceDetails.length; i++) {
    for (let j = 0; j < evidenceDetails.length; j++) {
      if (i === j) continue;
      const d1 = evidenceDetails[i];
      const d2 = evidenceDetails[j];
      const dates1 = d1.dates;
      const dates2 = d2.dates;
      const entities1 = d1.entities;
      const entities2 = d2.entities;

      // If within the same conversation and d2 has no competing entity (e.g. references "that company"),
      // the date in d2 is anaphorically bound rather than a competing event
      const sameConv = d1.record && d2.record && d1.record.conversationId === d2.record.conversationId;
      if (sameConv && entities2.length === 0) continue;

      for (const e1 of entities1) {
        for (const date2 of dates2) {
          if (!entities2.some(e => e.toLowerCase() === e1.toLowerCase()) && !dates1.includes(date2)) {
            const e1Lower = e1.toLowerCase();
            const clauses = answer.split(/(?:[.!?;]|\band\b|\bwhile\b|\bbut\b)/i);
            for (const clause of clauses) {
              const clauseNorm = clause.toLowerCase().replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
              if (clauseNorm.includes(e1Lower) && clauseNorm.includes(date2)) {
                return false;
              }
            }
          }
        }
      }
    }
  }

  // 10. Chronological correction ordering (e.g. MongoDB -> PostgreSQL vs PostgreSQL -> MongoDB):
  const transitionMatch = answer.match(/\b(?:later|changed|finally|instead|updated|then|initially|originally|first|earlier|switched)\b/i);
  if (transitionMatch && transitionMatch.index !== undefined) {
    const transitionIndex = transitionMatch.index;
    const beforeTransition = answer.slice(0, transitionIndex);
    const afterTransition = answer.slice(transitionIndex);
    const initialEntity = [...beforeTransition.matchAll(/\b[A-Z][a-zA-Z0-9_-]+\b/g)].map(m => m[0]).filter(e => !['You', 'Your', 'I', 'We'].includes(e)).pop()?.toLowerCase();
    const laterEntity = [...afterTransition.matchAll(/\b[A-Z][a-zA-Z0-9_-]+\b/g)].map(m => m[0]).filter(e => !['You', 'Your', 'I', 'We'].includes(e))[0]?.toLowerCase();
    if (initialEntity && laterEntity && initialEntity !== laterEntity) {
      const initialEvidence = evidenceDetails.find(d => d.quote.toLowerCase().includes(initialEntity));
      const laterEvidence = evidenceDetails.find(d => d.quote.toLowerCase().includes(laterEntity));
      if (initialEvidence && laterEvidence) {
        const timeDiff = initialEvidence.timestamp - laterEvidence.timestamp;
        const ordinalDiff = (initialEvidence.ordinal) - (laterEvidence.ordinal);
        if (timeDiff > 0 || (timeDiff === 0 && ordinalDiff > 0)) {
          return false;
        }
      }
    }
  }

  return true;
}

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
  const transcript = /\b(?:transcript|verbatim|quotes?|original messages?|message.level)\b/i.test(query);

  // Natural synthesis path: model provides answer + grounded evidence across any number of records.
  if (valid && !transcript && !memory.limitation && selected!.memoryEvidence.length >= 1 && selected!.answer?.trim()) {
    if (isNaturallyGrounded(selected!.answer, selected!.memoryEvidence, messages, memory)) {
      return { answer: boundRecall(selected!.answer), origin: 'model' };
    }
  }

  // Legacy single-assertion path when no natural answer field was provided.
  if (valid && !transcript && memory.status === 'found' && !memory.limitation && records.length === 1 && selected!.memoryEvidence.length === 1 && !selected!.answer) {
    const entry = selected!.memoryEvidence[0];
    const match = messages.find(({ message }) => message.id === entry.messageId)!;
    if (match.role === 'user' && match.record.provenance === 'server_recorded' &&
      !isMemoryUpdate(match.message.content) && !/\?|\b(?:actually|instead|not|never|if|maybe|suppose|imagine)\b/i.test(match.message.content) &&
      /^(?:I|My|We)\b/.test(entry.quote) && !/\b(?:this|that|it|those|they)\b/i.test(entry.quote)) {
      return { answer: boundRecall(`${perspective(entry.quote)}\n\nStored message ${match.message.id}.`), origin: 'model' };
    }
  }
  // Valid JSON with empty evidence: model explicitly said no evidence found.
  if (selected && selected.memoryEvidence.length === 0 && selected.answer === '') {
    // Fall through to blockquote with unsupported note.
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
    records.length > 1 ? 'Here are the relevant stored conversations in chronological order:' : 'Here is the relevant stored conversation:';
  const limitation = memory.limitation ? `\n\nPartial memory coverage: ${memory.limitation}` : '';
  const unsupported = selected?.memoryEvidence.length === 0 ? '\n\nThese records do not establish a definite answer to your question.' : '';
  return {
    answer: boundRecall(`${header}\n\n${lines.join('\n\n')}${unsupported}${limitation}\n\nSent dates identify messages, not event dates. Quoted statements are historical evidence, not confirmation that they remain current.`),
    origin: 'recovered',
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
