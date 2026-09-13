---
name: certified-skill-flake-budget
description: Auditing a mission-control S5 skill (seed/skills/*/SKILL.md) — a green certification is n=1 evidence; check latency headroom and LLM-judgment assertions before trusting it.
metadata:
  type: feedback
---

A skill certified "16/16 pass" is n=1 evidence per test. `src/skills/test-sweep.ts`
re-runs every certified skill's tests every 6 h and decertifies on ANY non-pass;
`src/skills/retrieval.ts` gates retrieval on `is_certified = 1`, so one flaky tick
silently removes the skill from Jarvis.

**Why:** two failure modes are invisible in a green run and only surface days later.

**How to apply** — before accepting a certification, run these two checks:

1. Latency headroom. `sqlite3 -readonly data/mc.db "SELECT s.name, t.test_name,
   t.duration_ms, LENGTH(t.actual_output_json) FROM skill_test_runs t JOIN skills s
   USING(skill_id) ORDER BY t.id"`. The wall is `DEFAULT_TIMEOUT_MS = 30_000` in
   `src/skills/mini-runner.ts` and neither `test-sweep.ts` nor the dispatcher passes
   an override. Anything over ~20 000 ms is a scheduled decertification.
2. Judgment assertions. Every key in a test's `expect.output_match` is compared with
   `Object.is` (`deepPartialMatch`). Echo fields (inputs, defaults) are safe; a field
   the body derives by LLM judgment is a coin flip. Worse: check the body's own rule
   for that field — a conjunctive verdict rule ("X only if A and B and C") whose
   fixture does not visibly satisfy every conjunct is a contradiction, not variance.

Related: [[skill-error-envelope-costs-an-antilist-strike]].
