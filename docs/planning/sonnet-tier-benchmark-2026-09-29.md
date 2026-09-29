# Sonnet-tier (fast path) benchmark: claude-sonnet-4-6 vs claude-sonnet-5-5 (2026-09-29)

Status: **BUILT, NOT RUN.** Harness `scripts/benchmark-sonnet-tier.ts` and the
seam field `OpusTierBenchmarkOverride.defaultModel` (claude-sdk.ts) are in the
tree. DRY run verified (20 tasks, 159 eligible). A qa-auditor pass comes
before the first `--run`, and each `--run` needs the operator's go/no-go.

## 1. Purpose, and why these four gates exist

The fast runner is the chat path (964 of 1,203 completed fast root tasks in
21 days are chats). It is hard-wired to `claude-sonnet-4-6`
with thinking disabled and effort left unset. Sonnet 5.5 costs less per token
($2 / $10 vs $3 / $15; cache reads $0.20 vs $0.30), but it carries the Sonnet 5
tokenizer.

**The June 30 Sonnet 5 revert.** The 06-30 swap to Sonnet 5 was reverted on
07-01. Nobody measured it before it went live, and it regressed on four
fronts:

- the tokenizer used about 30 % more tokens;
- the cache-read ratio fell from 62 % to 49 %;
- compaction got heavier;
- one delivery went out as an empty completion.

A cheaper price per token did not become a cheaper task. Each decision gate
below exists to catch one of those failure classes before production does.

Two API facts shape the arms (claude-api skill, cached 2026-09-25):

- Sonnet 5.5 **rejects `thinking: {type:"disabled"}` with a 400**. The
  production shape therefore cannot run on 5.5 unchanged, and the candidate
  arms must carry a thinking config.
- Effort defaults to `high` on Sonnet 5.5, and the levels are recalibrated. The
  guidance is `low` for chat and `medium` for multistep tool use, so both are
  tested.

## 2. Arms

The arms are interleaved per task, and the order rotates from task to task
(ABC for task 1, BCA for task 2, CAB for task 3, and so on). Time-of-day drift
is shared, and no arm always runs first on a cold prompt cache. Each row
records its `position` (0, 1 or 2) in `calls.jsonl`, and summary.md states
that the order was rotated.

| arm | model | thinking | effort | question |
|---|---|---|---|---|
| A | claude-sonnet-4-6 | disabled | unset (SDK default) | production baseline; only a `tap` is set |
| B | claude-sonnet-5-5 (`--model-b`) | adaptive | medium | recommended agentic shape |
| C | claude-sonnet-5-5 | adaptive | low | recommended chat shape |

`--configs=A,C` runs a subset. The seam is process-local and never set in the
service. `defaultModel` applies only when the caller passes no `model`, which
is always the case on the fast path. The effective model also feeds the breaker
key, the `cache_diag` log line and the `actualModel` default, so a candidate
run is attributed to the model it requested.

**Not tested:** `thinking: {type:"between_tools"}` on 5.5 (thinking off). It
would be a fourth arm if B and C fail only on cost.

## 3. Task selection (from the snapshot; deterministic, newest first, then task_id)

- `agent_type='fast'`, status `completed` or `completed_with_concerns`,
  `spawn_type='root'`, created in the last 21 days, `output` not null.
- **`tasks.input` is NULL on every fast row.** The dispatcher never persists
  chat input: `conversationHistory` exists only in memory. The "non-null
  input" rule is therefore replaced by reconstruction (§4). A chat task
  without a recoverable user message is skipped.
- Excluded:
  - vision chats (`Chat: El usuario envió una imagen…`);
  - eval, tuning and var-tune probes (matched in title or metadata);
  - titles containing `schedule` (which catches every `[Scheduled]` ritual),
    `recordatorio`, `envía` or `send`;
  - `/loop` tasks;
  - any task whose stored `output.toolCalls` used a tool outside the
    read-only allow-list (`ToolSearch`, the SDK schema loader, is neutral);
  - any task whose original scope has no read-only tool.
- Default is 20 tasks. `--n=` and `--tasks=<8-char prefixes>` override it;
  prefixes must still be in the eligible pool.
- DRY on 2026-09-29 (re-run after the audit fixes): 1,201 rows. Skipped: 622
  used a non-read-only tool, 331 vision, 90 title keyword. That leaves **158
  eligible**. The 20 newest are
  all chats: 13 with no tools, 7 using `jarvis_file_read` or `file_read`.
  Original cost is $0.17–$0.50 per task.

