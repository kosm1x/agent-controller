# V9 W1 verify gate: build-versus-adopt decision (2026-10-03)

> Session S3 of the 2026-10-03 plan. Research and design only, no production code. Input to S4 (the build), which is briefed only after Fede approves or changes the option below.
>
> Read with: `docs/planning/v9-capability-1-spec.md` (the June spec, "the spec"), `docs/planning/v8.4-honest-done-spec.md` (the ledger), `docs/planning/landscape-review-2026-10.md` items a1–a5 (Managed Agents "outcomes"). All line numbers are against `main` at `8303352`.

## Recommendation in one paragraph

**Option B: run a capable-tier grader as one more gate inside the V8.4 completion ledger**, not a separate `verifier.ts` phase inside Prometheus. The deciding fact: since the spec was written in June, the place where a task becomes "done" moved. It is now `applyCompletionLedger`, called from exactly one spot (`src/dispatch/dispatcher.ts:1078`) for every runner. A verify phase inside `orchestrate()` would be a second "done" decision that the ledger and `heavy-runner` can override afterwards (CLAUDE.md invariant: route every completion through `applyCompletionLedger`, never a second decision). The V8.4 spec already names W1 as the consumer of the gates it cannot run (`v8.4-honest-done-spec.md` §12: manual gates stay `unverified` "until V9 W1's capable-tier `criteria_check` consumes them"). Option B keeps the spec's hard constraints (capable tier, external grounding, gate not score, bounded, dormant behind a flag) and borrows the outcomes design (separate-context grader, per-criterion rubric, explicit budget-exhausted and interrupted results). Option C is ruled out by D4.

## 1. Phase 0 reconciliation (spec §2/§5 against current code)

| Spec claim | Code now | Verdict |
| --- | --- | --- |
| `Phase` = PLAN/EXECUTE/REFLECT, `types.ts:18-23` | `src/prometheus/types.ts:20-25`, same three values | holds (lines moved) |
| `selfAssess` defaults `met=true` on judge failure (`types.ts:99-108`) | comment `types.ts:100-110`; catch returns `met:true` `executor.ts:253-264`; **a second fail-open**: the shape guard sets `met=true` when `raw.met` is not a boolean (`executor.ts:248`) | holds, and worse than the spec says |
| Goal completion at `executor.ts:859-863`, the only path to COMPLETED | `executor.ts:894-907`, now three-way (unfinished goals stay IN_PROGRESS). Not the only path: `planner.ts:350` (replan carry-over), `resume-loader.ts:207`, swarm's own graph `swarm-runner.ts:453,461` | drifted |
| `reflect()` at `orchestrator.ts:415`; delivered `success` at `:484-485` | `reflect()` `orchestrator.ts:490-496`; `success: reflection.success` at `:584`, plus a new `completedWithConcerns` (`:565-573`) | drifted |
| Insertion point before REFLECT | before `emitProgress(...REFLECT...)` at `orchestrator.ts:487`; a veto would also have to suppress `completedWithConcerns`, because `heavy-runner.ts:100,112` promotes `!success && completedWithConcerns` back to a delivered DONE_WITH_CONCERNS | holds, but the veto leaks |
| `heavy-runner.ts:54-86` is the only reader of `result.success` | `heavy-runner.ts:74-157`. Every runner maps its own status (`fast-runner.ts:2592`, `nanoclaw-runner.ts:255`, `swarm-runner.ts:~1033`, `a2a-runner.ts:94`); **the final status is decided in `dispatcher.ts`**: map `:960-969` → `applyCompletionLedger` `:1078` (can demote `completed` → `completed_with_concerns`) → `updateTaskStatus` `:1090` | drifted: the seam is the dispatcher |
| `resolveUseOpus(true)` routes to the capable tier | `model-tier.ts:105-108` holds, but `queryClaudeSdkComplexWithFallback` **silently retries on Sonnet on any non-abort Opus error** (`claude-sdk.ts:555-561`; `OPUS_MODEL_ID = "claude-opus-4-8"` `:473`) | holds with a hole: "always capable" is not guaranteed |
| Reuse V8.2 `critic.ts` and its four check tools | `src/lib/v8-2/critic.ts` exists, tri-state, loop 2, tool budget 5. Only the pure `run*` functions are exported (`runReadOnlySelect :231`, `runCostCheck :288`, `runRecallCheck :419`, `runFileSha :457`); the SDK tool wrappers are not. Critic defaults to **Sonnet** (`:646`) and its prompt and SQL whitelist target judgments, not execution output | partly reusable |
| `GoalResult` carries `provenanceRecords`, `toolNames`, `criteriaMet` | yes, `types.ts:88-121`; plus the V8.4 per-task tool-evidence corpus (`numbers.ts:45,62`), which is **consume-once**: the consumer takes it at `consumer.ts:180` | holds; a second source exists |
| `build_check`/`test_run` run in the runner sandbox | no generic "run a command, return exit code and output" helper over `spawnSandbox` (`sandbox-backend.ts:36`; callers only run worker entrypoints). The only runnable-check executor, `runShellCheck` (`gate-check.ts:121-160`), runs on the **host**, and V8.4 skips host shell gates for container runs because they would be a manufactured green (`consumer.ts:70-76`) | gone: needs new work |
| Swarm covered by a Prometheus verify phase | no: swarm runs its own `reflect()` (`swarm-runner.ts:1001`) | gap |
| Name `verifier` free | free in `src/prometheus/`, but V8.4 already uses "verifier" for read-backs (`readback-verifiers.ts`) | use "grader" |

