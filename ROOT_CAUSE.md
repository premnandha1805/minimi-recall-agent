# Live memory incident — 18 November 2026

## Phase 0: instrument before changing logic

Baseline: 867 tests passed, 1 skipped (the merged 852 plus existing uncommitted
provider diagnostic tests). Branch: `fix/live-memory-recall`. Existing user edits
and the untracked frontend were preserved. `npm run dev` was run on port 3000.
The real Azure deployment and the real `.recall-data` archive were used; no keys,
deployments, billing or quota settings were changed.

Browser automation was blocked by the computer-use host because it could not
determine Chrome's current URL. Reproduction therefore used the actual HTTP/SSE
endpoint, not an injected/fake provider. Browser UI verification remains separate.

Raw structured logs are local `live-memory.log` (ignored, containing bounded private
history previews). Evidence below uses only the synthetic requested fact.

| Hypothesis | Finding before fixes | Correlated log evidence |
| --- | --- | --- |
| H1: persisted only after model success | False | `6d790dcc-8a94-455f-b6c9-61dc06e72149`: `user_message_persisted` at 863.81 ms, 14 conversations / 33 messages, then model failure at 770.82 ms of model time. The Infosys statement remained on disk and in the next retrieval. |
| H2: writes restart watcher / different path or processes | Not reproduced | PID 10956 handled all four requests and all their writes. Startup and writes used `D:\Minimi Recall Agent\.recall-data`, cwd `D:\Minimi Recall Agent`. No second server could bind the port. Watch ignores still need making explicit. The tool daemon interruption is not evidence of a tsx restart. |
| H3: retrieval excludes too much | True | `dad3b132-c116-4bd1-b4a1-17726bc97a27`: 17 conversations persisted, but retrieval scanned 0 other conversations, returned 0 records. Non-recall queries load only the active conversation. |
| H4: intent too narrow | True | Same request, “Do I have anything planned?”: `recall_intent.detected=false`. “Do I have any meeting coming up?” scanned 15 conversations / 20 messages but returned no hits: `coming up` polluted the majority-overlap terms. |
| H5: empty context produces false missing-history answer | True behavior; prompt already forbids literal “never told me” | Same request supplied 4,140 characters / estimated 1,035 tokens, no archive records; model answered “retrieved history shows not_found and no matching records” despite saved evidence. No scanned-conversation count was supplied. |
| H6: sequential classifier / validator calls or excessive timeout | No LLM classifier or validator exists. 10 s per-call timeout and lack of fallback are defects; observed failures were earlier | `8aa6d5c6-20e7-495f-9a46-032d09a6a416`: exactly one model call, HTTP 400 after 912.31 ms, despite 4 hits including Infosys; context 21,564 characters / estimated 5,391 tokens. First request had NETWORK_ERROR / ECONNRESET after 773.30 ms. These were not model timeouts. |
| H7: yearless date rejected | False for this failure | The above 4 retrieved hits include the exact “I have an Infosys meeting on 23 August.” Evidence survives; yearless dates are conservatively retained, not filtered out. Event-date hints need an explicit interpretation. |
| H8: unflushed write/read race | False in reproduction | `addTurn` awaits atomic rename; snapshot awaits queued writes. The very next request retrieved the failed preceding statement. Snapshot reparses every file on each request, adding 92–199 ms in these live traces. |

Additional root cause **confirmed**: HTTP 400 specifically on recall, whose adapter
sends `tool_choice: none` without `tools`. `scripts/diagnose-model.ts` made two
controlled real requests: with that field → HTTP 400 in 919 ms, param `tool_choice`,
error mentioned tools; omitting it → HTTP 200 in 1,932 ms with a completion.

## Fixes and final verification

### What changed

- **H1/H8 safeguards:** `addTurn` is awaited and the queue explicitly flushed
  before provider/search work. Assistant failures now have their own ISO-stamped
  message with `status: error`, separate from accepted answers. Retry identity is
  unchanged. A retry race was also fixed: the conversation execution lock is
  released before ending SSE, after the durable terminal write.
- **H2 safeguards:** the default is now `<project>/.data/conversations`, independent
  of the launching working directory. `MEMORY_DIRECTORY` is the single configured
  source; relative values resolve against the project root. The previous archive
  is copied once when the new default does not exist; originals remain intact.
  `tsx watch` explicitly ignores both data directories. Startup logs the absolute
  path. A read-only Windows check found exactly one listener on `127.0.0.1:3000`.
- **H3/H4:** every HTTP request scans a validated committed archive snapshot.
  Intent controls answering and evidence volume, never archive access. Runtime
  normalization includes stemming, punctuation/case normalization, aliases,
  dated/named-record boosts, identifier constraints and recency. Generic personal
  questions return recent user statements. Ordinary continuity keeps the active
  conversation alongside bounded archive snippets.
- **H5:** context includes actual scan counts and explicit empty/found modes.
  An empty search is never proof that something was never said. At zero earlier
  conversations, the response says there is no saved history yet. Relevant history
  includes dates, titles and neighboring messages; the recall block is capped near
  10,000 bytes (roughly 2,500 estimated tokens), with omissions disclosed.
- **H6 and the confirmed HTTP 400:** production now uses pinned `ai@7.0.176` and
  `@ai-sdk/openai@4.0.121` through the existing model interface. Disabled tools omit
  `tool_choice`; trusted system text uses SDK 7's `instructions` option. Source and
  SDK docs were inspected locally. `streamText` uses `isStepCount(1)` and disables
  SDK retries; the application owns search limits and a single transient retry.
  Normal recall makes one answer call, without any LLM classifier/validator.
  Timeouts/5xx allow one shorter-context retry inside the unchanged 25 s overall
  budget. A 15 s first-token timer ends when meaningful output arrives; streaming
  can continue within the overall deadline. Time is reserved for grounded output
  and atomic persistence. SSE drafts are plain text, then replaced by the validated
  final answer. Raw provider errors never become fallback prose.
