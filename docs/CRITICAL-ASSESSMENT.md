# Jarvis Critical Assessment

**Rigorous analysis of weaknesses, technical debt, and improvement opportunities**

_March 29, 2026 | Based on code audit of v2.28 (138 commits, 41K LoC)_

---

## Overview

This document catalogs every known weakness, architectural debt item, and improvement opportunity in the Jarvis/agent-controller codebase. Each finding is grounded in specific code locations and production incidents. Items are organized by severity and effort, intended as a prioritized roadmap once the current plan is complete.

---

## 1. Architecture: The Single-Process Trap

### 1.1 Event Loop Blocking

**Severity: High | Effort: Medium**

Everything — HTTP server, Telegram polling, tool execution, scheduled rituals, inference calls, memory writes — runs in one Node.js event loop. A slow inference call (Qwen at 30s on large prompts) blocks all other work. Concurrent tasks are interleaved, not parallel.

- **Impact**: When the fast runner is waiting on a 30s inference call, no other task can be classified, no ritual can fire, no Telegram message can be acknowledged.
- **Evidence**: Production logs show back-to-back inference calls serialized, with Telegram messages queuing behind long-running tasks.
- **Fix**: Move LLM calls to Node `worker_threads` with a task queue. Inference is CPU-idle (waiting on network), so workers would allow true concurrency without additional cores.

### 1.2 No Crash Recovery

**Severity: High | Effort: Low**

No systemd unit, no process manager. The process runs via manual `nohup npx tsx`. A segfault in better-sqlite3 or an OOM kills the process silently. Recovery requires manual intervention.

- **Fix**: Create a systemd unit file. ~30 minutes of work. Provides: automatic restart on crash, boot persistence, journal log management, `systemctl status` monitoring.

### 1.3 Unbounded Thread Map

**Severity: Medium | Effort: Low**

`conversationThreads` is an in-memory `Map<string, ThreadEntry[]>` that grows indefinitely. Each Telegram chat accumulates up to 8 turns, but the Map itself is never pruned of inactive chats.

- **Fix**: Add a TTL-based eviction (e.g., remove entries not accessed in 24h) or use an LRU cache.

### 1.4 No Backpressure on Task Submission

**Severity: Medium | Effort: Medium**

No queue between the Telegram poller and the dispatcher. 10 simultaneous messages create 10 competing tasks. `MAX_CONCURRENT_CONTAINERS` only limits NanoClaw — fast runner tasks have no concurrency limit.

- **Fix**: Add a bounded task queue with configurable concurrency limit per runner type.

---

## 2. Inference Layer: Fighting the Provider

### 2.1 `inferWithTools` Is a God Function

**Severity: High | Effort: Medium**

`src/inference/adapter.ts` — `inferWithTools()` is ~400 lines with cyclomatic complexity ~15. It handles: main loop, tool execution, token budget enforcement, 4 loop guards, hallucination detection, JSON repair, context compression, wrap-up generation, provider failover, and narration stripping.

- **Impact**: Any change risks breaking something else. The function is difficult to test, review, or reason about.
- **Fix**: Extract into composable units:
  - `executeToolCalls()` — tool execution + result truncation
  - `detectLoopConditions()` — all 4 loop guards
  - `buildWrapUpContext()` — already exists, but wrap-up orchestration should be separate
  - `repairToolCall()` — JSON repair + fuzzy name matching
  - Each becomes independently testable with cyclomatic complexity ~4.

### 2.2 Token Budget Creates Information Loss

**Severity: High | Effort: High**

Thread truncation orphans tool results from their tool_call messages. DeepSeek V3 rejects these with HTTP 400 (`messages with role "tool" must be a response to a preceding message with "tool_calls"`). The wrap-up path handles it, but information is permanently lost.

Tool result truncation at 12K (head 70% / tail 20%) mutilates mid-document content. For "find the paragraph about pricing and update it," the relevant content is exactly what gets cut.

