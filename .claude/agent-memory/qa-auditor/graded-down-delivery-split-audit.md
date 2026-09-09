# Grading-vs-execution split + failure-path delivery (task e6f3dfa0) — 2026-07-27

Bundle: `OrchestratorResult.completedWithConcerns` (types/orchestrator/resume) →
heavy-runner promotes to `DONE_WITH_CONCERNS` (both branches + heavy-worker JSON)
· router `handleTaskFailed` else-branch delivers `result.output` text on plain
`failed` · dispatcher `updateTaskStatus` failed-branch persists `output`.
Verdict: **PASS WITH WARNINGS** (0 Crit-hard / 1 Crit-invariant / 4 Warn).

## Promotion condition is sound (verified)

`!reflection.success && total > 0 && completed === total` over `graph.summary()`.
- `GoalStatus.COMPLETED` is set ONLY when `goalResult.ok === true`
  (executor.ts:865-869), so `completed === total` ⟺ zero failed/blocked/pending/
  in_progress. Budget-exhaust / abort / timeout paths all leave goals
  `in_progress` or `pending` (executor marks IN_PROGRESS *before* the
  budget/abort break) → never promoted.
- Replan swaps `graph` wholesale; summary is over the FINAL graph. Early
  `break`s (timeout, replan-throw) leave non-completed goals → not promoted.
- Reachable promotion causes are exactly: (a) reflector best-effort discount
  (`criteriaMet===false`), (b) LLM score in [0.7,0.8) where the >0.3 heuristic
  override doesn't fire (heuristic = completed/total = 1.0), (c) LLM
  `success:false` with a high score. All three genuinely have a deliverable.
- Container branch is fail-safe on an un-rebuilt image: `parsed.completedWithConcerns`
  undefined → `containerPromoted=false` → pre-fix behavior. (`HEAVY_RUNNER_CONTAINERIZED`
  defaults false anyway.)

## DOCTRINE (carry forward)

1. **A promote-to-deliver fix must also promote the CAVEAT.** The runner builds
   `concerns[]` but NOTHING reads `RunnerOutput.concerns` (dispatcher persists
   only `runner_status`; router never renders it). Net effect: the MORE severe
   case (criteria unverified) is delivered as a clean chat answer with no
   warning, while the LESS severe case (plain failed) gets an explicit
   "⚠️ no se completó al 100%". Honesty asymmetry — check the render path, not
   just the status mapping.
2. **A new delivery site inherits the send-path invariant of its neighbours —
   check WHICH sender it uses.** `handleTaskFailed` uses `sendToChannel`, whose
   own docstring says LLM-generated replies MUST use `sendLLMReplyToChannel`
   (v7.7 Phase 2b community write-gate). The 07-11 needs_context branch already
   violated it for 2 rare statuses; this change widened the violation to EVERY
   failed task, including community-manager mailboxes facing the public
   (routeToTask sets pendingReplies for email channels too).
3. **Persisting a previously-NULL column can wake a dormant detector.**
   `tasks.output` on failed rows was always NULL, so canary.ts:119
   (`if (!t.output) continue`) skipped the very case its own docstring says it
   "MOST wants to catch". Writing output activates it live — alert threshold
   (>2 delivery misses/24h) was calibrated against the dead behavior.
   Same class: `classifyConcernReason` now sees failed-task output and its
   status-agnostic markers (`error_max_turns`, tool-scope) can relabel `failed`
   rows from `none` → `max_turns`/`tool_scope_block`.
4. **Deliverable-field extraction can't tell a report from a meta-summary.**
   `extractDeliverableText` FIELD_ORDER ends in `content`, which on heavy/
   nanoclaw is the REFLECTOR meta-summary. On the new failure path an
   all-goals-failed heavy run has `finalAnswer:null` + `content:"Heuristic
   score: 0.00. 0/3 goals completed."` → the operator gets that English metric
   line framed as "esto es lo que alcancé a producir". Guard the failure path
   on a non-`content` field.
5. **Mutation-verified test gap**: deleting `finalSummary.completed ===
   finalSummary.total` (the ONLY clause preventing promotion of a genuinely
   failed graph) keeps orchestrator+heavy-runner+resume suites GREEN — every
   orchestrator.test fixture uses an all-COMPLETED `makeGraph()`. The
   safety-critical clause has zero discriminating coverage.

## Verified-clean (don't re-flag)

- Dispatcher SQL param order `(error, output, taskId)` matches placeholders;
  terminal-status guard intact (test pins it); no path writes `tasks.output`
  before a `failed` update, so no wipe risk.
- Empty-deliverable class holds: `hasDeliverableField` requires a `string`
  field, `extractDeliverableText` requires `trim().length>0` → `{content:""}`
  / `{finalAnswer:null}` still take the generic line (pinned by router.test).
- user-background branch still wins over the new else-branch (order preserved).
- THREAD_RESPONSE_CAP applied to the thread push; telegram adapter chunks via
  `formatForTelegram`, WhatsApp limit ~65k → no message-length break.
- §13/§17 gates read cost_ledger/judgments, NOT `tasks.status` → unaffected by
  the failed→completed_with_concerns shift. Rituals are fast/nanoclaw, so the
  requiredTools-retry interaction with heavy promotion is theoretical.
- Recall side: promoted tasks retain as `outcome:concerns` (kept, −0.05) where
  they used to be `outcome:failed` (dropped) — by design per outcome-bias.
