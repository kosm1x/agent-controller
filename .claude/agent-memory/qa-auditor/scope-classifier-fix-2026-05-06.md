---
name: scope-classifier-fix-2026-05-06
description: Audit of 4 narrow fixes for Jarvis scope-classifier DENUE/SQL miss (2026-05-06 incident); PASS WITH WARNINGS; FP surface on scoring/denue tokens, regex list drift, missing test for debug log
type: project
---

# Scope-classifier Fix Audit (2026-05-06)

**Verdict:** PASS WITH WARNINGS. 4 narrow fixes for a real incident — Telegram operator's "verifica y corre un query en SQL para confirmar la distribución de las tiendas" returned `[]` from semantic classifier, no regex safety net, no shell_exec, 90s thrashing browser/web_read.

## Why this fix was needed
- Semantic LLM classifier silently under-classifies explicit data-query imperatives.
- The existing classifier-bypass branch (when `preClassifiedGroups != null`) had no coding/SQL injection mirror to the existing google/seo/northstar pattern.
- High-stakes DENUE guard fired but neither shell_exec nor http_fetch were scoped → 90-line recipe useless.

## Risk patterns flagged
1. **`scoring\b` token in post-classifier injection** (scope.ts:989) — overrides LLM judgment on "credit scoring", "lead scoring", "scoring de SEO". Same regex token is also present in the main coding regex line 545.
2. **`denue` bare token** triggers on conversational mentions of DENUE without imperative.
3. **Regex list drift** between scope.ts:545 (main) and scope.ts:989 (safety-net) — kubectl/tsx/npx/file_delete/jarvis_test_run/jarvis_diagnose only in main.
4. **Duplicate `["coding"]` examples** in CLASSIFIER_SYSTEM_PROMPT (scope-classifier.ts:81-82) are functionally identical to the LLM.
5. **Fix B (debug log line) has zero test coverage** — future refactor can silently drop it.
6. **Fix D helper accepts `undefined` tools** — confirm RunnerInput.tools is actually undefinable at runtime; otherwise dead branch.

## Test coverage gaps
- No FP test for `scoring` token in post-classifier path.
- No test for Fix B router log line.
- No LLM-side test for the new prompt examples (only regex-side coverage).
- No DENUE-noun-without-imperative test (e.g., "el DENUE Analyzer es un proyecto que…").

## Recommendation
Ship as-is. Follow-ups: tighten `scoring`/`denue` injection or accept FP & document; sync the two coding regex lists; add R1/R2 tests.
