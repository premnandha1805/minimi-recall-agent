# File guide for the live memory repair

| File | What changed and why |
| --- | --- |
| `src/config.ts` | Validates one archive directory and the debug flag; relative archive paths use the project root. |
| `src/memory.ts` | Flushes writes, maintains the committed snapshot, stores assistant errors, backs up revisions and recovers damaged JSON at startup. |
| `src/memory-http.ts` | Migrates the legacy archive once and exposes the protected local memory summary. |
| `src/context.ts` | Searches all conversations for each HTTP request, improves lexical matches and builds bounded evidence context with dates and neighbors. |
| `src/dates.ts` | Adds labeled nearest-occurrence hints for yearless event dates without rewriting original wording. |
| `src/server.ts` | Coordinates persistence before networking, parallel research/retrieval, diagnostics, streaming and memory-use metadata. |
| `src/request-log.ts` | Emits one structured JSON record per requested stage with request/conversation IDs and elapsed milliseconds. |
| `src/agent.ts` | Uses deterministic recall grounding on model failure, bounds one shorter retry, and accepts a shared prefetched search session. |
| `src/model.ts` | Retains the existing JSON adapter and its diagnostics; adds optional streaming callbacks and omits invalid tool-choice fields on plain recall calls. |
| `src/streaming-model.ts` | Implements the production adapter with the pinned AI SDK, Azure API-key transport and streamed text callbacks. |
| `src/observability.ts` | Preserves the supplied bounded provider-failure diagnostic fields. |
| `src/execution.ts` | Separates first-token timing from the remaining overall stream budget. |
| `src/contracts.ts` | Validates streamed draft frames, early research progress and optional memory-use metadata. |
| `src/sse.ts` | Sends provisional text and friendly retry errors through the existing SSE owner. |
| `public/api.js` | Validates the additional stream frames and forwards draft tokens without treating drafts as accepted answers. |
| `public/api.d.ts` | Keeps browser callback types consistent with the stream reader. |
| `public/app.js` | Displays streamed draft text and the number of earlier conversations used; final results replace drafts. Existing New chat and Retry behavior is retained. |
| `package.json`, `package-lock.json` | Pin SDK versions, ignore data in the watcher, and add live-test and hygiene-lint commands. |
| `.env.example`, `.gitignore` | Document private archive/debug settings and keep new local data out of Git. |
| `scripts/live-e2e.ts` | Runs four fact pairs in new conversations against the real running server and writes measured results. |
| `scripts/reproduce-memory.ts` | Repeats the original failing questions without replacing the real provider. |
| `scripts/diagnose-model.ts` | Isolates the observed Azure tool-choice rejection with two small real calls. |
| `scripts/diagnose-stream.ts` | Checks a real streaming response while printing only bounded transport metadata. |
| `scripts/lint.mjs` | Provides a dependency-free conflict-marker/NUL hygiene check; TypeScript remains the semantic checker. |
| `tests/live-memory-regression.test.ts` | Adds the requested HTTP persistence, retrieval, timeout, restart, synonym, empty-history, watcher and 500-conversation regressions, plus continuity/date checks. |
| `tests/request-recovery.test.ts` | Verifies separate first-token timing and concurrent research/retrieval with shared sources. |
| `tests/streaming-model.test.ts` | Exercises the actual SDK SSE parser, trusted instructions and disabled-tool request shape with frozen wire chunks. |
| `tests/provider-diagnostics.test.ts` | Preserves and commits the pre-existing diagnostic regressions supplied in the working tree. |
| `ROOT_CAUSE.md` | Records hypotheses, real request evidence, repairs, limitations and actual verification output. |
| `docs/live-e2e-results.json` | Contains the final measured three-run results and request IDs. |
| `DESIGN.md`, `README.md` | Explain the repaired architecture, exact startup/testing commands and remaining limits. |

No original test file was edited. The pre-existing `frontend/` and model-diagnosis
document remain outside these commits. Running the existing evaluation suite
regenerates `docs/evaluation-results.json`; that previously modified file was not
included in the repair commits.
