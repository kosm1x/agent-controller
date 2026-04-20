---
name: F9 Morning/EOD Rituals audit (round 1)
description: Phase β S12. FAIL. Critical: telegram_send tool doesn't exist; consumeBudget never called in prod.
type: project
---

# F9 Morning/EOD Rituals — Round 1 Audit (2026-04-20)

**Branch:** `phase-beta/f9-rituals`. Last β item before β-addendum.

## Critical

1. **`telegram_send` tool does not exist.** Both ritual templates list it in `tools:` and `requiredTools:`. `toolRegistry.getDefinitions()` silently drops unknown names (registry.ts:123-124). LLM cannot call it → every fire: required-tool retry → mark failed. Existing morning/nightly rituals use `gmail_send` + rely on `watchRitualTask` broadcast for Telegram delivery. Impl-plan §D-E presumed it existed. Fix: remove `telegram_send`, let the router broadcast result text.
2. **`consumeBudget()` never called in production.** Only test-only usage. Without it, `exhausted` always false → the "degrade gracefully" branch is dead wiring. Need a hook at task completion (TaskCompletedPayload has no tokens_used; add, or use RunRow.token_usage).

## Warning

3. **`todayLabel()` uses RITUALS_TIMEZONE (MX), not ritual's own tz.** scheduler.ts:29-33. For 8am/4:30pm ET the MX date equals NY date so fine today, but a future 11pm ET ritual would title with the next MX day → `alreadyRanToday` dedup breaks at the NY/MX boundary.
4. **`alert_budget_status` without `ritual_id` is inconsistent with the one-with-id path.** With id, `initBudget` materializes a row (write side-effect on a "read-only" tool per its description). Without id, shows "no rituals consumed yet" + defaults. Once any id-path call runs, no-args call shows different output. ACI description lies about read-only.
5. **SELECT-then-UPDATE in consumeBudget is not atomic.** User flagged as v1-acceptable (single operator). Note for future multi-writer.

## Info

6. **Regex: bare `nyse`** (word on its own) triggers market_ritual scope — broad but acceptable.
7. **EOD cron 30 16 ET does NOT shift on early-close days** per plan §D-B (which said shift to 30 13). Current config fires 3.5h after 13:00 close on early-close days — works, but comment "30 min after close" is wrong on those days. Either document the deviation or add an early-close shift.
8. **`executeBudget` / exhausted-at stamp is set on consume, not re-cleared if limit later raised.** Unlikely edge case.
9. All NYSE 2024-2027 dates verified: Good Friday 2026=Fri Apr 3 ✓, Memorial Day last-Mon ✓, Juneteenth shifts ✓, Thanksgiving 4th-Thu ✓, July 4 observed ✓, Christmas Eve early close Thu Dec 24 2026 ✓.
10. node-cron 4.2.1 `timezone` option confirmed correct (TaskOptions.timezone in d.ts).

## Test coverage gap

- No test that `executeRitual` for `market-morning-scan` / `market-eod-scan` is end-to-end reachable (scheduler has dispatch case, but no smoke test that the TaskSubmission is submittable + required_tools validate).
- No integration test that tools list resolves all 10 tools (would've caught the `telegram_send` ghost).

## Verdict

FAIL — Critical #1 (no telegram_send) breaks both rituals on first fire. Every production run will loop into required-tool retries and submit a failed task. Round 2 expected.
