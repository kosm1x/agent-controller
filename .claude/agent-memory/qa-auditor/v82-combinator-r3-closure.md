---
name: v82-combinator-r3-closure
description: R3 verdict-verification on 79fe18d (print the combined verdict) closing the 3-commit §17-6a bundle — PASS WITH WARNINGS, no Critical; all 3 combined verdicts empirically forced on a snapshot DB; honest blame split shows 0 of 8 prior findings were bundle-authored lines
metadata:
  type: project
---

# R3 — combined-verdict render (`79fe18d`), bundle closure, 2026-08-02

Closes [[v82-section17-6a-removal-audit]] (R1 `a1634aa`) → [[v82-combinator-r2-audit]] (R2 `0c1a7d5`).
**PASS WITH WARNINGS. No Critical.** Streak of fix-bugs is 3/3 but severity is
CONVERGENT: Critical (masked §13) → Critical (invisible verdict) → Warning (mislabeled cause).

## DOCTRINE

**Force every verdict on a snapshot; never assert an exit code from code reading.**
`scripts/briefing-gate.ts` ignores `MC_DB_PATH` — it hardcodes `DB_PATH` as `<script>/../data/mc.db`.
Recipe that works: build `/tmp/harness/{data,scripts}`, `copyFileSync` mc.db+`-wal`+`-shm` → `data/mc.db`
(chmod 600), `ln -s <repo>/src` and `<repo>/node_modules`, `cp scripts/briefing-gate.ts scripts/`,
then `npx tsx harness/scripts/briefing-gate.ts`. Node resolves the symlinked `src` to its realpath so
its own imports work. Mutate only the snapshot: +5 `fast` rows at 5M prompt/5M cache_read → exit 0;
+1 row at 100M prompt/0 cache_read → exit 1. Baseline reproduced live exit 2 first — always confirm
the harness matches the real CLI before trusting a forced state.

**A headline that names ONE cause of a multi-cause state will eventually name the green one.**
`scripts/briefing-gate.ts:47-48` `insufficient_data: "⏳ INSUFFICIENT DATA — not enough ruled briefs
to measure §13"` — but `src/briefing/activation-gate.ts:325` is
`if (!cacheReadMeasurable || !promoteMeasurable)`. Live at audit the ruled-brief check was ✓ (75% over
8 ruled) and cache-read was ✗ (19 < 20 runs): the headline named the passing check. The R2 fix replaced
a VAGUE-but-safe string ("shadow run still accumulating") with a SPECIFIC-but-wrong one. Specificity in
a status label is only an improvement if it is derived from which term actually failed.

**"Both sides corrected; neither still claims it" is a grep-checkable claim — check it.**
The R2 sweep fixed `scripts/briefing-gate.ts:9` + the `combineVerdicts` docstring but missed a THIRD
site: `docs/planning/v8-capability-2-spec.md:651` (activation runbook step 3) still reads "V8.1 §13
stays exit 0 — the combined verdict does NOT demote a passing V8.1 during the V8.2 shadow" — the
`||`-pass rule, in the runbook an operator follows. Sweep with `grep -rn "EITHER layer\|does NOT
demote"`, not by memory of which files you edited.

**Re-verify the tsconfig trap the SAME bundle already documented.** `79fe18d`'s message claims "tsc
enforces the label map covers every GateVerdict". False: `tsconfig.json:22` is `"include":
["src/**/*.ts"]` and `npx tsc --noEmit --listFilesOnly | grep -c scripts/briefing-gate.ts` → **0**.
No test touches `COMBINED_LABEL` either. A 4th `GateVerdict` renders `undefined` — the exact
`acceptance undefined×` failure `a1634aa` hit in `scripts/judgments.ts` one commit earlier.

**A doc line-ref written in the same commit that shifts the file is born stale.** Queue item 4 cites
`v82-activation-gate.ts:273-277` for §17's four denominators; `79fe18d`'s own +2-line docstring edit
moved them to `275-279`. Compute doc refs AFTER the code edit, or cite symbols.

## Honest scoreboard (blame rule: line introduced/last-modified inside the 3 commits)

| Finding | Blame | Class |
|---|---|---|
| R1-C1 `\|\|`-pass combinator | `1968682e` 2026-06-19 | pre-existing LINE, harm created by `a1634aa` |
| R2-C1 combined verdict unprinted | `1968682e` 2026-06-19 | pre-existing ABSENCE, harm created by `0c1a7d5` |
| R2-A1 §14 vacuous linkage/reversibility | `0f48a39f` 2026-07-06 | pre-existing, other subsystem |
| R2-A2 `prometheus.ts:292` | `34fbb4f6` 2026-07-05 | pre-existing |
| R2-A3 `health.ts:83` | `33c598f` 2026-03-12 | pre-existing |
| R2-A4 `watchdog.sh:57` | `0bf45dfc` 2026-04-24 | pre-existing |
| R2-A5 `eval-gate.ts:152` | `bed561fd` 2026-07-05 | pre-existing |
| §13 nanoclaw cold-start | `3a21da26` 2026-07-10 | pre-existing |
| **R3-W1 §13 label names false cause** | **`79fe18d`** | **only bundle-AUTHORED defect, all rounds** |

**Zero of the 8 prior findings sit on a line the bundle wrote.** Both flattering framings are wrong:
it did not "catch 2 regressions it introduced" (no line was newly buggy), and it is not "clean"
(it broke two invariants held by untouched code). Accurate: *the bundle invalidated the premise two
pre-existing lines depended on.* Record that distinction — blame-classifying an audit scoreboard
separates "we wrote a bug" from "we changed a premise", and only the second class is invisible to
code review of the diff.

## Verified CLEAN (do not re-flag)

- `main()` has NO early return — single `return` at `:133`; the no-briefings `else` at `:102-106`
  falls through. Combined section prints on every non-throwing path. Only gap: an exception exits 1
  with no Combined line (stack trace shown) — Recommendation, not a defect.
- All three labels ↔ exit codes EMPIRICALLY matched (0/1/2), not argued.
- Doc refs that DO check out: `v8-3/activation-gate.ts:116,128,111,123,142`; `prometheus.ts:292,250`;
  `health.ts:83,84,58`; `watchdog.sh:57,319`; `eval-gate.ts:152,255`; `tuning/gate.ts:28`;
  `activation-gate.ts:81`; README:380-381; module doc "ALL FIVE" checks.
- Observability intact: every CLI deletion across the bundle is a RELABEL, not a drop.
  `mc-ctl judgments` / `verdict-rate` / `briefing-gate` all render coherently.
