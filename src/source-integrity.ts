/** Matching keys only. Never replace a provider URL with this value. */
export function sourceUrlKey(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source URL');
  // Preserve parameter order/encoding, unknown keys, fragments (including PDF page
  // selectors/hash routes), and non-root trailing slashes. No redirect guessing.
  const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
  const parts = url.search.slice(1).split('&');
  // Signed/tokenized links may bind the complete query, including tracking keys.
  try {
    const names = parts.map((part) => decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')));
    if (names.some((name) => /^(?:sig|signature|token|x-amz-.+|x-goog-.+)$/i.test(name))) return url.href;
  } catch { return url.href; } // Ambiguous encoding must never authorize removal.
  const retained = parts.filter((part) => !tracking.has(part.split('=')[0]));
  if (retained.length !== parts.length) url.search = retained.length ? `?${retained.join('&')}` : '';
  return url.href;
}

export interface RelevanceAssessment {
  sourceId: string;
  assessment: 'weak' | 'uncertain';
  queryTermsMatched: number;
  queryTermsTotal: number;
  year: 'match' | 'conflict' | 'unknown';
  requestedSite: boolean | null;
}
const stopWords = new Set('the and for with from what which when where who how about official latest current search find please site www com org'.split(' '));
function terms(text: string): string[] {
  return [...new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 3 && !stopWords.has(word) && !/^\d+$/.test(word)))];
}
const years = (text: string) => [...new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? [])];

/** Advisory lexical signals, never proof of authority, relevance or factual support.
 * Publication dates are deliberately not used as event dates. */
export function assessSource(query: string, intent: string, source: { id: string; title: string; url: string; text: string }): RelevanceAssessment {
  const queryTerms = terms(intent || query).slice(0, 64);
  const evidenceTerms = new Set(terms(`${source.title} ${source.text}`));
  const queryTermsMatched = queryTerms.filter((term) => evidenceTerms.has(term)).length;
  const intentYears = years(intent);
  const requestedYears = intentYears.length ? intentYears : years(query);
  const titleYears = years(source.title);
  const evidenceYears = titleYears.length ? titleYears : years(new URL(source.url).pathname);
  const year = requestedYears.length !== 1 || !evidenceYears.length ? 'unknown' :
    evidenceYears.includes(requestedYears[0]) ? 'match' : 'conflict';
  const sites = [...query.matchAll(/\bsite:([a-zA-Z0-9.-]+)(?=\s|$)/g)].map((match) => match[1].toLowerCase());
  const hostname = new URL(source.url).hostname;
  const requestedSite = sites.length ? sites.some((site) => hostname === site || hostname.endsWith(`.${site}`)) : null;
  return { sourceId: source.id, assessment: year === 'conflict' || (queryTerms.length > 0 && queryTermsMatched * 2 < queryTerms.length) ? 'weak' : 'uncertain',
    queryTermsMatched, queryTermsTotal: queryTerms.length, year, requestedSite };
}
