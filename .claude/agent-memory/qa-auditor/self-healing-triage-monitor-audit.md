# Self-Healing Triage Monitor Audit (2026-06-19)

`src/lib/self-healing/{types,flags,schema,detect,analyze,persist,tick,triage-cron}.ts` + tests + `scripts/run-triage-monitor.ts`; edits `src/index.ts:364`, `src/db/index.ts:17,1064`. All NEW/untracked. Typecheck clean, 16 tests pass.

## VERDICT: PASS WITH WARNINGS

## #1 Safety contract — PASS, structural (absence of a path)
- `TriageTickDeps` (tick.ts:12-24) has exactly 4 effects: detect/recentTriageExists/analyze/persist. No 5th "remediate" dep → no call site can wire one without a type change.
- Module-wide grep `exec|spawn|systemctl|restart|kill|.act(|toolRegistry|inferWithTools|callTool|docker` = ZERO executable hits (all comments / system-prompt-that-forbids / test-fixture strings like `recommendedActions:["restart the heavy runner"]` = operator-read data, not run).
- `FROM triage_report|recommended_json|affected_json` outside module = NO EXTERNAL CONSUMERS. Only reader is `hasOpenTriageWithin` (existence-only throttle).
- analyze.ts: `toolNames:[]`, sole extraTool = `submit_triage_report` closure-sink writing in-process `sink` only. LLM has no system-touching tool.
- Only system mutation in whole module = single `INSERT INTO triage_report` (persist.ts:22). No ALTER/DROP/destructive DDL.

## Verified clean
- Dormant: flags.ts `=== "true"` exact (test proves "1"/"TRUE"/"yes" OFF); index.ts:368 same literal gate; unset → no import, no cron, no LLM.
- `ensureSelfHealingTables` unconditional at db/index.ts:1064 = correct + safe (new table, CREATE IF NOT EXISTS, additive; `triage_report` confirmed absent from live mc.db, first boot creates it).
- Fail-closed: queryPrometheus null on any error; detectAnomalies skips null (detect.ts:146,162). Dead Prom → 0 anomalies. getStuckTaskCount/recentTaskErrors try/catch→0/[].
- Throttle: hasOpenTriageWithin short-circuits before analyze; no-anomaly returns before analyze; null analysis writes nothing, no loop. Cron 6h == THROTTLE_HOURS 6.
- Pattern fidelity to probe-cron.ts exact (module-scoped job, idempotent register, void tick + own try/catch, RITUALS_TIMEZONE, getDatabase singleton, datetime('now')).

## Warnings
- W2 (recurring): analyze.ts:111 calls queryClaudeSdk DIRECT, stores cost on triage_report.cost_usd but NEVER calls recordCost → spend invisible to cost_ledger + to its own budget_overrun detector. Same class as fast-runner / V8.2-producer bypass ([[sdk-wrapper-vs-direct-call-audit]], [[v82-producer-cost-abort-audit]]). Bounded: Haiku, ≤1 call/6h.
- W1: recentTaskErrors strings interpolated raw into sub-agent prompt (analyze.ts:97) = untrusted grounding. Bounded — LLM has no tool but submit, worst case skewed report not action.

## Info / drift
- I1: flags.ts `isTriageMonitorEnabled()` is exported+tested but index.ts:368 INLINES the env check instead of calling it → tested fn isn't the prod gate. Recommend index.ts call the helper.
- detect.test.ts asserts inference_degraded/tool_error_spike/budget_overrun/stuck_tasks breaches but NOT kb_drift/messaging_flap breach branches.

## Doctrine
- A new monitor's "never acts" safety must be the ABSENCE of an effect dep in its injected-deps interface, not a runtime flag — verify the deps type has no exec/tool seam, then grep that no external consumer reads the persisted action payload back.
- Cost-ledger bypass is now a 3-peat for direct queryClaudeSdk callers: always check recordCost is called whenever a new module fires queryClaudeSdk directly.
