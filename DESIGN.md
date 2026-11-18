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
read-after-write visibility in one process. Every HTTP request searches the archive;
intent controls answer phrasing rather than access. TF-IDF/lexical ranking, stemming,
aliases and recency recover natural questions such as "anything planned" and
"notebook computer". The user turn is flushed before network work; assistant errors
are saved separately. Up to eight earlier snippets, with sent dates, titles and
neighbors, enter a roughly 2,500-token evidence block. Active continuity retains its
original messages while they fit. Context omissions are disclosed. Files live in
the configured `.data/conversations` directory, explicitly ignored by the watcher.
A snapshot changes only after atomic rename; malformed/empty JSON is preserved
and restored from a validated backup at startup.

**Answers and dates.** Pure recall selects exact message evidence. Valid single
assertions render with a deterministic change of grammatical perspective;
transcript requests retain original wording. Conflicts and uncertain synthesis
retain labeled evidence or request narrowing. Relative phrases use the original
message reference and IANA timezone; month/year ranges use calendar boundaries.
Yearless event dates have labeled nearest-occurrence hints relative to the original
message; original wording remains authoritative and cannot prove upcoming status.
Sent, described-event, publication and effective dates remain distinct. Mixed
answers check personal/historical prose against originals separately from public
evidence; calendar claims retain the existing date/entity checks. These checks
are conservative linguistic safeguards, not a general semantic proof system.

**Web and reliability.** `web_search` is the only external model tool. Code enforces
2 rounds, 5+3 queries, 8 total requests including failures, 2-way concurrency,
per-search timeouts, a 15-second search cutoff and a 25-second request deadline.
Fresh external research starts alongside local retrieval and shares the same
request-local search budget. The pinned Vercel AI SDK streams provisional plain
text; one model call normally answers recall, with one shorter-context retry for
timeout/5xx. A 15-second first-token timer and reserved synthesis/write time fit
inside the overall deadline. If the model fails with evidence, deterministic
quotations still answer; empty retrieval never means "you never told me".
Abort signals handle disconnects. Zod validates requests and results; final output
is bounded to 16,000 characters before persistence/SSE. Current source IDs are
request-local; historical markers cannot become live citations. Change checks use
Confirmed change / No confirmed change / Cannot verify / Not comparable and require
comparable evidence plus matching quotes. Stored and web content are untrusted.

**Scope and tradeoffs.** One private directory represents one local user; loopback
and same-origin guards are not multi-user authentication. The production 1,000-conversation,
64 MiB single-process archive avoids external infrastructure and stale indexes.
Lexical recall can miss semantic paraphrases; conservative synthesis can be verbose.
Mixed prose can evade linguistic history detection. Drafts are replaced by a final
validated answer; extractive grounding can be verbose. Zero web requests do not
mean zero model cost; no quota or paid usage is assumed.

**Live failure and measurements.** Offline tests missed intent-gated archive access,
overly restrictive query matching and Azure rejecting `tool_choice` without tools.
The original 852 tests remain; the current suite passes 892 with one existing skip,
plus both typechecks and the hygiene lint. Five warm lookups over 500 stored
conversations measured 14.58–24.49 ms. The real provider passed all four fact pairs
three consecutive times (12/12); see [live results](docs/live-e2e-results.json) for
actual pair/first-token timings and [root causes](ROOT_CAUSE.md) for logs and limits.
These measurements describe this machine and corpus, not general latency guarantees.

**Rejected and next week.** Embeddings, a vector DB and an LLM intent classifier
would add cost, infrastructure or another network call without fixing these bugs.
Another week would expand paraphrase/adversarial fixtures, profile larger archives,
and test backup retention and Windows watcher/cancellation behavior on more machines.
