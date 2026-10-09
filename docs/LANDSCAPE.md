# Landscape register

The register the weekly scan and the monthly deep review read (cadence: `docs/ROADMAP.md`). Evidence, quotes and `file:line` for every row: `docs/planning/landscape-review-2026-10.md` (review #1, 2026-10-03; item ids in brackets).

**How to update:** one row per tracked item. Each review re-checks every row and sets "Last reviewed"; change a verdict only with a primary source recorded in that review's note. Add a row when a new item gets a verdict; remove one only when its follow-up has merged (say so in the note). Verdicts: **build** (we write it), **adopt** (take upstream's thing as is), **borrow** (take the design, write our own), **ignore** (with a reason; "already present" for parity). The skill `.claude/skills/upstream-review/SKILL.md` has the method.

## Tracked sources

| Source | Ours | Where to read releases |
| --- | --- | --- |
| Claude Agent SDK (TS) | 0.3.245 exact | https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md, https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk |
| Anthropic SDK (TS) | 0.111.0 exact (peer only) | https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md |
| Claude platform docs (Managed Agents, tool use) | n/a | https://platform.claude.com/llms.txt |
| MCP specification | 2025-11-25 via SDK | https://modelcontextprotocol.io/specification/latest |
| `@modelcontextprotocol/sdk` | `^1.29.0`, installed 1.29.0 | https://registry.npmjs.org/@modelcontextprotocol/sdk |
| A2A protocol | bespoke, pre-0.3 dialect | https://raw.githubusercontent.com/a2aproject/A2A/main/CHANGELOG.md |
| OTel GenAI semantic conventions | none | https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/CHANGELOG.md |
| LangGraph, OpenAI Agents SDK, Google ADK, Microsoft Agent Framework | none (ideas only) | registry JSON on npm / PyPI; docs pages listed in the review note |

## Register

