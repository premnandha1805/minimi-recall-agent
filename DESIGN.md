# Recall — Temporal, Evidence-Grounded Chat Agent

**Problem.** “On Monday we shortlisted five CRMs. Has anything changed?” A truly useful agent must reliably answer three questions: **which five** were shortlisted, what was stated **when**, and whether fresh evidence today confirms a genuine change. Recall addresses this challenge through durable original conversation storage, deterministic temporal and topic retrieval, a single strictly budgeted web-search tool loop, and deterministic quotation and change verification.

---

## 1. Overall Agent Architecture and Request Flow

The system operates as a single Fastify Node.js server pairing a dependency-free, plain HTML/CSS/JavaScript client with a modular TypeScript backend.

```mermaid
flowchart TD
  User([User in Browser]) -->|POST /api/chat with message & history| Server[Fastify HTTP Server]
  Server -->|Zod validation + storage admission| Context[Deterministic Context & Memory Engine]

  subgraph Memory Engine
    Context -->|Query classification| Intent{Query Intent}
    Intent -->|Pure Recall| DateResolver[Chrono + IANA Date Resolver]
    Intent -->|Mixed / Change / Fresh| SearchCoordinator[Search Coordinator]
    DateResolver -->|Filter turns & entities| DiskStore[(".recall-data/ JSON Store")]
  end

  subgraph Agent Core Loop [Bounded Model Loop]
    Context -->|Prepared messages + anchors| Model[Azure OpenAI v1 Adapter]
    Model -->|Tool call: web_search| SearchCoordinator
    SearchCoordinator -->|Tavily API - max 2 rounds / 8 queries| WebResults[(Tavily Search)]
    WebResults -->|Bounded snippets + Source registry| SearchCoordinator
    SearchCoordinator -->|Tool result message| Model
    Model -->|Synthesis text / Comparison JSON| PostCheck[Verification & Safety Gates]
  end

  subgraph Verification & Safety
    PostCheck -->|Verify citations exist in registry| CitCheck{Valid [S#] IDs?}
    PostCheck -->|Check verbatim quote alignment| QuoteCheck{Quote matches snippet?}
    PostCheck -->|Four-verdict factual comparison| CompCheck{Comparable facts?}
    PostCheck -->|Grounding against original user dates| DateCheck{Temporal Grounding}
  end

  PostCheck -->|Atomic write: Turn + Evidence snapshot| DiskStore
  PostCheck -->|SSE stream: progress + validated answer| User
  User -->|POST /api/conversations/:id/turns/:tid/receipt| Server
```

### End-to-End Execution Sequence

1. **Request Intake & Admission:** The Fastify server validates the request using strict Zod schemas (`ChatRequestSchema`), establishes an atomic write lock for the conversation, and initiates a monotonic deadline scope (25 seconds maximum).
2. **Deterministic Context & Memory Selection:** Before invoking the language model, internal functions inspect the query for temporal locators, personal schedule assertions, and change requests. If past context is requested, original turns are retrieved from local disk storage and filtered by resolved date boundaries or entity anchors.
3. **Execution Routing:**
   - **Pure Personal/Historical Recall:** When the user asks about private schedule, previous decisions, or recorded discussions, tools are completely disabled (`tools = []`). The model runs with memory context alone, consuming **zero external search calls**.
   - **External Research & Mixed Queries:** The single external tool, `web_search`, is enabled.
4. **Bounded Model & Search Loop:** The model engages in a strict two-round loop:
   - **Round 1:** Up to 5 parallel search queries.
   - **Round 2:** Up to 3 additional follow-up queries.
   - At most 8 total searches across both rounds. Queries are deduplicated by normalized string. Physical concurrency is capped at 2. New search queries are rejected after the 15-second cutoff to guarantee sufficient time for synthesis.
5. **Deterministic Verification Stage:**
   - **Citation Integrity:** Every `[S#]` marker is verified against request-local source registry IDs.
   - **Quotation Verification:** All cited quotes must match verbatim against the exact normalized text shown to the model. Mismatches trigger visible warnings.
   - **Change Verification:** For historical comparison queries, the model emits candidate extractions (`COMPARISON_INSTRUCTIONS`), and deterministic TypeScript code evaluates like-for-like pricing, dimensional equivalence, and authority whitelist compliance.
   - **Temporal Grounding:** Prevents hallucinated years or premature "upcoming" labels when users mention yearless dates.
