---
name: OpenClaude behavioral coherence audit (batches 2-3)
description: Audit of commits e39d4e3, 921cb4b, a0d6fef — tool deferral, omitKB, NO_TOOLS sandwich, fork boilerplate, replan matrix, memory drift, delegation rule
type: project
---

## Audit: 2026-04-06

**Commits**: e39d4e3 (batch 2), 921cb4b (audit fix), a0d6fef (batch 3)
**Verdict**: PASS WITH WARNINGS

### Key Findings

1. **Tool deferral system** (types.ts, registry.ts, adapter.ts, fast-runner.ts): Fully wired but zero tools marked `deferred: true`. Entire codepath is dead code with zero test coverage. Redundant JSON.stringify/JSON.parse roundtrip in adapter.ts expansion — could crash on undefined parameters (theoretical only, TS type prevents it).

2. **omitKB pattern** (fast-runner.ts): Correctly guards `[].every()` vacuous truth with `length > 0` check. `isReadOnlyTool` import from guards.ts is correct. `enforceOnly` flag properly dispatches to `getFilesByQualifier("enforce")` only.

3. **NO_TOOLS sandwich** (context-compressor.ts): Two consecutive user messages (system, user, user) — valid per OpenAI API but unconventional. Primary defense is that `infer()` is called without `tools`, so LLM can't invoke tools regardless. max_tokens bumped 800→1200 in audit fix.

4. **Critical System Reminder removal** (adapter.ts): `break` after first match is intentional — new code never produces duplicates. Removal loop targets `role === "system"` which doesn't conflict with `stripStaleSignals` (targets `role === "user"`).

5. **Fork boilerplate** (router.ts): Old "Guarda tus hallazgos..." fully replaced. New boilerplate is a const inside the if block (could be module-level but not a bug).

6. **Memory drift** (enrichment.ts): Dynamic `import("fs")` works in ESM. `existsSync` is synchronous but trivial for few paths. Regex misses `/usr/` and `/srv/` paths. Best-effort with try/catch.

7. **Planner prompts** (planner.ts): Template literals intact. Decision matrix and delegation rule correctly placed inside backtick strings.

### Gaps

- S1: No tests for deferral mechanism (CLAUDE.md requires type field assertions)
- S2: No tests for omitKB, drift verification, fork boilerplate
- Triple tool-set iteration in fast-runner startup (trivial perf)
