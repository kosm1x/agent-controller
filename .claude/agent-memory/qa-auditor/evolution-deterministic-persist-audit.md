# Skill-evolution deterministic-persist + Opus-pin audit (2026-06-28)

R1: FAIL (1 BLOCKER). R2: PASS (fully resolved, no new defects).

## What it fixes
Nightly `Skill evolution` ritual failed 9 days straight: success hinged on the
agent voluntarily calling `memory_store` (skipped ~100% on Sonnet, 0/10).
~2026-06-20 model-tiering routed it to Sonnet → unbroken streak. Fix =
deterministic persist at dispatcher seam (`TaskSubmission.persistResult`) + Opus
pin via prompt prose.

## R1 BLOCKER (caught, then fixed)
Dispatcher persisted `extractPersistText(result.output)` → `output.content`,
but heavy-runner sets `content = result.reflection.summary` (heavy-runner.ts:57
AND heavy-worker.ts:71) — the REFLECTOR's 1-3 sentence meta-assessment
(reflector.ts:55/69), or on heuristic fallback literally
`"Heuristic score: 0.63. 2/3 goals completed."` (reflector.ts:500). So it stored
the reflector paraphrase, NOT the agent's EVOLUTION REPORT. The report lives in
`executionResults.goalResults[*].result` (= executor finalContent, executor.ts:666).
FALSE-GREEN: the R1 test fed a synthetic `{content:"EVOLUTION REPORT…"}` shape the
real producer never emits. Classic producer/consumer-shape gap.

## R2 resolution (verified correct)
`src/prometheus/final-answer.ts` `collectFinalAnswer(execResults)` joins non-empty
`goalResults[*].result` in order → null when none. Wired into BOTH heavy paths
(in-process heavy-runner output.finalAnswer; container heavy-worker emits it in
stdout JSON, executeInContainer parses `parsed.finalAnswer`). `extractPersistText`
prefers `finalAnswer` over `content` (content demoted to last-resort fallback).
dispatcher.test now uses the REAL shape `{content:"Heuristic score…",
finalAnswer:"EVOLUTION REPORT…"}` and asserts finalAnswer wins. 74/74 green.
- No crash risk: `OrchestratorResult.executionResults` is REQUIRED (early returns
  use `goalResults:{}`), `Object.values({})`=[]→null, never throws.
- No success→failure regression (collectFinalAnswer can't throw on valid result).
- No junk: rejected goals set `error` but no `result` (executor.ts:818) → skipped;
  only real finalContent strings get joined.

## DOCTRINE
- Heavy/Prometheus runner `output.content` = REFLECTOR summary (1-3 sentences /
  heuristic score string), NOT the agent's answer. To persist/surface the agent's
  actual report, read `executionResults.goalResults[*].result` (executor
  finalContent), via `collectFinalAnswer`. Never persist `content` for a "store
  the agent's report" feature.
- When auditing "deterministically persist the agent's output X", TRACE the
  producer's real output shape — don't trust a hand-built test fixture. The R1
  test's fabricated `{content:"EVOLUTION REPORT…"}` masked that the producer emits
  `{content: reflection.summary}`. (audit_must_trace_path / mcp_producer_consumer_gap.)
- joining-ALL-goals (vs last-goal-only) is the SAFER artifact for a report: can't
  miss the report if the planner decomposes it across goals; skips empty/rejected.
  Tradeoff = verbosity (may include intermediate goal text / raw-data echoes).

## Residual NITs (non-blocking)
- null-finalAnswer falls back to `content` (reflector summary) → re-introduces the
  R1 junk ONLY in an abnormal "no agent text at all" run; dormant for evolution.
- heavy-runner.ts reformatted the unrelated `snapshot` type union (leading-pipe →
  inline) — doesn't trace to the finalAnswer task (tiny surgical-scope slip).

## Opus pin (resolveUseOpus, model-tier.ts)
- Keyword-driven; complex-wins-ties; no-signal DEFAULTS to complex (Opus).
- Real triggers in the new description: `audit`, `thorough`, `investigation`.
  "comprehensively" is INERT — `/\bcomprehensive\b/i` is defeated by the `-ly`
  (no trailing `\b`). R2 docstring corrected to say so.
- The OLD "## Report format" header matched `/\bformat(?:ting)?\b/i` (a SIMPLE
  signal) = likely why it ran on Sonnet. Real regression risk = re-adding a
  SIMPLE-pattern word, not stripping complex ones. Guard test
  `resolveUseOpus(description)===true` catches the net flip either way.
- Runtime feeds `title + "\n\n" + description` to resolveUseOpus (heavy-runner.ts:48);
  test checks description alone — safe because complex-wins is monotonic under added text.