## 4. How a task is replayed

The harness rebuilds the `RunnerInput` exactly as the dispatcher and router
build it, then calls `fastRunner.execute(input)` directly.

- **description**: `tasks.description`, with the cache-break marker
  re-inserted. The router's stable half ends with `figuresProvenanceSection()`,
  and persistence replaced the marker with one `\n`. If that text is not found,
  the whole description stays in the stable half (`split=false` in DRY). All
  20 DRY tasks split.
- **conversationHistory**: the last 15 `conversations` rows for the channel
  created before the task (the router's hydration query, with poisoned replies
  dropped), plus the current message. The message comes from `jme_turns`
  (the router's `originalText`; written only for the owner's Telegram chat),
  falling back to `scope_telemetry.message`. The fallback is **not verbatim**:
  scope-telemetry stores `message.slice(0, 500)`. A chosen message exactly
  500 characters long is flagged `msg_truncated` (DRY shows `msg=CUT500`;
  1 of the 20 DRY tasks). It gets the `[Hoy: …]` line for the task's own
  creation time. This approximates the in-memory thread buffer, which also
  has a 24 h TTL that the DB does not record.
- **tools**: original scope ∩ allow-list. **modelTier**: from
  `tasks.classification`. `input`: undefined, as it was in production.
- **taskId**: `<orig>-bench-<arm>`. The runner writes DB rows keyed by task
  id into the snapshot (`task_trace_events`, a synthetic `scope_telemetry`
  row). A fresh id keeps them off the stored run's rows. It also means the
  V8.4 Stop hook finds no ledger, so no `check_cmd` runs. **runId**:
  `bench-<arm>-<prefix>`.
- **checkpoint**: on a double cap the runner writes a checkpoint through
  `upsertFile`. That is a KB write: its `jarvis_files` row lands in the
  snapshot, but the same call also mirrors the file to disk, syncs it to
  pgvector and syncs it to Drive, and `markIndexDirty` regenerates the index
  through the same legs. None of those three reads the snapshot, so the
  harness neutralises them before any `src/` import (see §6).
- **JME**: the runner embeds the last user turn (≤ 2,000 chars) under a
  1.5 s timeout. The harness calls `generateEmbedding` on that exact text
  before every arm, so every arm hits the 5-minute embedding cache and none
  loses the JME block to a cold embed.
- **signal**: `AbortSignal.timeout(--timeout-s × 1000)`, default 300 s. The
  runner forwards it to the SDK.

**Fidelity limits** (identical for every arm, so A/B/C are compared fairly,
but A will not reproduce the stored cost):

- Narrower tool scope: each replay gets only the stored scope ∩ the 11-tool
  allow-list, so it sends fewer tool schemas. Every one of the 20 DRY tasks
  still has a tool that `guards.isReadOnlyTool` does not class read-only
  (`jarvis_file_search`, `code_search`, `data_summarize`), so none takes the
  omit-KB branch (DRY prints `omit-KB 0/20`).
- `maxRounds` is the CODING tier whenever grep or glob is in the replay
  scope; the runner keys it on tool names.
- History comes from per-channel `conversations` rows, not the router's
  in-memory buffer.
- The snapshot's KB and JME facts are newer than the replayed tasks, so facts
  learned after a task can reach its replay.
- The `mc.db` + `-wal` copy is not atomic; a write between the two copies can
  leave the snapshot a few rows inconsistent.
- The Claude subscription rate limit is shared with the live service. A 429
  shows in the `error` column, not as a model failure.
- The prompt cache is shared between B and C (same model), and A's cache is
  per model. Rotation spreads the cold-first-call cost across arms instead of
  always charging it to the same arm.

summary.md repeats these limits in a "Fidelity limits" paragraph.

## 5. Metrics (per task-arm, appended to `calls.jsonl` as each call finishes)

