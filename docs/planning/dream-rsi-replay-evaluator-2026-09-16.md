# Dream-RSI × Jarvis — review of Jarvis's plan and the session-ready replacement

**Date:** 2026-09-16 · **Reviewer:** Claude (session 017LjGDj…) · **Reviewed:** Jarvis's Google Doc "Dream-RSI × Jarvis — Plan de Implementación" (2026-09-16 12:30 CDMX) · **Paper:** Dream-RSI: Recursive Self-Improvement through Evolving Worlds (Zheng et al., Google / UMD / DeepMind / UVA, 2026; verified from the PDF, not from the summary).

**Verdict: do not build the plan as written.** Its four phases re-derive a loop Jarvis has run nightly since April (`src/tuning/`, 100 runs, 353 experiments, 2 wins) under a new directory name, and its central deliverable — an offline evaluator that scores a prompt or tool-description change "sin ejecutar el agente" — is not possible for those surfaces. The one transferable idea in the paper (evaluate a policy by *replaying recorded outcomes*, zero new rollouts) applies only to policies whose effect on a recorded turn is computable without the model: Jarvis has two such surfaces, both backed by data that already exists. This document replaces the plan with a gated sequence that starts with a half-day measurement and stops on numbers.

## 1. What the paper actually does (and its precondition)

- An **exploration policy is code** that decides, over a *discovery tree* of attempts, which recorded node to CONTINUE next, how many in parallel, and when to stop. The discovery agent (the coding LLM), the evaluator and the interfaces are **fixed**; "only the exploration-policy code is updated".
- The tree stores, per node, the artifact, diagnostics and a **score**. Replaying a candidate policy = re-traversing the recorded tree and *revealing* stored outcomes; nodes the policy would open that were never recorded stay unrevealed (no outcome, not a zero).
- Replay score (eq. 1) = best quality reached − β₁·(nodes expanded) + β₂·(parallelism). M policy revisions per outer iteration, written by an LLM from the replay trajectories; the next policy is argmax over the M+1 candidates *including the current one*, so selection is never worse than the incumbent on the fixed history.
- Results: Lasso path 317 vs 550 agent calls with better held-out runtime (Gemini-3.1 Pro), 1.79–2.43× fewer generations on KernelBench, up to 50× budget saving vs SimpleTES.

**Precondition:** the thing being improved must be a *deterministic selector over recorded, scored outcomes*. A system prompt, a tool description or a classifier prompt is not: changing it changes what the model would have done, and the recorded tree holds no outcome for that counterfactual. Evaluating it needs new inference — exactly what Dream-RSI avoids.

## 2. Jarvis's plan against the code (verified 2026-09-16, HEAD `0121ad3`)

