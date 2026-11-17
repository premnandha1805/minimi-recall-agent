# Gate 2 independent-review repair results

Work remains on `feat/gate-2-temporal-memory`. No branch operations, commits,
pushes, merge or deployment. No provider requests or new dependencies.

## Reproduction and decisions

`tests/memory-review.test.ts` initially ran 11 cases: **6 failed, 5 passed**.
The final expanded file has 25 passing cases. The failures were reproduced before
the corresponding fixes; suggestions were not treated as established facts.

| Finding | Reproduced mechanism | Change |
| --- | --- | --- |
| P0-1 intent | All five supplied routing examples already passed. Personal intent was not exclusively a noun whitelist. Schedule-specific fallbacks and incomplete grammar still existed; arbitrary fact retrieval additionally missed buy/bought. | Added a topic-independent first-person past-question rule and general verb equivalences. Existing possessive interrogatives already cover arbitrary nouns. Retained device exclusions and calendar-specific routing distinctions; mixed requests keep research enabled. |
| P0-2 mixed history | `You chose MongoDB.` survived unchanged despite only PostgreSQL in memory. The old mixed checker required an event word. | Added general personal/historical sentence checking against original user sentences, with controlled grammatical perspective/list formatting changes. Current citations cannot authorize historical claims. Unsupported historical sentences fall back to bounded evidence, while separate public/reasoning sentences survive. Calendar clauses retain the stricter existing checks. Assistant claims cannot establish private user facts. |
| P0-3 output size | Direct renderer returned 45,637 characters from three long messages. An SSE crash was **not** reproduced: `runAgent.finish` already imposed the public 16,000-character bound. | Added the same bound to the evidence renderer and mixed renderer. Complete validated short evidence can answer concisely; otherwise narrowing replaces oversized output. An actual mocked-provider HTTP/SSE test verifies a bounded persisted result, no stream error, and matching saved text. |
| P1-1 empty anchors | Ranker returned `[1,1]` for empty topics; a vague decision question selected unrelated history. | Empty lexical queries score zero. Retrieval explicitly distinguishes chronological/broad-history modes from unknown topics. Vague queries return ambiguity with no selected records; dated questions still retrieve history. Storage failures/deadlines remain observable before clarification. |
| P1-2 suppression | An all-term overview forced a relevant partial decision's score to zero. | Score eligibility independently with at-least-half term coverage and inverse-frequency weighting. Preserve named query anchors to exclude competing entities. This retains partial decision records without accepting another named project's decision. No exact match globally vetoes other records. |
| P1-3 natural answers | A validated `I chose PostgreSQL.` produced an entire transcript. | One unambiguous validated first-person assertion can render `You chose PostgreSQL.` with its stored message ID. Original evidence remains authoritative. Explicit transcripts retain original wording; multiple events/corrections remain conservative evidence views. |
| P1-4 design | AGENTS.md's Gate 6 explicitly requires a one-page DESIGN.md. It specifies no word count. | Condensed the design into a compact architectural overview; this report and existing supporting docs retain details. Corrected the implication that zero searches eliminate model API cost. Markdown pagination depends on the renderer. |

The earlier repair's `Recall our options/pricing information/tools => found`
expectation represented the confirmed empty-anchor bug. That expectation now
asserts **ambiguous and no records**, rather than accepting arbitrary history.
No `not_found` expectation was changed to `found`. The browser restoration test
now expects the natural perspective change and authoritative stored message label;
its restart, receipt, privacy and persistence assertions remain intact.

## Additional coverage

The tests cover arbitrary pets, hotel selection, learning, purchase locations,
dates, names, prices, chosen technologies, a misleading exact overview, partial
decisions, empty topics, chronological questions, explicit transcripts, long
originals, current citations attached to fabricated history, mixed ordinary
reasoning, named corrections across conversations and reference chains beyond
one neighboring turn. Existing tests cover retries, atomic/concurrent writes,
storage errors, private-root isolation, same-origin guards, API validation,
SSE terminal frames, source IDs, search budgets and deadlines.

