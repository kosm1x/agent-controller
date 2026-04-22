# Full System Audit — Methodology & Session Plan

> **Trigger**: Next session after compaction following 2026-04-22 session 100.
> **Baseline**: `docs/benchmarks/2026-04-22-baseline.md` — all deltas measured against these numbers.
> **Scope**: 5 dimensions — efficiency, speed, security, resilience, tool scoping.
> **Output per dimension**: findings report `docs/audit/2026-05-XX-<dimension>.md` with Critical / Major / Warning buckets, explicit Fix-or-Defer decision on each finding.

---

## Ground rules

1. **Evidence-first.** Every finding must cite a file:line, a measured number, a journalctl log line, or a DB query. No speculative claims.
2. **Benchmark-anchored.** Measurements compared against `2026-04-22-baseline.md`. Regressions are findings; so are unchanged numbers in categories where improvement was expected.
3. **Fix-or-Defer closure.** Every finding gets an explicit decision with reasoning + (if defer) trigger to promote.
4. **Double audit for high-blast-radius dimensions** — Security and Resilience get a second-round review by a separate subagent pass after round-1 fixes land.
5. **No feature work.** If an audit finding is "this would be better if we added X capability," defer it to the post-freeze roadmap.

---

## Dimension 1 — Efficiency

**Definition**: resource economy — tokens spent per task, cache hits vs recomputes, wasted computation, redundant LLM calls.

### Probes

| #   | Probe                                                                                                  | Where                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| E1  | Tokens-per-task by agent type (7d + 30d)                                                               | `cost_ledger` JOIN `tasks` on `task_id`; group by `agent_type` + `classification`; compute p50/p90/p99  |
| E2  | Tool-call overhead — avg tool calls per task, ratio of tool-call-then-no-action vs actual work         | `task_provenance` + tool call logs; look for "read same file twice," "search same query twice" patterns |
| E3  | Deferred-tool activation efficiency — how often does scope activation load tools the task never uses?  | Log scope activation + actual tool invocations; target: ≥70% of activated deferred tools get called     |
| E4  | L1/L2 cache hit ratios in data layer (F1)                                                              | `api_call_budget` + cache instrumentation in `src/finance/data-layer.ts`                                |
| E5  | Memory search / reflect — 5s avg latency at baseline. Is this I/O bound, compute bound, or LLM bound?  | `journalctl` pattern-match `[memory]` log lines + per-call timing                                       |
| E6  | Conversation thread buffer size vs actually-used context tokens                                        | Log prompt sizes; flag any case where the buffer is >2x actually used                                   |
| E7  | Scheduled task duplication / overlap — are two different rituals hitting the same LLM path within 30s? | `scheduled_tasks.last_run_at` + `schedule_runs` cross-check                                             |
| E8  | Prompt token audit — are there static prompt blocks that could be cached or trimmed?                   | Inspect `src/runners/fast-runner.ts` prompt-building path; measure each block size                      |

### Success criteria

- Median tokens-per-task for fast-runner: **≤25% increase** vs baseline despite Sonnet verbosity
- Tool-deferral activation yield: **≥70%** (tools loaded → tools called)
- Cache hit ratio in data layer: **≥80%** (H2 hardening was shipped in F1)
- No prompt block >10 KB that isn't already in a cacheable system-prompt position

---

## Dimension 2 — Speed

**Definition**: wall-clock latency per user interaction, p50/p90/p99 tail behavior, throughput ceilings.

### Probes

