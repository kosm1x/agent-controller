---
name: v7.7 Spine 6 Bundle 1 recall-modes audit
description: Conway Pattern 3 named recall modes audit. PASS WITH WARNINGS. W1 = two resolvers (resolveExcludeOutcomes vs resolveRecallMode) use divergent precedence ordering for the recallMode + explicit-excludeOutcomes input, mislabeling recall_audit.mode. Currently unreachable (0 recallMode callers).
type: project
---

# v7.7 Spine 6 Bundle 1 audit (2026-05-20)

## Scope
recall-mode.ts (NEW), types.ts (RecallOptions.recallMode field), outcome-bias.ts
(routes exclude-set via resolveExcludeOutcomes), db/index.ts (ALTER recall_audit
ADD COLUMN mode TEXT CHECK), recall-utility.ts (logRecall writes mode), 6
hindsight-backend logRecall sites, recall-mode.test.ts (13 tests, NOT 16 as bundle claimed).

## Verdict: PASS WITH WARNINGS

## W1 — divergent-precedence resolver pair (transferable pattern)
`resolveExcludeOutcomes` checks `excludeOutcomes` BEFORE `recallMode`; `resolveRecallMode`
checks `recallMode` FIRST. For input `{recallMode:'unfiltered', excludeOutcomes:['outcome:failed']}`
the exclude-set is `['outcome:failed']` (filtered) but the audit tag is `'unfiltered'` — a
filtered recall logged as unfiltered. Defeats the bundle's own auditability goal.
Currently unreachable: zero production callers set `recallMode` (only types.ts:87 references it).
Pattern: when two functions derive related outputs from the same option object, they MUST
share precedence ordering or one will mislabel. Tests exercised each knob in isolation only —
the cross-product (`recallMode` + non-empty `excludeOutcomes`) was the gap.

## Verified clean
- Behaviour-neutrality (#1): exhaustive 6-case walk, old `includeFailed ? [] : (excludeOutcomes ?? DEFAULT)` == new `resolveExcludeOutcomes` for every recallMode-unset input. No divergence.
- CHECK on ADD COLUMN (#3): tested against real better-sqlite3. ALTER with CHECK succeeds, pre-existing rows get mode=NULL and pass (`mode IS NULL OR ...`), invalid rejected, PRAGMA idempotency guard works.
- logRecall fire-and-forget (#4): writeWithRetry re-throws non-BUSY errors; logRecall outer try/catch swallows. Safe.
- 6 hindsight-backend sites all have `mode: resolveRecallMode(options)`, options in scope.
- sqlite-backend.ts untouched — confirmed zero applyOutcomeBias/logRecall refs.

## R1 — RecallMode type (recall-mode.ts:24) vs inline union (types.ts:87) are 2 sources of truth, can drift silently. Import cycle is the constraint; add a satisfies/type-equality assertion.