- **Files**: `adapter.ts:550` (MAX_TOOL_RESULT_CHARS), `adapter.ts:689-736` (buildWrapUpContext)
- **Fix**: Paired message pruning — when truncating, always remove tool_call + tool_result as a unit. For large results, save to temp file and pass file path instead of inline content (pattern already used by `wp_read_post`).

### 2.3 Provider Degradation Is Reactive

**Severity: Medium | Effort: Low**

`isDegraded()` uses hardcoded thresholds: avg >15s or success <50%, min 10 samples, 10-min window. These aren't derived from SLO requirements. The 10-minute recovery means a provider that fails for 5 minutes auto-recovers immediately — even if the root cause persists.

- **Files**: `adapter.ts:158-179`
- **Fix**: Make thresholds configurable via env vars. Add exponential backoff to recovery (first recovery attempt at 1min, then 2min, 4min, etc. after repeated degradation).

### 2.4 No Streaming

**Severity: Medium | Effort: Medium**

Every response is a complete text block. The user sends "analyze this repository" and sees nothing for 2-5 minutes. The HTTP API already has SSE for task progress — extending it to inference chunks is architecturally natural.

- **Fix**: Implement streaming in `callProvider()` (already has branching for streaming vs non-streaming). Pipe chunks through the message router to Telegram via `editMessageText` for progressive updates.

### 2.5 Hardcoded Constants Scattered Throughout

**Severity: Low | Effort: Low**

Token budgets, max rounds, loop guard thresholds, degradation parameters — all hardcoded across multiple files:

| Constant                       | Value     | Location           |
| ------------------------------ | --------- | ------------------ |
| TOKEN_BUDGET_FAST              | 28,000    | fast-runner.ts:48  |
| TOKEN_BUDGET_CODING            | 30,000    | fast-runner.ts:49  |
| MAX_ROUNDS_DEFAULT             | 20        | fast-runner.ts:45  |
| MAX_ROUNDS_CODING              | 22        | fast-runner.ts:46  |
| MAX_TOOL_RESULT_CHARS          | 12,000    | adapter.ts:550     |
| WRAPUP_TOOL_RESULT_CHARS       | 1,500     | adapter.ts:553     |
| Provider degradation threshold | 15,000ms  | adapter.ts:160     |
| Provider recovery window       | 600,000ms | adapter.ts:162     |
| Analysis paralysis threshold   | 5 rounds  | adapter.ts:1094    |
| Stale loop threshold           | 5 rounds  | adapter.ts:1067    |
| Hallucination retry headroom   | 85%       | fast-runner.ts:433 |

- **Fix**: Consolidate into a `src/config/constants.ts` file. Make critical ones overridable via env vars.

---

## 3. Memory: The Weakest Subsystem

### 3.1 SQLite Keyword Search Is Not Retrieval

**Severity: High | Effort: Medium**

The recall implementation uses LIKE substring matching with keyword count scoring:

```sql
SELECT content,
  (CASE WHEN content LIKE '%keyword1%' THEN 1 ELSE 0 END + ...) AS keyword_score
FROM conversations WHERE bank = ? AND (content LIKE '%keyword1%' OR ...)
```

