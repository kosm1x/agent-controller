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
   - `2` error, not a verdict. Before any spend: an unknown flag or a value flag without `=value` (`--probe-system jarvis`), a missing or unreadable baseline, a baseline captured under another `scoringVersion`, or one without its tool_selection population ids; a case the baseline probed is now excluded (scoping or the registry moved the scored population — fix it or re-capture; checked with a free mock pass, and again after the run). After the run: any tool_selection probe errored (an inference problem, not a regression — rerun when healthy; a capture writes nothing); `--update-baseline` probed no tool_selection case or fewer than half the active ones (nothing written); no cases; an error inside the run. Fix the harness problem and rerun; never report it as a pass. A `scoringVersion` or population refusal needs the operator's paid re-capture (`--run --update-baseline`).
   - `4` experiment run (`--cases-file` / `--probe-system`): scored, no verdict, baseline untouched; these flags refuse `--update-baseline`.
   - Exit `1` **with a stack trace and no score line** is also a harness error (a throw while snapshotting the DB happens outside the script's catch), not a FAIL.
5. Only the operator moves the incumbent (`--update-baseline`). Never pass it to make a FAIL go away, and never widen `--epsilon` to get a PASS.

## Know what a PASS proves

Only the `tool_selection` cases move on a model swap (the scope and classification cases are deterministic); quote the `tool_selection` counts the run prints (probed, excluded, unreachable slots) rather than remembered numbers. Only expected tools offered to the probe are scored; a case with none offered is excluded, so a falling probed count is a finding in itself. Scope accuracy currently rests on the hand-written cases only (the mined scope cases are inactive). New and removed cases since the baseline are printed as counts and are not an error. Nightly `tune_runs` scores are not comparable across the 2026-10-04 scoring change. A PASS rules out a gross tool-adherence collapse, not a subtle single-tool regression. Say that when you report it.
