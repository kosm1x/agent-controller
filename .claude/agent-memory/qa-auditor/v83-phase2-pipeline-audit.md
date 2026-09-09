# V8.3 Phase 2 pipeline-skeleton audit (2026-06-26)

Verdict: PASS WITH NITS. No Critical. Adversarial lens: spec-fidelity + test-quality + dormancy/surgical.

Files: `src/lib/v8-3/{pipeline,odd-evaluator,decisions-store,flags}.ts` + 3 tests. 26/26 green.

## Confirmed clean
- DORMANCY = YES. No prod call site of `runDecisionPipeline`/`isV83Enabled` (grep src). Only v8-3 prod imports are Phase 0/1 substrate (seedV83Capabilities/assertV82Dependencies/ensureV83Tables in index.ts + db/index.ts). flags default OFF (`process.env.V83_ENABLED === "true"`).
- SURGICAL = YES. `git diff --name-only HEAD -- '*.ts'` EMPTY; 7 new files only. The 2 modified tree files (docs/EVOLUTION-LOG.md day-log append; qa-auditor MEMORY.md) are NOT Phase 2 source.
- Real DB path: pipeline.test `initDatabase(':memory:')` → db/index.ts builds judgments(954)+reflection_followups(987) then ensureV83Tables(1069); foreign_keys=ON(40). Real decisions/decision_events w/ FKs, not mocked.
- §13 acceptance "10 decisions traverse, all events emit" GENUINELY tested (pipeline.test:191-234): seen-set union pins all 4 Phase-2 event kinds {proposed,autonomy_demoted,approved,executed}; fails if any stage no-ops (verified each branch reachable).
- Deferrals correct + documented: Phase 3 reversibility (pre_state=trigger mock, reversal_op null), Phase 5 injection 'interrupted', Phase 6 CRITIC judgment-linkage rejection — all NOT implemented, docstring lines 9-14 transparent.
- ODD evaluator covers all ops + numeric fail-safe + compound; flags proves ONLY literal "true" (rejects "TRUE"/"1"/"yes"). Event order pinned exact (toEqual) + persisted seq [1,2,3]. max_level cap before ODD, one-level demote per §6, ux_confirm forces confirm — all tested. House style clean (ESM .js, injected db=getDatabase(), no `any`, mirrors v8-2/flags).

## DOCTRINE — the 2 recurring gaps in a state-machine SKELETON that mocks execution
A dormant pipeline-skeleton phase nearly always leaves these two holes; check them first:
1. **L0/disabled level not special-cased.** pipeline.ts:132-133 route = `effectiveLevel <= 2 || ux_confirm ? "confirm" : "autonomous"` → an L0 capability (spec §6 = "disabled, operator only"; CADENCE_BY_LEVEL[0]="disabled") still routes confirm → executes → commits. No L0 guard, no L0 test. Low real risk (dormant, all seeds L1, demote floor=2 never reaches 0) but a "disabled" capability that executes is a safety inversion. Fix: early-refuse when effectiveLevel===0.
2. **execute()→{ok:false} = untested + no terminal event.** pipeline.ts:194-199: on `!result.ok` no event emits, status stays 'pending', updateDecisionStatus never called → dangling 'pending' row, returns status:'pending' silently. §7 "auto-revert on execution failure" is Phase 3, but Phase 2 emits NOTHING. No test (prompt explicitly demanded it). Fix: test it + emit a terminal event or document the Phase-3 deferral in docstring.

Nits: time_window WRAPPING branch (odd-evaluator.ts:103-105, start>end) untested (only [6,22) covered); compound-false on MIDDLE clause untested (.every() makes equiv, low risk); no L2/L5 base-level pipeline test (L5='silent' cadence is a distinct path); router-confirm hand-off mocked not wired (defensible — can't wire without a call site while dormant; docstring honest); double-write pre_state_json (insertDecision null + separate setDecisionPreState UPDATE, cosmetic); `unknown | null` redundancy (cosmetic).
