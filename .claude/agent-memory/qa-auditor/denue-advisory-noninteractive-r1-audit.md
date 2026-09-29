---
name: denue-advisory-noninteractive-r1-audit
description: 09-29 audit of DENUE advisory "none" variant for non-interactive tasks + reaction retries forwarding interactive:false + sent-before wording; PASS-W-WARN.
metadata:
  type: project
---

Verdict PASS WITH WARNINGS, 0 Crit, tsc 0, 175/175 (3 test files, not 4).

- Call-site mutant (`highStakesGuardVariant(input.tools)` without `input.interactive`) SURVIVED: only the pure fn is tested; no execute-level test of the guard exists.
- `\btop \d+` matched 5 rituals (morning, nightly, weekly-review, market scans): they got the advisory EVERY run; nightly-close 09-28 output literally says it ignored the shell_exec instruction. Fix removes it for them too.
- Forwarding interactive:false on reaction retries lifts the confirmation gate for gmail_send/tweet_post (both high-risk): matches first attempt, but opens a duplicate-send path when attempt 1 sent then failed (timeout/BLOCKED). 2 schedule retries in 90d.
- eval:gate never runs fast-runner: `eval-runner.ts` calls infer() with user msgs + tool defs only, no system prompt. So NO fast-runner prompt change is measurable by the gate.

**Why:** CLASS: a regex guard keyed on generic words (`top 3`, `oportunidades`) fires on populations far outside its domain; enumerate the population before judging a fix's blast radius.
**How to apply:** for any fast-runner system-message guard, grep ritual prompts + scheduled_tasks descriptions against the trigger regex first.
