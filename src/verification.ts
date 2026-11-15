import { z } from 'zod';
import type { RetrievedMemory } from './context.js';
import type { Source } from './search.js';

export type Verdict = 'Confirmed change' | 'No confirmed change' | 'Cannot verify' | 'Not comparable';
/** Explicit authority policy, not inferred from titles, ranking, HTTPS or a model assertion. */
export const OFFICIAL_PRODUCTS: Readonly<Record<string, string>> = Object.freeze({
  hubspot: 'hubspot.com', zoho: 'zoho.com', pipedrive: 'pipedrive.com', freshsales: 'freshworks.com',
  salesforce: 'salesforce.com', neon: 'neon.tech', supabase: 'supabase.com', render: 'render.com', railway: 'railway.com',
});
const normalized = (s: string) => s.normalize('NFC').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
/** Never remove decimal points, minus signs, currency signs, digits or date separators. */
export function quoteMatches(quote: string, evidence: string): boolean {
  const needle = normalized(quote); const haystack = normalized(evidence);
  if (!quote.length || quote.length > 500 || needle.length < 8) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? ''; const after = haystack[at + needle.length] ?? '';
    if (/[\p{L}\p{N}]/u.test(needle[0]) && /[\p{L}\p{N}]/u.test(before)) continue;
    if (/[\p{L}\p{N}]/u.test(needle.at(-1)!) && /[\p{L}\p{N}]/u.test(after)) continue;
    if (/\d/.test(needle.at(-1)!) && /[.,]/.test(after) && /\d/.test(haystack[at + needle.length + 1] ?? '')) continue;
    if (/\d/.test(needle.at(-1)!) && /[%‰]/.test(after)) continue;
    if (/\d/.test(needle[0]) && /[.,+−-]/.test(before)) continue;
    return true;
  }
  return false;
}
export function isChangeRequest(query: string): boolean {
  return /\b(?:changed?|changes|still correct|still valid|major new feature|new feature|feature launch)\b/i.test(query) &&
    /\b(?:since|previous|earlier|last discussed|shortlist|shortlisted|our|we|your previous)\b/i.test(query);
}
const Ref = z.strictObject({ sourceId: z.string().regex(/^S[1-9]\d*$/), quote: z.string().min(1).max(500) });
const HistoricalRef = Ref.extend({ conversationId: z.uuid(), turnId: z.uuid() });
const Candidate = z.strictObject({ kind: z.enum(['price', 'feature']),
  historical: HistoricalRef.optional(), current: Ref.optional() });
const Candidates = z.strictObject({ comparisons: z.array(Candidate).min(1).max(5) });
export const COMPARISON_INSTRUCTIONS = `For a historical change request, use web_search for fresh evidence within the existing budgets. The final response must be JSON only: {"comparisons":[{"kind":"price" or "feature","historical":{"conversationId":"original UUID","turnId":"original UUID","sourceId":"S1","quote":"short verbatim original evidence"},"current":{"sourceId":"current S1","quote":"short verbatim retrieved evidence"}}]}. At most five candidates. Omit unavailable references. Never supply a verdict or invented comparison fields. Runtime code decides the verdict. Historical IDs remain scoped to their original turn. The deterministic verifier only supports explicit, fully stated evidence records in the following grammars (do not reformat or manufacture evidence to fit them): Product: NAME; Plan: NAME; Region: REGION; Currency: USD/EUR/GBP/INR; Price: NUMBER; Billing: monthly/annual; Seats: NUMBER; Basis: per-seat/total; Conditions: TEXT; Effective: YYYY-MM-DD. Or Product: NAME; Feature: NAME; Status: unavailable/launched; Effective: YYYY-MM-DD. Other evidence must remain Cannot verify; never invent missing fields. These are extraction candidates, not model-certified facts.`;

type Evidence = Pick<Source, 'id' | 'url' | 'text' | 'retrieved_at' | 'published_at' | 'effective_at'>;
interface Price { kind: 'price'; product: string; plan: string; region: string; currency: string; amount: bigint;
  billing: string; seats: number; basis: string; conditions: string; effective: string }
