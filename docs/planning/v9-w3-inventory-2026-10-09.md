# V9 W3 step 1: inventory of the data an internal eval can stand on

Date 2026-10-09 (UTC). Read-only survey for the ROADMAP bet "W3 internal eval, reshaped". It feeds `docs/V9-ROADMAP.md` §4 W3 + §7 and `docs/V8-VISION.md` §7.
Method: `sqlite3 -readonly` aggregates over `data/mc.db` (counts, dates, enums, numeric aggregates only); `ls`/`find` sizes and mtimes for KB corpora. No row content and no KB file content was read. Every predicate ran as COUNT + MIN/MAX first. Numbers are raw SQL taken at about 21:40 UTC. They have **not** been through `mc-ctl audit-claim` because this survey was not allowed to run `mc-ctl`. Window edges are ±1 day: ISO and `datetime()` timestamps were compared as strings.

## 1. Verdict in 10 lines

1. **Time horizon: yes, but censored.** There are 3,918 terminal tasks since 2026-06-28. Retention keeps 90 days of `tasks`/`runs`; older rows sit in `data/archive/` gz. Every finished task ran ≤ 15.9 min of wall-clock, because the runner timeouts set the ceiling. No human-time axis exists. The size proxies are tool-call count (all runners), plan goal count (heavy/swarm only, 1–7) and cost.
2. **Policy adherence: thin, and the violation side has no population.** The data has 23 `tool.gated` traces, 23 `tool_approvals` rows (15 confirmed, 2 expired, 6 superseded) and 257 V8.3 decisions. All 257 decisions are `committed`, with 0 reverted, 0 vetoed and 0 operator overrides.
3. **Process quality: yes.** `task_gates` holds 1,129 rows over 826 tasks since 08-16, with a weekly met/failed/abandoned trend. There are 1,839 `numbers.audited` traces in 30 d and 18 W1 `gates.graded` traces. The label ledger holds 18 rows: 17 really done, 1 catch, 1 FP. Gate definitions changed mid-series (W38 jump), so the trend needs a definition-version column.
4. **§7 Q2 (delegated vs explicit direction): the split is fully separable.** In the last 30 d there are 1,386 operator-chat tasks and 403 delegated ones. The success signals are **asymmetric**: `task_outcomes` exists only for operator chat (2,674 of 2,674 rows). The V8.3 cost of errors is **no population**: 0 reverted, 0 vetoed.
5. **§7 Q1 (amplify vs execute) and Q3 (bilateral learning): no population in mc.db.** No row links a judgment or decision to an outcome. 1 of 298 judgments has a `concession_kind`. Project advancement lives in the day-logs, which are the only work record by CLAUDE.md, and reading them needs a content ruling.
6. **§7 Q4 (sustainability): yes.** `schedule_runs` has 855 rows (838 completed, 9 delivery_miss, 3 failed), `trigger_runs` has 1,281 and ritual gates have 39.
7. `logs/decisions/` (8 files, 11.7 KB, last mtime 09-19) cannot carry a task corpus. The V8.3 record is the db `decisions` table.
8. `tune_eval_results` has **0 rows**. Per-case eval data lives in `tune_experiments` (358) and `data/predeploy/` files.
9. A smallest harness can run tonight on existing rows: a read-only weekly report per side (operator vs delegated) × agent_type over 90 d. It would show finished rate, ledger all-met rate, `numbers.audited` unverified rate, wall-clock p50/p90, tool-call p50/p90 and cost per finished task.
10. It has no LLM calls and no writes, and it is honest only if it prints the timeout ceiling and the signal asymmetry next to every number.

## 2. Source table

Rows: all / 90 d / 30 d. "Op/deleg" = whether operator-directed and delegated tasks can be separated.

