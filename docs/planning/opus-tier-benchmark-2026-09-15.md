# Opus-tier benchmark — claude-opus-4-8 vs claude-opus-5 (2026-09-15)

Status: **DESIGNED, NOT RUN.** Harness `scripts/benchmark-opus-tier.ts` + seam
`setOpusTierBenchmarkOverride` (claude-sdk.ts) are in the tree; zero API spend
so far. Each stage is a separate operator go/no-go. qa-auditor 09-15: seam
PASS (production shape pinned by tests: thinking disabled, effort unset,
Opus→Sonnet fallback); harness criticals (spend gate, fail-open allow-list,
NaN cap) fixed the same day.

## 1. Why measure before swapping

- The Sonnet 5 attempt (06-30 → 07-01) regressed before anyone measured it:
  +30 % tokenizer, cache-read 62 % → 49 %, heavier compaction, one empty-
  completion delivery miss. Operator ruled Sonnet 5 out (07-12) unless bundled
  with a cache re-tune; Fable 5 parked. The 4.7 → 4.8 swap (V8.5 §4, `8f849cf`)
  is the precedent to copy: one constant, gate PASS, container rebuild.
- What Opus 5 changes for us (claude-api skill, 2026-06-24): same $5/$25 price
  and **same tokenizer as 4.8** (no cache re-baseline expected), but thinking is
  ON by default (adaptive). Production hard-codes `thinking: {type: "disabled"}`
  and leaves effort at the SDK default ("high"). With thinking disabled Opus 5
  has two documented failure modes: a tool call written into visible text
  (silent no-op) and `<thinking>` tag leakage. Recommended shape is adaptive
  thinking + lower effort. So Opus 5 cannot be tested in one configuration.
- Where the money is: the Opus tier is 87 calls / $304 / 27 % of 30-day spend,
  avg $2.58 per heavy task (range $0.6–$9.3), ~700 K prompt tokens per task at
  35 % cache read (executor tool loop; planner/reflect are off-ledger).

## 2. Arms

| arm | model | thinking | effort | what it answers |
|---|---|---|---|---|
| 4-8 / A | claude-opus-4-8 | disabled | unset (high) | incumbent, production shape (baseline) |
| 5 / A | claude-opus-5 | disabled | unset (high) | drop-in swap: does the production shape survive on Opus 5? |
| 4-8 / B | claude-opus-4-8 | adaptive | medium | is any gain from thinking, not from the model? |
| 5 / B | claude-opus-5 | adaptive | medium | the recommended Opus 5 shape |

Arms are interleaved per task (A48, B48, A5, B5) so time-of-day drift is
shared. Config B needs the seam (production planner/executor/reflector take
no thinking/effort argument); the seam is process-local, unset in the service.

## 3. Replay set (real Opus-run heavy tasks, last 30 d)

| family | tasks | why |
|---|---|---|
| nightly ritual | Skill evolution 09-03, 09-05 | the most frequent Opus shape (every 05:00), 4 goals |
| ops / repo work | Williams W37 commentary (6 goals, 31 tools), trustr handover review (3), LEARNINGS read+report (2) | the read-then-write repo shape; two are read-only ⇒ stage 2 |
| strategy / research | Fantasy 10k strategy ($8.42, 6 goals), deep-research self-eval (score 0.65), Google Doc audit (34 KB brief) | the expensive, long-brief shape |
| swarm children | 5 single-goal children (mxdiabetes demo ×3, bariatric ×2) | single-goal ⇒ stored `finalAnswer` == goal output ⇒ selfAssess replay |

13 tasks. Stored artifacts per task: `runs.goal_graph` (goals, criteria,
status), `runs.output` (`finalAnswer`, reflect `score`), `runs.tool_calls`,
`token_usage`. Per-goal result text is NOT persisted (Lane E finding), so the
reflect replay reconstructs `goalResults` with the final answer on the last
goal and a placeholder on the others — identical input for every arm, so the
comparison is fair even though agreement with the stored score is a proxy.

## 4. What is scored