The new extended chain fixture exposed and fixed the buy/bought normalization
gap and overly strict partial-overlap threshold. Neighbors continue to expand
through related turns, rather than loading every message indiscriminately.
An entity-free correction in a different conversation cannot safely inherit a
subject from proximity alone; it remains ambiguous or unretrieved.

## Verification

Commands used the Windows `.cmd` launcher because PowerShell execution policy
blocks `npm.ps1`. No policy was changed.

```text
npm.cmd run typecheck
  server: passed
  browser: passed

npm.cmd test
  Test Files 25 passed (25)
  Tests      852 passed | 1 skipped (853)
  Duration   19.39s

npm.cmd run eval:memory
  Test Files 1 passed (1)
  Tests      39 passed (39)
  Duration   1.73s

git diff --check
  passed
```

The regenerated `memory-evaluation.json` records ten frozen queries, ten expected
conversation matches recovered, zero unrelated conversation matches and all ten
injected fabricated-answer cases blocked. Retrieval p50/p95: **1.88/37.73 ms**;
one mocked HTTP measurement: **125.76 ms**. The dedicated review test file is also
included in `npm test`; it is separate from the original ten-query metric sample.
These are actual deterministic observations, not general recall accuracy,
hallucination rates or live latency. No Azure/Tavily quota was consumed.

## Files modified by this review repair

- `src/context.ts`: linguistic intent, empty-topic modes, general verb equivalences,
  independent ranking integration and named-entity constraints.
- `src/memory-ranking.ts`: independent scores and empty-anchor behavior.
- `src/recall-answer.ts`: concise validated assertions, general mixed prose guard,
  original-user-only historical support and direct renderer bounds.
- `src/agent.ts`: ambiguity response and mixed/single-fact renderer wiring.
- `src/prompts.ts`: compact evidence contract and separate historical/public prose.
- `tests/memory-review.test.ts`: 25 reproduction/regression/integration cases.
- `tests/context.test.ts`: correct the confirmed arbitrary-memory expectation.
- `tests/universal-memory.test.ts`: natural answer and provenance assertion.
- `docs/memory-evaluation.json`: regenerated observed measurements.
- `DESIGN.md`: compact design, cost clarification and measured evaluation.
- `docs/memory-reliability.md`: points readers to this superseding review record.
- This report: reproduction, decisions, results and remaining limits.

All other pre-existing dirty files, including `frontend/` and
`docs/evaluation-results.json`, were preserved. The storage schema, public API,
search contract, external tools and privacy model are unchanged.

## Remaining limits and recommendation

**GO for continued local Gate 2 development; NO-GO for claiming the stated
universal-memory success criteria are fully satisfied.**

The fixed reproductions and regression suite pass. However, linguistic detection
of historical prose cannot guarantee catching every unmarked implicit historical
claim (for example a bare fragment with no personal or historical framing).
Nor can lexical ranking recover arbitrary synonyms without shared terms or
context. Name capitalization is a retrieval heuristic, not entity recognition.
The current mixed-answer guard is conservative: legitimate paraphrases or
second-person advice may fall back to evidence. Exact sentence matching does not
prove full semantic support, and the existing calendar validator remains limited.

Natural synthesis is deliberately restricted to validated single assertions;
multi-record chronology and malformed model evidence can still yield evidence
views. This is safer than accepting unrestricted historical paraphrases but does
not meet a demand for consistently natural synthesis of every historical pattern.

Local single-user scope is unchanged: everyone reaching one local instance shares
its private root. Conversation IDs are not authorization. Selected memory is sent
to the configured model provider. Pure recall can use model tokens even with
zero web searches. No live-provider quality or clean-install claim is made here.

Next: extend the frozen adversarial corpus with unmarked historical fragments
and unseen paraphrases, then evaluate a typed historical/public answer format
with evidence for each historical claim. Any broader semantic verification needs
its own measured quality and latency justification; passing these fixtures alone
does not justify a universal grounding guarantee.