| Source | Rows all / 90 / 30 | Date range | Success signal | Op/deleg separable | Caveat |
| --- | --- | --- | --- | --- | --- |
| `tasks` | 3,969 / 3,942 / 1,796 | 06-28 → 10-09 | yes: `status` (completed / completed_with_concerns / failed / blocked) | yes: `metadata.tags` (`messaging`), `metadata.ritualId`, `spawn_type`, `schedule_runs.task_id` | 90-d retention (`TASKS_RETENTION_DAYS`), archives in `data/archive/`; status alone barely varies (44 failed all-time) |
| `runs` | 3,969 / 3,942 / 1,796 | 06-28 → 10-09 | `status`, `duration_ms` | via `task_id` | `tool_calls` JSON array (avg 89 B) = size proxy; `goal_graph.goals` heavy/swarm only |
| `task_gates` | 1,129 / 1,129 / 878 | 08-16 → 10-09 | yes: `state` met/failed/abandoned/pending | via `task_id` | 826 tasks, 1.37 rows/task (max 23); `source` harness 972 · plan 118 · ritual 39; ids RB-* (readback) dominate; definition changes (W38) |
| `task_outcomes` | 2,674 / 2,657 / 1,360 | 06-28 → 10-09 | `success`, `feedback_signal`, `concern_reason` | **operator chat only** (100 %) | 421 rows carry a signal other than `none`; the delegated side has none |
| `task_trace_events` | 29,569 / 29,569 / 28,862 | 09-09 → 10-09 | `task.completed/failed`, `gates.*`, `numbers.audited`, `feedback.explicit` | via `task_id` | **30-d retention, no archive**; `write.failure_claim` 0 (not deployed); `gates.hook_*` 14, none with `elapsed_ms` yet |
| `decisions` (+ view `audit_decisions`) | 257 / 257 / 131 | 08-09 → 10-09 | `status`, `operator_override_kind`, `reverted_at` | all delegated (V8.3) | all `committed`, level 1–2, 0 overrides, 0 `judgment_id` links, 2 threads |
| `decision_events` | 775 / 775 / 397 | 08-09 → 10-09 | event kinds | n/a | proposed/approved/executed 257 each, `autonomy_demoted` 4 |
| `capability_autonomy` | 6 | n/a | `override_count`, `total_executions` | n/a | both counters are 0 on all 6; `schedule_task` at L2 (promoted) |
| `judgments` (V8.2) | 298 / 248 / 85 | 06-24 → 10-09 | none (posture + confidence only, no outcome) | n/a | 61 surfaced; `concession_kind` set on 1 |
| `cost_ledger` | 35,279 / 27,421 / 8,945 | 03-25 → 10-09 | n/a (cost) | via `task_id` join | 7,137 rows / 30 d have no task row (aux, eval probes); **0 `swarm` rows ever** |
| `tune_runs` | 105 / 46 / 8 | 03-26 → 09-18 | `baseline_score`, `best_score` (29.43–81.04) | n/a | last run 09-18; 356 experiments, 2 won, $498 |
| `tune_eval_results` | **0** | none | none | none | no population |
| `tune_experiments` / `tune_test_cases` / `mined_test_cases` | 358 / 103 / 318 | not dated here | per experiment | n/a | case text not read |
| `reflection_baselines` | 154 / 147 / 66 | 04-14 → 10-09 | `score` 0–1 | partial (`task_type` prefix `chat:` = 45) | `task_type` carries request text: never select it beyond the prefix |
| `signal_baselines` | **0** | none | none | none | no population |
| `task_provenance` | 368 / 213 / 99 | 04-03 → 10-08 | `status` verified/inferred/unverified | via `task_id` | research tools only |
| `task_mutations` | 69 / 0 / 0 | 04-06 → 04-11 | none | none | dead since April |
| `skill_test_runs` | 2,704 / 2,196 / 2,196 | 05-19 → 10-09 | `result` pass 2,686 / fail 2 / error 16 | n/a | skill regression, not task outcome |
| `backtest_runs` | 1 / 0 / 0 | 04-19 | trading metrics | n/a | out of scope |
| `schedule_runs` | 855 / 420 / 132 | 04-09 → 10-09 | `status` completed 838 / delivery_miss 9 / failed 3 / running 5 | delegated by definition | 54 distinct schedules |
| `scheduled_tasks` | 20 (9 active) | 03-28 → 10-02 | `gates` column set on 1 | n/a | definition table |
| `trigger_runs` | 1,281 / 845 / 371 | 05-20 → 10-09 | `outcome` fired/skipped/failed | delegated | `cron_morning` failed 7 |
| `commit_tasks` | 8 / 0 / 0 | 2025-12 → 2026-01 | `status` | `modified_by` | dead |
| `tool_approvals` | 23 | 09-30 → 10-08 | `decision` | operator | confirmation seam |
| `project_log` | 208 / 43 / 18 | 03-25 → 10-08 | none (`created`/`updated`) | no task link | not an advancement signal |
| KB `logs/decisions/` | 8 files, 11.7 KB | mtime 04-06 → 09-19 | n/a | n/a | too small for a corpus |
| KB `logs/day-logs/` | 190 files, 4.35 MB | mtime 04-04 → 10-09 | work record (content) | n/a | needs a content ruling |
| KB `logs/day-narratives/` | 174 files, 1.60 MB | mtime 04-18 → 10-09 | content | n/a | same |
| `data/archive/tasks-retention-*.jsonl.gz` | 98 files, 46 MB | 07-05 → 10-09 | full aged-out task + run rows | yes | the only path to windows past 90 d |
| `data/predeploy/` | 9 files (7 eval JSON, 2 gate-diff txt) | 10-04 → 10-07 | per-case eval (not opened) | n/a | contents not read |
| `src/tuning/eval-baseline.json` | 1 | captured 2026-10-07 05:46 UTC | overall 85.01 (scoring v3, ε 2; toolSelection 70.03, scope 100, classification 100), 261 cases | n/a | ROADMAP "Blocked on" still cites the 10-04 76.87 baseline |

