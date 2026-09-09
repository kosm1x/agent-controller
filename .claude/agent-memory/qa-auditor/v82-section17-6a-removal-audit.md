---
name: v82-section17-6a-removal-audit
description: "Audit of a1634aa (2026-08-02) — deletion of §17 check 6a (green/red brief promote-ratio) from the V8.2 activation gate. PASS WITH WARNINGS, 1 Critical."
metadata:
  type: project
---

# §17 check 6a removal — `a1634aa` (2026-08-02)

**Verdict: PASS WITH WARNINGS.** 1 Critical (exit-code masking), 2 Warnings, 2 doc-drift.
13 files, +149/−424. Removed check 6a + `briefConfidenceColor` + `GATE_V82_PROMOTE_RATIO`
+ `GATE_V82_MIN_ACCEPTANCE_BRIEFS` + `GATE_V82_ACCEPTANCE_SINCE` + `promoteRatio` field.
§17 went FAIL → PASS (5 checks).

## DOCTRINE (transferable)

- **Deleting a check that was PINNING a gate un-pins the gate's combinator.** `combineVerdicts`
  (`src/briefing/v82-activation-gate.ts:86`) is `||`-pass: `pass` if EITHER gate is green.
  While §17 was permanently fail/insufficient (6a stuck at ~1.0), a §13 degradation to
  `insufficient_data` still surfaced as exit 2. With §17 now permanently green, §13 regressing
  to `insufficient_data` is MASKED → exit 0. **When you remove the check that kept gate B
  non-green, re-derive every combined verdict involving gate A.** The commit's own rationale
  ("the CLI would have gone green without ever measuring calibration") describes the harm it
  then relocated onto §13.
- **Proving a combinator regression: run the OLD module against the SAME DB snapshot.**
  `git show <commit>^:path > /tmp/old.mts`, sed the relative imports to absolute, `initDatabase`
  on a `copyFileSync` snapshot, call both evaluators. Same data, exit 2 → exit 0 = proven, not
  argued. (tsx needs `.mts` for top-level await; `MC_DB_PATH` is IGNORED by `scripts/briefing-gate.ts`
  — it hardcodes `DB_PATH` relative to the script.)
- **Count the OPERATOR-GROUNDED terms after removing a check.** 6a was §17's only human signal.
  The 5 survivors (schema, judgment count, resolver, critic-LLM, sycophancy-probe-LLM) are all
  machine-generated, so §17 now certifies "activatable" fully self-referentially. Removing a
  check can silently convert a gate from human-validated to self-validated.
- **Verify a "removed too much" sweep by RUNNING the consumers outside the typecheck root.**
  `tsconfig.json` includes only `src/**/*.ts`, so `scripts/*.ts` + `mc-ctl` (bash) are NOT
  typechecked — `scripts/judgments.ts` printed `acceptance undefined×` with tsc clean. Repo
  precedent: always `./mc-ctl <cmd>` every CLI that reads the changed module.
- **A partial comment sweep leaves SELF-CONTRADICTORY operator output.** `mc-ctl cmd_verdict_rate`
  footer was updated to "NO S17 check reads these" while its own `=== S17 acceptance window ===`
  headers (mc-ctl:1842,1849) and the help entry (mc-ctl:1914) still say §17. Sweep headers +
  help text, not just the footer.

## Verified CLEAN (do not re-flag)

- No live consumer of any removed symbol. Survivors are prose only (module doc, spec, README
  history, `dist/` doc-comment; `dist/` is gitignored). `mc-ctl judgments` + `mc-ctl briefing-gate`
  both run clean, exit 0.
- **Nothing auto-arms.** `evaluateV82Gate` has exactly 2 callers, both tsx scripts. No ritual/
  cron/systemd/watchdog reads it. `scripts/v83-gate.ts:59` + `scripts/v83-promote.ts:74` only
  PRINT that L≥3 additionally needs §17 — no programmatic verdict read.
- **`insufficient` guard is sound** despite losing the `promoteRatio === null` term: each of the
  4 data-bearing checks has its emptiness mirrored in the disjunction (`judgments7d`,
  `claimAgg.total`, `measuredVerdicts`, `probeAgg.total`). No window passes with no data.
- **No orphaned test coverage.** All 11 deleted tests were 6a/`briefConfidenceColor`-only. The
  lead-first/plurality/tie-break logic was internal to `briefConfidenceColor`;
  `src/lib/v8-2/judgment-render.ts` has an INDEPENDENT `DISPLAY_PRIORITY` (ordering, not colour
  derivation) + `confidenceDot`, covered by its own 14 green tests.
- New operator Spanish in `no-verdict-reminder.ts:91` is TRUE in practice: `proposed_briefings`
  has exactly one surface (`morning`, 73/73) and §13 check 2 filters `surface==='morning'`.
  Latent only: `composeReminder`'s non-morning branch (line 85) would make the §13 claim false,
  where the old §17 claim was surface-agnostic. No test pins the old string.
- 468 briefing + v8-2 tests green; `tsc --noEmit` 0.

## Cross-links

[[v82-phase17-gate-audit]] (the dormant-gate-OR'd-into-exit-code class — same combinator),
[[v81-section13-heavy-exclusion-audit]] (§13's razor-thin pass), [[v82-6a-verdict-affordance-audit]]
(the explicit-verdict rebuild 6a rested on).
