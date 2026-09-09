---
name: v82-combinator-r2-audit
description: R2 on 0c1a7d5 (combineVerdicts ||-pass -> true worst-of-two, fixing R1's Critical on a1634aa) — PASS W/WARN; the exit-code fix has no render, and the same collapse-null-to-green class is live in the untouched §14 gate
metadata:
  type: project
---

# R2 — `combineVerdicts` worst-of-two fix (`0c1a7d5`), 2026-08-02

Follow-up to [[v82-section17-6a-removal-audit]] (R1 on `a1634aa`). Verdict: **PASS WITH WARNINGS**, 1 Critical in-fix + 1 Critical-class adjacent.

## The fix itself is correct — verified, don't re-litigate

- All 9 input pairs of `combineVerdicts` are right (fail > insufficient_data > pass).
- The rewritten test **discriminates** — MUTATION-VERIFIED: restoring `||`-pass makes
  `v82-activation-gate.test.ts:224` fail (`expected 'pass' to be 'insufficient_data'`); restored 12/12 green.
- §13 (`src/briefing/activation-gate.ts:325`) tests measurability BEFORE thresholds — sound.
- `src/lib/v8-3/promotion.ts:118` is strict `!== "pass"` — `insufficient_data` refuses.
- Consumer sweep independently re-confirmed: **nothing branches on the exit code.** Both systemd
  units are spent dated one-shots (`v81-gate-check`, `v82-shadow-verdict`); the latter only
  `echo`s `${PIPESTATUS[0]}` into a log. No cron/CI/tool/`&&` chain.

## DOCTRINE

**An exit-code-only fix on an operator-facing CLI is invisible.** `scripts/briefing-gate.ts`
prints §13's verdict then §17's, and **never prints the combined verdict** (`:96-112`). On the
exact path the fix exists to expose (§13 `insufficient_data` + §17 `pass`) the terminal's LAST
line is `✅ PASS — V8.2 §17 activation gate met` while the process exits 2. Since no automation
reads the exit code either, the correction currently reaches nobody. When a fix changes a
verdict combinator, check the RENDER carries the new verdict — not just the return value.

**When you rewrite a combinator, grep the caller's prose for the OLD rule.**
`scripts/briefing-gate.ts:9` still says the exit "reflects whether **EITHER** layer is
activatable" — the `||`-pass rule in words. Worse, the new docstring
(`v82-activation-gate.ts:76-77`) and the commit message both assert "Exit 0 means what
scripts/briefing-gate.ts has always documented — BOTH gates met." The caller documents the
opposite. A docstring that cites another file's contract must be checked against that file.

**Vacuous-truth checks: a violation-count with no denominator is not a check.** The bug class
(un-measurable collapsed to green) is live and UNTOUCHED in §14:
`src/lib/v8-3/activation-gate.ts:116` `const linkagePass = unlinkedAutonomous === 0;` and
`:128` `const reversibilityPass = irreversibleAutonomous === 0;`. Both scope
`WHERE autonomy_level >= 3`, a population empty BY CONSTRUCTION (promotion.ts implements only
L1→L2; all 6 caps at `level=1`; `decisions` has 0 rows). The live gate today prints
`✓ linkage integrity: no L≥3 decision lacks a linked judgment` over zero rows. Once 7 ordinary
L1 decisions land, volume clears and the verdict flips to `pass` with the gate's entire safety
content never once evaluated — and `promotion.ts:190-192` writes those two vacuous ✓ lines into
the permanent ADR as promotion evidence. Contrast §17, which guards four denominators
(`v82-activation-gate.ts:273-277`, e.g. `measuredVerdicts === 0 ||`); §14 guards exactly one
(`:142`). **Discriminator: does the check's WHERE clause select a population that can be empty
for a reason unrelated to compliance?**

## Adjacent instances of the same class (all quoted, all live)

- `src/observability/prometheus.ts:292` `return { healthy: rituals.every((r) => !r.stale), rituals };`
  — `[].every()` is `true`; heartbeats written only on success (`:250`), so a never-fired
  scheduler reports healthy forever. (Recurrence of the [[hardening-sweep-2waves-closure-audit]]
  min-over-empty-series finding — same gauge, different collapse.) Nothing consumes
  `ritualsHealthy`: `scripts/healthcheck.sh:26` uses `-o /dev/null`.
- `src/api/routes/health.ts:83` `const status = dbOk ? "healthy" : "degraded";` — `inferenceOk`
  never enters status or code (`:84`). Inference unreachable → 200 `"healthy"`. And `:58`
  `inferenceOk = sdkCredentialsReady();` is a `statSync().size > 0` file test, not reachability.
- `scripts/watchdog.sh:57` collapses curl-fail / jq-fail / metric-absent into `""`; every
  consumer skips (`:299`, `:263`, `:272`, `:281`) and `:319` then prints
  `OK: all checks passed`. No `absent()` companion in `monitoring/alerts.yml` (0 hits).
- `scripts/eval-gate.ts:152` prints "too few for subtle regressions" then falls through to
  `:255 process.exit(g.verdict === "PASS" ? 0 : 1)` — `src/tuning/gate.ts:28` has no third state.

## Doc drift left behind by the correction

- `scripts/briefing-gate.ts:109-110` — "2 = still accumulating (the expected state while V8.2 is
  in its 7-day shadow)". False: §17 passes now; exit 2 means §13 went un-measurable.
- `scripts/briefing-gate.ts:41` — §13's `insufficient_data` label reads "shadow run still
  accumulating" for a gate ACTIVE since V8.1. Newly consequential.
- `README.md:381` still: "Arming delivery is the only path off §17's `insufficient_data`" —
  present-tense, contradicts the just-corrected `:380`.

Live state at audit: §13 **FAIL** (cache-read 71.9% < 80, the queued `nanoclaw` cold-start bug),
§17 **PASS**, combined exit **1**.
