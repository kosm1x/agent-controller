---
name: skill-error-envelope-costs-an-antilist-strike
description: In mission-control S5 skills, a body-level {"error":...} return is a wrong_output failure that burns an anti-list strike; required:true inputs make the body's INPUT_REQUIRED path unreachable.
metadata:
  type: feedback
---

Two contract facts that make "step 1. Validate → return `{"error":"INPUT_REQUIRED"}`"
misleading in a SKILL.md, even though every seed skill in the repo is written that way.

**Why:**
- `src/skills/dispatcher.ts` treats any output with a non-empty `error` string as
  `wrong_output` and calls `incrementFailure`. Three consecutive user mistakes push
  `consecutive_failures` to 3 and `src/skills/retrieval.ts` hides the skill.
- An input declared `required: true` is a non-optional Zod field
  (`src/skills/inputs.ts`), so the dispatcher rejects the call as `input_validation`
  BEFORE the body runs. The body's own INPUT_REQUIRED text never executes in
  production — only the test-runner's mini-executor, which bypasses the dispatcher,
  reaches it.

**How to apply:** when a test asserts `expect_error: {class: "INPUT_REQUIRED"}` on a
required field, say so and propose the empty-string fixture (`{"field": ""}`) instead
— it passes Zod, reaches the body, and exercises the path production actually uses.
Prefer designing invalid values out of the schema (enums) over erroring on them.

Related: [[certified-skill-flake-budget]].
