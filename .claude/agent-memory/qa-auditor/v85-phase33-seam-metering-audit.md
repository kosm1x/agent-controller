# V8.5 Phase 3.3 seam-metering + budget-enforcement audit (2026-07-13)

Bundle: 27 files, cost_ledger seam hook in queryClaudeSdk + dormant enforcement gate + per-site opt-outs/attribution. Verdict: FAIL.

## DOCTRINE (load-bearing)
- **AGGREGATE-FED SITE MUST OPT OUT, and the inventory of aggregate-fed sites is bigger than the obvious runners.** The contract enumerated planner/executor/reflector (×6) as the prometheus opt-outs, but `provenance.ts` `summarizeResearch` (executor sums `condensed.usage` into goalResult.tokenUsage → orchestrator → dispatcher 'heavy' row) was MISSED → DOUBLE COUNT. When adding a universal seam recorder, grep every `infer(`/`queryClaudeSdk(` caller and TRACE whether its usage is summed into any aggregate — not just the ones the design doc lists. context-compressor also calls infer() but drops usage (leak-closure, single count) — the discriminator is "is .usage summed downstream", not "is it a prometheus file".
- **A UNIVERSAL cost_ledger writer contaminates every agent_type-agnostic READER.** §13 activation-gate (`briefing/activation-gate.ts`) computes cache-read ratio over cost_ledger excluding ONLY `reflection:%` + `heavy`. Phase 3.3's new rows (chat:*, aux:*, v82:*, audit:*, skill:critic, tuning:*, sdk:unattributed) pass all filters → enter the ratio pool. Recording is UNGATED by the dormant budget flags, so this lands the moment 3.3 ships. Low-cache aux/classifier rows drag a razor-thin gate (80.51 vs 80) toward FAIL → blocks V8.2 §17 / V8.3 promotion. Same class as the §13 heavy-exclusion audit: any new agent_type must be reconciled against every gate that reads cost_ledger without an allow-list.
- **BudgetExhaustedError is a novel throw with no messaging-layer handler.** fast-path catches → falls through to full pipeline → re-throws → generic task-failure. No dedicated user reply / never-silent floor for budget refusal. Dormant (gated behind budgetEnabled&&budgetEnforce) but latent when armed.

## CORRECT (verified, don't re-flag)
- recordCost is AFTER breaker.recordSuccess/Failure (1002/1004 vs ~1063) inside own try/catch → throw can't corrupt breaker or skip return. Good.
- getRemainingBudgetUsd bypasses the WindowStatus Math.max(0,...) clamp (recomputes limit-spend), includes monthly. Correct unclamped-negative on breach.
- Haiku-retry legs re-throw BudgetExhaustedError (adapter.ts) — skips retry correctly.
- skills mini-runner catches throws→status (never throws) so writeCostLedger always fires on success+failure. Opt-out safe.
- briefing recordReflectionCost fires unconditionally on the success path after infer. Safe.
- reflection/runner.ts: fast-runner seam opt-out + recordReflectionCost = single count, no double.
- taskId=agentType fallback strings (chat:fast-path etc.) can't collide with UUID task_ids → task-outcomes LEFT JOIN won't misjoin.
