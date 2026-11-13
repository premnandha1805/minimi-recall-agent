# Tavily search adapter

The backend exports `createTavilySearch(config, fetchImpl?)` from `src/search.ts`.
It returns the existing `WebSearch` function; inject it as `runAgent`'s `search`
option. Without a configured key, omit that option so the core reports unavailable
search. Constructing the adapter without a key throws `NOT_CONFIGURED`. Server
startup requires no credentials, and `/api/chat` retains its honest HTTP 501 response.
Nothing automatically calls Tavily on startup, import, or during `npm test`.

## Verified request contract

One native-fetch `POST https://api.tavily.com/search` with an
`Authorization: Bearer <TAVILY_API_KEY>` header and JSON:

```json
{
  "query": "<validated query>",
  "search_depth": "basic",
  "topic": "general",
  "max_results": 3,
  "auto_parameters": false,
  "include_answer": false,
  "include_images": false,
  "include_raw_content": false,
  "include_published_date": true,
  "include_usage": true
}
```

No generated answer, full-page extraction, images, date filters, additional tools,
redirects, parameter auto-upgrades, or retries. Snippets are the provider's
`results[].content`, not Tavily's generated `answer` or `raw_content`.

The [official Search API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
documents this shape, publication metadata, `usage.credits`, and basic search at
one API credit. This is a provider price, not a claim that the current account has
free credits. Eligibility and available quota must be checked by the user.

## Evidence and failure behavior

Titles and URLs are preserved exactly. Snippets retain their original characters
up to the existing 2,000-character cap. The source registry and model receive the
same truncated text; Tavily result IDs are ignored. `SearchSession` remains the
owner of deterministic request-local `S1`, `S2`, ... IDs.

Only HTTP/HTTPS source URLs without embedded credentials are accepted. Missing,
blank or wrongly typed title/content, unsupported URLs, missing `results`, more
than three results, invalid JSON/UTF-8 or oversized bodies reject the entire query.
This avoids silently dropping evidence while presenting an apparently complete
result set. An explicit empty `results` array is a genuine zero-result success.
Unknown fields are ignored; none become instructions or sources.

Publication dates are optional. Valid ISO date-only values remain date-only and
ISO timestamps keep their explicit offsets. The documented RFC 1123 GMT form is
converted to the equivalent UTC ISO timestamp after strict calendar/weekday
validation. Missing, invalid or ambiguous dates stay absent; they are never
replaced by retrieval time. `retrieved_at` records when this adapter received and
validated the response. No `effective_at` is inferred from Tavily metadata or text.

The adapter bounds actual response bytes at 128 KiB, including chunked bodies and
false Content-Length headers. It aborts fetch and pending body reads after four
seconds or earlier caller cancellation, releases reader locks, cancels unfinished
bodies, removes timers/listeners and observes late failures. A transport ignoring
AbortSignal cannot be forcibly killed; a late response is discarded and its body
cancelled. No replacement requests are issued by this adapter.

Sanitized `TavilySearchError` codes distinguish configuration, bad query/request,
authorization (401/403), rate limit (429), quota (432/433), unavailability (434),
timeout (408/504 or local deadline), other provider errors, invalid/oversized
responses, network failure and cancellation. No key, query, header, raw error body,
stack cause, or private upstream detail is copied into these errors. The existing
`SearchSession` exposes its existing coarse statuses (`failed`, `timeout`, etc.);
its cancellation propagation and agent orchestration are unchanged.

Admission still belongs to the existing core: 25 seconds overall, new searches
stop at 15 seconds, two concurrent requests, five searches in round one and three
in round two, eight total, normalized query deduplication, and failures counted.
Use the adapter through that core; calling the low-level `searchTavily` function
directly is intended for a single explicitly initiated smoke request, not a second
agent orchestration path.

## Optional manual live smoke test

This procedure was **not run during implementation**. First verify that your
account has an available free credit. Do not enable billing, purchase credits or
increase limits. Put your actual key in the local ignored `.env` file, replacing
the placeholder; never commit it or place it in command history.

From `D:\Minimi Recall Agent` in PowerShell, explicitly initiate:

```powershell
npm.cmd run smoke:tavily -- --live
```

Without `--live`, the command exits without loading credentials or making a call.
With it, the command makes exactly one basic request for the fixed harmless query
“What is the Internet Engineering Task Force?” There is no LLM call. It prints
only status, result count, elapsed milliseconds, number of known publication dates,
and provider-reported credits. Missing usage is `null`, never an invented zero or
an assumed one. Failures print a sanitized code and unknown credit usage; check
the dashboard before deciding whether to retry. A failed request may still consume
credits. The command does not change account settings.

Offline verification:

```powershell
npm.cmd run typecheck
npm.cmd test -- tests/tavily.test.ts
npm.cmd test
git diff --check
git status --short --branch
```

Remaining work: live provider verification, designated SSE/HTTP/frontend
integration, memory/date anchoring and quote/claim verification. This feature does
not complete the full live chat acceptance gate or establish source claim support.
