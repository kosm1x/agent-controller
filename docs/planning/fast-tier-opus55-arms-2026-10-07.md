# Fast tier — Opus 5.5 arms D/E readout (2026-10-07)

Queue §2026-10-07 item 8. Decision rule: `model-tier-rerun-2026-10-06.md` §3.1.
Run `benchmarks/sonnet-tier-2026-10-07-05-24/` (gitignored; per-task answers
and grader rationales stay there — they hold private chat content).

**Verdict: neither Opus 5.5 arm passes §3.1, and neither beats the incumbent
Sonnet 5.5 low (arm C) on grader means. Keep Sonnet 5.5 low. No change.**

## 1. Run

| step | command (repo root) | result |
|---|---|---|
| dry run | `npx tsx scripts/benchmark-sonnet-tier.ts --configs=A,C,D,E --before=2026-09-29T05:09:00Z` | exit 3; 20 tasks of 156 eligible; reference `claude-sonnet-4-6 ×20` |
| bench | `… --run --configs=A,C,D,E --before=2026-09-29T05:09:00Z --max-usd=30` | 2026-10-07 05:24–05:44 UTC, 80 rows, 20 paired tasks, **$23.98**, 0 errors, 0 rate-limit hits, 0 `model_mismatch` |
| grader dry | `npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-2026-10-07-05-24 --grader-model=claude-opus-4-8 --arms=A,C,D,E --max-usd=10` | exit 3; rough est $1.36 |
| grader | same + `--run` | 20/20 graded, **$1.52**, 0 errors; isolated db copy removed by the script |

Dry-run lines (verbatim):

```
[bench] arm-A env: SONNET_MODEL_ID=claude-sonnet-4-6 (pinned to --model-a) · SONNET_EFFORT=(unset) (cleared)
[bench] env guards: KB mirror -> /root/claude/mission-control/data/sonnet-bench/kb-mirror · pgvector off · Drive off · 14 launching-shell CLAUDE* key(s) stripped
[bench] 20 task(s) of 156 eligible (1197 fast root completed, created 2026-09-29 05:09:00 − 21d → 2026-09-29 05:09:00 UTC; skipped used-non-read-only-tool=620 vision=331 title-keyword=90)
[bench] Pool created 2026-09-25 11:56:29 → 2026-09-29 00:42:07 UTC · reference (stored production answer) model(s): claude-sonnet-4-6 ×20
```

