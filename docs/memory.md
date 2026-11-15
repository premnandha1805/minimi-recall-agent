# Durable conversation storage — Gate 2, Milestone 1

`src/memory.ts` now connects to Fastify through `src/memory-http.ts`. The browser now restores server conversations and sends explicit complete-answer
receipts. Deterministic bounded context retrieval is now connected to chat;
historical/current factual comparison remains outstanding.

## Ownership and schema

Open one `ConversationStore` per private directory, once at process startup, and
close it during shutdown. The default is `.recall-data/`, excluded from Git.
The directory must not be inside `public/`. IDs are server-generated UUIDs;
filenames are SHA-256 of the conversation ID, avoiding traversal, Windows reserved
names and filename case collisions. Input idempotency keys are bounded opaque
keys, not filenames or message IDs. Never accept a caller-supplied ID generator
from an HTTP request; the optional generator/clock arguments are test seams.

Every JSON document has version `recall.memory.v1`, conversation identity,
revision, UTC creation/update times, optional IANA timezone, seeded messages,
and ordered turns. Server-recorded turns hold the original user message and
ordered attempts. A turn's ordinal is stable even if an old failed turn is retried
after later turns. Completion timestamps never determine logical order.

`addTurn` and `startAttempt` return the existing server record for a repeated key,
including conflicting replay content. Repeated generated results preserve the
original server snapshot. Seed imports merge by supplied message ID or SHA-256
of `[role, normalized UTC timestamp, exact content]`; first stored copy wins.
Messages matching known server message IDs cannot replace or promote those records.
Imports retain supplied order, supplied IDs separately, normalized original UTC
timestamps, receipt times and `client_seed` provenance. Their canonical IDs are
server-generated. Imported assistant messages are unverified historical data,
not accepted server attempts; a later context selector must preserve that distinction.
Seeded messages are separate from turns because missing turn associations cannot
be reconstructed honestly. No API history loader is implemented here.

## Attempt lifecycle

`running -> generated -> awaiting_receipt -> accepted | partial`

- `saveGenerated` validates the existing ChatResult shape and matching source
  snapshots, then assigns the stored assistant ID and UTC completion timestamp.
  The supplied answer ID/time are not authoritative. Return this stored result
  when HTTP integration is implemented.
- Each snapshot contains the exact evidence text supplied by the caller (maximum
  2,000 characters/source), original URL, query and known dates. Snapshot metadata
  must match the answer registry exactly. The storage layer cannot independently
  prove what was sent to a model. No text is truncated or invented here.
- Receipt acknowledgment requires both the correct attempt and stored assistant
  message ID. A complete answer becomes `accepted`; a research-partial answer
  becomes `partial`, never accepted history. Repeated acknowledgment is idempotent.
- Active attempts may become `failed` or `cancelled`. Previously generated data
  remains available for diagnosis/recovery but does not become accepted history.
  Late completion cannot overwrite a stopped attempt or another attempt.
- Only one executing (`running`, `generated`) attempt is allowed per conversation.
  Earlier turns may await receipt while a later turn executes, preserving legacy
  chat clients. A turn awaiting receipt must be recovered/replayed, not regenerated.
  An accepted turn cannot be retried. Failed, cancelled,
  interrupted and delivered-partial attempts can be retried within the limit.
- On open, `running` and `generated` become `interrupted`; saved evidence remains.
  `awaiting_receipt` remains pending; accepted/partial records retain their status.
  Startup completes recovery before returning a usable store. No pending answer
  is automatically accepted. Future UI recovery/receipt semantics need integration.

Source IDs remain scoped to the original assistant answer. Two snapshots can
both contain `S1` and the same URL with different evidence; they are never merged.
Citation IDs validate registry membership, not quotation or factual support.

## Frozen bounds and failure behavior