6. **Persistence & Delivery:** The validated result, full turn history, and raw evidence snapshots are written atomically to disk. Progress and the final answer are streamed via SSE (`recall.chat.v1`). Client receipt acknowledgment marks the turn as accepted.

---

## 2. Why One Bounded Web-Search Tool Loop Was Chosen

The challenge requires: *"Build the best chat agent you can with one tool, web search."*

To uphold this constraint with high reliability:
- **`web_search` is the sole tool exposed to the model.** Internal date parsing, history loading, citation checks, and JSON storage are implemented as **internal application functions**, never as model tools.
- Exposing internal capabilities (such as `get_date` or `read_history`) as model tools introduces non-deterministic multi-step loops, context explosion, unnecessary token expenditure, and hallucinated function arguments.
- **Budget enforcement in code:** Search budgets (5 first round, 3 second round, 8 total) and execution deadlines (25s request, 15s search cutoff, 10s model timeout, 4s search timeout) are strictly enforced by wrapping code, never delegated to model prompt instructions.

---

## 3. Cross-Conversation Temporal Memory

Minimi Recall Agent maintains continuity across distinct sessions without cloud databases or heavy infrastructure:

- **Per-Conversation Versioned JSON:** Each conversation is stored as an independent file in `.recall-data/<uuid>.json` complying with schema `recall.memory.v1`.
- **Dual-Scope Temporal Resolver (`dates.ts`):** Relative expressions are resolved deterministically using `chrono-node` paired with an explicit IANA timezone:
  - `conversation` scope: Locates when a conversation took place (e.g., `"What did we discuss last Wednesday?"`).
  - `external_event` scope: Resolves future or past real-world event dates mentioned in discussion (e.g., `"meeting on 23 August"`).
  - Explicit weekday isolation: `"last Wednesday"` targets the most recent Wednesday strictly prior to the reference day.
  - Fail-closed year preservation: When a user mentions a date without a year (`"meeting on 23 August"`), the system grounds the fact without inventing a current or future year.
- **Conservative Assertion Gate (`isPersonalAssertion`):** Filters out hypotheticals (`"Imagine I have a flight..."`), speculative questions (`"Should I attend AWS Summit...?"`), and third-party events (`"My brother has a flight..."`) so that only genuine user statements establish personal memory facts.
- **Chronological Edit Chains:** When events are modified across turns (`"Actually make that 18 September"`) or cancelled (`"The review was cancelled"`), ordinal linking ensures the latest state is recognized without discarding original historical auditability.

---

## 4. Historical Source Provenance and Citation Verification

- **Request-Local Source Registries:** Search results are assigned local identifiers (`S1`, `S2`, ...). Historical source `S1` and current source `S1` are strictly disambiguated in model context and persistent storage.
- **Verbatim Quotation Matching (`quoteMatches`):** Uses Unicode NFKC normalization, typographic quote stripping, and whitespace folding to verify that cited quotations exist in the source text shown to the model. Quotation mismatches produce a prominent warning: `quotation warning: a cited quotation did not match the exact available source text`.
- **Four Verification Verdicts:**
  1. **Confirmed change:** Credible comparable historical baseline and current evidence differ across identical dimensions.
  2. **No confirmed change:** Current evidence confirms identical pricing or feature state; explicitly disclaims being proof of universal non-change.
  3. **Cannot verify:** Baseline missing, evidence incomplete, or authority unknown.
  4. **Not comparable:** Material dimensions differ (e.g., monthly vs. annual billing, per-seat vs. total capacity, different regional tiers).
- **Domain Authority Whitelist (`OFFICIAL_PRODUCTS`):** Change confirmations are restricted to verified vendor domains (`supabase.com`, `neon.tech`, `salesforce.com`, etc.). Third-party review sites, blogs, and unmapped domains fail closed to `Cannot verify`.

---

## 5. Why No Vector Database or Extraction Agent Swarm

| Technique | Considered | Why Rejected for This Architecture |
| :--- | :--- | :--- |
| **Vector DB / Embeddings** | ChromaDB, Pinecone, pgvector | Introduces heavy external dependencies or native binaries. Embeddings are fuzzy, struggle with exact relative date arithmetic (`"last Tuesday"` vs `"two Tuesdays ago"`), cannot handle chronological cancellations reliably, and add cost/setup friction. Exact keyword + temporal anchoring is 100% deterministic and runs locally with zero setup. |
| **Agent Swarm / Multi-Agent LLMs** | LangGraph, AutoGen, CrewAI | Multi-agent coordination multiplies token usage, increases p95 latency far beyond the 25-second budget, introduces orchestrator race conditions, and complicates failure recovery. A single bounded loop with deterministic code wrappers is vastly faster and more dependable. |
| **LLM Query Router** | Secondary LLM extraction call | Adds 500–1,500ms of latency and token cost before any search can start. Deterministic regex and token extractors (`historicalLocator`, `recallIntent`, `isChangeRequest`) execute in sub-millisecond time at ₹0 cost. |

