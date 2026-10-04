---
name: v9-w1-grader-gate-r1-audit
description: V9 W1 grader gate (Phases 0-4, TASK_GATES_GRADER dormant) R1 audit, uncommitted 2026-10-04 - PASS WITH WARNINGS, 0 Crit, 7 Warn
metadata:
  type: project
---

# V9 W1 grader gate - R1 audit (uncommitted, 2026-10-04, branch claude/s4-verify-gate-sphh8y)

**Verdict: PASS WITH WARNINGS - 0 Crit, 7 Warn, 14 Info, tsc 0, 240/240 (9 scoped files), 23/23 valid mutants RED** (M11 invalid, M25 equivalent: assessTaskComplexity is binary).

## Clean (verified once)
- Flag off: every touched path gated on mode or GR rows. Shadow: no rows, status/text unchanged. Enforce demotes through existing enforce branch, never promotes.
- No Sonnet fallback: explicit `model` beats benchmarkOverride.defaultModel in queryClaudeSdk; budget timer calls ac.abort() (test asserts signal.aborted).
- `met` requires evidence; malformed / unavailable -> pending.
- `GR-` reserved for source=harness (gates.ts:352); API can't set harness. ABANDON excludes GR (gate-check.ts:353). evaluateLedger skips manual rows even on rerun; Stop hook skips GR; reverifyChildLedger filters isGradeRow.
- Consumer blocks in try/catch; evidence corpus taken once; cost ledgered as v9:grader; no schema change, no registered tool.
- mc-ctl `gates graded` read-only, days `^[0-9]{1,3}$`, SQL ran correctly on synthetic rows.

## Warnings
- W1 critic.ts `referencedTables` whitelist bypassed by `FROM "t"`, `[t]`, backtick, `FROM/**/t` (demonstrated). Pre-existing in critic, NEW exposure: grader reads untrusted deliverable text -> prompt injection can read conversations/jme_facts and quote into evidence (Gates line / tasks.output.grader). Fix before arming shadow.
- W2 trace attrs: realistic 12-criterion gates.graded = 2289 chars > ATTRS_MAX_CHARS 2000 -> `{truncated}`, mc-ctl loses the row. Test passes only without usage/model/reason. Measure serialized length, shrink in loop.
- W3 grade-specs.ts:320 / gates.ts:636: evidence + criterion not single-lined or redactSecrets'd (unlike evidenceTail) -> multi-line Gates: breaks isLedgerLine, router tail cap can cut FAILED notice.
- W4 orchestrator.ts:460 abandonPlanGatesForGoals only source='plan': unfinished goals' GR rows graded "failed" on completed_with_concerns partials (contradicts plan doc s2).
- W5 specs registered only from initial plan (orchestrator.ts:215): replan-removed goals can demote a met final plan; new goals never graded.
- W6 shadow awaited in completion seam: delivery waits up to budget (90s, clamp 600s) on top of ledger 120s; stretches swarm child polling.
- W7 swarm child routed to heavy re-registers g-1.. specs colliding with swarm GR-<parentGoal g-1>.n -> child criteria silently dropped (INSERT OR IGNORE / id dedup).

## Info (abridged)
I1 SDK crash text "Error: query aborted" -> no_verdict with model set, not grader_unavailable. I2 self-inflicted budget abort counts on shared claude-sdk-opus breaker (could push Prometheus Opus to fallback). I3 renderGatesBlock GR wording unreachable on orchestrator path (declared after render); its ABANDON sentence invites silently-ignored ABANDONs. I4 swarm retry respawn registers no specs. I5 SIMPLE_PATTERNS skip non-code tasks ("Write the weekly report in markdown format"). I6 registration has no trace event. I7 mc-ctl: error traces labelled "graded"; ts 'T' vs datetime() space compare; disagreement list omits cwc graded met. I8 enforce->off leaves GR pending (shows unverified). I9 GRADE_ID_PREFIX vs literal "GR-". I10 docs/.env.example not updated. I12 skipped verdicts still write evidence/checked_at. I13 grader enforce + TASK_GATES_MODE=shadow writes rows, trace says enforce. I14 no eval:gate while dormant.

Not checked: live data, real SDK behaviour, full suite, live chat turn.

## Doctrine
- CLASS: a borrowed guard (critic's SQL whitelist) was sized for its original trusted-ish input; reusing it under a NEW untrusted input (deliverable-driven grader) is a new exposure even if the bug is old. Re-attack the guard with quoting/comment spellings.
- A trace attrs cap that degrades to `{truncated}` must be tested with the realistic FULL payload (usage+model+reason), not the minimal fixture.
- Harness-declared rows tied to plan goals must follow every plan lifecycle event (abandon, replan, child re-plan), not just initial declare.