| Plan claim | Reality |
|---|---|
| "Lo que NO existe: un proceso que genere variantes de comportamiento y las evalúe offline" | Exists: `src/tuning/` (autoresearch-inspired overnight loop; `meta-agent.ts` proposes `scope_rule` / `tool_description` mutations, `eval-runner.ts` scores them, `activation.ts` promotes, `mc-ctl tuning report|promote`). `tune_runs` 100, `tune_experiments` 353 (2 passed / 226 regressed / 125 rejected; 232 scope_rule / 121 tool_description), `tune_variants` 2 (both April 2026). Cost $455 all-time, $156.68 in the 30 d to 09-10, ~$7–8 per night for 5 experiments. 0 wins since 09-08. |
| Fase 2 `policy-proposer.ts`: "LLM genera M=5 variantes" | That is `meta-agent.ts` today (M=5 per night). |
| Fase 3 weekly report + `--apply` behind operator approval | The nightly run already writes a report with the promote line; promotion is `./mc-ctl tuning promote <run>` (operator). |
| Fase 0 new `discovery_tree` table | `task_trace_events` (27,882 rows since 08-17: 8,661 `tool.called`, 1,351 `task.completed` with `termination_reason`, 42 `task.failed`), `task_gates` (368 Honest-Done verdicts), `task_outcomes` (2,105), `scope_telemetry` (3,708; 1,499 in 30 d — message, active groups, tools in scope, tools called, feedback signal) already are the tree. No new table. |
| Fase 1 evaluator "reproduce el eval:gate baseline 67.20 ± 2 sin ejecutar el agente" | Baseline is 67.6 (`src/tuning/eval-baseline.json`), and `tool_selection` cases are scored by calling `infer()` (`eval-runner.ts:206`). Impossible offline for prompt / tool-description diffs (§1). Possible only for deterministic surfaces (§3). |
| "Flywheel corpus (172 casos tool_selection)" | `tune_test_cases`: 103 active — 39 tool_selection, 44 scope_accuracy, 20 classification. |
| `src/lib/task-trace.ts` | Does not exist; it is `src/observability/task-trace.ts`. |
| "5 skills certificadas" | 10 certified (memory `agent-controller`), plus 6 first-party catalog entries. |
| "Prompt bloat — CLAUDE.md 10 KB … evaluar offline qué secciones importan" | CLAUDE.md is the Claude Code operator file, not Jarvis's system prompt; and section impact cannot be measured without inference. Drop. |
| "Scope routing … 216+ clasificaciones del historial" | The semantic classifier (Sonnet) now carries the routing: 170 `Scope groups (semantic)` vs 11 `regex fallback` in the last 7 d. The regex surface the tuner mutates governs ~6 % of live turns (queue 2026-09-12 already flagged this as the tuner's leverage problem). |

Known defects of the existing loop that the plan does not mention, all in `docs/planning/next-sessions-queue.md` §2026-09-12 (Operator decisions / Queued follow-ups): `activateBestVariant()` runs before tool sources register, so `tool_description` wins have **never** applied at boot; the April variant is blocked at boot (no `code_fingerprint`); the eval grades a regex mirror, not the live path; no held-out split (gap 2c); no post-activation observed probe (gap 2b); the loop bills the shared `cost_ledger` windows (W4); proposal to pause `TUNING_ENABLED` or add a win-rate kill gate. Any "dreaming" that produces a win lands on this pipeline; until these are fixed a win changes nothing live ([[feedback_gate_pass_must_have_a_consumer]]).

## 3. Where a replay evaluator genuinely applies

A recorded turn in `scope_telemetry` is a scored node: *message → groups activated → tools placed in scope → tools actually called (+ failed / repaired / feedback)*. Two deterministic policies act on it and can be re-run over the recorded rows with zero inference:

1. **Scope regex fallback** (`CODE_SCOPE_PATTERNS`, the tuner's `scope_rule` surface). Replay: apply candidate patterns to each recorded message → groups → tools in scope. Score per turn = every recorded `tools_called` reachable (hit / miss), minus β₁·|tools in scope| (prompt cost, the paper's cost term). Unrevealed case: a candidate that puts a tool in scope that the recorded turn never had cannot be credited — abstain, count coverage. Leverage ceiling: ~6 % of live turns (the fallback path). Cheap to build, small prize.
2. **Group → tool membership** (`DEFAULT_SCOPE_PATTERNS[*].tools`, the deterministic table that turns the classifier's groups into the tool list every turn pays for). Same replay, applies to **100 %** of turns: minimize tools-in-scope while keeping every recorded `tools_called` reachable. This is the surface where the paper's cost term buys something Jarvis measures already (per-turn prompt tokens). Nobody has proposed it; it is a candidate, not a commitment.

Not replayable (needs inference): tool descriptions, the semantic classifier prompt, the system prompt, skills. The existing paid eval stays the only honest gate for those, and `npm run eval:gate -- --run` before any such change stands.

**The real exploration-policy analog** (heavy orchestrator: replan / retry / batch / stop decisions over goals, scored by `task_gates`) has the paper's shape but not its data: Jarvis records ~one attempt per goal, so a replay would have almost no alternative branches to reveal. A count is the only honest next step (Phase 0c).

## 4. Session plan (gated; each phase ends in numbers, not code)

### Phase 0 — measurement spike (½ day, read-only, no deploy, no inference)
Script `scripts/replay-world-probe.ts` (scratch, not shipped) over `sqlite3 -readonly data/mc.db`:
- 0a. Build the replay world from `scope_telemetry` (all 3,708 rows; 30-d and 90-d slices). Score the **current** `CODE_SCOPE_PATTERNS` and the **April variant** (`tune_variants`, `config_json`) with the §3.1 objective. Report hit-rate, mean tools-in-scope, abstain count.
- 0b. Compare the ranking against the paid eval's 44 `scope_accuracy` cases and the 09-08…09-15 nightly reports. Exit gate: the replay must rank the two known policies the same way the paid eval does, and its hit-rate on turns that later drew `negative` / `rephrase` feedback (4 + 6 + 37 implicit in 30 d) must be lower than on `positive` ones. If not, the world does not model the outcome and the project stops here.
- 0c. Orchestrator tree density: from `task_trace_events` + `task_gates`, count decision points with ≥ 2 scored attempts in 90 d. Below 50 → the orchestrator analog is out of scope (record the number).
- 0d. Membership objective preview (§3.2): tools-in-scope distribution per turn vs tools-called; the maximum saving if membership were minimal. One table.
Deliverable: numbers in this file §6 and one operator decision (§5).

### Phase 1 — replay scorer inside the existing tuner (only on a Phase 0 pass; ~2 days)
- `src/tuning/replay-world.ts` (load + freeze a world from `scope_telemetry`, time-split 80/20 = the held-out split the queue already asks for, gap 2c) and `replay-scorer.ts` (§3.1 objective, β₁ from the observed per-tool description token cost).
- `eval-runner.ts`: `scope_rule` experiments score on the replay world (zero inference); `tool_selection` keeps the paid path. Meta-agent M for `scope_rule` raised from 5 to 20 (the only cost is one proposal call). Selection = argmax including the incumbent (paper §3), scored on the held-out slice.
- Prerequisites folded in the same phase, because a replay win is otherwise decorative: win-rate kill gate (queue proposal), post-activation observed probe (gap 2b, reuse `runEvaluation` + `compareToBaseline`), and one operator decision on `tool_description`: move activation after `sourceManager` or drop the surface (queue "Operator decisions").
- Tests: the world builder on a fixture DB; the scorer's abstain rule mutation-verified (crediting unrevealed tools must turn a test RED); replay-vs-paid ranking pinned on the two known variants. Scoped vitest only; `eval:gate` untouched (no prompt / description change in this phase).
Exit gate: nightly cost for the `scope_rule` half < $1; first replay-selected variant carries a `code_fingerprint`, activates by group merge, and the post-activation probe holds baseline − ε on the live registry.

### Phase 2 — decision, not build
With Phase 0d and Phase 1 numbers: (a) extend the replay objective to group → tool membership (§3.2) as a new tuner surface, or (b) close the thread. Either way one paragraph in `docs/planning/next-sessions-queue.md`.

## 5. Operator decisions this plan needs
1. Approve Phase 0 (read-only, $0). Recommended.
2. `tool_description` surface: fix activation order or drop it (queue 2026-09-12; blocks any tuner win from being real).
3. Whether the tuner stays enabled while Phase 0/1 run (0 wins since 09-08 at ~$8/night; a kill gate is in Phase 1 either way).

## 6. Phase 0 results
_(to be filled by the session that runs it; numbers only, with the reproducing command)_

## 7. Constraints for the session
- `data/mc.db` shell access is READ-ONLY (`sqlite3 -readonly`; mc-guard). The probe script reads through the app's `getDatabase()` or `-readonly`; never `?immutable=1`.
- No live inference in Phase 0. Phase 1 experiments bill `cost_ledger` (`tuning:eval-probe`) — say the amount before running a nightly by hand.
- `npm run eval:gate -- --run` before ANY model-id / system-prompt / tool-description change; scoped vitest; qa-auditor before commit; `./scripts/deploy.sh` is operator-only.
- Surgical: this lands inside `src/tuning/`; no `src/dreaming/`, no new tables, no weekly Telegram loop (the nightly report + `mc-ctl tuning promote` already exist).
- The Google Doc is Jarvis's draft and was left untouched; this file supersedes it.