- **H7 safeguard:** yearless event mentions receive an explicitly inferred nearest
  occurrence relative to the original ISO timestamp and timezone. Original wording
  remains authoritative; this never proves an event is upcoming. Conversation-date
  lookups retain their most-recent-past rule and strict weekday behavior.
- **Storage:** the production snapshot updates only after successful atomic rename;
  reads await pending writes. Startup validates files once. Small files allocate
  their admitted size rather than 4 MiB per read. Malformed/empty files are retained
  as private `.corrupt` backups and recovered from a validated previous revision
  when available. Unsupported schemas/identity mismatches still fail closed.
- **UI:** New chat preserves the archive, memory use is disclosed, drafts arrive
  during generation, and failed requests retain a clear retry action. Error messages
  remain excluded from factual assistant history.

The original JSON adapter remains available for callers using its injectable
completion transport. Existing frozen HTTP fixtures continue to exercise that
boundary; new SDK-stream tests validate the production wire format, and new
Fastify tests inject normal, stuck and throwing model implementations. No existing
test was changed, removed or weakened.

### Further issues caught during repair

An early streaming pilot exposed two adapter mistakes introduced during this
repair: an incorrect base URL suffix, then SDK 7 rejecting system-role messages
inside `messages`. The SDK regression now includes trusted system instructions and
asserts the exact configured endpoint, streaming chunks and absent tool fields.
The initial pilot also showed `Who did I ask…` being missed and `I asked Priya…`
being mistaken for a recall question; runtime routing now distinguishes both.
These are repair findings, not claims about the original merged implementation.

### Measured verification

```text
npm.cmd test
  Test Files 29 passed (29)
  Tests      892 passed | 1 skipped (893)
  Duration   35.31s
npm.cmd run typecheck
  server passed; browser passed
npm.cmd run lint
  0 errors (dependency-free conflict-marker/NUL hygiene check)
```

The original 852 tests are retained; the initial working tree already contained
15 additional provider diagnostic tests. This repair adds 25 tests. The single
skip is the existing Windows symlink-permission test. Lint is intentionally a
small hygiene check; semantic checking is the strict TypeScript compiler.

The 500-conversation on-disk fixture uses the production committed snapshot.
After startup/JIT warmup, five complete retrieval calls measured **24.49, 16.56,
19.03, 14.58, 15.17 ms**; all stayed below the 50 ms assertion. Startup I/O is not
included in those lookup timings. This is a synthetic local measurement, not a
guarantee for arbitrary disk sizes, hardware or concurrent workloads.

`node --import tsx scripts/live-e2e.ts --runs=3` was run against the actual dev
server, configured Azure deployment and real `.data/conversations` archive.
**12/12 fact pairs passed across three consecutive runs.** All 12 recall responses
received provider tokens and used no deterministic model-failure fallback. The
machine-readable report includes per-request IDs and first-token timings:
[live-e2e-results.json](docs/live-e2e-results.json). Each pair creates two new
conversations, waits for complete SSE, and checks the requested names/date/facts.
Project/task identifiers vary per run to prevent old fixtures from satisfying a
new query accidentally. No billing or account settings were changed.

Final real output (total latency includes both chats and conversation creation):

| Fact pair | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Infosys / 23 August | PASS 2,878 ms | PASS 3,062 ms | PASS 2,875 ms |
| Project / PostgreSQL | PASS 2,491 ms | PASS 2,365 ms | PASS 3,801 ms |
| Notebook / Dell | PASS 3,186 ms | PASS 3,327 ms | PASS 2,499 ms |
| Priya / deployment checklist | PASS 3,341 ms | PASS 3,287 ms | PASS 3,244 ms |

```text
12/12 pairs passed; 3 consecutive runs PASS.
```

Recall first-token times were 734–1,456 ms. All recall calls used one model call
and zero searches. One initial fact-statement request had a provider failure
without a usable status and returned saved evidence instead; its response was
grounded, not an error. The live report's null initial first-token field makes
that limitation visible; it is not counted as successful provider generation.

A clean `git archive` checkout of runtime commit `4117618` also passed:

```text
npm.cmd ci --no-audit --no-fund
  added 109 packages in 30s
npm.cmd install --no-audit --no-fund
  up to date in 3s
npm.cmd run dev
  tsx watch --ignore ./.data/** --ignore ./.recall-data/** src/index.ts
  Server listening at http://127.0.0.1:3011
GET /health
  {"status":"ok","service":"minimi-recall-agent","version":"1.0.0",...}
```

That clean startup used an isolated archive and startup-only default provider
configuration; live chat/provider verification above used the original configured
server. The clean smoke server was stopped afterward. No credentials were copied
into the clean checkout.

Raw logs remain local in ignored `live-memory.log` / `live-memory-debug.log`.
`DEBUG_MEMORY=1` enables requested 80-character excerpts; by default operational
logs retain counts, scores and canonical conversation IDs without raw history.
The debug endpoint remains loopback/same-origin protected and is disabled in
production unless `DEBUG_MEMORY=1`.

Browser automation could not determine Chrome's URL and stopped for policy
enforcement. Real HTTP/SSE verification and the existing browser DOM tests passed;
manual visual verification in Chrome is not claimed.
