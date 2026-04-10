---
name: hardening-commit-audit
description: Pre-production hardening commit verification audit — SSRF IPv6 bypass, Telegram restart race (2026-04-09)
type: project
---

## Hardening Commit ed0d56b Audit (2026-04-09)

**Verdict:** PASS WITH WARNINGS (2 critical, 5 warnings)

### Critical

1. **SSRF IPv6 bypass** in `src/lib/url-safety.ts`: `URL.hostname` returns brackets for IPv6 (`[::1]`), regexes don't account for them. IPv6-mapped IPv4 also bypasses (`[::ffff:10.0.0.1]`).
2. **Telegram restart/stop race**: `restartPolling()` setTimeout callback uses `this.bot!` but `stop()` sets `this.bot = null`. Null guard needed inside callback.

### Verified Correct

- SEC-C1: shell injection fixed (execFileSync + arg arrays)
- PERF-C1: spin-wait → Atomics.wait (works, verified empirically)
- PERF-C3: day-log direct DB write matches jarvis_files schema
- INF: GLM-5 pricing consistent between adapter.ts and pricing.ts
- HYG-C1: src/lib/adapters/ fully deleted, no dangling imports
- RES-W11: health messaging chain fully wired
- 1785 tests pass, typecheck clean

### Pre-existing (not introduced by this commit)

- Prometheus executor bypasses CCP5 gate (calls toolRegistry.execute directly)
- glm-4.7 missing from adapter.ts MODEL_PRICING (falls to expensive default)
