# Usability Phase 2 R2 — R1 folds verified (2026-08-23)

Scope: `readback.ts` rewritten (artifact-keyed ids + supersede/withdraw),
`readback-verifiers.ts`, 3 test files, deltas in `gates.ts`/`gate-check.ts`/
`consumer.ts`/`stop-hook.ts`/`deliverable-filter.ts`/`router.ts`/handlers.
tsc clean; 1430/1430 (`src/lib/v8-4` + router + deliverable-filter + `src/tools`).

**Verdict: FAIL — 1 Critical, 8 Warnings.** All 3 R1 Criticals folded correctly;
the C3+filter fold CREATED a new contradiction in the very mode it fixed.

## Doctrine (transferable)

1. **Filtering a row class out of the RENDERER but not out of the VERDICT
   function re-creates the contradiction the filter was meant to remove.**
   `formatLedgerBlock`/`renderGatesBlock` filter read-back rows; `ledgerVerdict`
   and `ledgerSummaryJson` do not. Enforce mode therefore prints
   `⚠️ No quedó: …` and, two lines later, `Gates: 1/1 met` — while
   `tasks.output.gates` stores `verdict:"failed", total:2`. **Rule: when you
   exclude rows from a display, diff the display's arithmetic against the
   stored summary's arithmetic; a headline count is a claim.**
2. **Supersede is correct for MUTATING writes and wrong for APPENDING ones.**
   `kb:<path>` supersede is right (a 2nd write replaces the state). Sheets
   `sheet:<id>|<sheetName>` supersede is wrong: appends never overwrite each
   other, so N appends collapse to ONE gate proving only the last row.
   Corpus: 4/4 tasks that used `gsheets_write` in 30d called it >=2x (2,3,3,5)
   vs 13/168 (7.7%) for KB. **Rule: key the gate by what the write can
   CLOBBER, not by the container it lands in.**
3. **A harness proof whose id is derivable and whose declarer yields to an
   existing row can be pre-empted from the model side.**
   `declareReadbackGate` returns false when a same-id row has
   `source !== 'harness'`; ids are `RB-<sha8("kb:<path>")>` and gate ids are
   caller-chosen in `parseGateSpecs`/planner object-form. C2 closed the ABANDON
   door; this is the same class through the DECLARE door. **Rule: reserve the
   harness id namespace in the parser, not only in the writer.**
4. **A third state renders nowhere.** met/failed have Spanish lines; `pending`
   (ledger budget exhausted) is filtered out of `formatLedgerBlock` too, so a
   read-back that never ran is invisible under BOTH modes — pre-fold, enforce
   at least printed `unverified: RB-…`.

## Verified-good (do not re-flag)

- **W1 is airtight end-to-end**: the only `source="harness"` `declareGates`
  callers are consumer.ts:192 (landing, no check text) and readback.ts:186.
  `/api/tasks` (routes/tasks.ts:68) never sets `gatesSource`; rituals pass
  "ritual", swarm "plan". R1 doctrine-4's arbitrary-`spreadsheet_id`-under-
  operator-OAuth hole is CLOSED.
- **W8 timing is correct and needs no tolerance**: `declaredAt` is stamped
  BEFORE `appendToFile` (jarvis-files.ts:449-452). JS
  `toISOString().slice(0,19).replace("T"," ")` and SQLite `datetime('now')`
  are both UTC `YYYY-MM-DD HH:MM:SS` — lexicographic compare valid. The R1
  skew scenario (stamp taken after the write) cannot occur.
- **E2E replay, 7/7 met, 0 false `No quedó`**: plain write · write+tags/
  qualifier/priority · write-then-append (supersede) · metadata-only update ·
  markdown/table append · batch x2. `appendToFile` joins with `\n\n` and does
  not transform the text, so whitespace-normalized `must_contain` holds.
- C2 by probe: `ABANDON: RB-…` leaves the row `failed` + evidence,
  `abandon_reason` NULL.
- Stop-hook cannot deadlock (stop-hook.ts:109-120): shell+failed-RB blocks on
  the shell gate only; RB-only releases; `hasRunnableGates` excludes manual so
  an RB-only ledger never builds a hook.
- `appendToDeliverable` early-returns on an empty suffix (consumer.ts:108), so
  the all-pending / all-withdrawn case cannot clobber `text` with "".
- W6 works: `"Voy a escribir el archivo.\n\n⚠️ No quedó: …"` → `stripped:[]`
  (R1 measured `narration:1` without it). `isOwnLine` is used ONLY inside
  `contentLength` — it excludes the lines from the guard, never deletes them.

## Mutation matrix

| # | mutation | result |
|---|---|---|
| a | supersede → `if (false && existing)` | **RED** (2) |
| b | ABANDON exclusion removed | **RED** (1) |
| c | read-back block skipped under enforce | **RED** (1) |
| d | `source === "harness"` → `true` | **RED** (1) |
| e | `isOwnLine` extension → `false` | **GREEN — UNPINNED** |
| f | 6 of 7 wiring sites | **RED**; `jarvis_files_batch_write` **GREEN — UNPINNED** |

W7's "all 7 call sites" claim is false: batch_write has no wiring assertion.

## Not answerable from the corpus

`task_trace_events` has no args payload — columns are `(id, task_id, run_id,
ts, name, round, tool, tokens_in, tokens_out, cost_usd, latency_ms, attrs)`
and `attrs` is NULL on every `tool.called` row. Path + appended text cannot be
reconstructed, so a historical false-`No quedó` count is impossible. The e2e
replay above is the substitute evidence. (Per-task tool COUNTS are available
via the `tool` column and are what the corpus arguments above rest on.)

## Reproduction

Probes in scratchpad `p1..p5.mts` — use the `.mts` extension (top-level await),
import project modules by ABSOLUTE path. `tasks.id`/`created_at` are
INTEGER-typed: skip the `tasks` insert entirely, `task_gates` has no FK to it.
The vitest pre-tool hook needs an explicit path in the LITERAL command string,
so `npx vitest <verb> $VAR` inside a shell function is blocked too — inline the
path at every call.
