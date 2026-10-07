# Model-tier re-run — Opus 5.5 as a new arm on both benchmarks (2026-10-06)

Status: **HARNESSES READY, NOTHING RUN.** All runs are operator-side (the live
env is read from `/proc/<MainPID>/environ`, which the auto-mode classifier
denies from Claude's shell). Siblings: `opus-tier-benchmark-2026-09-15.md`
(orchestrator tier, §7 decision rule) and `sonnet-tier-benchmark-2026-09-29.md`
(fast tier, §9 four gates).

## 1. Why

- **Orchestrator / heavy tier.** `OPUS_MODEL_ID = "claude-opus-4-8"` is a
  literal in `src/inference/claude-sdk.ts` (~:541). Opus 4.8 lists at $5 / $25
  per MTok (cache read $0.50, write $6.25). Claude Opus 5.5
  (`claude-opus-5-5`) lists at **$4 / $20** (cache read $0.20, write $5),
  effort default `medium`, adaptive thinking that cannot be disabled. The
  09-16 run ruled out Opus 5 (goal inflation, harder reflect grading, +20 %
  plan $/call); Opus 5.5 is a different model at a lower price and has not
  been measured on this workload.
- **Fast tier.** The Sonnet 5.5 canary (`sonnet-canary.conf`:
  `SONNET_MODEL_ID=claude-sonnet-5-5`, `SONNET_EFFORT=low`) has been live
  since 2026-09-29 05:09 UTC; its 7-day readout is §2. The same harness can
  now also put Opus 5.5 on the fast path (arms D/E) so the fast-tier ruling
  compares Sonnet 4.6, Sonnet 5.5 and Opus 5.5 on the same replayed tasks.
- `src/budget/pricing.ts` had no `claude-opus-5*` / `claude-sonnet-5-5`
  entry, so `calculateCost` priced them at the $1 / $3 fallback (Sonnet 5.5
  hit the `claude-sonnet-5` prefix by luck). Exact entries now exist and both
  harness summaries print cost two ways (SDK `total_cost_usd` vs usage ×
  `pricing.ts`), so a wrong SDK price for a new model is visible.

## 2. Canary 7-day readout (aggregates only)

Windows: canary 2026-09-29 05:09 → 2026-10-06 23:10 UTC (Sonnet 5.5, fast
tier); prior = same length on Sonnet 4.6. One cost_ledger row per task;
cache-read share = cache_read_tokens/prompt_tokens; tool calls from
task_trace_events; compaction not persisted on the SDK path.

| win | kind | n | $/task | $/done | in tok/task | out tok/task | cache-read | tools/task | zero-tool | empty out | is_error | w/ concerns | fail/blk/needs_ctx |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prior 4.6 | ALL | 652 | 0.2750 | 0.2784 | 167,392 | 1,705 | 0.810 | 3.29 | 55 | 8 | 0 | 55 (8.4%) | 8 (1.2%) |
| canary 5.5 | ALL | 408 | 0.2613 | 0.2639 | 227,779 | 2,685 | 0.804 | 4.20 | 71 | 4 | 0 | 181 (44.4%) | 4 (1.0%) |
| prior | chat | 554 | 0.3024 | 0.3068 | 189,986 | 1,584 | 0.814 | 2.78 | 54 (9.7%) | 8 | 0 | 47 (8.5%) | 8 (1.4%) |
| canary | chat | 311 | 0.3189 | 0.3209 | 288,247 | 2,934 | 0.810 | 4.19 | 58 (18.6%) | 2 | 0 | 126 (40.5%) | 2 (0.6%) |
| prior | scheduled | 34 | 0.1186 | 0.1186 | 34,965 | 2,261 | 0.641 | 5.74 | 1 | 0 | 0 | 3 | 0 |
| canary | scheduled | 42 | 0.0666 | 0.0700 | 30,593 | 1,395 | 0.631 | 3.12 | 12 | 2 | 0 | 20 | 2 |
| prior | ritual | 49 | 0.1380 | 0.1380 | 46,625 | 2,832 | 0.700 | 7.45 | 0 | 0 | 0 | 4 | 0 |
| canary | ritual | 49 | 0.0882 | 0.0882 | 38,861 | 2,388 | 0.640 | 5.59 | 0 | 0 | 0 | 31 | 0 |

Chat: median $/chat 0.2291 → 0.2973, p90 0.4991 → 0.4783, turns/task 5.58 →
7.37, $/turn 0.0542 → 0.0434. Concern rate (fast, daily) 9-15 % before the
cutover, 28.6 / 58.1 / 21.7 / 63.6 / 48.8 / 43.1 / 41.5 / 53.7 % on
09-29..10-06. Zero-tool scheduled jobs after the 09-29 17:52 fix: two
recurring schedules went from ≥1 tool/run to 0 tools in every run (6/6 and
4/4). Morning Sync: $0.1481 → $0.1230, tools 7.9 → 5.8, concerns 0 → 7 of 9.
Pharma daily: $0.2423 → $0.0883, out tokens 6,464 → 2,715, tools 10.5 → 3.5.
Critics/briefing per call 18-50 % cheaper with shorter outputs. Opus 4.8
heavy tier, 30 d: 57 tasks, $118.78, $2.084/task, 1.9 tasks/day, 514k in /
10.7k out tokens per task, cache-read 0.688; 25 of 57 are "Skill evolution"
runs.

Caveats: n small (34-49 scheduled/ritual per window), chat volume halved, the
09-29 fix changed 5 rituals mid-canary, and the readout's claim that
`SONNET_EFFORT=low` did not reach most tasks is **contradicted by the code**
— see §5.3: every fast-runner SDK leg receives it, whatever the task's tier.

## 3. Arms, gates, decision rule

### 3.1 Fast tier — `scripts/benchmark-sonnet-tier.ts`

Same replay as 09-29 (20 newest eligible fast root tasks from a 21-day
window, read-only tool allow-list, isolated mc.db copy, no delivery, arm order
rotated per task), plus pool bounds: `--before=<ISO>` keeps only tasks created
before that instant (the 21-day window then ends there) and `--after=<ISO>`
replaces the window's lower bound. Both default to unset (window = the last
21 days) and need an explicit `Z` or `±HH:MM` offset (exit 2 otherwise: a
bare time parses in the local TZ, and the service shell runs
`TZ=America/Mexico_City`). Arms:

