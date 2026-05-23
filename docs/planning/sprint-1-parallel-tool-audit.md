# Sprint 1 T-04 — Parallel Tool Execution Audit

**Closes:** task #199 (T-04 of Sprint 1 Fast Runner Hardening).
**Date:** 2026-05-23.
**Conclusion:** Both inference paths already execute tool calls in parallel. No code fix needed. Light runtime instrumentation added so future audits can verify without re-reading code.

---

## Question

When the assistant turn emits ≥2 `tool_use` blocks in a single round, does the runner execute them via `Promise.all` (parallel) or `for...of await` (sequential)? For our 20–50 tools/turn ceiling and 200ms avg tool latency, sequential would be a 5–10× wall-clock latency lever.

## Findings

### OpenAI-compatible path (`inferWithToolsViaOpenAi`)

**Already parallel.** `src/inference/adapter.ts:1895` executes the tool-call array via `await Promise.all(response.tool_calls.map(async (toolCall) => { ... }))`. Block runs from line 1895 through 2061 (~167 LOC of tool-execution body), then `conversation.push(...toolResults)` at line 2062.

```ts
// src/inference/adapter.ts:1895
const toolResults = await Promise.all(
  response.tool_calls.map(async (toolCall) => {
    // ... salvage, repair, scope-check, registry.execute(), result-eviction ...
  }),
);
conversation.push(...toolResults);
```

### Claude Agent SDK path (`inferWithToolsViaClaudeSdk`)

**Delegates to SDK.** The signature at `src/inference/claude-sdk.ts:812` accepts `_executor: ToolExecutor` (underscore prefix marks the parameter as unused) — the comment at line 800 confirms: _"the `executor` parameter is ignored (SDK calls the registry directly)."_ Tool execution happens inside the SDK's `query()` call.

Per Anthropic's docs, parallel tool execution is **default-on** for Sonnet 4.x / Opus 4.x without `disable_parallel_tool_use: true`. We grep-confirmed we never set that flag anywhere in src.

### Tool registry

**No serialization.** `ToolRegistry.execute(name, args)` at `src/tools/registry.ts:186` is a plain async wrapper around `tool.execute(args)`. No mutex, no semaphore. `grep -rn "destructiveLock|acquireLock|Mutex|withLock" src/` returns zero hits.

### TaskExecutionContext

**Confirmation gating, not serialization.** `TaskExecutionContext` (`src/inference/execution-context.ts:14`) manages per-task state — destructive-tool confirmation gates, memory rate limits — but not concurrency. Its `destructiveUnlocked` Map tracks which destructive operations the operator has confirmed for this task; it doesn't block parallel calls.

## Verification mechanism (added this commit)

Added a runtime log line at `src/inference/adapter.ts:2074` that fires whenever ≥2 tool calls execute in a single round:

```
[inference] parallel_tool_exec n=<N> wallclock_ms=<MS> taskId=<id>
```

The `wallclock_ms` is the wall-clock time for the `await Promise.all` block — by construction this is `max(tool_latency)`, NOT `sum(tool_latency)`. If serialization ever creeps in (refactor, accidental `await` inside the map, etc.), the wallclock will jump to roughly the sum and any operator scanning `journalctl -u mission-control | grep parallel_tool_exec` will spot it immediately.

**Why a log line, not a Prometheus counter:** parallelism is a binary architectural invariant, not a tunable. We want a regression alarm, not a dashboard. Counter would be more elaborate without giving more signal.

## Live trace (sample)

After deploy, the next fast turn with ≥2 tool calls will emit the log line. Operator can verify with:

```bash
journalctl -u mission-control --since "10 min ago" --no-pager \
  | grep "parallel_tool_exec" \
  | head -5
```

Expected: for N=2-5 tools, `wallclock_ms` typically in 100–800ms range (max of individual tool latencies). If `wallclock_ms ≈ N × 200ms`, that's the serialization signature — should not appear.

## Caveat — scope_telemetry coverage

T-02 baseline noted that `scope_telemetry` covers only ~73% of fast tasks (268 rows vs 365 fast tasks completed last 7d). Investigating during this audit:

- `recordToolExecution(taskId, toolsCalled, failedToolCalls)` is called at `src/runners/fast-runner.ts:1257` in the OpenAI-compat path.
- On the SDK path, the equivalent call site is needed but the SDK manages execution internally; we may be capturing scope state from `getDefinitions()` but not the final `toolsCalled` for SDK-managed turns.
- This is **not** a parallelism issue but a telemetry-coverage gap. **Filed as a follow-up task** rather than expanded into T-04's scope.

## Decision

- **No code fix needed for parallelism** — both paths already parallel.
- **Instrumentation shipped** — light log line guards against regression.
- **No regression test** — adapter test file mocks `infer()` but `inferWithTools` orchestration is heavy to mock end-to-end; the runtime log delivers stronger evidence at production volume than a unit test could. Acceptable trade.
- **Telemetry gap (scope_telemetry coverage 73%)** logged separately, NOT folded into this ship.

## References

- `src/inference/adapter.ts:1895` — Promise.all on tool calls (OpenAI-compat path)
- `src/inference/adapter.ts:2074` — new parallel_tool_exec log line (this commit)
- `src/inference/claude-sdk.ts:812` — `_executor` ignored (SDK path)
- `src/tools/registry.ts:186` — `ToolRegistry.execute`, no serialization
- `src/inference/execution-context.ts:14` — `TaskExecutionContext`, no serialization
- Anthropic docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use (`disable_parallel_tool_use` parameter, parallel-by-default semantics)
- `docs/planning/sprint-1-baseline.md` — coverage gap noted there too