## 3. Time-horizon feasibility

Wall-clock minutes are `completed_at − started_at`. "Finished" means `completed` or `completed_with_concerns`.

| Population | Window | n finished | p50 | p90 | max | n failed |
| --- | --- | --- | --- | --- | --- | --- |
| fast | 30 d | 1,699 | 0.47 | 1.32 | 12.83 | 2 |
| fast | 90 d / all | 3,652 / 3,675 | 0.57 | 2.10 | 15.85 | 16 |
| heavy | 30 d | 66 | 2.33 | 4.48 | 10.68 | 0 |
| heavy | 90 d / all | 170 / 171 | 2.28 | 4.83 | 12.12 | 7 (p50 10.68) |
| nanoclaw | all | 22 | 2.25 | 10.33 | 12.45 | 13 (p50 6.02) |
| swarm | all | 6 | 5.77 | 9.17 | 12.93 | 8 (p50 10.83) |

- **What "finished" can mean in the data**: (a) `status`, which barely varies (44 failed of 3,918 terminal); (b) the task-level ledger verdict, computed as all gates met, any failed, any abandoned, or pending. That verdict exists for 826 tasks, all since 08-16. (c) The W1 grader, 18 traces, heavy only. (d) The label, 18 rows. Only (a) covers the whole population. (b) is the sharpest signal at scale.
- **Censoring**: failures cluster at the top of the range: heavy failed p50 10.7 min, swarm failed p50 10.8 min, and no task exceeds 18 min. Long tasks fail or are cut off, so a 50 % crossing shows up mostly where the timeouts sit. A METR-style fit on wall-clock would measure the timeout knobs (`GOAL_TIMEOUT_MS` 5 min, `ORCHESTRATOR_TIMEOUT_MS` 15 min). It would not measure the system's horizon.
- **Earliest window holding ≥ 30 finished tasks**, by the date the 30th finished task arrived:

| Population | Finished all-time | 30th reached |
| --- | --- | --- |
| operator chat · fast | 2,617 | 07-12 |
| ritual · fast | 568 | 07-16 |
| scheduled · fast | 422 | 07-16 |
| ritual · heavy | 90 | 08-10 |
| other delegated · fast | 55 | 09-22 |
| operator chat · heavy | 37 | 09-29 |
| swarm child · heavy | 40 | 10-06 |
| nanoclaw, swarm root, W1 labels | 22 / 6 / 17 | not reached |

  Heavy tasks finish at 11–19 per ISO week (W36–W40; W35 37). A 30-heavy window is therefore 2–3 weeks wide.