| Resource | Limit |
| --- | --- |
| Conversations | 100 |
| Serialized conversation | 4 MiB UTF-8 |
| Total files, including orphan temporary files | 64 MiB |
| Directory entries, including temporary files | 256 |
| Turns/conversation | 500 |
| Attempts/turn | 8 |
| Seeded messages/conversation | 1,000 |
| Seed batch | 100 |
| List page | default 20, maximum 50 |
| User turn / seeded message | 16,000 / 32,000 characters |
| Evidence per attempt | 24 sources, 2,000 characters each |

Capacity checks include old and new file sizes during replacement. Full storage
rejects new writes; no original history is silently evicted. Listing is ordered
by hashed filename with offset pagination and returns metadata only. Directory
scans and file reads are bounded. Explicit delete is idempotent, but rejects a
conversation with an active attempt. Corrupt data requires manual recovery:
load/list/startup/delete refuse it instead of resetting or hiding it.

Read-modify-write operations use per-conversation promise chains. A separate short
commit chain serializes cross-conversation capacity checks, replacements and deletes.
Failures release queues. A failed transaction leaves the previous document intact;
callers receive fixed `MemoryError` codes without paths, content or upstream errors.
Do not log inputs, snapshots or the raw filesystem error. No storage logging occurs.

## Filesystem guarantees and limitations

Writes create a unique same-directory file with `wx`, write the complete validated
document, call `FileHandle.sync()`, close it, then `rename` over the destination.
No copy fallback or destination unlink is used. Windows sharing violations,
antivirus interference or disk failures produce an error; the old destination is
retained. Only this operation's temporary path is cleaned up. Orphan temps after
a crash remain unpromoted and count against capacity; they are never replayed as
committed history. Manual removal requires separate review.

Ordinary replacement is exercised on the host filesystem by unit tests. File
flush plus rename does not establish universal power-loss durability: directory
metadata flushing, filesystem/network-drive behavior and Windows ACLs differ.
The guarantee is atomic visible replacement on a supporting local filesystem,
with preservation on reported pre-rename failure, not a tested power-loss SLA.
Unix mode requests are 0700/0600; Windows access depends on the user's ACLs.
Files are plaintext. Retention is until explicit deletion or manual export/removal.

This service assumes one Node process and a trusted local storage directory. It
rejects duplicate live store owners within that process and symlink/non-file data
entries, but is not a cross-process lock or a defense against a local attacker
swapping paths concurrently. Do not share the directory between processes.
Unknown schema versions, wrong filename/document identity, malformed UTF-8/JSON,
invalid state transitions and duplicate stored identities fail explicitly.

## Verification and remaining work

`tests/memory.test.ts` uses temporary directories, frozen clocks and offline source
fixtures. It exercises replacement, failure preservation, recovery, limits,
idempotency, privacy-safe errors, turn order and concurrency without providers.

The temporal resolver now supplies supported recall anchors during context retrieval.
Quotation/change verification and true token streaming remain separate outstanding
requirements. This isolated storage service does not complete Gate 2 or Gate 1's
live acceptance requirements.

## Milestone 3 HTTP integration

- `POST /api/conversations` with `{}` creates a server-owned conversation.
- `GET /api/conversations?offset=0&limit=20` lists bounded metadata.
- `GET /api/conversations/:id` loads the validated document, including provenance,
  statuses, original messages and answer-scoped evidence snapshots.
- `DELETE /api/conversations/:id` returns `{deleted}`; pending attempts must be
  resolved before deletion. Corrupt files are never silently deleted.
- `GET /api/conversations/:id/turns/:turnId/attempts/:attemptId/result` returns
  `{status,result}` for awaiting-receipt, accepted or delivered-partial attempts.
  It does not call providers, accept the answer, or promote interrupted generation.
- `POST` to the same attempt's `/receipt` with `{messageId}` acknowledges that
  specific stored answer. A complete result becomes accepted; partial stays partial.
  Lost receipt replies can safely be retried.

