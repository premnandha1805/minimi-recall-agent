# Constrained change comparison and quotation safeguards

This stage retains all four DESIGN.md verdicts: **Confirmed change**, **No confirmed
change**, **Cannot verify**, **Not comparable**. It is not a general fact checker
or pricing engine. There are no additional model calls, tools or dependencies.

## Comparison evidence, not model verdicts

Recognized historical-change questions retrieve original stored discussions using
the existing context path and permit current Tavily research through the bounded
agent loop. The existing final model call proposes at most five evidence pairs as
internal JSON (historical conversation/turn/source identity, current source identity,
and short verbatim quotations, plus an optional product identity for missing items).
Product names are coverage locators, never authority or evidence. It cannot supply
verdicts or invented fact fields.
This JSON is never the public HTTP/SSE result: TypeScript validates it and renders
the final answer. Missing or malformed candidates produce Cannot verify without
automatic retries. General recommendation correctness has no deterministic rule
here and must remain Cannot verify unless reduced to a supported evidence pair.

Historical candidates require an accepted server-recorded answer with saved source
text. Seeds, bare assistant claims, ambiguous retrieval and unavailable snapshots
cannot establish a verified baseline. Failed searches do not invalidate an
independently sufficient pair: the result retains partial status and explicitly
discloses incomplete research. Missing evidence for an item still means Cannot verify. Historical sources
remain separate from the current request registry even when both use S1. The old
quotation is labeled with its original conversation/turn/source/time; only current
sources receive clickable [S#] links. Saved source text and timestamps are unchanged.

## Deliberately narrow supported facts

Facts must be fully stated as standalone lines in the exact model-visible excerpts.
The model may not manufacture or reformat a source to make it fit. Labeled forms
remain supported:

```text
Product: Neon; Plan: Launch; Region: US; Currency: USD; Price: 20; Billing: monthly; Seats: 1; Basis: per-seat; Conditions: standard; Effective: 2026-11-01.
Product: Neon; Feature: Branch snapshots; Status: launched; Effective: 2026-11-14.
```

Gate 7D also accepts a small anchored prose grammar, for example:

```text
The Neon Launch plan costs USD 20 per seat per month in the US, standard terms, effective 15 November 2026.
Neon Professional plan costs USD $30/month for 1 user in the US, standard terms, effective 2026-11-17.
As of 1 November 2026, Neon Branch snapshots was unavailable.
On 14 November 2026, Neon launched Branch snapshots.
```

Prose prices require a mapped product, named plan, explicit currency code, amount,
unit/billing, region (US/EU/UK/India/global), conditions and valid explicit effective
date. Supported units are per seat/user per month/year (also per seat/month), or
total month/year prices with an explicit seat/user count. A symbol is optional but
must agree with the currency code; `$` alone does not establish USD. Conditions
are standard terms, annual commitment or monthly commitment. Per-user and per-seat
each state a unit quantity of one but retain distinct billing bases; a total price
never receives an inferred quantity or a user-to-seat conversion. Dates are
ISO calendar dates or day/full-English-month/year; relative dates are not inferred.

Starting prices, promotions, discounts, trials and usage tiers abstain, including
when stated in labeled conditions. Negation, extra qualifiers, missing dimensions,
partial sentences and unsupported sentence forms abstain. Recognized contextual
qualifications (such as hypothetical prices or “only for”) also block the relevant
item. This is not general prose understanding: unsupported contradictions elsewhere
in a page can still escape recognition. Comparison excerpt selection retains line
starts; a cut sentence cannot be reconstructed from omitted text.

Price records support USD/EUR/GBP/INR and nonnegative decimal values with at most
two fractional digits. Comparison uses exact integer minor units without currency
conversion. Product, plan, region, currency, billing interval, seat count, basis
and material conditions must match. Differences in these dimensions yield Not
comparable. Unknown/missing dimensions yield Cannot verify instead.

An explicit policy in `OFFICIAL_PRODUCTS` recognizes HubSpot, Zoho, Pipedrive,
Freshsales, Salesforce, Neon, Supabase, Render and Railway. Only each mapped HTTPS
root, www or docs hostname qualifies; arbitrary customer subdomains and lookalike
hosts do not. Nondefault ports and explicit redirect paths/parameters are rejected.
The policy is not inferred from model assertions, titles or search ranking.
Domain membership and a matching snippet do not prove factual truth, page intent,
completeness, or that the site has not been compromised. Live official-site coverage
and realistic page-format recall have not been evaluated. Unsupported products
remain Cannot verify; broad live accuracy is not claimed. Gate 7D deliberately
retains the mapping: the available provider metadata supplies no independently
trusted ownership proof for an arbitrary domain. Redirect chains/final fetched
destinations are not exposed by this adapter, so URL checks cannot certify them.

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
that this constrained extractor cannot detect. Exact and semantic duplicate
candidates count once (kind plus historical product/dimensions). Disagreeing
candidates for the same comparison fail closed rather than choosing a winner.

Requested products come from explicit original shortlist lists, or mapped names
in a specific-product question. Unknown names in a list remain in the denominator
without becoming trusted vendors. Missing candidates get individual Cannot verify
rows. Counts distinguish supported, not comparable and unverified products; if
both price and feature checks are explicitly requested, a missing kind prevents
calling that product fully supported. Unsupported shortlist formats disclose that
requested coverage could not be enumerated. Counts never establish complete market
coverage or the correctness of every recommendation.

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

`tests/verification.test.ts` uses frozen labeled/prose evidence and mocked providers.
It covers all four verdicts, source identity collisions, dates, conflicts, altered
quotations, unsupported data and injection boundaries. Existing agent/search/SSE
cancellation, timeout and budget regressions remain required. Dated live Azure/Tavily and comparison observations are recorded in evaluation.md and docs/results; they are not general accuracy guarantees.

## Recall reliability review

This is the uncommitted 22 November 2026 follow-up to cleanup, not a new historical feature milestone. [The measured results](results/recall-reliability.json) record the predefined before/after runs. No original harness criterion, fixture, source-trust rule, dependency, model-call limit, deadline or search budget was changed.

### Evidence and diagnosis

The harness creates a fact conversation, acknowledges its answer, and asks a recall question in a different conversation. Each traced recall input contained one matching original user statement, its separately labeled assistant response, UTC timestamps, conversation/message/turn identities, and original-time hints. No record was omitted; the user facts fit within the 600-character projection. Assistant projections are capped at 180 characters and are not evidence of personal decisions. All four facts in these runs were sent on 22 November, with Asia/Kolkata timezone. The meeting's yearless 23 August is an event mention, not its message date or proof of an upcoming meeting.

The actual model input is three messages: the trusted system instructions, JSON untrustedHistoricalData, and the recall question. Recall exposes no tools. Exact synthetic inputs, raw responses, selected IDs/quotes and final answers are retained locally in `.data/recall-reliability/live-before.json` and `live-after.json`; no real archive, headers or configuration is traced.

| Case / question pattern | Required facts and source | Traced baseline | Post-fix observation |
| --- | --- | --- | --- |
| What meeting did I tell you about? | User: Infosys meeting on 23 August | RECOVERED: exact quotation but model copied record.turnId into messageId. It was not a fabricated UUID; it was the wrong identity field. The old lexical check also rejected harmless "told" framing | PASS: correct user.id, grounded answer with company/date |
| Which database did I select for CedarLedger-tag? | User selected PostgreSQL for the named project | PASS: user.id and whole source sentence selected; project/database retained | PASS: same complete relationship |
| Which laptop brand did I buy for FieldKit-tag? | User purchased a Dell notebook for that project | FAIL: input and selected whole quotation contained the identifier, but answer was only "Dell". Token inclusion checked support, not completeness | RECOVERED: raw answer now included both facts, but "bought" was absent from the source's factual wording ("purchased"). References/quotes were valid; conservative grounding rejected the paraphrase and returned full originals |
| Who did I ask to review the deployment checklist for CedarRelease-tag? | User asked Priya to review that task for the named project | PASS: correct user.id and complete person/task/project relationship | PASS: same complete relationship |

None of these new runs had provider failures, timeouts, missing facts, truncated user evidence, incorrect question/answer pairing or additional search calls. Each used eight model calls: one fact acknowledgment and one recall call per pair. The post-fix four answers contain all required facts, with one explicitly labeled recovery. Receipt/restart verification passed in both runs.

The older cleanup result was 1 PASS / 2 RECOVERED / 1 FAIL; the earlier recovery snapshot was 2 PASS / 2 RECOVERED. Their per-case raw provider responses were not recorded, so the exact reasons for those historical recovered responses cannot be reconstructed. A separate earlier synthetic probe captured prose before otherwise valid JSON and correctly fell back. That observation cannot be assigned to a different historical request without evidence. Provider variability remains a limit of these small samples.

### Correction and alternatives

Prompt-only instructions cannot enforce completeness. Instead, named query locators and compound identifiers must remain in the answer and in selected supporting user evidence. Named entities in the same answer clause must be supported alongside that locator; merely taking words from different conversations does not establish their relationship. Matching is case-insensitive so lowercasing an answer cannot bypass that check. Existing date, ambiguity, negation, quotation and role checks remain in force. Incomplete synthesis recovers to full labeled originals; model-selected excerpts cannot conceal omitted associations.

The compact prompt now specifies copying records[].user.id or assistant.id and preserving requested relationships. It is 446 bytes against the cleanup prompt's 452, with original context-budget tests unchanged. "Told" is accepted as nonfactual narrative framing; evidence IDs, factual tokens and relationship checks are not relaxed. Internal decision categories make deterministic rejection reproducible without putting conversation text into operational logs or changing the public API.

Rejected alternatives: accepting turn IDs as message IDs would weaken identity checks; changing the benchmark would hide the failure; accepting arbitrary prose/JSON mixtures or unrestricted paraphrases would weaken grounding. Extra LLM judges/retries add cost and latency. Provider-specific structured-output changes were unnecessary for the confirmed association defect and would expand the adapter contract. Safe deterministic recovery remains legitimate behavior.

### Verification and remaining limits

`tests/recall-associations.test.ts` covers missing identifiers, correct complete answers, repeated entities, cross-conversation swaps, lowercase answers, original Q&A roles, date-specific retrieval, incomplete excerpts, unknown identifiers, ambiguity, turn/message identity confusion, conservative paraphrase recovery, and one-call/zero-search recovery. Seven initial generalized tests failed before the correction. Original tests and strict live evaluator criteria remain unchanged.

The final predefined live run was 3 PASS / 1 RECOVERED / 0 FAIL, exit 1. Its four saved responses replay identically through the final validator after the lowercase-association hardening; no additional provider run was made. A correct recovered answer is not relabeled as model synthesis. This supports functional correctness of the tested cases, not a four-of-four model-synthesis claim or general semantic accuracy.

The guard recognizes English capitalized names and compound identifiers; it is not arbitrary semantic relationship extraction. Correct paraphrases can still recover, and larger evidence sets may require a narrower query rather than truncated quotations. Local microbenchmark timings and the small live samples in the result file are observations, not a controlled performance improvement claim. Current research/comparison production paths were not changed; frozen mixed-comparison and search regressions remain the relevant checks.
