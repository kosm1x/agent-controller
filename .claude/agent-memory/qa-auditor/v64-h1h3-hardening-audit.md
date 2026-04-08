---
name: v6.4 H1-H3 hardening audit
description: Audit of rephrase correction loop, pre-flight tool verification, and self-monitoring canary (commit 5c3a24b)
type: project
---

v6.4 H1-H3 hardening features shipped in commit 5c3a24b (2026-04-07). 6 files, 297 lines added.

**H1 (correction-loop.ts)**: setTimeout leak in Promise.race deadline (never cleared). qualifier "always-read" means every correction is injected into every task prompt — could bloat KB.
**H2 (task-executor.ts checkPreflight)**: No tests for preflight. northstar_sync missing. 20-char body threshold is low but documented. No interference with CONFIRMATION_REQUIRED (correct ordering).
**H3 (canary.ts)**: Provider failure check #2 declared in header but not implemented. Delivery miss detection relies on metadata LIKE which is fragile (metadata only written when tags present). No canary tests.

Verdict: PASS WITH WARNINGS.