No stemming ("ran" won't match "running"), no phrase matching, no semantic similarity, no TF-IDF. A memory about "quarterly revenue projections" won't surface when asking about "financial forecasts."

- **Files**: `src/memory/sqlite-backend.ts:188-244`
- **Fix**: Migrate to SQLite FTS5. No new infrastructure required — FTS5 is a built-in SQLite extension. Provides: tokenization, stemming, phrase queries, BM25 ranking, and 10-100x faster full-text search.

### 3.2 Hindsight Circuit Breaker Gaps

**Severity: Medium | Effort: Low**

- Async fire-and-forget writes bypass the circuit breaker (`src/memory/hindsight-backend.ts:68`). If Hindsight silently drops writes for hours, its embedding index falls behind SQLite.
- No exponential backoff on recovery — fixed 60s cooldown regardless of failure history.
- 3s timeout for recall vs 5s default creates inconsistency.

- **Fix**: Track async write failures separately. Add jitter + exponential backoff to cooldown (60s → 120s → 240s on repeated trips).

### 3.3 User Facts Don't Scale

**Severity: Medium | Effort: Medium**

All user facts are injected into every prompt via `formatUserFactsBlock()`. Works at 20 facts, problematic at 200 (2-3K extra tokens against a 28K budget).

- **Fix**: Relevance-score facts per message (keyword or embedding match) and inject only top-N relevant facts. Keep critical facts (timezone, name, role) as always-inject.

### 3.4 Missing Database Indexes

**Severity: Low | Effort: Trivial**

- `conversations`: Missing composite `(bank, created_at DESC)` index — every recall query does a full scan filtered by bank.
- `task_outcomes`: Missing `task_id` index for classifier lookups. Missing `success` index for rate filtering.
- `conversations.trust_tier`: No CHECK constraint (allows any integer).

- **Files**: `src/db/schema.sql`
- **Fix**: Add indexes. One migration.

---

## 4. Hallucination Defense: Patches, Not Prevention

### 4.1 Root Cause: Prompt Overload

**Severity: High | Effort: High**

`buildJarvisSystemPrompt()` produces a dynamically assembled prompt with up to 15 sections (~250 lines of builder code, ~14K tokens output). The model parses: identity rules, COMMIT protocol, journal restrictions, confirmation gates, tool-first reminders, WordPress multi-step protocol, coding workflow, memory directives, and verification instructions. With 30K ceiling and 111 possible tools, cognitive overload is inevitable.

Seven hallucination defense layers exist because the underlying prompt/model interaction inherently produces hallucinations. A system that needed fewer defenses might be a better system.

- **Files**: `src/messaging/router.ts:78-314`
- **Fix**: Decompose into composable prompt modules. Each domain (WordPress, Google, COMMIT, coding) becomes a tested fragment. Only assemble what's needed (already partially done via tool scoping, but the prompt sections don't align with scope groups). Reduce total prompt from 14K to ~8K tokens.

### 4.2 Language-Fragile Detection Patterns

**Severity: Medium | Effort: Low**

`WRITE_CLAIM_PATTERNS` uses Spanish past-tense regexes. Misses: synonyms ("mandé" for "envié"), reflexive forms ("me aseguré de enviar"), periphrastic constructions ("he enviado"), English/Spanish code-switching. Each incident adds a regex, growing the pattern set without achieving coverage.

- **Files**: `src/runners/fast-runner.ts:143-160`
- **Fix**: Two options: (a) Add a lightweight classifier (embedding distance from "I performed an action" vs "I will perform an action") or (b) invert the approach — instead of detecting hallucination, verify execution (check if claimed tool was actually called). Option (b) is partially implemented (Layer 2, wrap-up inventory) but not applied as the primary defense.

### 4.3 Mechanical Replacement Is a Defeat

**Severity: Medium | Effort: Medium**

Layer 5: when token budget is <15%, regex-replace claims with "[action not completed]". The user sees "I searched for X and [action not completed] the results to your email." This is worse than a simple error message saying "I ran out of budget before completing this task."

- **Files**: `src/runners/fast-runner.ts:506-533`
- **Fix**: Replace mechanical substitution with an honest failure message: "I attempted this task but couldn't complete all actions within the token budget. Completed: [list]. Not completed: [list]."

---

## 5. Tool Scoping: Keyword Matching Is Brittle

### 5.1 Scope Decay in Multi-Turn Conversations

**Severity: Medium | Effort: Low**

Only current + last 2 user messages are scanned for scope keywords (`router.ts:332`). A conversation that starts with "let's work on the WordPress site" loses WP tool access after 2 unrelated messages.

- **Fix**: Add scope "stickiness" — once a scope group is activated, keep it active for the remainder of the thread (or until explicitly changed). Reset on new thread.

