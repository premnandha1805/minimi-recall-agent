# Memory reliability audit and implementation

**Current review follow-up:** [Gate 2 review repairs](gate2-review-repairs.md)
supersedes the original matching, empty-topic, answer-rendering and measurement
descriptions below. The original report is retained as the audit history.

This work stays on `feat/gate-2-temporal-memory`. No branch creation, commit,
merge, push or deployment is part of this change. The current task's explicit
branch instructions override the older gate workflow in AGENTS.md.

## Confirmed root cause

Cross-conversation storage and retrieval were already implemented. The failure
was not simply a missing database or a conversationId-only lookup. Inspection of
the starting revision found these boundaries:

| Boundary | Finding and consequence |
| --- | --- |
| `src/server.ts:297`, `:309`, `:340` | Resolves the server-owned conversation, saves the user turn, then retrieves memory before calling the model. Recognized recall already scanned all conversations in the local root. Ordinary continuity loaded only the active conversation. Missed intent therefore bypassed cross-conversation retrieval. |
| `src/context.ts` (original lines 96–103, 186–250) | Recall detection covered only some English phrasings. Matching required every non-filler anchor inside one record. Date-free, anchorless recall returned no matches. Descriptive paraphrases, decisions split across turns and broad recall failed despite stored evidence. |
| `src/context.ts` (original lines 137–155) | Personal assertions used a list of first-person forms and subject nouns. Valid arbitrary declarative facts and relationships could be discarded. Questions and hypothetical statements correctly needed separate treatment. |
| `src/context.ts` (original lines 117–121) | Any `on`/`during` phrase could be mistaken for an unsupported date, including working on a project. |
| `src/dates.ts` (original lines 126–157) | Week/day resolution worked, including local weekdays and rollover. Calendar months and years were unsupported. |
| `src/context.ts` (original lines 234–255) | Only narrow forward reference patterns were retrieved. A statement about “this topic” could lose its preceding discussion. |
| `src/agent.ts:79` | The original answer checker validated some calendar assertions, not arbitrary names, decisions or personal facts. A plausible non-calendar model answer could pass without evidence. |
| `src/memory.ts:120`, `:176`, `:235` | Atomic file writes, server-winning merges and per-conversation queues already worked. List-then-load retrieval reread files and could observe several commit states. The new snapshot waits for queued operations and serializes the complete validated read against commits. |
| `public/app.js:1255`, `:1500`, `:1529`, `:1583` | The frontend already restored server history after refresh, kept only an active ID in localStorage, and acknowledged complete answers. Its 100-item outgoing history cap did not delete persisted history. Pending/partial assistants intentionally remain excluded from accepted context. |
| `src/memory-http.ts:33` | Local same-origin checks already existed. There is no authenticated multi-user service. A client-supplied user ID cannot establish ownership. |

The exact seminar incident transcript was not available. Its regression fixture
reconstructs the reported relationship failure, using an unrelated technology
topic. It is one of several distinct topics, not a special retrieval rule.

## Smallest design amendment

Retain Fastify, TypeScript, private per-conversation JSON, original messages,
receipts, the one external tool, and the existing API/SSE contracts. No new
dependencies, embeddings, external memory service or extra model calls.

Amend the earlier design's strict anchor matching and limited calendar parsing:

1. Recognize more grammatical recall forms and distinguish past comparisons from
   requests for current facts. Continue using the active history for ordinary chat.
2. Read a coherent snapshot of the local user's archive for recall. Wait for
   operations already queued at snapshot entry; subsequent commits cannot interleave
   the scan. A write that begins after snapshot entry belongs to a later view.
3. Filter original timestamps using the request's IANA timezone and retry reference.
   Normalize Unicode, apply modest English stemming, prefer complete term matches,
   then use majority overlap and inverse-document-frequency ranking. This is
   lexical retrieval, not general semantic understanding or a BM25 implementation.
4. Rank reference turns with their immediate antecedents. Include original adjacent
   references, shared-topic turns, corrections and decisions following a reference.
   Distinct conversations and competing events remain labeled; proximity does not
   prove a relationship. Original messages are never overwritten.
5. Select at most eight whole records, with the existing 32 KiB recall-context
   and model-context checks. More matches are explicitly disclosed. A full archive
   is never injected into a model prompt. Oversized essential records require a
   narrower question. Lookup terms and scanned records are bounded.
