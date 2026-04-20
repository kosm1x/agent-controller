---
name: f81a-pm-alpha-round2
description: F8.1a PM Alpha Round 2 audit — all 8 W-findings fixed, new W9 whale-multi-outcome symmetric to W4, no test coverage for 4/8 fixes
type: project
---

# F8.1a PM Alpha — Round 2 Audit (2026-04-20)

**Verdict**: PASS WITH WARNINGS (branch `phase-beta/f81a-pm-alpha`, uncommitted).

## Round-1 fixes verified landed

All 8 W-findings (W1 whale-cap, W2 unknown_liquidity, W3 unknown_resolution, W4 multi-outcome sentiment gate, W5 UTC asOf, W6 already_resolved, W7 sentiment indicator filter, W8 INSERT OR IGNORE) have corresponding code changes. `npx vitest run src/finance/pm-alpha*.test.ts src/tools/builtin/pm-alpha.test.ts` → 34/34 pass. `tsc --noEmit` clean.

## New findings

**W9 (major)**: `whaleFlowForMarket` has the same multi-outcome mis-routing W4 fixed in sentiment tilt. For N=3 markets with labels like "January/February/March", all three get `isYes=false` and thus _negated_ whale flow. W4 closed sentiment side only. Fix: pass `nOutcomes` into `whaleFlowForMarket` + symmetric gate.

**W10**: Binary markets with labels like `WIN/LOSE` or candidate names fail both isYesLabel/isNoLabel regexes → tilt silently = 0 even though nOutcomes===2. Either extend regex or emit a distinct `multi_outcome_no_tilt` reason.

**W11**: `multi_outcome_no_tilt` is declared in `PmExcludeReason` union but never assigned anywhere (dead constant). Either wire in at W10 or remove.

**W12**: `new Date().toISOString().slice(0,10)` shows UTC date in operator output. For NY evening runs (≥20:00 EDT), this displays _tomorrow's_ date. Also schema.sql:676 still says "ISO 8601 America/New_York" but code now writes UTC — comment-vs-impl lie worse than the UX glitch. Fix with `toLocaleDateString("en-CA", { timeZone: "America/New_York" })` for the display or update schema comment.

**W13**: Zero test coverage for 4 of the Round-1 exclusion additions (`unknown_liquidity`, `unknown_resolution`, `already_resolved`, multi-outcome sentiment gate). pm-alpha.test.ts tests only pre-existing exclusions.

**W14**: `rowsInserted += 1` in `persistPmAlphaRun` overcounts on UNIQUE-IGNORE drops. Should be `+= insert.run(...).changes`. Stat is unused today but trivially correctable and the test comment already admits the discrepancy.

## Info

- I1: NaN liquidity bypasses all liquidity gates (NaN comparisons all false). Low prob but guard with `Number.isFinite()`.
- I2: Exclusion ladder shows only first-match reason — by design.

## Key pattern for future audits

When an audit finding gates a function on a semantic precondition (like "N=2 outcomes"), grep for the _other_ places that make the same semantic assumption. W4 fixed `sentimentTilt` but not `whaleFlowForMarket`, which has identical "isYes else NO" binary assumption. One-liner grep on `isYesLabel(` before declaring symmetry fixes complete would have caught this.