### 5.2 No Scope Feedback Loop

**Severity: Medium | Effort: Medium**

When the model tries to call a tool not in scope, it gets an error. But the system doesn't record "user asked X, needed tool Y, Y wasn't in scope" as training data. The overnight tuning system evaluates scope patterns against 49 curated test cases, not production misses.

- **Fix**: Log scope misses to a `scope_misses` table (user_message, attempted_tool, active_scopes). Feed into overnight tuning as negative examples. This is the highest-leverage improvement for the tuning system.

### 5.3 False Activation/Deactivation

**Severity: Low | Effort: Low**

- "Did you send that email?" won't activate Google tools because "send" past-tense isn't in triggers.
- Previously fixed false positives ("error" → coding, "form" → browser) indicate pattern fragility.

- **Fix**: Short-term: expand patterns with common missed variants. Long-term: replace keyword matching with a lightweight intent classifier (even a simple TF-IDF or embedding-based one would outperform regex).

---

## 6. Testing: Unit Tests Without Integration Tests

### 6.1 No End-to-End Pipeline Tests

**Severity: High | Effort: Medium**

All 623 tests mock external dependencies (inference, database, tool execution, Telegram). The test suite verifies component logic in isolation but never verifies that components work together.

Missing test scenarios:

- Submit task → classifier → dispatcher → runner → tool execution → result callback
- Provider failover under simulated failures
- Conversation thread management across multiple messages
- Token budget enforcement triggering wrap-up
- Overnight tuning loop executing a real mutation + evaluation cycle
- Hallucination detection → retry → mechanical replacement end-to-end

- **Fix**: Create an integration test suite with a mock LLM server (simple HTTP server returning scripted tool calls). Test the full pipeline per runner type. 5-10 integration tests would cover the critical paths.

### 6.2 Hallucination Tests Are Synthetic

**Severity: Medium | Effort: Low**

`fast-runner.test.ts` tests `detectsHallucinatedExecution()` with crafted inputs. Doesn't test that retry logic, mechanical replacement, and budget headroom check work end-to-end.

- **Fix**: Add integration tests that simulate a hallucinated response (mock LLM returns text claiming writes without tool calls) and verify the full retry → replacement → honest output chain.

---

## 7. Security

### 7.1 Shell Command Substitution Bypass

**Severity: Medium | Effort: Low**

`validateShellCommand("ls $(cat /etc/shadow)")` passes validation because only the base command ("ls") is checked. `$(...)`, backticks, and `${...}` patterns are not detected.

