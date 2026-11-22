# Minimi Recall Agent

A local research assistant for the Minimi challenge: answer conversationally, search the web when needed, and remember what was discussed and when. TypeScript, one Fastify server, and a plain HTML/CSS/JavaScript client. The model has exactly one external tool: `web_search`, backed by Tavily.

## Run locally

Requires **Node.js 24+** and npm. There is no frontend build or separate database.

```powershell
git clone https://github.com/premnandha1805/minimi-recall-agent.git
Set-Location minimi-recall-agent
npm install
# Fresh checkout only: keep an existing .env instead of overwriting it.
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run dev
```

Open **http://127.0.0.1:3000**. `npm start` runs without the file watcher.

Without credentials, the interface and saved-conversation routes work; chat returns HTTP 503 `CHAT_NOT_CONFIGURED`. `/health` reports HTTP availability and `chatConfigured`, which checks configuration presence, not provider connectivity.

For live chat, edit the project-root `.env`:

- Set `MODEL_PROVIDER=azure-openai-v1`.
- Set `AZURE_OPENAI_CHAT_ENDPOINT` to the resource's HTTPS `/openai/v1/chat/completions` URL, without query parameters.
- Set `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, and the deployment's actual `AZURE_OPENAI_CONTEXT_TOKENS`.
- Set `TAVILY_API_KEY`.

The Azure deployment must support text chat, system instructions, function tools, and `max_completion_tokens`. Other provider names are reserved; only the Azure v1 adapter is implemented. Check account eligibility and available quota yourself. The project never enables billing or buys credits.

The loader finds `.env` relative to the project, even when launched elsewhere. Existing process variables take precedence. Restart after configuration changes. Optional settings, including `PORT`, `DEFAULT_TIMEZONE`, and `MEMORY_DIRECTORY`, are documented in [.env.example](.env.example). Never commit `.env`.

## How it works

1. Validate the request and save the original user turn to the local archive.
2. Resolve dates in the user's IANA timezone. Retrieve relevant original messages, keeping active conversation context and bounded historical anchors.
3. Ask the model to answer or invoke `web_search`. The wrapper enforces two rounds, at most five plus three queries, two concurrent searches, a 15-second search cutoff, and a 25-second request deadline.
4. Validate current source IDs and constrained historical comparisons. Stream ordinary answer drafts; recall and comparison text is held until its evidence checks finish.
5. Save the result, then confirm browser delivery with a receipt. Refresh, reopening, and retry use server-owned identities.

Conversation JSON lives under `.data/conversations/`; filenames hash validated conversation IDs. Writes use per-conversation queues, exclusive temporary files, and atomic rename. The legacy `.recall-data/` import retains originals. Both directories are private and ignored by Git.

The four comparison verdicts are **Confirmed change**, **No confirmed change**, **Cannot verify**, and **Not comparable**. A previous assistant answer or imported history alone is not a trustworthy price baseline. Citation registration and quote matching reduce unsupported attribution; they do not establish complete factual support.

## Verify

All commands below use frozen fixtures or local checks and make **no provider requests**:

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run eval:offline
npm run eval:memory
npm run audit:history
```

`typecheck` includes unused-declaration checks and separately checks the browser JavaScript. `lint` is a small conflict-marker/NUL check, not a full style or security analyzer. No build script is necessary.

Generated evaluation reports go to ignored `.data/evaluations/`; the history preflight writes `.data/audits/publication.json`. Deliberately retained historical measurements are under [docs/results](docs/results). See [evaluation methodology and limitations](docs/evaluation.md).

Live checks are explicit opt-ins and consume configured quota:

```powershell
# One basic Tavily query.
npm run smoke:tavily -- --live
# Real Azure chat/recall, optional research, receipts, and persistence after restart.
# Starts its own loopback server and a new private test archive; does not use your conversations.
npm run test:live -- --live --runs=1 --research
```

The live harness distinguishes **PASS**, **RECOVERED**, and **FAIL**. Grounded deterministic recovery is useful behavior, but does not count as model-synthesis PASS. Partial answers also cannot pass that gate. Timing fields measure visible SSE output, not raw provider first-token time. The offline evaluation includes a small search-policy baseline on ten existing memory fixtures, with identical grounding criteria and privacy guards; it is not a live accuracy comparison.

The pre-cleanup recovery commit recorded **982 passing tests and one Windows symlink-permission skip**, 31/31 frozen safety checks, and 30/31 usefulness checks. Its strict live recall run had 2 model PASS and 2 RECOVERED.

Cleanup evidence recorded **1,005 tests passed, one skipped**, with strict live recall at 1 PASS, 2 RECOVERED and 1 identifier-coverage FAIL. See [cleanup verification](docs/results/cleanup-verification.json) for that dated stage.

