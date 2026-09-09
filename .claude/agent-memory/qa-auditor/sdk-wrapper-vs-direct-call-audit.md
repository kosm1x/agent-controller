---
name: sdk-wrapper-vs-direct-call-audit
description: 2026-05-23 claude-sdk cache+cost audit — fix hardened wrappers but missed the fast-runner's direct SDK call site. Pattern: when a module exposes both wrapper adapters and a primary function, audit BOTH consumer seams.
metadata:
  type: project
---

**2026-05-23 audit: claude-sdk #224 (cache_control split) + #225 (phantom-$0 cost) — verdict FAIL.**

Both fixes correctly engage the openai-compat wrappers (`queryClaudeSdkAsInfer`, `queryClaudeSdkAsInferWithTools`) used by planner/reflector/executor. All 9 new tests pass and assert the right behavior at that seam.

But the **primary consumer is the fast-runner**, which calls `queryClaudeSdk` directly (fast-runner.ts:1102-1242), NOT through the wrappers:
- It builds `systemPrompt` itself by `.filter(m => m.role === "system").map(...).join("\n\n")` — ignores the new `cacheable` field. Fix #224 is silently bypassed.
- It packs `actualCostUsd: sdkResult.costUsd` unconditionally at line 1239 — propagates the phantom-$0 to dispatcher.ts:505 → `costUsdOverride: 0` is truthy → ledger writes $0. Fix #225 is silently bypassed.

**Why:** Both fixes were designed with the wrappers in mind. The wrapper-layer pattern is the right one for the openai path (Prometheus). The fast-runner has its own pre-SDK-cutover prompt assembly that bypasses the adapter layer and was added in 70f8cc5. New SDK-boundary fields must be threaded through the direct call seam too.

**How to apply (audit pattern):** When auditing a fix in `src/inference/claude-sdk.ts`:
1. Identify which exported function the fix modifies (`queryClaudeSdk` vs `queryClaudeSdkAsInfer` vs `queryClaudeSdkAsInferWithTools`).
2. Grep for ALL call sites: `grep -n "queryClaudeSdk" src/runners/*.ts src/prometheus/*.ts src/reflection/*.ts`.
3. The fast-runner calls `queryClaudeSdk` directly (line 1168). New return-shape fields must be honored at fast-runner.ts:1230-1240. New input-shape fields (cacheable on ChatMessage) must be honored at fast-runner.ts:1108-1156 (prompt construction).
4. Tests in `claude-sdk.test.ts` only cover the wrappers because they mock the SDK at the `query()` import. A fast-runner test (`fast-runner.test.ts`) is needed to confirm runner-result shape.

**Other audit-relevant traps from this pass:**
- Mocked `query()` async generator yields then exits cleanly — it does NOT throw. Tests that claim "the catch block fires" actually exercise the natural-iteration-exit path through line 660. The actual `catch (err)` at line 620 has zero coverage in the suite. Look for `mockMessages.value = [... no result ...]` followed by a comment claiming abort/catch — that's the iteration-exit path, not the catch path.
- `flattenMessagesForSdk` collects all `cacheable:false` system blocks into one prepended array, losing relative position vs interleaved user messages. Fine for fast-runner (system-then-user convention) but a contract loosening for any future caller that interleaves.
- SDK shape claim `sdk.d.ts:1472` verified against installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1472` — `systemPrompt?: string | { type: 'preset', ... }`. Citation correct, line number fragile to SDK upgrades.

**Memory link**: see [[websearch-summary-hallucinations]] — verifying the SDK source line confirmed the JSDoc claim. The audit-blocking findings (C1, C2) were NOT about the SDK shape claim; they were about call-site coverage that no SDK-source check could have caught. Different failure class: not hallucinated facts, but unaudited seam.
