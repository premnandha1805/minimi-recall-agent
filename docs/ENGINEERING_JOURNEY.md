# Engineering journey and review evidence

This account follows Git ancestry, source diffs, fixtures, and recorded results. Dates are commit author dates in +05:30, not reconstructed work-session times. Work began on 12 November 2026. The four-day constraint in the original brief is a planning constraint, not evidence that this recorded history finished in four days.

Main remains at `3fb0148`. Recovery commit `63237c0` and the current uncommitted cleanup are review candidates, not integrated releases. No original branch or commit has been rewritten.

## Chronological roadmap

Verification below identifies evidence introduced or present in the cited revision. It does not claim today's dependencies were run against every historical branch.

| Date / phase | Original branch | Problem and implementation | Verification / dependency | Evidence |
| --- | --- | --- | --- | --- |
| 12 Nov: foundation | `feature/project-setup` | Small Node/TypeScript project without extra services | Package scripts/compiler setup; prerequisite for later code | [6901ef3](https://github.com/premnandha1805/minimi-recall-agent/commit/6901ef3) |
| 12 Nov: HTTP | `feature/chat-api` | Validate requests, cap bodies, expose health, sanitize errors | Configuration/server contract tests | [8b22394](https://github.com/premnandha1805/minimi-recall-agent/commit/8b22394) |
| 12–13 Nov: interface | `feature/chat-ui`, `fix/chat-ui-usability` | Integrate Stitch as plain assets; repair scrolling/focus | DOM interaction and layout tests; depends on HTTP | [14f6460](https://github.com/premnandha1805/minimi-recall-agent/commit/14f6460), [bb6bb07](https://github.com/premnandha1805/minimi-recall-agent/commit/bb6bb07) |
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
| 20 Nov: release | `release/final-submission` | Capture startup instructions and measured evidence | Dated results, with documented limitations | [3fb0148](https://github.com/premnandha1805/minimi-recall-agent/commit/3fb0148) |
| 22 Nov: recovery | `fix/main-regression-recovery` | Recover omitted UI work; fix project-root env lookup, rejected-save labels and historical-price routing | 982 tests passed/one skip in primary and clean snapshots; exact live price recheck | Local `63237c0`; [recovery audit](results/recovery-audit.json) |

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
| Cleanup found unused timezone default and debug text logs | Usage inspection showed default read only in config; debug logs emitted 80-character excerpts | Apply configured default when omitted; use original local date for Q&A headings; remove conversation text from operational logs | New timezone/override, UTC/local-day heading, and debug-privacy regressions; current uncommitted work, not a fabricated historical milestone |

No alternative is labeled “considered” unless an earlier design/incident report supports it. Architectural choices and limitations are in [DESIGN.md](../DESIGN.md), rather than duplicated here.

## Retained evidence and consolidated clutter

| Inventory class | Scope / reason |
| --- | --- |
| KEEP | Production modules, browser assets including both referenced icons, every existing test/fixture, evaluation runners, lockfile, contributor rules and useful technical contracts |
| IMPROVE | Runtime types/default-timezone/log privacy, recall format instructions, strict compiler checks, safe live harness, environment example and current setup/contracts |
| CONSOLIDATE | Superseded incident diaries into this evidence-linked journey; nine unchanged result snapshots into docs/results |
| IGNORE | .env, real archives/backups, logs, node_modules, generated evaluations/audits, isolated test checkouts, and preserved local Stitch exports |
| REMOVE | Only the seven individually justified files below; no branch, historical commit or meaningful test |

Every original test and synthetic fixture remains. The JSON model adapter remains a useful injectable boundary exercised by frozen HTTP tests; production streaming has separate SDK wire tests. Exports used in regressions are not removed simply because index.ts does not call them. All ten dependencies have a runtime or development use. The existing pinned tsx package moves to runtime dependencies because npm start executes TypeScript directly; no dependency is added, upgraded or removed.

Nine JSON reports moved byte-for-byte into `docs/results/`. New evaluations write ignored `.data/evaluations/`, preserving committed evidence. The old 12/12 live report predates the stricter model-origin evaluator; it cannot be compared directly with the recovery run's 2 PASS / 2 RECOVERED.

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

Final compact-format observation: **1 PASS / 2 RECOVERED / 1 FAIL**, restart passed. The model-origin FAIL answered the brand correctly as `Dell` but omitted the exact project identifier required by the existing benchmark. The criterion remains unchanged. Final primary and clean suites each passed 1,005 tests with one skip. [The complete cleanup verification](results/cleanup-verification.json) preserves the intermediate context-budget failure and all three live outcomes. No submission-readiness claim is made.

Subsequent uncommitted recall review: a predefined traced baseline reproduced the omission and identified a turn-ID/message-ID confusion. Deterministic association validation, full-original recovery and compact field-specific instructions corrected the tested completeness defect. The predefined post-fix run returned **3 PASS / 1 RECOVERED / 0 FAIL**; the remaining conservative paraphrase recovery is not counted as model synthesis. The ten-fixture offline search-policy baseline and [recall diagnosis](verification.md#recall-reliability-review) report their actual scope and limitations. [Recall results](results/recall-reliability.json) retain both attempts. This is follow-up review evidence, not an invented branch, commit or controlled accuracy improvement.

## Complete branch inventory and publication audit

At audit: 23 local branches, origin/main plus its origin/HEAD alias, 12 worktrees, no stashes. All historical feature/fix tips below are ancestors of main except backup and the recovery candidate.

The preflight inspected **55 commits and 360 blobs**, including remote/reflog history. It detected no matching current credentials, private keys, literal provider tokens, environment files, private storage paths or logs. Relevant source/docs were manually reviewed for the context of synthetic examples. Standard Git author identity and public profile links remain. This is a defined heuristic scan plus review, not a guarantee that arbitrary personal data is automatically recognizable. Dirty changes/future commits require a new scan.

| Branch | Tip | Contribution / integration | Committed-history scan |
| --- | --- | --- | --- |
| `feature/project-setup` | `6901ef3` | Foundation; integrated | No detected secret/private file |
| `feature/chat-api` | `8b22394` | HTTP validation; integrated | Same |
| `feature/chat-ui` | `14f6460` | Stitch/plain UI; integrated | Same |
| `fix/chat-ui-usability` | `bb6bb07` | Focus/scroll; integrated | Same |
| `feature/agent-core` | `86cf0a3` | Bounded agent/Azure; integrated | Same |
| `feature/web-search` | `32a90bd` | Tavily/budgets; integrated | Same |
| `feature/live-chat-integration` | `3466bc6` | SSE; integrated | Same |
| `feature/latency-observability` | `5bc979a` | Timing/source/UI fixes; integrated | Same |
| `feat/gate-2-temporal-memory` | `694c04b` | Memory/dates/retrieval; integrated | Same |
| `fix/live-memory-recall` | `980371b` | Grounding/streaming reliability; integrated | Same |
| `feat/gate-3-change-verification` | `4e90b26` | Comparison/recall; integrated | Same |
| `fix/live-tool-call-schema` | `56e96e5` | Tool shape/fallback; integrated | Same |
| `fix/historical-qa-pairing` | `9eae1b0` | Original Q&A; integrated | Same |
| `fix/five-crm-coverage` | `73ccb78` | Vendor coverage; integrated | Same |
| `release/final-submission` | `3fb0148` | Release snapshot; identical to main | Same |
| `main` | `3fb0148` | Existing public submission | Same |
| `backup/primary-workspace-20261120` | `09245b8` | Unique preserved work; UI hunks recovered selectively | Same; label as backup |
| `fix/main-regression-recovery` | `63237c0` | Pending recovery; cleanup uncommitted | Existing history passes; rescan approved cleanup commit |
| `swarm-agent-worker-2c834fba` | `6cfc071` | Agent snapshot; base integrated | No detected secret/private file |
| `swarm-context-worker-8a224c2b` | `6cfc071` | Context snapshot; base integrated | Same |
| `swarm-recall-worker-8bc787cd` | `6cfc071` | Recall snapshot; base integrated | Same |
| `swarm-tests-worker-232f9019` | `6cfc071` | Test snapshot; base integrated | Same |
| `test/final-live-e2e-validation` | `73ccb78` | Validation reference; untracked harness remains local | Same for committed history |

origin/main is `3fb0148`; origin/HEAD is its alias, not another development branch. The scanner never accesses account credential stores or unrelated directories. It compares project-local keys in memory and returns categories/paths only. Its private report is `.data/audits/publication.json`.

### Prepared publication commands — not executed

Obtain approval for the cleanup commit and intended publication first. Re-run `npm run audit:history` after an approved commit. These commands neither merge nor rewrite history nor include dirty worktree files. Pushing recovery now would publish only `63237c0`, not this cleanup.

```powershell
git push --set-upstream origin feature/project-setup
git push --set-upstream origin feature/chat-api
git push --set-upstream origin feature/chat-ui
git push --set-upstream origin fix/chat-ui-usability
git push --set-upstream origin feature/agent-core
git push --set-upstream origin feature/web-search
git push --set-upstream origin feature/live-chat-integration
git push --set-upstream origin feature/latency-observability
git push --set-upstream origin feat/gate-2-temporal-memory
git push --set-upstream origin fix/live-memory-recall
git push --set-upstream origin feat/gate-3-change-verification
git push --set-upstream origin fix/live-tool-call-schema
git push --set-upstream origin fix/historical-qa-pairing
git push --set-upstream origin fix/five-crm-coverage
git push --set-upstream origin release/final-submission
git push --set-upstream origin backup/primary-workspace-20261120
git push --set-upstream origin fix/main-regression-recovery
# Optional operational snapshots; these four references share one commit.
git push --set-upstream origin swarm-agent-worker-2c834fba
git push --set-upstream origin swarm-context-worker-8a224c2b
git push --set-upstream origin swarm-recall-worker-8bc787cd
git push --set-upstream origin swarm-tests-worker-232f9019
git push --set-upstream origin test/final-live-e2e-validation
```

Main already exists remotely. Only after separately approved integration/publication, its explicit publication command is `git push origin main`. Do not replace this reviewed list with `git push --all`.
