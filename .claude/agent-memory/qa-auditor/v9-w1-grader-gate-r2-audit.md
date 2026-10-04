---
name: v9-w1-grader-gate-r2-audit
description: V9 W1 grader gate R2 re-audit (uncommitted 2026-10-04) - PASS WITH WARNINGS, 0 Crit, 4 Warn; R1 W1-W7 closed; critic SQL guard via EXPLAIN
metadata:
  type: project
---

# V9 W1 grader gate - R2 audit (uncommitted, 2026-10-04, branch claude/s4-verify-gate-sphh8y)

**Verdict: PASS WITH WARNINGS - 0 Crit, 4 Warn, 8 Info, tsc 0, 435/435 (12 scoped files), mutants 28/31 valid RED** (35 run; M1 lexical-layer-off, M4 p3-check-off, M11 shadow-before-ledger and M16 render-time redaction are equivalent or near-equivalent).

## R1 folding (verified against each R1 scenario)
- W1 closed. `tablesOutsideWhitelist` reads the EXPLAIN program: OpenRead/ReopenIdx root pages are mapped through sqlite_master, VOpen is refused, and p3!=0 (a non-main database) is refused. Every R1 spelling, alias-comma and paren is refused even with the lexical layer removed.
- W2 closed. Measured the worst case at 1656 chars (6 criteria with evidence). At 12 or more criteria, evidence is dropped and the counts survive.
- W3 closed: `singleLineRedacted` runs at normalize, at record and at render.
- W4 closed (early exit) and W5 closed (replan): `syncGradeSpecs`, `withdrawGradeSpecsForGoals`, and `adoptLedgerGradeRows` on resume.
- W6 closed: shadow is fire-and-forget after `completionLedgerStage`; it has a `.catch`, `emitTraceEvent` never throws, and `Promise.race` handles the losing call.
- W7 closed: the `GR-sw.` namespace.
- I1, I2 (`skipBreakerOnCallerAbort`, inert unless passed), I3, I6, I7 (error label and completed_with_concerns) and I9/I10 are also closed.
- Flag-off byte identity re-checked:
  - `completionLedgerStage` is a verbatim move.
  - `renderGatesBlock` is identical when there are no GR rows.
  - The orchestrator's sync/withdraw calls return at mode off.
  - critic.ts is NOT flag-gated (see W1 below).

## Warnings
- W1 critic.ts `hiddenIdentifierToken` rejects any `"`, backtick or `[` outside a literal, so legitimate double-quoted identifiers (`SELECT "task_id" FROM "tasks"`) are refused on the LIVE V8.2 critic, ungated. The critic system prompt itself writes `"tasks"`/`"task_id"`, and each refusal burns a tool-budget call. It is redundant: the EXPLAIN layer alone refuses every bypass spelling (M1 survived; checked by hand). Fix: drop the quote/bracket ban, or the whole lexical layer.
- W2 The VOpen refusal is load-bearing and untested (M3 survived). With it removed, `SELECT f.* FROM tasks t, conversations_fts f` returned the conversation content. Add that fixture.
- W3 Shadow no longer records criterion TEXT anywhere: `output.grader` was removed, the traces carry ids only, the registry is consumed, and the evidence is shrunk away at about 12 criteria. The labelling list (plan doc §6) shows `GR-g-2.1=failed` with nothing to label against. Fix: put a truncated criterion in the `gates.grade_specs` trace, or in a per-task record.
- W4 M6 survived: `skipBreakerOnCallerAbort` set without an abort is untested. A refactor that skips whenever the flag is set would hide real Opus outages from the shared breaker. Add the not-aborted control case.

## Info
- Goals left blocked on a normal exit (pending=0) are not withdrawn and can be graded failed (the same as plan gates).
- A replan that drops a completed goal withdraws that goal's specs, so the work goes ungraded (the safe direction).
- Detached shadow grading has no concurrency cap and can overlap the next swarm wave; an in-flight grade is lost on restart.
- The "collected after the ledger settled" ordering is not load-bearing (M11).
- The 150-char headroom is untested (M21).
- I1 heuristic: an `Error:` prefix or `query aborted` anywhere in the model's own text is classed as grader_unavailable.
- mc-ctl: the window comparison of 'T' against a space remains (a pre-existing pattern).
- Enforce resume: pending GR rows of goals missing from the resumed graph are still graded.
- `_drainShadowGradesForTests` is exported from production code.

## Doctrine
- CLASS: once a structural check exists (EXPLAIN-opened tables), a lexical layer stacked on top adds only false rejects. Score it on legitimate spellings, including those the model's OWN prompt primes.
- Moving a record from durable output to a size-capped trace loses whatever the trace does not carry. Ask "can the labeller still see WHAT was judged?"
- A security branch the regex layer shadows in the fixtures (VOpen) needs a fixture that only that branch catches.
