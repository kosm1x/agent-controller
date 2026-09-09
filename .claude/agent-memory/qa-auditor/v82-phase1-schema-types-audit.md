---
name: v82-phase1-schema-types-audit
description: V8.2 Phase 1 (attributed_claims + sycophancy_probes DDL + src/lib/v8-2/types.ts) audit — PASS, drift guard is one-directional (DDL⊇TS only)
metadata:
  type: project
---

# V8.2 Phase 1 "Schema + types" audit (2026-06-01)

Verdict: PASS (additive + dormant, no producers write rows). All 32 scoped tests green, typecheck clean, no `any`.

Files: `src/db/index.ts` lines 997-1055 (attributed_claims + sycophancy_probes DDL), `src/lib/v8-2/types.ts` (NEW §6/§7 types), `src/db/v8-2-phase1-schema.test.ts`, `src/lib/v8-2/types.test.ts`.

**Why:** Phase 1 of the V8.2 Strategic Initiative Layer. Builds on Phase 0 (judgments + reflection_followups, reconciliation.ts enums). DDL matches spec §6 verbatim; types.ts matches §6/§7. `foreign_keys=ON` (index.ts:38) so FK/CASCADE tests genuinely enforce.

**How to apply (findings to carry into Phase 2+):**
- **Drift guard is one-directional (DDL ⊇ TS only).** The `accepts every EVIDENCE_KINDS value` test (schema.test.ts:200) iterates the TS enum and asserts each inserts. Catches "added TS value, forgot DDL" but NOT "added DDL value, forgot TS" (a divergent DDL-only CHECK value passes silently). Same for RESOLVER_STATUSES/CONCESSION_KINDS guards. Low severity (DDL is hardcoded literal, TS is source of truth) but the reverse direction is the realistic drift when someone hand-edits the SQL string. To close: parse the CHECK list out of sqlite_master and assert set-equality with the TS array.
- Posture divergence ('momentum' V8.2 DDL/POSTURES vs 'has_momentum' V8.1 JudgmentSchema) is INTENTIONAL + pinned by test (types.test.ts:167-178). Do not flag.
- `triggering_evidence_text required iff concession_kind='updated_with_evidence'` (spec line 166/508) is a Phase 8/§13 runtime rule, NOT a Phase 1 schema concern. `z.string().optional()` is correct for Phase 1.
- Benign noise: `[jarvis-index] Failed to regenerate INDEX.md: Database not initialized` during teardown — fire-and-forget from seedDirectives→markIndexDirty racing closeDatabase, `.catch(()=>{})`-swallowed, pre-existing (any initDatabase test emits it). Not introduced here.

Pattern reaffirmed: when a DDL CHECK must stay in lockstep with a TS enum, a one-sided "every-enum-value-inserts" test is the common shortcut — flag it as Warning because the realistic drift (hand-edited SQL adds a value) is the uncovered direction.
