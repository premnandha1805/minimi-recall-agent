# Constrained change comparison and quotation safeguards

This stage retains all four DESIGN.md verdicts: **Confirmed change**, **No confirmed
change**, **Cannot verify**, **Not comparable**. It is not a general fact checker
or pricing engine. There are no additional model calls, tools or dependencies.

## Comparison evidence, not model verdicts

Recognized historical-change questions retrieve original stored discussions using
the existing context path and permit current Tavily research through the bounded
agent loop. The existing final model call proposes at most five evidence pairs as
internal JSON (historical conversation/turn/source identity, current source identity,
and short verbatim quotations). It cannot supply verdicts or invented fact fields.
This JSON is never the public HTTP/SSE result: TypeScript validates it and renders
the final answer. Missing or malformed candidates produce Cannot verify without
automatic retries. General recommendation correctness has no deterministic rule
here and must remain Cannot verify unless reduced to a supported evidence pair.

Historical candidates require an accepted server-recorded answer with saved source
text. Seeds, bare assistant claims, ambiguous retrieval, incomplete research and
unavailable snapshots cannot establish a verified baseline. Historical sources
remain separate from the current request registry even when both use S1. The old
quotation is labeled with its original conversation/turn/source/time; only current
sources receive clickable [S#] links. Saved source text and timestamps are unchanged.

## Deliberately narrow supported facts

Facts must be fully stated as standalone evidence records in the actual snippets,
using these explicit labeled forms. The model may not manufacture or reformat a
source to make it fit. Ordinary prose, incomplete tables, missing dimensions or
alternative formats currently produce Cannot verify.

```text
Product: Neon; Plan: Launch; Region: US; Currency: USD; Price: 20; Billing: monthly; Seats: 1; Basis: per-seat; Conditions: standard; Effective: 2026-11-01.
Product: Neon; Feature: Branch snapshots; Status: launched; Effective: 2026-11-14.
```

Price records support USD/EUR/GBP/INR and nonnegative decimal values with at most
two fractional digits. Comparison uses exact integer minor units without currency
conversion. Product, plan, region, currency, billing interval, seat count, basis
and material conditions must match. Differences in these dimensions yield Not
comparable. Unknown/missing dimensions yield Cannot verify instead.

An explicit policy in `OFFICIAL_PRODUCTS` recognizes HubSpot, Zoho, Pipedrive,
Freshsales, Salesforce, Neon, Supabase, Render and Railway. Only each mapped HTTPS
root, www or docs hostname qualifies; arbitrary customer subdomains and lookalike
hosts do not. The policy is not inferred from model assertions or search ranking.
Domain membership and a matching snippet do not prove factual truth, page intent,
completeness, or that the site has not been compromised. Live official-site coverage
and realistic page-format recall have not been evaluated. Unsupported products
remain Cannot verify; broad live accuracy is not claimed.

Comparable unequal prices require a later explicit effective date after the
historical discussion and no available conflicting or superseding official record.
This produces Confirmed change (increase or decrease). Equal comparable prices
produce No confirmed change for that quoted price only. Date-only records cannot
establish a change later within the same day as the historical discussion.

A feature launch needs an explicit prior unavailable state, a new launched state,
and both an effective date and publication date after the discussion. Old release
news with an already-launched baseline is No confirmed change, not a new release.
Contradictory lifecycle evidence, unsupported removals, missing dates, future
announcements and ambiguous history are Cannot verify. Publication, effective and
retrieval dates retain distinct meanings. Future timestamps within the same day
are checked against actual recorded instants; missing dates are not synthesized.

Competing fully parsed official records for the same dimensions are inspected.
Conflicting values at one effective date, or selection of a superseded record,
cannot establish confirmation. Unparsed prose may contain additional contradictions
that this constrained extractor cannot detect. Rendered coverage counts concern
the supplied comparisons, not all products or complete market coverage.

## Quotation checks

Quotes are matched against the exact possibly truncated evidence text supplied to
the model. Matching allows NFC Unicode, case, whitespace, typographic quotation
marks and en/em dash differences. It preserves digits, decimal/thousands punctuation,
percentages, currency signs, date separators and true minus signs. Numeric/word
token boundaries prevent accepting 20 as a quotation of 200 or 20.99. Quotations
are at most 500 characters; no ellipsis reconstruction or missing-text inference.

Ordinary answers additionally check explicitly source-cited straight/curly double
quotations immediately followed by [S#] markers (including escaped markers).
Every cited source must contain the quote. Unsupported nested/oversized forms fail
closed. Uncited quoted names, Markdown blockquotes and arbitrary paraphrases are
not certified by this checker. Valid IDs never establish factual claim support.
An unmatched cited quotation replaces the answer with a visible Cannot verify /
quotation warning; unsupported quote text is not displayed as evidence.

The public recall.chat.v1 event shapes and `evidenceCheck: citation_ids_only` are
unchanged. That field retains the transport-level registry guarantee; clients
must not infer universal quotation/factual verification from it. Limited comparison
checks are described in answer text. The existing Sources notice now explains this
limit without claiming that no quotation matching ever occurs. Historical stored
answers are not retroactively verified.

## Boundaries and tests

Only five candidates, existing 16,000-character model output and 24 current sources
are inspected. The original 25-second arrival deadline, three model calls, two
rounds, 5+3 searches, concurrency two and provider timeouts remain enforced. Pure
historical recall still disables search. Stored and retrieved content remains
untrusted data; parsing never executes instructions from it. Quotation matching
and these rules reduce unsupported claims but cannot prove general factual accuracy.

`tests/verification.test.ts` uses frozen labeled evidence and mocked providers.
It covers all four verdicts, source identity collisions, dates, conflicts, altered
quotations, unsupported data and injection boundaries. Existing agent/search/SSE
cancellation, timeout and budget regressions remain required. Real Azure/Tavily
compatibility, latency and live comparison quality remain unverified.