| #   | Probe                                                                                  | Where                                                                                   |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S1  | Fast-runner p50/p90/p99 end-to-end latency (user message → first response) by scope    | `conversations` + `tasks` timestamp deltas; split by scope (briefing, chart, ads, etc.) |
| S2  | Heavy-runner PER loop wall-clock — plan+execute+reflect cycle                          | `task_provenance` phase timestamps                                                      |
| S3  | Nanoclaw container spawn overhead — measured post-session-100 rebuild                  | spawn-to-first-log-line via journalctl timestamps                                       |
| S4  | Tool latency distribution (full catalog) — not just the 8 in `/health` topByLatency    | Instrument every tool handler; p50/p90 per tool over 7d                                 |
| S5  | MCP bridge round-trip — lightpanda + playwright MCP call latency                       | `src/mcp/bridge.ts` instrumentation                                                     |
| S6  | Cold-start penalty — fast-runner's first message after process restart vs steady-state | A/B measurement across restart events                                                   |
| S7  | Thread-buffer recall latency — `memory_search` at 5.4s avg is suspicious               | Profile with `node --prof` or `clinic doctor`                                           |
| S8  | Scheduled-task polling loop — every 60s scan over all rows, any slow queries?          | Capture `EXPLAIN QUERY PLAN` on the key selects                                         |

### Success criteria

