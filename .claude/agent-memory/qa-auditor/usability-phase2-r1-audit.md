# Usability Phase 2 R1 — read-back gates on the V8.4 ledger (2026-08-23)

Scope: `src/lib/v8-4/readback.ts` + `readback-verifiers.ts` (+3 test files),
`gates.ts` / `gate-check.ts` / `consumer.ts` deltas, handlers in
`jarvis-files.ts` (3) / `google-docs.ts` (3) / `schedule.ts` (1), `index.ts`,
`task-trace.ts`. tsc clean; `src/lib/v8-4` 94/94; `src/lib/v8-4 + src/tools`
1292/1292. Live `TASK_GATES_MODE=shadow` (drop-in `v84-gates.conf`), stop hook
off, `dist/` predates the bundle (not deployed).

**Verdict: FAIL — 3 Critical, 16 Warnings, 4 Standards violations.**
The author edited `readback.ts` / `readback-verifiers.ts` mid-audit (added
`MAX_VERIFICADO_ITEMS=3` and `cellEquals`); findings are pinned to md5
`39708ecb…` / `c60daa3d…`.

## Doctrine (transferable)

1. **A gate whose EXPECTATION is a snapshot of a mutable artifact fails when
   the same task legitimately mutates it again.** Proven: `jarvis_file_write`
   (sha of "primera versión") + `appendToFile` in ONE task ⇒ R-1 `failed`,
   status demoted, and the deliverable carries BOTH `✔ Verificado: KB x.md
   (sha 4b7e…)` and `⚠️ No quedó: KB x.md … (sha 4b7e… ≠ a7f4…)` for the SAME
   path — self-contradictory, and the work was correct. Population measured:
   14/173 tasks (8.1%, 31d `task_trace_events`) call a KB write tool ≥2× in
   one task (max 6). **Rule: before shipping a snapshot-compare gate, count
   how often one task touches the same artifact twice — and supersede the
   earlier gate instead of letting both stand.** `declareGates` is INSERT OR
   IGNORE / additions-only, so there is no supersede primitive today.
2. **`ABANDON: <id>` is a model-writable escape from a harness-owned proof.**
   `evaluateLedger` honors ABANDON lines (gate-check.ts:276-292) BEFORE the
   run loop and skips `abandoned` rows (:297). Proven: gate that WOULD fail +
   report line `ABANDON: R-1 no pude escribirlo` ⇒ status stays `completed`,
   zero lines appended, row silently `abandoned`. Control without the line ⇒
   `completed_with_concerns` + `⚠️ No quedó`. Both Phase-2 consumers
   (`formatNoQuedo` readback.ts:190, `formatVerificado` :204) filter on
   `failed`/`met` only, so an abandoned read-back is invisible — violating
   V8.4 structural property #3 ("surrender is visible; every consumer lists
   abandoned gates") and plan §2.2 ("`ABANDON` path renders `No quedó:`").
   **Rule: when a new gate class is harness-owned, exclude it from the
   model-authored ABANDON parser, or render abandoned rows in its consumer.**
