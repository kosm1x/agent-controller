# v6.0+ Enhancements — Beyond the Roadmap

> Items that emerged from production use but aren't on the v5.0 roadmap.
> Prioritized by impact. Revisit when v5.0 is fully complete (S5d remaining).
>
> Last updated: 2026-04-04

---

## Tier 1 — High Impact, Ready to Build

### Multi-Model Routing

Route different task types to different LLMs. Claude for reasoning/analysis, GPT-4 for tool calling, fast model for classification. Current: single vendor (DashScope) with primary/fallback/tertiary of the same family.

**Why:** Fallback model (qwen3-coder-plus) can't call tools reliably. When primary degrades, everything degrades. Model routing would use the best model for each step.

**Effort:** ~2-3d. Requires: provider registry with capability tags, routing logic in adapter.ts, per-step model selection in inferWithTools.

### More Intel Adapters (14 free sources)

No-auth sources ready to build (adapters already have metric definitions in delta-engine.ts):

| Source      | Domain         | Auth        | Effort |
| ----------- | -------------- | ----------- | ------ |
| IODA        | infrastructure | none        | 2h     |
| WHO DON     | health         | none        | 2h     |
| OilPriceAPI | financial      | none (demo) | 1h     |
| CelesTrak   | space          | none        | 2h     |
| Safecast    | nuclear        | none        | 2h     |
| disease.sh  | health         | none        | 1h     |
| OONI        | infrastructure | none        | 2h     |
| HN Firebase | news           | none (SSE)  | 3h     |

API-key sources (free signup):

| Source           | Domain                        | Signup                  |
| ---------------- | ----------------------------- | ----------------------- |
| Finnhub          | financial (VIX, SPY, DXY)     | finnhub.io/register     |
| FRED             | economic (Fed funds, GDP)     | fred.stlouisfed.org     |
| NVD              | cyber (critical CVEs)         | nvd.nist.gov            |
| Cloudflare Radar | infrastructure                | dash.cloudflare.com     |
| ACLED            | geopolitical (armed conflict) | developer.acleddata.com |
| NewsData.io      | news (200/day)                | newsdata.io             |

### Unified FS Maturation

- **user_facts → knowledge/ migration**: Move remaining 39 genuine facts to files. Parallel run, then deprecate user_facts.
- **Day recaps**: Nightly ritual reads day-log, writes structured recap to `logs/day-logs/{date}-recap.md`. Enables "what happened yesterday?" queries.
- **Auto-persist to meaningful paths**: Instead of `logs/sessions/{id}.md`, extract topic from the conversation and write to `projects/{slug}/notes/` or `knowledge/domain/`.
- **INDEX.md project summaries**: Pull one-line status from each `projects/*/README.md` into INDEX.md.

---

## Tier 2 — Medium Impact, Design Needed

### Structured Outputs

Guarantee schema-compliant JSON responses for tool calls and structured data queries. Currently: free-form text, tools parse args from JSON but responses are narrative.

**Options:**

- Instructor-style constrained decoding (requires vendor support)
- Post-generation JSON extraction + validation
- Response schema in tool definitions (OpenAI function calling already does this for args)

**Why:** Eliminates LLM narrativization of data. The COMMIT fiasco and cuatro-flor hallucinations were caused by the LLM interpreting data instead of relaying it.

### NanoClaw Production Activation

Docker image built (`nanoclaw-coding:latest`). Container infrastructure exists. Volume mounts supported. Not yet used in production because fast runner + host tools handle most coding tasks.

**Activate when:** Test suites exceed 60s shell_exec timeout, or when isolated sandbox execution is needed for untrusted code.

### Embedding-Based Scoping (S3, deferred from v5.0)

Replace keyword regex with embedding similarity for scope detection. Current regex accuracy: 85%+.

**Revisit when:** Scope accuracy drops below 80%, or new languages (Portuguese, English-heavy) are added.

**Effort:** ~3-5d. Requires: embedding model selection, scope vector generation, similarity threshold tuning, A/B test against regex.

---

## Tier 3 — Low Urgency, Future

### Multi-User Support

PostgreSQL, Redis, per-user isolation. Only if a second user exists.

**Requires:** Auth middleware, per-user DB schema (or row-level security), user-scoped tool registry, budget quotas per user.

### WebSocket Streaming (Intel Depot)

Persistent WebSocket connections for Finnhub (real-time quotes) and Bluesky JetStream (social signals). Deferred from S7.

**Requires:** WebSocket manager with reconnection, Bluesky keyword filtering (50 events/sec → 1-5/hour), memory management.

### A2A Protocol Activation

Full A2A (Agent-to-Agent) stack exists — JSON-RPC server/client, agent card, mapper. Currently gated behind `A2A_AGENT_NAME` env var. Zero consumers.

**Activate when:** External agents need to call Jarvis or Jarvis needs to delegate to external agents.

### Documentation + Open Source

- Architecture overview beyond CLAUDE.md
- Contributor guide
- Deployment guide (Docker Compose, systemd, env vars)
- Tool development tutorial
- "How Jarvis Works" public writeup

---

## Completed (from prior "beyond roadmap" items)

| Item                                              | Shipped    |
| ------------------------------------------------- | ---------- |
| Coding capability (git tools, NanoClaw image)     | 2026-04-04 |
| Self-tuning activation (overnight loop)           | 2026-04-04 |
| Prompt enhancer (Telegram gatekeeper)             | 2026-04-04 |
| Day log (mechanical interaction logging)          | 2026-04-04 |
| File boundaries (read all, write restricted)      | 2026-04-04 |
| Unified File System (Jarvis Knowledge Base)       | 2026-04-04 |
| Deep audit (5-agent, 3 critical fixes)            | 2026-04-04 |
| Git hardening (5 iterations, shell injection fix) | 2026-04-04 |
| User Guide + Prompt Enhancer docs                 | 2026-04-04 |
