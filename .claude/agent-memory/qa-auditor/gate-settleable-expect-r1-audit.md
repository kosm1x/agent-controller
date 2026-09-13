# Audit — Honest-Done settleable `expect` (lens B: wiring / ledger semantics / blast radius)

**2026-09-12 · uncommitted working tree · Verdict FAIL (1 Critical)**
tsc clean · `npx vitest run src/lib/v8-4/` 224/224 green · corpus replay 296 rows.

Change: `src/lib/v8-4/expect.ts` (new grammar `gt/gte/lte/lt/eq/neq/between` + `isUnsettleableExpect`),
wired into `gates.ts:135` (parseGateSpecs ⇒ THROW) and `gates.ts:257` (gateSpecsFromGoal ⇒ ABANDONED row),
comparator branch in `gate-check.ts:123 expectMatches`, Counter in new `gate-metrics.ts`.

## Hottest crumbs

- **A per-source refusal policy is only as visible as the CALLER's catch.** The plan path
  emits an ABANDONED row (surrender visible, doctrine 3); the ritual path's caller
  `scheduleGates` (`src/rituals/dynamic.ts:206-216`) already had a `try/catch → []`
  "a bad gates column must never stop the ritual" swallow. So the SAME refusal becomes
  a silent total gate LOSS on the ritual side: `parseGateSpecs` throws on the FIRST bad
  entry, so one refused gate drops the WHOLE array. Live: schedule
  `9e06a237 "MexicoNecesario — Tweet Diario"` (active=1, 19:00) is the ONLY ritual gate
  row in the DB and it is `/^[1-9][0-9]*$/m` — 20/20 ritual gate rows over 30 days,
  100% of the population. After deploy it submits with 0 gates and 0 ledger rows.
  The plan doc's blast-radius line ("a refusal converts a can't-fail gate into a visible
  abandoned row; it never fails a task by itself") is FALSE for `source=ritual`.
  → Check a refusal's blast radius at every CALLER, not at the validator.

- **A write-time metric wired into the validator counts the READ path too.**
  `countGateRefusal("spec", …)` sits inside `parseGateSpecs` (gates.ts:137), and
  `scheduleGates` re-parses the stored column on EVERY ritual submission. Proven:
  three identical parses ⇒ counter 1,2,3. `mc_gate_refusals_total{source="spec"}`
  therefore ticks nightly forever from ONE stale row and can never answer
  "did something author a bad gate today". Meter at the WRITE sites, not the parser.

- **prom-client Counter at module scope in a widely-imported lib.** `new client.Counter`
  in `gate-metrics.ts:10` throws `"A metric with the name … has already been registered"`
  under a second module identity (proven with a `?v=2` import). `gates.ts` has 11
  importers incl. `nanoclaw-worker`/`heavy-worker` and `scripts/gates-validate.ts`.
  NOT a new heavy pull: `dist/observability/prometheus.js` (which also calls
  `collectDefaultMetrics` at module scope) was already in the pre-change dist worker
  graph, and `gates.js` too. Latent only. Guard = `register.getSingleMetric(name) ?? new …`
  (the read-side of that API is already used at `src/lib/s3/evaluator.ts:139`).

- **A prefix prepended INSIDE a truncation budget eats the readout.** `"last line is not
  a number — "` (28 chars) goes before the tail in `gate-check.ts:286`, then
  `recordGateResult` slices to `MAX_EVIDENCE=400`, `mc-ctl:3093` renders
  `substr(evidence,1,80)` and `stop-hook.ts:149` `slice(0,160)` — the operator loses 35%
  of the 80-char readout exactly when they need to see the offending line.

- **`ABANDONED`-only ledger ⇒ verdict `"met"`.** `ledgerVerdict` (gates.ts:465) counts
  abandoned into `total` but into neither `failedRows` nor `pendingRows`, so a task whose
  only gate is refused prints `Gates: 0/1 met · ABANDONED: …` and verdict `met`.
  Correct per doctrine (abandoned neither passes nor demotes; `consumer.test.ts:168`
  pins "abandoned ≠ failed"), but the `[met, abandoned]` case is pinned
  (`gates.test.ts:266-273`) and the abandoned-ONLY case is not.

- **The digit-regex rule is deny-by-shape, not allow-by-membership.** `regexNamesALiteral`
  refuses only digit-ONLY patterns; the backstop `FAILURE_OUTPUTS = ["", "0"]`
  (`expect.ts:110`) misses labeled counts — `/n: [0-9]+/` on a check printing `n: 0`
  names the literal `n:` ⇒ kept, still cannot fail. 0 live instances in 296 rows.

- **The ritual `gates` surface has no LLM producer at all.** `CreateScheduleParams.gates`
  (dynamic.ts:197) has ZERO callers that set it — `schedule_task`
  (`src/tools/builtin/schedule.ts:138`) does not expose `gates`. The only authoring path
  is `mc-ctl gates set-ritual` → `scripts/gates-validate.ts` → `parseGateSpecs` (covered).
  So "teach the tool the grammar" is moot; the gap is that the surface is CLI-only.

- **Migration is feasible with the check unchanged**: `./mc-ctl db "SELECT COUNT(*) AS n …"`
  is `sqlite3 -header -column`, whose output is `n` / `--` / `20` — last non-empty line is
  the bare number, so `"expect":"gt 0"` grades correctly.

## Environment note

A parallel auditor was planting mutations (`// M1 MUTATION`, `// M8 MUTATION`) into the
same working tree during this run; one scoped test run went RED on `gate-check.ts:286`
purely because of that. **Grep the tree for `MUTATION` immediately before every test run
when auditing in parallel** — otherwise a peer's mutation reads as your finding.
