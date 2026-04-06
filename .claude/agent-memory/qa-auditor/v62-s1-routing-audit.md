---
name: v6.2 S1 Smart Provider Routing Audit
description: Health classification + cost tracking audit — threshold asymmetry, window mismatch, weak cost test
type: project
---

v6.2 S1 shipped in commit 61c9341 (2026-04-06). PASS WITH WARNINGS.

Key findings:

- `classifyHealth()` uses ERROR_RATE_HEALTHY (3%) for degraded, but `isDegraded()` uses ERROR_RATE_UNHEALTHY (10%) for skip → dashboard says "degraded" while routing still sends traffic
- `getStats()` uses full 50-entry buffer (no time filter), `isDegraded()` uses 10-min window → can disagree after idle period
- Cost test only asserts `> 0`, should be `toBeCloseTo(0.045, 6)` for the known pricing
- `classifyHealth()` uses `>` not `>=` for LATENCY_HEALTHY_MS — exactly 90s classifies as "healthy"
- Model stored per-provider not per-entry — mid-window model switch prices all tokens at latest rate
- No test for error-rate-based health degradation or time-window exclusion in isDegraded

**Why:** S1 is the foundation for S2-S5 routing decisions. Threshold consistency matters for operator trust.
**How to apply:** Follow up on C1 (threshold alignment) and W2 (cost assertion) before S2.
