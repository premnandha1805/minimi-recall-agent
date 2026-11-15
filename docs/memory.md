# Durable conversation storage — Gate 2, Milestone 1

`src/memory.ts` is an internal storage service only. It is not wired into HTTP,
the agent, or the browser. Refresh recovery, temporal resolution, context selection
and historical/current comparison are not implemented by this milestone.

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
- Only one active (`running`, `generated`, `awaiting_receipt`) attempt is allowed
  per conversation. An accepted turn cannot be retried. Failed, cancelled,
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

Later milestones must add HTTP/receipt and browser restoration, server-authoritative
history merging during chat, temporal parsing and bounded context retrieval.
Quotation/change verification and true token streaming remain separate outstanding
requirements. This isolated storage service does not complete Gate 2 or Gate 1's
live acceptance requirements.