| arm | model | thinking | effort | default |
|---|---|---|---|---|
| A — incumbent (`--model-a`, effort unset; the report label names the model in force) | `--model-a` (default `claude-sonnet-4-6`; must match `/^claude-sonnet-\d/`, else exit 2), PINNED via the seam's `defaultModel` | per model (disabled on 4.x, adaptive on 5.x) | unset → SDK default | yes |
| B | `--model-b` (default `claude-sonnet-5-5`) | adaptive | medium | yes |
| C | `--model-b` | adaptive | low | yes |
| D | `--model-d` (default `claude-opus-5-5`) | adaptive | low | only with `--configs` |
| E | `--model-d` | adaptive | medium | only with `--configs` |

Arm A is now honest under the canary: after the `/proc` env copy the harness
sets `SONNET_MODEL_ID=--model-a` and deletes `SONNET_EFFORT` unless the
launching shell set either key itself (launcher wins, as for every key). It
prints `[bench] arm-A env: …` with the values in force. Each row's
`model_mismatch` still compares the arm's label to the model the SDK
reported. Arm C is the shape production runs today (Sonnet 5.5, adaptive,
low on every fast leg — §5.3).

**The reference flipped to arm C's shape.** Each replayed task's stored
production answer (`orig`) is the reference for two measures: `tool_jaccard`
(gate 3 compares each arm's tool-name set with the stored run's) and the
grader's `# REFERENCE` (grounding counts a specific not in the request, the
prior turns *or the reference* against a candidate). Production fast has run
Sonnet 5.5-low since 2026-09-29 05:09 UTC, so with the default window the 20
newest tasks are all Sonnet-5.5 production rows (dry run 2026-10-06: pool
10-06 03:07 → 22:56 UTC, reference `claude-sonnet-5-5` ×20) — gate 3 and
grounding would then measure closeness to arm C. **Gate 3 and grounding are
relative to the reference model**, so the recommended run pins the pool to
Sonnet-4.6 production with `--before=2026-09-29T05:09:00Z` (dry run
2026-10-06: 156 eligible of 1,197 fast root completed tasks in 09-08 05:09 →
09-29 05:09 UTC; the 20 selected span 09-25 11:56 → 09-29 00:42 UTC,
reference `claude-sonnet-4-6` ×20). The dry run and `summary.md` print the
pool's date range and the reference model(s) (`cost_ledger.model` per task;
`summary.json` → `reference`), so a run cannot silently flip it again. Rows
from runs before 2026-10-06 carry no reference model and say so.

New files per run: `results/<task>-request.md` (the replayed user message and
the last 4 prior turns, or the task description; read by the grader). New
summary section: **Cost two ways** per arm.

**Decision rule (fast tier).** A candidate arm (C, D or E) replaces the
incumbent only if, against A on the same paired tasks:

