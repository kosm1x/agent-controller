---
name: F9 Morning/EOD Rituals Round 2 Audit
description: Round-2 verification of F9 round-1 fixes on phase-beta/f9-rituals. PASS WITH WARNINGS — 2 criticals fixed cleanly, but 3 features (C2 consume, W2 read-only assertion, W4 trading-day gate) lack regression tests; task.failed path doesn't consume budget.
type: project
---

# F9 Rituals Round 2 Audit (2026-04-20)

## Verdict: PASS WITH WARNINGS

Round-1 fixes landed correctly. Tests pass (2850/2850), typecheck clean. Three coverage gaps + one design gap noted.

## Round-1 fixes verified

- **C1 (telegram_send)**: No reference in tools/requiredTools of either template. Only in doc-comments as warnings. Grep-sweep confirmed.
- **C2 (budget consume)**: `recordRitualTokensForTask` correctly SELECTs `runs.token_usage` with ORDER BY id DESC LIMIT 1. Dispatcher persists `token_usage` BEFORE emitting `task.completed`, so no race. Dynamic import is Node 22 module-cached → no hot-path cost after first call.
- **W1 (todayLabel timezone)**: Backward-compat default param = `RITUALS_TIMEZONE`; all 4 call sites pass `ritual.timezone` which is `undefined` for non-market rituals → falls back cleanly. No other caller of scheduler.ts's local `todayLabel`.
- **W2 (read-only)**: `market-ritual.ts` no longer calls `initBudget`. Synthesizes default from `DEFAULT_LIMITS`. Note: test assertion doesn't explicitly verify no row is written.
- **W4 (trading-day gate)**: Placed after `alreadyRanToday` but before `submitTask`. On holiday, we skip without recording a task marker — correct.
- **R1 (tools-resolve test)**: 2 new tests instantiate real ToolRegistry + BuiltinToolSource, check every tool resolves except RUNTIME_REGISTERED_TOOLS allowlist (gmail_send). Catches phantom tools.

## New findings

### Warning W-R2-1: `task.failed` path doesn't consume budget

**File**: `src/messaging/router.ts:1997-2011`

`handleTaskFailed` clears `ritualWatches` map (line 2001) but does NOT call `recordRitualTokensForTask`. A ritual that consumed N tokens before failing is not charged against the daily budget. This creates a budget-bypass path:

- Runaway failing ritual consumes tokens, gets retried, fails again, etc. — never exhausts budget.
- The dispatcher's required-tool auto-retry (line 453-460) creates a NEW task via `submitTask` that has NO ritual watcher → both silent AND budget-bypassing.

The whole point of the budget is to stop runaway loops, which typically manifest as failures. Right now the budget only counts successful completions. Single-operator v1 acceptable, but the purpose-mismatch is worth documenting.

Fix: mirror the C2 wire in `handleTaskFailed` for market rituals.

### Warning W-R2-2: No regression test for C2 consume

**File**: `src/rituals/alert-budget.test.ts`

`recordRitualTokensForTask` is the entire C2 fix — zero unit coverage. The function has 5 distinct branches:

1. No row in `runs` for task → returns null
2. `token_usage` is null → returns null
3. `token_usage` is malformed JSON → returns null (caught)
4. `token_usage` parses but has no numeric prompt/completion → returns null
5. Happy path → calls `consumeBudget`

None of these branches are exercised. If a future refactor breaks the SELECT query, JSON parse, or the consumer shape, no test catches it.

### Warning W-R2-3: No regression test for W4 trading-day gate

**File**: `src/rituals/scheduler.test.ts`

The scheduler-level trading-day gate (`if (!isNyseTradingDay(today)) return`) has no test. Future refactor could remove it silently. Test would:

- Stub `isNyseTradingDay` to return false
- Invoke the market-morning-scan callback
- Assert `submitTask` not called, `watchRitualTask` not called

### Info I-R2-1: W2 read-only not asserted

**File**: `src/tools/builtin/market-ritual.test.ts`

The test checks `consumed=0/` in output, which holds whether or not a row gets written (since init writes 0). To actually verify read-only, query `alert_budget` after tool invocation and assert it's empty. Would catch accidental reintroduction of `initBudget` call.

### Info I-R2-2: Dead sync `try/catch` around dynamic import

**File**: `src/messaging/router.ts:1714-1726`

Outer `try/catch` wraps `import("../rituals/alert-budget.js").then(...).catch(...)`. The `import()` call itself returns a Promise synchronously — it can't throw. The outer catch is unreachable. Cosmetic only — the inner `.catch` correctly handles all real error paths.

### Info I-R2-3: Deferral causes 2-3 extra inference rounds for market rituals

**File**: `src/runners/fast-runner.ts:696`

Morning scan has 9 tools, EOD has 8. Both exceed the `skipDeferral<=6` threshold. All 9/8 tools are `deferred: true`. LLM sees 0 full tools on first turn and must load each via deferred-catalog lookup. Extra latency/cost per ritual. Not a correctness issue — the ritual prompts explicitly instruct which tools to call, so lookup is predictable. Consider raising `skipDeferral` threshold for ritual tasks, or marking these tools non-deferred when the ritual's scope is active.

## Not in scope / deferred

- **R2 SELECT-then-UPDATE atomicity in consumeBudget**: single-operator v1, acknowledged.
- **R3 observability**: existing gap, not a regression.
- **R4 bare `nyse` in scope regex**: acceptable.
- **W3 EOD early-close cron**: documented deferral, half-day close still reflected in market_history.

## Grading

- C1, C2, W1, W2, W4, R1 — correctly landed.
- Coverage gaps (W-R2-2, W-R2-3, I-R2-1) — not blocking but shorten the usable test-safety net.
- Budget-bypass on failure (W-R2-1) — not blocking for v1 but defeats budget's stated purpose.
- Cosmetic items (I-R2-2, I-R2-3) — optional.

Round 1 fixes are clean. Round 2 surfaces one design gap (failure path) and three test-coverage gaps.
