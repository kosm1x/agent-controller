---
name: F8.1a PM Alpha Layer Round 1 Audit
description: v7.0 F8.1a β-addendum audit findings — PASS WITH WARNINGS, 8 warnings around loader filters, undefined-guards, and whale-row cap
type: project
---

F8.1a Prediction-Market Alpha Layer audit on branch `phase-beta/f81a-pm-alpha` (2026-04-20).

**Verdict**: PASS WITH WARNINGS. No critical. 2894/2894 tests green.

**Why**: Math correct per spec (Kelly edge/b simplification acknowledged as conservative approximation vs (p·b-q)/b full form; per-token→total-scale clip order is safe). No provider risk, no new deps. Eight warnings are all "unknown-input slips through as valid":

1. **W1 queryRecentWhales cap** — pm-alpha handler calls `queryRecentWhales({ hours: 24*7 })` but `queryRecentWhales` defaults `limit=20`. Week intent capped at 20 rows. whales.ts:101.
2. **W2 undefined liquidity passes** — `m.liquidityUsd !== null && !== undefined && < minLiq` — undefined markets bypass low_liquidity exclusion. pm-alpha.ts:276-279.
3. **W3 undefined resolution passes both date guards** — `daysBetween` null → both `days !== null && …` branches false → no exclusion on missing date. pm-alpha.ts:282-288.
4. **W4 multi-outcome crypto tilt mis-fires** — `isYes = /^(yes|up|above|higher|true|bull|bullish)/i` on custom labels ("January", "Trump") gives them ALL `-weight` on extreme fear instead of 0. Defer F8.2 but current code does wrong thing; v1 should require exactly 2 outcomes before applying tilt.
5. **W5 hardcoded -04:00 offset** — `asOf` uses `T00:00:00-04:00` which is wrong outside EDT. Can flip a near-resolution exclusion by 1 hour in winter.
6. **W6 loadActiveMarkets has no closed/resolved filter** — resolved markets crowd LIMIT 100; excluded misleadingly as "near_resolution".
7. **W7 loadLatestSentimentReadings no indicator filter** — 10 funding rows can silently starve F&G → sentiment tilt = 0 with no signal.
8. **W8 duplicate outcome labels kill whole run** — UNIQUE(run_id, market_id, outcome) + single transaction means one bad market aborts all inserts. No defensive dedup.

**How to apply**: Round 2 should verify W1-W4 (wire-behavior affecting) first; W5-W8 are hardening. Pattern class match: "loader-filter off-by-one" and "tool boundary validation gap" from prompt's predicted round-1 bugs. Also matches `feedback_f6_f65_external_signals` pattern: "new table is half-done until end-to-end persist-then-consume wired".

**Integration**: all 14 touchpoints present and correctly wired (scope group, dispatch, auto-persist, write-tools-sync, builtin.ts, test files, fast-runner WRITE_TOOLS). Scope regex cleanly separates from F7 `alpha` group via `signals/señales` anchor on F7 side.

**Test gaps flagged**: no tests for W2/W3/W4/W6/W8 scenarios; no test at sentiment threshold boundaries (25/75); no test for `pEstimate` clamping when tilt pushes out of [minPriceBound, maxPriceBound].