6. Pure recall uses a model-selected **extractive evidence contract**. Message IDs
   and complete-sentence excerpts are checked against exactly the projected history
   shown to the model. Unknown IDs, malformed JSON, invented quotations or ordinary
   generated prose fall back to labeled original messages. Every selected record
   remains represented; the model cannot silently omit another record's correction.
   Recognized corrections inside a message are also kept whole. Sent dates, roles
   and provenance come from storage, never the model.
7. Save the resulting answer using the existing attempt/receipt lifecycle. The
   frontend displays the unchanged result contract and restores it normally.

The extractive answer is intentionally more conservative and more verbose than
an unrestricted conversational paraphrase. It demonstrates what was actually
said without claiming that quoted assistant text is true. It is not a proof that
a selected record is relevant or that a quoted statement remains current.

## Temporal and web evidence

Last/this/next calendar weeks, months and years use local calendar boundaries,
including leap years and year rollover. Relative phrases in old messages are
resolved against their original timestamp and timezone. Named event dates without
a year remain yearless. Message sent dates, described event dates and source
publication/effective dates remain separate fields and are labeled accordingly.

Pure recall disables search. Current external questions retain `web_search`.
Mixed history/current requests receive the retrieved originals and the existing
bounded search loop. Existing change verification still requires comparable
historical/current evidence and uses Confirmed change / No confirmed change /
Cannot verify / Not comparable. Historical source IDs stay qualified; they never
enter the current search registry. Search limits remain two rounds, five initial
plus three additional requests, a 15-second search cutoff and a 25-second deadline.
General explanations may answer without search. This patch preserves the existing
final-answer SSE behavior; it does not introduce token-by-token model streaming.

## Identity, isolation and failure semantics

One private server data directory is **one local user's scope**. All browser
profiles/tabs reaching that instance belong to that same scope. Conversation IDs,
client idempotency keys and browser storage are not authorization. Tests reject
client-supplied user IDs and nonlocal/cross-origin HTTP access. Separate private
roots are isolated, including lookups using another root's conversation ID.

This is not isolation between hostile OS users sharing the same local port.
For separate people, use separate OS accounts/private roots and protected local
instances; do not share an instance as a multi-user service. Authenticated shared
hosting requires a separate authorization design and remains outside the frozen
architecture. Imported history is labeled unverified; it is not authenticated
proof of another person's statements.

Selected historical messages are sent to the configured model API for synthesis;
local persistence does not mean inference is local. Missing legacy/imported IANA
timezones are explicitly marked assumed. The existing history input preserves
UTC instants but cannot reconstruct an original IANA zone from an offset alone.

Corrupt or unreadable storage rejects retrieval; it never produces `not_found`.
HTTP retains the existing explicit error response/SSE error. `not_found` means a
completed lookup found no suitable record, not proof that no prior conversation
ever existed. Cancellation and the inherited request deadline wrap retrieval.
There is no persistent derived index to become stale after a successful write.
The store remains single-process and bounded to 100 conversations / 64 MiB total.

## Changed files

| File | Purpose |
| --- | --- |
| `src/memory.ts` | Queue-aware, commit-consistent snapshot of the private root. |
| `src/memory-ranking.ts` | General morphological normalization and lexical scoring. |
| `src/context.ts` | Intent, date/topic separation, snapshot retrieval, neighboring evidence, bounded context and relative-time hints. |
| `src/dates.ts` | Calendar month/year/week ranges. |
| `src/recall-answer.ts` | Evidence validation and rendering with authoritative provenance. |
| `src/agent.ts` | Connects the recall renderer and discloses limited coverage. |
| `src/prompts.ts` | Extractive recall contract and evidence/routing instructions. |
| `tests/fixtures/universal-memory.ts` | Diverse frozen histories and expected conversation identities. |
| `tests/universal-memory.test.ts` | Retrieval, grounding, persistence, HTTP, failure and isolation checks. |
| `tests/context.test.ts`, `tests/dates.test.ts`, `tests/adversarial-eval.test.ts` | Update superseded expectations while retaining evidence, event-year and citation assertions. |
| `scripts/evaluate-memory.mjs`, `package.json` | Reproducible offline memory evaluation command. |
| `docs/memory-evaluation.json` | Actual measured fixture results; no live metrics. |
| `DESIGN.md`, `README.md`, `docs/memory.md`, this report | Final design decision, privacy model, workflow, limits and verification record. |

The pre-existing modified `docs/evaluation-results.json` and untracked `frontend/`
were left untouched by this task. No frontend implementation changes were needed.

