# Memory Provider Interface Comparison — Research Note

**Status:** Research deliverable, 2026-05-23. Closes Hermes April Tier-2 #4 ("Compare Hermes pluggable memory provider ABC vs our MemoryService"). No code change in this task.

**Sources consulted**

- Our `MemoryService` interface — `/root/claude/mission-control/src/memory/types.ts`
- Our backends — `src/memory/sqlite-backend.ts`, `src/memory/hindsight-backend.ts`
- [Hermes Agent v0.7.0 release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.3)
- [Hermes `MemoryProvider` source](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)
- [Hermes memory-providers user guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md)

---

## 1. The two interfaces side-by-side

### Ours — `MemoryService` (`src/memory/types.ts:125`)

| Method                           | Purpose                         |
| -------------------------------- | ------------------------------- |
| `retain(content, RetainOptions)` | Store one observation           |
| `recall(query, RecallOptions)`   | Search by semantic + keyword    |
| `reflect(query, ReflectOptions)` | Synthesize from stored memories |
| `isHealthy()`                    | Operational check               |
| `backend` (property)             | `"sqlite" \| "hindsight"`       |

Rich option types carry domain semantics:

- `RetainOptions`: `bank` (mc-operational / mc-jarvis / mc-system), `trustTier` (1-4 with decay), `source`, `tags`, `taskId`
- `RecallOptions`: `bank`, `excludeOutcomes`, `includeFailed`, `withRerank` (Hindsight rerank opt-in), `recallMode` (coherence / correspondence / unfiltered)

Backends: `SqliteMemoryBackend` (FTS5 + embedding hybrid), `HindsightMemoryBackend` (semantic via Docker container).

### Hermes — `MemoryProvider` (ABC with default impls)

Source declares `class MemoryProvider(ABC):` from `abc.ABC` — nominal inheritance, not structural typing. Most methods carry default implementations so a subclass only overrides the parts it actually needs; that's the plugin-ergonomics path, not Protocol.

**Required (4 abstract methods + 1 abstract property):**

- `name` (property)
- `is_available()` — credentials/config check
- `initialize(session_id, **kwargs)` — session-scoped init
- `get_tool_schemas()` — provider exposes its own tools to the LLM
- `sync_turn(user_content, assistant_content)` — write-back per turn

**Lifecycle with default impls (5):**

- `system_prompt_block()` — provider injects into system prompt
- `prefetch(query)` — pre-emptive lookup (sync)
- `queue_prefetch(query)` — pre-emptive lookup (background)
- `handle_tool_call(name, args)` — dispatch tool calls
- `shutdown()` — flush + close

**Optional hooks (8):**

- `on_turn_start` / `on_session_end` / `on_session_switch` / `on_pre_compress` / `on_delegation` / `on_memory_write` / `get_config_schema` / `save_config`

Built-in providers: built-in memory + Honcho. Third-party-registerable: agentmemory, Supermemory, vector stores. One external provider at a time alongside the always-on built-in.

## 2. What each design optimizes for

**Hermes — plugin ecosystem.** The broad surface (5 abstract methods + 5 defaulted lifecycle + 8 optional hooks = 18 callable members) exists because Hermes wants third parties (Honcho, Supermemory, agentmemory) to drop in without core changes. Provider-owns-its-tools means a memory backend can advertise specialized tools (e.g., entity-extracting retain). Session-scoped lifecycle lets a provider hook into delegation, compression, session switches. The ABC-with-default-implementations choice keeps the required surface tight (5 abstracts) while letting a subclass override only the optional bits it actually uses — that's the plugin-ergonomics path. **`**kwargs`on`initialize`and`handle_tool_call` can carry arbitrary data but there's no contract — every provider would invent its own kwarg names\*\*, which is exactly what makes adoption a semantic-loss event for us (§4–§5).

**Ours — in-house multi-bank with audit + trust semantics.** Three ops + bank routing + trust tier + outcome filtering + rerank opt-in is exactly the shape required by the V8.1 briefing pipeline, the `recall_audit` weekly correspondence audit, and the per-bank Hindsight demote (`HINDSIGHT_RECALL_DISABLED_BANKS`). The interface is narrower because every option carries domain meaning we'd lose in a generic-plugin redesign.

## 3. What's missing on our side that Hermes has

Lifecycle hooks worth thinking about (independent of adopting their ABC):

