---
name: v9-w1-grader-gate-r3-audit
description: V9 W1 grader gate R3 verification (uncommitted 2026-10-04) - PASS WITH NOTES; R2 W1-W4 + Info 3/8 closed; critic vs HEAD shape table
metadata:
  type: project
---

# V9 W1 grader gate - R3 audit (uncommitted, 2026-10-04)

**Verdict: PASS WITH NOTES - 0 Crit, 0 Warn, 1 Info, tsc 0, 440/440 (12 scoped files), new-test mutants 6/6 valid RED** (8 run; N6, where an over-cap skip occupies a slot, and N8, where the criterion is not redacted, are equivalent: the skip resolves in microtasks, and emitTraceEvent redacts attrs anyway).

## Closed
- R2 W1: the lexical layer is gone and EXPLAIN is the only guard.
  - Ran 18 query shapes against HEAD critic.ts and the new one side by side: 17 behave the same. Quoted identifiers, comments, aliases, subqueries, UNION and LEFT JOIN are all accepted as before.
- R2 W2: the VOpen fixture goes RED when the refusal is removed (N1).
- R2 W3: `gates.grade_specs` registration now carries `{id, criterion}`, shrunk to fit.
  - The mc-ctl disagreement list joins it, falling back to task_gates for manual rows.
  - Ran that SQL on synthetic rows: both criteria rendered.
- R2 W4: the not-aborted control case goes RED (N3).
- Info 3: the cap of 4 holds; an over-cap task is traced `skipped_concurrency` with no grader call. Removing the cap (N4) and loosening it by one (N5) both go RED.
- Flag off: the cap code is reachable only from shadow, and gradeDecision's new parameter defaults to false.

## Info
- The one shape HEAD accepted and the new guard refuses: `SELECT j.value FROM tasks t, json_each(t.output) j`.
  - HEAD accepted it only through the regex alias gap.
  - json_each and json_tree read only their argument, so allowing these two eponymous virtual tables would restore it.
  - The non-aliased forms were already refused by the HEAD regex.

## Doctrine
- To prove "the guard change rejects nothing new", run an OLD-vs-NEW table: import HEAD's file under a temporary name and run both over the same legitimate shapes.
