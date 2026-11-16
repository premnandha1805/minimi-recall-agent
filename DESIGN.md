# Recall — System Architecture

**Problem.** “On Monday we shortlisted five CRMs. Has anything changed?” A useful agent must reliably answer which five were shortlisted, what was stated when, and whether today's evidence confirms a genuine change. Recall addresses this through deterministic temporal memory, bounded web search, and evidence verification.

```
Browser (vanilla JS) ──> Fastify HTTP ──> [Deterministic Memory & Dates]
                                                │
                                    ┌───────────┴───────────┐
                          (Pure recall: 0 search)   (Mixed / Research)
                                    │                       │
                                    ▼                       ▼
                           Model synthesis  <───> Tavily web_search (≤2 rds, ≤8 queries)
                                    │
                       [Quotation & Change Checks]
                                    │
                                    ▼
                 Atomic JSON write (.recall-data/) + SSE stream
```

## 1. How It Works

- **Single Tool Loop:** `web_search` is the sole external model tool ([agent core](docs/agent-core.md)); memory, dates, citations, and storage are internal functions. Execution is strictly bounded: &le;2 search rounds (up to 5 initial + 3 follow-up), &le;8 queries, 2-way concurrency, and a 15s search cutoff within a 25s deadline.
- **Temporal Memory:** Conversations persist as versioned JSON in `.recall-data/` ([memory spec](docs/memory.md)). `chrono-node` and IANA timezones resolve relative dates (`conversation` vs `external_event`). An assertion gate filters hypotheticals and questions; chronological chains preserve edits and cancellations, with conservative calendar checks. Pure recall consumes zero search calls.
- **Verification Gates:** Search results receive request-local source IDs (`[S#]`). Quotations must match source snippets verbatim ([verification spec](docs/verification.md)). Historical comparisons evaluate like-for-like dimensions against an official domain whitelist (`OFFICIAL_PRODUCTS`) across four verdicts: *Confirmed change*, *No confirmed change*, *Cannot verify*, or *Not comparable*.

## 2. Why This Design

We prioritized correctness and bounded execution over autonomous complexity: internal memory routing eliminates search latency and API costs; deterministic code gates guard against unsupported claims and quotation mismatches; bounded timeouts, disconnect aborts, and atomic temp-file writes support clean recovery with explicit disclosures on search outages.

## 3. Trade-offs

- **No Vector DB:** Embeddings introduce fuzzy matching, external daemons, and poor relative calendar arithmetic (`"last Wednesday"` vs `"two Wednesdays ago"`). Keyword + temporal anchoring is deterministic and zero-setup.
- **No LLM Fact Routers:** Secondary LLM routing calls add an extra network round-trip and token overhead before search begins; deterministic extractors parse intent directly in-process.
- **No Multi-Agent Swarms:** Swarms multiply token cost, introduce race conditions, and risk exceeding the 25s deadline.
- **Bounded Research:** Strict 5+3 query caps prevent runaway spending while ensuring synthesis time.

## 4. What We Would Improve With Another Week

1. **Broader Semantic Recall:** Lightweight BM25 or local token-stemming for wider paraphrasing without vector infrastructure.
2. **True Token Streaming:** Upgrade the Azure OpenAI adapter from request-response (`stream: false`) to live token-by-token SSE streaming ([SSE wire contract](docs/chat-sse.md)).
3. **Live Latency & Quality Benchmarks:** Measure p50/p95 latency and factual accuracy against an always-search baseline across production LLMs.

---

**Grounded Evaluation:** Automated test suite records **791 passed, 1 skipped** across 23 test files; **31/31** scripted safety passes and **30/31** usefulness passes ([evaluation report](docs/evaluation.md); C8 reflects an intentional authority whitelist abstention); and **10/10** mocked adversarial capability passes. *(Measures deterministic orchestration and safety guards, not live model accuracy or network latency.)*
