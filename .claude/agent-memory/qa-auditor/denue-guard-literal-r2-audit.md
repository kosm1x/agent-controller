---
name: denue-guard-literal-r2-audit
description: 09-29 R2 of DENUE guard: ownTools per-task Set in runToolContext + taskRunTools, file-marker cut, (?<!\p{L})denue(?!\p{M}) regex; PASS-W-WARN.
metadata:
  type: project
---

Verdict PASS WITH WARNINGS, 0 Crit, tsc 0, 499/499 (13 files), 7/7 mutants RED (ownTools shared/unshared, cut skipped on either path, lookbehind dropped, cron/retry detectionText dropped).

- toolsSoFar readers are only priorRunTools (registry.ts:308, v8-4/provenance-gate.ts:149, v8-3/trigger.ts:65); store built only in enterRunToolContext, so ownTools can never be undefined.
- Marker literal is NFC in both fast-runner.ts:111 and telegram.ts:508, but NO test pins them (test hardcodes the string).
- Regex has no trailing-letter guard: `denuevo` (typo of "de nuevo"), `denuedo`, `denuesto` fire; 0/4063 scope_telemetry messages today.
- No direct rule-of-two.test for taskRunTools; only heavy-runner tests pin it.

**Why:** CLASS: a cut keyed on another module's literal silently dies when that module rewords; pin producer and consumer with a shared export or a cross-module test.
**How to apply:** for any string-marker parse across modules, grep both sites and require an import or an asserting test.