## 2. What V8.4 already enforces, mapped onto the spec's `checks[]`

| Spec `kind` | V8.4 today | Covered? |
| --- | --- | --- |
| `criteria` (capable-tier judgment) | Nothing in the ledger: `manual` gates are never flipped (`gate-check.ts:377`) and read as `unverified`. Prometheus prose criteria never reach the ledger at all: `splitCriteria` sends only object-form criteria with a `check` to gates (`planner.ts:137-161`); prose is graded only by in-loop `selfAssess` (same tier as the goal, fails open) | **No. This is W1's real gap.** |
| `tool_evidence` | numbers audit against the tool-evidence corpus (`consumer.ts:180-237`), write-time provenance refusal (`provenance-gate.ts:187`), citation existence check | partly: per-figure, not per-criterion |
| `build` / `test` | a plan or submission may declare a shell check (`tsc`, scoped vitest) with a settleable `expect`; skipped for container runs | partly: only when declared, host only |
| `sql` | a shell check running a read-only query (`mc-ctl db`) | partly |
| "I changed X" / write landed | read-back gates for write tools (`readback.ts:138`), landing probe for branches/PRs/commits (`landing.ts`) | **yes, beyond the spec** |
| Verdicts verified / needs_revision / unverifiable | `met` / `failed` / `unverified` (+ `abandoned` = visible surrender) (`gates.ts:479-531`); `met` requires evidence (`:451`) | yes, same semantics |
| In-loop "not done, keep going" | Stop hook re-evaluates the ledger and blocks on FAILED runnable gates, `MAX_HOOK_BLOCKS=3` / total 6 (`stop-hook.ts:38-40`), claude-sdk path only, armed in prod since 2026-09-18 | yes, for runnable gates |
| Modes, traces, readout | `TASK_GATES_MODE` off/shadow/enforce (enforce armed 2026-08-27); `gates.*` trace events; `mc-ctl gates summary` | yes |

**Duplication if W1 were built as specified:** its own verdict type, shadow/enforce switch, evidence rule, trace events, status demotion, operator readout and status line. All of these exist in V8.4. What W1 adds that V8.4 lacks is one thing: a **capable-tier judge for criteria no command can check**, in a context separate from the executor.

### Outcomes states (from S2, a2/a4)

Managed Agents outcomes return `satisfied`, `needs_revision`, `max_iterations_reached`, `failed` (rubric does not apply) and `interrupted`. The ledger has no gate-level equivalents for the last three:

