# Offline application evaluation

Run `npm.cmd run eval:offline` from the repository root. This uses installed
dependencies only and writes `docs/evaluation-results.json`. Ordinary `npm.cmd test`
also runs the assertions but does not overwrite that report. No credentials or
network access are required: the injected transport rejects unexpected destinations.
Frozen synthetic prices are not claims about actual vendors or plans.

The 29 HTTP cases exercise real Fastify admission, restarted JSON storage,
historical/date retrieval, Azure response parsing, agent/tool orchestration, Tavily
parsing, verification, SSE encoding and browser stream validation. F2/F3 exercise
the actual agent cancellation/deadline machinery with a virtual clock instead of
HTTP sockets. F4 recovers an awaiting-receipt result without additional provider
calls. This suite does not run a browser or real socket-disconnect experiment;
existing HTTP/UI regressions supply separate coverage.

Model outputs are scripted at the provider boundary. Recall output is copied only
when the real context contains the stored answer; it is not an LLM recall score.
Injection fixtures exercise data transport with a cooperative scripted model, not
proof of resistance to an adversarial live model. Relative dates use a frozen
17 November 2026 reference and explicit zones, including a UTC/local-day boundary.
Setup occurs outside the timed interval. Random storage identities do not affect
assertions; report identities and timings may differ between runs.

## Gate 7D verification update

The offline evaluation suite contains 31 frozen cases. Following Gate 7D's
bounded natural-language pricing and feature verification, cases C6 (prose price
increase) and C7 (prose price unchanged) now pass both safety and usefulness
expectations. The recorded Gate 7D run has **31/31 structural/safety passes (100%)**
and **30/31 usefulness passes (96.8%)**, with 48 scripted model requests and 19 searches.
Only one restrictive abstention remains: C8 (fictional Acme domain outside the
explicit official product whitelist).
The full regression suite passed **687 tests with one skip** across 22 files;
server/browser typechecks passed.

## Gate 7A regression update (prior)

The suite now contains 31 frozen cases. G7A1–G7A3 use the exact three challenge
questions through restarted storage and HTTP orchestration. They assert the
selected original discussion, historical date, complete five-product shortlist,
and comparison routing before scripted current research. Their expected Cannot
verify reflects deliberately unsupported comparison evidence, not failed recall.
The existing evidence grammar and three known usefulness failures are unchanged.
The recorded Gate 7A run has 31/31 structural/safety passes and 28/31 usefulness
passes, with 48 scripted model requests and 19 searches. C6, C7 and C8 remain
the usefulness failures. The full regression run passed 617 tests with one skip
across 22 files; server/browser typechecks passed. Following the final stop-word
concatenation cleanup, the 118 affected context/date/verification tests and all
31 evaluation cases passed again. These remain offline application outcomes,
not live model accuracy or latency measurements.

## Previous 28-case observed run (before Gate 7A)

| Category | Cases | Structural/safety pass | Usefulness pass |
| --- | ---: | ---: | ---: |
| Web/citations | 4 | 4 | 4 |
| Historical recall | 9 | 9 | 9 |
| Historical comparisons | 11 | 11 | 8 |
| Reliability/recovery | 4 | 4 | 4 |
| Total | 28 | 28 | 25 |

False confirmations: 0 detected. Incorrect historical recalls: 0 detected.
Accepted fabricated citations or altered quotations: 0. Unnecessary searches in
the nine recall cases: 0. These counts refer only to explicit frozen assertions;
they do not establish general factual accuracy or semantic claim support.
Observed mock calls: 42 model requests and 16 searches across all cases.

Cannot verify occurred in 7/28 cases (25%): 4 appropriate abstentions and 3
restrictive abstentions relative to the fixture's stated evidence oracle:

| Case | Root cause | Minimum recommended future correction |
| --- | --- | --- |
| C6 | Complete natural-language price increase is outside the labeled grammar | Add a narrowly validated, lossless natural-language evidence parser with negative fixtures |
| C7 | Same limitation for equal comparable prices | Reuse that parser without weakening dimensional/quotation checks |
| C8 | Fictional Acme's explicitly supplied official evidence is outside the whitelist | Add an explicitly reviewed authority policy; never infer authority from the model |

C8's oracle declares `acme.example` authoritative inside the synthetic world;
production is correct to withhold trust absent such a policy. These quality
failures remain visible in the report while safety expectations still pass.
Missing baseline, partial snippet and general recommendation judgments remain
Cannot verify; the latter has no complete factual oracle in this fixture.

The top three usefulness risks are strict format dependence, finite authority
coverage, and inability to adjudicate broad recommendation correctness from these
rules. No production algorithms were changed to improve evaluation scores.

Local request wall time over the 26 HTTP cases: median **326.085 ms**, range
**164.66–437.66 ms**, observed in the currently recorded run. Timings are
nondeterministic observations, not frozen expectations or performance guarantees.
This includes disk, mocked parsing and
in-process HTTP/SSE handling; excludes setup and virtual timeout waits. It is not
isolated CPU overhead, provider latency, a stable benchmark or live p50/p95.

Verification: server/browser typechecks passed; full offline suite **597 passed,
1 skipped**, 22 files. The dedicated evaluation passed **28/28** assertions.
An initial fixture incorrectly expected MODEL_UNAVAILABLE for a provider 503;
it was corrected to the documented MODEL_FAILED mapping, with no production edit.
Live accuracy, latency, actual tool-selection quality, a measured always-search
baseline and clean-clone acceptance remain outside this offline run.
