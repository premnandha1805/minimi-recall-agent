# HTTP chat contract: recall.chat.v1

This interim integration uses **SSE progress plus one validated final/partial
answer, not token streaming**. The existing Azure adapter sends `stream: false`.
True token streaming remains a future requirement. Server-backed browser restoration and receipt acknowledgment are implemented;
temporal recall/context integration and quotation verification remain outstanding. Live Azure
deployment compatibility, account quota and measured live latency are unverified.

## Request and credential preflight

`POST /api/chat` accepts the unchanged `ChatRequestSchema`: message (1–16,000
characters), optional safe conversationId (128 characters), IANA timezone, and up
to 100 timestamped history messages (32,000 characters each). The default body
limit is 262,144 bytes; server configuration can lower or raise it within existing
validated bounds. The browser keeps its existing bounded history suffix and
visible omission notice. This is not persistent or date-anchored memory.

Both `createModelProvider(config)` and `createTavilySearch(config)` must construct
successfully before execution, including for no-search questions. Unsupported
model selection or missing Tavily configuration returns HTTP 503
`CHAT_NOT_CONFIGURED`, without spending model tokens or making search requests.
This is local configuration validation, **not** verification of credentials or
quota with either provider. Credential-free startup remains possible under the
existing rules; explicitly selecting Azure with missing required fields still
fails environment validation at startup. Keys remain on the server.

Input errors retain existing JSON envelopes and HTTP 400/413/415. A deadline
before SSE headers produces HTTP 504. Unexpected pre-stream errors use sanitized
HTTP 500. These responses use `{ error: { code, message, details? }, requestId,
conversationId? }`. Health indicates server availability, not provider readiness.

## Events and schemas

Authoritative runtime schemas and TypeScript types are in `src/contracts.ts`.
HTTP 200 uses `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform, no-store`, `X-Content-Type-Options: nosniff` and a
server-generated UUID in `X-Request-Id`. The version is independent of app version.

| Event | Payload | Cardinality |
| --- | --- | --- |
| `meta` | `{ version: "recall.chat.v1", requestId, conversationId, answerMode: "final" }` | First, once |
| `progress` | `{ phase: "accepted" }`, `{ phase: "model_started", call }`, or `{ phase: "search_started", attempt }` | Accepted once, then real admitted calls only |
| `result` | `{ message: { id, role: "assistant", content, timestamp }, coverage, issues, sources, evidenceCheck: "citation_ids_only" }` | At most once |
| `error` | `{ code, message }` | At most once, mutually exclusive with result |
| `done` | `{ outcome: "completed" | "partial", messageId }` or `{ outcome: "failed" | "cancelled" }` | Sole terminal event, once |

Success order: `meta → accepted → progress* → result → done`.
Failure order: `meta → accepted → progress* → error → done`.
There are no progress events after result/error and no events after done. A
disconnected peer may receive no terminal event; exactly-once ownership cannot
guarantee delivery. The result and done frames are validated/serialized before
either is written, and sent together without an asynchronous gap.

Model calls count upward from 1 to at most 3. Search attempts count upward from
1 to at most 8; duplicates and budget/cutoff rejections do not emit search progress.
Progress reports admitted adapter calls, not successful retrieval or verified facts.
No simulated percentages, token events, replay IDs, heartbeats or retries exist.

Message and conversation IDs use `[a-zA-Z0-9_-]+`, maximum 128 characters.
The assistant message timestamp is the server's observed UTC completion time;
content is nonblank and at most 16,000 characters. `coverage` is `complete` with
no issues or `partial` with at least one issue. It describes execution limitations,
not item-by-item factual coverage or correctness.

Issues are unique members of `search_budget_exhausted`, `search_cutoff`,
`search_unavailable`, `search_timeout`, `search_failed`, `search_invalid_results`.
At most 24 sources are sent. Each source is `{ id, query, title, url, retrieved_at,
published_at?, effective_at? }`: unique `S[1-9][0-9]*` ID (up to 128 characters),
query/title up to 500 characters, URL up to 2,048 characters. URLs must be absolute
HTTP(S) with no embedded credentials. Retrieval dates are ISO timestamps with
offsets; optional evidence dates are valid ISO dates or timestamps. Missing dates
stay absent. No effective date is inferred. Raw source text stays in the core's
registry, exactly as truncated for model input; it is not duplicated in the browser.

Citation markers `[S1]`, etc., including bracket-escaped forms `\[S1\]`,
`\[S1]` and `[S1\]`, must resolve within this answer's source registry.
Core, result-schema and browser validation apply the same marker grammar, even
inside literal code spans. Unknown escaped IDs fail as `INVALID_CITATION` in the
core; this tightens validation without changing event shapes or the version.
Registered markers outside code spans become links. **Citation ID checks do not verify quotations
or factual claims.** Retrieved text and history remain untrusted data. The UI uses
text nodes and explicit links, never raw HTML or a Markdown library. Its small
inline formatter protects same-line matching backtick runs first and preserves
their contents exactly. Paired standalone `**`/`__` delimiters, including paired
escaped bold delimiters, render as bold. Isolated escapes remain literal; there
is no general Markdown, block-code or mathematical typesetting implementation. Historical
assistant text is context, not independently established evidence of a baseline.

