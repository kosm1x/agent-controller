---
name: v83-phase5-trigger-seam-audit
description: V8.3 Phase 5 trigger.ts — wires dormant decision-ledger into router operator-confirm site (canary jarvis_file_delete)
metadata:
  type: project
---

# V8.3 Phase 5 — decision-ledger trigger seam (2026-07-01): PASS WITH WARNINGS

`src/lib/v8-3/trigger.ts` `executeGatedCapability(tool,args,ctx)` swapped into
router.ts:1657 operator-confirm-accept (was `toolRegistry.execute(tool,{...args,confirmed:true})`).

**Verified holding:** dormant passthrough is byte-for-byte (off-path returns
`toolRegistry.execute(toolName,args)` directly, getDatabase NOT called until after
the guard → zero DB side effect when off). AT-MOST-ONCE holds on both throw paths:
tool-throw is caught inside the execute callback (output set to error json, ok:false);
pipeline-throw happens BEFORE `await execute` (resolve/L0/malformed-max_level all pre-execute)
so output stays undefined → fallback direct execute → runs once; post-execute DB throw →
output already set → outer catch returns `output??""`, no re-exec. No autonomy: jarvis_file_delete
requiresConfirmation:true → getEffectiveRiskTier=high → task-executor.ts:93 gate funnels
INTERACTIVE agent calls back to the confirm site; L1→confirm route, ODD not evaluated (<L3).

**W1 (only warning):** the pipeline-throws degrade branch (trigger.ts:140-152, the outer
catch + line 151 fallback) has ZERO tests. Design intent required at-most-once across BOTH
throw paths; only tool-throw is tested. Repro of the untested branch:
`V83_GATED_CAPABILITIES=northstar_sync` + call for unseeded northstar_sync → runDecisionPipeline
throws "unknown capability" → fallback executes. This is the higher-risk branch (the only one
that could double-exec if the `output===undefined` guard were wrong).

**DOCTRINE — two structural notes worth carrying:**
1. The trigger seam is observability-only and INTENTIONALLY does NOT enforce the pipeline's
   own L0/disabled/malformed structural-refuse contract: a jarvis_file_delete seeded L0 makes
   runDecisionPipeline throw → degrade-to-direct → the delete STILL runs (unlogged). Correct
   here ("never block a confirmed action" — operator already confirmed upstream) but it means
   the pipeline's structural-safety guarantees do NOT extend to this call site.
2. Coverage gap beyond the confirm site: NO second confirm-EXECUTE site in router.ts (line 2439
   is the STORE side). But NON-INTERACTIVE tasks bypass the confirm gate (task-executor.ts:91-93
   "schedule = prior authorization") → a SCHEDULED/ritual jarvis_file_delete executes via
   task-executor.ts:131 directly, UNLOGGED. Prometheus executor.ts:406+ also calls
   toolRegistry.execute directly. The v1 canary ledger captures ONLY operator-confirmed
   interactive deletes, not all executions of the gated capability. Acceptable for audit-only v1.

Minor: armed+tool-throw changes operator error string (armed "Error: <msg>" via parsed.error
vs dormant "Error ejecutando <tool>: <msg>" via router catch) — cosmetic. `confirmed:true`
persists into payload_json — harmless noise (payload not replayed; reversal deferred).
Test gap: no non-throwing `{error:"x"}` return feeds toolReportedError→ok:false→pending path.
