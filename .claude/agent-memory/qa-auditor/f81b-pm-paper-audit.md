---
name: F8.1b PolymarketPaperAdapter audit Round 1
description: F8.1b PM paper trading, branch phase-beta/f81b-pm-adapter — 2026-04-20
type: project
---

**Scope**: 4 new files (pm-paper-persist, pm-paper-adapter, pm-paper-executor, pm-paper-trading tool) + 8 modified. 186 F8.1b-related tests green, 2957/2957 overall, 0 typecheck errors.

**Verdict**: PASS WITH WARNINGS. No critical blockers. Ship with W1 (dust-filter blocks full exits) and W4 (no stale-abort gate) tracked as F8.1b.2 follow-ups.

**Round 1 warnings (blast-radius assessment):**

- W1 DUST_MIN_NOTIONAL=$10 blocks full-exit sells of low-priced tokens (100 × $0.05 = $5 dust) → stranded positions forever. Accumulates over time. pm-paper-executor.ts:154
- W2 "polymarket rebalance" / "pm portfolio" (head-noun first) not matched by scope regex. "rebalance polymarket" works. scope.ts:559
- W3 "prediction market positions/portfolio/fills" NOT matched — regex only covers `rebalance prediction_market`. Asymmetric.
- W4 No stale-position abort gate (vs F8 equity's `allowStale` opt-in). Stale quotes distort totalEquity, silently mis-size target notionals. pm-paper-executor.ts:101-106 surfaces staleMarkets but doesn't gate.
- W5 No TARGET_CASH_BUFFER for slippage. F8 equity has 20 bps buffer; F8.1b lacks one. Safe at default 30% maxTotalExposure but exposed at higher allocations. pm-paper-executor.ts:149
- W6 `.symbol` / `.avgCost` on Position union without type narrowing in tests (paper-equity-adapter.test.ts:147-149, 246, 316). Works at runtime, but tsconfig excludes tests so invisible to typecheck.
- I1 `invalid_fill_price` fires before `insufficient_cash`. Fine, but UX debatable.
- I2 slug/tokenId always stored null in pm_paper_portfolio — adapter hardcodes. Display falls back to hex prefix. Plan acknowledged.
- I3 parseSymbol splits on first colon — breaks if marketId ever contains `:`. Safe for Polymarket UUIDs.
- I4 Dead code: `key.split(":", 2)` + `void marketId; void outcome;` at pm-paper-executor.ts:155-165. No effect.
- I5 No test exercises BOTH YES+NO weights from pm_alpha (antisymmetric by Kelly math, so no "both positive" case — confirmed by trace).

**Verified correct:**

- Weighted-avg cost on buys matches F8 equity pattern
- Realized P&L = (fill_price - avg_cost) × shares on sells
- Fill price = midpoint × (1 ± slip_bps/10000) — NOT midpoint ± slip_bps
- invalid_fill_price guards both upper (≥1) and lower (≤0) bounds
- max_loss bounded by shares × avg_cost (no naked-short assumption)
- Discriminated union migration complete in all F8 sites
- pm_alpha binary markets emit opposite-signed weights (no double-count risk)
- `entry_signal='pm_weekly_rebalance'` distinct from F8's `'weekly_rebalance'`
- Scope collision test with F8 `paper` holds
- Write-tools sync test covers pm_paper_rebalance
- auto-persist covers all 3 pm_paper tools
- Fills back-linked to thesis by UUID (not timestamp)
- Atomic transaction on buy/sell/fill write
- β closes clean with 4/4 β-addendum items shipped.