## Evaluation coverage and interpretation

The new suite complements the existing 23-file suite:

| Requested categories | Evidence |
| --- | --- |
| A–E: same/new conversation, refresh, restart, immediate visibility | New continuity, snapshot/restart and HTTP tests; existing `ui-memory` restoration and receipt tests. |
| F–K: dates, paraphrases, pronouns, competing events, corrections, lists | Calendar-range tests, diverse frozen retrieval cases, exact entity-list/provenance checks, existing adversarial follow-up tests. |
| L: memory plus web change detection | Existing frozen `evaluation`, `verification`, `context` and adversarial scenarios run in the full suite. |
| M–O: missing history, failures, isolation | Unknown-topic fixture, malformed model output, corrupt disk, rejected snapshot, separate-root and HTTP origin tests. |
| P–S: long history, continuity, ambiguity, concurrency | 150-message import, multi-turn context, tied matches, simultaneous queued writes and existing storage/context tests. |
| T: regression | Complete test suite, including search budgets, cancellation, citations, SSE and browser tests. |

Run `npm.cmd run eval:memory` to regenerate the dedicated JSON report. Its ten
fixed queries measure conversation retrieval coverage and unrelated matches.
Grounding checks inject a fabricated answer and verify it cannot reach output.
The HTTP measurement includes local disk/HTTP injection with a mocked model.
These numbers do not measure real model reasoning accuracy, semantic recall on
unseen language, live search latency, or production p95 behavior. The report's
p50/p95 are descriptive order statistics of only ten synthetic queries.

## Actual verification results

On this Windows checkout, the final run produced:

```text
npm.cmd run typecheck
  typecheck:server: passed
  typecheck:browser: passed

npm.cmd test
  Test Files  24 passed (24)
  Tests       827 passed | 1 skipped (828)
  Duration    24.92s

npm.cmd run eval:memory
  Test Files  1 passed (1)
  Tests       39 passed (39)
  Duration    5.40s
```

The dedicated ten-query evaluation retrieved all 10 expected conversation
matches, with 0 unrelated conversation matches. All 10 injected fabricated-answer
checks were blocked. Retrieval p50 was **4.99 ms**, p95 **130.79 ms**; the single
mocked HTTP run was **322.76 ms**. These are the actual observations in
`memory-evaluation.json`, including cold initialization, not a production latency
claim or an estimate of real-model hallucination rate.

`git diff --check` passed. The existing provider-free browser restoration,
receipt, SSE, cancellation, search-budget, comparison and citation tests passed
in the full suite. Initial failed assertions and discovered defects were fixed;
the final suite has no failing tests. One pre-existing test remains skipped.

`npm.cmd run dev` initially hit the sandbox's Windows account lookup failure.
The permitted outside-sandbox retry found port 3000 already occupied by a Recall
instance. Running this checkout on port **3107** succeeded; real HTTP `GET /health`
returned `ok` and `GET /` returned **200**. That test server was stopped; the
pre-existing port-3000 instance was left running. No fresh dependency install or
clean-checkout test was performed in this task.

Azure and Tavily credentials were detected without printing their values. Live
model/search calls were **not run**: free quota and paid-overage status were not
confirmed. The quota question follows AGENTS.md's instruction to never assume
free/student quota. No live latency, live recall quality or paid usage is claimed.

The independent final diff review checked storage consistency, model-output
boundaries, source-ID isolation, event-year handling, changed test expectations,
privacy scope and unrelated files. It caught and added a regression for a named
yearless event receiving an inferred year in context metadata; only relative
expressions now receive date hints. It also checked the same-message correction
case so excerpt selection cannot discard a recognized update.

## Remaining limitations and next step

English lexical rules can miss synonyms with no shared stems, multilingual text,
distant implicit references and unusual intent wording. Neighbors can include
irrelevant context. Selection is bounded and may require narrowing. The extractive
answer is grounded but less natural than free-form synthesis. Mixed research prose
still relies on the model outside the existing deterministic calendar/change and
citation checks; there is no general factual verifier. Partial/unreceipted assistant
answers remain stored but intentionally excluded from accepted assistant context.

Next: after confirming free quota and no paid overages, run a small live test using
synthetic private histories, then add unseen paraphrases to the frozen evaluation.
Do not infer live quality from scripted outputs. No gate completion, clean-install
claim, multi-user hosting claim or deployment claim is made by this work.
