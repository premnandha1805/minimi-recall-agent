/** Small English morphological normalizer. No topic, product or answer rules.
 * Keep Unicode letters and identifier numbers; this is lexical, not embeddings. */
export function stem(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length < 4) return word;
  if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) word = word.slice(0, -1);
  if (word.length > 5 && /(?:ing|ed)$/.test(word)) {
    word = word.replace(/(?:ing|ed)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  }
  // Align forms such as migrate/migration; this deliberately remains modest.
  word = word.replace(/ation$/, 'at').replace(/(?:ment|ness)$/, '');
  return word.length > 4 ? word.replace(/e$/, '') : word;
}

/** Independent majority-overlap eligibility and inverse-frequency scores.
 * Empty topics need an explicit chronological mode in the caller. Named-entity
 * constraints are applied by retrieval, not by a global exact-match veto. */
export function rankMemory(query: string[], documents: string[][]): number[] {
  const sets = documents.map((terms) => new Set(terms));
  if (!query.length) return sets.map(() => 0);
  const frequencies = new Map(query.map((term) => [term, sets.filter((set) => set.has(term)).length]));
  return sets.map((set) => {
    const matched = query.filter((term) => set.has(term));
    if (matched.length < Math.ceil(query.length / 2)) return 0;
    return matched.reduce((score, term) => score + Math.log(1 + sets.length / (1 + frequencies.get(term)!)), 0) / query.length;
  });
}