- **Budget exhausted.** `EvaluateResult.budgetExhausted` (`gate-check.ts:316,378-381`) only counts gates skipped when the ledger's own 120 s ran out; they stay pending. Task-level exits (`max_rounds`, `token_budget`, `timeout`, `aborted`, `src/runners/termination.ts:19-55`) live on the task trace, and Prometheus abandons the gates of unfinished goals with the exit reason (`orchestrator.ts:432-449`).
- **Needed:** no new `state` value. The `CHECK` constraint on `task_gates.state` would need a table rebuild, and that table is not in `SCHEMA_MIGRATIONS`. Instead: grader not reached because the task ran out of budget, or the grader ran out of its own budget → row stays `pending` (reads `unverified`, never `failed`) with the reason in `evidence`; task interrupted → `abandoned` with `abandon_reason: interrupted — <termination reason>`. Both are named in the `gates.graded` trace (below) so the readout can count them. Rubric does not apply (`failed` upstream) → `pending`/`unverified` with the reason.
- **Iteration counter (a4):** the grader trace event carries `iteration` (always 1 in v1; see §5 Phase 6).

## 3. The three options

- **A. Build `verifier.ts` per the spec**: `Phase.VERIFY` in `orchestrate()` before REFLECT, its own `VerificationResult`, veto over `success`, one bounded replan.
- **B. Ledger grader gate**: the grader runs inside `applyCompletionLedger` as one more gate kind. Criteria nobody can check with a command become grade gates; the grader writes `met` / `failed` / `pending` / `abandoned` with cited evidence, and the existing ledger semantics decide the status.
- **C. External outcomes-style grader**: call a hosted grader such as Managed Agents outcomes.

| Criterion | A. Build per spec | B. Ledger grader gate | C. External grader |
| --- | --- | --- | --- |
| Where "done" is decided | a second decision in `orchestrate()`; heavy-runner can promote it back (`heavy-runner.ts:100`) and the ledger can demote it after | the existing single seam (`dispatcher.ts:1078`) | outside the process; result must still be fed to the ledger |
| Coverage | Prometheus only (heavy). Not swarm parents, not fast, not nanoclaw | every runner whose task has gradeable criteria (heavy, swarm, rituals, API submissions) | depends on what is sent |
| Grounding | spec's tools; build/test need a sandbox helper that does not exist | same grader tools; reads the tool-evidence corpus and `provenanceRecords` the consumer already holds; build/test stay with shell gates | grader sees only what is uploaded; no access to `mc.db`, the tree or tool evidence |
| Cost | one capable-tier pass per complex task, plus a replan | one capable-tier call per task with gradeable criteria (all criteria scored in one call, each independently); no replan in v1 | per-session hosted pricing plus duplicated context |
| Data location (D4) | VPS | VPS (inference calls go to the same API Jarvis already uses) | **task data leaves the VPS into a hosted session: ruled out by D4** |
| Failure modes | veto leaks through `completedWithConcerns`; silent Sonnet fallback; duplicated shadow/enforce logic can drift from the ledger | Opus fallback (same hole, fixed below); grader latency inside the 120 s ledger budget; per-Stop billing if the Stop hook re-runs the grader (fixed below) | vendor outage, schema changes, beta API |
| Reversibility | new phase in the orchestrator loop; off by flag, but more surface to remove | one flag; off ⇒ no rows declared, no calls, byte-identical | easy to remove, but nothing to keep |
| Fit with invariants | conflicts with "no second done decision" | uses `applyCompletionLedger`, `isLedgerLine`, evidence-required `met`, visible surrender | n/a |
| Size | spec says 4–5 days, before the drift above | smaller: types, declaration, grader, a consumer branch, a readout | n/a |

**Verdict: B.** A is the right idea in the wrong place: the code moved under it. C is excluded by D4, and its design is what B borrows.

## 4. Design of option B (what S4 builds)

