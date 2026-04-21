---
name: v7.14 infographic_generate audit
description: v7.14 infographic_generate Round 1 audit findings; regex alternation bug on ph/f root in Spanish scope matcher
type: project
---

# v7.14 infographic_generate — Round 1

**Verdict:** PASS WITH WARNINGS (1 major, 5 warnings, 0 critical)

**Why:** 24 tests pass, security is tight (no exec/shell/network, pure-JS DOM shim), path validation matches v7.10/v7.12. Ship blocker is a regex bug that silently leaves Spanish plural+unaccented `infografía` forms inert.

**How to apply:** Same pattern seen in scope regex authorship before — author mentally factored `infograph(?:ic|ía|ia)s?` as a shared-prefix alternation, missing that EN `infographic` starts with `infograph` and ES `infografía` starts with `infograf` (no `h`). The `|infografía` catch-all only handles one of 4 Spanish forms. When reviewing scope regex additions touching EN+ES terminology, always expand by hand: EN singular, EN plural, ES accented singular, ES accented plural, ES unaccented singular, ES unaccented plural. Six forms minimum. Empirically test each with Node one-liner before approving.

**Other findings:**

- W1: CURATED_TEMPLATES names not validated against runtime AntV catalog at test time — upstream rename will bite silently
- W2: `looksLikeAntvDsl` regex matches "infographic briefing for Q4" and routes to DSL mode, producing confusing parse error
- W3: No test for the `@antv/infographic not available` ENOENT-equivalent path
- W4: No scope.test.ts assertions for the new keywords (SWOT, KPI grid, summary card, etc.)
- W5: Outer 30s timeout does not cancel inner renderToString — cosmetic

**Cross-reference:** Matches the F2/F4 scope-regex-as-ship-blocker pattern from feedback_f2_f4_indicator_engine. Also see feedback_f8_paper_trading (ES accents + JS \b) — same class.