Chat accepts optional `turn: {key, attemptKey}`. Reuse both keys to retransmit a
submission; use a new attemptKey to retry a failed/cancelled/interrupted attempt.
The same key preserves original server content. Duplicate completed/pending
submissions replay their saved SSE result. Running overlap returns HTTP 409.
Identifiers are returned in `X-Conversation-Id`, `X-Turn-Id`, `X-Attempt-Id` headers;
SSE payloads remain unchanged. Legacy conversation IDs remain echoed in SSE and
are persisted as `clientKey` aliases to canonical server UUIDs. Aliases are not
authentication. Optional alias fields extend stored v1 records; older strict
readers may reject these records if the application is downgraded.

All configured chats persist user/attempt admission before a provider call.
Provider preflight remains mandatory. Source snapshots and generated answers are
saved before awaiting receipt and before emission. Socket writes never imply
receipt. Cancellation before pending delivery stops the attempt; lost delivery
after pending delivery remains recoverable. A disk error during finalization may
leave an interrupted/running record for startup recovery, with a fixed safe log
notice. No filesystem operation is claimed forcibly cancellable.

Supplied history is merged with disk records and normalized to server originals.
Known unaccepted assistant answers and later turns are excluded. Seeded history
remains unverified data. This selects no additional history automatically. Legacy
clients can continue posting, but do not automatically acknowledge or reuse stored
pending assistant messages as trusted history; browser receipt integration is next.

The application lazily opens the store and recovers it before first use, closes
it on shutdown, and keeps write queues released during providers. Storage time
uses the original request deadline. Private routes require loopback peers, a
loopback Host matching the listening port, and matching Origin when supplied;
cross-site fetches are rejected. Same-origin browser/CLI calls are supported;
there is no public-deployment authentication or CORS access. Private responses
use no-store, including SSE. Memory routes log a generic path, not message data.
Storage errors map to sanitized JSON 400/404/409/503/507 before SSE; after hijack
existing error/done ownership remains unchanged. HTTP memory reads/recovery work
without model credentials. `BuildServerOptions.memoryDirectory` selects an owned
private directory for tests or local deployment; default remains `.recall-data/`.


## Milestone 4 browser integration

The browser lists bounded stored conversations and loads the active server-owned
UUID after refresh. Only `recall.activeConversation.v1` (one conversation ID) is
kept in localStorage; message text, evidence and receipt state are never cached
there. Earlier conversations are reopened by fetching their current server records.
Client-seeded records remain visibly labeled when their original sources are absent.
Only accepted server answers enter restored assistant history; partial, cancelled,
interrupted and pending attempts do not. Original logical turn order is retained.

A new conversation is created on the server before its first chat request. Each
user turn has stable turn/attempt keys; failed completed executions get a fresh
attempt key for retry, while uncertain network/protocol delivery reuses the key
for idempotent replay. Server user-message identities and timestamps replace
local provisional identities before subsequent history submission. Unsynchronized
provisional user records are not reimported as new server history.

Newly delivered complete answers are acknowledged only after schema/order checks,
matching terminal delivery and clean SSE EOF. Restored awaiting-receipt answers
require an explicit Recover / retry receipt action: fetch the saved result,
validate it and acknowledge its exact message identity. Recovery never submits
chat. Partial answers are never acknowledged by the browser. Lost acknowledgments
can be retried; failed receipts stay visibly pending and excluded from history.

Memory HTTP reads are bounded to 5 MiB, have a ten-second transport watchdog,
validate browser-consumed identities/results and clean up readers/listeners/timers.
Restoration is cancelled/ignored after newer navigation or destruction. Other-tab
selection changes show a notice rather than silently replacing the current view;
server overlap checks remain authoritative. Network, malformed data and deleted
conversation errors preserve the current view and show an explicit status.
A Refresh conversations control retries listing without paid calls. This remains
one local user's server, with no public-deployment authentication.

`tests/ui-memory.test.ts` uses frozen offline HTTP/SSE responses. Existing isolated
UI suites explicitly disable persistence to retain their layout/interaction test
boundaries. Real browser geometry, storage restrictions and multiple real browser
windows still require manual evaluation; DOM tests do not prove those behaviors.

## Milestone 5 historical retrieval and context