1. **What gets graded.** A criterion becomes a grade gate when no command can check it: (a) Prometheus prose criteria, which today are dropped before the ledger (`planner.ts:137-161`); (b) `manual` gates from submissions and rituals. Read-back, landing and shell gates are untouched. Tasks in the `SIMPLE_PATTERNS` class skip grading (spec §4 item 5). Fast-runner chat turns are out of scope for v1.
2. **Storage.** Reuse the read-back trick (`readback.ts:37-40`): a harness-sourced `manual` row whose `check_cmd` starts with `grade:`, a reserved id prefix (`GR-`, guarded like `RB-` at `gates.ts:346-351`), and `declareGates` taught to keep that prefix (`gates.ts:371-377`). No schema change. The model cannot write or ABANDON a `GR-` row (same exclusion as read-backs, `gate-check.ts:353-356`).
3. **The grader.** One call per task, in a **fresh context**: it gets the task description, the criteria, the deliverable, and a digest of tool evidence and `provenanceRecords`, and never the executor's transcript (outcomes a1). It must return a verdict per criterion through a forced submit tool, each with cited evidence; a missing or malformed verdict is `pending`, **never** `met` (the opposite of `selfAssess`). Read-only grounding tools: `sql_check` and `file_sha` built over the exported `run*` functions in `critic.ts`, with an execution-oriented prompt; tool budget 5.
4. **Capable tier, no silent downgrade.** The grader calls `OPUS_MODEL_ID` with **no fallback**. If Opus fails, the rows stay `pending` with `evidence: grader unavailable — <error>`; the trace records the model that actually answered. `PROMETHEUS_ECONOMY_MODEL` does not apply.
5. **Budget and placement.** The grader runs after `evaluateLedger` in the consumer, with its own wall-clock budget (`TASK_GATES_GRADER_BUDGET_MS`, default 90 s), not inside the shared 120 s ledger budget. It reads the tool-evidence corpus before the consumer's `takeToolEvidence` drops it. The Stop hook skips `GR-` rows (otherwise every Stop pays for a grader call).
6. **Modes.** `TASK_GATES_GRADER` = `off` (default) / `shadow` / `enforce`, separate from `TASK_GATES_MODE`, which is already `enforce` in production.
   - `off`: nothing declared, no call; byte-identical to today (test required).
   - `shadow`: grade specs are kept in `tasks.output.grader`, **not** declared as rows (a declared row would appear in the `Gates:` line and change the deliverable under the live enforce mode); verdicts go to the trace `gates.graded` `{task_id, iteration, model, criteria: [{id, verdict, evidence}], latency_ms, usage, reason?}` and to `cost_ledger`.
   - `enforce`: rows are declared and written; the existing ledger rules apply (`failed` demotes `completed` → `completed_with_concerns` and the `Gates:` line names the unmet criterion; `pending` reads `unverified`). Nothing is ever promoted.
7. **Retry (spec §4 item 4, the bounded replan).** Not in v1. The ledger demotes; it does not loop. A later phase may let Prometheus spend one replan on a `failed` grade (Phase 6 below) if shadow data shows that retries would have fixed real misses.
8. **Same-model question.** The spec forbids same-model self-checks. Prometheus executors mostly run on Opus too (`resolveUseOpus` defaults to Opus), so the grader is often the same weights as the executor. What B guarantees is the part the evidence supports: a separate context with no executor reasoning, the capable tier, and tool grounding. Calling a different model family is not available on this stack. **This is an interpretation Fede should confirm** (see the question at the end).

## 5. Revised phase list (replaces spec §11)

| Phase | Work | Gate |
| --- | --- | --- |
| 0 | Spec amendments recorded here; types for grade specs and `gates.graded` | typecheck |
| 1 | Grader core: prompt, forced per-criterion submit tool, evidence digest, Opus no-fallback call, malformed ⇒ `pending` | unit tests: verdict matrix, malformed output, Opus failure ⇒ pending, no fallback |
| 2 | Declaration: prose criteria and manual gates → grade specs; `GR-` prefix, model-ABANDON exclusion, `declareGates` keeps `grade:` | tests: prefix guard, ABANDON refused, SIMPLE skip |
| 3 | Consumer wiring behind `TASK_GATES_GRADER`; own budget; Stop hook skips `GR-`; `gates.graded` trace; ledger line through `isLedgerLine` | tests: flag off byte-identical (prompt, output, status); shadow never changes status or text; enforce demotes a **seeded false-complete**; outcomes-state mapping |
| 4 | Readout: `mc-ctl gates graded [days]` (per-criterion verdicts, model, latency, cost, disagreement list for labelling) | read-only |
| 5 | Ship dormant; Fede deploys and arms shadow; measure (§6) | shadow data |
| 6 | Only if shadow justifies it: one bounded Prometheus replan on a `failed` grade, `iteration` > 1 | separate brief |
| deferred | `build_check`/`test_run` in the sandbox (needs a command-runner over `spawnSandbox`) | trigger: shadow shows misses that only a build/test would catch |

