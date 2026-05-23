# Swarm per-sub-task retry policy (queue #231)

**Shipped**: 2026-05-23 (shadow mode).
**Status**: Default OFF (`SWARM_SUBTASK_RETRY_ENABLED=false`).
**Author**: Claude Opus 4.7 + operator (4-question design dialogue).

---

## Problem

Today, when a swarm sub-task fails, the goal-graph cascades FAILED to dependents and the reflector picks up the partial state. A single transient flake on goal-3-of-5 wastes the work of goals 1+2 and cascades 4+5 to failure. Swarm tasks are bigger and more expensive than fast/heavy tasks; the fixed-cost-per-failure economics get worse for larger fan-out.

This document codifies the design decisions for adding bounded per-sub-task retry while preventing the obvious failure modes (infinite retry loops, side-effect double-execution, masking of real bugs as transients).

## Locked decisions

| #                                | Decision                                                                                                                                                                        | Rationale                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1                               | Policy at **swarm-level**; counter primitive (`tasks.retry_count`) at **dispatcher-level**                                                                                      | Localizes the retry policy to the goal-graph context (sub-task state, sibling goals) while keeping the counter shared across mechanisms                      |
| Q2                               | Use existing `Tool.idempotentHint` / `destructiveHint` / `readOnlyHint`. Sub-task is retry-eligible iff every tool called pre-failure satisfies `readOnlyHint ∨ idempotentHint` | Annotations already exist (186/186 production tools annotated, per CLAUDE.md). No new tool-interface surface; conservative defaults via `getToolAnnotations` |
| Q3                               | Shared budget. `tasks.retry_count` is the single counter; dispatcher's `_isRequiredToolRetry` increments it on its retry path                                                   | Prevents the budget from doubling when both mechanisms could fire                                                                                            |
| Q4                               | `tasks.retry_count INTEGER NOT NULL DEFAULT 0` column (additive migration)                                                                                                      | Simple, durable, indexable for analytics; sub-tasks already are their own `tasks` rows                                                                       |
| Q5 (matcher)                     | See [Retry-eligibility taxonomy](#retry-eligibility-taxonomy-q5) — **hallucination_detected is YES** (bundled)                                                                  | Per-Hermes-v0.13 framing; bundled with this ship rather than spun out as a separate item                                                                     |
| Q6 (visibility)                  | `mc_swarm_subtask_retry_total{decision, reason, recovery_mode}` Prometheus counter + `[swarm-retry]` structured log on every decision                                           | Without this the feature ships dark — we'd never know if retries are paying back                                                                             |
| MAX_RETRIES_PER_GOAL             | **1**                                                                                                                                                                           | Hermes ships 1; doubling sub-task budget for a 5-goal swarm = 5× worst-case cost. 1 retry is the right floor                                                 |
| Hallucination recovery           | **Bundled** — re-spawn with sterner prompt addendum, shares budget                                                                                                              | Hermes v0.13 ships them together; structurally close (both = re-spawn with policy)                                                                           |
| Default state                    | **Shadow** — `SWARM_SUBTASK_RETRY_ENABLED=false`. Classifier runs and **logs** the would-decision; does NOT actually retry                                                      | Observe cost ceiling for 1 week before lifting                                                                                                               |
| `_isRequiredToolRetry` migration | **Leave flag** in place. Dispatcher just increments `retry_count` on its retry path                                                                                             | Lower risk for first ship; can refactor later                                                                                                                |

## Retry-eligibility taxonomy (Q5)

The classifier in `src/runners/swarm-retry-policy.ts` runs the failure's `error` string and tool-call trace through three veto gates in order:

| Failure class                                                                   | Retry?      | Recovery mode   | Notes                                                    |
| ------------------------------------------------------------------------------- | ----------- | --------------- | -------------------------------------------------------- |
| Provider transient (429, 5xx, network timeout, ECONNRESET, circuit-open)        | YES         | `plain`         | Plain re-spawn, identical description                    |
| **Hallucination guard fire**                                                    | YES         | `hallucination` | Re-spawn with sterner-prompt addendum (Option A wording) |
| Tool execution error (ENOENT, EACCES, validation, scope)                        | NO          | —               | Same input → same error                                  |
| `max_rounds` / `token_budget` exhaustion                                        | NO          | —               | Same budget → same outcome                               |
| `[timeout after Ns]` (SDK 15-min hard timeout)                                  | NO          | —               | Matches `max_rounds` matcher (NOT generic timeout)       |
| `needs_context` / `blocked`                                                     | NO          | —               | Waiting for user input; won't auto-resolve               |
| `cancelled` (user) / `Service shutdown` (SIGTERM)                               | NO          | —               | User-initiated or operator-initiated; don't second-guess |
| **Side-effect tainted** (any non-idempotent destructive tool fired pre-failure) | NO override | —               | Hard veto regardless of failure class                    |
| Budget cap (`retry_count >= 1`)                                                 | NO          | —               | Predecessor used the retry                               |

**Veto order** (most-specific first, so the rationale string explains the FIRST gate that blocked):

1. Budget cap (cheapest)
2. Failure class is terminal
3. Side-effect taint (requires registry lookup)

## Sterner-prompt addendum (hallucination recovery)

When `recoveryMode === "hallucination"`, the retry submission's description is prepended with:

> ⚠️ IMPORTANT: The previous attempt at this sub-task failed because the response narrated tool calls without actually invoking them. You MUST call the tools you reference. Do not describe results — produce them.

This is Option A from the design dialogue. Option B (reuse `[hallucination guard]` text from fast-runner) was rejected — that text is meant for the LLM that JUST hallucinated, not a fresh-context retry.

## Architecture

```
syncSubTaskStatuses (swarm-runner.ts)
  ↓ on task.status === "failed" AND retryContext provided
attemptSubtaskRetry (swarm-runner.ts)
  ↓
classifyRetry (swarm-retry-policy.ts) — pure
  ├── budget veto (retry_count >= 1)
  ├── class veto (error string matching → reason)
  └── taint veto (tool calls × annotations)
  ↓ if all pass: decision = "retried"
respawn?
  ├── env flag SWARM_SUBTASK_RETRY_ENABLED === "true"
  │     ↓ yes
  │   submitTask({ ..., retryCount: predecessor + 1 })
  │   rewire goalTaskMap[goalId] → new taskId
  │   tracker.status = "pending"
  │   graph stays IN_PROGRESS
  └── shadow mode (flag off)
        ↓ no respawn
      record counter with decision: "shadow_skipped"
      mark goal FAILED as today
```

## Files changed

- `src/db/schema.sql` — additive: `tasks.retry_count INTEGER NOT NULL DEFAULT 0`, `runs.tool_calls TEXT`
- `src/dispatch/dispatcher.ts`:
  - `TaskRow.retry_count: number` field
  - `TaskSubmission.retryCount?: number` (defaults to 0)
  - `INSERT INTO tasks` plumbs `retry_count`
  - `_isRequiredToolRetry` path passes `retryCount: 1`
  - `runs UPDATE` persists `tool_calls` JSON
  - New helper `getRunToolCalls(taskId): string[]`
- `src/runners/swarm-retry-policy.ts` (NEW) — pure classifier + `findSideEffectTaint` + `buildRetryDescription` + `MAX_RETRIES_PER_GOAL` constant + Option A addendum constant
- `src/runners/swarm-runner.ts`:
  - `SwarmRetryContext` interface
  - `syncSubTaskStatuses` accepts optional 4th `retryContext` arg
  - `attemptSubtaskRetry` helper (respawn + telemetry)
  - `execute()` poll loop passes retryContext (parentTaskId, tools, goalsById)
- `src/observability/prometheus.ts`:
  - `mc_swarm_subtask_retry_total{decision, reason, recovery_mode}` counter
  - `recordSwarmSubtaskRetry()` exported helper with cardinality guards

## Tests

- `src/runners/swarm-retry-policy.test.ts` (NEW) — 32 tests:
  - Retryable classes (provider_transient × 5 patterns, hallucination)
  - Terminal classes (tool_error × 3, max_rounds × 3, needs_context × 2, cancelled × 2, null/empty)
  - Side-effect taint veto (read-only OK, idempotent OK, destructive vetoed, unknown vetoed, findSideEffectTaint determinism)
  - Budget veto (cap fires first, MAX_RETRIES_PER_GOAL pinned at 1)
  - `buildRetryDescription` (plain identity, hallucination prepend, Option A wording locked, defensive "none" mode)
- `src/runners/swarm-runner.test.ts` extension — 8 integration tests:
  - Absent retryContext → legacy behavior preserved (backward compat)
  - Shadow mode + retryable → counter `shadow_skipped`, no respawn
  - Enabled mode + retryable → respawn + counter `retried` + tracker.pending
  - Hallucination recovery → addendum in retry description
  - Budget cap → `skipped_budget`, no respawn
  - Side-effect taint → `skipped_side_effect`, no respawn
  - Terminal class → `skipped_terminal`, no respawn
  - Strict env flag (only literal `"true"` activates; `"1"` stays shadow)

## Acceptance criteria — flipping shadow → enabled

After **1 week of shadow logs** (target window: 2026-05-30), operator runs:

```bash
sqlite3 ./data/mc.db "
  SELECT
    SUM(CASE WHEN decision='shadow_skipped' THEN 1 ELSE 0 END) AS would_retry,
    SUM(CASE WHEN decision LIKE 'skipped%' AND decision != 'shadow_skipped' THEN 1 ELSE 0 END) AS vetoed,
    SUM(1) AS total_decisions,
    SUM(CASE WHEN reason='provider_transient' AND decision='shadow_skipped' THEN 1 ELSE 0 END) * 1.0 /
      NULLIF(SUM(CASE WHEN decision='shadow_skipped' THEN 1 ELSE 0 END), 0) AS pct_provider_transient
  FROM (
    -- Pull labels from prom; need a journalctl grep until S3 evaluator
    -- has a Prom→SQLite ingest. Workaround: grep journalctl for the
    -- [swarm-retry] structured log line over the 7d window and parse the
    -- decision=X reason=Y labels.
  )
"
```

**Flip to enabled iff** ALL THREE hold:

1. **Shadow retry rate < 15% of swarm sub-tasks** — would_retry / total swarm sub-tasks. Sanity ceiling — if more than 15% would retry, the substrate has a deeper problem to fix first.
2. **Provider-transient class > 50% of would-retries** — pct_provider_transient over the shadow window. Signal that retries would actually pay back; if it's all `max_rounds` (which is NOT retryable in the classifier but worth checking the reason distribution), we'd be double-spending without benefit.
3. **Zero `skipped_side_effect` false positives observed** — manually review the rationale strings. If the classifier is marking known-idempotent tools as destructive, fix the classifier or the tool's annotations before enabling.

To flip:

```bash
echo "SWARM_SUBTASK_RETRY_ENABLED=true" >> .env # or systemd EnvironmentFile
systemctl restart mission-control
```

To revert:

```bash
sed -i '/SWARM_SUBTASK_RETRY_ENABLED/d' .env
systemctl restart mission-control
```

## qa-audit folds (2026-05-23, pre-ship)

The R1 audit caught one critical and several smaller findings. Folded same-bundle before push:

- **C1 — `findSideEffectTaint` logic gap**. Original veto required `destructiveHint: true` as a third clause. Three production tools have `readOnlyHint: false, idempotentHint: false, destructiveHint: false` (reversible-but-non-idempotent pattern): `jarvis_file_update` (appends accumulate), `jarvis_file_move` (second call ENOENT), `submit-report` (duplicate row). Fix: drop the `destructiveHint` requirement. Veto condition is now `NOT readOnly AND NOT idempotent`, independent of destructive. +3 regression tests pin the three production tools by name. **Caught before activation** — feature ships in shadow so no production double-write, but the fix MUST land before `SWARM_SUBTASK_RETRY_ENABLED=true` is flipped.
- **SV1 — JSDoc said "most specific first" for veto order**. Actual order is cheapest-first (budget compare → regex matching → registry lookup). Reworded JSDoc.
- **W1 — Sanitization sentinel collapsed unknown labels to real buckets**. Future typos at the call site (e.g. `skipped_taint` instead of `skipped_side_effect`) silently bucketed as `skipped_terminal`. Fix: collapse unknown labels to distinguished `unknown_label` sentinel. +4 prometheus tests pin this.
- **W3 — Shadow rows lost recovery_mode info**. The label was clobbered to `"none"` when env flag was off, even though the classifier said "retry plain"/"retry hallucination". Operator-facing dashboard claim "see what the retry would do" lost the mode info. Fix: preserve recoveryMode in shadow rows; only collapse to "none" when the classifier itself said skipped\_\*.
- **W2 — Concurrent fan-out storm bypasses MAX_CONCURRENT_SUBTASKS** — DEFERRED. If 10 sub-tasks all fail at the same poll tick, all 10 respawn synchronously without slot accounting. Not blocking in shadow mode; needs operator decision on whether to add retry-slot accounting or keep the simple model. Tracked below.
- **W4 — `.catch` path in attemptSubtaskRetry untested** — DEFERRED. Small, but the path is small and visually correct; pin worth adding if a real submitTask failure surfaces in journalctl.
- **W5 — Retry-of-retry integration test missing** — DEFERRED. Unit-tested at the classifier level (budget cap); the two-poll-tick integration cycle is covered by inference (predecessor.retry_count=1 means classifier vetoes); add if a regression surfaces.

## Deferred / known gaps

- **Post-retry outcome tracking** — counter currently records the decision, not the outcome of the respawn. Adding a second event (`mc_swarm_subtask_retry_outcome_total{retried_success | retried_fail}`) would let us measure "what fraction of retried sub-tasks actually succeeded on the retry?" Worth doing once we have shadow → enabled data.
- **Cooldown / backoff** — design dialogue mentioned 2-5s backoff for provider transients. Not shipped in this pass; the next poll tick is 3s anyway so the natural cadence approximates this.
- **W3 from queue #228 still applies** — env-flag gate at the call site is untested at the call site (e.g. no test verifies `SWARM_SUBTASK_RETRY_ENABLED=true` actually flows from environment through to respawn). The unit tests cover the classifier exhaustively and the integration tests mock the env flag; same precedent gap as `heavyRunnerContainerized`.
- **Goal-graph-level retry budget** — currently per-sub-task. A swarm with 10 sub-tasks could retry up to 10 times total. If we observe pathological cases (e.g. 8 sub-tasks all hit provider transients on the same minute), we may need a goal-graph-level budget too. Not shipped pending data.
- **Hallucination class detection** — currently matches `/hallucinat/i`, `/\[hallucination guard\]/i`, `/narrat(ed|ing) tool call/i`. Fast-runner's actual hallucination guard error messages may not cleanly fall into these matchers — verify against journalctl after the first real hallucination fires.

## Related memories

- `feedback_sdk_cache_and_phantom_cost_2026_05_23.md` — wrapper-vs-direct seam pattern (same lesson applies: this ship adds the policy at the seam, not at a wrapper)
- `feedback_drift_signal_activation_and_aux_haiku_plumbing_2026_05_23.md` — env-direct flag pattern is the safe default
- `feedback_round2_audit_pattern.md` — R2 cadence (this ship is a behavior-extracting refactor with a new module — candidate for R2 after the audit)
- `feedback_layered_bug_chains.md` — failure-class matchers must be specific (`[timeout after Ns]` must fire BEFORE generic timeout to avoid classifying SDK hard-timeouts as transient)
