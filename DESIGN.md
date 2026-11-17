# Recall ? System Architecture

**Purpose.** A local conversational research agent that recalls stored discussions,
retrieves current external evidence, and distinguishes verified changes from
missing or incomparable information.

**Flow:** browser (plain HTML/CSS/JS) ? Fastify ? deterministic memory/date context ?
provider-swappable model ? optional Tavily `web_search` ? evidence checks ? atomic
JSON persistence and SSE result. TypeScript runs on Node.js with `npm install`
and `npm run dev`; no database daemon or frontend build is required.

**Memory.** Original messages, roles, IDs, UTC timestamps, turn timezones and source
snapshots persist in private per-conversation JSON. Server copies win import
conflicts. Per-conversation queues and a commit-consistent snapshot provide
read-after-write visibility in one process. Linguistic recall cues select the
archive; ordinary continuity loads the active conversation. Unicode normalization,
modest stemming, verb equivalences, independent weighted lexical ranking and
named anchors retrieve supporting turns across conversations. Adjacent reference
and correction chains retain their originals. Empty topics require a date,
explicit broad history request, active antecedent, or clarification. Only eight
whole recall records enter the bounded context; omissions are disclosed.

**Answers and dates.** Pure recall selects exact message evidence. Valid single
assertions render with a deterministic change of grammatical perspective;
transcript requests retain original wording. Conflicts and uncertain synthesis
retain labeled evidence or request narrowing. Relative phrases use the original
message reference and IANA timezone; month/year ranges use calendar boundaries.
Sent, described-event, publication and effective dates remain distinct. Mixed
answers check personal/historical prose against originals separately from public
evidence; calendar claims retain the existing date/entity checks. These checks
are conservative linguistic safeguards, not a general semantic proof system.

**Web and reliability.** `web_search` is the only external model tool. Code enforces
2 rounds, 5+3 queries, 8 total requests including failures, 2-way concurrency,
per-search timeouts, a 15-second search cutoff and a 25-second request deadline.
Abort signals handle disconnects. Zod validates requests and results; final output
is bounded to 16,000 characters before persistence/SSE. Current source IDs are
request-local; historical markers cannot become live citations. Change checks use
Confirmed change / No confirmed change / Cannot verify / Not comparable and require
comparable evidence plus matching quotes. Stored and web content are untrusted.

**Scope and tradeoffs.** One private directory represents one local user; loopback
and same-origin guards are not multi-user authentication. The 100-conversation,
64 MiB single-process archive avoids external infrastructure and stale indexes.
Lexical recall can miss semantic paraphrases; conservative synthesis can be verbose.
Mixed prose can evade linguistic history detection. SSE currently delivers a final
validated answer rather than provider-token streaming. Zero web requests do not
mean zero model cost; no quota or paid usage is assumed.

**Measured evaluation.** 852 tests passed, 1 skipped across 25 files; both typechecks
passed. The 39-test memory suite retrieved 10/10 expected conversation matches
with zero unrelated matches in ten frozen queries. Retrieval p50/p95 was
1.88/37.73 ms; one mocked HTTP run took 125.76 ms. These are synthetic local
measurements, not live model quality or network benchmarks. No provider calls
were made for this review. See [review repairs](docs/gate2-review-repairs.md),
[memory design](docs/memory.md), and [results](docs/memory-evaluation.json).
