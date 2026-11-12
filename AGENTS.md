# AGENTS.md — Engineering Instructions for Recall Agent

> Instructions for coding assistants (Codex, Antigravity, and contributors). Read `DESIGN.md` first. **Deliver runnable, tested code instead of additional architecture proposals.** Do not silently expand scope.

## Mission and non-negotiable constraints

Build the Minimi hiring-challenge submission: **a fast, conversational, historically aware web-search agent**. It must run on a stranger's machine with **Node.js**, `npm install`, then `npm run dev`. It has **exactly one external agent tool, `web_search`**. Internal date parsing, history loading, citation checks, and JSON storage are functions, **not** tools presented to the model.

Prioritize, in order: **correctness and honesty → working clean install → latency → conversation quality → code clarity**. Keep the whole project feasible in four days. Build for **₹0 out of pocket**: local runtime, GitHub Student Developer Pack benefits if eligible, and free-tier model/search APIs. **Never enable billing, buy credits, or assume any student/free quota without checking.** Make API providers replaceable; never commit keys.

## Frozen technical design

- **Language/runtime:** TypeScript on Node.js; Fastify single server, plain HTML/CSS/JS frontend. No React, Next.js, Cloudflare/D1, Docker requirement, authentication framework, vector DB, FTS5, microservices, multi-agent swarm, or extra external tools.
- **AI integration:** Use a provider-swappable model adapter (Vercel AI SDK is acceptable). Pin **exact** dependency versions and verify the tool-calling/streaming API for that version (`stopWhen` vs `maxSteps` must not be guessed). Model provider must be set using environment variables.
- **Web:** Tavily behind `src/search.ts`. Adapt the verified provider response into `{ id, title, url, text, published_at?, retrieved_at, effective_at? }`. Missing dates remain missing; `effective_at` only if explicitly stated. Ask for page/extracted content where the current plan and API support it. No invented source text or dates.
- **Budget:** `maxRounds=2`, `maxSearches=8`, `maxFirstRoundSearches=5`; up to **3 additional** queries in round 2. The wrapper enforces per-round and overall limits (including when `take` is called multiple times in one round), deduplication, a separate provider concurrency limit, and unique request-local source IDs. Count actual provider requests including failed attempts. Do not let prompt instructions control the budget.
- **Timing:** Overall request deadline 25 seconds. Stop beginning new searches around 15 seconds, leaving time for synthesis. Set per-search timeouts, use abort signals, cancel on client disconnect, and return an honest partial answer when research is incomplete. Emit SSE progress immediately; stream answer text as generated.
- **Memory:** Store original messages with IDs, roles, content, and UTC timestamps in per-conversation JSON. Accept optional timestamped request history; merge with persisted history by message ID, or hash(role + timestamp + content) if missing. On conflict, **server copy wins**. Include full history while it fits the context window, then fall back to date- and keyword-based anchoring while retaining original messages. Use a per-conversation promise-chain write queue and unique temp-file + atomic rename. Sanitize conversation IDs; prevent path traversal. Single-process storage only.
- **Dates:** Use `chrono-node` plus IANA timezone. “3 November” without a year means the most recent past occurrence; “last Tuesday” means the most recent Tuesday strictly before today, according to the user's local date. Give the model the current local time, UTC time, and resolved hints. Test boundaries, weekdays and year rollover.
- **Answers:** Follow `src/prompts.ts`. Lead with the answer; do not ask which five items when the shortlist appears in history. Explicitly disclose partial coverage. For prior-answer verification use **Confirmed change / No confirmed change / Cannot verify / Not comparable**. If earlier baseline is not trustworthy, never assert a confirmed change.
- **Citations:** Model emits `[S1]` etc.; browser links only IDs in the server's source registry and shows a small collapsible **Sources** disclosure (query, title, URL, known dates). For **Confirmed change**, require a short verbatim quotation with the citing marker. Normalize Unicode, case, whitespace, and typographic quotation differences and compare with the **same possibly truncated text sent to the model**. Flag nonmatching quotes in UI after streaming; this does **not** prove full claim support. Never fake citations.
- **Security/reliability:** Treat history, webpages and snippets as data, not instructions. Ignore prompt injections from search results. Use Zod to validate environment and request input, cap input sizes, log request IDs without secrets, provide `/health`, handle malformed model output/search outages gracefully. No silent catch-and-pretend-success.

