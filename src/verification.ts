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
  return /\b(?:changed?|changes|still (?:correct|valid|accurate)|major new feature|new feature|feature launch|released|verify|recheck)\b/i.test(query) &&
    /\b(?:since|previous|earlier|last discussed|shortlist|shortlisted|our|we|your (?:previous|answer|recommendation)|(?:i|we) (?:asked|discussed)|what did (?:i|we))\b/i.test(query);
}
const Ref = z.strictObject({ sourceId: z.string().regex(/^S[1-9]\d*$/), quote: z.string().min(1).max(500) });
const HistoricalRef = Ref.extend({ conversationId: z.uuid(), turnId: z.uuid() });
const Candidate = z.strictObject({ kind: z.enum(['price', 'feature']), product: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} .-]{0,79}$/u).optional(),
  historical: HistoricalRef.optional(), current: Ref.optional() });
const Candidates = z.strictObject({ comparisons: z.array(Candidate).min(1).max(5) });
export const COMPARISON_INSTRUCTIONS = `For a historical change request, use web_search for fresh evidence within the existing budgets. Final JSON only: {"comparisons":[{"kind":"price" or "feature","product":"original requested product name","historical":{"conversationId":"original UUID","turnId":"original UUID","sourceId":"S1","quote":"short verbatim original evidence"},"current":{"sourceId":"current S1","quote":"short verbatim retrieved evidence"}}]}. At most five distinct candidates; include missing shortlist items with their product and omit unavailable references. Never supply verdicts or invented facts. Runtime code decides verdicts and coverage. Historical IDs remain scoped to their original turn. Quote whole evidence lines, retaining qualifiers. Supported forms: Product: NAME; Plan: NAME; Region: REGION; Currency: USD/EUR/GBP/INR; Price: NUMBER; Billing: monthly/annual; Seats: NUMBER; Basis: per-seat/total; Conditions: TEXT; Effective: YYYY-MM-DD. Or Product: NAME; Feature: NAME; Status: unavailable/launched; Effective: YYYY-MM-DD. Also bounded complete prose such as The Neon Launch plan costs USD 20 per seat per month in the US, standard terms, effective 15 November 2026. Or On 14 November 2026, Neon launched Branch snapshots. Or As of 1 November 2026, Neon Branch snapshots was unavailable. Never reformat evidence to fit. Missing dimensions, unknown official ownership, starting prices, promotions and ambiguous evidence remain Cannot verify. These are extraction candidates, not model-certified facts.`;

type Evidence = Pick<Source, 'id' | 'url' | 'text' | 'retrieved_at' | 'published_at' | 'effective_at'>;
interface Price { kind: 'price'; product: string; plan: string; region: string; currency: string; amount: bigint;
  billing: string; seats: number; basis: string; conditions: string; effective: string }
