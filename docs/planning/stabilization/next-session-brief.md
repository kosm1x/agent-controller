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

**[P1-A] 24h cost re-measure** — _data-gathering, no code_

- Question: does $0.41 → $0.25 per-task hold across a full mixed-traffic day?
- How: query `cost_ledger` filtered to post-deploy timestamp (Session 109 deploy completed ~22:00 MX 2026-04-26). Print N + window + per-PID breakdown. Honor the protocol from `feedback_metrics_extrapolation.md` — sample list before AVG, drop first N tasks after each mc restart, write the math for any extrapolation.
- If holds: fold into next benchmark + close as a stabilization win.
- If not: find the confounder (probably either prompt-cache warmup behavior or a scope-distribution skew in the n=5 sample).
- **Hard rule**: do not headline a savings number tomorrow without N≥30 and the sample window printed inline. No more n=1-as-trend.

**[P1-B] Hindsight recall re-eval** — _15 min probe_

- Disabled by default since 2026-04-25 (`HINDSIGHT_RECALL_ENABLED=false`). The CE reranker was 22.2s on 244 candidates against a 1.5s client cap.
- Probe: hit the recall endpoint manually with a known-warm query, time it.
  - If <1s: re-enable, watch for one full day, re-evaluate.
  - If still 22s+: leave disabled, file a ticket on the upstream service, move on.
- Don't re-enable speculatively. Disabled is the correct state until measured otherwise.

### P2 — known small cleanups (pick if time)

**[P2-A] Replan KB regression test** — _20 min_

- Lesson from `feedback_kb_injection_extraction.md`: enforce-only KB landed in `plan()` first, missed `replan()` (caught by audit, fixed, but no test guards it).
- Add: a test that captures the system prompt of both `plan()` and `replan()` and asserts the `[JARVIS KNOWLEDGE BASE]` marker plus a known-enforce title appears.
- File: `src/prometheus/planner.test.ts` (extend existing), or new test if missing.

**[P2-B] `learner_model_status` matcher coverage test** — _10 min_

- Audit caught one miss. Already fixed via the table-driven rewrite (`439cfcc`), but the regression test that asserts `conditionMatches("teaching", ["learner_model_status"]) === true` is in `src/messaging/kb-injection.test.ts:25-28`. Verify it covers all teaching-scope tools symmetrically (every tool in `TEACHING_TOOLS` should match the `teaching` keyword). One iterating test.

**[P2-C] `react\b` regex tightening in coding-scope** — _cosmetic, deferable_

- Flagged during earlier audit as prompt bloat. Not urgent. Pick only if P0/P1 finish fast.

### P3 — calendar

- **2026-05-22**: day-30 re-benchmark. ~26 days out from end-of-Session-109. Compare against `docs/benchmarks/2026-04-22-baseline.md`. Exit criteria from `30d-hardening-plan.md`: all P0 closed, P1 triaged, audit report filed, measurable improvement on efficiency + resilience.

---

## Out-of-scope reminders (do NOT pick up casually)

- **Stealth browser fingerprint injection** (`/root/.claude/plans/replicated-jingling-castle.md`) — adds dependency + new capability surface. Feature, not hardening. Park until freeze lifts unless a bot-detection incident promotes it.
- **New tools, runners, scope groups, scheduled tasks** — all freeze-violations per separation policy.
- **Jarvis autonomous-build adoption into mc-core** — MCP bridge only; no `src/tools/builtin/*.ts` additions.

---

## Health snapshot at session close

| Item                     | State                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| Service                  | `mission-control` active, no recent errors                           |
| Tests                    | 3817 passing, 0 type errors                                          |
| Disk                     | 26 GB free / 96 GB                                                   |
| Branch state             | `main` clean; all session work pushed to `origin/main`               |
| Hindsight recall         | DISABLED (env-flag); retain/reflect/consolidation paths active       |
| Stabilization audit      | All 5/5 dimensions CLOSED (session 101 baseline)                     |
| Open carry-forward count | 3 (P0-A, P1-A, P1-B) + 3 small cleanups (P2-A/B/C) + 1 calendar (P3) |

---

## Operating notes for tomorrow

1. **No new features.** If a "small enabler" feels in-scope, re-read the separation policy in `30d-hardening-plan.md` first.
2. **Verify before reporting.** If the user asks "audited?", re-query the data with fresh eyes — don't re-read your own report. The discipline in `feedback_metrics_extrapolation.md` is a hard rule now, not a guideline.
3. **One commit per logical change.** Today's session ran 7 commits across 4 lanes (gmail, matcher, extraction, SOP-split). The lane separation made the audit + revert math easy. Keep that pattern.
4. **Pre-commit hook runs full suite (~140s).** Don't trigger it manually with `vitest run` — use scoped `vitest run <file>` (1.3s). The OOM event of 2026-04-25 came from 9 unscoped runs in 12 min.
