# Next-Session Friction Pickup — 2026-05-08 → next session

> ✅ **CLOSED 2026-05-09**. All three items shipped in a single session.
> See `docs/audit/friction-pickup-2026-05-09.md` for the closure record.
> Commits `6c0be55` (#1 + #2) and `edd9778` (#3 — operator-narrowed scope).
> This brief is preserved as a reference artifact for the 4-decision-matrix
> pattern that compressed #3's scope by ~80%.
>
> **Purpose**: After /compact, the next conversation MUST tackle these three unresolved friction items head-on. Distilled from the 2026-05-04 → 2026-05-07 evolution log. The strict-mirror sync work shipped today (`e78d71d`) closed the NorthStar↔COMMIT bricking; these three remain.
>
> **Authored**: 2026-05-08, end of strict-mirror sync session. Priority order is execution-ready — start with #1.

---

## #1 — `jarvis_file_write` scope-loss on short confirmations (4-day pattern, jumps to P1)

**Trigger phrases that fail to activate the writing scope**: "Procede", "Dale", "hazlo", "Tenlo listo para el post 4", and similar short imperatives. Surfaced 2026-05-05, recurred 05-06 and 05-07 without resolution. The next-sessions-queue.md item #13 (Scope architecture rethink) explicitly stated _"if a fourth incident hits, jumps to P1"_ — three documented recurrences across consecutive sessions satisfy that escalation criterion.

**Why this is load-bearing**: every recurrence interrupts a real KB-write workflow mid-task. Operator works around by re-typing the request with a longer phrasing, paying ~30s tax + cognitive context-switch each time.

**Two routes (not mutually exclusive)**:

- **Surface fix (1-2h)**: extend the scope regex(es) for `jarvis_file_write` to admit Spanish-imperative confirmations. Catalog the failed phrases by grepping `journalctl -u mission-control` for the past 14d (`scope.*regex fallback` + write-tool errors). Test against the failure corpus.
- **Architectural fix (1-2 days)**: per `docs/planning/scope-architecture-rethink.md`, this is the 4th incident in the regex-gates-too-tight pattern. Option B (always-on for write tools, discipline at tool-description layer) was already partially shipped 2026-05-07 (`feedback_jarvis_writes_always_on`). Verify whether the always-on promotion landed for `jarvis_file_write` specifically. If yes, the 3-strike is regex-side and surface-fix is sufficient. If no, the architectural fix is the right call.

**Verification**: re-run the captured trigger phrases through the classifier; confirm `jarvis_file_write` in scope. Add 5+ regression cases to scope tests.

**Anchors**: `feedback_jarvis_writes_always_on.md`, `docs/planning/scope-architecture-rethink.md`, next-sessions-queue.md item #13.

### Amendment 2026-05-08 — re-diagnosis required before surface fix

The v7.6 Spine 1 gatekeeper audit (`docs/audit/v7.6-gatekeepers.md`) discovered that the original hypothesis here is **partially wrong**:

- **JARVIS_WRITE_TOOLS is already always-on** (confirmed at `src/messaging/scope.ts:1177-1180`, comment "2026-05-07 promoted to MISC_TOOLS (always-on)"). So the friction class CANNOT be scope-loss for `jarvis_file_write` — the tool is in scope on every message regardless of classifier output.
- **`procede`, `dale`, `hazlo` already match** in both confirmation regexes (`messaging/confirmations.ts:99` and `runners/fast-runner.ts:104`). So the friction class CANNOT be a confirmation regex miss for those specific phrases.

What this leaves as the actual root cause for the 4-day friction class:

1. **LLM didn't gate on `CONFIRMATION_REQUIRED`**: the write tool returned its result directly (skipping the pending-confirmation flow) and the user's "Procede" landed in a normal turn with no pending op to consume it.
2. **No pending was stashed**: the LLM emitted "¿guardo esto?" prose without actually returning the `CONFIRMATION_REQUIRED` sentinel — so `getPendingConfirmation(tk)` returned null and the confirmation path never engaged.
3. **A different write tool**: maybe the friction was about `northstar_create_task` or another write surface, not `jarvis_file_write` specifically. Operator should clarify the failing flow before diagnosis continues.

**Revised first move**: pull the journalctl context for one of the failing incidents (look for the operator typing "Procede" / "Dale" with no follow-through) and trace WHY the pending confirmation flow didn't trigger. Re-frame the surface fix only after the actual gate failure is identified. The Spine 1 F5 fix bundle (shipped 2026-05-08, commit pending) addresses a related-but-distinct producer/consumer drift class — it does NOT fix the friction-pickup #1 incidents.

---

## #2 — `max_turns` involuntary task truncation (new friction class, 3 incidents in 4 days)

**Incidents**:

- 2026-05-04: Fase 3 document write hit `error_max_turns` at 20 turns (re-read-context loop before writing).
- 2026-05-07: Two sessions hit max_turns — Phase 3 DENUE engineering (55 turns) and CRM sub-project restructuring (35 turns). Both tasks left in ambiguous incomplete state.

**Why this is load-bearing**: tasks that hit max_turns terminate without delivering and without a clear failure signal — the operator can't easily tell whether work was completed-but-not-reported, partially-completed, or entirely lost. Reliability concern as task complexity scales.

**Approach-first** (DO NOT start coding until verified):

1. Hypothesis: the limit is being hit because runners re-explore context every turn (no working memory between turns), so a 30-turn task spends 25 turns on bookkeeping and 5 on actual work. Verify by: pull the conversation logs of the three incidents, count tool-call types per turn, confirm whether the "exploration vs work" ratio is what the hypothesis predicts.
2. If confirmed: the fix is at the runner layer — either (a) raise max_turns for specific runner classes (cheap), (b) introduce per-task working memory that survives between turns within a session (medium), or (c) add a checkpoint protocol where the runner periodically writes a partial state so a re-spawn can resume (expensive).
3. If NOT confirmed (i.e. 5/5 turns are real work): the limit is just under-provisioned for current task complexity; raising it is the correct fix.

**Verification**: replay one of the three incidents end-to-end with the chosen fix; confirm completion within budget.

**Anchors**: 2026-05-04 + 2026-05-07 evolution-log entries; classifier/dispatcher in `src/dispatch/`; runner files in `src/runners/`.

---

## #3 — NorthStar compass-reframe operationalization (declared 05-05, never executed)

**Origin**: 2026-05-05 evolution-log — _"Fede explicitly articulated that NorthStar should be a compass, not a backlog — visions are his alone, execution lives in the KB. This is now a permanent operational principle, not just a preference."_

**Status as of 2026-05-08**: declared but never operationalized. NorthStar stayed stale 4+ consecutive days. Today's strict-mirror sync work made COMMIT↔NorthStar reconciliation trustworthy but did NOT change what NorthStar contains — it's still a task list with stale on*hold items. The friction class the log calls out is structural, not infrastructural: the operator wants NorthStar to hold \_intentions*, not _tasks_.

**What "operationalization" means concretely** (to be confirmed with operator):

- Tasks migrate from `NorthStar/tasks/` to KB (e.g. `jarvis_files/projects/<project>/tasks/`). Tools `northstar_create_task` / status updates retire or get re-pointed at the KB.
- NorthStar narrows to visions + goals + objectives. INDEX shows compass state, not work-in-flight.
- Briefings (morning-briefing ritual, etc.) read intentions from NorthStar but execution status from the KB project tree.
- COMMIT app schema implications: keep tasks table on the COMMIT side or also retire? If retired, the strict-mirror sync work needs an exclusion rule for tasks. **Do not skip this question — answer before changing anything.**

**Approach** (do NOT start coding until operator confirms scope):

1. Open with operator: confirm the operationalization spec (the 4 bullets above), specifically the tasks-table-on-COMMIT decision.
2. Inventory current touch points: `grep -rn "NorthStar/tasks\|northstar_tasks\|tasks_table" src/` to find every reader/writer.
3. Stage the migration: KB project structure design → backfill from current NorthStar tasks → rituals and INDEX update → sync rule for tasks → cutover → post-cutover verification.

**Verification**: morning briefing references intentions from NorthStar and execution status from KB; no task-class records appear in NorthStar after cutover; `northstar_sync` skips the tasks table cleanly.

**Anchors**: 2026-05-05 evolution-log entry; `feedback_session_2026_05_07_wrap.md`; today's strict-mirror sync work (`e78d71d`).

---

## Order of attack

1. **#1 first** — fastest payoff (scope-regex surface fix likely 1-2h), highest recurrence count (3 days), and verifies whether 2026-05-07's always-on promotion held.
2. **#2 second** — diagnostic-heavy (approach-first, no coding until hypothesis verified). If the diagnosis points at a config-only fix (raise max_turns for runner X), ship it the same session.
3. **#3 third** — biggest scope, requires operator alignment before any code change. Open with the spec confirmation; do not pre-implement.

**Non-goal for the next session**: don't spawn new feature work. The 15-item next-sessions-queue.md is still the strategic backlog; this brief is friction-pickup that interrupts queue processing until #1–#3 are closed.
