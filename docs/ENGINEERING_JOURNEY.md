# Engineering journey and review evidence

This account follows Git ancestry, source diffs, fixtures, and recorded results. Dates are commit author dates in +05:30, not reconstructed work-session times. Work began on 12 November 2026. The four-day constraint in the original brief is a planning constraint, not evidence that this recorded history finished in four days.

Current `main` is published at commit `d3b4029`. The repository contains 18 publicly published branches on GitHub, capturing genuine incremental feature milestones, root-cause debugging, regression recovery, and interface refinement. No original branch or commit has been rewritten.

## Chronological roadmap

Verification below identifies evidence introduced or present in the cited revision. It does not claim today's dependencies were run against every historical branch.

| Date / phase | Original branch | Problem and implementation | Verification / dependency | Evidence |
| --- | --- | --- | --- | --- |
| 12 Nov: foundation | `feature/project-setup` | Small Node/TypeScript project without extra services | Package scripts/compiler setup; prerequisite for later code | [6901ef3](https://github.com/premnandha1805/minimi-recall-agent/commit/6901ef3) |
| 12 Nov: HTTP | `feature/chat-api` | Validate requests, cap bodies, expose health, sanitize errors | Configuration/server contract tests | [8b22394](https://github.com/premnandha1805/minimi-recall-agent/commit/8b22394) |
| 12–13 Nov: interface | `feature/chat-ui`, `fix/chat-ui-usability` | Plain HTML/CSS/JS interface; repair scrolling, focus, and stream indicators | DOM interaction and layout tests; depends on HTTP | [14f6460](https://github.com/premnandha1805/minimi-recall-agent/commit/14f6460), [bb6bb07](https://github.com/premnandha1805/minimi-recall-agent/commit/bb6bb07) |
| 13 Nov: agent | `feature/agent-core` | Separate provider completion from bounded agent orchestration and one external tool | Scripted provider, malformed-output and budget tests | [86cf0a3](https://github.com/premnandha1805/minimi-recall-agent/commit/86cf0a3) |
| 14 Nov: search | `feature/web-search` | Adapt real Tavily text/dates; enforce query/concurrency limits | Adapter fixtures and opt-in smoke utility | [32a90bd](https://github.com/premnandha1805/minimi-recall-agent/commit/32a90bd) |
| 14 Nov: integration | `feature/live-chat-integration` | Connect agent to SSE and browser delivery | HTTP/SSE framing and transport tests | [3466bc6](https://github.com/premnandha1805/minimi-recall-agent/commit/3466bc6) |
| 14–15 Nov: observation | `feature/latency-observability` | Measure stages; stabilize source IDs, formatting, reader state and retry order | Observability/source-integrity/UI regressions | [06d96bc](https://github.com/premnandha1805/minimi-recall-agent/commit/06d96bc), [5bc979a](https://github.com/premnandha1805/minimi-recall-agent/commit/5bc979a) |
| 15–17 Nov: memory | `feat/gate-2-temporal-memory` | Durable originals, server-winning seeds, dates, restoration and archive retrieval | Queue/restart, boundary-date, receipt and frozen-evaluation tests | [722623c](https://github.com/premnandha1805/minimi-recall-agent/commit/722623c), [850e082](https://github.com/premnandha1805/minimi-recall-agent/commit/850e082), [694c04b](https://github.com/premnandha1805/minimi-recall-agent/commit/694c04b) |
| 18–19 Nov: recall incident | `fix/live-memory-recall` | Scan committed archive on every request; retain active context; add SDK streaming and stronger grounding | Real HTTP reproduction, wire fixtures, 500-conversation regression, origin-metadata tests | [504f2c9](https://github.com/premnandha1805/minimi-recall-agent/commit/504f2c9), [63c353a](https://github.com/premnandha1805/minimi-recall-agent/commit/63c353a), [980371b](https://github.com/premnandha1805/minimi-recall-agent/commit/980371b) |
| 20 Nov: comparison | `feat/gate-3-change-verification` | Combine historical recall/current evidence with four constrained verdicts | Price/feature grammar and untrusted-baseline tests | [4e90b26](https://github.com/premnandha1805/minimi-recall-agent/commit/4e90b26) |
| 20 Nov: tool correction | `fix/live-tool-call-schema` | Normalize supported query shapes; preserve hard budgets | Tool-schema, repeated-call and fallback tests | [56e96e5](https://github.com/premnandha1805/minimi-recall-agent/commit/56e96e5) |
| 20 Nov: Q&A correction | `fix/historical-qa-pairing` | Keep recorded assistant answer beside its original question | Seeded-history/mixed-verification regressions | [9eae1b0](https://github.com/premnandha1805/minimi-recall-agent/commit/9eae1b0) |
| 20 Nov: coverage correction | `fix/five-crm-coverage` | Group vendors without duplicate or missing requested products | Five-CRM and mixed-verdict fixtures | [73ccb78](https://github.com/premnandha1805/minimi-recall-agent/commit/73ccb78) |
| 20 Nov: initial freeze | `release/final-submission` | Initial hiring challenge submission freeze; capture startup instructions and measured evidence | Dated results, with documented limitations | [3fb0148](https://github.com/premnandha1805/minimi-recall-agent/commit/3fb0148) |
| 22 Nov: recovery & cleanup | `fix/main-regression-recovery` | Recover omitted local fixes, project-root env lookup, rejected-save labels, strict recall association and completeness | 1,033 tests passed/one skip; 3 PASS, 1 RECOVERED, 0 FAIL live run; fast-forward merged to main | [6ddabc8](https://github.com/premnandha1805/minimi-recall-agent/commit/6ddabc8) |
| 22 Nov: professional UI | `feature/professional-chat-ui` | ChatGPT-inspired interface, immediate deterministic conversation titles, chronological newest-first ordering, stable 100+ pagination, automated test storage isolation | 1,053 tests passed/one skip; 20 UI/ordering/isolation regressions; live browser verification with 0 console errors; fast-forward merged to main | [d3b4029](https://github.com/premnandha1805/minimi-recall-agent/commit/d3b4029) |

Initial comparison code was already on the Gate 2 branch. No extra historical branch is invented for each commit. Backup/worker references below are operational snapshots, not additional feature milestones.

## Genuine problem-solving examples

| Failure | Investigation and verified cause | Correction / safeguard | Evidence and limits |
| --- | --- | --- | --- |
| Saved meeting missed by recall | Request stages showed zero archive scans for missed wording; the user turn was already durable. Missing storage or post-model-only saving was not the cause | Archive access independent of intent; better lexical anchors; retain active context | `context.test.ts`, `live-memory-regression.test.ts`; original incident [44e08c2](https://github.com/premnandha1805/minimi-recall-agent/commit/44e08c2) |
| Azure rejected a no-tool request | Controlled probe: HTTP 400 with `tool_choice: none` but no tools; HTTP 200 without the field | Omit disabled-tool fields; validate pinned SDK instructions/endpoint/stream behavior | `model.test.ts`, `streaming-model.test.ts`; does not prove every deployment is compatible |
| Historical assistant answer omitted | Inspected retrieved record pairing and formatter output | Pair original Q&A without promoting an unsupported answer into verified evidence | `9eae1b0`; seeded-history comparison regression |
| Five CRM output duplicated/omitted vendors | Compared requested shortlist against product-level coverage | Canonical grouping and explicit missing-item verdicts | `73ccb78`; five-product fixtures |
| Browser listing failed at 109 records | Actual GET returned 200, but frontend rejected totals over 100. Backup `09245b8` held the compatible fix | Restore count validation; fetch all bounded pages | `63237c0`; 109/1000-record DOM tests. Omitted backup work, not a proven later core-code revert |
| Existing .env not loaded consistently | Required-field/factory checks succeeded; loader resolved shell cwd. No Git deletion/rename evidence | Resolve project-root .env; distinguish configuration presence from liveness | Config and clean/live checks; original failing process environment was not captured, so its precise omission is not asserted |
| Mixed price question omitted old price | Clean live output had only the verdict; mixed-intent classifier excluded the wording | Extend explicit historical interrogatives; reuse Q&A formatter | Targeted fixture and live recheck retained USD 20, returned Cannot verify for the unsupported baseline |
| Cleanup found unused timezone default and debug text logs | Usage inspection showed default read only in config; debug logs emitted 80-character excerpts | Apply configured default when omitted; use original local date for Q&A headings; remove conversation text from operational logs | New timezone/override, UTC/local-day heading, and debug-privacy regressions; committed in `6ddabc8` |
| Sidebar titles showed repeated "Stored conversation ? open..." | `GET /api/conversations` did not return conversation titles in list items, and frontend only derived titles after opening a chat. Filename sorting (`a.name.localeCompare(b.name)`) sorted SHA-256 hashes, producing pseudo-random ordering | Added deterministic `deriveConversationTitle()` extracting first user turn text (capped at 60 chars) with no additional LLM calls; minimal local processing overhead. Extended `GET /api/conversations` with `includeTitle: boolean`. Reordered `ConversationStore.list()` chronologically (`updatedAtUtc` desc) before slicing pagination offsets. Added temporal grouping headers (`TODAY`, `PREVIOUS CONVERSATIONS`) | 20 unit/integration tests in `tests/professional-ui.test.ts` (105-conversation pagination, corrupt file handling, ordering, XSS escaping, aria attributes); live browser verification on `http://127.0.0.1:3000` with 0 console errors/warnings; committed in `d3b4029` |
| Automated tests contaminated conversation archive | Tests calling `buildServer()` without `memoryDirectory` defaulted to `config.MEMORY_DIRECTORY` (`.data/conversations/`), writing 79 synthetic test fixtures into the local storage folder over multiple test runs | Added test environment guard in `src/server.ts`: when running under `NODE_ENV === 'test'` or `VITEST === 'true'` (or eval flags) without an explicit directory, storage routes to an isolated temporary directory in `os.tmpdir()` (`minimi-test-memory/<uuid>`), with cleanup on server close | Regression test in `tests/professional-ui.test.ts` verifying `buildServer()` under test conditions leaves `.data/conversations/` untouched. Full 1,053-test suite executed with 0 files added to `.data/conversations/` (verified 117 files before and after); committed in `d3b4029` |

No alternative is labeled “considered” unless an earlier design/incident report supports it. Architectural choices and limitations are in [DESIGN.md](../DESIGN.md), rather than duplicated here.

## Retained evidence and consolidated clutter

| Inventory class | Scope / reason |
| --- | --- |
| KEEP | Production modules, browser assets including both referenced icons, every existing test/fixture, evaluation runners, lockfile, contributor rules and useful technical contracts |
| IMPROVE | Runtime types/default-timezone/log privacy, recall format instructions, strict compiler checks, safe live harness, environment example, professional UI, immediate titling, and test isolation |
| CONSOLIDATE | Superseded incident diaries into this evidence-linked journey; nine unchanged result snapshots into docs/results |
| IGNORE | .env, real archives/backups, logs, node_modules, generated evaluations/audits, isolated test checkouts, and preserved local Stitch exports |
| REMOVE | Only the seven individually justified files below; no branch, historical commit or meaningful test |

Every original test and synthetic fixture remains. The JSON model adapter remains a useful injectable boundary exercised by frozen HTTP tests; production streaming has separate SDK wire tests. Exports used in regressions are not removed simply because index.ts does not call them. All ten dependencies have a runtime or development use. The existing pinned tsx package moves to runtime dependencies because npm start executes TypeScript directly; no dependency is added, upgraded or removed.

The automated test suite has grown incrementally across verified milestones:
- Initial submission (`3fb0148`): **982 tests passed, 1 skipped**.
- Regression recovery (`6ddabc8`): **1,033 tests passed, 1 skipped**.
- Professional UI & test isolation (`d3b4029`): **1,053 tests passed, 1 skipped** across 38 test suites.

The local conversation storage (`.data/conversations/`) contains 117 historical JSON files:
- **38 genuine user conversations**: personal questions, meeting reminders, release dates, and notes.
- **79 synthetic test fixtures**: `FieldKit` / `CedarLedger` / `CedarRelease` benchmarks and repetitive regression loops from earlier testing.
All 117 files remain strictly preserved and unmodified.

| Removed current-tree file | Reason / retained value |
| --- | --- |
| `scripts/diagnose-model.ts` | One-time two-call probe; conclusion above, original in Git, adapter regression covers request shape |
| `scripts/diagnose-stream.ts` | Unregistered one-off probe; SDK wire fixtures and opt-in live harness provide continuing checks |
| `scripts/reproduce-memory.ts` | Wrote to the default running archive and printed raw conversation/debug output; isolated live/HTTP recall tests retain useful intent |
| `ROOT_CAUSE.md` | Historical transcript duplicated later diaries and obsolete workflow descriptions; confirmed findings above, original remains in `44e08c2` |
| `docs/live-memory-changes.md` | File-by-file repair diary duplicates diffs/roadmap; no unique runtime contract |
| `docs/memory-reliability.md` | Superseded chronological audit; findings above, current storage contract in memory.md |
| `docs/gate2-review-repairs.md` | Superseded repair diary; safeguards remain in source/tests/current design and original Git history |

Credentials, both real archives, private logs and untracked Stitch exports remain local. `frontend/` is ignored because `public/` is the maintained app; the design reference is preserved. Ignored old test directories are not bulk-deleted.

## Honest AI-assisted workflow

The human brief and AGENTS.md set scope, cost limits, feature isolation and acceptance rules. AI-assisted coding/diagnostics are part of the actual tool/worktree context. Branches, corrections, fixtures and measured results support an account of decomposition and validation; they do not establish that every line was manually typed or every alternative benchmarked.

The four `swarm-*` references all point to `6cfc071`: automation working snapshots, not four independently completed features. Their dirty local experiments were inspected and preserved. An older recall experiment would remove stronger main checks, so it was not integrated. Untracked alternative Gate 3 harnesses in other worktrees also remain local.

Final compact-format observation: **1 PASS / 2 RECOVERED / 1 FAIL**, restart passed. The model-origin FAIL answered the brand correctly as `Dell` but omitted the exact project identifier required by the existing benchmark. The criterion remains unchanged. Final primary and clean suites each passed 1,005 tests with one skip. [The complete cleanup verification](results/cleanup-verification.json) preserves the intermediate context-budget failure and all three live outcomes.

Subsequent uncommitted recall review: a predefined traced baseline reproduced the omission and identified a turn-ID/message-ID confusion. Deterministic association validation, full-original recovery and compact field-specific instructions corrected the tested completeness defect. The predefined post-fix run returned **3 PASS / 1 RECOVERED / 0 FAIL**; the remaining conservative paraphrase recovery is not counted as model synthesis. The ten-fixture offline search-policy baseline and [recall diagnosis](verification.md#recall-reliability-review) report their actual scope and limitations. [Recall results](results/recall-reliability.json) retain both attempts. This review evidence was committed in `6ddabc8` and published.

The subsequent professional UI redesign (`feature/professional-chat-ui`, `d3b4029`) addressed user experience and navigation: immediate deterministic titles without extra model calls, chronological newest-first ordering, stable pagination across 100+ items, automated test isolation in temporary storage, and a polished ChatGPT-inspired interface with responsive sidebar and dark mode support.

## Complete branch inventory and publication audit

At publication: 18 public branches on `origin` (all verified ancestors of or identical to `main` at `d3b4029`), plus local development snapshots.

The publication preflight inspected **59 commits and 405 blobs**, including remote and reflog history. It detected zero matching credentials, private keys, provider tokens, environment files, private storage paths, or logs (`blocked: []`). Standard Git author identity and public profile links remain.

| Branch | Tip | Contribution / integration | Status on origin |
| --- | --- | --- | --- |
| `feature/project-setup` | `6901ef3` | Foundation; integrated | Published |
| `feature/chat-api` | `8b22394` | HTTP validation; integrated | Published |
| `feature/chat-ui` | `14f6460` | Stitch/plain UI; integrated | Published |
| `fix/chat-ui-usability` | `bb6bb07` | Focus/scroll; integrated | Published |
| `feature/agent-core` | `86cf0a3` | Bounded agent/Azure; integrated | Published |
| `feature/web-search` | `32a90bd` | Tavily/budgets; integrated | Published |
| `feature/live-chat-integration` | `3466bc6` | SSE; integrated | Published |
| `feature/latency-observability` | `5bc979a` | Timing/source/UI fixes; integrated | Published |
| `feat/gate-2-temporal-memory` | `694c04b` | Memory/dates/retrieval; integrated | Published |
| `fix/live-memory-recall` | `980371b` | Grounding/streaming reliability; integrated | Published |
| `feat/gate-3-change-verification` | `4e90b26` | Comparison/recall; integrated | Published |
| `fix/live-tool-call-schema` | `56e96e5` | Tool shape/fallback; integrated | Published |
| `fix/historical-qa-pairing` | `9eae1b0` | Original Q&A; integrated | Published |
| `fix/five-crm-coverage` | `73ccb78` | Vendor coverage; integrated | Published |
| `release/final-submission` | `3fb0148` | Initial release snapshot | Published |
| `fix/main-regression-recovery` | `6ddabc8` | Regression recovery & cleanup; integrated | Published |
| `feature/professional-chat-ui` | `d3b4029` | Professional UI, titles, test isolation; integrated | Published |
| `main` | `d3b4029` | Stable published GitHub branch HEAD | Published |
| `backup/primary-workspace-20261120` | `09245b8` | Preserved recovery backup | Private local |
| `swarm-agent-worker-2c834fba` | `6cfc071` | Automation worker snapshot | Private local |
| `swarm-context-worker-8a224c2b` | `6cfc071` | Automation worker snapshot | Private local |
| `swarm-recall-worker-8bc787cd` | `6cfc071` | Automation worker snapshot | Private local |
| `swarm-tests-worker-232f9019` | `6cfc071` | Automation worker snapshot | Private local |
| `test/final-live-e2e-validation` | `73ccb78` | Validation reference | Private local |

All 18 genuine development branches are published and publicly visible on GitHub at `https://github.com/premnandha1805/minimi-recall-agent/branches`.
The publication commands were executed via explicit targeted pushes (`git push origin <branch>`), ensuring private backup and worker snapshots remain local.