- **Size proxies** (the METR x-axis is human time; none of these is that):
  - Tool calls per run (`json_array_length(runs.tool_calls)`) over finished tasks: fast p50 4 / p90 12 / max 62; heavy 5 / 25 / 83; nanoclaw 12 / 63 / 93. Limit: swarm parents record 0, because the work happens in the children.
  - Plan goals (`runs.goal_graph.goals`): heavy p50 4 / p90 5 / max 7; swarm 5 / 5 / 6. Limit: the planner caps the count, so the range is narrow.
  - Cost per task: from `cost_ledger`. Limit: swarm parent cost has never been attributed (0 rows), and the model tier differs per runner.
  - `tool.called` traces: 1,662 tasks, avg 4.7, 30 d only.
  None of these maps to operator time without a labelled sample.

## 4. Explicit-direction baseline

The split uses `metadata` keys only. The classes are mutually exclusive, applied in this order:

| Side | Rule | All | 30 d | Finished 30 d (fast / heavy / swarm) |
| --- | --- | --- | --- | --- |
| Operator-directed | tag `messaging` (Telegram; `threadId` present since 08-17) | 2,745 | 1,386 | 1,347 / 16 / 2 |
| Delegated: ritual | `metadata.ritualId` (8 ritual ids) | 666 | 220 | 188 / 30 / 0 |
| Delegated: scheduled | tag `scheduled` (424 joined to `schedule_runs`) | 427 | 133 | 131 / 0 / 0 |
| Delegated: swarm child | `spawn_type = 'subtask'` | 46 | 16 | 0 / 16 / 0 |
| Delegated: other | internal / skill-suggestion / scope-rerun roots | 62 | 34 | 30 / 2 / 0 |
| Unknown | `metadata` null or invalid | 23 | 7 | 3 / 2 / 0 |

Cost over 30 d by side: operator $552.60 over 1,382 tasks ($0.40/task). Delegated $105.72: ritual $61.05/218, child $22.15/16, scheduled $13.66/133, other $8.86/34. Rows with no task row $121.90. Unknown $11.36.

Task-level ledger verdict by side (all-time; 30 d in parentheses):
- Operator fast: 656 (565) all met, 11 (8) any failed.
- Operator heavy: 10 all met, 5 failed, 4 abandoned.
- Ritual fast: 48 all met.
- Scheduled fast: 26 all met, 19 abandoned.
- Swarm child: 23 all met, 9 failed, 1 abandoned.

**Paired-comparison candidates**
- Same ritual run by chat vs by schedule: **no population**. 0 operator-chat tasks carry a `ritualId`.
- Same project advanced with vs without delegation: **no population in mc.db**. Tasks carry no project id, and `project_log` (208 rows) has no task link. The day-logs are the work record.
- Heavy, operator vs delegated, on identical signals (status, ledger verdict, wall-clock, tool calls, cost): this is the closest available pair. It has 37 operator vs 132 delegated finished all-time, and 16 vs 48 in 30 d. The tasks are matched by runner, not by task.
- Fast, operator vs scheduled/ritual, on the same signals: large n, but the task mix differs completely (chat turns vs fixed rituals).

**Not comparable**
- `task_outcomes` feedback (operator only).
- W1 grades (heavy only, 18).
- Raw cost per task (different mixes and tiers).
- Anything from traces older than 30 d.

## 5. The four §7 questions mapped to data

| Question | Rows that could answer | Rows missing | Status |
| --- | --- | --- | --- |
| Q1 Amplify vs execute | `judgments` (298: posture × confidence, 61 surfaced); `feedback.explicit` (23: positive 18, rephrase 5); day-logs (190, content) | any link from a judgment or decision to an operator decision or project outcome; `concession_kind` set on 1 row | **no population** in mc.db; day-logs need a content ruling |
| Q2 Delegated autonomy vs explicit direction, net of cost of errors | side split (§4); status, ledger and cost per side; V8.3 `decisions` 257 | an outcome signal on the delegated side (0 `task_outcomes`); V8.3 errors (0 reverted / vetoed / override) | partial: outcome deltas yes, **cost of errors no population** |
| Q3 Bilateral learning curve | `judgments.confidence` (green/yellow/red); `task_outcomes.feedback_signal` over time; W1 labels | judgment resolution (was it right?) for calibration; any measure of operator decision quality | **no population** for calibration and for operator quality |
| Q4 Sustainable without attention | `schedule_runs` (855); `trigger_runs` (1,281; `cron_morning` failed 7); ritual gates 39 (met 20, abandoned 19); `tasks` blocked 40 / needs_context 8 | an operator-attention measure (interventions per week) | yes for reliability; attention not measured |

