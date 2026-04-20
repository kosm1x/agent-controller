---
name: f8-paper-trading-round2
description: Round 2 audit of F8 Phase β S11 — fixes landed; 6 residual warnings, 1 standards violation
type: project
---

Round 2 audit of F8 paper trading (`phase-beta/f8-paper-trading`) on 2026-04-19. Round 1 had 7 warnings — Round 2 PASS WITH WARNINGS.

## What was verified

- **W1 backtest fallback**: `readLatestBacktest("flam") ?? readLatestBacktest()` — works but silent fallback to unrelated strategy.
- **W2 stale-quote**: `Position.stale: boolean` added, adapter marks it, executor aborts unless `allowStale=true`. Tests cover abort path.
- **W3/W4 linkFillsToThesis**: correct for single-operator sequential use; concurrent-rebalance race misattributes fills to earlier thesis.
- **W5 scope regex**: English determiners NOT covered (`rebalance the portfolio` → false). Spanish-only in the regex is a usability regression.
- **W6 rejects path**: mock-adapter rejects test added.

## New residual warnings found in R2

1. **Scope false negative**: `rebalance the portfolio` doesn't activate — only Spanish `la|el|del|de la` matched, not English `the|my|your|this`.
2. **Silent stale-abort**: tool output has no branch for `stalePositionsAborted`; looks identical to an empty no-op rebalance.
3. **`allowStale` unwired + untested**: `RebalanceOpts.allowStale` exists but `paper_rebalance` tool doesn't expose it; no test exercises `allowStale=true`.
4. **linkFillsToThesis race**: W7 says deferred, but the fix ACTIVELY misattributes across concurrent rebalances rather than leaving NULL. Earlier thesis steals later thesis's fills via `filled_at >= startedAt` + `thesis_id IS NULL` UPDATE.
5. **Aborted thesis `outcome='open'`**: stale-abort inserts thesis row with default `outcome='open'`; future "open theses" queries include aborted ones.
6. **No test for thesis_id linkage**: only assertion is `thesis_id=` in tool output text; no SELECT on `paper_fills.thesis_id` after rebalance.

## Recurring audit pattern

- Round 1 flagged W-type issues that led to defensive additions; Round 2 found that some fixes (stale-abort, allowStale) exist in the library layer but aren't wired into the tool handler. Classic half-migration pattern from feedback_incomplete_migration.
