# Agent and provider boundaries

`runAgent` in `src/agent.ts` orchestrates a provider-swappable `ModelProvider` and one external tool, `web_search`. Memory, date parsing, source identity, budgets and comparison rules are internal functions. History/search content is untrusted data. The production adapter uses the pinned AI SDK; the native JSON adapter remains an injectable boundary for frozen integration tests and compatible callers.

## Limits and failure behavior

- At most two search rounds, five actual provider requests in round one and three in round two, eight overall, including failures. Multiple tool invocations share the round budget; normalized duplicates do not create requests.
- Two provider searches may run concurrently. Search admission stops at 15 seconds; individual searches have bounded timeouts. Late provider completion cannot exceed the caller's permitted wait.
- The default overall request deadline is 25 seconds, inherited from HTTP arrival. Abort signals propagate on timeout/disconnect. Model first-output timing and one eligible shorter-context retry remain inside the overall/model-call/output budgets; SDK automatic retries are disabled.
- Ordinary drafts stream as generated. Historical recall and comparisons suppress unvalidated prose/JSON until grounding or deterministic comparison finishes. The final result replaces provisional text.
- Unknown citations, malformed tool output and incomplete searches are explicit failures or partial answers, not fabricated success. Pure recall may quote saved evidence if model synthesis cannot be accepted; metadata reports `generation.origin: recovered`.

## Azure v1 implementation

Only `MODEL_PROVIDER=azure-openai-v1` implements live HTTP chat. It uses the exact configured HTTPS `/openai/v1/chat/completions` URL, deployment name, API-key authentication and context capacity. Redirects are rejected and credentials are not forwarded to another endpoint. There is no API-version or model fallback.

`streaming-model.ts` uses the pinned SDK's `streamText`, `instructions`, one-step completion, and zero SDK retries. Disabled tools omit tool-choice fields. `model.ts` uses bounded native-fetch JSON parsing for the non-streaming adapter. Neither adapter exposes raw provider errors or secrets. Deployment text/tool support and available quota must be verified with the actual account.

## Verification map

- `agent.test.ts`, `tool-call-schema.test.ts`: rounds, multiple invocations, malformed calls and stop reasons.
- `model.test.ts`, `streaming-model.test.ts`: native/SDK wire format, trusted instructions and disabled-tool behavior.
- `request-recovery.test.ts`, `safeguards.test.ts`: first-output deadlines, cancellation and bounded retry.
- `production-correctness.test.ts`, `synthesis.test.ts`: origin metadata, safe historical grounding and suppression of unchecked drafts.

See [chat-sse.md](chat-sse.md), [web-search.md](web-search.md), [memory.md](memory.md), and [verification.md](verification.md) for their respective contracts. No claim of general factual correctness follows from these bounded checks.