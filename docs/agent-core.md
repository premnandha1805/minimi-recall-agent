# Feature 4: internal agent core

`runAgent(request, { provider, signal, search? })` is an internal TypeScript API.
`createModelProvider(loadConfig())` selects the configured adapter. There is no new
HTTP assistant schema or SSE format. `POST /api/chat` still returns the existing
501 error envelope; merely setting a key does not trigger model calls.

The loop uses at most three model requests: up to two tool-call rounds followed
by synthesis with tools disabled. One round is one model response, including all
its `web_search` calls. Each call accepts `{ queries: string[] }`. The single
request-local budget permits five actual search requests in round one and three
in round two, eight total, with two concurrent provider requests. Failed calls
count; normalized duplicate queries do not run again. There are no retries.
Search admission stops at 15 seconds; each search has a four-second timeout.
After a search timeout, no replacements start, even if a provider ignores abort.

The overall limit is 25 seconds (or a smaller caller limit). Pass the existing
`request.executionSignal` to inherit the server's arrival deadline/disconnect;
pass a monotonic `startedAt` from request arrival when wiring HTTP so the search
cutoff also includes request parsing time. Model calls have a ten-second timeout.
Timers and parent abort listeners are disposed. Late promise rejections are
observed even when a provider ignores cancellation; synchronous CPU work cannot
be interrupted.

Each model request reserves at most 2,048 output tokens; at most 6,144 can be
reserved for a run, including failed calls or missing usage reports. Smaller
caller budgets are allowed. Input context is bounded by 65,536 serialized UTF-8
bytes and a conservative byte count plus framing allowance and reserved output
against the configured deployment context window. This is not an exact tokenizer.
Oversized context fails explicitly; history is never silently dropped. Date and
keyword anchoring remains part of the later memory feature.

The result includes status/reason, optional model answer, source registry, explicit
research issues, counters and reported usage. Consumers must display partial
coverage/issues alongside answers. Empty, malformed, filtered, truncated or
unknown-citation output is rejected, not converted to a successful answer.
Malformed/unsupported tool calls and repeated tool-call IDs stop the loop.
Duplicate queries are reported to the model; an all-duplicate round ends research.

`WebSearch` is an injectable boundary. `createTavilySearch(config)` now provides a
real basic-search implementation (see [web-search.md](./web-search.md)). Each
admitted invocation makes one provider request and honors its signal. The adapter
supplies provider title/URL/snippets, an observed retrieval timestamp, and only
valid explicit publication dates. At most three documents per query are accepted;
text is limited to 2,000 characters before both model context and source storage.
Source IDs are unique per run and assigned in query order. Unavailable search is
an explicit tool result, not an empty successful search. Tests use labeled fixtures.
Citation-ID validation is not claim support or quotation verification.

## Azure adapter scope

The native-fetch adapter is limited to Azure OpenAI **v1 Chat Completions**, using
the exact configured HTTPS `/openai/v1/chat/completions` URL, deployment name,
`api-key` authentication, `messages`, function `tools`, `tool_choice`, and
`max_completion_tokens`. It requests non-streaming text only. It rejects multiple
choices, invalid JSON, malformed responses, oversized response bodies (128 KiB),
and redirects. API response bodies, keys, URLs and provider error messages are
not exposed through core errors. No API-version query is guessed or appended.

Reference verified during implementation:
[Microsoft Azure OpenAI v1 REST specification](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat).
Not supported here: legacy dated Azure APIs, Responses API, generic Azure AI
Inference, Entra authentication, arbitrary model-specific parameters, streaming,
or other provider adapters. A model must explicitly support the listed features;
the Azure label alone does not establish compatibility or free/student eligibility.

## Remaining integration

The frozen design's target architecture is unchanged. This feature deliberately
does not complete its SSE/live-search gate: an agreed SSE event contract, model
streaming, frontend consumption, wiring the Tavily adapter into HTTP execution,
persistent history/date anchoring, and
quote verification still need implementation. Do not expose the internal result
as an invented HTTP 200 payload. No live credentials/quota or live latency have
been verified. Existing environment defaults do not imply an implemented Gemini
adapter. Selecting an unsupported provider fails explicitly in the core factory.

Offline verification (PowerShell):

```powershell
npm.cmd run typecheck
npm.cmd test -- tests/agent.test.ts tests/model.test.ts
npm.cmd test
git diff --check
git status --short --branch
```