- **Files**: `src/tools/builtin/shell.ts:74-118`
- **Fix**: Add pattern detection for `$(`, `` ` ``, `${` in the command string before parsing. Reject or sanitize.

### 7.2 Confirmation Gates Are Advisory

**Severity: Medium | Effort: High**

`requiresConfirmation` is a flag on the Tool interface that's logged but never enforced. No mechanism exists to pause the fast-runner loop, prompt the user, and resume. The system relies entirely on the LLM obeying a system prompt instruction.

- **Files**: Tool interface in `src/tools/types.ts`, checked nowhere in `src/runners/fast-runner.ts`
- **Fix**: Implement a blocking confirmation flow: fast-runner detects `requiresConfirmation` on tool call → emits confirmation request via Telegram → task enters `awaiting_confirmation` state → user reply resumes execution. Requires task state machine changes.

### 7.3 Loose Credential Detection

**Severity: Low | Effort: Low**

`detectCriticalData()` regex patterns (e.g., `AIzaSy[A-Za-z0-9_-]{33}` for Google keys) could match non-secrets. The auto-persistence safety net stores detected credentials to `user_facts` — a hallucinated API key in an LLM response could be persisted as a "fact."

- **Files**: `src/messaging/router.ts:429-503`
- **Fix**: Only auto-persist from user messages, not from LLM responses. Add a source check before `ensureCriticalDataPersisted()`.

---

## 8. Classifier: Heuristic Scoring Without Calibration

### 8.1 Uncalibrated Weights

**Severity: Medium | Effort: Medium**

Keyword weights are hardcoded without calibration data:

- Word count >200: +4 points
- "Architect" in description: +2 points
- "Multiple files": +3 points

A detailed single-step request gets +4 for word count alone, potentially routing to NanoClaw when Fast would suffice. Why is "multiple files" worth 50% more than "architect"? No data supports these ratios.

- **Files**: `src/dispatch/classifier.ts:107-156`
- **Fix**: Log classifier inputs and outcomes to build a calibration dataset. Run logistic regression or simple grid search on historical data to derive weights. The `task_outcomes` table already has the data — it just needs analysis.

### 8.2 Over-Damped Adaptive Adjustments

**Severity: Low | Effort: Low**

Outcome adjustments require 10+ outcomes before activating, and are clamped to [-3, +4]. The damping is so conservative that the adaptive system barely moves the needle. A runner type with 95% success rate only gets a -1 adjustment.

- **Files**: `src/dispatch/classifier.ts:222-325`
- **Fix**: Lower the minimum sample threshold to 5. Widen the clamp range to [-5, +5]. These are safe because the classifier already has messaging-task guardrails that override scores.

---

## 9. Operational Gaps

### 9.1 No Alerting

**Severity: High | Effort: Low**

If Jarvis stops at 3 AM, nobody knows until they check Telegram. No uptime monitoring, no external healthcheck.

- **Fix**: Add a simple external healthcheck (cron job that curls `/health` and sends Telegram alert on failure). Or use a free uptime service (UptimeRobot, Healthchecks.io).

### 9.2 No Log Rotation

**Severity: Medium | Effort: Trivial**

`/tmp/agent-controller.log` grows indefinitely. No logrotate, no max size, no archival.

- **Fix**: Either logrotate config or switch to pino with `pino-rotate` transport. With systemd, logs go to journald automatically (with built-in rotation).

### 9.3 Budget Resets on Restart

**Severity: Medium | Effort: Low**

Daily spend limit is tracked in-memory. Process crash at $28 spent → new process starts at $0 → can spend another $30.

- **Files**: `src/budget/` (in-memory tracking)
- **Fix**: Persist daily spend to SQLite. Query on startup to resume from last known state.

### 9.4 No Database Backups

**Severity: Medium | Effort: Low**

`mc.db` is 30MB with a single manual backup from March 18. WAL mode provides consistency but not durability against disk corruption or accidental deletion.

- **Fix**: Daily SQLite `.backup` command via cron. Keep 7 days of rotating backups. ~5 lines of bash.

### 9.5 No Metrics Export

**Severity: Low | Effort: Medium**

`/health` endpoint returns provider stats and budget, but no Prometheus exporter, no time-series retention. Can't answer "what was the P95 latency last Tuesday?" without grepping logs.

- **Fix**: Add prom-client with a `/metrics` endpoint. Export: inference latency histogram, task completion rate, tool call counts, budget utilization. Grafana optional but valuable.

---

## 10. Overnight Tuning: Not Transaction-Safe

### 10.1 Non-Atomic DB Writes

**Severity: Medium | Effort: Low**

If the process crashes mid-experiment, the variant archive may contain partial data. Run + experiment + variant writes are not wrapped in a transaction. Cost tracker is in-memory and can diverge from DB on crash.

- **Files**: `src/tuning/overnight-loop.ts:460-477`
- **Fix**: Wrap experiment lifecycle (create → evaluate → archive/discard) in a SQLite transaction. Persist cost tracker to DB alongside run record.

### 10.2 No Per-Experiment Timeout

**Severity: Medium | Effort: Low**

If a single eval hangs, it blocks the entire loop. The only timeout is the global 8-hour cap.

- **Files**: `src/tuning/overnight-loop.ts:386-405`
- **Fix**: Add a per-experiment timeout (e.g., 30 minutes). Use AbortController to cancel eval runner on timeout. Record as "timeout" status.

### 10.3 Insufficient Seed Data

**Severity: Low | Effort: Medium**

49 test cases cover basics but miss edge cases in: bilingual scoping, multi-step workflows, provider-specific quirks, vision tasks, and schedule management.

- **Fix**: Expand to 200+ cases. Use the `scope_misses` table (once implemented, see 5.2) as a source of real-world negative examples.

---

## Priority Matrix

### P0 — High Impact, Low Effort (Do First)

| #   | Item                                 | Effort |
| --- | ------------------------------------ | ------ |
| 1.2 | Systemd unit for crash recovery      | 30 min |
| 3.4 | Missing database indexes             | 15 min |
| 7.1 | Shell command substitution detection | 1 hour |
| 9.2 | Log rotation                         | 30 min |
| 9.3 | Budget persistence to SQLite         | 1 hour |
| 9.4 | Database backup cron                 | 30 min |

### P1 — High Impact, Medium Effort (Do Next)

| #    | Item                                           | Effort   |
| ---- | ---------------------------------------------- | -------- |
| 2.1  | Extract `inferWithTools` into composable units | 1-2 days |
| 3.1  | SQLite FTS5 for memory recall                  | 1 day    |
| 5.2  | Scope feedback loop (log misses)               | Half day |
| 6.1  | Integration test suite (mock LLM server)       | 2 days   |
| 9.1  | External healthcheck / alerting                | 1 hour   |
| 2.5  | Consolidate hardcoded constants                | Half day |
| 10.1 | Transaction-safe overnight tuning              | 2 hours  |
| 10.2 | Per-experiment timeout                         | 1 hour   |

### P2 — Medium Impact, Variable Effort

| #   | Item                                                      | Effort   |
| --- | --------------------------------------------------------- | -------- |
| 1.1 | Worker threads for inference                              | 2-3 days |
| 1.3 | Thread map TTL eviction                                   | 1 hour   |
| 1.4 | Task queue with backpressure                              | 1 day    |
| 2.2 | Paired message pruning for truncation                     | 1 day    |
| 2.3 | Configurable degradation thresholds                       | 2 hours  |
| 3.2 | Hindsight circuit breaker improvements                    | Half day |
| 3.3 | Relevance-scored user facts                               | 1 day    |
| 4.2 | Execution-verification-first hallucination defense        | 1-2 days |
| 4.3 | Honest failure messages instead of mechanical replacement | 2 hours  |
| 5.1 | Scope stickiness in multi-turn conversations              | 2 hours  |
| 7.3 | Source-check on credential auto-persistence               | 1 hour   |
| 8.1 | Classifier weight calibration                             | 1 day    |

### P3 — Structural / Long-Term

| #    | Item                                         | Effort   |
| ---- | -------------------------------------------- | -------- |
| 2.4  | SSE streaming responses                      | 2-3 days |
| 4.1  | Prompt decomposition into composable modules | 3-5 days |
| 5.3  | Embedding-based tool scoping                 | 2-3 days |
| 7.2  | Blocking confirmation flow                   | 3-5 days |
| 9.5  | Prometheus metrics export                    | 1-2 days |
| 10.3 | Expand seed data to 200+ test cases          | 2-3 days |

---

## Closing Note

Every defense layer, every workaround, and every hardcoded threshold in this codebase was born from a real production incident. That's the system's greatest strength — it's battle-tested — and its greatest weakness — it's accreted, not designed. The path forward isn't rewriting. It's disciplined extraction of accreted complexity into testable, composable units, starting with the P0 items that take 30 minutes each and compound into operational stability.

The most honest architectural observation: all 7 hallucination defense layers exist because the underlying approach (large dynamic prompt + budget model + many tools) inherently produces hallucinations. Reducing prompt complexity may eliminate more hallucinations than adding an 8th detection layer.
