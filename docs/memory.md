# Local memory, retrieval and delivery

The application is single-user and single-process. The default archive is `<project>/.data/conversations/`; configured relative paths resolve against the project root. Startup imports the legacy `.recall-data/` archive only when the new default does not exist, retaining originals. Do not share an archive between independent running processes.

## Stored identities and writes

`ConversationSchema` in `src/memory.ts` is the canonical `recall.memory.v1` schema. Each conversation has server-owned identity, revision, UTC timestamps, optional timezone, imported seed messages and ordered server turns. Filenames hash validated UUIDs. Client legacy keys map to server identities; they do not become filesystem paths.

Turns retain original user text and stable ordinal order. Attempts progress through running/generated/awaiting-receipt/accepted/partial or terminal failure states. Retry keys are idempotent; later completion time does not reorder an earlier turn. Imported history merges by supplied ID or role/timestamp/content hash. Server copies win on conflicts; imported assistant text is not authoritative historical evidence.

A per-conversation promise chain serializes changes. A commit queue coordinates the archive snapshot and filesystem writes. Files are size-bounded, written to exclusive same-directory temporary files, flushed and atomically renamed. Production snapshots update after commit. Validated previous revisions support bounded recovery of malformed/empty JSON; damaged originals are retained privately. Unsupported schemas, identity mismatches and unexpected/symlink paths fail closed. These safeguards are not a distributed lock or a guarantee for arbitrary network filesystems.

HTTP storage supports up to 1000 conversations, pages of at most 50, up to 500 turns per conversation and eight attempts per turn, subject to byte/entry/seed limits in `MEMORY_LIMITS`. The standalone store's default capacity is smaller; the HTTP server explicitly supplies its 1000-conversation limit.

## Context and temporal recall

Every chat retrieves a coherent committed archive view. Intent controls answer mode, not whether archive access occurs. Active conversation context is retained alongside bounded historical matches. When complete history cannot fit, selection uses dates, lexical anchors, modest stemming, majority overlap, inverse-document-frequency scores and contextual neighbors. This is lexical retrieval, not BM25, embeddings or general semantic reasoning.

Messages keep their original UTC timestamps and wording. Relative mentions are interpreted against their original time reference; message dates are distinct from event dates. Historical yearless dates choose the most recent past occurrence, and last Tuesday is strictly before the user's local today. Explicit request timezones win; otherwise `DEFAULT_TIMEZONE` applies. An absent event year never proves that an event is upcoming.

Retrieved questions, assistant suggestions and hypothetical statements are not user facts. Corrections and competing events remain distinguishable. Matching a keyword or being adjacent does not prove two records describe one event. Context/scan limits are disclosed rather than silently deleting originals. Safe recall may render original quotations when model prose cannot pass grounding; this is labeled recovery.

## HTTP and browser synchronization

Local same-origin/loopback checks protect conversation and chat routes. No client-supplied user ID creates authenticated ownership. Conversation create/list/get routes work without Azure or Tavily configuration.

The browser stores only an active conversation ID in localStorage and reopens authoritative server records. A complete streamed result is persisted before delivery. Browser receipt acknowledges the exact conversation/turn/attempt/message identity. Unacknowledged, partial and failed assistants do not silently become accepted factual history. Result recovery and idempotent replay avoid another model call when the answer is already stored.

The sidebar paginates through the HTTP capacity and preserves the current view on refresh errors. A configuration rejection happens before a new user turn is saved; the UI ends the pending-save state rather than claiming persistence.

## Privacy and verification

`.env`, both archives, backups, logs and generated reports are ignored. Operational logs contain request IDs, counts, scores and stages, never conversation excerpts. The local memory diagnostics endpoint is enabled in development and only explicitly in production; it returns private storage metadata/titles, so it must not be exposed publicly. `DEBUG_MEMORY` does not enable raw text logs.

`memory.test.ts`, `memory-http.test.ts`, `memory-review.test.ts`, `context.test.ts`, `dates.test.ts`, `ui-memory.test.ts`, and `live-memory-regression.test.ts` cover concurrent writes, seed conflicts, restart/corruption, long histories, temporal boundaries, receipt recovery and cross-conversation lookup. See [evaluation.md](evaluation.md) for mocked/live distinctions and [ENGINEERING_JOURNEY.md](ENGINEERING_JOURNEY.md) for the actual incident history.