## Framing, limits and browser acceptance

The server emits `event: <name>\ndata: <JSON>\n\n` using `JSON.stringify`; embedded
newlines remain JSON escapes. Each frame is bounded to 1 MiB and the entire stream
to 2 MiB. Objects are strict: unknown properties, event names and versions fail.

The POST fetch reader incrementally decodes fatal UTF-8 across arbitrary byte
boundaries. It accepts LF, CRLF and CR, joins multiple `data:` lines with newline,
dispatches on blank lines, and ignores comments before completion. Unsupported SSE
fields and repeated event fields fail. EOF with unfinished framing, malformed
JSON, invalid UTF-8, invalid payloads/order, duplicate completion, mismatched IDs,
overflow or absent completion produces a protocol error. No automatic reconnect.

HTTP 200 alone is not success. The browser requires matching result/done **and
clean EOF** before displaying an accepted answer. A body read failure, cancellation
or 30-second transport watchdog prevents acceptance even after result/done bytes
arrived. The watchdog does not extend server execution. Pending readers are
cancelled and locks, signal listeners and watchdog timers are cleaned up.

Only `done(completed)` answers enter later request history, once, using original
server message ID/text/timestamp. Research-partial answers remain visible with
limitations and Sources, but do not enter later history. Progress, placeholders,
errors and disconnected/cancelled/malformed answers never become assistant history.

## Execution, cancellation and failures

The existing core remains the sole budget owner: 3 model calls, 2 research rounds,
5+3 search attempts, concurrency 2, 4-second search timeout, 10-second model
timeout, 15-second search admission cutoff, and at most 25 seconds overall.
Request arrival time and `request.executionSignal` are propagated, not restarted
after parsing. Existing token/context limits and deterministic IDs are unchanged.

After Fastify hijack, `SseResponse` owns raw headers/writes/completion. Actual
socket close, request abort or premature response close cancels work. Normal POST
body completion is not a disconnect. Writes never target an ended/destroyed
response. Drain waits stop on cancellation; a blocked socket is destroyed at the
deadline. Otherwise timeout sends a sanitized error/done best effort. Late work
and promise rejections are observed and cannot send a second response. A provider
ignoring cancellation cannot be forcibly stopped, but its late output is discarded.

Public SSE errors are `REQUEST_TIMEOUT`, `MODEL_TIMEOUT`, `MODEL_FAILED`,
`INVALID_MODEL_OUTPUT`, `INVALID_CITATION`, `CONTEXT_LIMIT`, `AGENT_LIMIT`,
`CANCELLED`, `INTERNAL_ERROR`, with fixed safe messages. Azure authentication,
quota/rate limits, incompatible deployments and other upstream HTTP errors all
map to `MODEL_FAILED`: the existing adapter/core do not preserve a finer category.
Never infer a specific cause or expose upstream bodies/URLs/keys. Tavily failures
become explicit core research issues; synthesis may return a partial answer before
the deadline. No fallback answer is invented after a hard timeout.

## Offline verification

`tests/sse.test.ts` covers framing/schema parity, Unicode, truncation, limits,
watchdog and writer backpressure. `tests/chat-stream.test.ts` exercises Fastify,
the unchanged core and real adapters with mocked fetch, including loopback socket
disconnect. `tests/ui.test.ts` covers rendering, history policy and existing
interactions. Existing adapter, agent and safeguard regressions remain required.

```powershell
npm.cmd run typecheck
npm.cmd test
git diff --check
git status --short --branch
```

All automated provider calls use fixtures. Live compatibility and latency require
a separately authorized smoke test with verified available free quota. This stage
does not claim the full live-search/token-streaming acceptance gate is complete.

Memory HTTP integration now persists chat attempts and evidence before result delivery.
Optional turn keys, identity headers, explicit receipts and provider-free recovery
are documented in [memory.md](memory.md#milestone-3-http-integration). The five
SSE payload shapes remain unchanged. Error notices say no answer was accepted,
which does not deny that an unaccepted generated snapshot may exist on disk.


The browser now sends the optional turn keys, remembers only the canonical
conversation ID, restores server messages and sources, and explicitly acknowledges
complete SSE results after clean EOF. Pending recovery uses memory HTTP endpoints,
not chat. Receipt failures and research-partial answers are excluded from trusted
assistant history. See [browser memory behavior](memory.md#milestone-4-browser-integration).