interface Feature { kind: 'feature'; product: string; feature: string; status: string; effective: string }
type Fact = Price | Feature;
const pricePattern = /^Product: ([^;\n]{1,80}); Plan: ([^;\n]{1,80}); Region: ([^;\n]{1,80}); Currency: (USD|EUR|GBP|INR); Price: (\d{1,7}(?:\.\d{1,2})?); Billing: (monthly|annual); Seats: ([1-9]\d{0,4}); Basis: (per-seat|total); Conditions: ([^;\n]{1,100}); Effective: (\d{4}-\d{2}-\d{2})\.$/i;
const featurePattern = /^Product: ([^;\n]{1,80}); Feature: ([^;\n]{1,120}); Status: (unavailable|launched); Effective: (\d{4}-\d{2}-\d{2})\.$/i;
/** Deliberately narrow lossless extraction, not a general pricing/announcement parser. */
export function extractFact(quote: string): Fact | undefined {
  const clean = quote.normalize('NFC').replace(/\s+/g, ' ').trim();
  const p = clean.match(pricePattern);
  if (p && z.iso.date().safeParse(p[10]).success) {
    const [whole, decimal = ''] = p[5].split('.');
    return { kind: 'price', product: normalized(p[1]), plan: normalized(p[2]), region: normalized(p[3]), currency: p[4].toUpperCase(),
      amount: BigInt(whole) * 100n + BigInt(decimal.padEnd(2,'0')), billing: p[6].toLowerCase(), seats: Number(p[7]),
      basis: p[8].toLowerCase(), conditions: normalized(p[9]), effective: p[10] };
  }
  const f = clean.match(featurePattern);
  if (f && z.iso.date().safeParse(f[4]).success) return { kind: 'feature', product: normalized(f[1]), feature: normalized(f[2]), status: f[3].toLowerCase(), effective: f[4] };
  return undefined;
}
function official(fact: Fact, source: Evidence): boolean {
  const domain = OFFICIAL_PRODUCTS[fact.product];
  try { const url = new URL(source.url); return !!domain && url.protocol === 'https:' && !url.username && !url.password &&
    [domain, `www.${domain}`, `docs.${domain}`].includes(url.hostname); } catch { return false; }
}
// Evidence timestamps may carry offsets; date-only facts retain their literal day.
const dateOf = (timestamp: string) => timestamp.includes('T') ? new Date(timestamp).toISOString().slice(0,10) : timestamp;
function dimensions(f: Fact): string {
  return f.kind === 'price' ? JSON.stringify([f.product,f.plan,f.region,f.currency,f.billing,f.seats,f.basis,f.conditions]) : JSON.stringify([f.product,f.feature]);
}
function value(f: Fact): string { return f.kind === 'price' ? String(f.amount) : f.status; }
function conflicting(fact: Fact, sources: Evidence[], cutoff: string): boolean {
  const peers = sources.flatMap((s) => s.text.split(/[\r\n]+/).map(extractFact)
    .filter((f): f is Fact => !!f && official(f, s) && dimensions(f) === dimensions(fact) && f.effective <= cutoff));
  // Never cherry-pick an older explicit record or ignore a same-date contradiction.
  return peers.some((p) => p.effective > fact.effective || p.effective === fact.effective && value(p) !== value(fact));
}
export interface ComparisonCheck { verdict: Verdict; reason: string; label: string; historicalQuote?: string;
  historicalIdentity?: string; currentQuote?: string; sourceId?: string }