1. **`on_pre_compress(messages)`** — Hermes lets a provider see the conversation right before compaction. Could be useful: our `context-compressor` currently doesn't notify the memory backend that a compaction is about to happen; a provider could `retain` distilled facts at that exact moment.
2. **`on_delegation(task, result, child_session_id)`** — when a swarm sub-task completes, the parent could route a fact-store automatically. Currently we do this via `retain` calls scattered in callers.
3. **`on_session_switch(new_session_id, parent_session_id, reset)`** — we don't have an explicit session concept; tasks chain via `parent_task_id` but there's no "session boundary" signal sent to memory.
4. **`prefetch(query)` / `queue_prefetch(query)`** — pre-emptive memory lookup based on the user message before the LLM call. Could land in `fast-runner` as a parallel-fetch optimization but is not currently a structural part of the recall path.

These are interesting individually but none are blocking work today.

## 4. What's missing on Hermes's side that we have

- **Bank routing** — our `MemoryBank` enum (mc-operational / mc-jarvis / mc-system) is a first-class option on every call. Hermes uses session_id as the only scope; banks would have to be re-implemented via session naming convention.
- **Trust tier (1-4) with decay** — Memoria-inspired ([matrixorigin/Memoria](https://github.com/matrixorigin/Memoria); cited in `types.ts:16`), used for ranking. Hermes's ABC is silent on confidence/trust.
- **Outcome-filter / recall-mode duality** — coherence vs correspondence vs unfiltered, with `outcome:failed` drop and `outcome:concerns` -0.05 score penalty. Hermes leaves this to the provider.
- **`recall_audit` instrumentation** — every recall logs source (hindsight, sqlite-fallback, sqlite-primary, circuit-open, bank-disabled, rerank-opt-out, sqlite-fallback-opt-in). Cross-encoder rerank-vs-not is tagged. Hermes's interface doesn't surface this taxonomy.

## 5. Decision

**Don't adopt the Hermes `MemoryProvider` shape.** Reasoning:

1. **Different optimization targets.** Hermes optimizes for third-party plugin ecosystem (Honcho/Supermemory/agentmemory). We don't have an external-plugin use case on the roadmap. Adopting the 14-method surface to gain plugin-ecosystem-readiness pays for capability we don't use.

2. **Adoption would degrade audit + trust semantics.** Our `RetainOptions` / `RecallOptions` carry domain concepts (bank, trust tier, outcome filter, rerank mode, recall mode) that the generic Hermes kwargs can't represent without erasing meaning. A migration would either inflate the Hermes shape with our domain fields (defeating the "generic plugin" point) or lose those semantics (degrading the V8.1 briefing pipeline and the weekly correspondence audit).

3. **The interesting bits are hooks, not the ABC.** The four lifecycle hooks worth considering (§3) can be added à la carte to our existing `MemoryService` without ABC migration. `on_pre_compress` is the highest-leverage candidate — would let the backend retain distilled facts immediately before context loss. Could ship as an opt-in `MemoryService.onPreCompress?(messages)` optional method without touching the rest of the interface.

4. **Cost of NOT adopting:** we forgo a hypothetical future where we integrate Honcho or Supermemory as a drop-in. If that becomes a real need, the right move is to write a Honcho `MemoryService` implementation (translating Hermes-shaped APIs into our retain/recall/reflect), not to flip our whole interface to match theirs.

## 6. Re-evaluation triggers

- We want to integrate Honcho, Supermemory, agentmemory, or another Hermes-ecosystem memory provider as a drop-in (look at Hermes's plugin shape as a translation reference, not a model).
- A use case for memory pre-fetch (`prefetch(query)`) surfaces as a measurable latency win — e.g., the fast-runner could parallel-fetch recall while the LLM streams the system prompt.
- Pre-compaction retain becomes a recurring need — adopt the `on_pre_compress` hook as an optional method on `MemoryService`.
- Quarterly cadence check, next ~2026-08-23. Confirm "we still don't have a plugin-ecosystem need" before letting this deferral go further.

## 7. Cherry-pick candidates (small follow-ups, NOT in this commit)

These are individual lifecycle ideas worth their own queue entries if a use case justifies:

- **`MemoryService.onPreCompress?(messages)` optional method** — adopted from Hermes's `on_pre_compress`. Lets the memory backend retain distilled facts immediately before compaction. Smallest cherry-pick.
- **Memory prefetch in fast-runner** — kick off `recall` in parallel with system-prompt assembly so the result is ready when the LLM call returns. Not blocked on interface change. Open design questions before this is ship-shaped: (a) **bank choice** — default to the runner's owner-bank (`mc-jarvis` for operator threads, `mc-system` for system tasks), with explicit override; (b) **await policy** — wait up to N ms (~100ms candidate) then proceed with whatever's ready, discard the rest on next-turn (don't block the LLM call); (c) **trigger** — every fast-runner call OR only on long user messages (>200 chars) OR only when scope-classifier returns a recall-tagged group. Cheapest measurement first: instrument current recall latency from a per-turn sample to see if the prefetch even pays off vs serial.

Memory pointer: `feedback_memory_provider_abc_comparison.md` (created in same ship).