- Fast-runner p90 first-response: **≤20s** (vs Sonnet cold call ~7s + tool round-trip ~5s + wrap ≤3s)
- Heavy-runner PER loop p90: **≤45s** for trivial task (nanoclaw smoke today was 28s)
- Memory search p90: **≤1s** (current 5s avg is likely embedding-service round-trip; if Gemini API key is unset that's the root cause — see baseline logs)
- No tool with p90 >10s that isn't inherently bounded by external I/O

---

## Dimension 3 — Security

**Definition**: input validation, credential handling, SSRF / path-traversal surface, isolation guarantees, admin-endpoint auth.

### Probes

| #     | Probe                                                                                                                                                                                   | Where                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Sec1  | SSRF sweep — every tool that fetches user-controlled URLs must call `validateOutboundUrl()`                                                                                             | Grep for `fetch(`, `page.goto(`, `http.get(`; cross-check against `validateOutboundUrl` call sites |
| Sec2  | Path-traversal — every tool accepting filesystem paths must reject `..`, absolute paths outside allowlist, symlink escapes                                                              | `file_read`, `file_write`, `file_edit`, `video_html_compose`, `screenshot_element` output path     |
| Sec3  | Container volume allowlist review — exhaustive list of `/root/claude/`, `/tmp/`, `/root/.config/gh`, `/root/.claude/.credentials.json` entries; confirm each mount is minimum-privilege | `src/runners/container.ts:101-105`                                                                 |
| Sec4  | Admin endpoint auth — `/api/admin/*` — X-Api-Key enforcement, X-Kill-Passphrase required for destructive ops                                                                            | `src/api/admin/*`                                                                                  |
| Sec5  | MCP token scope enforcement — `scope='read_only'` CHECK constraint + runtime enforcement                                                                                                | `src/api/mcp-server/auth.ts`                                                                       |
| Sec6  | Credential surface — what reads `.env`? What reads `~/.claude/.credentials.json`? What gets logged?                                                                                     | Grep + log-review for accidental secret prints                                                     |
| Sec7  | `shell_exec` scope — sandbox rules, command blocklist, user-confirmation gate                                                                                                           | `src/tools/builtin/shell.ts`                                                                       |
| Sec8  | `jarvis_dev` commit authoring — commit author identity, SSH vs HTTPS preference, `--no-verify` use                                                                                      | `src/tools/builtin/jarvis-dev.ts`                                                                  |
| Sec9  | Rate-limit coverage — MCP server + public endpoints                                                                                                                                     | `src/api/mcp-server/rate-limit.ts` + reverse-proxy config                                          |
| Sec10 | Prompt injection resistance — fetched content → LLM → persisted → downstream prompt chain; sanitize at storage boundary per `feedback_llm_content_laundering_pattern.md`                | `validateKbEntry` + any content-persistence path                                                   |

### Success criteria

- 0 Critical findings
- All SSRF / path-traversal surfaces have explicit validation calls with tests
- All container mounts are read-only unless writable access is justified in a code comment
- No credential strings reachable via journalctl or task output
- **Double-audit round required** — a second subagent re-reviews round-1 fixes for completeness

---

## Dimension 4 — Resilience

**Definition**: recovery from failures, circuit breaker behavior, retry discipline, degradation paths, data safety.

### Probes

| #   | Probe                                                                                                                              | Where                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| R1  | Provider failure recovery — what happens on Sonnet 500? Anthropic quota exhaustion? Credentials expiry inside a container?         | Chaos test: rotate `~/.claude/.credentials.json` to invalid; verify failure is loud + fallback activates |
| R2  | Circuit breaker state on SDK path (v7.9 W4) — does Sonnet downtime trigger the same breaker fast-runner uses?                      | `src/runners/status.ts` + `src/inference/claude-sdk.ts`                                                  |
| R3  | Task abort / orphan cleanup — when a container dies mid-task or the service restarts, do stuck `in_progress` tasks get reconciled? | `prometheus_snapshots` + restart-reconcile logic                                                         |
| R4  | SQLite WAL checkpoint discipline — graceful shutdown checkpoints; what about SIGKILL? Test DB integrity after hard kill            | Run `PRAGMA integrity_check` after induced SIGKILL                                                       |
| R5  | Scheduled task delivery failures — if a ritual's LLM call errors, does the task get retried? Silently dropped?                     | `schedule_runs` + error handling in scheduler                                                            |
| R6  | Memory backend degradation — Hindsight down vs SQLite fallback; are writes queued or lost?                                         | `src/memory/*` dual-backend path                                                                         |
| R7  | NorthStar sync — collision handling between local edits and COMMIT webhook writes; bootstrap empty-journal behavior                | `src/northstar/sync.ts` + `feedback_northstar_sync_gaps.md`                                              |
| R8  | Orphan subprocess handling — lightpanda + graphify subprocesses if main process crashes                                            | Test via kill of main PID; check if children are reaped                                                  |
| R9  | Budget exhaustion — daily / monthly cap hit; does the service degrade or hard-stop?                                                | `src/budget/service.ts` + consumer call sites                                                            |
| R10 | Telegram 409 flap — how long does the auto-recover last before it gives up? What's the `maxRestarts` cap?                          | `src/messaging/telegram.ts` polling loop                                                                 |

### Success criteria

- 0 Critical findings
- All "fail-loud" paths documented; no silent fallbacks on critical routing
- WAL integrity survives SIGKILL
- Scheduled task failures produce an `events` row with category=`schedule_run` + type=`failed`
- **Double-audit round required**

---

## Dimension 5 — Tool scoping

**Definition**: ACI quality of tool descriptions, scope-regex precision, deferral efficiency, false-positive / false-negative activation rates.

### Probes

| #   | Probe                                                                                                                                                                                    | Where                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T1  | Scope activation hit/miss rates by scope group — for each regex, over 7d log: how many messages matched? How many needed it?                                                             | `scope_telemetry` table                                                                          |
| T2  | Deferred-tool loading yield — per scope group, % of activated tools actually called in the resulting task                                                                                | `scope_telemetry` + `task_provenance` JOIN                                                       |
| T3  | Tool description length audit — every tool's description; flag any >800 tokens (prompt bloat) or <100 tokens (ACI underinvestment)                                                       | Tool registry introspection                                                                      |
| T4  | Zod schema `.describe()` coverage — every field on every tool's input schema should have a describe                                                                                      | Static analysis of schema files                                                                  |
| T5  | Enum vs free-string — fields that could be enums but aren't                                                                                                                              | Static analysis                                                                                  |
| T6  | Scope regex false-positive audit — each scope group's regex against a corpus of past user messages classified as scope-free                                                              | Backtest: replay 30d `conversations.user_message` against current regex; flag unexpected matches |
| T7  | Scope regex false-negative audit — messages where the user clearly wanted a scope-gated tool but scope didn't activate; `error_max_turns` after tool-not-found errors often signals this | Log-grep for "tool X not available" followed by user retry                                       |
| T8  | Unicode / accent handling per `feedback_nfd_unicode_scope_regex.md` — every non-ASCII scope regex must be preceded by NFC normalization                                                  | Inspect `normalizeForMatching` call graph                                                        |
| T9  | Tool-description drift from implementation — does the description still match what the handler does?                                                                                     | Diff against git blame on description + handler                                                  |
| T10 | Dead tools — registered but never called in 60 days                                                                                                                                      | `cost_ledger` + tool registry cross-check                                                        |

### Success criteria

- Scope false-positive rate ≤5% on backtest
- Scope false-negative rate ≤5% on backtest (measured by user-retry-after-tool-error)
- Every schema field has `.describe()`
- No tool descriptions >800 tokens
- Zero dead tools (either justify keep or prune)

---

## Session plan — how to run this

### Session N+1 (next session after compaction)

1. Read baseline `2026-04-22-baseline.md`.
2. Start with **Efficiency** — smallest blast radius, measurable via SQL queries alone.
3. Produce `docs/audit/2026-05-XX-efficiency.md` with findings table + Fix-or-Defer decisions.
4. Land P0 fixes from Efficiency before moving on.

### Session N+2

5. **Speed** audit — requires instrumentation; may need to add timing hooks before measuring.
6. Produce `docs/audit/2026-05-XX-speed.md`.
7. Land P0 fixes.

### Session N+3

8. **Security** audit — 2-round discipline required.
9. Produce `docs/audit/2026-05-XX-security.md`.
10. Land all Critical + Major fixes before merge.

### Session N+4

11. **Resilience** audit — 2-round discipline required. Requires chaos tests (safe, reversible).
12. Produce `docs/audit/2026-05-XX-resilience.md`.
13. Land all Critical + Major fixes before merge.

### Session N+5

14. **Tool scoping** audit — largest corpus to backtest against, most measurement work.
15. Produce `docs/audit/2026-05-XX-tool-scoping.md`.
16. Land P0 fixes.

### Session N+6 (re-benchmark)

17. Run all measurement probes again; produce `docs/benchmarks/2026-05-22-post-audit.md`.
18. Compare against baseline; document deltas.
19. Declare the window closed or identify follow-up sessions.

---

## Known anti-patterns this audit should expose

From prior session feedback (keep top-of-mind):

1. **Incomplete migrations** — `feedback_incomplete_migration.md`. If a "X is now primary" statement touched only one file, grep all callers before declaring done.
2. **Layered bug chains** — `feedback_layered_bug_chains.md`. Trace full request path; 3-5 bugs stacked is the norm.
3. **Extractor self-reflection loops** — LLM extractors summarizing agent's own tool usage create self-reinforcing distortion. Fix at storage boundary.
4. **Content laundering** — `feedback_llm_content_laundering_pattern.md`. Fetched-content → LLM → persisted → downstream prompt needs sanitization at storage boundary, not per-consumer.
5. **NFD unicode in scope regex** — ensure every non-ASCII char class is NFC-normalized.
6. **Docker image tag drift** — session 100 pattern 2. Configured tags must exist; surface loudly when they don't.
7. **Env propagation on provider flags** — session 100 pattern 1. Every envVars dict spawning children.

---

## Deliverables

By day-30:

1. `docs/benchmarks/2026-04-22-baseline.md` — THIS session (done)
2. `docs/benchmarks/2026-05-22-post-audit.md` — end of window
3. `docs/audit/2026-05-XX-efficiency.md`
4. `docs/audit/2026-05-XX-speed.md`
5. `docs/audit/2026-05-XX-security.md`
6. `docs/audit/2026-05-XX-resilience.md`
7. `docs/audit/2026-05-XX-tool-scoping.md`
8. Feedback memory files for any patterns that generalize beyond single-finding scope.
9. All P0 hardening items from `30d-hardening-plan.md` closed or explicitly deferred with trigger.
10. Re-compute all baseline metrics; document improvements/regressions.
