# V8.3 reversibility seams (seed.ts + pipeline.ts) audit — 2026-07-06

Verdict: PASS (0 Critical / 0 Warning). Scope: `reversalStrategyForCapability` added to seed.ts; pipeline.ts seam (a) + seam (b); reworked pipeline.test.ts. Directly CLOSES Hole #1 + Hole #3 of [[v83-phase3-reversibility-audit]].

WHAT CHANGED
- Seam (a) pipeline.ts:213-227 — `buildReversalOp` bound to `reversalStrategyForCapability(cap.capability)` (canonical, from IMMUTABLE `CAPABILITY_SEEDS`), NOT `trigger.sqlMutation.strategy`. Mismatch THROWS. Fixes Phase-3 Hole #1 (northstar_sync could pass strategy:'sql_inverse' and build a local replayable inverse = 2026-05-12 resurrection class).
- Seam (b) pipeline.ts:237-241 — the §7 `L≥3 && kind!=='sql_inverse' → demote L2` moved OUT of the `if(sqlMutation)` block to fire GENERALLY. Fixes Phase-3 Hole #3 (L≥3 trigger with NO sqlMutation reached autonomous with reversalOp=null, reversible_required unenforced).

WHY IT'S AIRTIGHT (traced)
- Ordering: maxcap → ODD demote (:186-193) → sqlMutation/buildReversalOp (:203-227) → seam(b) demote (:237-241) → route (:246-247). Seam (b) is UNCONDITIONAL, after reversalOp final, before route. autonomous ⟺ effectiveLevel>2 && ux_confirm==0 ⟹ L≥3 ⟹ sql_inverse. ux_confirm + max_level only make route MORE conservative.
- Seam (a) DOUBLE protection: (1) throw before buildReversalOp AND before insertDecision → nothing built/stored; (2) builder uses canonical strategy so a "matching-but-lying" trigger still builds compensating, never sql_inverse. captureSqlPreState runs before throw but is read-only SELECT (reversal.ts:144-146). Cap-in-DB-but-not-in-SEEDS → reversalStrategyForCapability throws (fail-safe).

DOCTRINE — DEFENSE-IN-DEPTH WIN: moving a structural invariant OUT of a conditional so it no longer depends on a MUTABLE DB column (`gate_config.max_level`) being correct. Previously the only thing keeping a compensating cap off the autonomous path was max_level≤2 (a drift-prone column); now seam (b) enforces "L≥3 ⇒ sql_inverse" independently. Test at pipeline.test.ts:441 proves it by injecting the drift (gmail_send + OPEN_GATE max_level=5) and confirming demote.

DORMANCY / LIVE CANARY: ONLY runtime caller of runDecisionPipeline = executeGatedCapability (trigger.ts) ← router.ts:1704 (confirm-accept). It builds a trigger with NO sqlMutation (grep `sqlMutation:` in non-test src = EMPTY). So BOTH seams are forward-looking — neither fires on the wired path. Canary jarvis_file_delete: no sqlMutation (seam a never runs, no throw) + max_level=2/base-L1 (seam b `>=3` always false) → route/ledger/events byte-identical. UNAFFECTED.

Q4 THROW BLAST-RADIUS: throw → executeGatedCapability catch → direct unlogged execute (trigger.ts:152-164). Fail-SAFE for seam (a)'s purpose: dangerous inverse never built/persisted (throw precedes build+insert). Acceptable because wired path is L1-L2 confirm-only + never declares sqlMutation. HANDOFF CAVEAT: when an L≥3 AUTONOMOUS call site is wired, it must NOT reuse the "throw→direct execute unlogged" degrade — an autonomous action would then run with no inverse AND no ledger (defeats the seam). Same as phase-5 doctrine.

RESIDUALS (pre-existing, dormant, out-of-scope):
- sql_inverse op is only as good as caller-declared `sqlMutation.targets`: empty/under-declared targets still yield `kind:'sql_inverse'` (empty steps) that passes seam (b) + validateBlastRadius but proves nothing. Pre-existing Phase-3 W2 (verifyRestored target-scoped). No sqlMutation caller wired.

TEST INTEGRITY: 37/37 local pass. Old "L4→autonomous" (arbitrary cap, no mutation) MUST rework under new code (would demote to confirm) → correctly reworked to task_edit+sqlTrigger(sql_inverse) + asserts reversal==='sql_inverse' (STRONGER). Seam-(a) test rejects for RIGHT reason: tasks.task_id exists (schema.sql:5) so captureSqlPreState doesn't throw; regex /canonical strategy is 'compensating'/ wouldn't match a capture throw → no false-pass via early-throw. Reworked tests now couple to CAPABILITY_SEEDS canonical strategies (desirable — locks invariant).