1. all four 09-29 gates PASS: $/completed ≤ A; empty ≤ A and errors ≤ A;
   mean tool_jaccard within 0.1 of A; cache-read (Σ) ≥ A − 10 pts;
2. blind grader means (`grades-summary.md`) not below A by more than **0.3**
   on any axis (fit, grounding, quality);
3. no increase in zero-tool answers vs A (per-task table: tool calls = 0 on a
   task where A called a tool) — the canary's zero-tool rise (chat 9.7 % →
   18.6 %, two schedules 6/6 and 4/4) is the regression this guards;
4. no `model_mismatch` rows on that arm (they invalidate the arm).

A PASS for an Opus arm (D/E) is not shippable as an env flip — see §5.2.

### 3.2 Orchestrator tier — `scripts/benchmark-opus-tier.ts`

Stage 1 (plan + reflect + selfAssess on 13 stored heavy tasks, no tools).
Run `--models=claude-opus-4-8,claude-opus-5-5 --configs=A,B --effort-b=high`.
Config A on a 5.x model is adaptive thinking at the model's default effort
(5.x rejects `disabled`), so for Opus 5.5 `--effort-b=medium` would duplicate
A; the harness warns about it. The harness now also strips the launching
shell's `CLAUDE*` keys and sets the KB-mirror / pgvector / Drive / budget
guards (stage 2 can write the KB through a tool loop), and its summary prints
cost two ways per arm × phase. After the `/proc` copy it pins
`SONNET_MODEL_ID=claude-sonnet-4-6` and deletes `SONNET_EFFORT` unless the
launching shell set either (launcher wins), so stage-2 executor legs routed to
Sonnet keep the 09-16 baseline shape instead of the live 5.5-low canary; it
prints `[bench] sonnet-leg env: …` with the values in force.

**Decision rule (orchestrator tier)**, consistent with 09-15 §7:

1. contract: Opus 5.5 bare-JSON rate ≥ 4-8/A and zero `<thinking>` /
   tool-in-text leaks on the chosen config;
2. tokens: prompt tokens per call within ±5 % of 4-8/A (tokenizer parity) and
   cache-read ratio not lower;
3. quality: goals/plan within **+0.5** of 4-8/A (the Opus 5 failure was
   3.7 vs 2.3); reflect success agreement with the stored run **≥ 85 %**;
   assess met not lower;
4. cost: plan **$/call ≤ 4-8/A** (pricing.ts column, so an SDK mis-price
   cannot flatter it).

Stage 2 (executor, read-only tools, $22-30) only if stage 1 passes.

## 4. Operator runbook

Run from the Panel terminal (not inside a Claude Code session). The harnesses
find the service with `systemctl show -p MainPID`; set `MC_PID=<pid>` if that
fails. Do **not** export `SONNET_MODEL_ID` / `SONNET_EFFORT` in the shell
unless you mean to override arm A (the old `SONNET_MODEL_ID=claude-sonnet-4-6
SONNET_EFFORT= …` prefix is no longer needed). The Claude subscription rate
limit is shared with the live service: avoid the 08:00 MX Morning Sync and
heavy-chat hours.

```bash
cd /root/claude/mission-control

# 1) Fast tier: A (Sonnet 4.6) vs C (Sonnet 5.5 low) vs D/E (Opus 5.5 low/medium),
#    pool = Sonnet-4.6 production (before the 09-29 canary) — see §3.1
npx tsx scripts/benchmark-sonnet-tier.ts --configs=A,C,D,E --before=2026-09-29T05:09:00Z   # DRY (exit 3): task set, pool range + reference model, arm-A env line
setsid nohup npx tsx scripts/benchmark-sonnet-tier.ts --run --configs=A,C,D,E --before=2026-09-29T05:09:00Z --max-usd=30 \
  > /tmp/sonnet-bench.log 2>&1 & disown
tail -f /tmp/sonnet-bench.log                                       # per task-arm lines; summary at the end

# 2) Blind grading of that run (dir printed at the end of step 1)
npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp>   # DRY (exit 3): tasks, arms, rough $ estimate
npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp> --run --max-usd=10

# 3) Orchestrator tier, stage 1
npx tsx scripts/benchmark-opus-tier.ts --models=claude-opus-4-8,claude-opus-5-5 --effort-b=high   # DRY
setsid nohup npx tsx scripts/benchmark-opus-tier.ts --run --models=claude-opus-4-8,claude-opus-5-5 \
  --configs=A,B --effort-b=high --max-usd=20 > /tmp/opus-bench-stage1.log 2>&1 & disown

# Re-render after a partial run / a --max-usd stop
npx tsx scripts/benchmark-sonnet-tier.ts --summarize --out=benchmarks/sonnet-tier-<stamp>
npx tsx scripts/benchmark-opus-tier.ts --summarize --out=data/opus-bench/stage1-<stamp>
npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp> --summarize
```

