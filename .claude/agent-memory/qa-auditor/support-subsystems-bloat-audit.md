---
name: support-subsystems-bloat-audit
description: Read-only structural/bloat audit of mc support subsystems (lib/memory/prometheus/tuning/rituals/intelligence/briefing/intel/audit/teaching, ~44k LOC) 2026-07-05 — dead files, naming collisions, dead-file-scan doctrine
metadata:
  type: project
---

Structural/bloat audit 2026-07-05 of the ~44k-LOC "support" slice. READ-ONLY, no test run.

**DEAD-FILE SCAN DOCTRINE (load-bearing):** a src-only import grep gives FALSE POSITIVES because many mc modules are wired only via (1) `scripts/*.ts` CLI entry points (mc-ctl wrappers) and (2) dynamic `await import()` in index.ts / rituals/scheduler.ts. Before calling a file dead you MUST grep BOTH `src` AND `scripts`, AND grep for dynamic-import basename. Files I first mis-flagged then CLEARED: briefing/v82-activation-gate.ts (→scripts/briefing-gate.ts), lib/phase-closure.ts (→scripts/phase-ctl.ts), audit/closure-doc-validator.ts (→scripts/validate-closure-doc.ts), audit/cli.ts (→mc-ctl audit-claim), memory/background-extractor/hindsight-backend/consolidation, rituals/diff-digest/autonomous-improvement/prometheus-alert-poller, intelligence/skill-discovery, lib/s3/push, tuning/baseline+run (npm tune:* scripts), lib/*/probe-cron + self-healing/triage-cron (index.ts dynamic import).

**CONFIRMED DEAD (0 callers in src+scripts, non-test) — ~915 LOC:**
- src/lib/v8-3/adr-writer.ts (285) — renderDecisionAdrById never called even when V83_ENABLED armed; dormant scaffolding not wired to a call site (my earlier v83-phase4-adr-render-audit passed it as "dormant pure renderer" — it was NEVER subsequently wired).
- src/tuning/skill-eval-loop.ts (275) — runSkillEval/recommend, zero refs; dead sibling of overnight-loop.
- src/memory/consolidate.ts (197) — consolidateLearnings never called; header says "called from the evolution ritual" but it isn't. NEAR-DUPLICATE NAME of the LIVE memory/consolidation.ts (CCP7, wired via scheduler.ts:621). Twins differ: consolidate=learnings-embedding-dedup (dead), consolidation=overnight memory-prune (live).
- src/prometheus/resume.ts (158) — resumeFromGoal 0 callers; the goal-graph resume capability is scaffolded but unwired (snapshot/compaction path IS live, resume specifically is not).

**8 dead standalone functions** (0 callers): intelligence getToolChainStats, clearEnrichmentCache, resetDiscoveryRateLimit; intel getAllSnapshots, getBaseline, getMetric; teaching masteryToQuality, markUnitStatus. Plus ~20 test-only-exported types (minor).

**NAMING COLLISION (cognitive tax, not code waste):** src/intel/ = external "Intelligence Depot" signal collection (USGS/CISA-KEV/NWS/GDELT adapters, live via index.ts scheduler + intel-* tools) vs src/intelligence/ = agent SELF-learning enrichment (mental-models/scope-telemetry/outcome-tracker, live via fast-runner/router). Genuinely different domains, confusingly co-named.

**BRIEF-PREMISE CORRECTIONS:** (1) audit/ vs prometheus/ do NOT overlap — src/prometheus/ is the autonomous AGENT loop engine (executor/orchestrator/planner/reflector), the metrics Prometheus is src/observability/ (outside slice). (2) tuning/ vs teaching/ do NOT overlap — tuning=automated overnight prompt/skill evolution loop, teaching=human SM2 spaced-repetition Socratic tutor (wired via teaching-tools.ts). Both legit.

**HEALTHY (abstractions justified):** MemoryService iface→2 live impls (sqlite/hindsight, runtime-selected by HINDSIGHT_ENABLED); XBackend→2 impls (cookie/api); lib/event-bus.ts(44) is a legit thin singleton facade over lib/events/bus.ts(681), 13 consumers — NOT a dup.

**OVERBUILT — worst offender = tuning/ (4497 LOC / 23 files):** research-grade evolutionary-optimization framework (parent-selection strategies, predictive-consistency, trajectory-miner, meta-agent, failure-classifier, self-review) for prompt tuning, gated behind TUNING_ENABLED (OFF by default) with 6 further nested sub-flags (TUNING_PARENT_SELECTION/PREDICTIVE_CONSISTENCY/TRAJECTORY_MINE/SELF_REVIEW/COOLDOWN_HOURS/SAFETY_KEYWORDS) + a fully-dead loop variant (skill-eval-loop). Dormant-by-design OK, but the speculative surface is large.

**MINOR dupes:** 4 truncate/trim reimplementations (lib/v8-2/judgment-format.ts exports `truncate`; tuning/self-review.ts, intel/alert-delivery.ts, memory/recall-compare.ts each reimplement). No shared markdown/telegram section-formatter — every ritual (morning/day-narrative/weekly-review/signal-intelligence/diff-digest) + briefing assembles `##`+`.join("\n")` output inline.
