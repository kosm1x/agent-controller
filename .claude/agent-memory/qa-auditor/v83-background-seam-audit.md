---
name: v83-background-seam-audit
description: 2026-08-08 audit of the V8.3 gated-execution background seam (registry chokepoint) + delete_inverse reversal — PASS WITH WARNINGS, 0 Critical, 5 Warnings
metadata:
  type: project
---

# V8.3 background seam + delete_inverse (2026-08-08) — PASS WITH WARNINGS

Bundle: `src/lib/v8-3/gated-execution.ts` (NEW), `trigger.ts` (thin wrapper),
`src/tools/registry.ts` (execute split + background seam), `pipeline.ts`
(`creation` declaration, §7 widened to {sql_inverse, delete_inverse}),
`reversal.ts` (delete_inverse variant), `decisions-store.ts`.

## Verified-holding invariants

- **No double-record**: interactive passes `{v83:"skip"}`; registry gates on
  `opts?.v83 !== "skip"`. Degrade path re-enters with `skip` (interactive) or
  `executeDirect` (background) — never the recording path.
- **At-most-once**: `output` sentinel at gated-execution.ts:209 gates the degrade.
- **No live import cycle break**: cycle EXISTS (registry → gated-execution →
  db/index → tuning/activation → registry) but is benign — no top-level
  cross-reference. Empirically smoke-tested both entry orders.
- **In-container inert**: `nanoclaw-runner.ts:77` / `heavy-runner.ts:165` build an
  explicit env ALLOW-LIST; `V83_ENABLED` is not in it → seam dormant in Docker.
- **Concurrency**: no module-level mutable state; `output` is per-invocation.
- **ident() at build AND apply**; `SAFE_IDENT` anchored.
- **null-pk op cannot replay**: refused in `applyReversal` and `revertDecision`.

## Doctrine crumbs (generalizable)

1. **A `getDatabase()` (or any throw-capable resolve) placed OUTSIDE the try that
   implements "never blocks" is the single line that defeats the invariant.**
   gated-execution.ts:147. Reproduced: tool never ran, `registry.execute` threw.
   When auditing a fail-OPEN wrapper, find every statement BEFORE the try.
2. **Moving a wrapper onto a shared chokepoint changes the FAILURE CHANNEL, not
   just the success path.** The catch converts a tool THROW into a returned
   `{error}` string — so on the claude-sdk path (`claude-sdk.ts:156`) a failing
   gated tool now returns `isError:false`. Ungated tools on the same registry
   still throw. Diff the *error* contract, not only the output.
3. **A gate that admits a TEMPLATE admits a promise, not a proof.** §7 widened to
   accept `delete_inverse` with `pkValue:null` pre-execution. Post-execution the
   op may stay incomplete and NOTHING freezes the decision — the comment names
   the §10 freeze class, no code implements it. Grep for the enforcement of every
   "a future caller MUST…" comment.
4. **A test that mocks the very contract it claims to pin proves nothing.**
   `gated-execution.test.ts:112-118` uses a `fakeTool` emitting `schedule_id`;
   nothing ties `CREATION_BY_TOOL` to the real `schedule.ts:153` output field or
   the real `scheduled_tasks` DDL. Rename either and every test stays green.
5. **The hardest degrade branch is usually the untested one.** All degrade tests
   throw BEFORE execute (unseeded capability). The `output !== undefined` branch
   (pipeline throws AFTER execute) has zero coverage — the exact regression that
   would double-send a gmail or double-create a schedule.

## Live state at audit time (2026-08-08)

`V83_ENABLED=true`, `V83_GATED_CAPABILITIES=jarvis_file_delete,gmail_send,
northstar_sync,schedule_task` (systemd drop-in). NOT dormant — this change goes
live on the next deploy. `decisions` table had 0 lifetime rows; all 6 capabilities
seeded at level 1, so no L≥3 path is reachable yet.