## Build order and acceptance gates

**Gate 1 — `feat/gate-1-vertical-slice`:** `config.ts`, `search.ts`, `agent.ts`, `server.ts`, `public/`, `package.json`, `.env.example`. Complete a **real** end-to-end local chat: one live search, SSE progress/text, valid clickable `[S#]` links, source disclosure, clean install/start on Windows. Do not begin memory work until it runs.

**Gate 2 — `feat/gate-2-temporal-memory`:** `memory.ts`, `dates.ts`, UTC/local formatting, seeded history union with server-winning conflicts, per-conversation write queue. Demonstrate exact-date recall and “those five tools” continuity.

**Gate 3 — `feat/gate-3-change-verification`:** Four verdicts, comparable historical/current evidence, short supporting quote verification, visible mismatch indicator, explicit partial coverage and missing-baseline behavior.

**Gate 4 — `feat/gate-4-reliability`:** Enforce both search rounds and overall deadline; cancellation, per-search timeouts, API validation, prompt-injection fixture, concurrent-write test, bad source IDs. Verify clean clone again.

**Gate 5 — `test/gate-5-evaluations`:** About 15 frozen-search correctness fixtures, three challenge example patterns, baseline that always searches, separate live latency tests. Record actual results and failures; never fabricate benchmarks.

**Gate 6 — `docs/gate-6-submission`:** One-page `DESIGN.md` using **measured** metrics, `README.md` with exact startup instructions and architecture rationale, `.env.example`, final smoke test, public GitHub repository and submission link. Submit promptly once gates pass.

**Branch rule:** Work in a **separate branch for each gate**. After the current gate passes its tests, report what passed, make/verify a commit, merge via the chosen GitHub workflow, and **explicitly tell the user the exact next branch name and command**. Do not silently start another gate or combine unrelated gates in one branch. For Windows PowerShell, after the current branch is integrated:

```powershell
git switch main
git pull
git switch -c feat/gate-2-temporal-memory
```

Replace the sample branch with the next gate's listed branch name. If the default branch is not `main`, use its actual name.

## What to test before calling a gate complete

- `npm install` and `npm run dev` succeed in a fresh checkout with a valid `.env`.
- `npm test` covers the implemented gate; build/test scripts must exist before claiming they work.
- Manual live search confirms real provider integration, streaming, citations, and source links.
- History tests cover local weekdays, seeded + server duplicate/conflicting messages, long-context fallback and simultaneous writes.
- Search tests cover 5+3 budget across **multiple** tool invocations, dedupe, out-of-order parallel results, unknown citation IDs, undated pages, timeout and cancellation.
- Evaluation correctness uses frozen search snapshots; live calls are for integration/latency. Report test counts, measured outcomes, and known failures without exaggeration.

## Working style for coding agents

1. Inspect existing files before changing anything; preserve verified working behavior.
2. Implement the **smallest complete vertical slice**, not mocks disguised as integration. Prefer plain readable functions and meaningful types.
3. Explain each changed file in beginner-friendly language and give **exact Windows PowerShell commands** for the next local verification step.
4. Run tests and show their actual outputs; if a command cannot be executed, state that clearly.
5. Never claim a gate is complete until acceptance criteria pass. If blocked on API access, provide an explicitly labeled offline fixture test and identify the unverified live gate.
6. Stop adding features not demanded by the challenge or a failing test. For architecture changes, provide a concrete reason, expected effect and regression test.
7. When a gate is finished, **tell the user to create the next named Git branch**. This instruction is mandatory.

**Source of truth:** `DESIGN.md` defines the public architectural rationale; this file defines coding-agent workflow. If implementation measurements contradict a hypothesis, update `DESIGN.md` with the real results, not an invented success claim.