| field | meaning |
|---|---|
| `cost_usd` | summed over every SDK call of the run (tap), resume and auth legs included. A call with a terminal result contributes its SDK `total_cost_usd`; a call without one (abort or timeout, `costAuthoritative=false`) is priced from its token usage with `calculateCost` (src/budget/pricing). Estimates count toward `--max-usd`. `runner_cost_usd` holds `RunnerOutput.tokenUsage.actualCostUsd` for cross-checking |
| `cost_authoritative`, `cost_estimated` | every call reported a terminal cost / at least one call was priced from usage. summary.md counts estimated rows per arm (`est. cost rows`) |
| `position` | 0-based slot in the task's rotated arm order |
| `msg_truncated` | the replayed user message is the 500-char scope_telemetry cut |
| `turns`, `tool_calls`, `tool_names` | Σ `numTurns` and every tool call except ToolSearch, from the tap |
| `prompt_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `completion_tokens` | prompt count includes cache read and cache creation |
| `cache_read_ratio` | cache_read / prompt |
| `duration_ms` | wall clock of `execute()` |
| `effective_model`, `model_mismatch` | the dominant model the SDK reports on each call; a mismatch is flagged if any call differs from the arm's model |
| `status` | `RunnerOutput.status`: the runner's `parseRunnerStatus` plus its BLOCKED→DWC promotion, which is what production records |
| `raw_status` | `parseRunnerStatus` over the last raw SDK text |
| `empty_completion`, `text_chars` | computed on the deliverable text |
| `tool_jaccard` | tool-name sets compared with the stored run (ToolSearch excluded) |
| `error` | runner error or thrown error, or an SDK marker (`[error_api_response`, `error_max_turns`, `[error_max_budget_usd`, `[refusal]`) |

`results/<task>-<arm>.md` holds each answer and `results/<task>-orig.md` holds
the stored production answer, for side-by-side reading.

## 6. Safety

- The live `data/mc.db` is only copied (db + `-wal` + `-shm`) to
  `data/sonnet-bench/bench.db` with mode 0600, and the copy is opened with
  `initDatabase`. Nothing in the harness opens the live file.
- The live env is inherited from `/proc/<MainPID>/environ` **only under
  `--run`**, and values are never printed. Every `CLAUDE*` key of the
  launching shell is deleted first, because the inherit loop never overwrites
  a key that is already set, so a Claude Code session's values would
  otherwise shadow the service's.
- **KB side-effect guards**, applied after the inherit and before any `src/`
  import, in DRY and `--run` alike. DRY prints a confirmation line with
  no values.
  - `JARVIS_KB_MIRROR_DIR` is set to `data/sonnet-bench/kb-mirror` (mode 0700);
    `getMirrorDir()` reads it per call.
  - `COMMIT_DB_KEY` is deleted, which makes `syncToPgvector` a no-op
    (`isPgvectorEnabled` is `!!COMMIT_DB_KEY`).
  - `DRIVE_KB_FOLDER_ID` is deleted before drive-sync loads, because it reads
    that variable at module load; `syncToDrive` then returns early.
  - A checkpoint therefore touches only the snapshot and the scratch mirror.
- `BUDGET_*` are forced to false. `JEV_SHADOW_CONSUMERS=""` so the replay
  makes no Jev calls; the shadow is log-only in production anyway.
- The run refuses to start if `inferencePrimaryProvider ≠ claude-sdk`, or if any
  allow-list tool lacks `readOnlyHint`.
- **No delivery path**: `execute()` returns a `RunnerOutput`. Telegram and
  WhatsApp sends, streaming, alerts and the sync surface all live in the
  router and dispatcher, which the harness never calls. `onTextChunk` is
  undefined. fast-runner passes `costLedger:false`, so no cost rows are
  written.
- `--max-usd` defaults to 45 and is cumulative, estimated costs included. It
  is checked after each task-arm, and a stop writes the summary first. Results contain private chat
  text, so the output dir is created with mode 0700 and files with 0600.
  `benchmarks/` is gitignored because the repo is public.

## 7. How to run

```bash
cd /root/claude/mission-control
npx tsx scripts/benchmark-sonnet-tier.ts                      # DRY: task set, arms, tools, out dir → exit 3
npx tsx scripts/benchmark-sonnet-tier.ts --run                # 20 tasks × A,B,C, cap $45
npx tsx scripts/benchmark-sonnet-tier.ts --run --n=5 --max-usd=8   # smoke first
npx tsx scripts/benchmark-sonnet-tier.ts --summarize --out=benchmarks/sonnet-tier-<stamp>
```

**Estimate**: A ≈ $0.30 per task (stored mean), and B/C are probably cheaper
per token, but see §1. That gives about 20 × $0.9 ≈ **$15–20** and about
30–45 min wall clock. Exit codes: 0 done; 2 usage, error or `--max-usd` stop;
3 dry.

## 8. Reading summary.md

- **Per arm**: aggregates over *paired* tasks, meaning tasks with a row for
  every arm run, so a partial stop cannot skew the denominators. The columns
  are n, total and mean $, mean and median seconds, turns, tool calls,
  cache-read (Σ token-weighted, and per-call mean), empty, errors, STATUS
  distribution, tool_jaccard, model mismatches, estimated-cost rows,
  completed, and **$ per
  completed task** (total $ ÷ tasks with DONE or DONE_WITH_CONCERNS and
  non-empty text).
- **Ratios vs A**: cost, duration and cache-read for B/A and C/A.
- **Decision gates**: computed per candidate arm (below).
- **Per task**: cost, seconds, turns, tools and STATUS per arm, with the
  original cost. EMPTY, ERR and MISMATCH are flagged.

Read the side-by-side answers before trusting any aggregate. Twenty tasks is
a small n.

## 9. Decision rule (proposed)

Adopt B or C **only if all four gates hold against A**:

1. **Cost per completed task ≤ A.** This is per completed task, not per
   request: a cheaper request that fails more is not cheaper. It guards
   against the tokenizer-inflation class.
2. **Empty completions ≤ A and errors ≤ A.** This guards against the
   empty-completion delivery miss.
3. **Mean tool_jaccard within 0.1 of A.** Tool behavior must not drift.
4. **Cache-read ratio (Σ) no more than 10 points below A.** This is the
   62 % → 49 % class.

Any `model_mismatch` invalidates that arm's rows. A PASS goes to the
eval-gate (`npm run eval:gate -- --run`), because a model-id change still
needs that gate before shipping. A FAIL on gate 1 alone, with the other
three passing, is the only case worth a `between_tools` fourth arm.

## 10. Results — run 2026-09-29 03:43 UTC (`benchmarks/sonnet-tier-2026-09-29-03-43/`, local only, gitignored: per-task files hold user chat content)

60 rows · 20 paired tasks · $12.67 spent (cap $45) · 14 min wall · 0 errors · 0 429s · 0 model mismatches · 0 empty completions. Live mc.db, live KB mirror and the cost ledger verified untouched afterwards.

| arm | mean $ | $/completed | mean s | turns | tool calls | cache-read Σ | gates (1-4) |
|---|---|---|---|---|---|---|---|
| A Sonnet 4.6, thinking off (prod) | 0.263 | 0.293 | 17.6 | 2.8 | 1.8 | 68.1 % | — |
| B Sonnet 5.5, adaptive, medium | 0.208 | 0.260 | 11.5 | 2.3 | 1.3 | 55.1 % | PASS PASS PASS **FAIL** (−13 pts) |
| C Sonnet 5.5, adaptive, low | 0.163 | 0.191 | 11.3 | 1.7 | 0.7 | 63.9 % | PASS PASS PASS PASS |

Quality grading (separate Opus grader, 1-5 on task fit / grounding / register, full user message read from the snapshot; cells where the arm stopped on a one-line tool request were excluded because production re-runs the turn with the tool added — 5 A, 5 B, 3 C):

| arm | fit | grounding | quality | tasks won |
|---|---|---|---|---|
| A | 4.47 | 4.00 | 3.53 | 4 |
| B | 4.93 | 4.60 | 4.20 | 4 (+3 shared) |
| C | 4.82 | 4.71 | 4.24 | 8 (+3 shared) |

Observed per arm: A leaked narration and stray tool-request lines into finished answers, invented specifics (a public figure's age and look, framework item names), and over-explored (one task: 9 calls / 92 s / $0.72). B was honest about scope but wordier and asked for write tools most often. C answered first and noted what it could not save; faults: ignored "en un párrafo" once, mis-read a hidden `.env` as missing once.

Caveats: n = 20, drawn mostly from one book-ingestion / product thread (no finance, email or scheduling traffic); the snapshot's KB is newer than the tasks, so grounding partly measures how each arm handled stale context; the cache-read gate is confounded by arm position (B at position 0 averaged 21 % cache read, B at position 2 60 %) — n per cell is 6-7.

**Verdict: C (Sonnet 5.5, adaptive thinking, effort low) is the candidate for the fast path. B is not (cache gate + cost). Neither ships from this run.** Next steps in order: (1) `npm run eval:gate -- --run` with `SONNET_MODEL_ID=claude-sonnet-5-5` + adaptive/low wired through the production path, not the benchmark seam; (2) one live check of the "asks for a write tool the original never needed" pattern (2 of 20 C rows) since production would re-run and write to the KB unasked; (3) canary on a channel for a week, watching `$/task`, cache-read ratio, compaction frequency and empty deliveries — the 06-30 Sonnet 5 revert signals.