interface Feature { kind: 'feature'; product: string; feature: string; status: string; effective: string }
type Fact = Price | Feature;
const pricePattern = /^Product: ([^;\n]{1,80}); Plan: ([^;\n]{1,80}); Region: ([^;\n]{1,80}); Currency: (USD|EUR|GBP|INR); Price: (\d{1,7}(?:\.\d{1,2})?); Billing: (monthly|annual); Seats: ([1-9]\d{0,4}); Basis: (per-seat|total); Conditions: ([^;\n]{1,100}); Effective: (\d{4}-\d{2}-\d{2})\.$/i;
const featurePattern = /^Product: ([^;\n]{1,80}); Feature: ([^;\n]{1,120}); Status: (unavailable|launched); Effective: (\d{4}-\d{2}-\d{2})\.$/i;
const products = Object.keys(OFFICIAL_PRODUCTS).join('|');
const prosePrice = new RegExp(`^(?:The )?(${products}) ([\\p{L}\\p{N} -]{1,80}) plan costs (USD|EUR|GBP|INR) ?([$€£₹]?)(\\d{1,7}(?:\\.\\d{1,2})?)(?: per (seat|user) per (month|year)| per (seat|user)/(month|year)|/(month|year) for ([1-9]\\d{0,4}) (?:seats?|users?)) in (?:the )?(US|EU|UK|India|global), (standard terms|annual commitment|monthly commitment), effective (.+)\\.$`, 'iu');
const proseLaunch = new RegExp(`^On (.+), (${products}) launched ([\\p{L}\\p{N} -]{1,120})\\.$`, 'iu');
const proseUnavailable = new RegExp(`^As of (.+), (${products}) ([\\p{L}\\p{N} -]{1,120}) was unavailable\\.$`, 'iu');
const qualified = /\b(?:not|never|starting|from|discount|discounted|promotion|promotional|trial|tier|tiers|example|hypothetical|fictional|except|excluding|only|ignore|instructions?)\b/i;
function explicitDay(text: string): string | undefined {
  const months = 'january february march april may june july august september october november december'.split(' ');
  const named = text.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/i);
  const day = named ? `${named[3]}-${String(months.indexOf(named[2].toLowerCase()) + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}` : text;
  return z.iso.date().safeParse(day).success ? day : undefined;
}
const minorUnits = (amount: string) => { const [whole, decimal = ''] = amount.split('.'); return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0')); };
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
  // Entire sentences only. Currency, region, conditions and date are never defaulted.
  // "per seat/user" explicitly supplies the unit quantity; total prices require a count.
  if (qualified.test(clean)) return undefined;
  const prose = clean.match(prosePrice);
  if (prose) {
    const effective = explicitDay(prose[14]); const currency = prose[3].toUpperCase();
    const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };
    if (!effective || prose[4] && symbols[currency] !== prose[4]) return undefined;
    return { kind: 'price', product: normalized(prose[1]), plan: normalized(prose[2]), currency, amount: minorUnits(prose[5]),
      billing: (prose[7] ?? prose[9] ?? prose[10]).toLowerCase() === 'month' ? 'monthly' : 'annual',
      seats: prose[11] ? Number(prose[11]) : 1,
      basis: prose[11] ? (/for \d+ users?/i.test(clean) ? 'total-user' : 'total') : normalized(prose[6] ?? prose[8]) === 'user' ? 'per-user' : 'per-seat',
      region: normalized(prose[12]),
      conditions: normalized(prose[13]) === 'standard terms' ? 'standard' : normalized(prose[13]), effective };
  }
  const announcement = clean.match(proseLaunch) ?? clean.match(proseUnavailable);
  const effective = announcement && explicitDay(announcement[1]);
  if (announcement && effective) return { kind: 'feature', product: normalized(announcement[2]), feature: normalized(announcement[3]),
    status: /^On /i.test(clean) ? 'launched' : 'unavailable', effective };
  return undefined;
}
function official(fact: Fact, source: Evidence): boolean {
  const domain = OFFICIAL_PRODUCTS[fact.product];
  try { const url = new URL(source.url); return !!domain && url.protocol === 'https:' && !url.username && !url.password &&
    !url.port && [domain, `www.${domain}`, `docs.${domain}`].includes(url.hostname) &&
    !/(?:^|\/)(?:redirect|redirects|redirector|out)(?:\/|$)/i.test(url.pathname) &&
    ![...url.searchParams.keys()].some((key) => /^(?:url|redirect|redirect_uri|redirect_url|target|destination|next)$/i.test(key)); } catch { return false; }
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
function ambiguousEvidence(fact: Fact, sources: Evidence[]): boolean {
  const hasName = (line: string, name: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(line);
  const relevant = (text: string) => hasName(text, fact.product) && hasName(text, fact.kind === 'price' ? fact.plan : fact.feature);
  return sources.some((s) => official(fact, s) && (
    relevant(s.text) && /\b(?:hypothetical|fictional|illustrative|example prices?|examples? only|except|excluding|only for|subject to|does not apply)\b/i.test(s.text) ||
    s.text.split(/[\r\n]+/).some((line) => relevant(line) &&
    (fact.kind === 'price' ? /\b(?:costs?|price|pricing)\b.*(?:USD|EUR|GBP|INR|[$€£₹])/i.test(line) : /\b(?:launched|unavailable)\b/i.test(line)) &&
    !extractFact(line))));
}
export interface ComparisonCheck { verdict: Verdict; reason: string; label: string; kind?: 'price' | 'feature'; historicalQuote?: string;
  historicalIdentity?: string; currentQuote?: string; sourceId?: string }
const cannot = (reason: string): ComparisonCheck => ({ verdict: 'Cannot verify', reason, label: 'Comparison' });
export function compareEvidence(candidate: z.infer<typeof Candidate>, memory: RetrievedMemory, current: Source[]): ComparisonCheck {
  if (memory.status !== 'found') return cannot('Historical selection is incomplete, missing or ambiguous.');
  const ref = candidate.historical;
  const record = memory.records.find((r) => r.conversationId === ref?.conversationId && r.turnId === ref?.turnId);
  if (!record || record.provenance !== 'server_recorded' || !record.assistant || !ref || !candidate.current) return cannot('A supported historical baseline and current evidence are required.');
  const old = record.evidence.find((s) => s.id === ref.sourceId);
  const fresh = current.find((s) => s.id === candidate.current!.sourceId);
  if (!old || !fresh || !quoteMatches(ref.quote, old.text) || !quoteMatches(candidate.current.quote, fresh.text)) return cannot('A cited quotation is missing or does not match the exact available evidence.');
  const before = extractFact(ref.quote); const after = extractFact(candidate.current.quote);
  if (![old, fresh].every((s, i) => s.text.split(/[\r\n]+/).some((line) => normalized(line) === normalized(i === 0 ? ref.quote : candidate.current!.quote)))) return cannot('The quote is not a standalone fully stated evidence record.');
  if (!before || !after || before.kind !== candidate.kind || after.kind !== candidate.kind) return cannot('Evidence lacks fully explicit supported facts; missing dimensions and qualifiers cannot be inferred.');
  if (!official(before, old) || !official(after, fresh)) return cannot('Official product ownership is unknown or the source URL is not allowed by the authority policy.');
  if (candidate.product && normalized(candidate.product) !== before.product) return cannot('The proposed product identity does not match the historical evidence.');
  if ([before, after].some((f) => f.kind === 'price' && /\b(?:starting|from|discount|discounted|trial|promo\w*|usage|tiers?|up to)\b/i.test(f.conditions))) return cannot('Starting, promotional, trial, discounted or usage-tier prices do not establish a fixed comparable price.');
  if (ambiguousEvidence(before, record.evidence) || ambiguousEvidence(after, current)) return cannot('Available official evidence contains an ambiguous or qualified assertion for this item.');
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
/** Coverage names are locators, never proof of ownership or a historical fact.
 * Only explicit lists are enumerated; arbitrary prose is not treated as a shortlist. */
function requestedProducts(memory: RetrievedMemory, query: string): string[] {
  const named = Object.keys(OFFICIAL_PRODUCTS).filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(query));
  if (named.length && !/\b(?:shortlist|shortlisted|those|five|all)\b/i.test(query)) return named;
  const names = new Set<string>();
  const addList = (text: string) => {
    const list = text.replace(/\.$/, '').split(/,|;|\band\b/i).map(normalized).filter(Boolean);
    if (list.length < 2 || list.length > 20 || list.some((name) => !/^[\p{L}\p{N}][\p{L}\p{N} -]{0,79}$/u.test(name))) return;
    for (const name of list) names.add(name);
  };
  for (const record of memory.records) for (const content of [record.user.content, record.assistant?.content ?? '']) {
    for (const match of content.matchAll(/(?:\bshortlist(?:ed)?(?: (?:is|was|includes))?\s*:\s*|\bshortlisted\s+)([^\n.!?]{1,500})/gi)) addList(match[1]);
    if (content === record.assistant?.content && /\bshortlist\b/i.test(record.user.content)) addList(content);
    if (names.size > 20) return []; // Do not silently enumerate only part of an oversized list.
  }
  return [...names];
}
export function verifyChangeAnswer(text: string, memory: RetrievedMemory, sources: Source[], incomplete = false, query = ''): string {
  const requested = memory.status === 'found' ? requestedProducts(memory, query) : [];
  let input: unknown; try { input = JSON.parse(text); } catch { input = undefined; }
  const parsed = Candidates.safeParse(input);
  const groups = new Map<string, ComparisonCheck[]>();
  for (const candidate of parsed.success ? parsed.data.comparisons : []) {
    const fact = candidate.historical && extractFact(candidate.historical.quote);
    const label = candidate.product ? normalized(candidate.product) : fact?.product;
    const check = compareEvidence(candidate, memory, sources);
    check.kind = candidate.kind;
    if (label) check.label = label;
    // Evidence pairs are deduplicated by semantic comparison identity, not model count,
    // citation ID, source order, or superficial quote spelling.
    const key = JSON.stringify([candidate.kind, label ?? 'unknown', fact ? dimensions(fact) : null]);
    const group = groups.get(key) ?? []; group.push(check); groups.set(key, group);
  }
  const checks = [...groups.values()].map((group) => group.every((c) => c.verdict === group[0].verdict && c.reason === group[0].reason) ? group[0] :
    { ...cannot('Conflicting candidates for the same comparison; no candidate was preferred.'), label: group[0].label, kind: group[0].kind });
  if (!parsed.success && !requested.length) checks.push(cannot('Comparison candidates were missing or malformed.'));
  for (const product of requested) if (!checks.some((c) => c.label === product)) checks.push({
    ...cannot('No supported evidence pair was supplied for this requested product; it has not been established as unchanged.'), label: product });
  const kinds: Array<'price' | 'feature'> = [];
  if (/\b(?:price|prices|pricing|cost|costs)\b/i.test(query)) kinds.push('price');
  if (/\b(?:feature|features|released|release|launched|launch)\b/i.test(query)) kinds.push('feature');
  for (const product of requested) for (const kind of kinds) {
    if (!checks.some((c) => c.label === product && (c.kind === kind || !c.kind))) checks.push({
      ...cannot(`No supported ${kind} evidence pair was supplied for this requested product.`), label: product, kind });
  }
  const supported = (c: ComparisonCheck) => c.verdict === 'Confirmed change' || c.verdict === 'No confirmed change';
  const supportedProducts = requested.filter((name) => checks.filter((c) => c.label === name).every(supported));
  const unsupportedProducts = requested.filter((name) => !supportedProducts.includes(name) &&
    checks.filter((c) => c.label === name).every((c) => c.verdict === 'Not comparable'));
  return checks.map((c, i) => `${i+1}. ${c.verdict} — ${c.label}: ${c.reason}` +
    (c.currentQuote ? `\nCurrent excerpt: “${c.currentQuote}” [${c.sourceId}]\nHistorical excerpt: “${c.historicalQuote}” (original ${c.historicalIdentity})` : '')).join('\n\n') +
    `\n\nSupported comparisons: ${checks.filter(supported).length} of ${checks.length}. ` +
    (requested.length ? `Requested products supported: ${supportedProducts.length} of ${requested.length}; unsupported (not comparable): ${unsupportedProducts.length}; unverified: ${requested.length - supportedProducts.length - unsupportedProducts.length}. Coverage applies only to the supplied comparison kinds, not every price or feature. ` :
      'Requested product coverage could not be enumerated; counts apply only to distinct supplied comparisons. ') +
    (incomplete ? 'Research is incomplete: some searches failed or were limited. Supported pairs use independently sufficient available evidence; missing research was not treated as unchanged. ' : '') +
    'Quote matches and constrained comparison rules do not establish full factual verification or complete market coverage.';
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