3. **A feature implemented in the `else` of a mode fork disappears in the mode
   the plan targets.** consumer.ts:213-244: the read-back demotion + Spanish
   lines live in the non-`enforce` branch. Proven: mode=shadow → `⚠️ No
   quedó: …`; mode=enforce → `Gates: 0/1 met · FAILED: R-1 (…)` (English
   harness block, no `gates.readback` event). Plan §2.2 says "enforce for
   write classes" — flipping it deletes the Phase-2 UX and puts a raw harness
   string on the phone (Phase 0's banned class). **Rule: read the fork the
   feature sits in against the mode the plan asks the operator to switch to.**
4. **An untrusted-payload validator that admits a runnable prefix makes the
   payload runnable.** `parseGateSpecs` accepts `check` on `kind:"manual"`
   (gates.ts:104-113) and `declareGates` now persists it when it starts with
   `readback:` (gates.ts:215-219) — no `source` check. An `/api/tasks`
   key-holder can hand the harness a `gsheets_write` payload with an arbitrary
   `spreadsheet_id`; the verifier reads it with the operator's OAuth bearer,
   OUTSIDE the tool registry (no Rule-of-Two, no risk tier, no `tool.called`
   trace) and echoes up to 80 chars of cells into the deliverable and
   `tasks.output.gates`. Fix: `kind === "manual" && source === "harness" &&
   check.startsWith("readback:")`.
5. **Deriving the expectation from a post-write READ makes the gate a
   tautology.** `jarvis_file_update` passes `sha8(getFile(path).content)`
   read AFTER the append (jarvis-files.ts:457-465) — it can only fail if
   something changes the file LATER (i.e. doctrine 1's false positive). It
   cannot detect the #11750/#11820 "never persisted" class it cites.
   `jarvis_file_write` (hashes the INPUT) is the only genuine content check.
   Fail-open twin: `if (expected && actual !== expected)` (verifiers.ts:53) —
   an empty expected sha disables the comparison entirely; same for
   `first_row: []` on Sheets and empty-string cells (`w !== ""`, :83-85).
6. **Appending harness lines to a deliverable changes the sanitizer's
   arithmetic.** Verified against the real `sanitizeDeliverable`: the two
   lines survive untouched, BUT they count as content in the ≥80-char guard,
   so `"Voy a escribir el archivo."` (unchanged alone) becomes
   `stripped:["narration:1"]` with the model's own sentence DELETED once the
   ledger lines are appended. **Rule: a new appender at a filtered seam must
   be replayed through the filter both with and without a short body.**

## Verified-good (do not re-flag)

- `renderGatesBlock` does NOT leak the `readback:` JSON — the `check_cmd`
  branch is guarded by `check_kind === "shell"` (gates.ts:376). Manual rows
  render `[manual — state the evidence in your report]`.
- `runCheck`/`validateShellCommand` never see a readback row (kind dispatch
  precedes the shell branch) — no shell-injection surface.
- `ledgerSummaryJson` / `formatLedgerBlock` omit `check_cmd`; no HTTP/SSE/A2A/
  MCP/dashboard surface serializes it.
- `mc-ctl gates <id>` uses `sqlite3 -header -column` with no awk/IFS: `|`,
  `"`, `{}` in the payload are safe (emoji in a KB path misaligns columns;
  cosmetic).
- Sheets dedup-removed-everything returns `{written:false}` BEFORE any
  `declareReadbackGate` (google-docs.ts:250-258) — no gate on a 0-row write.
- `enterRunToolContext(taskId, …)` always stamps the CURRENT task id, so a
  nested dispatch attributes read-backs to the child, not the parent.
- `hasRunnableGates` excludes manual ⇒ a ledger of only read-backs never
  blocks the (dormant) Stop hook.
- Telegram: `TelegramStreamController.finalize(fullText)` ignores its own
  `accumulatedText`; the router feeds it the post-ledger `task.completed`
  text (router.ts:2734) — the lines DO reach the phone on the streaming path.
- Ritual change-only suppression is not defeated: `fingerprintReport` is four
  field regexes, not a content hash (`sha` line does not move it).

## Reproduction

- Probes: `/tmp/…/scratchpad/probe1.ts` (filter), `probe2.mts` (ABANDON /
  write-then-update / R-id collision), `probe3.mts` (mode fork, N-failure
  fan-out). Run `.mts` — top-level await fails under tsx's cjs transform for
  `.ts`. Import project modules by ABSOLUTE path so better-sqlite3 resolves.
- Mutation harness: back up to scratchpad, `python3` in-place edit, restore by
  `cp`, verify with `md5sum` + `git diff --stat`.
- Mutation results: `isReadbackRow` branch in gate-check → 3 RED; consumer
  demotion → 1 RED; `declareReadbackGate` removal → RED only for
  `jarvis_file_write` and `jarvis_file_update`. **5 of 7 declare sites
  (batch_write, gsheets append, gsheets overwrite, gdocs_write, schedule_task)
  are GREEN when deleted** — 1292/1292 pass.