Every phase: implementer subagent → `npm run typecheck` + scoped vitest → separate qa-auditor. Deploy and arming are Fede's.

## 6. Shadow measurement plan and the false-positive budget

**Population.** Tasks with at least one gradeable criterion, not `SIMPLE_PATTERNS`, completed under `TASK_GATES_GRADER=shadow`. How many such tasks arrive per week is **unverified** (needs VPS data: `mc-ctl db` count of Prometheus tasks and manual gates over 30 days). That count sets how long shadow runs.

**Recorded per task.** Grader verdict per criterion, evidence, model used, latency, tokens and cost; next to the existing signals: ledger verdict, `selfAssess` `criteriaMet`, `reflection.success`, final status.

**Labels.** Fede labels each graded task "really done" or "not done" from the `mc-ctl gates graded` disagreement list: every task the grader flagged `failed`, plus a random fifth of the rest (so misses the grader passed are also seen).

**Definitions.**
- *False positive*: a task Fede labels really done that the grader flagged `failed`. **FP rate = false positives ÷ tasks labelled really done.** Budget: **≤ 10%** (spec §12).
- *Catch*: a task the existing signals delivered as `completed` that Fede labels not done and the grader flagged `failed` with evidence Fede accepts.
- *Unverifiable rate*: share of criteria left `pending`. Not a pass or fail; a high rate means vague criteria (feeds the rubric-from-example idea, landscape a5, S5).

**Activation (shadow → enforce).** All of:
1. at least 30 tasks labelled really done, with at most 2 false positives (≤ 6.7% observed). Honest limit: one operator's sample cannot prove 10% tightly. Only 0/30 puts the 95% upper bound at 10% (rule of three); 2/30 leaves it near 22%. The observed rate is the gate, and the count keeps running in enforce so a drift above 10% shows up;
2. at least one confirmed catch (the spec's "catch rate positive on a ≥20-task sample" is kept as the minimum graded sample);
3. median added latency and cost per graded task reported from `cost_ledger` and the trace, and accepted by Fede. Cost is reported against the daily soft cap, which never blocks a dispatch (budget invariant).

Before any aggregate is quoted, run `mc-ctl audit-claim`. If the FP budget is missed, fix the grader prompt or the criterion selection and restart the count; do not lower the bar.

## 7. Spec amendments (for S4, not applied to the June spec)

- §1: add the second `selfAssess` fail-open (`executor.ts:248`). Fixing `selfAssess` itself is out of scope here.
- §4 item 3 and §9: the veto lives in the ledger, not in `orchestrate()`; `success` is never touched.
- §6: no `VerificationResult`; grade gates are `task_gates` rows plus the `gates.graded` trace.
- §8: `criteria_check` and `tool_evidence_check` become the grader's per-criterion judgment over the evidence digest; `sql_check`/`file_sha` via exported `run*`; `build_check`/`test_run` deferred.
- §10: capable tier means Opus with no fallback; a failed Opus call leaves criteria unverified.
- §11: replaced by §5 above. §12: replaced by §6 above.
- §13: Q1 answered (trace only). Q3: V8.2-internal tasks are not graded (their critic is the gate). Q4: deliver with the verdict (no replan in v1). Q6: keep `selfAssess` in the loop; the grader is the task-level gate.

## Question for Fede

Approve **option B** as designed above, or change it. Points where your answer changes S4:
1. **Option:** B (recommended) or A.
2. **Same model:** is a fresh-context Opus grader with tool grounding acceptable when the executor was also Opus (§4 item 8)? Recommended: yes.
3. **Retry:** demote only in v1, replan later only if shadow data justifies it (recommended), or build the one bounded replan now.
