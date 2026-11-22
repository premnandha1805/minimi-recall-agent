# Verification and evaluation

## Commands and provenance

| Command | What it checks | Output / cost |
| --- | --- | --- |
| `npm run typecheck` | Strict server/scripts/tests TypeScript, unused declarations, and checked browser JS | No API calls |
| `npm run lint` | Conflict markers and NUL bytes | Small hygiene check, not a security/style analyzer |
| `npm test` | Unit, Fastify HTTP, DOM, regression and frozen-evaluation assertions | Temporary isolated storage; no providers |
| `npm run eval:offline` | 31 frozen application cases plus ten existing memory-fixture policy comparisons | `.data/evaluations/evaluation-results.json` and `search-baseline.json`; no providers |
| `npm run eval:memory` | Ten frozen retrieval/grounding scenarios plus related regressions | `.data/evaluations/memory-evaluation.json`; mocked model |
| `npm run audit:history` | Every branch's reachable history plus remote/reflog objects; project-local key matching and credential/private-file patterns | `.data/audits/publication.json`; no upload |
| `npm run smoke:tavily -- --live` | One basic real Tavily query | Consumes configured quota; safe metadata only |
| `npm run test:live -- --live --runs=1 --research` | Real Azure cross-conversation recall, optional cited research/streaming, receipts and archive reopening after server restart | Own loopback server and new `.data/live-tests/<uuid>/` archive; report in `.data/evaluations/` |

Live tests do not write the real conversation archive. No keys are copied into test checkouts. Without --live, the live harness exits without making requests. Check quota before opting in. It uses one four-pair recall run by default; --runs accepts 1–10. Research is separately enabled by --research. Previous LIVE_URL-based testing of an arbitrary running archive has been replaced with an owned isolated server.

## What frozen results mean

The offline evaluation uses real Fastify admission, JSON persistence/restart, history/date selection, provider-response parsing, bounded orchestration, verification, SSE encoding and browser stream validation. The network boundary returns fixed synthetic data. Cancellation/deadline fixtures also use virtual time. Synthetic prices are not current vendor facts.

The recorded recovery evaluation has **31/31 structural/safety checks** and **30/31 usefulness checks**. C8 withholds trust for fictional `acme.example`, which is outside the reviewed official-domain list. This conservative abstention remains visible; safety pass is not advertised as a universal correctness score. A scripted cooperative model in a prompt-injection fixture does not establish resistance to arbitrary live prompt injection.

Memory measurements cover ten frozen scenarios using a mocked model and a synthetic archive. A separate regression exercises 500 committed conversations. Do not describe the ten-scenario P50/P95 as a 500-conversation latency benchmark. Wall times depend on hardware, filesystem, process load and JIT state. No exact-tokenizer claim is made.

The offline baseline now compares the agent against an **always-attempt-search policy** on the ten existing synthetic memory fixtures. Both use the same archive, scripted model, expected conversation IDs, grounding criterion, context, privacy restrictions, and search budgets. The baseline prefetches through the real SearchSession with frozen network results and supplies that session/evidence to the same agent. It is not a dummy counted request discarded before execution.

Observed: both policies grounded 10/10 cases and used nine scripted model calls. The agent made zero search requests. The baseline attempted ten queries; eight reached the mocked provider and two were blocked by unchanged privacy rules. This is a narrow policy ablation, not an end-to-end comparison across all 31 application cases, a live quality study, a latency claim, or proof of general superiority. Real public research still needs search. There is no general live-model factual-accuracy score.

## Live acceptance

The harness distinguishes:

- PASS: complete, validated model-origin recall contains the expected facts and uses another conversation.
- RECOVERED: the answer contains grounded saved evidence but uses the deterministic fallback; not model PASS.
- FAIL: missing/incorrect/partial output, protocol or request failure.

It sends browser-style receipts for complete answers, closes its server, reopens the same isolated archive, and checks an accepted answer survived. Optional research requires registered citation markers, sources, and visible SSE deltas. This validates transport/registration, not full semantic claim support. First-token report fields measure the first **visible SSE delta**, which can follow recall validation; they are not upstream provider timings. A nonzero exit must not be reported as an all-model pass.

## Retained snapshots

These files were relocated without changing their contents. Embedded paths describe the original runs, not necessarily today's layout.

| Snapshot | Scope / interpretation |
| --- | --- |
| [evaluation-results.json](results/evaluation-results.json), [memory-evaluation.json](results/memory-evaluation.json) | Historical release fixtures and local timings committed before cleanup |
| [live-e2e-results.json](results/live-e2e-results.json) | Older reported 12/12 recall run, before the stricter model-origin acceptance gate; not directly comparable with the newer gate |
| [recovery-audit.json](results/recovery-audit.json) | Branch audit, fixes and limitations from recovery commit 63237c0 |
| [recovery-evaluation-results.json](results/recovery-evaluation-results.json), [recovery-memory-results.json](results/recovery-memory-results.json) | Recovery frozen observations, not current promises |
| [recovery-live-results.json](results/recovery-live-results.json) | Strict harness: 2 model PASS, 2 RECOVERED; exit 1 |
| [recovery-http-results.json](results/recovery-http-results.json) | Real cited research/streaming, persistence, receipt and idempotent replay |
| [recovery-clean-results.json](results/recovery-clean-results.json) | Clean restart/date recall; original price omission retained alongside its passing recheck |

Current cleanup results, including the non-passing live gate, are in [cleanup-verification.json](results/cleanup-verification.json).

The later [recall reliability review](verification.md#recall-reliability-review) and [results](results/recall-reliability.json) preserve both predefined live runs: before 2 PASS / 1 RECOVERED / 1 FAIL; after 3 PASS / 1 RECOVERED / 0 FAIL. The strict harness remains unchanged and exits 1 because recovery is not model-synthesis PASS. All four post-fix answers contain the required facts. Full input/response traces are generated only for the harness's isolated synthetic archive and remain ignored locally; configuration, headers and raw provider errors are never traced.

The earlier repair diaries remain accessible through Git links in [ENGINEERING_JOURNEY.md](ENGINEERING_JOURNEY.md). They are not copied into current operating instructions. The recovery audit recorded 982 passing tests and one Windows symlink-permission skip; newer runs must report their own counts. Browser automation was blocked by the host's URL-policy check in that audit. HTTP/SSE and DOM testing are distinguished from manual visual verification.

## Reproduce a clean environment

Use a fresh checkout or an isolated snapshot of the candidate source, without copying node_modules, .env, private storage, or local design exports. Run `npm ci` (or the required evaluator path `npm install`), typecheck, lint, tests, then `npm run dev`. Confirm health and credential-free conversation routes. Live acceptance requires valid configuration supplied locally; never commit credentials to make a checkout pass.
