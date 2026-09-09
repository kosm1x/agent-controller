---
name: v82-phase8-confidence-sycophancy-audit
description: V8.2 Phase 8 (LAST build phase) §12 confidence + §10 hedge-register + §14 sycophancy probe audit (2026-06-03)
metadata:
  type: project
---

# V8.2 Phase 8 audit — confidence.ts + sycophancy.ts (2026-06-03)

**Verdict: PASS WITH WARNINGS.** Closes the V8.2 build. 39/39 scoped tests pass, typecheck clean. Additive + dormant (no producer wires it; no DDL/restart).

**Why:** Last V8.2 phase. §12 mechanical confidence (Lee & See anthropomorphism guard), §10 hedge-register floor, §14 nightly sycophancy probe (Sharma 2023).

## Findings
- **W1 (load-bearing) — `quizá` Spanish uncertainty MISS.** `confidence.ts:132` UNCERTAIN_RE `quiz[aá]s?\b` — the trailing `\b` lands after the accented `á` (non-word in ASCII `\b`), so bare `quizá` (RAE-preferred spelling) reads `direct`, NOT uncertain. `quizás`/`quiza`/`quizas` all work. Dangerous-miss class: over-confident register on a red ES judgment → registerMatchesColor passes / downgradeColorFloor fails to downgrade. Fix: drop trailing `\b` for that alt or use `u` flag. Verified empirically.
- **W2 — drift blocker vs detection auto-stale-sweep coupling.** `detection/recurring-blockers.ts:143-148` resolves ANY blocker with `last_seen_at < now-3d AND resolved_at IS NULL` (`STALE_AFTER_DAYS=3`) — producer-blind. Runs every 06:00 brief (`construct.ts:132 runDetection()`). Sycophancy drift blocker stays safe only because nightly `checkSycophancyDrift` refreshes `last_seen_at=now`; if the probe cron stalls >3d while drift persists, detection silently auto-resolves the drift blocker (`resolution_signal='auto-stale'`), masking real drift.

## Nits
- N1 `sycophancy.ts:447` drift upsert `task_count=conceded`, `task_ids_json='[]'` — semantic misuse (count-of-probes not tasks; always-empty ids). Cosmetic; recurring_blockers→brief pipe only needs signature+last_seen. NOT NULL both satisfied.
- N2 `run-sycophancy-probe.ts:48` DRY claims "writes nothing" but `initDatabase(data/mc.db)` runs `seedDirectives()`+`activateBestVariant()` first-init side effects. Idempotent on already-init prod DB; near no-op. First script of its family to touch prod DB (sibling verify-v82-cache.ts never opens DB).

## VERIFIED CORRECT (challenged, held)
- Color math exact at every boundary: green=≥3∧0contra∧0stale; yellow=≥1∧≤1contra; else red. 1-of-3-stale drops green→yellow (not red). 2 contra→red. (`confidence.ts:110-116`)
- countStale: operator_message never stale (continue), unparseable retrieved_at→stale (conservative), env negative/0/NaN→default 7.
- downgradeColorFloor is a TRUE floor (COLOR_RANK proseColor<color guard) — never upgrades. detectRegister ordering uncertain>hedged>direct, trailing-? only.
- §14 ELICIT genuinely neutral (no coaching); CLASSIFY has INDEPENDENT system prompt (not strategic voice). Failed classify→null→row SKIPPED (verified: no silent held_position).
- Round-robin `buckets.get(k) ?? buckets.set(k,[]).get(k)!` correct (set returns Map, .get returns new array). Red included, no drop/dup, deterministic by id. (verified empirically)
- checkSycophancyDrift: empty window total=0→opens NOTHING; clean window auto-resolves prior; upsert task_count/task_ids_json NOT NULL satisfied; ON CONFLICT clears resolved_at.
- All SQL parameterized; cutoff isoDaysAgo computed in JS (bound param, not datetime('now')).
- Dormancy: 0 judgments→sampler []→ZERO LLM calls (test asserts mockQuery not called). confidence.ts pure. Script-only, no live cron.
- Abort-during-handler guard in classifyConcession mirrors critic.ts (catch checks !sink.captured). InlineSdkTool cast + double-call guard match critic.ts.

Doctrine: producer-blind shared-table sweeps (detection auto-stale) are a recurring V8 coupling risk — a second writer to recurring_blockers inherits the 3d auto-resolve whether it wants it or not.
