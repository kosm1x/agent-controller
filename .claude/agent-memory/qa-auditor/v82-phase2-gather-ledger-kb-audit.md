---
name: v82-phase2-gather-ledger-kb-audit
description: V8.2 Phase 2 "widen the gather ledger" — decompose.ts KB pass added to gatherEvidence (2026-07-01) PASS WITH WARNINGS
metadata:
  type: project
---

# V8.2 Phase 2 — widen the gather ledger (KB pass) — 2026-07-01

Change: `decompose.ts` `gatherEvidence` now appends a subject-keyed KB pass
(`retrieveKbForQuery(subject)` over `jarvis_files_fts`, kind=`kb_entry`, id=path,
`DEFAULT_KB_LIMIT=5`/`MAX_KB_LIMIT=8`) so the author cites the SAME surface the
§11 critic verifies (`recall_check`). `produce.ts` one line: `gatherEvidence(…, { subject: j.subject })`.
Verdict: **PASS WITH WARNINGS**.

## Verified correct (don't re-flag)
- `id=path` safe: `jarvis_files.path` is `TEXT UNIQUE NOT NULL` (index.ts:234). Dedup key
  `kind:id` (gatherEvidence:434) == `computeConfidence`'s `${r.kind}:${r.id}` (confidence.ts:98) — agree.
- `resolveCitations` resolves by INDEX (`ledger[k-1]`), never by id → path string inert to resolution.
  KB refs appended AFTER tasks; same single array threaded everywhere (LEDGER INVARIANT); one bm25 query = stable order.
- `kb_entry` is a legal `evidence_kind` CHECK value (v8-2-phase1-schema.test.ts:200). No DDL.
- FTS injection impossible: `sanitizeFtsQuery` (critic.ts:307) reduces to `[a-z0-9]+`, quotes+ORs, strips every FTS op; `match` is a bound param.
- `path UNINDEXED` (index.ts:275) → MATCH searches title+content only, IDENTICAL to critic recall_check → author/critic surfaces are symmetric (the point of the change).
- Cost fine: ≤5×≤200char refs negligible vs the already-uncapped task pass (MAX_ANGLE_LIMIT 50 × 3 angles).

## DOCTRINE (the transferable findings)
- **Confidence inflation via UNCITED ledger refs.** `computeConfidence` counts DISTINCT sources over the
  WHOLE gathered ledger (produce.ts:277 `evidenceRefs: ledger`), NOT the cited refs. So a broad keyword
  pass that adds N grounding refs raises `distinct_sources` even for refs the author never cited. Concrete:
  subject-keyed KB returns 3-5 fresh files → `distinct_sources≥3`, `stale=0`, `contradiction=0` → GREEN,
  even when the task pass matched 0 tasks (was red pre-change). When auditing any change that WIDENS an
  evidence ledger fed to a "distinct-source" confidence function, check whether confidence counts the
  gathered ledger vs the cited subset — widening the ledger silently inflates the color.
- **Name the backstops and prove they DON'T cover the mode.** §11 critic only lowers confidence via
  `contradiction_count` (must PROVE a claim false — vague-but-true is never contradicted). §10 floor
  (`downgradeColorFloor`) only fires when prose is MORE cautious than color (green+direct passes). bm25
  RANKS but has no score THRESHOLD, so subject-keying+bm25 does NOT filter weak hits. All three are
  ORTHOGONAL to thin-but-clean-evidence inflation. Fix direction = count distinct sources among CITED
  resolved claims, not the whole ledger (Phase-8 scope). Mitigated here only by SHADOW + §17 gate FAIL.
- **Untested degrade path (repeat pattern).** The headline "never throws / degrades to task-only when
  jarvis_files_fts absent" (decompose.ts:391 catch) has ZERO coverage — every test uses
  `initDatabase(":memory:")` which ALWAYS creates the FTS table (index.ts:273). The resilience claim most
  needing a guard is unverified. Same class as v82-delivery W1. Test = seed bare db, DROP the FTS table,
  assert `[]`.
- **The one-line wiring is the untested seam.** produce.ts:328 `subject: j.subject` is the whole
  integration; produce.test mocks `gatherEvidence` (vi.fn) and never asserts call args → deleting
  `subject: j.subject` passes all tests while the KB pass silently never runs in prod. Always check that a
  one-line "pass field X into mocked function Y" change has a `toHaveBeenCalledWith(objectContaining({X}))`.

## Residuals worth naming (Info)
- Coverage: subject-keying only closes the fix for subjects whose name is in title/content; descriptive /
  multi-subject subjects miss (degrade=safe) or OR-match noise (feeds inflation). Acceptable Phase-2 boundary.
- No KB-namespace filter → a subject matching a secret-bearing memory note surfaces a ≤200char snippet;
  low sev (operator owns KB, shadow), revisit if V8.2 gains a non-operator delivery surface.
- `getDatabase()` at decompose.ts:377 is OUTSIDE the try → "never throws" is scoped to query exec not db acquisition (irrelevant in prod, db always injected).
