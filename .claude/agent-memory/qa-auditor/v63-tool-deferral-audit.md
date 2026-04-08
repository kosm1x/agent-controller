---
name: v6.3 Tool Deferral and Context Trimming Audit
description: Audit of deferred tool expansion, MISC_TOOLS restructure, MCP deferral, KB trimming — FAIL, deferred tools never execute (allowedToolNames never updated)
type: project
---

v6.3 tool deferral audit (2026-04-07). Verdict: FAIL.

1 critical:

- C1: allowedToolNames in adapter.ts (line 1035) is never updated after deferred expansion — tools hit infinite schema-return loop, 83+ deferred builtin + 25 MCP tools non-functional through fast-runner
- C2: exa_search in CORE_TOOLS AND deferred:true — always in scope but never has full schema

Fix for C1: `allowedToolNames.add(toolName)` after schema return, plus optionally add definition to tools array for proper function-calling.

Key findings:

- Prometheus/heavy runner NOT affected (getDefinitions without excludeDeferred=true)
- Only fast-runner uses excludeDeferred=true (line 503)
- KB trimming correctly preserves enforce files (directives/core.md, repo-authorization.md)
- NorthStar/INDEX.md moved to reference (saves ~7.5K chars)
- fede-summary.md conditional on northstar but effectively always triggers
- geocode_address, weather_forecast, currency_convert are dead (not in any scope)
- No adapter tests exist at all