Per call (from the seam's raw-result tap): reported model, prompt /
completion / cache-read / cache-creation tokens, cost, wall time, turns.

| phase | contract checks | quality proxies |
|---|---|---|
| plan | parse OK (`parseGoalGraph`), bare JSON vs fenced vs prose, `<thinking>` leak, tool-call-in-text | goal count vs stored, criteria per goal, V8.4 gate count (`metadata.gates`) |
| reflect | final JSON parsed, leak checks | score vs stored, success-threshold agreement (0.8) |
| assess | final JSON parsed | `met` rate (every input is a goal the stored run completed, so met=true is the expected reading) |
| execute (stage 2) | goals completed, leak checks on goal text | tool calls vs stored, reflect score, tokens, cache-read ratio, cost, wall time |

Sonnet-5-class regressions to watch explicitly: cache-read ratio per call,
prompt tokens for the same input (tokenizer), empty completions (`textChars`
0 with ok=true), turn count inflation.

## 5. Stages, cost, time (estimates — nothing spent yet)

| stage | calls | est. spend | cap (`--max-usd`) | wall time | command |
|---|---|---|---|---|---|
| 1 plan + reflect + assess | 13 + 13 + 5 per arm × 4 = 124 | $10–18 (~$0.08–0.15 per 1-turn call; B arms add thinking tokens) | 20 | ~50–70 min sequential | `npx tsx scripts/benchmark-opus-tier.ts --run` |
| 2 executor, read-only | 3 tasks × 4 arms = 12 graph runs | $22–30 (stored 4.8 cost $0.94 + $2.65 + $2.14 per arm-set) | 40 | ~40–60 min | `npx tsx scripts/benchmark-opus-tier.ts --run --stage=2 --tasks=b8e2700a,656a4b94,b324396a` |
| 3 eval gate (only if a swap is proposed) | fixed | ~$5 | — | ~13 min | `npm run eval:gate -- --run` |

Stage 1 alone answers the drop-in question (does 5/A leak or break the JSON
contracts?) and the tokenizer/cache question. Stage 2 is only worth buying if
stage 1 shows no contract regressions. Stop after any stage.

Stage 2 fidelity note: the allow-list is 11 in-box read tools (file/grep/glob/
list/code_search/data_summarize/project_list/user_fact_list + jarvis_file_*).
Deliberately absent: `shell_exec` (the stored runs used it), `knowledge_map`
(writes maps and runs its own un-metered infer despite `readOnlyHint`),
`pdf_read` (URL mode leaves the box), `project_get` (returns stored
credentials). The harness refuses to run if any allow-listed tool is missing
or loses `readOnlyHint` — an empty list would hand the model the whole
registry. Expect fewer tool calls than stored on all four arms — compare arms
to each other, not to the stored count.

## 6. Run mechanics (operator)

The harness follows the validate-* pattern: live env from
`/proc/<MainPID>/environ` (never printed; **the auto-mode classifier denies
this read from Claude's shell**, so the run is operator-side), mc.db snapshot
under `data/opus-bench/` (gitignored, 0600; `MC_BENCH_SCRATCH` overrides),
`--run` gate, cumulative spend cap checked after each recorded call / graph
run (not mid-run), `costLedger:false` on the phase calls, executor metering
into the snapshot. Inherited from the validate-* pattern, unchanged: WAL files
are copied rather than `.backup`-snapshotted, and an operator-shell env var
shadows the same name from the service env.

```bash
cd /root/claude/mission-control
npx tsx scripts/benchmark-opus-tier.ts                     # dry: task set + arms (no spend)
setsid nohup npx tsx scripts/benchmark-opus-tier.ts --run > /tmp/opus-bench-stage1.log 2>&1 & disown
tail -f /tmp/opus-bench-stage1.log                          # per-call lines; summary.md at the end
```

Output: `<out>/results.jsonl` (one row per call) and `<out>/summary.md` (per
arm × phase table; means over OK rows only). `--summarize --out=<dir>`
re-renders from a partial run.

Reachability is NOT yet proven: the first 5/A plan call doubles as the probe.
A 403/404 on `claude-opus-5` under the `max` subscription shows up as an
error row (noFallback — Sonnet never masks it) and the run continues with the
other arms.

## 7. Decision rule (proposed)

Swap to Opus 5 only if, on the same tasks:
1. contract: 5/x bare-JSON rate ≥ 4-8/A and zero `<thinking>`/tool-in-text
   leaks on the chosen config;
2. tokens: prompt tokens per call within ±5 % of 4-8/A (tokenizer parity) and
   cache-read ratio not lower;
3. quality: plan goal counts and gate counts comparable; reflect/assess
   agreement not lower; stage-2 goals-completed and score not lower;
4. cost: $/task not higher than 4-8/A by more than the quality gain justifies.

If the winner is 5/B, the swap is TWO constants, not one (model id + the
thinking/effort shape for the Opus tier), and needs the same gate. Either way:
one commit, `npm run eval:gate -- --run` PASS, qa-auditor, operator deploy
(`./scripts/deploy.sh`, container image rebuild), 3-day watch on
`mc_inference_cache_read_ratio_24h{model="opus"}` (today 0.86) and the daily
cost line; revert = the same constant(s).

## 8. Not in scope

Sonnet 5 (ruled out 07-12), Fable 5 (parked), the Sonnet main loop, the Haiku
classifier, budget hard-caps (closed by operator ruling).
