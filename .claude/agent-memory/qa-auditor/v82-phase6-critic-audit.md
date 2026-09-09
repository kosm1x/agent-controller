---
name: v82-phase6-critic-audit
description: V8.2 Phase 6 §11 CRITIC forced-tool verifier audit (2026-06-03)
metadata:
  type: project
---

# V8.2 Phase 6 — §11 CRITIC audit (2026-06-03)

Verdict: PASS WITH WARNINGS. Files: src/lib/v8-2/critic.ts (+test), cite.ts markClaimsContradicted/countContradictions (+3 tests). Additive+dormant, no producer wires it.

**Why:** Phase 6 extends the S2 forced-tool critic (src/audit/critic.ts) to a tri-state strategic verifier with 4 read-only ground-truth tools, an LLM-authored sql_check, and a 2-loop Self-Refine. The sql_check SQL-execution surface is the highest risk.

**How to apply (re-audit pointers):**
- sql_check write-proof is GENUINE defense-in-depth (verified empirically): readonly better-sqlite3 conn blocks DELETE/UPDATE/INSERT/ATTACH-to-new-file; `.prepare()` rejects multi-statement (`SELECT 1; DROP` throws "more than one statement"); `/^select\b/i` rejects PRAGMA/ATTACH/WITH/comment-prefixed-DELETE at the regex layer. PRAGMA writable_schema=ON does NOT throw on a readonly conn but is rejected by the regex first.
- CONFIRMED whitelist bypass (Warning, bounded): `referencedTables` regex `/\b(?:from|join)\s+...` only captures the FIRST table after FROM — comma-join `FROM tasks, conversations` detects only `tasks`, lets `conversations` (non-whitelisted) be read. Subquery/CTE tables AFTER from/join ARE caught. Residual risk capped by readonly conn = read-only local-table read, capped rows(50)/chars(4000), output only back to critic LLM, NO write/exfil. Not Critical.
- UNTESTED production path: every test injects `queryDb`, so `ownConn=true` branch (open `new Database(path,{readonly:true})` + close in finally) never runs under tests. Pure-function guards are tested; connection lifecycle/fd-leak is not. Warning.
- `.all()` materializes ALL rows before the 50-row slice → a huge whitelisted table can OOM/balloon before the cap. Warning (theoretical; tables are small).
- runFileSha uses readFileSync (whole file into memory) — no size cap. Info; traversal guard (relative+startsWith('..')+isAbsolute) is sound.
- Conservative-error disposition VERIFIED correct: no-tool/throw/timeout → needs_revision+error=true; 2-loop re-authors once then escalates to unfixable. Never silent-approves, never infinite-loops. SDK maxTurns exhaustion → no capture → needs_revision (safe).
- markClaimsContradicted: parameterized IN(...) placeholders (no SQLi), Number.isInteger filter + dedupe, judgment-scoped, idempotent. countContradictions = COUNT(DISTINCT claim_id). 'contradicted' is in the resolver_status CHECK list (db/index.ts:1021). Tests prove rows actually flip (read-back), not just counts. No vacuous assertions.
- Spec drift (NOT a bug — documented deferral): spec §11 lists kb_entries in sql_check whitelist + semantic recall_check; impl swaps to jarvis_files + lexical FTS5 (pgvector semantic DEFERRED). Brief pre-cleared this.
- finalize writes contradictions even on non-error verdict (correct); write failure caught+logged without erasing verdict (correct).
