---
name: northstar-sync strict-mirror audit (2026-05-08)
description: NorthStar Phase 4 strict-mirror upgrade audit — bootstrap+phase-4 destructive interaction, kind-arg drift on populateCommitIdInFile, listFiles missing fields, POST-fail data loss
type: feedback
---

# NorthStar Sync Strict-Mirror Audit (2026-05-08)

VERDICT: FAIL.

## Critical findings

**C1: bootstrap+Phase 4 destructive interaction** — Phase 4 (post-sync mirror verification at northstar-sync.ts:1208-1292) runs unconditionally. The bootstrap branch in syncKind preserves local files with stale/foreign COMMIT_IDs (line 793: `report.skippedPaths.push(local.path)`). Phase 4 then deletes them. The INDEX.md footer line 1347 stamps `Mode: bootstrap (no deletes)` — header lies. Tests escape bootstrap by seeding unrelated journal rows; no test exercises bootstrap+Phase-4 path.

**C2: POST-fail unconditional `deleteFile`** at northstar-sync.ts:1146-1160 — strict-mirror licenses removing unsyncable records, but every transient 4xx/5xx (Caddy 502, key rotation, schema drift on COMMIT) deletes the operator's local content with no Quarantine fallback. Operator deferred per Q10.

**C3: `populateCommitIdInFile` Phase-1-success path missing `kind` arg** at line 1164 — `populateCommitIdInFile(entry.path, entry.title, entry.content, newId)` vs self-heal path at 1097 which passes `kind`. Tags drift to `["northstar"]` instead of `["northstar", kind]`. Comment at 659-660 explicitly warns against this drift.

**C4: Phase 0 clobbers `condition` and `related_to`** at lines 1041-1051 — `upsertFile(..., null, [], ...)` because `listFiles` (jarvis-fs.ts:317-377) doesn't return condition or related_to. Phase 0 should read full file via `getFile()` already done at 1037 and pass through the existing values.

## Why: lessons for future audits

- **Strict-mirror invariants must gate on bootstrap mode** — every "destructive cleanup" pass should check whether the journal was empty pre-sync, otherwise the first run on existing data deletes user content.
- **Quote-the-line discipline saved this audit** — line 1164 missing `kind` arg vs line 1097 having it, line 1048 hardcoding `null, []`. Both are confirmable findings, not speculation.
- **Bootstrap+strict-mirror is a known anti-pattern** — the operator's strict-mirror contract conflicts with the "no destructive ops on first run" safety net. Resolution required explicit operator sign-off, not silent code reconciliation.

## How to apply

When auditing destructive sync/mirror tooling:

1. Look for unconditional destructive phases. Cross-check with documented invariants ("no deletes on bootstrap", "preserve drafts", etc.) — flag any drift.
2. Verify EVERY tested destructive path also has the inverse non-destructive test. If "Phase X drops orphan when journal exists" exists, "Phase X preserves orphan on bootstrap" must also exist.
3. Walk the FULL POST-fail surface. 4xx is a different failure mode from network throw is a different failure mode from gateway-killed-response-after-PG-commit. Each can lead to silent data loss in different ways.
4. Check helper-function arg consistency. Self-heal vs success vs error paths in the same function should pass the same args; missing args silently change behavior.
5. Check `listFiles` projections vs `upsertFile` arg lists. SQLite projections that drop columns lead to "blanket null" overwrites when the result is round-tripped.
