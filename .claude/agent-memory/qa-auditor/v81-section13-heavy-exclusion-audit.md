# V8.1 §13 activation-gate — exclude `heavy` from cache-read ratio (2026-07-10)

VERDICT: PASS W/WARN, 0 Crit / 2 Warn / 4 Info. Files: `src/briefing/activation-gate.ts` (+`GATE_COLD_START_AGENT_TYPES=["heavy"]`, SQL `AND agent_type NOT IN (?)`), `activation-gate.test.ts` (+1 test). 12/12 tests green.

DB-VERIFIED (data/mc.db, 2026-07-10):
- fast 80.5% / 24h (EXACT match), 87.2% / 14d (EXACT). heavy 1 run/day 14/14 (EXACT). Fix flips gate: 78.29%→80.51% (FAIL→PASS), runs 32→31 (≥20, stays measurable). nanoclaw 0 runs/24h but 24/14d — real cacheable path, unaffected.
- SQL correct: placeholder gen `.map(()=>"?")` = pure "?" chars (no injection); bind order `reflection:%` then `...heavy` matches `NOT LIKE ?`/`NOT IN (?)`; count/param = 2/2. cacheableRuns & cacheableCostUsd both omit heavy (same filtered query). No model-id/prompt/tool-desc touched → eval:gate NOT required.
- New test discriminating: without fix runs=21,pct=69.9 vs asserted 20/81 → fails without fix. Realistic heavy ratio 47.6% = (N-1)/N ceiling.

DOCTRINE — "measurement-correction vs goalpost-move" verified TRUE here: heavy's ratio is turn-count-capped ((N-1)/N at ~1.9 turns→~47% ceiling), INDEPENDENT of prefix size, so no prompt work could lift it → excluding it is legitimate. Confirmed empirically: ratio tracks turns (06-27 had 4.47 turns→77.6%; recent 1.7-1.9 turns→43-48%).

WARNINGS:
- W1 coverage-loss forward risk: exclusion is a STATIC list w/ NO guard. If heavy ever becomes high-frequency (new heavy workload firing >TTL-often), OR heavy's prefix caching genuinely breaks (0% vs 47%), §13 stays blind — docstring says track via `mc-ctl audit-claim cache-hit --stratify-by=agent_type` but nothing automated re-includes it.
- W2 razor-thin pass: fast alone = 80.51% vs 80.0 bar (0.51pt). Fix converts FAIL→PASS on a hair; a small fast dip re-fails. Not a defect — gate working as designed — but the "PASS" is fragile.

INFO:
- Docstring "measures 43-55% every single day" is FALSE for 2/14 days it cites: 06-27=77.6%, 06-28=75.7% (both had ~4 turns). Comment-only, thesis still holds.
- Docstring "78.6%" aggregate vs actual 78.29% (rolling-window timing). "$7.43/run" = cherry-picked 07-09 low; 24h=$8.20, recent avg ~$7.8.
- Stale JSDoc: interface fields `cacheableRuns`/`cacheableCostUsd` (lines ~80-83) still say only `NOT LIKE 'reflection:%'`, not updated to mention heavy.
- `NOT IN ()` empty-array edge: if GATE_COLD_START_AGENT_TYPES emptied, SQL syntax-errors (fail-loud, not silent) — guarded by const being non-empty.
