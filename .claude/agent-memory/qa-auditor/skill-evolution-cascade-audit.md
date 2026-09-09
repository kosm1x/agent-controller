---
name: skill-evolution-cascade-audit
description: 3-file fix for skill-evolution ritual ~50% failure rate since 2026-05-12 (reactions/manager drops agent_type/tools/ritualId on retry → reclassifies to nanoclaw)
metadata:
  type: project
---

# Skill-Evolution Ritual Failure Cascade — Audit (2026-05-24)

**Verdict**: PASS WITH WARNINGS

**Files reviewed**: src/dispatch/dispatcher.ts (metadata persistence shape), src/reactions/manager.ts (retry/retry_adjusted forwarding), corresponding .test.ts files.

## Confirmed bug class

`handleTaskFailed` retry path was discarding `agent_type`, `tools`, `ritualId` from the failed task — retry went through classifier with no hints and 78% (per heuristic message) of ritual failures landed on nanoclaw, which structurally cannot run heavy-runner workloads (5min cap, occasional docker-image gap).

Compounding: dispatcher.ts:255 only persisted metadata when `submission.tags` was truthy — so `tools` was silently dropped at INSERT time for any submission that had tools but no tags. Ritual factories (createEvolutionRitual at rituals/evolution.ts:50) set tools but no tags, so on retry, tools was already gone from the DB row.

## Sibling submitTask call sites to watch (NOT in this fix's scope)

- swarm-runner.ts:225 (swarm-retry-policy) — does NOT preserve agentType or ritualId from `failedTask`. Sub-tasks won't be ritualContext-wrapped on retry. Same anti-pattern, different consumer. Track as follow-up.
- swarm-runner.ts:565 (initial swarm sub-task spawn) — by-design lets classifier pick; not a retry path.
- dispatcher.ts:527 (_isRequiredToolRetry) — uses `...submission` spread; already preserves all fields. Safe.

## Audited risks (cleared)

- TaskSubmission.ritualId at line 74; classifier honors explicit agentType at classifier.ts:129. The fix's `task.agent_type ?? undefined` is correct: 0 rows currently have NULL agent_type; if a row had NULL, the classifier would run and may still misclassify, but that's NOT a regression.
- task.metadata readers: only outcome-tracker.ts:46 reads `.tags`; doesn't care about new fields. messaging/router.ts:1120 reads `thread.metadata` (different table). Reaction manager metadata read at line 102 reads `.tags` for messaging-skip — still works. New metadata shape is purely additive.
- fast-runner honors `input.tools` as allowlist filter (registry.getDefinitions(input.tools)) — forwarding tools on non-ritual retry is benign.
- Companion claim verified: `submission.ritualId` flows from submitTask → dispatchTask → dispatchWithSlot → ritualContext.run wrap at dispatcher.ts:430. So reaction-retried rituals DO inherit yesterday's flailing-guard exemption.

## Behavioral pattern saved

Round-trip discipline: ANY task field that must survive a retry through reactions/manager MUST be persisted to tasks.metadata at submit time AND extracted at retry time. The reactions manager has no in-process access to the original TaskSubmission — it works from the DB row alone.

Confirmed scope of damage: 9 days × ~50% failure rate × 1 nightly cron = ~5 paired-task failure rows. Verified via the cascading-bug-chain pattern documented in [[feedback_layered_bug_chains]]: this is a 2-layer cascade (DB persistence + reaction-retry forwarding), each fix necessary, neither sufficient alone.
