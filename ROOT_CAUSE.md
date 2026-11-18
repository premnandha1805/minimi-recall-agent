# Live memory incident — 18 November 2026

## Phase 0: instrument before changing logic

Baseline: 867 tests passed, 1 skipped (the merged 852 plus existing uncommitted
provider diagnostic tests). Branch: `fix/live-memory-recall`. Existing user edits
and the untracked frontend were preserved. `npm run dev` was run on port 3000.
The real Azure deployment and the real `.recall-data` archive were used; no keys,
deployments, billing or quota settings were changed.

Browser automation was blocked by the computer-use host because it could not
determine Chrome's current URL. Reproduction therefore used the actual HTTP/SSE
endpoint, not an injected/fake provider. Browser UI verification remains separate.

Raw structured logs are local `live-memory.log` (ignored, containing bounded private
history previews). Evidence below uses only the synthetic requested fact.

| Hypothesis | Finding before fixes | Correlated log evidence |
| --- | --- | --- |
| H1: persisted only after model success | False | `6d790dcc-8a94-455f-b6c9-61dc06e72149`: `user_message_persisted` at 863.81 ms, 14 conversations / 33 messages, then model failure at 770.82 ms of model time. The Infosys statement remained on disk and in the next retrieval. |
| H2: writes restart watcher / different path or processes | Not reproduced | PID 10956 handled all four requests and all their writes. Startup and writes used `D:\Minimi Recall Agent\.recall-data`, cwd `D:\Minimi Recall Agent`. No second server could bind the port. Watch ignores still need making explicit. The tool daemon interruption is not evidence of a tsx restart. |
| H3: retrieval excludes too much | True | `dad3b132-c116-4bd1-b4a1-17726bc97a27`: 17 conversations persisted, but retrieval scanned 0 other conversations, returned 0 records. Non-recall queries load only the active conversation. |
| H4: intent too narrow | True | Same request, “Do I have anything planned?”: `recall_intent.detected=false`. “Do I have any meeting coming up?” scanned 15 conversations / 20 messages but returned no hits: `coming up` polluted the majority-overlap terms. |
| H5: empty context produces false missing-history answer | True behavior; prompt already forbids literal “never told me” | Same request supplied 4,140 characters / estimated 1,035 tokens, no archive records; model answered “retrieved history shows not_found and no matching records” despite saved evidence. No scanned-conversation count was supplied. |
| H6: sequential classifier / validator calls or excessive timeout | No LLM classifier or validator exists. 10 s per-call timeout and lack of fallback are defects; observed failures were earlier | `8aa6d5c6-20e7-495f-9a46-032d09a6a416`: exactly one model call, HTTP 400 after 912.31 ms, despite 4 hits including Infosys; context 21,564 characters / estimated 5,391 tokens. First request had NETWORK_ERROR / ECONNRESET after 773.30 ms. These were not model timeouts. |
| H7: yearless date rejected | False for this failure | The above 4 retrieved hits include the exact “I have an Infosys meeting on 23 August.” Evidence survives; yearless dates are conservatively retained, not filtered out. Event-date hints need an explicit interpretation. |
| H8: unflushed write/read race | False in reproduction | `addTurn` awaits atomic rename; snapshot awaits queued writes. The very next request retrieved the failed preceding statement. Snapshot reparses every file on each request, adding 92–199 ms in these live traces. |

Additional root cause **confirmed**: HTTP 400 specifically on recall, whose adapter
sends `tool_choice: none` without `tools`. `scripts/diagnose-model.ts` made two
controlled real requests: with that field → HTTP 400 in 919 ms, param `tool_choice`,
error mentioned tools; omitting it → HTTP 200 in 1,932 ms with a completion.

## Fixes and final verification

Pending implementation and measured results.
