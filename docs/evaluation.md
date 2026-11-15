# Offline application evaluation

Run `npm.cmd run eval:offline` from the repository root. This uses installed
dependencies only and writes `docs/evaluation-results.json`. Ordinary `npm.cmd test`
also runs the assertions but does not overwrite that report. No credentials or
network access are required: the injected transport rejects unexpected destinations.
Frozen synthetic prices are not claims about actual vendors or plans.

The 26 HTTP cases exercise real Fastify admission, restarted JSON storage,
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

## Observed run

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
