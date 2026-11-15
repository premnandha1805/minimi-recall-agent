# Tavily search adapter

The backend exports `createTavilySearch(config, fetchImpl?)` from `src/search.ts`.
It returns the existing `WebSearch` function; inject it as `runAgent`'s `search`
option. The internal core can still report unavailable search when that option is
omitted, but **HTTP chat now requires both supported Azure configuration and valid
local Tavily configuration before execution**, even for a no-search answer.
Missing configuration returns sanitized HTTP 503 with zero model/search requests.
Constructing the adapter without a key throws `NOT_CONFIGURED`. Credential-free
startup remains possible under existing environment rules; explicitly choosing
Azure still requires its fields at startup. No quota/authentication probe is made.
Nothing calls Tavily on startup, import, or during `npm test`. A configured chat
request can call it through the core. See [the SSE contract](chat-sse.md).

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

### Request-local URL identity and relevance

Before assigning IDs, `SearchSession` deduplicates validated sources using an
internal URL key. Standard URL parsing normalizes host casing, default ports and
the empty root path. Only the exact lowercase query keys `utm_source`,
`utm_medium`, `utm_campaign`, `utm_term` and `utm_content` are removed from the
key. Signed/tokenized queries (`sig`, `signature`, `token`, `x-amz-*`, `x-goog-*`)
retain all parameters. Unknown parameters, parameter ordering/encoding, HTTP vs
HTTPS, non-root trailing slashes and fragments (including PDF page selectors and
hash routes) remain distinct. No title-based merging, redirect following, URL
rewriting or publication-date inference occurs.

The first retained occurrence owns the exact provider URL, title, dates and
truncated text for the rest of this request. Repeated results reuse that source
object and ID; each enclosing internal query outcome preserves retrieval-query
provenance. Conflicting later snippets are not merged into or substituted for
evidence already sent to the model. Sources are assigned in query order, never
network completion order. Within a query, an explicitly requested `site:` match
with lexical overlap and no year conflict is stably preferred; otherwise provider
order is preserved. No existing source ID is renumbered in a later round.

Internal tool outcomes include `relevance` assessments keyed by source ID. These
carry bounded query-term overlap counts, explicit title/path year signals, and
whether an explicit query `site:` constraint matches the hostname boundary.
The original user question supplies lexical/year intent; the query is the fallback.
Less than half of the selected terms matching, or an explicit year conflict, is
marked `weak`; all other evidence remains `uncertain`, never verified. Multiple
requested years remain temporally unknown. Publication years are not event years.
These signals do not remove results or alter the public source/SSE schemas. The
prompt asks the model to scrutinize entity, event and time period and disclose
uncertainty. There is no general official-domain classifier, semantic relevance
verifier, quotation check or demonstrated improvement in live accuracy.

URL deduplication reduces registry/context duplication but does not avoid distinct
queries: different queries can reveal additional evidence. Existing normalized
query deduplication, provider-call counting and all execution limits remain intact.
Frozen fixtures verify 15 returned records becoming 11 registry entries and nine
becoming seven; these are synthetic offline cases, not measured live outcomes.

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

HTTP/frontend integration uses SSE progress plus a final answer, **not token
streaming**. True token streaming, live provider compatibility and latency
verification, memory/temporal recall and quote/claim verification remain outstanding.
Citation-ID checks do not establish factual verification. This stage does not
complete the full live chat acceptance gate.
