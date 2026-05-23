# Sprint 1 T-01 — Claude Agent SDK Beta-Header / Feature Probe

**Closes:** task #196 (T-01 of Sprint 1 Fast Runner Hardening).
**Date:** 2026-05-23.
**Method:** TypeScript types + runtime bundle inspection. Per operator constraint, no live Anthropic API probes.

**Sprint-altering finding:** The Claude Agent SDK 0.2.101 is a **high-level orchestration SDK**, not a thin wrapper around `messages.create`. It does not expose the per-request features that three of Sprint 1's five execution items depend on. Honest reframe of the sprint at the bottom.

---

## SDK version

- **Installed:** `@anthropic-ai/claude-agent-sdk@0.2.101` (per `mission-control/package.json` line 24 and `node_modules/.../package.json`)
- **Latest upstream:** `0.3.150` (per `npm view @anthropic-ai/claude-agent-sdk dist-tags`)
- **Gap:** 49 minor versions. Per operator directive #1 ("SDK as is working now"), we will not bump in this sprint. Bump is a Sprint 2+ candidate.

## Architectural reality of the SDK

The Claude Agent SDK is NOT a TypeScript port of `messages.create`. From inspecting `sdk.d.ts` and `sdk.mjs`:

- The `query()` function (sdk.d.ts:1891) takes an `Options` object with high-level fields: `agent`, `agents`, `allowedTools`, `disallowedTools`, `tools` (preset), `canUseTool`, `fallbackModel`, `toolConfig`, etc.
- Internally, `query()` invokes `cli.js` (Claude Code CLI) as a child process. Tool definitions, message construction, cache management, and tool execution happen inside the CLI — **we do not have an API surface for per-message cache_control, per-tool strict mode, or arbitrary server tools.**
- The single exposed beta-header field is `betas?: SdkBeta[]`, where `SdkBeta` is a TypeScript union literal type with ONE allowed value:

```ts
// sdk.d.ts:2018
export declare type SdkBeta = "context-1m-2025-08-07";
```

Runtime inspection of `sdk.mjs` (line 23) shows the SDK DOES forward whatever array is in `betas` as a comma-joined `anthropic-beta` HTTP header. So technically you can pass arbitrary strings via `as SdkBeta` casts. BUT — and this matters — the SDK does not surface any other parameters that consume those betas. Passing `'cache-diagnosis-2026-04-07'` would arrive at Anthropic, but we have no way to pass `diagnostics.previous_message_id` alongside it because the SDK does not expose a `diagnostics` field on the request. The beta header alone does nothing.

## Sprint-relevant feature support — per item

| Feature                                         | Sprint item | SDK 0.2.101 supports?                                                                          | Path                                      |
| ----------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `betas` array with `cache-diagnosis-2026-04-07` | T-03        | Header forwards, **but `diagnostics` field NOT exposed** → effective NO                        | BLOCKED                                   |
| `diagnostics.previous_message_id` param         | T-03        | **NO** — not in Options type or query() signature                                              | BLOCKED                                   |
| Per-message `cache_control` markers             | T-06        | **NO** — SDK manages messages internally                                                       | BLOCKED (spills to Sprint 2 per operator) |
| Per-tool `strict: true`                         | T-05        | **NO** — SDK manages tool definitions internally; we pass tool NAMES, not schemas              | BLOCKED                                   |
| `tool_search_tool_bm25_20251119` as server tool | T-07        | **NO** — SDK has no server-tool surface for our injection                                      | BLOCKED                                   |
| `defer_loading: true` per tool                  | T-07        | **NO** — same reason                                                                           | BLOCKED                                   |
| `eager_input_streaming: true` per tool          | Sprint 2 #9 | **NO** — same reason                                                                           | BLOCKED (was already Sprint 2)            |
| CLI escape hatch via `extraArgs`                | any         | Inspected: no `--cache-*`, `--strict`, `--tool-search`, `--diagnostic` flags in cli.js strings | BLOCKED                                   |
| Custom HTTP headers passthrough                 | any         | `extraHeaders` / `customHeaders` not in Options type                                           | BLOCKED                                   |

## Cross-checks performed

1. **`grep -n "cache_control\|diagnostics\|previous_message_id\|tool_search\|defer_loading\|eager_input_streaming" sdk.d.ts`** → zero matches in our surface
2. **`grep -n "extra_headers\|extraHeaders\|customHeaders" sdk.d.ts`** → zero matches
3. **`grep "^--beta|^--cache|^--strict|^--tool-search|^--diagnostic" cli.js`** (strings dump) → zero matches
4. **Runtime `sdk.mjs` line 23** confirms `betas` array is comma-joined into `anthropic-beta` header — but only the header. Other parameters required for those betas to do anything are still gated behind SDK API surface that doesn't exist here.

## Open-inference fallback (operator constraint #1, "worst case scenario")

The operator authorized falling back to the openai-compat path (`inferWithToolsViaOpenAi` at `src/inference/adapter.ts:1481`) for items the SDK blocks. Reality check:

| Sprint item               | Openai-compat path applicability                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-03 cache diagnostics    | **NO** — `diagnostics.previous_message_id` is Anthropic-specific. Fireworks/Groq don't have it.                                                                                                                                                                                                                         |
| T-05 strict tool mode     | **PARTIAL** — OpenAI supports `strict: true` since GPT-4o. Some openai-compat providers do too. But the fast runner runs through SDK by default since 2026-05-10 cutover, so strict mode on openai-compat path only helps if/when we route fast tasks through it. Strict mode on the SDK path is what we actually want. |
| T-06 cache-block collapse | **NA** — the cache-collapse bug IS in the SDK path. The openai-compat path doesn't use `cache_control` in the same way (Fireworks has different cache semantics). Per operator directive #2, T-06 spills to Sprint 2 if SDK blocks it — confirmed blocked here, spill confirmed.                                        |
| T-07 Tool Search          | **NO** — Anthropic-only feature. Fireworks/Groq don't ship `tool_search_tool_bm25_20251119`.                                                                                                                                                                                                                            |

**Summary: openai-compat fallback unlocks zero of T-03 / T-05 / T-06 / T-07** for the fast runner's primary traffic flow. The fallback is theoretically a tool for one-off escape hatches but doesn't deliver any Sprint 1 deliverable as designed.

## Honest sprint reframe

Under operator constraint #1 ("SDK as is working now"), Sprint 1's plan as designed cannot ship its three highest-leverage items. **The five-item execution track collapses to two**: T-02 (baseline, ✅ shipped) and T-04 (parallel audit, ✅ shipped). T-08 (retro) still applies. The remaining three (T-03, T-05, T-07) need a different vehicle.

### Three paths forward (operator decision)

**Path A — minimal Sprint 1, Sprint 2 starts with SDK upgrade probe.**

- Sprint 1 ships: T-01, T-02, T-04, T-08 = 4 docs/instrumentation items.
- Sprint 2 begins with: SDK upgrade to 0.3.150 evaluation, then re-probe — if 0.3.x exposes per-message cache_control / strict / tool_search, Sprint 1's blocked items become Sprint 2's main work.
- Honest, low-risk. Acknowledges the SDK constraint.

**Path B — selective rollback for cache-sensitive tasks.**

- Identify the highest-cache-collapse-cost task subset (e.g., long messaging threads with the 51k cache_create signature).
- Route those specific tasks back through the openai-compat path with manual cache_control on supported providers (Fireworks does support cache_control in OpenAI-compatible shape since late 2025; verification needed).
- Cost lever: targeted, not blanket. Trades reliability of SDK path on a small denominator for cache savings.
- Higher complexity, requires per-task routing logic and a re-probe of Fireworks cache semantics. **NOT recommended for Sprint 1 — design work required first.**

**Path C — accept the constraint, focus Sprint 1 on what IS shippable through SDK.**

- Items NOT blocked by the SDK constraint (and not yet shipped this sprint):
  - **Tool description tightening for BM25-friendliness** (preparatory work for Tool Search if/when SDK supports it; pure docs in tool descriptions)
  - **scope_telemetry coverage gap fix** (the 73% gap noted in T-04; add `recordToolExecution` on the SDK path)
  - **Verification nudge expansion** (currently fires at ≥3 write tools; investigate widening per the dossier's flagged gap)
  - **Test coverage gaps from the dossier** (fastRunner.execute() integration test; checkpoint write test; mechanical replacement test — these are Sprint 2 #7 from the 10-list but doable now)
- Items can be added to Sprint 1 to actually fill the 2-week window with meaningful ships.

## Recommendation

**Path A + a slice of Path C as a buffer.** Concretely:

1. Mark T-03, T-05, T-06, T-07 as blocked-on-SDK in their task records (status: pending, but with a blocker note). Don't delete — the work is real, the vehicle is wrong.
2. Add ~2-3 Path-C tasks to Sprint 1 so the calendar window delivers something:
   - scope_telemetry SDK-path coverage fix
   - tool description audit pass (BM25-friendliness preparatory work, pays off when Sprint 2+ unblocks T-07)
   - fastRunner.execute() integration test
3. T-08 retro now closes Sprint 1 honestly: 4 items shipped (T-01, T-02, T-04 + one Path-C), 3 items blocked by SDK constraint, 1 spilled per operator directive. Sprint 2 starts with the SDK upgrade evaluation.

## Verifiable artifacts from this probe

- `sdk.d.ts` line 2018: `SdkBeta = 'context-1m-2025-08-07'` — single allowed beta value
- `sdk.d.ts` lines 962-1109: full Options type, no `cache_control` / `diagnostics` / tool-schema fields
- `sdk.d.ts` line 1891: `query()` signature
- `sdk.mjs` line 23: `betas` runtime forwarding to `anthropic-beta` header
- `package.json` line 24: `"@anthropic-ai/claude-agent-sdk": "^0.2.101"`
- `npm view @anthropic-ai/claude-agent-sdk dist-tags`: `latest: 0.3.150`

## What I did NOT do (and why)

- **Did NOT hit Anthropic API to live-probe beta headers** — operator constraint #1 explicitly: "No anthropic API."
- **Did NOT bump the SDK version** — operator constraint #1: "SDK as is working now."
- **Did NOT roll the fast runner back to openai-compat path** — would be a major architectural revert (2026-05-10 cutover was deliberate); Path B above is the controlled version of this and needs design work, not a snap decision.

---

**Generated by:** Sprint 1 task T-01 (SDK beta-header probe).
**Decision needed from operator:** which path (A / B / C / hybrid) — sprint pivots on the answer.