The subsequent recall correction preserves requested names/identifiers and checks their association with user evidence. Primary and isolated clean suites each passed **1,033 tests with one skip**. Its predefined post-fix live run returned **3 PASS, 1 RECOVERED, 0 FAIL**, with all required facts returned and restart persistence passing. See [recall reliability evidence](docs/results/recall-reliability.json) and [diagnosis and trade-offs](docs/verification.md#recall-reliability-review).

The professional UI redesign and test-isolation milestone brought the test suite to **1,053 passing tests and one skip** across 38 suites, adding 20 comprehensive unit and integration tests covering immediate deterministic title derivation, temporal grouping, newest-first chronological ordering, pagination across 100+ conversations, and temporary test storage isolation preventing automated test runs from modifying `.data/conversations/`. Offline evaluation passed **41/41** checks and memory evaluation passed **39/39** checks (10/10 grounded scenarios). See [the engineering journey](docs/ENGINEERING_JOURNEY.md) for full incident logs and evidence.

## Engineering development

The Git history records separate features and bug fixes rather than one fabricated milestone:

| Phase | Original branch | Evidence |
| --- | --- | --- |
| Foundation and HTTP validation | `feature/project-setup`, `feature/chat-api` | [6901ef3](https://github.com/premnandha1805/minimi-recall-agent/commit/6901ef3), [8b22394](https://github.com/premnandha1805/minimi-recall-agent/commit/8b22394) |
| Interface and usable chat controls | `feature/chat-ui`, `fix/chat-ui-usability` | [14f6460](https://github.com/premnandha1805/minimi-recall-agent/commit/14f6460), [bb6bb07](https://github.com/premnandha1805/minimi-recall-agent/commit/bb6bb07) |
| Bounded agent, Tavily, and SSE | `feature/agent-core`, `feature/web-search`, `feature/live-chat-integration` | [86cf0a3](https://github.com/premnandha1805/minimi-recall-agent/commit/86cf0a3), [32a90bd](https://github.com/premnandha1805/minimi-recall-agent/commit/32a90bd), [3466bc6](https://github.com/premnandha1805/minimi-recall-agent/commit/3466bc6) |
| Memory, dates, and retrieval | `feat/gate-2-temporal-memory`, `fix/live-memory-recall` | [694c04b](https://github.com/premnandha1805/minimi-recall-agent/commit/694c04b), [980371b](https://github.com/premnandha1805/minimi-recall-agent/commit/980371b) |
| Comparison and regression fixes | `feat/gate-3-change-verification`, tool-schema, Q&A-pairing, and CRM-coverage branches | [4e90b26](https://github.com/premnandha1805/minimi-recall-agent/commit/4e90b26), [56e96e5](https://github.com/premnandha1805/minimi-recall-agent/commit/56e96e5), [9eae1b0](https://github.com/premnandha1805/minimi-recall-agent/commit/9eae1b0), [73ccb78](https://github.com/premnandha1805/minimi-recall-agent/commit/73ccb78) |
| Initial challenge freeze | `release/final-submission` | [3fb0148](https://github.com/premnandha1805/minimi-recall-agent/commit/3fb0148) |
| Regression recovery & repository cleanup | `fix/main-regression-recovery` | [6ddabc8](https://github.com/premnandha1805/minimi-recall-agent/commit/6ddabc8) |
| Professional UI, titles, and test isolation | `feature/professional-chat-ui` | [d3b4029](https://github.com/premnandha1805/minimi-recall-agent/commit/d3b4029) |

Development was AI-assisted under human-directed requirements and repository constraints. Branches, source changes, regression fixtures, and measured outcomes support the account; commit authorship alone does not identify which lines were manually typed. Worker snapshots are labeled separately from feature milestones. The full [engineering journey](docs/ENGINEERING_JOURNEY.md) documents the chronology, actual incidents, evidence limits, and publication records.

## Repository map and reviewer navigation

- **Architecture & Trade-offs**: [DESIGN.md](DESIGN.md) explains the single-process model, budget limits, temporal resolution, and citation integrity.
- **Engineering Journey**: [docs/ENGINEERING_JOURNEY.md](docs/ENGINEERING_JOURNEY.md) details the chronological roadmap, verified problem-solving cases, and complete branch inventory.
- **Technical Contracts & Evaluation**:
  - [docs/evaluation.md](docs/evaluation.md): offline benchmark harness, scoring criteria, and limitations.
  - [docs/memory.md](docs/memory.md): JSON storage format, concurrency queues, and recovery behavior.
  - [docs/verification.md](docs/verification.md): change verification grammar, quote validation, and recall diagnostics.
  - [docs/chat-sse.md](docs/chat-sse.md): SSE event stream protocol and error framing.
  - [docs/agent-core.md](docs/agent-core.md): single-tool agent state machine and budget owner.
- **Source Code**:
  - `src/`: server, provider/search adapters, context, dates, JSON memory, comparison, and streaming safeguards.
  - `public/`: responsive conversational interface, declarations, styles, and SVG icons.
  - `tests/`: unit, HTTP integration, DOM, regression, and evaluation suites; `tests/fixtures/` contains synthetic data.
  - `scripts/`: evaluation runners, live verification, history preflight, and hygiene check.
- **Private / Ignored**: `.data/`, `.recall-data/`, `.env`, logs, and local `frontend/` design exports are ignored and never submission data.

## Limits

This is a local single-user, single-process application, not an authenticated public service. Keep its loopback binding. JSON storage has capacity and size limits; there is no distributed lock or semantic/vector retrieval. Context selection and recall intent are English-focused heuristics, and safe grounding can fall back to quotations. The comparison grammar and reviewed official-domain list are deliberately finite. Prompt-injection fixtures are useful regressions, not a general safety proof.

Main is the stable published GitHub branch at commit `d3b4029`. All 18 feature, fix, and release branches are published publicly on GitHub, preserving authentic engineering history without rewriting commits.
