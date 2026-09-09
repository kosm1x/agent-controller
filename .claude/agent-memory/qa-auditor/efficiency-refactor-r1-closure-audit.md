# Efficiency-refactor bundle R1 closure audit (2026-07-05)

Commits 19664cb (Phases 1-4: dead-code purge, shared infra, hot-path memo,
structural splits) + 89784d2 (converge failure shapes to {error} JSON +
defineTool + errMsg sweep). ~220 files, net −4,700 LOC. 6 agents + operator in
parallel waves. R1 = cross-agent INTEGRATION defects (per-piece gates green).
VERDICT: PASS WITH WARNINGS. tsc --noEmit exit 0; 0 TODO/FIXME introduced;
582 scoped tests green (router 56, task-exec 72, scope 356, adapter 70,
claude-sdk 52, registry 25, retention 8) + agents ran 70 converged-tool + 104
tuning green.

## Two warnings — BOTH in retention.ts (the one genuinely-new subsystem), both LATENT on current data
### W1 (CONFIRMED, latent): batched tasks-delete violates the self-referential parent FK
`tasks.parent_task_id REFERENCES tasks(task_id)` is NO ACTION + `foreign_keys=ON`
(index.ts:41). retention.ts fixpoint (106-124) guarantees a parent is deletable
only if its WHOLE subtree is deletable — logical completeness — but the delete
runs in 500-row BATCHES, each its OWN transaction (155-175). If a parent lands
in batch N and its child in batch N+1, batch N's `DELETE FROM tasks` removes the
parent while the child still references it → immediate FK check at STATEMENT
CONCLUSION fires "FOREIGN KEY constraint failed (19)". EMPIRICALLY CONFIRMED with
the exact schema in sqlite3. Same hazard for `a2a_contexts.task_id` (NO ACTION FK,
NOT deleted by retention). Currently UNFIREABLE: live mc.db has 0 candidate
PARENTS among 1586 terminal >90d candidates, and 0 a2a_contexts rows. Fires once
a multi-child parent subtree >500 rows ages out. Not data-loss (archive written
for ALL ids at :148 BEFORE any delete; per-batch tx rolls back atomically) and
caught by runRetentionTick (:67 → logs "contract violation", never crashes) — but
the subtree stays un-prunable + nightly error. Comment :13-18 OVER-CLAIMS
FK-safety (addresses runs FK + logical orphaning, NOT batch ordering of the
self-FK). Fix: delete tasks leaf-first (child batches before parent) OR single tx
OR temporarily disable FK for the sweep; also delete/handle a2a_contexts.
DOCTRINE: a fixpoint/subtree guard proves LOGICAL referential completeness but
NOT the DELETE ORDER — with an immediate self-FK (foreign_keys=ON, NO ACTION),
batching splits a subtree across statements and the parent-batch delete violates
mid-sweep. Always check: does the batch boundary cut a parent from its child?

### W2 (low): data/archive grows unbounded
retention.ts:128-149 writes data/archive/tasks-retention-*.jsonl.gz every sweep
w/ deletions; NOTHING prunes/rotates it (grep-confirmed no cleaner). Feature's
whole point was to bound growth yet it spawns a new monotonic artifact under
data/ (also swept into nightly offsite backups). Small (gzipped) → low urgency.
Fix: prune archives older than ~365d or cap count.

## Info / cosmetic (not bugs)
- router.ts:1994 STALE comment "feedbackTaskId captured at line 592" — now
  captured at :1758 (recordFeedbackWindowSignal); doc-rot from the handleInbound
  895→34 split. Harmless.
- Partial errMsg sweep: raw-fetch catches keep inline ternary (wordpress.ts:855,
  gemini-research.ts:293/320/463); heavy-runner.ts:124 + nanoclaw-runner.ts:51
  keep a LOCAL `const errMsg` inline var (NOT shared-helper calls, no shadow bug).
  Functionally identical; cosmetic.
- WP tools' wpFetch network/timeout throw escapes uncaught out of execute()
  (registry.execute RE-THROWS at registry.ts:202). PRE-EXISTING (old local
  wpFetch used try/FINALLY, no catch — same throw). NOT a bundle regression.
- gemini-image.ts + wordpress-admin.ts have NO colocated test file → P2a
  fetchJson/HttpStatusError error-text paths untested (silent drift risk).

## Seams verified SOUND (the reason this is PASS)
- #1 SHAPE×CALLER: task-executor.ts:141-155 3-leg detection matches ACTUAL
  producers EXACTLY. Grep-confirmed: NO builtin returns "Error:" strings; the
  `success===false` leg is produced ONLY by jarvis-files batch (`success:
  errors===0` @915/1062) + gemini-research (`success: finalState==="ACTIVE"`
  @447) — verbatim the code comment's claim. All 6 converged files return valid
  JSON.stringify({error}); every fetchJson site inside try/catch.
- #2 ROUTER: handleInbound (2198-2231) → 13 interceptors clean. USER day-logged
  ONCE @2202; JARVIS once per terminal path (old double-USER-log FIXED — confirm/
  decline paths only log JARVIS w/ "USER already logged" comments @1726/1738).
  checkFeedbackWindow consumed ONCE @1758, threaded to submitInboundTask. errText
  rename (@1730) clean.
- #3 ADAPTER SPLIT: adapter.ts re-exports every external importer's symbol
  (agent line-checked each re-export target actually-exported); errMsg→errText
  rename consistent (errText declared @1452, used @1455/1473 same scope).
- #4 DB GATE: all 27 ALTER + 7 table_info probes inside `if (schemaVersion<1)`
  gates (63/99/148/202/284/589/916). SCHEMA_MIGRATIONS v1 = no-op MARKER that
  stamps user_version=1 so v0 blocks skip next boot (the "what stamps v1"
  question — answered). v2 DROP baseline_history is `IF EXISTS` + post-init.
  baseline_history survives only in comments (s3/registry.ts:9-10, index.ts).
- #5 RETENTION fixpoint vs orphans: correct. Orphan edge (child→missing parent)
  is a no-op in the fixpoint (deletable.has(missingParent)=false). 0 orphans
  live. runs-before-tasks order FK-safe WITHIN a batch. Counts RETURNED from the
  retry callback (honors feedback_accumulator_outside_retry doctrine explicitly).
- #6 SCOPE: SKILL_DISPATCH_TOOLS in the universe Set (scope.ts:1591).
  getAllAvailableTools returns cached Set BY REFERENCE (:1555) but sole prod
  caller router.ts:496 reads `.size` inline (no bind/mutate); no test mutates.
- #7 TUNING SHELVE: 0 dangling refs to the 5 deleted modules; all TUNING_*
  dead flags removed (only TUNING_ENABLED/COOLDOWN_HOURS/SAFETY_KEYWORDS read);
  meta-agent (core mutation proposer) intact + called @overnight-loop.ts:383.
