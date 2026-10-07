# Planner swarm-child experiment — 2026-10-07

**Prompt experiment, not a model decision.** The orchestrator model stays Opus 4.8
(ruling in `model-tier-rerun-2026-10-06.md` §7). Switching to Opus 5.5 still needs
the eval gate (`npm run eval:gate -- --run`) and a code change to `OPUS_MODEL_ID`;
neither is decided here.

## Why

On stage 1 (03:44 UTC, `data/opus-bench/stage1-2026-10-07-03-44/`), Opus 5.5 failed
gate 3 (goals/plan 3.4 A vs 2.5 for 4.8/A; the limit is +0.5). The extra goals came
from the five single-goal `[swarm-child]` tasks: 5.5/A planned 3,3,3,4,4 where the
stored plan had 1.

## Change

`src/prometheus/planner.ts`: `plan()` adds `SWARM_CHILD_PLAN_RULE` to the **user**
message when the task text starts with `[Swarm] `:

> ## Swarm child
> This task is ONE goal delegated by a parent swarm plan, which already decomposed
> and sized the work. Plan it as exactly ONE goal carrying its completion criteria — do not split it.

How the planner recognises a swarm child: `swarm-runner.ts:903` titles each child
`[Swarm] <goal>`, and `heavy-runner.ts:79/215` gives `orchestrate()` (and so `plan()`)
`${title}\n\n${description}`. The check is anchored, so a task that only mentions
"[Swarm]" further in is unaffected. `PLAN_SYSTEM` is unchanged, so its cached
prefix stays byte-identical. Other tasks get today's prompt.
Pinned by `src/prometheus/planner.test.ts` › "a swarm child ([Swarm] title…)". Mutation-checked
by three mutants: rule never added, rule always added, anchor dropped. All three fail the test.

**Harness fidelity fix, needed for the experiment:** `scripts/benchmark-opus-tier.ts`
used to plan and reflect on `description` alone, so the `[Swarm]` title never reached
the planner. It now passes the same `${title}\n\n${description}` string that heavy-runner
builds (it still omits the chat conversation context). Because of that, the 03:44 rows
are not a clean "before". The table below adds a **control** run: the new
harness input with the old planner prompt.

## Runs (stage 1, `--configs=A --plan-only`, 6 tasks × {4.8, 5.5})

| run | dir (`data/opus-bench/…`, gitignored) | planner | spend |
|---|---|---|---|
| 03-44 (original) | `stage1-2026-10-07-03-44` | old, description only | (part of $9.72) |
| control | `planner-exp-control-2026-10-07` | old, title + description | $0.68 |
| rule | `planner-exp-rule-2026-10-07` | **new**, title + description | $0.47 |
| rule r2 (repeat) | `planner-exp-rule-r2-2026-10-07` | **new**, title + description | $0.29 |

Total spend for this experiment: $1.44. There were 0 failed calls and no 429s or overloaded errors.

## Goals per plan (criteria in parentheses)

| task | stored | 03-44 4.8 | 03-44 5.5 | control 4.8 | control 5.5 | rule 4.8 | rule 5.5 | r2 4.8 | r2 5.5 |
|---|---|---|---|---|---|---|---|---|---|
| b8e2700a swarm | 1 | 4 (9) | 3 (6) | 3 (7) | 3 (6) | **1** (4) | **1** (3) | 1 (4) | 1 (3) |
| 8202d36a swarm | 1 | 1 (3) | 3 (6) | 1 (3) | 2 (6) | **1** (2) | **1** (3) | 1 (2) | 1 (3) |
| 62229255 swarm | 1 | 2 (4) | 3 (7) | 2 (4) | 3 (7) | **1** (3) | **1** (3) | 1 (3) | 1 (3) |
| 92f0ceec swarm | 1 | 2 (5) | 4 (7) | 1 (3) | 4 (11) | **1** (3) | **1** (2) | 1 (3) | 1 (3) |
| bcaf39e5 swarm | 1 | 1 (3) | 4 (8) | 1 (3) | 2 (5) | **1** (3) | **1** (3) | 1 (3) | 1 (2) |
| eb91914c chat (rule does not apply) | 3 | 1 (1) | 3 (6) | 3 (7) | 3 (9) | 3 (7) | 4 (10) | 3 (7) | 5 (12) |

Mean |goals − stored| on these 6:

| | 03-44 | control | rule | rule r2 |
|---|---|---|---|---|
| Opus 4.8/A | 1.17 | 0.50 | **0.00** | 0.00 |
| Opus 5.5/A | 2.00 | 1.50 | **0.17** | 0.33 |

All 20 swarm-child plans with the rule (2 runs × 5 tasks × 2 models) came back as 1 goal,
on both models. On swarm children, runnable gates per plan fell from 1.8 (4.8) and
2.0 (5.5) in the control to 1.4 on both: fewer goals means fewer criteria. The parent's own gates for
the goal still travel with the child (`swarm-runner.ts` `gateSpecsFromGoal`).
Plan completion tokens on swarm children fell from 693 to 535 (4.8) and from
1242 to 673 (5.5). Every reply was bare JSON.

eb91914c is a chat task, not a swarm child, so its input was identical in the control and rule runs. Across
those three runs 5.5 planned 3, 4 and 5 goals, and 4.8 planned 3 each time. That spread is run-to-run variance at n=1 per
cell, not an effect of the rule. Adding the title alone moved 4.8 from 1 goal
(03-44) to 3, which is the stored count.

## Production effect on Opus 4.8 (the live orchestrator)

The rule moved 4.8 to the stored count on every swarm child: 3,1,2,1,1 in the control became
1,1,1,1,1 in both rule runs. It made **no** task worse. 4.8 kept its criteria on the single goal (2-4 each).
Going by this experiment, the line can ship for 4.8. Shipping still has to follow the
repo rule: run the eval gate before any system-prompt change.

## Gate 3 recomputed on the full 13

Method: take the 03-44 plan/A rows, replace the 6 tasks' goals with the rule-run values,
and keep the other 7 as they were.

| | 4.8/A mean goals | 5.5/A mean goals | Δ (limit +0.5) | verdict |
|---|---|---|---|---|
| 03-44 as run | 2.54 | 3.38 | +0.85 | FAIL |
| control substituted | 2.54 | 3.15 | +0.62 | FAIL |
| **rule substituted** | 2.31 | 2.54 | **+0.23** | **PASS** |
| rule r2 substituted | 2.31 | 2.62 | +0.31 | PASS |

Mean |goals − stored| on the 13, rule run: 4.8/A 0.69, 5.5/A 0.62. The 03-44 values were
1.23 and 1.46.

Caveat: this is a mixed set. The 7 kept tasks were planned on description only (old
harness input). As eb91914c shows, adding the title can move a plan by itself. A clean gate-3 reading
needs the full 13-task stage-1 run (all four gates) with the current harness. This experiment
does not run it.

## What this does NOT decide

- No orchestrator model swap. 5.5 still has to pass the full stage 1 (gates 1-4) on the
  current harness, then stage 2, then the eval gate, and then a code change to `OPUS_MODEL_ID`.
- `replan()` is untouched. A swarm child that replans can still split.
- A `[Swarm]` child routed to the swarm runner (nested swarm, capped by `MAX_SWARM_DEPTH`)
  also gets the rule, because `swarm-runner.ts:644` builds the same `${title}\n\n${description}` input.
  It then plans one goal and so does not fan out further. That matches the intent that one child is one goal,
  but it has not been measured.
