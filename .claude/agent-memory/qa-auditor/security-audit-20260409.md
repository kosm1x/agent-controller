---
name: security-audit-20260409
description: Full security audit of mission-control — shell injection in code-search, SSRF in http_fetch, no CORS/rate-limiting, npm vulns, CCP5 risk tier gap
type: project
---

## Security Audit Results (2026-04-09)

**Verdict: PASS WITH WARNINGS** (2 Critical, 5 Warnings, 4 Info)

### Critical

- **C1: Shell injection in code-search.ts** — `includeGlob` and `searchPath` are interpolated into `execSync()` shell commands without escaping. `pattern` is escaped but `searchPath` is not. LLM-controlled input reaches shell via `execSync()`.
  - File: `src/tools/builtin/code-search.ts:108,116,239`
  - `searchPath` at line 116: directly interpolated, no single-quote escape
  - `includeGlob` at line 108: interpolated inside single quotes but NOT escaped (quote-breakout possible)
- **C2: SSRF via http_fetch and web_read** — No URL scheme or destination validation. LLM can fetch `file:///`, `http://169.254.169.254/...` (cloud metadata), or `http://localhost:8080/api/admin/...` (internal API with API key bypass since it's on the same host).

### Warnings

- W1: npm audit shows 3 vulnerabilities (1 high: path-to-regexp ReDoS, 2 moderate: Hono serveStatic middleware bypass, cookie handling)
- W2: No CORS headers — dashboard and metrics endpoints are unauthenticated. Any origin can read `/health` (exposes provider stats, budget, circuit breaker state) and `/metrics` (Prometheus scrape)
- W3: No HTTP rate limiting on API endpoints — API key is the only gate
- W4: `screenshot_element` tool accepts `inject_text` param (arbitrary JS execution in headless browser). While controlled by LLM, a prompt injection in web content could instruct the LLM to use this to exfiltrate data
- W5: CCP5 risk tier enforcement gap — `registry.execute()` only LOGS high/medium risk tools, doesn't block. `task-executor.ts` only blocks `DESTRUCTIVE_MCP_TOOLS` (currently empty Set). All `requiresConfirmation: true` tools execute freely

### Info

- I1: SQL queries use parameterized statements throughout — no SQL injection found
- I2: `tuning/schema.ts:325` uses dynamic column names but from a TypeScript-typed `Partial<Pick<...>>` — keys are compile-time constrained
- I3: `reactions/store.ts:161` interpolates `completedAt` but it's hardcoded to `"datetime('now')"` or `"NULL"` — not user-controlled
- I4: Shell guard (`shell.ts`) is comprehensive for the `shell_exec` tool but bypassed by `code-search.ts` which uses its own `execSync` calls

**How to apply:** Fix C1 (escape searchPath/includeGlob or use execFileSync), add URL validation for C2, run `npm audit fix`, consider CORS and rate limiting for production exposure.
