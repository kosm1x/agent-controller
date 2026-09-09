---
name: v7.6 Spine 6 Round 2 audit
description: Round-2 of L4-L6 composed pipeline + covarianceMatrix bundle. PASS WITH WARNINGS. 5 NEW low/medium findings, 0 round-1 regressions. Doctrine: round-1 structurally sound bundles still expose loose-edge contracts under round-2 scrutiny — 100% of finds were forward-looking, not bundle-regressions.
type: project
---

# v7.6 Spine 6 Round 2 audit (2026-05-08)

## Bundle scope
- `src/finance/composed.test.ts` (3 it-blocks: happy path single-view, two-view shape, fail-open)
- `src/finance/allocators.ts` (added `covarianceMatrix` export, ~50 LOC)
- `src/finance/allocators.test.ts` (5 new tests for `covarianceMatrix`)

## Round-1 disposition (verified clean in round-2)
W1 split single-view monotonicity from two-view shape — pi[AAPL]=3.2e-4, Q=0.04, math headroom is 2 orders of magnitude.
W2 tightened `>=2` to `toBe(2)` — verified.
W3 extracted `covarianceMatrix` to allocators.ts — diagonal-equals-varianceVector verified at toBeCloseTo(12).
W4 aspirational-contract caveat block at composed.test.ts:13-21 — present.
W5 `safeContext` excludes `lessonsBlock`, comment at adversarial-critic.ts:42-51 — present (but see W8 below).
W6 dropped dead `_seed` — verified.
S1 dropped `composedOutput` shape pin — verified.

## Round-2 NEW findings
- W7 (medium): covarianceMatrix off-diagonal only tests perfect-positive correlation (corr=1.0). Negative correlation + zero correlation untested. Sign-flip bug would pass all 5 unit tests.
- W8 (low): trust-model comment claims `safeContext` is "numeric only" but actual value is `Prior π for AAPL: 0.0003` — has hardcoded English label. Better wording: "system-derived bytes only; no user-controlled text."
- W9 (low): `failureReason!.length).toBeGreaterThan(0)` only checks presence; doesn't pin "bull" side. Regression that swapped failure side would still pass.
- W10 (low): `formatLessonsBlock` exercised + asserted but unconsumed downstream after W5 fix. Either label as "Stage 3.5 shape-pin only" or move to reflection-memory.test.ts.
- W11 (low): δ=2.5 magic literal repeated 3× across it-blocks; no test pins `equilibriumReturnsReverse` default == 2.5.
- S2 (low): Two of three it-blocks duplicate `60×4` foundation setup. `beforeAll` in nested describe would consolidate. Stylistic; current code is `--shuffle` safe.

## Doctrine refinement
**Round-2 catches forward-looking edges, not bundle-regressions, when round-1 fixes are structurally sound.** All 5 findings here are forward-looking; 0 are "round-1 fix moved drift." Contrast with the F8/F10 bundle (Spine 1) where round-2 caught 7 bundle-regressions (parser unification moved drift). The pattern: bundles unifying multiple parsers/helpers MOVE drift; bundles adding clean new exports + restructuring tests don't move drift but reveal contract looseness that wasn't visible before consolidation.

**Quote-the-line discipline applied throughout.** Every finding includes the exact quoted line; no symbol-only flags.
