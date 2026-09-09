---
name: v82-producer-cost-abort-audit
description: V8.2 judgment-assembly producer (first live consumer) COST/ABORT/BOUNDING audit (2026-06-19)
metadata:
  type: project
---

# V8.2 judgment-assembly producer — COST/ABORT/BOUNDING audit (2026-06-19)

PASS WITH WARNINGS. Files: src/lib/v8-2/{produce,author}.ts + morning-surface.ts + router.ts.

**Why this matters:** produce.ts is the FIRST live consumer of the dormant P0-P8 substrate. Per-call abort/timeout plumbing in author/decompose/critic/multi-option is genuinely correct (AbortController + timeout + finally cleanup + already-aborted upfront guard + abort-during-handler tolerance — all mirror decompose.ts). The gaps are at the SEAMS the producer owns.

## Findings (real, verified)
1. **WARNING — producer spend is NEVER recorded to cost_ledger.** queryClaudeSdk returns {costUsd,costAuthoritative} but does NOT write the ledger; only dispatcher.ts/skills/dispatcher.ts/reflection/runner.ts call recordCost. produce.ts calls queryClaudeSdk DIRECTLY (via author/decompose/critic/multi-option) and never recordCost. author.ts:156 captures costUsd then it's dropped on the floor (only author.test.ts reads it). So ~10-33 Sonnet calls/brief are invisible to budget windows + audit-claim cost. SAME bypass class as fast-runner [[sdk-wrapper-vs-direct-call-audit]].
2. **WARNING — no wall-clock bound on the whole pass.** morning-surface.ts:88 calls runJudgmentAssembly(construct.briefing) with options={} → signal=undefined everywhere. Each LLM call has its own 30-45s timeout but the SEQUENTIAL pass has none: worst case ~3 judgments × ~11 calls × 45s ≈ minutes, uncancellable. The per-judgment `options.signal?.aborted` checks (produce.ts:355, assembleOneJudgment) are dead because no signal is ever passed.
3. **WARNING — V82_MAX_JUDGMENTS_PER_BRIEF has no upper cap.** maxJudgmentsPerBrief() (produce.ts:71) validates `Number.isInteger(n) && n > 0` but no ceiling → =100 runs 100 judgments × ~11 calls = ~1100 Sonnet calls, unbounded LLM spend from one env typo. Doc says "10-22 calls/brief"; actual worst case at default max=3 is ~33 (1 decompose + 6 multi-option[3 persp + 3 synth retries] + 1 author + 2 critic + 1 reauthor).
4. **WARNING — reRunJudgment (router reply chokepoint) passes NO signal/timeout.** produce.ts:403 authorJudgment({...}) single-arg → no abortSignal, only default 45s. Invoked fire-and-forget via `void resolveBriefingOnOperatorReply(...).then()` (router.ts:1225) so it doesn't block the reply, but spawns an uncancellable 45s-capped Sonnet call with no parent-abort path. Dormant until producer armed (countJudgmentsForBriefing===0 keeps pure V8.1 regex path today).

## Correct (verified, NOT findings)
- Critic loop bounded: CRITIC_MAX_LOOP=2, 2nd needs_revision → unfixable (critic.ts:662). reAuthor failure degrades to prior draft (produce.ts:269), no unbounded loop.
- runMultiOption only runs when shouldRunMultiOption(j).run (produce.ts:201); skip predicate pure/deterministic.
- costAuthoritative gating correct: author.ts:156 + critic.ts:538 both `costAuthoritative ? costUsd : undefined` → no phantom $0 (even though the value is then unused).
- multi-option synth retry bounded: maxAttempts = retryBudget+1 = 3 (multi-option.ts:544).
- per-judgment try/catch isolation (produce.ts:357) + flag-gate + morning-surface try/catch → cannot break live brief (invariant 4 holds).

Doctrine: when a new module calls queryClaudeSdk DIRECTLY (not via infer/inferWithTools adapters), its spend is invisible to cost_ledger AND its only bound is the per-call timeout — audit the wall-clock + ledger seam, not just the per-call abort plumbing (which is usually copied correctly).
