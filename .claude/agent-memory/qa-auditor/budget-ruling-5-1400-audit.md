# Reading-budget ruling 4/700 → 5/1400 audit (PR #35, fe0bffa..eeee703, 2026-08-27)

**Verdict: PASS WITH WARNINGS — 2 Critical (both "the raise disabled the gate" class), 0 blocking regressions.**
Post-merge/post-deploy pass. 51/51 scoped GREEN; deploy verified in `dist/` (5/1400, unit restarted after the commit).

## The two findings worth carrying forward

### 1. Raising a cap can DELETE it — check a raised cap against the PRODUCT of its sibling caps
`WORD_CAP` 700→1400 made the word branch **structurally unreachable**. The population it governs is
bounded by the *per-push* caps it does not know about: non-anchor rows are capped to
`TELEGRAM_PUSH_WORD_CAP=250` (+~5-word pointer) BEFORE the budget check, and `PUSH_CAP=5` leaves only
3 optional slots. Empirical ceiling (mirror probe): telegram-only 5000w push records **255w**, emailed
records **129w**; a maxed day (357w sync + 3×255 + 259w close) = **1381w < 1400**. `overWords` first
fires only once the Morning Sync exceeds **636 words** — 1.78× the largest sync ever recorded (357).
At 700 the branch fired daily (08-25/26/27 ledger). **Rule: before raising cap A, compute
`slots × per-item cap` for the population A governs; if that product < A, A is inert.**

### 2. Mutation-verify a VALUE change by reverting to the OLD value
The classic absurd-value mutation is not enough. `WORD_CAP=99999` → 1 RED (looks pinned), but
**`WORD_CAP=700` (the old value) → 51/51 GREEN**: the only word-cap test seeds 1300w + pushes 200w =
1500, over BOTH constants. The ruled number was unpinned. Contrast `PUSH_CAP=4` → 5 RED (pinned).
**Rule: for a constant-change PR, the mandatory mutation is `constant := old value`.**

### 2b. A test that seeds a ledger row the producer cannot emit proves arithmetic, not reachability
The word-cap test `INSERT`s a delivered non-anchor row with `words=1300` — 5.1× the 255w structural
max. It replaced an older test that used only seam-produced rows. Such a test stays green while the
gate is dead in production, and hides finding #1.

## Method that worked (repeatable, read-only w.r.t. the repo)
Mirror the tree into scratchpad (`cp -r src`, `ln -s node_modules`, copy package/tsconfig/vitest
config) and mutate THERE — full mutation testing with zero repo writes. Replay the real ledger's fire
order (from `sqlite3 -readonly data/mc.db ritual_deliveries`) through `applyRitualDeliveryPolicy` in a
mirror-only probe test to get deliver/defer per ritual.

## Live shape of this seam (2026-08-27)
Fire order: market-morning-scan(emailed 50w) · signal-intelligence(emailed) · pm-daily-rebalance(188w)
· Morning Sync(anchor 305-357w) · 12:00 reading `bdb82f0c` · tweet `9e06a237` · market-eod-scan ·
nightly-close(anchor 111-145w). Under 5/1400 the ruling's goal is met (the 12:00 reading delivers at
719w used; day = 5p/864w) and tweet+eod defer on `push-cap`.
**`EMAILED_SHARE.pushes = 1` was NOT raised** — market-morning-scan takes the single emailed slot at
06:00, so `signal-intelligence` defers `budget: emailed-share` every day regardless of the ruling
(25w digest deferred while 100 of 150 emailed words go unused). That is the next blocker, not the caps.
Docstring "the anchors are ~350 words" is stale: live avg = 326 (sync) + 127 (close) = **453**.
