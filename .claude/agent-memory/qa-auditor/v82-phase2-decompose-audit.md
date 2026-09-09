---
name: v82-phase2-decompose-audit
description: V8.2 Phase 2 decompose.ts audit (2026-06-01) — PASS WITH WARNINGS; forced-tool abort-during-handler guard dropped vs critic.ts; exclude_completed omits 'failed'
metadata:
  type: project
---

# V8.2 Phase 2 (Decomposition) audit — 2026-06-01

Files: `src/lib/v8-2/decompose.ts` (359 LOC) + `decompose.test.ts` (15 tests, all pass).
Verdict: **PASS WITH WARNINGS**. Pattern copied from `src/audit/critic.ts` (forced-tool S2 critic).

**Why:** V8.2 Phase 2 turns a strategic question into ≤3 retrieval ANGLES (not answers) via a one-shot `submit_decomposition` SDK tool, then deterministic SQL retrieval over `tasks` honoring structured boundaries, then append-only ADR write.

**How to apply when re-auditing forced-tool consumers (3rd seam now: critic.ts, decompose.ts):**
- **Abort-during-handler guard is the load-bearing copy detail.** critic.ts:261-269 returns the captured payload from the CATCH block if `sink.captured` is set (timeout races a successful tool_use). decompose.ts:189 dropped this — catch unconditionally throws DecompositionError even when angles were captured. Always diff the catch block against critic.ts when a new forced-tool consumer appears.
- Other guards that WERE copied correctly: double-call guard, already-aborted pre-check, `finally` clearTimeout + removeEventListener, single `as unknown as InlineSdkTool` cast, `maxTurns:2`.
- **Re-validation at function boundary is the real cap, not the SDK schema.** Tests call `(tool as any).handler(args)` directly, bypassing the SDK Zod parse. So `submitDecompositionSchema.max(3)` is UNTESTED; the only thing rejecting 4 angles in the test path is `DecompositionSchema.parse` (types.ts:186 `.max(3)`). Confirm the function-boundary schema actually has the cap.

**exclude_completed judgment call:** `COMPLETED_TASK_STATUSES = [completed, completed_with_concerns, cancelled]` — `'failed'` NOT included, so `exclude_completed:true` still surfaces failed tasks. Real `tasks` status CHECK (schema.sql:11) has 10 statuses incl. failed/blocked/needs_context. Defensible only if failed=signal; flag as silent gap. Test suite seeds no `failed` row so it's invisible.

**SQL safety verified GOOD:** all values bound params; empty `status_in` guarded by `.length > 0` (no `status IN ()`); `LIMIT ?` appended last via `.all(...params, limit)`; date `<=`/`>=` inclusive via ISO lexicographic compare (confirmed t-cancel-1 at exact date_to boundary is included).

**Silent limit cap:** `Math.min(limit ?? 20, 50)` truncates with no surfaced marker — evidence ledger looks complete when capped. Minor (50/angle generous).

**Path traversal:** `saveDecomposition(judgmentId: string)` interpolates into `join()`. Not reachable today (judgment_id is app-gen int) but param type is `string` wider than producer. One-line regex guard recommended, not load-bearing.

Real tasks schema columns confirmed correct: task_id/title/status/priority/created_at. TOOL_GUIDANCE enum includes `northstar_sync` (reconciliation.ts:63) but retrieval only uses tasks substrate so northstar is never queried — docstring's "moving-target guard" claim is accurate.
