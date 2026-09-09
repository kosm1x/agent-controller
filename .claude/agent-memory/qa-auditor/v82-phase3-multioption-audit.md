---
name: v82-phase3-multioption-audit
description: V8.2 Phase 3 RAPID-D multi-option audit (2026-06-02) — PASS WITH WARNINGS, contract sound, test-boundary gaps
metadata:
  type: project
---

# V8.2 Phase 3 — Multi-option / RAPID-D audit (2026-06-02)

Files: `src/lib/v8-2/should-multi-option.ts`, `multi-option.ts` + their `.test.ts`. Verdict **PASS WITH WARNINGS**. Additive+dormant (no producer calls `runMultiOption`/`shouldRunMultiOption`). tsc clean, 34/34 scoped tests pass.

**Why:** Phase 3 of the V8.2 Strategic Initiative Layer (spec `docs/planning/v8-capability-2-spec.md` §8 multi-option, §9 carve-out). Contract correctness > integration since dormant.

**How to apply:** When Phase 4 (citation/cite.ts + drop-vs-surface predicate) lands, re-check the two carry-forward gaps below.

## All 8 design claims verified TRUE (not rubber-stamped)
- Skip predicate order red→observational→mechanical matches §8 exactly. The at_risk/recurring_blocker red SURFACE carve-out is §9 Phase-4 work (drop-vs-surface predicate), correctly ABSENT from Phase 3 — red always skips option-generation here.
- `runMultiOption` returns only length-3 or `[]` (types.ts refine pins proposed_options ∈ {0,3}). Traced all returns.
- Diversity gate advisory: `computeMaxPairwiseSimilarity` returns `null` (not 0) on <2 summaries OR any null embedding → accepts options (no degrade). Only true >θ-after-retries → `[]`.
- `generated_by_role:'synthesizer'` stamped via `satisfies RapidDRole`; `rawOptionSchema` has no such field so model can't supply it (poka-yoke, mirrors decompose.ts clock/question stamping).
- abort/timeout hygiene (clearTimeout+removeEventListener in finally, captured-despite-abort fall-through) mirrors critic.ts:261 / decompose.ts:181 exactly. `{once:true}` + explicit remove → no listener leak across ≤3 synth attempts.
- Only `any` is the documented SDK schema-erasure cast `as unknown as InlineSdkTool` (matches decompose.ts) + test-only mock dispatch.

## Findings to clear before Phase-4 producer goes live
- **W2 (test gap):** dispatch-by-shape mock calls `extraTools[0].handler({options})` DIRECTLY, bypassing the SDK's Zod parse. So `submitOptionsSchema` per-field Zod (`summary.min(1)`, rank literal union) is UNTESTED at the boundary, and the `ProposedOptionSchema.parse` catch at `multi-option.ts:301-305` is uncovered. Fix: add a `validateOptions` test with empty `summary`.
- **I1 (spec ambiguity, carry-forward):** §8 line 356 says degrade to "rank-1 only, proposed_options=[]" — contradictory. Impl correctly returns `options:[]` but DISCARDS the last synth's rank-1 summary (`degraded()` keeps only perspectives). If Phase 4 needs rank-1 prose on a `no_diversity` degrade, there is NO data source in `RapidDResult`. Flag for Phase-4 author.

## Minor
- SV1: `res.text?.trim()` at multi-option.ts:389 — dead `?.`, `ClaudeSdkResult.text` is non-optional `string`.
- `submitOptionsSchema.min(1).max(3)` intentionally looser than {3} so a 2-option synth consumes a retry instead of crashing the SDK call. Do NOT "tighten" to `.length(3)`.

## Reusable doctrine
When a forced-tool sink is tested via direct `handler()` invocation, the SDK's Zod parse is bypassed — the tool's input schema validation is effectively untested. Always add a unit test that feeds malformed-per-field input through the post-capture validator (here `validateOptions`) to cover the schema-erasure boundary. Pin [[forced_structured_output_via_mcp_tool]].