`src/context.ts` is an internal deterministic function, not an external model tool.
Recognized recall questions scan at most 100 conversations / 150,000 stored records
under the original request deadline. Ordinary questions load active conversation
continuity only. Whole turns include original user messages and accepted assistant
answers/evidence; pending, failed, partial and cancelled assistants remain excluded.
An assistant completed after the original request's reference is also excluded.
Client-seeded records retain their original role/text, separate IDs and unverified
provenance. No histories are written or synthesized by retrieval.

Supported recall patterns include "What did I/we ...", "Which ... did we ...",
"Summarize our earlier/previous ...", "recall" and "remember". Temporal phrases
are extracted conservatively and passed to dates.ts. Bare weekdays mean the most
recent occurrence on/before the reference local day; "last weekday" is strictly
before it. Last week is the previous Monday-through-Sunday week. Multiple hints,
numeric date ambiguity and unsupported expressions require clarification. External
fact questions are not interpreted as requests for dated conversations.

The captured reference is the original server user-message UTC timestamp and
stored turn timezone (UTC fallback for missing legacy timezone), reused on retries.
Local time and UTC reference are supplied to the model. Relative mentions in old
messages receive bounded date hints anchored to their own original timestamps;
missing old timezone is explicitly labeled as assumed. Those hints are external
event-date metadata, never recursive conversation retrieval instructions.

Historical locator clauses are separated from current-verification instructions;
bounded calendar expressions are passed to the existing resolver. Thus a later
"still correct today" clause does not override the date of the earlier discussion.
Matching requires normalized entity/topic anchors, with explicit Postgres/PostgreSQL
and CRM/CRMs equivalences. Conversational filler is removed; descriptive terms
contribute to rank, with at least half of the remaining terms required. Generic
terms alone cannot establish a topic, and date-free anchorless queries cannot
select arbitrary history. Calendar-day filters apply to original user-message
instants in the request timezone. Rank by date/keyword overlap, then recency;
break ties by conversation ID, ordinal and turn ID. A directly adjacent followup
starting with a supported reference word may be included as separately labeled
context. Contiguous related server turns on one local day in one conversation
form one discussion; gaps, different days, competing conversations and separate
seed records retain ambiguity. This lexical method can miss
paraphrases, inflections or implicit references; absence is not proof that a
discussion never occurred. No measured accuracy improvement is claimed.

Recall selects at most eight whole records with a 32 KiB serialized memory-context
budget, also checked by the existing conservative contextFits calculation including
the system prompt, question, tools and reserved output. Active continuity uses full
eligible records if they fit the existing context window (without the recall-only
32 KiB cap), otherwise a recent whole-turn suffix with an explicit
omission count. Essential recall turns are never cut mid-shortlist: if they cannot
fit, return a limitation asking for a narrower request. This is not exact tokenization.
The existing 65,536-byte/context-window limits still apply to each model call.

Historical originals and source snapshots stay unchanged on disk and in retrieval
results. Model-context projection replaces citation markers with qualified
`history:conversation:turn:S#` labels, preserving original IDs and provenance.
Historical sources never enter the current SearchSession registry or the public
answer source list. Reopen the original answer for historical source links. Stored
data is JSON in a user-role message, never a system instruction; prompts explicitly
reject stored instructions and forbid treating old assistant statements as facts.
These boundaries do not establish claim-level factual or quotation verification.

Pure recognized recall disables web_search. Missing records, unsupported date
references and coverage/context limits produce fixed honest answers without model
or search calls. Found records use the same bounded agent loop for synthesis.
Mixed current-information requests retain Tavily through the existing single tool.
Storage failures fail explicitly, never as invented "not found" success. Retrieval
has a disposable arrival-deadline scope, and elapsed time is rechecked before model
execution. Limits remain three model calls, two rounds, 5+3 searches and 25 seconds.
No public response shapes, receipt rules or SSE event framing changed.

`tests/context.test.ts` uses frozen records plus a restart/HTTP test with mocked
providers. Live recall quality and latency remain unmeasured; this milestone does
not implement historical change/quotation verification or true token streaming.
