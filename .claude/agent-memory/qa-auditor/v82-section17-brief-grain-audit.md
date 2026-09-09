# V8.2 §17 6a acceptance: judgment-grain → brief-grain recalibration (2026-06-26)

PASS (no Critical). Companion to [v82-phase17-gate-audit](v82-phase17-gate-audit.md).
Files: src/briefing/v82-activation-gate.ts (+ `briefConfidenceColor` export) and its test.

## The fix (verified correct)
Old 6a measured green/red promote-rate at JUDGMENT grain (`GROUP BY j.confidence`
over judgments↔proposed_briefings). A promoted MIXED-color brief lifted BOTH its
green and red judgments' rate → greenRate≈redRate → ratio collapses to ≈1.0, so
≥1.5 (`GATE_V82_PROMOTE_RATIO`) was unreachable regardless of real calibration.
New: one color PER BRIEF via `briefConfidenceColor` → green-briefs' promote-rate
vs red-briefs'. Promotion is a per-BRIEFING event, so brief-grain is the right unit.

## Why it's sound (the load-bearing checks)
- `briefConfidenceColor`: lead = the brief's `highest_leverage` judgment's color;
  else plurality, ties → more cautious via iterating COLORS_CAUTIOUS_FIRST
  ['red','yellow','green'] with strict `>` (keeps cautious color seated on equal
  count: g1/r1→red, g2/r1→green). Empirically all 5 unit tests + tie cases hold.
- LEAD-POSTURE DEPENDENCY confirmed end-to-end: producer persists `highest_leverage`
  VERBATIM — `normalizePosture` (judgments-store.ts:241-245) only maps
  has_momentum→momentum, leaves highest_leverage. DB CHECK (index.ts:958) allows it.
  ≤1-HL invariant enforced upstream by BriefingSchema (schema.ts:137-141), validated
  in construct.ts before persist; selectJudgments (produce.ts:94) prioritizes it. So
  the lead `.find()` matches real data and resolves deterministically.
- null-confidence judgments filtered (SQL `confidence IS NOT NULL` + JS filter); a
  null-confidence HL is dropped → brief colored by plurality of vetted judgments
  (DESIGN, tested). confidence cast `as Color` safe (NOT NULL filter + CHECK).
- promoteRatio null-guard identical in spirit to old (`green && red && redRate>0`).
- Existing tests preserved (one-judgment-per-brief, default posture at_risk → no HL
  → plurality of 1 → that color): #pass still promoteRatio 2.0, #fail still fails.
  New integ test: round1(1.0/(1/3))===3 EXACTLY — round1 absorbs the 3.0000000004
  float epsilon. 13/13 tests pass.
- Consumers unaffected: scripts/judgments.ts:67 + scripts/briefing-gate.ts read
  promoteRatio (number|null) only. V8.3 dep intact: shadow (delivery off) → no
  promoted briefs → promoteRatio null → insufficient_data, gate still hard-gates V8.3.

## Residual (Info, dormant during shadow)
- If a finalized brief's HL judgment ever ships with NULL confidence, the brief is
  re-colored by its NON-headline judgments → can invert the headline signal the
  operator actually reacted to. Confirm producer always scores HL before delivery
  activates. Yellow-led briefs are invisible to the ratio (spec-faithful green/red).

DOCTRINE: a grain-change on an aggregation gate is only as correct as the field it
keys on surviving the WRITE path verbatim — trace producer→normalizer→CHECK before
trusting `posture === "X"`, don't assume the in-memory enum equals the persisted one.