const cannot = (reason: string): ComparisonCheck => ({ verdict: 'Cannot verify', reason, label: 'Comparison' });
export function compareEvidence(candidate: z.infer<typeof Candidate>, memory: RetrievedMemory, current: Source[], incomplete = false): ComparisonCheck {
  if (incomplete || memory.status !== 'found') return cannot('Historical selection or current research is incomplete, missing or ambiguous.');
  const ref = candidate.historical;
  const record = memory.records.find((r) => r.conversationId === ref?.conversationId && r.turnId === ref?.turnId);
  if (!record || record.provenance !== 'server_recorded' || !record.assistant || !ref || !candidate.current) return cannot('A supported historical baseline and current evidence are required.');
  const old = record.evidence.find((s) => s.id === ref.sourceId);
  const fresh = current.find((s) => s.id === candidate.current!.sourceId);
  if (!old || !fresh || !quoteMatches(ref.quote, old.text) || !quoteMatches(candidate.current.quote, fresh.text)) return cannot('A cited quotation is missing or does not match the exact available evidence.');
  const before = extractFact(ref.quote); const after = extractFact(candidate.current.quote);
  if (![old, fresh].every((s, i) => s.text.split(/[\r\n]+/).some((line) => normalized(line) === normalized(i === 0 ? ref.quote : candidate.current!.quote)))) return cannot('The quote is not a standalone fully stated evidence record.');
  if (!before || !after || before.kind !== candidate.kind || after.kind !== candidate.kind || !official(before, old) || !official(after, fresh)) return cannot('Evidence lacks fully explicit supported facts from recognized official product sources.');
  const baselineDate = dateOf(record.assistant.timestamp); const observedDate = dateOf(fresh.retrieved_at);
  const future = (value: string | undefined, instant: string) => !!value && (value.includes('T') ? Date.parse(value) > Date.parse(instant) : value > dateOf(instant));
  if (Date.parse(old.retrieved_at) > Date.parse(record.assistant.timestamp) || Date.parse(fresh.retrieved_at) < Date.parse(record.assistant.timestamp) ||
      future(old.effective_at, record.assistant.timestamp) || future(old.published_at, record.assistant.timestamp) ||
      future(fresh.effective_at, fresh.retrieved_at) || future(fresh.published_at, fresh.retrieved_at)) return cannot('Evidence metadata is future-dated relative to its observed baseline or retrieval instant.');
  if (before.effective > baselineDate || dateOf(old.retrieved_at) > baselineDate || observedDate < baselineDate || after.effective > observedDate ||
      (old.effective_at && dateOf(old.effective_at) !== before.effective) || (fresh.effective_at && dateOf(fresh.effective_at) !== after.effective)) return cannot('Evidence dates do not establish an applicable historical/current comparison.');
  if (conflicting(before, record.evidence, baselineDate) || conflicting(after, current, observedDate)) return cannot('Available official evidence conflicts or the selected record is superseded.');
  const details = { label: before.product, historicalQuote: ref.quote.replace(/\\?\[(S\d+)\\?\]/g, (_m, id: string) => `(historical source ${id})`), historicalIdentity: `${record.conversationId}/${record.turnId}/${old.id} at ${record.assistant.timestamp}`,
    currentQuote: candidate.current.quote, sourceId: fresh.id };
  if (dimensions(before) !== dimensions(after)) return { ...details, verdict: 'Not comparable', reason: 'Product, plan, region, currency, billing, seats, basis or material conditions differ.' };
  if (before.kind === 'price' && after.kind === 'price') {
    if (before.amount !== after.amount && (after.effective <= before.effective || after.effective <= baselineDate)) return cannot('Different prices lack a supported chronological change.');
    return { ...details, verdict: before.amount === after.amount ? 'No confirmed change' : 'Confirmed change',
      reason: before.amount === after.amount ? 'The quoted comparable price is equal; this does not establish that everything is unchanged.' :
        after.amount > before.amount ? 'Explicit comparable evidence records a price increase.' : 'Explicit comparable evidence records a price decrease.' };
  }
  if (before.kind === 'feature' && after.kind === 'feature') {
    if (!fresh.published_at) return cannot('The feature announcement lacks an explicit publication date.');
    if (dateOf(fresh.published_at) > observedDate) return cannot('The announcement is future-dated.');
    const changed = before.status === 'unavailable' && after.status === 'launched' && after.effective > baselineDate && dateOf(fresh.published_at) > baselineDate;
    if (!changed && before.status !== after.status) return cannot('The release chronology conflicts with the historical status or the lifecycle change is unsupported.');
    return { ...details, verdict: changed ? 'Confirmed change' : 'No confirmed change', reason: changed ?
      'A dated official release follows the recorded unavailability baseline.' : 'Available evidence does not establish a newly launched feature since the baseline.' };
  }
  return cannot('The facts cannot be compared.');
}
export function verifyChangeAnswer(text: string, memory: RetrievedMemory, sources: Source[], incomplete = false): string {
  let input: unknown; try { input = JSON.parse(text); } catch { return 'Cannot verify: no validated evidence comparison was supplied.'; }
  const parsed = Candidates.safeParse(input);
  if (!parsed.success) return 'Cannot verify: comparison candidates were missing or malformed.';
  const checks = parsed.data.comparisons.map((c) => compareEvidence(c, memory, sources, incomplete));
  return checks.map((c, i) => `${i+1}. ${c.verdict} — ${c.label}: ${c.reason}` +
    (c.currentQuote ? `\nCurrent excerpt: “${c.currentQuote}” [${c.sourceId}]\nHistorical excerpt: “${c.historicalQuote}” (original ${c.historicalIdentity})` : '')).join('\n\n') +
    `\n\nSupported comparisons: ${checks.filter((c) => c.verdict !== 'Cannot verify' && c.verdict !== 'Not comparable').length} of ${checks.length}. Quote matches and constrained comparison rules do not establish full factual verification or complete market coverage.`;
}
/** Only explicitly cited source quotations are interpreted as source-quote claims.
 * Ordinary quoted names are not assumed to be direct source quotations. */
export function checkSourceQuotations(answer: string, sources: Source[]): boolean {
  const pattern = /[“"]([^“”"]{1,16000})[”"]\s*((?:\\?\[S\d+\\?\]\s*)+)/g;
  const claimed = [...answer.matchAll(/[”"]\s*\\?\[S\d+\\?\]/g)].length;
  let checked = 0;
  for (const match of answer.matchAll(pattern)) {
    checked++;
    const ids = [...match[2].matchAll(/\\?\[(S\d+)\\?\]/g)].map((m) => m[1]);
    if (!ids.length || ids.some((id) => !sources.some((s) => s.id === id && quoteMatches(match[1], s.text)))) return false;
  }
  return checked === claimed;
}
