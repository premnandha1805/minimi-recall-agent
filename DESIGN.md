# Recall — Temporal, Evidence-Grounded Chat Agent

**Problem.** “On Monday we shortlisted five CRMs. Has anything changed?” A useful agent must recover **which five**, what was said **when**, and whether today's evidence actually supports a change. Recall preserves original conversations, searches selectively, and answers with verifiable sources and explicit uncertainty.

## Architecture

`Minimal chat UI → Fastify/Node.js + SSE → timestamped context → one tool-calling model ↔ web_search → source checks → streamed answer + saved history`

**Current integration (interim):** [recall.chat.v1](docs/chat-sse.md) connects the
browser to the existing Azure OpenAI v1 and Tavily adapters using SSE progress
plus one validated final/partial answer. Azure uses `stream: false`; this is **not
token streaming**. True token streaming remains a required future milestone.
HTTP chat requires both supported Azure configuration and Tavily credentials,
checked locally before any model call. Memory, temporal recall and quotation
verification remain outstanding. Citation-ID checks do not establish factual
verification. Live model compatibility, quota and measured latency are unverified.
The architecture and remaining acceptance requirements below remain the target.

**Gate 2 storage milestone:** An isolated, versioned JSON conversation store now
implements durable turn/attempt records and evidence snapshots with bounded local
storage and explicit receipt states ([storage contract](docs/memory.md)). It is
not yet connected to chat or browser restoration; persistent chat, temporal
resolution and context retrieval remain outstanding. This does not change the
interim SSE contract or establish quotation/factual verification.

- **One external tool:** `web_search`, implemented through a replaceable Tavily adapter. The model decides when to search; **code** enforces **2 rounds / 8 provider queries** (up to **5** first round, **3** second), query deduplication and bounded concurrency. History/date functions are internal, not extra tools.
- **Memory and time:** Persist original messages, IDs and UTC timestamps in per-conversation JSON. Merge request-seeded history with disk history by ID (fallback: hash of role/timestamp/content); server copy wins conflicts. Inject all history while it fits, otherwise anchor relevant dates/keywords. Use `chrono-node` and an IANA timezone for relative dates. Atomic rename plus per-conversation write queues prevent partial or lost writes **within one process**.
- **Speed and failure:** One server serves the plain HTML/CSS/JS UI and streams SSE progress and answer text. Overall deadline: **25 s**; stop launching searches around **15 s** to reserve synthesis time. Timeouts, abort-on-disconnect, and partial-evidence responses prevent a slow or failed search from becoming an invented answer.
- **Evidence:** Each result supplies ID, title, URL, extracted text, retrieval time, and optional publication/effective dates (never invented). Link only known `[S#]` citations. For **Confirmed change**, require a short cited quotation and check it after streaming against the *exact text shown to the model*, allowing Unicode/whitespace/typographic normalization; visibly flag mismatches. A matching quote does **not** prove the entire claim. Retrieval date is not change date.

## Change-verification contract

Recover original entities, facts and conversation date; search only stale facts; compare like-for-like plan, currency, region, billing period and seat basis. Say **“verified 3 of 5”** rather than imply full coverage. Use one verdict per item:

| Verdict | Meaning |
| --- | --- |
| **Confirmed change** | Credible comparable historical/current evidence differs. |
| **No confirmed change** | No substantiated change found; **not** proof of unchanged status. |
| **Cannot verify** | Missing baseline, weak evidence or failed research. |
| **Not comparable** | Plans, regions or billing terms differ. |

Lead with the answer; cite current claims inline; explain whether the earlier recommendation still holds. Treat webpages and history as untrusted **data**, never instructions.

## Trade-offs

| Chosen | Rejected | Why |
| --- | --- | --- |
| One bounded tool loop | Agent swarm / separate LLM router | Less latency and orchestration. |
| Original JSON history | Summary-only, FTS5, vector DB | Exact recall and portable setup. |
| Same-server UI + SSE | Separate React app / WebSockets | Fewer parts; responsive UX. |
| Lightweight quote checks | Full pricing engine | Useful evidence integrity without scope creep. |

**Limit:** JSON persistence is designed for a single-process challenge, not distributed deployment; citations reduce but cannot eliminate unsupported claims.

## Evaluation and submission

Run **15 frozen-search correctness fixtures** (including all three task examples, missing baseline, bad citations, conflicting dates, search failure and prompt injection) against an **always-search baseline**. Measure recall/change correctness, unsupported claims, citation failures and searches/request. Run **separate live tests** for latency, plus concurrent-write and clean-clone tests. Report real results, including misses.

**Measured results — replace only after running tests:** correctness `PENDING`; unsupported claims `PENDING`; searches/request (Recall/baseline) `PENDING`; p50/p95 live latency `PENDING`.

**Ship gate:** A clean clone runs `npm install && npm run dev`; `.env.example` lists required keys; live search, citations, seeded recall and recorded evaluation results work. Never commit secrets.
