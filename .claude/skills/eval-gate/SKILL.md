---
name: eval-gate
description: Run the model-swap eval gate before shipping any model-id, system-prompt or tool-description change, and act on its verdict. Use whenever a diff touches a model id, a prompt module, or a tool's description/schema text.
---

# Eval gate

CLAUDE.md rule: before ANY model-id, system-prompt or tool-description change, run the gate and do not ship on a FAIL. Background and limits are in the header comment of `scripts/eval-gate.ts` and `docs/CLAUDE-REFERENCE.md` (Development section).

## Where it can run

The gate reads the live service's environment from `/proc/<pid>` and scores against a snapshot of `data/mc.db`. It runs **only on the VPS**. In a cloud session even the dry run fails (`Cannot open database because the directory does not exist`). In a cloud session, do not try to fake it: finish the change, and write "eval:gate owed (VPS, operator-run)" in the PR description and the ROADMAP session log row, so nobody merges it as gated.

## Steps (VPS)

1. Confirm the change is in scope: `git diff` touches a model id (`src/inference/`, env defaults), a prompt (`prompt_modules`, system-prompt builders) or a tool description / Zod `.describe()` text. Refactors that leave those strings byte-identical do not need the gate; say which strings you compared.
2. Free check first: `npm run eval:gate` (dry). Exit 3 is expected; it only proves the harness loads.
3. Real run, which spends money (about $5 and 13–15 minutes): `npm run eval:gate -- --run`. Do not run it in a loop or in parallel.
4. Read the exit code:
   - `0` PASS (score ≥ incumbent − epsilon): record the score and incumbent in the PR / status row.
   - `1` FAIL: do not ship. Report the score, the incumbent and which case family dropped; the fix goes back to an implementer.
   - `2` error (no cases, missing baseline, an error inside the run): not a verdict. Fix the harness problem and rerun; never report it as a pass.
   - Exit `1` **with a stack trace and no score line** is also a harness error (a throw while snapshotting the DB happens outside the script's catch), not a FAIL.
5. Only the operator moves the incumbent (`--update-baseline`). Never pass it to make a FAIL go away, and never widen `--epsilon` to get a PASS.

## Know what a PASS proves

Only the `tool_selection` cases move on a model swap (the scope and classification cases are deterministic); quote the `tool_selection` count the run prints rather than a remembered number. A PASS rules out a gross tool-adherence collapse, not a subtle single-tool regression. Say that when you report it.