| run | expected spend | cap | wall time | results |
|---|---|---|---|---|
| fast tier A,C,D,E (20 tasks × 4 arms) | ≈ $20-25 | `--max-usd=30` | ~25-40 min (09-29: 3 arms, 14 min; Opus arms are slower) | `benchmarks/sonnet-tier-<stamp>/` — `summary.md`, `summary.json`, `calls.jsonl`, `results/` |
| grader (20 tasks, one call each) | ≈ $1-2: the dry run's rough estimate is **$0.93** for 20 tasks × 3 arms (the 09-29 run, title-only requests); 4 arms and the new `request.md` add input, so read the dry run's figure for your run | `--max-usd=10` (default; a wide margin over the estimate) | ~10-20 min | `benchmarks/sonnet-tier-<stamp>/grades/` — `grades.jsonl`, `grades-summary.md` |
| orchestrator stage 1 (13 tasks × 4 arms, ~124 calls) | ≈ $12 | `--max-usd=20` | ~35-50 min (09-16: 33 min) | `data/opus-bench/stage1-<stamp>/` — `results.jsonl`, `summary.md` |

`benchmarks/` and `data/` are gitignored (per-task files hold private chat
text; the repo is public). The grader resumes: a re-run skips tasks already
graded without error under the same key (task, `--grader-model`, `--seed`,
sorted arm set); if `grades.jsonl` holds a row graded under another key the
run refuses (exit 2) unless `--force-mixed`, which re-grades those tasks.
`--arms=…` is strict: a task missing any requested arm is skipped with a
logged reason, so every arm's mean is over the same tasks. The grader's
`--max-usd` is checked before each call (spent + that call's estimate); it
stops before a call that would cross the cap. Exit codes for all three: 0
done, 2 usage / error / `--max-usd` stop, 3 dry.

Snapshot copies of mc.db (they include `projects.credentials`): the grader
deletes its `data/grade-bench/bench.db` (+ `-wal`/`-shm`) at the end of every
`--run`, success or error. The two harnesses keep theirs (existing behaviour;
every run, the dry runs included, overwrites them) at
`data/sonnet-bench/bench.db` and `data/opus-bench/bench.db`; remove them after
the runs with
`rm -f data/sonnet-bench/bench.db{,-wal,-shm} data/opus-bench/bench.db{,-wal,-shm}`.

The grader shuffles arms per task with a seeded PRNG (`--seed`, default
`grade-v1`) and labels them R1..Rk; it never sees arm ids or models (the
results-file header is stripped). Unlike the 09-29 manual grading it does not
exclude answers that stopped on a one-line tool request — read those cells
in the per-task table before trusting a mean.

## 5. Blockers and open findings

1. **The eval gate cannot run right now.** The working tree carries the
   uncommitted eval scoring v3 WIP (`SCORING_VERSION = 3` in
   `src/tuning/gate.ts`) while the committed baseline
   `src/tuning/eval-baseline.json` is `scoringVersion: 2` → a compare run
   exits 2 (no verdict). The v3 work must land (with a re-captured baseline)
   before any swap is gated.
2. **The fast-tier env seam is Sonnet-only.** `SONNET_MODEL_ID` is used only
   when it matches `/^claude-sonnet-\d/`, so neither the eval gate nor
   production can put Opus 5.5 on the fast path by env: a D/E win needs a code
   change in `claude-sdk.ts` (and an Opus model on the fast path would share
   the `claude-sdk-opus` circuit breaker with the heavy tier).
3. **`SONNET_EFFORT` reach (verified in code, 2026-10-06).**
   `envSonnetEffort` (`src/inference/claude-sdk.ts` ~:907-915) applies to any
   call whose effective model equals `SONNET_MODEL_ID` and whose caller passed
   no `effort`; precedence is caller `effort` → benchmark seam `effort` →
   `SONNET_EFFORT` (~:1086-1088). The fast runner's live path
   (`INFERENCE_PRIMARY_PROVIDER=claude-sdk`, `src/runners/fast-runner.ts`
   :1434) calls `queryClaudeSdk` with **neither `model` nor `effort`** on all
   three legs — main (:1510), auto-resume (:1630), auth retry (:1690) — so
   **every** canary fast task ran at effort `low`, whatever its classifier
   tier. `tierToEffort(input.modelTier)` (:805) is passed only on the
   `inferWithTools` branch (:1888, :1935, :2010, :2320), which the SDK path
   returns before reaching. The readout's "357 of 409 were tier `standard`,
   so they ran at medium" is wrong: the tier→effort mapping is dead on the
   live path. Calls that do **not** get `SONNET_EFFORT`: the morning briefing
   (`src/briefing/construct.ts:270`, explicit `high`), JME extraction
   (`src/memory/jme.ts:1328`, explicit `low` anyway), every Opus leg
   (planner/executor/reflector/selfAssess pass the Opus model) and the Haiku
   fallback legs. Calls that do, besides the fast runner: the v8-2 critics /
   sycophancy / multi-option / author / concession and `src/audit/critic.ts`
   (model = `SONNET_MODEL_ID`, no effort), adapter `infer()` callers without
   `request.effort`, and Prometheus Sonnet legs (`queryClaudeSdkTiered`
   with `useOpus=false`, the Opus-failure fallback). Not fixed here; whether
   the fast runner should pass `tierToEffort` on the SDK path is a separate
   ruling (it would change the canary's measured shape).
4. **Opus 5.5 reachability under the subscription is unproven.** The first
   benchmark call is the probe: a 403/404 shows as an error row (the Opus
   harness sets `noFallback`; the fast harness records `error` +
   `model_mismatch`), and the run continues with the other arms.
5. **An orchestrator swap is a code change.** `OPUS_MODEL_ID` is a literal:
   a swap = one commit (model id, plus the thinking/effort shape if config B
   wins), eval gate PASS, qa-auditor, operator `./scripts/deploy.sh` (image
   rebuild), 3-day watch on `mc_inference_cache_read_ratio_24h{model="opus"}`
   and the daily cost line.

## 6. Not in scope

- The Claude Code harness model split (Fable main session / Opus subagents)
  is a separate operator ruling with no benchmark.
- Fixing the `SONNET_EFFORT` / `tierToEffort` reach (§5.3), the eval scoring
  v3 WIP, and any production model change. This doc only makes the two
  benchmarks re-runnable with Opus 5.5 and adds the blind grader.

## 7. Results — orchestrator tier, stage 1 (2026-10-07 03:44–04:17 UTC, $9.72, 124 rows, 0 failed calls)

Run on SDK 0.3.285 (`de1f882`), 13 stored heavy tasks × {Opus 4.8, Opus 5.5} × {A default, B high}. Dir `data/opus-bench/stage1-2026-10-07-03-44/` (gitignored).

| gate | 4.8/A (reference) | 5.5/A | 5.5/B high | verdict |
|---|---|---|---|---|
| 1 contract: bare JSON · leaks | 100 % · 0 | 85 % · 0 | 31 % · 0 | FAIL strictly; every non-bare reply is **fenced** JSON and all 52 parsed (`ok` 100 %) — formatting, not contract |
| 2 tokens: prompt/call · cache-read | 10 232 · 49 % | 10 233 · 54 % | 10 233 · 53 % | PASS |
| 3 quality: goals/plan (+0.5 max) | 2.5 | **3.4 (+0.9)** | **3.5 (+1.0)** | **FAIL** — same class as Opus 5 on 09-16 (3.7 vs 2.3), milder |
| 3 quality: reflect agreement ≥ 85 % · assess met | 92 % · 80 % | 85 % · 100 % | 85 % · 100 % | PASS (agreement at the threshold) |
| 4 cost: plan $/call, pricing.ts column | 0.0573 | 0.0565 | 0.0725 | A PASS by 1.4 %; B FAIL |
| latency plan s/call | 11.1 | 14.9 | 23.1 | — |

Where the inflation sits: the five single-goal `[swarm-child]` tasks got 3–4 goals from 5.5/A (4.8/A: 1–4, one outlier) and the deep-research chat task went 1 → 3 (B: 5). On the four multi-goal ritual/ops tasks 5.5 reproduced the stored goal count exactly (4, 4, 3, 4) where 4.8/B under-split. Mean |goals − stored|: 4.8/A 1.23 · 4.8/B 1.08 · 5.5/A 1.46 · 5.5/B 1.54. Completion tokens 1.8× (A) / 2.7× (B) of 4.8/A; the lower list price absorbs it on A only. SDK/pricing.ts ratio 1.26–1.45 on all arms (4.8 included), so the gap is not model-specific.

**Ruling: Opus 4.8 stays the orchestrator.** Stage 2 does not run (gate 3 failed on both configs). Opus 5.5 is re-tested only after a planner-prompt change aimed at swarm-child decomposition (one child = one goal) — a prompt experiment (queue §2026-10-07), not a model verdict; the fenced-JSON rate is a cosmetic column until the parser stops accepting fences.
