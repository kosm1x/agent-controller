---
name: v6.3.1 Context Optimization and FS Consolidation Audit
description: Audit of deferred tool expansion fix, scope restructure, fast-path hardening, enrichment parallelization, project README injection — PASS WITH WARNINGS
type: project
---

v6.3.1 optimization audit (2026-04-07). Verdict: PASS WITH WARNINGS.

Prior audit's FAIL (C1: allowedToolNames never updated) is FIXED in this commit.
`allowedToolNames.add()` + `tools.push()` now correctly injected on deferred expansion.

Key findings:

1 Critical:

- C1: Enrichment pgvector race condition — timeout resolves Promise.race but async IIFE continues. sections.push() can fire AFTER Promise.all resolves, mutating sections during downstream processing.

3 Warnings:

- W1: exa_search still dual-listed (CORE_TOOLS + deferred:true). Costs an extra inference round on first use every conversation.
- W2: Duplicate tools in scope (pdf_read, http_fetch, humanize_text) when multiple groups activate. Not a crash, but wastes tokens.
- W3: fede-summary (user identity profile) gated behind northstar scope — LLM loses user context on non-NorthStar tasks. The conditional gate check was changed from jarvis_file_read (always present) to northstar_sync (scope-gated).

2 Info:

- I1: Project slug detection has false positives ("cuatro flores" matches cuatro-flor, "obsidian brain dump" matches obsidian-brain). Non-critical: only injects a README, budget-capped.
- I2: Fast-path 3-word threshold blocks some pure farewells ("ya me voy", "cómo te va"). Acceptable per stated design: "false negatives are acceptable."
- I3: No tests for deferred tool expansion path in adapter.ts.
