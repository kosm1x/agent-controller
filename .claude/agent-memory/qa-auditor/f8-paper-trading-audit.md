---
name: f8-paper-trading-audit
description: F8 Paper Trading (Phase β S11) audit — PASS WITH WARNINGS. Hardcoded "flam" strategy, silent stale-quote fallback distorts total equity, dead weekly-dedup helper with LIKE-wildcard risk, no scope regex tests, thesis_id never linked to fills
type: project
---

# F8 Paper Trading Audit (Phase β S11) — 2026-04-19

Branch: `phase-beta/f8-paper-trading`. 71 new tests, all green. typecheck clean. Verdict: **PASS WITH WARNINGS**.

## Critical — 0 blockers found

## Warnings

1. **Hardcoded "flam" strategy in ship-gate lookup** (`paper-trading.ts:121`) — `readLatestBacktest("flam")`. If operator renames strategy or runs a different one, tool reports "no backtest run found" incorrectly. Accept a `strategy` param or fall back to unqualified latest.
2. **Silent stale-quote fallback distorts totalEquity** (`paper-equity-adapter.ts:224-247`) — when `getMarketData` fails for some but not all symbols, `getPositions()` returns mixed-accuracy marketValue (some at avg_cost, some at live). `runRebalance` then uses this distorted `totalEquity` to compute target shares for GOOD symbols, leading to off-target weights. Add a `stale: boolean` field on `Position` + let `getBalance/planOrders` react (either skip rebalance or surface warning).
3. **Dead weekly-dedup helper with LIKE-wildcard injection** (`paper-persist.ts:328-346`) — `readLatestPortfolioThesisForIsoWeek` is exported but never called. Plan §D-K mentions ISO-week dedup; not enforced. Additionally, `%"account":"${account}"%` interpolates account name into a LIKE pattern — `_` / `%` in account would act as wildcards (no SQL injection, but false matches). Either delete or wire it + escape wildcards.
4. **thesis_id never linked to fills** (`paper-equity-adapter.ts:194`, `paper-executor.ts:196`) — fills insert `thesisId: null`, then executor inserts thesis AFTER fills. No follow-up UPDATE. `paper_fills.thesis_id` stays null forever → joining history to rebalance-intent not possible. Pre-generate the thesis ID (or reorder: insert thesis first with 'pending' status, then fills link, then update status).
5. **No scope-regex activation tests** — `PAPER_TOOLS` wiring is tested (`write-tools-sync.test.ts:164`) but the scope pattern at `scope.ts:516` has zero coverage. Risk: future regex edits silently break activation. The pattern misses plurals like "historial de fills recientes" (regex needs `recient\w*`) and "ultimos fills", and has a minor false-positive on "please rebalance the disk" (bare "rebalance" verb unanchored).
6. **No rejects-at-runRebalance test** — `paper-executor.test.ts:251` checks `ordersSkipped > 0` (from `planOrders` no_price path) but no test injects `placeOrder` rejects (insufficient_cash, short_sell, stale_price) to verify `summary.rejects` surfaces them. Add one where a small-cash account + large weight causes an in-flight `insufficient_cash`.
7. **Concurrency: two parallel rebalances can interleave** — each `paper_rebalance` constructs a fresh adapter, `placeOrder` opens per-order transactions. No outer account-level lock. Low risk given weekly cadence but not enforced (the plan says "Typically once per week" but nothing prevents it).
8. **fmt()-formatted large numbers lack thousands separators** — `100000.00` less readable than `100,000.00` for operator delivery. Cosmetic.

## Info / nits

- `paper_portfolio` / `paper_history` auto-create default $100K account via `initAccount` on first access (`paper-equity-adapter.ts:77`). Harmless (idempotent) but may mislead a user who typos the tool name before ever rebalancing.
- `initial_cash` param silently ignored after first call — behavior documented in tool desc but not echoed in response. User flagged #12. Consider including "cash=100000 (existing account, initial_cash ignored)" line in output.
- `paper_history` symbol filter is case-sensitive — doc states this, but lowercasing defensively (`symbol.toUpperCase()`) would avoid operator confusion.
- `Position.unrealizedPnl` is always `0` exactly when quote fetch fails — indistinguishable from genuinely-flat positions. Tied to warning #2.
- `PAPER_QUOTE_STALE_MS = 35d` — reasonable for weekly-first cadence (5 weekly bars), but the code offers no user-facing diagnostic when a rebalance degrades due to stale quotes (shown only as "skipped=N").
- Test comment `paper-executor.test.ts:82` says "0.1% equity" for 0.5-share delta on $100K — actually 0.10% = 10bps, which is just below MIN_REBALANCE=25bps. Comment accurate despite ambiguous wording.
- `weightsBySymbol` throws on malformed `signalKey` without context — would crash tool execution. Bounded risk (alpha_run always writes well-formed keys) but worth a try/catch with a clean error.

## Integration 7-row checklist — verified complete

- `src/tools/sources/builtin.ts:298-301` — 3 tools imported + registered
- `src/messaging/scope.ts:274` — `PAPER_TOOLS` const
- `src/messaging/scope.ts:516` — scope regex pattern
- `src/messaging/scope.ts:775` — `activeGroups.has("paper")` attach
- `src/runners/fast-runner.ts:327` — `paper_rebalance` in `WRITE_TOOLS`
- `src/runners/write-tools-sync.test.ts:164` — sync test added
- `src/memory/auto-persist.ts:159-161` — Rule 2b includes all 3 tools
- all 7 rows touched for all 3 tools ✓
