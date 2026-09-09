---
name: hotpath-perf-audit
description: Per-message hot-path audit (router/scope/dispatch/inference/fast-runner) — structural + per-message-waste findings, 2026-07-05
metadata:
  type: project
---

# Per-message HOT PATH audit (2026-07-05)

Slice: src/messaging/router.ts (2934), scope.ts (1626), dispatch/dispatcher.ts (1009),
inference/adapter.ts (2347), claude-sdk.ts (1153), runners/fast-runner.ts (1875).

**Why:** runs on EVERY inbound Telegram/email msg + every LLM call. Verdict: fundamentally
sound (linear early-return guard chain + config-gated dual inference path), NOT overbuilt in
logic, but carries per-message allocation waste + one 900-line god-method.

**How to apply:** when auditing/optimizing this slice, these are the confirmed load-bearing
facts and the standing findings.

## Standing findings (ranked)
1. **buildMcpServer rebuilds Zod schemas per SDK call** (claude-sdk.ts:144-172 → wrapTool 88-122 →
   jsonSchemaToZodShape 67-82). `queryClaudeSdk` (l.422) calls buildMcpServer every message →
   ~30 scoped tools × ~5 params = ~150 z.*/.describe()/.optional() allocs/msg. Tool defs are
   STATIC post-registration → memoize wrapTool in Map<toolName, SdkTool>; keep extraTools fresh.
   TOP per-message CPU/GC win on the production path.
2. **getAllAvailableTools rebuilds ~150-name Set per msg for a LOG denominator** (scope.ts:1520,
   consumed router.ts:477-483 `X/Y tools`). Memoize by env-flag key or drop.
3. **handleInbound is ONE ~905-line method** (router.ts:1205-2109), 10+ inline intent branches
   sharing one scope. Refactor target: extract pre-task command interceptors
   (context-clear/background-agent/agent-mgmt/cancel/enhancer/confirmation/feedback/fast-path)
   into an array of `(msg,ctx)=>handled?`; loop until handled.
4. Inline regex recompiled per msg: CONTEXT_CLEAR_RE(1252) BACKGROUND_AGENT_RE(1290)
   CANCEL_INTENT_RE(1486) SKIP_RE(1540) CONTINUATION_RE(1977) — hoist to module scope.
5. **Double appendDayLog("USER")**: unconditional at 1209 + again at 1679(confirm)/1691(decline)
   → confirm/decline replies log USER twice. Drop the 1679/1691 USER appends.
6. getForeignProjectNames DB SELECT per submitTask (dispatcher.ts:241, called ~294) over tiny
   rarely-changing projects table → cache w/ short TTL.
7. this.channels.get(msg.channel) fetched 4-5×/msg (1225,1263,1883,1958,+1329) — hoist once.
8. env-flags obj {hasGoogle,hasWordpress,hasMemory,hasCrm} rebuilt 3×/msg (router 465,478,1889);
   each reads process.env×4 + getMemoryService().backend — build once, pass down.
9. cache_diag double SHA-256 of full ~34K systemPrompt + toolList EVERY SDK call
   (claude-sdk.ts:468-478) — diagnostic added 2026-05-22; gate behind debug flag / sample.

## Load-bearing config facts (don't mis-read as dead code)
- **Under INFERENCE_PRIMARY_PROVIDER=claude-sdk (documented default since 2026-05-10):**
  `infer()` returns early at adapter.ts:938 → the OpenAI provider loop (941-1094) is INERT.
  `inferWithTools()` returns early at 1591 → its OpenAI round loop (1593-~1720+) is INERT.
  ~600 LOC of circuit-breaker/degraded/backoff machinery is the `=openai` REVERT path, not dead.
  These dominate adapter.ts and complicate hot-path reading — candidate to split to adapter-openai.ts.
- fast-runner chat path (execute) has its OWN claude-sdk branch (1129-1286) that calls
  queryClaudeSdk DIRECTLY (l.1202), bypassing inferWithTools. `definitions` (built 2× at 692+694
  via getDefinitions) is UNUSED on the SDK path (only .length for logging) — OpenAI-path only.
- getDefinitions (registry.ts:119) is CHEAP (maps to pre-built t.definition; no schema rebuild).
  The schema rebuild cost is in wrapTool's zod construction (#1), not getDefinitions.
- Correctly parallelized already: enrichContext‖classifyScopeGroups (router 1853); essentials‖KB‖
  precedent (fast-runner 781). Prompt cache split via CACHE_BREAK_MARKER + cacheable:false routing
  is intentional (do NOT vary the stable prefix; cache-read ~82%).