---

## 6. Failure Handling, Safeguards, and Honest Uncertainty

- **Hard Deadlines & Timeouts:** 25-second overall request deadline, 15-second search launch cutoff, 10-second model completion timeout, 4-second per-search timeout.
- **Client Disconnect Cancellation:** Fastify request socket abort signals propagate immediately to running model requests and search fetch jobs. Late results from disconnected clients are durably discarded without duplicate turn creation.
- **Single-Process Atomic Write Queues:** Per-conversation promise chains combined with temp-file writes and atomic renames prevent corrupted JSON files during sudden shutdowns or rapid sequential requests.
- **Honest Partial Coverage:** When searches fail (e.g., Tavily 500, network drop) or exceed timeouts, the agent marks the response status as `partial`, logs `search_failed`, and synthesizes a safe answer disclosing that live research was unavailable rather than hallucinating facts.

---

## 7. Trade-offs Summary

| Chosen Approach | Rejected Alternative | Core Rationale |
| :--- | :--- | :--- |
| **One bounded tool loop** | Multi-agent swarm / LLM router | Minimal latency, strictly bounded token cost, reproducible execution. |
| **Original JSON history on disk** | Summarization-only, FTS5, Vector DB | Exact factual recall, zero data loss, zero external service dependency. |
| **Single-server Fastify + SSE** | Microservices, React/Next.js, WebSockets | Portable zero-build setup, instant startup, clean native SSE streaming. |
| **Deterministic quotation/authority gates** | Pure LLM self-verification | Prevents subtle hallucinations from passing as verified factual changes. |

---

## 8. Reproducible Evaluation Evidence

The implementation is verified across extensive automated test suites and frozen offline evaluations:

- **Regression Test Suite:** **775 tests passed, 1 skipped** across 22 test files covering context selection, temporal resolution, memory HTTP APIs, SSE wire contracts, prompt injection resistance, and UI lifecycle.
- **Dedicated Scripted Evaluation (`npm run eval:offline`):**
  - **31 / 31 (100%)** structural and safety assertions passed.
  - **30 / 31 (96.8%)** usefulness assertions passed.
  - C8 represents a documented restrictive abstention: the evaluation oracle accepts a fictional synthetic domain (`acme.example`), whereas production correctly enforces the official authority whitelist.
- **Adversarial Capability Evaluation (`tests/adversarial-eval.test.ts`):**
  - **10 / 10 (100%)** passed across paraphrased recall, weekday isolation, mixed shortlist research, PostgreSQL pricing comparison, hypothetical rejection, chronological cancellation, quotation mismatch warning, search outage handling, long-history token budgeting, and multi-turn thread recovery.

*(Note: Scripted and mocked evaluation tests measure deterministic application orchestration, safety guards, and contract compliance; they do not measure live third-party LLM accuracy or live network latency.)*

---

## 9. Known Limitations

1. **Single-Process JSON Storage:** Storage is engineered for single-process local operation. Concurrent processes sharing `.recall-data/` or multi-tenant cloud scaling would require a transactional database.
2. **Anchor-Based Keyword Retrieval:** Non-calendar topic recall relies on query anchor overlap. Queries must mention the primary subject noun or entity from the earlier discussion.
3. **Structured Date Grammar:** Relative calendar expressions support `today`, `yesterday`, `<weekday>`, `last <weekday>`, `last week`, `N days ago`, `YYYY-MM-DD`, and named day/month formats (`25 October`). Broad rolling phrases like `"last month"` or `"last year"` are rejected as unsupported dates rather than guessed.
4. **Model Streaming Transport:** The Azure OpenAI v1 adapter operates in request-response mode (`stream: false`), emitting SSE progress events and a final synthesized result. Full token-by-token streaming remains a future protocol enhancement.
5. **Fixed Authority Whitelist:** Change confirmations are restricted to domains registered in `OFFICIAL_PRODUCTS`. Unlisted enterprise vendors will yield `Cannot verify`.
