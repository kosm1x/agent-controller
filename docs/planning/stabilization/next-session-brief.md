# Next Session Brief — Hardening Phase

> **Authored**: 2026-04-26 end-of-Session-109
> **Window**: 2026-04-22 → 2026-05-22 (day 4 of 30 at next session start)
> **Re-benchmark target**: 2026-05-22 vs `docs/benchmarks/2026-04-22-baseline.md`
> **Phase posture**: Hardening + reliability only. Feature freeze in effect — see `30d-hardening-plan.md` separation policy.

---

## Where Session 109 left things

**Landed today** (6 commits on `main`, all pushed):

| Commit    | Lane                | Change                                                                                                                                                                    |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `534f60b` | reliability         | `gmail_send` forces plain text — strips HTML at handler boundary                                                                                                          |
| `a0d3f22` | reliability         | `gmail_send` HTML strip hardening + audit fixes                                                                                                                           |
| `5b9093f` | KB bloat            | `code-generation-sop.md` always-read → `coding`-conditional; `active-plans.md` → `teaching`                                                                               |
| `439cfcc` | matcher correctness | Table-driven `conditionMatches` against canonical scope groups; `learner_model_status` no longer silently missed                                                          |
| `be46714` | architectural gap   | KB injection extracted to `src/messaging/kb-injection.ts`; wired into Prometheus heavy/swarm planner + executor (`enforce` directives no longer skipped on those runners) |
| `9e3102e` | KB bloat            | SOP split: 30.6 KB → 4.7 KB; project evaluations moved to `knowledge/journal/code-evaluations.md` (qualifier=reference, never auto-injected)                              |
| `f325e78` | tests               | Drop brittle "Journal" substring assertion (re-audit Rec-1)                                                                                                               |

**Net effect**:

- Always-injected KB pile: 34.7 KB → 2.8 KB on non-coding tasks (−92%)
- Coding-scope KB injection: 30 KB → 4.7 KB per task
- Heavy/swarm runners now receive `enforce` directives (was zero before — Major architectural gap closed)
- Hindsight `recall()` failures: 86% → 0% (env-flag bypass since 2026-04-25)
- Per-task cost on Sonnet (post-deploy n=5): $0.41 → $0.25 (−39%) — **needs N>>5 verification, see P1 below**
- Tests 3783 → 3817 (+34)

**Trust caveat**: I (Claude) headlined six wrong before/after numbers earlier this session and self-corrected on operator's "Audited?". The directional claims held; magnitudes were off by up to 2.4×. The cache-hit "97% → 65%" framing was extrapolated from a single warm-cache moment and is the kind of error that self-feedback was added to prevent — see `feedback_metrics_extrapolation.md`. Apply the same skepticism to today's $0.41 → $0.25 number: it is an n=5 snapshot, not a trend.

---

## Tomorrow's queue

### P0 — credential hygiene

**[P0-A] AV API key rotation** — _10–15 min, blocked on operator_

- Plaintext key was logged to `journalctl` earlier this week through `scripts/fetch.sh` invocation. Treat as exposed.
- Steps: rotate at alphavantage.co → update env on radar repo + mc → restart both → confirm a fresh fetch succeeds → optional: `journalctl --vacuum-time=...` to scrub.
- Owner: operator (key-source side); Claude can do the env edits + restarts once new key is provisioned.
- Why now: this has been on the carry-forward list for multiple sessions. Each day it sits is another day of valid-but-exposed credential.

### P1 — verify recent fixes hold under real traffic

- ~~[P1-A] 24h cost re-measure~~ — **DONE 2026-04-26.** Real delta: $0.2142 → $0.2035 per task (n=55 vs n=6, −5%). Original "$0.41 → $0.25 (−39%)" headline was wrong on every dimension — extrapolated from n=5 without checking cache structure. Aggregate cache-read ratio dropped 83% → 59% post-deploy: KB-prefix variability ate most of the prompt-shrink savings. **Follow-up next session**: re-measure with N≥30 post-deploy across full mixed-traffic day. Architectural lesson captured in `feedback_cache_prefix_variability.md` and folded into V8-VISION §3-S1.
- ~~[P1-B] Hindsight recall re-eval~~ — **DONE 2026-04-26.** Probed 4 times across 2 banks: mc-jarvis 16.6-18.1s (essentially unchanged from 22.2s baseline), mc-operational 3.4s. Both still over the 1.5s client cap. Decision: leave disabled. Operator action: file upstream ticket with `vectorize-io/hindsight` on CE rerank latency. `HINDSIGHT_RECALL_ENABLED` stays `false`.

### P2 — known small cleanups

**All three shipped end-of-session 2026-04-26 (post-P1 verification turn).** See commit detail below.