Same 20 task ids as the 02-14 run. Arms: A = Sonnet 4.6 (effort unset,
pinned) · C = Sonnet 5.5 adaptive low (production since 10-07 02:44 UTC) ·
D = Opus 5.5 adaptive low · E = Opus 5.5 adaptive medium. SDK 0.3.285 (the
02-14 run was on 0.3.245, where D/E 400'd on 20/20).

## 2. §3.1 strictly, vs this run's A

| arm | 1 $/completed ≤ A | 2 empty/errors ≤ A | 3 jaccard ±0.1 of A | 4 cache-read ≥ A − 10 pts | grader ≥ A − 0.3 (all axes) | zero-tool not up vs A | model_mismatch 0 | §3.1 |
|---|---|---|---|---|---|---|---|---|
| A | 0.3309 (17/20) | 0 / 0 | 0.34 | 75.9 % | 3.00 / 3.15 / 2.80 | 7/20 | 0 | — |
| C | 0.2523 PASS | 0 / 0 PASS | 0.57 FAIL | 53.3 % FAIL | +1.00 / +0.35 / +0.70 PASS | 14/20; 11 of A's 13 tool tasks FAIL | 0 PASS | FAIL |
| D | **0.5125 FAIL** | 0 / 0 PASS | 0.63 FAIL | 53.5 % FAIL | +0.50 / +0.20 / +0.40 PASS | 15/20; 11 of 13 FAIL | 0 PASS | **FAIL** |
| E | **0.4597 FAIL** | 0 / 0 PASS | 0.49 FAIL | 75.4 % PASS | +0.60 / −0.20 / +0.40 PASS | 9/20; 6 of 13 FAIL | 0 PASS | **FAIL** |

Grader cells are Δ fit / grounding / quality vs A. D fails gate 1 by 55 %, E
by 39 %: on cost alone neither Opus arm can pass, whatever the A noise below.

Strict-reading notes:

- Gate 3 is symmetric (`Math.abs(a − A) <= 0.1`, `scripts/benchmark-sonnet-tier.ts:394`).
  A fell to 0.34 this run, so every candidate "fails" by being *closer* to the
  reference than A. C's jaccard is 0.57 in both runs.
- The zero-tool rule fails C as well (it also did on 02-14: 13 vs A's 10
  zero-tool answers, 6 of A's 10 tool tasks). The 10-07 ruling did not apply
  it strictly. Read zero-tool as a relative signal between candidates
  (lower part of §4), not as the gate that decides this run.

## 3. Arm A drift (02-14 → 05-24, same 20 tasks, same pool pin)

| arm | run | $/completed | completed | cache-read Σ | jaccard | tool calls/task | zero-tool | fit / grounding / quality |
|---|---|---|---|---|---|---|---|---|
| A | 02-14 | 0.2760 | 18 | 62.9 % | 0.52 | 1.4 | 10 | 3.60 / 3.35 / 3.40 |
| A | 05-24 | 0.3309 | 17 | 75.9 % | 0.34 | 2.4 | 7 | 3.00 / 3.15 / 2.80 |
| C | 02-14 | 0.2094 | 20 | 52.0 % | 0.57 | 1.1 | 13 | 4.05 / 3.30 / 3.55 |
| C | 05-24 | 0.2523 | 17 | 53.3 % | 0.57 | 1.1 | 14 | 4.00 / 3.50 / 3.50 |

A moved a lot between identical replays (fit −0.60, cache +13 pts, jaccard
−0.18). C held: grades within 0.2, jaccard and tool use identical, cache
+1.3 pts. Its 3 non-completions this run (1 BLOCKED, 2 NEEDS_CONTEXT) are all
missing-tool blocks (§5). Changes between the two runs: SDK 0.3.245 → 0.3.285
(CLI 2.1.285) and a fresh mc.db snapshot (newer KB/JME facts). Run-to-run
variance on n = 20 is about ±0.5 on a grader axis. That makes C, not A, the
useful fixed point for comparing D and E.

## 4. D and E vs the incumbent C (what the decision turns on)

| measure | C | D | E | D/C | E/C |
|---|---|---|---|---|---|
| $/completed (SDK) | 0.2523 | 0.5125 | 0.4597 | 2.03× | 1.82× |
| total $ (SDK, 20 tasks) | 4.290 | 7.175 | 6.895 | 1.67× | 1.61× |
| total $ (usage × pricing.ts, list) | 2.568 | 4.426 | 4.441 | 1.72× | 1.73× |
| completed | 17 | 14 | 15 | | |
| BLOCKED + NEEDS_CONTEXT | 3 | 6 | 5 | | |
| grader fit / grounding / quality | 4.00 / 3.50 / 3.50 | 3.50 / 3.35 / 3.20 | 3.60 / 2.95 / 3.20 | −0.50 / −0.15 / −0.30 | −0.40 / −0.55 / −0.30 |
| grader mean (3 axes) | 3.67 | 3.35 | 3.25 | −0.32 | −0.42 |
| per-task wins/ties/losses vs C (3-axis sum) | | 7 / 4 / 9 | 6 / 4 / 10 | | |
| zero-tool answers | 14 | 15 | 9 | | |
| zero-tool on the 7 tasks where production used tools | 4 | 4 | 2 | | |
| zero-tool where C used a tool (6 tasks) | — | 2 | 2 | | |
| tool calls (Σ) / tasks with ≥ 1 tool | 21 / 6 | 11 / 5 | 41 / 11 | | |
| output tokens Σ | 19,210 | 17,863 | 31,293 | 0.93× | 1.63× |
| cache-read Σ | 53.3 % | 53.5 % | 75.4 % | | |

Against C under the §3.1 rules, D fails fit (−0.50) and $/completed. E fails
fit (−0.40), grounding (−0.55) and $/completed. Quality is −0.30 on both,
exactly at the line.

**Sensitivity, with the missing-tool blocks removed.** On the 14 tasks where
none of C/D/E hit a missing-tool block (excluding 03a7c9e8, 215930b3,
ae67f96f, c2bad579, cc349111, d9ad7dc1), the grader means are C 4.43 / 3.50 /
3.86 (mean 3.93), D 4.50 / 3.43 / 4.07 (4.00), E 4.50 / 2.93 / 3.93 (3.79).
Per task vs C: D wins 7, ties 1, loses 6. E wins 5, ties 2, loses 7. Cost on
those 14 tasks: C $3.115, D $5.304 (1.70×), E $5.326 (1.71×). Under the
assumption most favourable to Opus, D is +0.07 on the mean for +70 % spend,
and E is behind C.

## 5. Why Opus 5.5 blocks more (replay-fidelity confound)

Every BLOCKED or NEEDS_CONTEXT row in the run (17 of 80, all arms) is a
one-line "I need `<tool>` for this" (`Necesito \`<tool>\``) naming a tool
that the replay leaves out. The replay offers only the 11-tool read-only
allow-list (fidelity limit 1 in `summary.md`).

| arm | blocks | missing tool named |
|---|---|---|
| A | 3 | `shell_exec` ×3 |
| C | 3 | `jarvis_file_write`, `shell_exec`, `market_indicators` |
| D | 6 | `jarvis_file_write` ×3, `file_write`, `shell_exec`, `market_history` |
| E | 5 | `jarvis_file_write`, `jarvis_file_update`, `file_write`, `market_history` ×2 |

On 3 of these tasks (03a7c9e8, 215930b3, c2bad579), C answered in text and
scored 4–5 on fit, while D and E blocked and scored 1/3/1. The grader's
rationale on 03a7c9e8 says the requested artefact did not need the write
tool at all. In production a write tool would be in scope, so some of the
Opus blocks would become tool calls there. §4's sensitivity cut removes
them, and Opus still does not clear C by a margin that would pay for the
price.

## 6. Cost two ways

| arm | model | SDK `total_cost_usd` Σ | usage × `pricing.ts` Σ | SDK / pricing.ts |
|---|---|---|---|---|
| A | claude-sonnet-4-6 | 5.625 | 3.597 | 1.56 |
| C | claude-sonnet-5-5 | 4.290 | 2.568 | 1.67 |
| D | claude-opus-5-5 | 7.175 | 4.426 | 1.62 |
| E | claude-opus-5-5 | 6.895 | 4.441 | 1.55 |

All 80 `Completed:` lines in the run log report `basis=list`. Even so, the
SDK total is 1.55–1.67× usage × list price on every model. That is the same
gap as on 02-14 (1.63–1.66), and it bears on queue §2026-10-07 item 5.

## 7. Latency (seconds per task-arm, wall clock)

| arm | mean | median | p90 | max |
|---|---|---|---|---|
| A | 18.3 | 11.1 | 20.8 | 98.1 |
| C | 10.8 | 8.9 | 21.5 | 24.9 |
| D | 13.3 | 10.8 | 24.8 | 41.5 |
| E | 19.4 | 15.8 | 39.7 | 65.4 |

## 8. Recommendation

Do not adopt either Opus 5.5 arm on the fast tier. Both fail §3.1 against A
on gate 1 ($/completed 0.51 and 0.46 vs 0.33). Against the incumbent Sonnet
5.5 low they cost 1.6–2.0× and grade lower on every axis: mean −0.32 (D) and
−0.42 (E), with D losing 9 of 20 tasks and E losing 10. Part of that gap
comes from Opus 5.5 blocking on write tools the read-only replay withholds.
With those tasks removed, D comes out +0.07 ahead of C at +70 % spend and E
comes out behind. That is nowhere near the large blind-grade margin a 2×
list price would need. Sonnet 5.5 low stays the fast tier. A §5.2 code path
for an Opus fast tier (`SONNET_MODEL_ID` accepts `/^claude-sonnet-\d/` only)
is not worth building on this evidence.

Caveats: n = 20 chat tasks, one replay each. Arm A moved by up to 0.6 on a
grader axis between identical runs. One grader (Opus 4.8). The read-only
replay penalises a model that refuses rather than answers in text without the
write tool.