| Item | Verdict | Trigger | Owner | Last reviewed |
| --- | --- | --- | --- | --- |
| Agent SDK 0.3.245 → 0.3.288 bump (umbrella for the L1 rows below) | adopt | operator VPS session with `eval:gate` | L1 | 2026-10-03 |
| Stop hook own deadline + trace (gap exists at the current pin) [a16] | build | **built 2026-10-09** (`STOP_HOOK_DEADLINE_MS` 150 s < SDK 180 s; deadline/abort ⇒ `gates.hook_released reason=deadline\|aborted`; all hook traces carry `elapsed_ms`) | L5 | 2026-10-09 |
| `verbatimPrompts` [a17] | adopt | pin bump | L1 | 2026-10-03 |
| `systemPrompt` snapshot default (0.3.267) [a18] | adopt (check cache_diag) | pin bump | L1 | 2026-10-03 |
| Telemetry discontinuity at the bump (0.3.246, 0.3.257) [a19] | adopt (caveat in `audit-claim`) | pin bump | L1 | 2026-10-03 |
| MCP server timeout / handshake (0.3.248, 0.3.281) [a20] | adopt | pin bump | L1 | 2026-10-03 |
| `permissionMode` default change (0.3.286) [a21] | ignore (explicit `dontAsk`) | none | L1 checks a test pins it | 2026-10-03 |
| New stop reasons [a22] | ignore now | a new subtype in the journal | L1 | 2026-10-03 |
| Model deprecations (Sonnet 4.5, Opus 4.1) [a23] | ignore (neither used) | none | none | 2026-10-03 |
| Outcomes: separate-context grader, per-criterion rubric [a1] | borrow | S3 spike | S3 | 2026-10-03 |
| Outcomes: named end states (budget-exhausted, interrupted) [a2] | borrow | S3 spec diff | S3 → S4 | 2026-10-03 |
| Outcomes: iteration bound (default 3) [a3] | ignore (keep one replan) | S5 shows the single replan limits catch rate | S5 | 2026-10-03 |
| Outcomes: start/iteration events [a4] | borrow | S4 implementation | S4 | 2026-10-03 |
| Rubric from a known-good example [a5] | borrow (prompt; `eval:gate`) | vague criteria behind `unverifiable` | S5 → operator | 2026-10-03 |
| Advisor tool / `advisorModel` [a8] | adopt (experiment; `eval:gate`) | W3 harness can measure it | S5 → operator | 2026-10-03 |
| Tool search [a9] | ignore (already present, dormant) | operator arms `TOOL_SEARCH_ENABLED` | operator ruling | 2026-10-03 |
| Dreams-style memory curation [a6] | borrow (shape) | duplicate rate material (VPS data) | operator ruling | 2026-10-03 |
| Multiagent one-level depth [a7] | borrow (data point) | swarm outcome review (VPS data) | operator ruling | 2026-10-03 |
| Mid-conversation tool changes [a10] | ignore | the CLI exposes `tool_addition` | weekly scan | 2026-10-03 |
| Programmatic tool calling, context editing, memory tool, hosted Skills [a11, a13–a15] | ignore | none | none | 2026-10-03 |
| Server compaction [a12] | ignore (CLI owns it) | context overflows (VPS data) | weekly scan | 2026-10-03 |
| Hosted Managed Agents [a24] | ignore (option A) | none | operator (standing) | 2026-10-03 |
| MCP bridge keeps `structuredContent` + resource links [b1] | build | already reachable | L2 | 2026-10-03 |
| `@modelcontextprotocol/sdk` 1.32.0 [b2] | adopt (within caret) | with L2 | L2 | 2026-10-03 |
| MCP validation errors as tool errors [b3] | borrow | `-32602` on a bad `/mcp` argument | L2 | 2026-10-03 |
| Deterministic `tools/list` order [b4] | borrow | cache-hit drop (`audit-claim`) | S5 | 2026-10-03 |
| MCP 2026-07-28 stateless protocol, v2 SDK [b5] | ignore now | an SDK sets `LATEST_PROTOCOL_VERSION = 2026-07-28` | operator ruling | 2026-10-03 |
| Drop deprecated `logging` capability on `/mcp` [b6] | adopt at the next touch of `/mcp` | MCP v2 migration | operator ruling | 2026-10-03 |
| MCP MRTR, tasks extension, OAuth/CIMD [b7–b9] | ignore | a configured server needs it; `/mcp` exposed wider | none / operator | 2026-10-03 |
| `traceparent` in MCP `_meta` [b10] | borrow later | multi-hop MCP debugging needed | L4 | 2026-10-03 |
| A2A retire [c6] | ignore (retire candidate; operator ruling) | zero A2A use (VPS data) | L3 → operator ruling | 2026-10-03 |
| A2A 1.0 shim (methods, version header, parts/states) [c1, c2, c4] | build (shim), pending L3 ruling; retire is the alternative | VPS data on A2A use | L3 → operator ruling | 2026-10-03 |
| A2A card hygiene (`agent-card.json`, no `stateTransitionHistory`) [c3] | borrow, with the shim | L3 picks the shim | L3 | 2026-10-03 |
| `@a2a-js/sdk` type shapes [c5] | borrow (the dependency needs discussion) | L3 picks the shim | operator ruling | 2026-10-03 |
| Per-goal Prometheus snapshot + format version + pending approval [d1–d4] | borrow | a task lost to shutdown with completed goals (VPS data) | W2 | 2026-10-03 |
| Run-wide approvals in non-fast runners [d5] | borrow (design) | gated calls ending refused (VPS data) | W2 | 2026-10-03 |
| Generic per-tool output check [d6] | borrow if needed | W1 spike finds a per-tool-call check | S3 | 2026-10-03 |
| Span tree with parent ids [d7] | borrow (with e3) | `mc-ctl` trace cannot localise a goal failure | L4 | 2026-10-03 |
| Args-hash approvals, tool gate, output tripwire, redaction [d8–d11, d13] | ignore (already present) | none | none | 2026-10-03 |
| Time travel / fork [d12] | ignore | re-run from an earlier goal > 1/month | none | 2026-10-03 |
| `gen_ai.*` names in trace `attrs` [e1] | borrow | next trace-event change | L4 | 2026-10-03 |
| `gen_ai.evaluation.result` shape for gate results [e2] | borrow | S5 defines gate-result records | S5 | 2026-10-03 |
| `span_id` / `parent_span_id` via migration [e3] | borrow | `mc-ctl` trace cannot localise a goal failure | L4 (operator approval) | 2026-10-03 |
| OTLP exporter [e4] | ignore now | GenAI release with a schema URL, or S6 needs it | operator ruling | 2026-10-03 |
| Trajectory `IN_ORDER` match [e5] | borrow | a seed case passes with write before read | S5 | 2026-10-03 |
| Rubric judges, user simulation [e6] | ignore for the gate | multi-turn regression missed | S5 | 2026-10-03 |
