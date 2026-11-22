# Chat HTTP/SSE contract: recall.chat.v1

The authoritative schemas are in `src/contracts.ts`; the server owns framing in `src/sse.ts`, and the browser validates streams in `public/api.js`. Production Azure output streams. The native JSON adapter remains an injectable non-streaming boundary for compatible callers and frozen tests.

## Admission and liveness

`POST /api/chat` accepts a message, optional safe conversation ID, optional IANA timezone, up to 100 timestamped history messages, and optional stable turn/attempt keys. Input/body limits come from the shared schemas/configuration. Server copies win when supplied history conflicts. Missing timezone uses `DEFAULT_TIMEZONE`.

Provider factories must be configured before a turn is stored, even for a no-search answer. Unsupported selection or missing Tavily configuration returns HTTP 503 `CHAT_NOT_CONFIGURED` without provider requests. Explicit Azure selection with incomplete required fields fails startup validation. Otherwise, credential-free startup and conversation routes are supported.

`GET /health` returns liveness, application identity/version, timestamp, and `chatConfigured`. That boolean checks required configuration presence; it does not authenticate with providers, prove quota, or certify storage health. Input errors use JSON envelopes and HTTP 400/413/415; a deadline before streaming produces 504. Unexpected failures are sanitized.

## Stream lifecycle

HTTP 200 uses `text/event-stream`, no-store/no-transform cache controls, nosniff, and a server-generated request ID. The protocol version is independent of the application version.

| Event | Meaning |
| --- | --- |
| `meta` | First frame: version, requestId, conversationId and `answerMode: final` |
| `progress` | accepted, model_started with call, search_started or research_started with attempt; schema-bounded counters |
| `delta` | Provisional visible text; never an accepted assistant message by itself |
| `result` | Validated assistant message, coverage/issues, current source metadata, `evidenceCheck: citation_ids_only`; optional memory/generation provenance |
| `error` | Fixed sanitized failure code/message; mutually exclusive with result |
| `done` | Sole terminal frame: completed/partial with message ID, or failed/cancelled |

Success is `meta -> accepted -> (progress/delta)* -> result -> done`. Failure replaces result with error. No frames follow done. The reader requires valid terminal framing and clean EOF before treating delivery as successful. A disconnected peer may receive no terminal frame; server ownership does not guarantee network delivery.

The final result replaces drafts. Ordinary non-recall requests may stream as the provider generates text. Historical recall/comparison suppresses unvalidated prose and internal comparison JSON; validated text can then arrive through delta. Raw provider first-token latency and first visible delta latency are therefore different measurements.

Coverage is complete when execution issues are empty, otherwise partial. It describes research execution, not universal factual accuracy or complete product coverage. Search issues are limited to the shared schema's budget/cutoff/unavailable/timeout/failure/invalid-result categories. Model/search counters remain inside the three-call and 5+3 search bounds.

## Sources and rendering

Each result has at most 24 registered current sources, with query/title/URL/retrieval time and optional known publication/effective dates. Missing dates stay absent. SSE sends source metadata, not its full evidence text. Current markers such as `[S1]`, including recognized escaped forms, must resolve to this result's registry. Historical source markers are projected with their original scope and never promoted to current citations.

The client renders text and vetted links without executing model HTML. Its bounded inline formatter preserves code, literal escapes and reader state. Matching citation IDs does not prove claim support. Constrained quote/comparison checks are described in answer text; `evidenceCheck: citation_ids_only` must not be interpreted as universal factual certification. See [verification.md](verification.md).

## Persistence, receipts and retries

The user turn is durable before model work. A generated result is saved before SSE completion. Complete browser delivery and authoritative identity synchronization are followed by an exact message receipt. Pending/partial/failed assistants do not silently enter accepted history. Reopening can recover a saved awaiting-receipt answer; an idempotent retry can replay it without new model calls. Network failure alone does not prove whether a user turn was saved. A known configuration rejection happens before its new turn is stored and is labeled accordingly.

See [memory.md](memory.md) for identities, queueing, local access and storage limits. `chat-stream.test.ts`, `sse.test.ts`, `ui-memory.test.ts`, `ui-retry.test.ts` and `production-correctness.test.ts` exercise framing, cancellation, draft suppression, receipts, malformed output and replay. Live/DOM/manual-browser verification are distinguished in [evaluation.md](evaluation.md).