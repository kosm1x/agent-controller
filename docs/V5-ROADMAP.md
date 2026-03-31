# v5.0 Roadmap — Agent Controller

> Preliminary plan based on deferred v4.0 items, CRITICAL-ASSESSMENT gaps, and operational learnings from the v4.0 session marathon (39 commits, 6 QA audits).
>
> Last updated: 2026-03-31 — DRAFT, will evolve over sessions

## Guiding principle

v4.0 was about reliability — making Jarvis work correctly with existing models and tools. v5.0 is about scalability — making the architecture handle more users, more concurrent work, and smarter routing without accumulating complexity.

---

## Carried from v4.0

These were scoped but deferred during v4.0:

| Source   | Item                                                     | Why deferred                                                                                               |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CRIT 1.1 | Worker threads for inference concurrency                 | Needs architecture change — single event loop blocks all work during 30s inference calls                   |
| CRIT 2.2 | Paired message pruning (tool_call + tool_result as unit) | Low urgency after token budget guards landed                                                               |
| CRIT 5.3 | Embedding-based tool scoping (replace keyword regex)     | Complex regex proved fragile (v4.0.6 catastrophic backtracking). Embeddings would eliminate regex entirely |
| CRIT 8.1 | Classifier weight calibration from task_outcomes         | Adaptive classifier adjustments exist but thresholds are untested                                          |
| CRIT 8.2 | Lower adaptive adjustment thresholds                     | Coupled to 8.1                                                                                             |
| CRIT 7.3 | Credential detection (only from user messages)           | Low incident rate                                                                                          |

---

## New themes from v4.0 learnings

### Theme 1: Inference concurrency

**Problem**: One LLM call blocks everything. Playwright browsing tasks take 2+ minutes of inference rounds — during which no other Telegram message is processed.

**Direction**: Move inference calls to worker threads. The fast-runner's `inferWithTools` loop is CPU-idle (waiting on network). Worker threads would allow true concurrency without additional cores.

**Open questions**:

- How to share tool registry across threads (it's a singleton with MCP connections)?
- Worker pool size? Memory budget is ~3GB free.
- Does streaming (onTextChunk callback) work across thread boundaries?

---

### Theme 2: Smarter tool scoping

**Problem**: Keyword regex for scope is fragile (catastrophic backtracking, Spanish morphology, clitic pronouns). The v4.0.6 fix was to merge scopes — but this loads more tools per message (~40 tokens each).

**Direction**: Replace keyword regex with embedding similarity. Compute a vector for the user message, compare against pre-computed scope group vectors, activate groups above a threshold.

**Benefits**: No regex, no language-specific patterns, handles synonyms and rephrases naturally.

**Open questions**:

- Latency? Embedding call adds ~200ms. Acceptable for Telegram but not for fast-path.
- Cache? Most messages in a conversation share scope — cache the last scope decision.
- Hybrid? Keep simple keyword triggers for core groups (COMMIT nouns), use embeddings for finer-grained groups.

---

### Theme 3: Memory architecture

**Problem**: Thread buffer (15 entries) is a ring buffer — high-value outputs get evicted alongside greetings. The v4.0.10 fix (auto-persist prompt) is soft — depends on LLM compliance.

**Direction**: Mechanical auto-persist for high-value outputs. Detect output characteristics (length > N chars, tool_calls > M, Playwright browsing involved) and automatically call memory_store with a structured summary.

**Related**: The v4.0 S9 tool_chain attribution needs more data before the self-tuning system can learn from it. Implicit feedback detection is live but needs production validation.

**Open questions**:

- What constitutes "high-value"? Length alone is insufficient (long error messages aren't valuable).
- Should auto-persist be mechanical (post-hoc in fast-runner) or LLM-driven (prompt instruction)?
- Memory consolidation: how to merge overlapping memories over time?

---

### Theme 4: Multi-user architecture

**Problem**: Everything is single-user (Fede). Thread buffer, user_facts, conversation history, Hindsight bank — all assume one user.

**Direction**: Per-user isolation. PostgreSQL migration for concurrent writes, Redis for session state, user_id column on all tables.

**Dependencies**: Only worth building when there's a second user. Currently premature.

---

### Theme 5: A2A agent mesh

**Problem**: CRM (crm-azteca) and agent-controller are separate systems. Cross-system workflows (e.g., CRM prospect data → Jarvis analysis → COMMIT task creation) require manual coordination.

**Direction**: A2A protocol already implemented (v2.2). Need to deploy CRM as an A2A agent and wire bidirectional task delegation. Plan exists at `docs/PLAN-A2A-AGENT-MESH.md`.

---

## Tentative session structure

| Session | Theme                   | Scope                                                                   |
| ------- | ----------------------- | ----------------------------------------------------------------------- |
| S1      | Mechanical auto-persist | Detect high-value outputs, auto-save to memory. No LLM dependency.      |
| S2      | Inference workers       | Move inferWithTools to worker_threads. Pool of 2-3 workers.             |
| S3      | Embedding-based scoping | Replace keyword regex with vector similarity for scope groups.          |
| S4      | A2A mesh                | CRM ↔ Jarvis bidirectional task delegation.                             |
| S5      | Classifier calibration  | Outcome-driven weight tuning, lower thresholds, negative feedback loop. |
| S6+     | Multi-user              | PostgreSQL, Redis, per-user isolation. Only if needed.                  |

---

## Metrics to track

| Metric                   | v4.0 baseline         | v5.0 target                                                 |
| ------------------------ | --------------------- | ----------------------------------------------------------- |
| Feedback signal rate     | 5/603 explicit (0.8%) | >15% with implicit signals                                  |
| Tool chain attribution   | New (S9)              | Self-tuning proposes mutations based on chain success rates |
| Concurrent task handling | 1 (sequential)        | 3 (worker threads)                                          |
| Scope false positives    | Unknown (no tracking) | <5% (embedding-based)                                       |
| Memory recall precision  | Unknown               | Track via scope_telemetry + feedback loop                   |
| Avg response time        | ~15s (full pipeline)  | <10s (with worker concurrency)                              |
