---
name: v77-spine6-b2-conway-p3-audit
description: v7.7 Spine 6 Bundle 2 Conway Pattern 3 correspondence-audit drift signal audit (2026-05-20) — PASS, 0C/0W
metadata:
  type: project
---

# v7.7 Spine 6 Bundle 2 — Conway Pattern 3 audit (2026-05-20)

**Verdict: PASS.** 0 Critical, 0 Warning, 3 cosmetic Recommendations. All 14 seed-signals tests pass.

Bundle adds `recall_coherence_suppression_rate` as the 14th seed signal (`src/lib/s3/seed-signals.ts:275-291`), `enabled=0` disabled-pending, source `Conway-P3`, `coherence_drift` kind, weekly/P2. Plus `cmd_recall_modes()` in `mc-ctl` (read-only, no args, no injection surface).

**Why disabled-pending is faithful, not overclaiming:** `recall_audit` has had no new rows since 2026-05-10 — recall routes through `SqliteMemoryBackend` (HINDSIGHT_ENABLED=false), which never calls `logRecall`. PRE-EXISTING dormancy, not introduced by Spine 6. The seed pattern (enabled=0 + `awaiting:` sentinel + real activation SQL in `notes`) is identical to Spine 2's 10/13 disabled signals — accepted precedent.

**Verified concretely:**
- Activation SQL tested empirically vs real SQLite: with data → scalar; empty table → NULLIF makes whole expr NULL → evaluator returns null → `evalAbsoluteThreshold` returns tripped:false on non-number (tolerance.ts:92-93). No false-trip when enabled-but-dormant.
- `signal_kind`/`source_substrate` are plain TEXT (no CHECK) — `coherence_drift`/`Conway-P3` need no enum extension. Only `cadence`+`alert_priority` have CHECK enums (db/index.ts:494-495); `weekly`/`P2` both valid.
- Count-sweep clean: no stale `13`. Other s3 test files' `length` assertions are local fixtures, not seed totals.

**Recommendations (cosmetic):** R1 cmd_recall_modes shows empty rate cell on dormant DB (recent-row line mitigates); R2 0.08 threshold is 1.97x baseline not "~2x"; R3 established_by inline literal vs const (fine for 1 signal).

**Pattern reinforced:** disabled-pending seed signal + honestly-documented dormancy = legitimate satisfaction of a "ship the cron + measure baseline" done-when, when the data source is genuinely dormant for pre-existing reasons. Don't flag as incomplete; the alternative (faking live alerts) would be dishonest.
