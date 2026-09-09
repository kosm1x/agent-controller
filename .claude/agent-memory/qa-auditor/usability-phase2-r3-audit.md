# Usability Phase 2 R3 — R2 folds verified (2026-08-23)

Scope: same uncommitted bundle (13 modified + 5 new files). Baseline
45/45 GREEN (`readback.test.ts` + `readback-wiring.test.ts` + `consumer.test.ts`).

**Verdict: FAIL — 1 Critical, 3 Warnings.** R2's C1/W1/W3/W4/W5/W8 folds all
landed; the third read-back state (`pending` → `⏳ Sin releer`) was added to the
RENDERER and to nothing else — it is unhandled by the router tail-preserver and
by the deliverable-filter's `isOwnLine`, and its consumer wiring is pinned only
by an `||` assertion that cannot fail.

## Doctrine (transferable)

1. **A tail-preserving loop keyed to a literal prefix list is a whitelist: the
   line class added last is the one it drops.** router.ts scans back over
   `✔ Verificado:` / `⚠️ No quedó:` / blank / failureLine. `⏳ Sin releer` and
   the enforce-mode `Gates:` block are appended AFTER those lines, do not match,
   so the scan stops at index 0 → `tail=undefined` → the whole read-back block
   falls under the 500-char body cap and vanishes. **Rule: when a renderer
   appends line classes in a fixed ORDER, the downstream preserver must be
   keyed on "everything from the first appended line onward", not on a prefix
   set that must be kept in sync by hand.**
2. **An `||` in an assertion is an OR over two DIFFERENT code paths — the
   green one hides the red one.** `expect(text.includes("⏳ Sin releer") ||
   text.includes("✔ Verificado")).toBe(true)` passes with the met branch alone;
   deleting `formatSinReleer(gates.rows)` from the consumer stays GREEN.
3. **A fix implemented twice looks pinned and is not.** The C1 population split
   lives in `formatLedgerBlock`/`ledgerSummaryJson` (they filter internally);
   the consumer's `others` filter is redundant, so reverting it is GREEN and
   behaviour-neutral. Locate the invariant's single owner before crediting a
   mutation as pinned.
4. **Excluding a row class from `output.gates` does not exclude it from the
   TRACE.** `gates.evaluated` attrs come from `evaluateLedger` (all rows);
   `output.gates` now excludes read-backs. `mc-ctl gates summary` (mc-ctl:2939)
   therefore sums a different population than the per-task JSON. Harmless for
   the CLI (a superset) but the swarm parent path reads the same unsplit
   verdict and demotes a child to hard FAILED on a read-back the direct
   consumer only demotes to `completed_with_concerns` (swarm-runner.ts:853).

## Mutation matrix

| # | mutation | result |
|---|---|---|
| a | enforce population → `gates.rows` | **GREEN — redundant filter, invariant lives in gates.ts** |
| b | RB- reservation → `if (false)` | **RED** (1) |
| c | `formatSinReleer` dropped from consumer | **GREEN — UNPINNED** |
| d | sheets append key → `sheet:${id}` | **RED** (1) |

## Verified-good (do not re-flag)

- No consumer of `tasks.output.gates` exists outside v8-4 — `mc-ctl gates`
  reads `task_gates` + trace attrs directly, `gates-validate.ts` only validates
  input specs, `/api/tasks` is input-side. The `readback` key breaks nobody.
- W5's throw is safe at the dispatch seam: dispatcher.ts:442-448 wraps
  `declareGates` in try/catch ("task runs ungated"), so an RB- id in a
  submission/plan payload cannot lose the task.
- Read-back rows are filtered out of `renderGatesBlock` (prompt), the
  stop-hook's blocking set, and the model's ABANDON namespace.

## Reproduction

Mutations are safe here ONLY with an explicit backup: the whole bundle is
uncommitted, so `git checkout` is not a revert path. Copy each file to the
scratchpad first, `cmp` after restoring. vitest paths must be literal in the
command string (pre-tool hook).