## 6. Policy adherence and process quality

**τ²-style boundary signal**
- `tool.gated`: 23, all `confirmation_required` with operator origin, 09-30 → 10-08.
- `tool_approvals`: 23 rows (15 confirmed, 2 expired, 6 superseded).
- `confirmation.continuation_started`: 15.
- `gates.hook_allowed`: 14 since 09-21. `gates.hook_released` has 0 rows (L5 trace not yet seen).
- V8.3 `decisions`: 257 across 4 capabilities (`gmail_send` 234, `schedule_task` 17, `jarvis_file_delete` 6). `capability_autonomy` override counters are 0, and there are 4 `autonomy_demoted` events.

The data has boundary *honoring* (confirmations, approvals). It has **no population of boundary violations or operator vetoes** to score against.

**LH-style process signal**

`task_gates` weekly counts:

| Week | Met | Failed | Abandoned | Tasks |
| --- | --- | --- | --- | --- |
| W33 | 12 | 1 | 0 | 9 |
| W34 | 49 | 0 | 1 | 41 |
| W35 | 115 | 13 | 7 | 80 |
| W36 | 95 | 9 | 5 | 70 |
| W37 | 89 | 4 | 5 | 48 |
| W38 | 308 | 2 | 3 | 284 |
| W39 | 177 | 0 | 1 | 168 |
| W40 | 209 | 13 | 8 | 124 |

The W38 jump is a gate-definition change: RB-* readback gates went wide. Any trend must stratify by gate source and definition date.

- `numbers.audited` (30 d): all verified 439, unverified > 0 456, no numbers 944.
- `provenance.checked`: 1,142. `citations.checked`: 9.
- `task_outcomes.concern_reason`: partial 522, tool_scope_block 17, max_turns 16.
- W1: 18 `gates.graded` traces (16 all met, 2 grader-failed, 0 errored). The ledger has 18 labelled rows: 17 really done, 1 not done, 1 catch, 1 FP.
- `write.failure_claim`: **0** (built, deploy pending).

## 7. Proposed W3 step 2

**Metric definitions**
- **TH50**: per 30-d window and side, the largest bucket of tool calls (and of wall-clock) where the finished-and-ledger-met rate stays ≥ 50 %, by logistic fit. It is always printed with the timeout ceiling and the count per bucket.
- **Boundary**: per 100 gated actions, the shares that are approved, expired, superseded, overridden and reverted. Overridden and reverted print "no population" while their counts are 0.
- **Process**: weekly ledger all-met / failed / abandoned rate per gate source; the `numbers.audited` unverified rate; W1 grader-vs-label agreement. All are stratified by gate-definition date.
- **Q2 delta**: operator vs delegated, within the same `agent_type`. It compares finished rate, ledger all-met rate, unverified-number rate and cost per finished task, each with n and a 95 % interval.
- **Q4**: schedule completion rate, delivery-miss rate, ritual gate met rate and trigger failure count, weekly.

**Scope**
- `src/eval/queries.ts`: read-only prepared statements through `getDatabase()`, aggregates only.
- `src/eval/report.ts`: renders markdown with n beside every rate and "no population" where n = 0.
- `mc-ctl eval [days]`: prints the report.
- No LLM calls, no writes and no new tables.
- Tests: synthetic db fixtures via the sqlite3 CLI in scratch, never the live db.

**Operator rulings needed before any build**
1. **Time-horizon axis.** Option (a): accept tool-call count and wall-clock as the size proxy, censored by the 5/15-min timeouts. Option (b): label a sample of tasks with an operator-estimated human time, which is new labelling work at a W1-like weekly rate.
2. **The success definition and the asymmetry.** Does "finished" mean `completed` + ledger all met (excluding `completed_with_concerns`)? Does the delegated side get a rating signal (reply-to attribution on ritual roots) before Q2 is reported? Without one, Q2 compares a signal that exists on one side only.
3. **Data reach.** Should the harness read `data/archive/*.jsonl.gz` for windows past 90 d, or should trace retention move past 30 d? Does Q1 (project advancement) get to read day-log content? If both answers are no, Q1 stays "no population" and the rolling windows stop at 90 d (30 d for traces).