- ~~[P2-A] Replan KB regression test~~ — **DONE** (`planner.test.ts` +3 cases, asserts `[JARVIS KNOWLEDGE BASE]` + `MANDATORY:` marker in both `plan()` and `replan()` system prompts; differentiating mock catches qualifier-set widening regressions)
- ~~[P2-B] Symmetric matcher coverage~~ — **DONE** (`kb-injection.test.ts` +10-row `it.each` iterates every tool in every scope group; catches future silent-miss class)
- ~~[P2-C] `react\b` tightening in coding scope~~ — **DONE** (`scope.ts:508`; `Reactivar`/`reactor`/`reacción` no longer fire coding scope; regression test in `scope.test.ts`)

### P2-followup — wider coding-regex `\b` sweep (deferred, not freeze-blocking)

Audit during P2-C found the same prefix-match defect class on ~12 other bare alternations in the coding regex (`scope.ts:508`). High-impact realistic Spanish FPs (each pulls `shell_exec`/`file_edit` on benign chatter):

| Bare alt                                    | FP example                                              | Correct intent |
| ------------------------------------------- | ------------------------------------------------------- | -------------- |
| `programa(r\|ción)?`                        | "el programa de TV", "el programa de fidelidad"         | non-coding     |
| `rutina`                                    | "mi rutina diaria", "rutina del gimnasio"               | non-coding     |
| `funci[oó]n`                                | "la función de teatro", "la función del corazón"        | non-coding     |
| `estructura`                                | "la estructura organizacional"                          | non-coding     |
| `directori`, `carpetas?`, `servidores?`     | physical org references                                 | non-coding     |
| `commit`, `code`, `repositori`, `archivos?` | English "commitment"/"committee", ES "archivos físicos" | non-coding     |

Cleanest fix: append `\b` to the closing `)/i` of the outer group (mirrors the browser regex pattern at `scope.ts:503`). Sweep the multi-word alternations (`agrega\s+...`, `node\.?js`) to verify they don't break. Likely a 1-line change + 4 regression tests. Not picked up this session because it exceeds the "surgical" freeze-bundle scope. Promote to P2 next session.

### P3 — calendar

- **2026-05-22**: day-30 re-benchmark. ~26 days out from end-of-Session-109. Compare against `docs/benchmarks/2026-04-22-baseline.md`. Exit criteria from `30d-hardening-plan.md`: all P0 closed, P1 triaged, audit report filed, measurable improvement on efficiency + resilience.

---

## Out-of-scope reminders (do NOT pick up casually)

- **Stealth browser fingerprint injection** (`/root/.claude/plans/replicated-jingling-castle.md`) — adds dependency + new capability surface. Feature, not hardening. Park until freeze lifts unless a bot-detection incident promotes it.
- **New tools, runners, scope groups, scheduled tasks** — all freeze-violations per separation policy.
- **Jarvis autonomous-build adoption into mc-core** — MCP bridge only; no `src/tools/builtin/*.ts` additions.

---

## Health snapshot at session close

| Item                     | State                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service                  | `mission-control` active, no recent errors                                                                                                                                                                                                                   |
| Tests                    | 3832 passing, 0 type errors                                                                                                                                                                                                                                  |
| Disk                     | 26 GB free / 96 GB                                                                                                                                                                                                                                           |
| Branch state             | `main` clean; all session work pushed to `origin/main`                                                                                                                                                                                                       |
| Hindsight recall         | DISABLED — probed 2026-04-26: mc-jarvis 16-18s (unchanged from baseline). Leave disabled, file upstream                                                                                                                                                      |
| Stabilization audit      | All 5/5 dimensions CLOSED (session 101 baseline)                                                                                                                                                                                                             |
| 24h cost re-measure      | Real delta $0.2142 → $0.2035 (−5%) on n=55 vs n=6 — original "$0.41 → $0.25 (−39%)" headline was wrong. Cache hit ratio dropped 83% → 59% post-deploy (KB-prefix variability ate most of the prompt-shrink savings). Re-measure with N≥30 post-deploy needed |
| Open carry-forward count | 1 (P0-A AV key) + 1 (P2-followup wider regex sweep) + 1 calendar (P3 day-30 re-benchmark)                                                                                                                                                                    |

---

## Operating notes for tomorrow

1. **No new features.** If a "small enabler" feels in-scope, re-read the separation policy in `30d-hardening-plan.md` first.
2. **Verify before reporting.** If the user asks "audited?", re-query the data with fresh eyes — don't re-read your own report. The discipline in `feedback_metrics_extrapolation.md` is a hard rule now, not a guideline.
3. **One commit per logical change.** Today's session ran 7 commits across 4 lanes (gmail, matcher, extraction, SOP-split). The lane separation made the audit + revert math easy. Keep that pattern.
4. **Pre-commit hook runs full suite (~140s).** Don't trigger it manually with `vitest run` — use scoped `vitest run <file>` (1.3s). The OOM event of 2026-04-25 came from 9 unscoped runs in 12 min.
