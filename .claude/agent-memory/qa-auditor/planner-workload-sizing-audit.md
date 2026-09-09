# Planner workload-sizing prompt block (2026-07-27) — FAIL (1 Critical)

Scope: `src/prometheus/planner.ts` PLAN_SYSTEM "## Workload sizing" block +
REPLAN_SYSTEM timeout row + 2 pin tests. Prompt-only fix for task 588389e9
(monolithic "analyze each slide" goal blew the 120s per-goal timeout twice,
10-min ceiling arrived with user-facing goals unfinished).

## C1 — the new REPLAN decision-table row is DORMANT

`planner.ts:80` adds `| A goal TIMED OUT (did not fit its round) | Split it
into smaller batch goals |`. The replanner can never see that signal:

- `orchestrator.ts:340` is the ONLY `replan()` call site; it passes
  `vote.reason` from `checkReplan`, whose three templates
  (`orchestrator.ts:580,594,610`) are tool-failure-rate / tool-call-ratio /
  "Goals blocked with no ready alternatives" — none mention a timeout.
- `replan()`'s payload is `graph.toJSON()` + reason (`planner.ts:222-226`);
  `Goal` (types.ts) has **no error field**, so the
  `Goal g-3 timed out after 120000ms` string in
  `executionResults.goalResults[id].error` never reaches the prompt.
- `checkReplan(graph, trace, _execResults, cfg)` — the exec results are
  already a parameter and deliberately UNUSED (`orchestrator.ts:572`).
- The new test feeds reason `"Goal g-3 timed out after 120000ms"` — a string
  production never emits. Green test, impossible input.

**DOCTRINE (new)**: a decision-table row in a replan/repair prompt is only
live if some producer puts its trigger token into the payload. Trace the
REASON-STRING PRODUCER, not just the prompt text. Same family as
"deferred tool needs registration AND scope-array" (x-poster) and
"dormant-gate OR'd into exit code".

## W-class (all verified in code)

- **Prompt's runtime numbers vs machinery**: the 120s race wraps ONLY the
  first `inferPromise` (`executor.ts:434-447`). The self-assess retry legs
  (`executor.ts:551-580`, `MAX_SELF_ASSESS=2`) are NOT raced — only the
  global abort. Plus `MAX_RETRIES=3`. So "one goal = ~2 min / 10-15 tool
  calls" is a SIZING TARGET, not an enforced bound: worst case ≈ 3×120s +
  untimed retries, and up to 10 rounds × 3 legs per attempt
  (`MAX_ROUNDS_PER_GOAL=10`).
- **Batching never addressed the wall-clock ceiling.** `executeGraph` runs
  ready goals CONCURRENTLY and unbounded
  (`Promise.allSettled(ready.map(...))`, executor.ts:805). Batches only fit
  the 600s ceiling (`types.ts:265`) if they are INDEPENDENT — the prompt
  never says `depends_on=[]`. A serial chain of 5 batches = 10 min = the
  original incident. Conversely 15 independent batches = 15 concurrent Opus
  SDK calls, no limiter, breaker at `claude-sdk.ts:616`.
- **15-goal cap collision** (`planner.ts:52` vs `:62`): 60 items at 3-5/batch
  = 12-20 goals. No overflow guidance; `parseGoalGraph` does not enforce the
  cap → silent item-dropping or cap breach.
- **Self-assess window**: `windowOutputForAssess` MAX=5000 (head 3000/tail
  2000, `executor.ts:130`). A 3-5-item batch with per-item prose overflows
  it → middle items elided → per-batch criteria unmet → `criteriaMet=false`
  grade-down, the exact e6f3dfa0 class the fix targets.

## Verified TRUE claims (don't re-litigate)

- `goalTimeoutMs` default 120_000 (`types.ts:266`). NOTE: `config.ts:218`
  `GOAL_TIMEOUT_MS` is **dead config** — both consumers build cfg from
  `defaultConfig()`, so the env var is never read.
- "Per-goal answers are JOINED into the final user reply": TRUE for heavy
  chat. `collectFinalAnswer` joins per-goal `result` (final-answer.ts:18) →
  `heavy-runner.ts:92` `output.finalAnswer` → `deliverable.ts` FIELD_ORDER
  puts `finalAnswer` FIRST. The 500-char truncation at `router.ts:2517` is
  background-agent-only; heavy tasks last 30d are spawn_type root=36 /
  subtask=1, zero user-background.
- **eval:gate N/A is CORRECT**: `src/tuning/eval-runner.ts` has exactly three
  categories (tool_selection / scope_accuracy / classification, lines
  275-285); `evalToolSelection` builds messages from the test case only and
  never touches planner.ts. But CLAUDE.md's rule is unconditional, so the
  honest framing is "this change class has NO automated detector".

## Test brittleness — MUTATION-VERIFIED

Rewording `BATCH goals of 3-5 items` → `batched goals of 3 to 5 items`
(semantically identical) turns the pin test RED. Discrimination confirmed;
brittleness confirmed. Prefer case-insensitive regex on load-bearing tokens.
