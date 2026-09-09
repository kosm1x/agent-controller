---
name: finance-video-slice-audit
description: finance/video/skills/api/boot domain-module audit (2026-07-05) + grep-v-test false-positive trap
metadata:
  type: project
---

# Domain-module slice audit (2026-07-05)

Read-only structural audit of src/finance (13.4k LOC #2 dir), video, skills, api, boot.

## DOCTRINE — the `grep -v test` filename trap (COST ME A FALSE "DEAD CODE" CLAIM)
Excluding test files with `grep -v test` ALSO deletes any source file whose NAME
contains "test" — e.g. `src/tools/builtin/backtest.ts`. I first reported runCpcv/
runWalkForward/computeOverfitMetrics as "NO caller / dead" — WRONG: backtest.ts (the
live tool, builtin.ts:354 `backtestRunTool`) imports all of them, but `grep -v test`
filtered it out. Correct filter: `grep -vE '\.test\.ts:'` (anchor the extension).
Same class as the quote-the-line rule: never claim "dead/missing" from a grep whose
exclusion pattern is a bare substring.

## Verified findings (finance is a bolt-on quant subsystem, F7/F8/F8.1 sprints Apr-May 2026, all deferred-scope-gated so 0 prompt cost, 43/48 files tested)
- **DEAD TRIANGLE (~940 LOC)**: hrp.ts(382)+black-litterman.ts(383)+allocators.ts(174)
  form a closed import ring — nothing imports hrp; allocators feeds only hrp;
  black-litterman's only used export (equilibriumReturnsReverse) feeds only allocators.
  Single-commit 2026-05-07, no tool, no dynamic import, no barrel. Abandoned HRP/BL
  portfolio-optimizer. Safe KILL candidate.
- **DUP paper stacks**: paper-persist.ts vs pm-paper-persist.ts are 1:1 structural
  clones (P&L line byte-identical: `(fillPrice - avg_cost) * shares` at :183 / :199),
  parallel table CRUD (paper_* vs pm_paper_*). VenueAdapter interface (venue-types.ts)
  unified the ADAPTER interface but persist/executor layers were hand-cloned. Equity
  stack 934 LOC / PM stack 1118 LOC. Merge = parameterize by table/venue.
- Money as JS floats throughout paper ledgers → totalEquity/P&L drift (Medium, paper $).

## video/ — SOUND arch, ONE real bug
composer.ts uses execFile (not shell) + worker-pool scene fan-out (execFileAsync) —
good. BUT 5 assembly steps use **execFileSync** (composer.ts:111 concat, 168 final
encode [FFMPEG_TIMEOUT_MS=120_000, final 2x=240s], 241/265/302 crop/narration/mix) →
BLOCK the shared single-process event loop up to 2-4 min. Fire-and-forget runPipeline
(video.ts:223) only defers the RETURN, not the CPU. Fix: execFileAsync (already defined
composer.ts:19). Temp cleanup is LAZY-only (cleanupJob 24h TTL fires only when a job is
re-polled; never-polled /tmp/video-jobs/<id> orphan forever — no periodic sweep).

## skills/api/boot — clean
- skills: loader runs ONCE at boot (index.ts:132), not per-call. No per-call registry rebuild.
- api: all /api/* behind apiKeyAuth+rate-limit; /metrics privateOrApiKeyAuth; constant-time
  key compare (auth.ts). No missing-auth route. better-sqlite3 sync-by-design.
- boot: cron regs are lazy dynamic import(). Minor: index.ts:181-190 serial awaits
  (initMemoryService→migrate→seed) but only under hindsight backend (off).
