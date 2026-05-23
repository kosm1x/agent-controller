# Pluggable Context-Engine Slot — Design Note

**Status:** Research/design deliverable, 2026-05-23. Closes Hermes April Tier-2 #1 ("Design pluggable context-engine slot for context-compressor"). No code change in this task. Output is the **interface sketch** (§6, copy-pasteable when a trigger fires) and the **decision** (§5, defer until a concrete second compressor exists).

**Sources consulted**

- Our compaction pipeline — `src/prometheus/compaction-pipeline.ts`
- Our compressor — `src/prometheus/context-compressor.ts`
- [Hermes Agent v0.9.0 release notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.13) (PR #7464)
- [Hermes `ContextEngine` ABC source](https://github.com/NousResearch/hermes-agent/blob/main/agent/context_engine.py)
- [Hermes context-engine plugin guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-engine-plugin.md)

---

## 1. Current state — our compaction shape

`compactConversation()` in `compaction-pipeline.ts` is a 4-level deterministic cascade:

| Level | Action                                             | Cost     | LLM?    |
| ----- | -------------------------------------------------- | -------- | ------- |
| L0    | Truncate old tool results                          | Free     | No      |
| L1    | Pair drain (drop completed tool-call/result pairs) | Free     | No      |
| L2    | LLM summarization via `compress()`                 | $ + 2-5s | **Yes** |
| L3    | Deterministic message-count floor                  | Free     | No      |

**Only L2 is LLM-driven.** L0/L1/L3 are deterministic algorithms that don't need pluggability. The pluggability question is exclusively about L2 — the `compress()` function in `context-compressor.ts`.

`compress()` shape today (after #188/#189 ships earlier this session):

```ts
async function compress(
  messages: ChatMessage[],
  keepHead: number,
  keepTail: number,
  contextInjection?: string,
): Promise<ChatMessage[]>;
```

Stateless. Single-domain prompt (the `STRUCTURED_COMPACT_PROMPT` 9-section format + `LANGUAGE_RULE` + `UPDATE_LANGUAGE_ADDENDUM` for PRESERVE+ADD). No tracker for compression count or running token usage. No focus-topic parameter.

## 2. Hermes's `ContextEngine` ABC mapped to ours

Hermes defines `class ContextEngine(ABC)` (similar to their `MemoryProvider` shape — see [[memory-provider-abc-comparison]]) with 4 abstract methods + 9 optional + ~10 state attrs.

| Hermes method                                           | Our equivalent                                             | Gap                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `name` (property)                                       | none — implementations are not first-class                 | Need a plugin identifier if we ever register multiple                                                                   |
| `update_from_response(usage)`                           | none — we re-compute `estimateTokens` per call             | We're stateless; Hermes engines accumulate token usage                                                                  |
| `should_compress(prompt_tokens)`                        | `shouldCompress(messages, contextLimit, threshold)`        | Ours takes the messages, theirs takes a single token count — same logic, different signature                            |
| `compress(messages, current_tokens, focus_topic)`       | `compress(messages, keepHead, keepTail, contextInjection)` | Same role; we lack `focus_topic`, they lack `contextInjection`                                                          |
| `on_session_start/end/reset`                            | none                                                       | We have no "session" concept; compaction is per-task                                                                    |
| `get_tool_schemas()`                                    | none                                                       | Plugins can't expose their own tools to the LLM (matches our `MemoryService` decision — we keep tool registry separate) |
| `update_model(model, context_length, …)`                | none — `contextLimit` is a per-call parameter              | Hermes engines own the model context-length state                                                                       |
| `should_compress_preflight` / `has_content_to_compress` | none                                                       | Optional pre-checks; our `shouldCompress` is the only gate                                                              |
| `get_status()`                                          | none                                                       | No diagnostic surface; we log inline                                                                                    |

Hermes ships **one** built-in implementation: `ContextCompressor` (the equivalent of our `compress()`). LCM (Lossless Context Management) is named in the plugin guide as a hypothetical example ("For example, a Lossless Context Management (LCM) engine that builds a knowledge DAG instead of lossy summarization") — NOT a shipped class. Custom plugins discoverable via `hermes plugins`.

## 3. What pluggability would unlock for us

Possible domain splits if a concrete second compressor ever surfaces: research (preserve `cvegeo`/`scian` codes verbatim), coding (preserve file paths and diff snippets), chat (preserve verbatim user quotes; compress assistant verbosity). The runner already knows the active scope via `scope.ts` groups, so tag-based selection at the swarm-runner / fast-runner seam is the natural routing strategy. None of these are concretely needed today — see §4.

## 4. Do we have any of those on the roadmap right now?

**Spot-check (2026-05-23):**

- V8 substrate direction (relational arc + S1-S5): no compression-domain requirement surfaced in `docs/V8-VISION.md`
- v7.5 closure (GEPA/SkillClaw): doesn't tie to per-domain compression
- Recent compression session ships (#188 language, #189 anti-thrash): both made the SINGLE `compress()` function smarter, none of them needed a second one
- Open queue (planning/next-sessions-queue.md): no item names a second compressor as a dependency
- `feedback_*` memory cluster: no recurring failure that says "the compress() prompt is wrong for domain X"

**Conclusion:** no concrete second compressor on any near-term roadmap or memory file. This is exactly the disqualifier the task description named: _"only pays off when paired with a concrete second compressor we want to plug in; otherwise it's architecture-for-its-own-sake."_

## 5. Decision

**Don't build the plugin slot now.** Reasoning:

1. **No concrete second compressor on the roadmap.** Per the task's own disqualifier and the §4 spot-check.
2. **Refactor cost is real.** Converting `compress()` from a function to a class instance, plumbing it through `compaction-pipeline.ts:219`, and giving it the `update_from_response` / `update_model` state would be ~150-200 LOC of refactor PLUS a registry layer. We'd take that cost up front for zero current users.
3. **Adopt Hermes's session-aware shape only if a session-aware feature lands.** `on_session_start/end/reset` makes sense in Hermes because compaction lives across conversation sessions; our compaction is per-task and the per-task state we want already lives in `prometheus_snapshots`. Adopting their shape would import a sessions concept we don't have.
4. **The interesting wins from compression work this session were NOT pluggability.** They were: language adherence (#188), multi-cycle dedup (#189), no-op short-circuit (#189). All landed in the existing function without needing pluggability. (TZ-aware timestamp parsing also shipped today, but in `checkpoint.ts:findRecentCheckpoint`, not the compressor — separate ship.)

## 6. Re-evaluation triggers + interface sketch

**Triggers (act on any one):**

- A concrete second compressor lands on the roadmap (e.g., a DENUE/research task surfaces "we need to preserve `cvegeo` codes verbatim in the L2 summary").
- We add a domain-specific scope-classifier output that wants its own compression posture (e.g., `coding` scope wants longer summaries; `chat` scope wants shorter).
- A Hermes-style "compaction tool" surfacing pattern surfaces — e.g., the agent should be able to call `/compress <focus>` to drive its own L2 step with a topic. (Already noted as Tier-2 #3; see queue.)
- We adopt the `MemoryService.onPreCompress?(messages)` hook from [[memory-provider-abc-comparison]], and the hook semantics start wanting domain-aware framing.
- Quarterly cadence check — next ~2026-08-23 — to prevent permanent-by-neglect deferral.

**Selection strategy — undecided, defer to adoption time.** Two patterns viable:

- **Registry (single live engine, Hermes pattern):** `setContextEngine(engine)` / `getContextEngine()` at startup. Simpler API. Couples engine choice to runner restart.
- **Per-call selection (stateless, our discipline):** `compactConversation(..., { engineName })` parameter, runner picks per-task based on scope. Better fit for our stateless-function pattern but slightly more wiring at each call site.

The sketch below shows the registry form for brevity; either is fine. Pick at adoption time once the second compressor exists and we know whether engine choice is per-task (favor per-call) or global (favor registry).

**Interface sketch (copy-pasteable when a trigger fires).** Minimum viable shape that maps to our existing functional surface, keeps the four-level cascade, and avoids importing Hermes's session concept:

```ts
// src/prometheus/context-engine.ts
//
// Pluggable L2 (LLM summarization) strategy. Trigger this interface only
// when a concrete second compressor exists — see `docs/planning/
// pluggable-context-engine-design.md` §6 for the decision history.

import type { ChatMessage } from "../inference/adapter.js";

export interface ContextEngine {
  /** Short identifier — e.g., "default", "research", "coding". */
  readonly name: string;

  /**
   * Optional: per-domain budget threshold. Defaults to caller's threshold
   * if undefined. Allows a "coding" engine to compress later (higher
   * threshold) than the default.
   */
  readonly threshold?: number;

  /**
   * The actual compression step. Same contract as today's
   * `compress(messages, keepHead, keepTail, contextInjection)`.
   * Additional optional `focusTopic` adopted from Hermes's `compress(
   * messages, current_tokens, focus_topic)` — enables `/compress <focus>`
   * (Tier-2 #3) if/when that ships.
   */
  compress(
    messages: ChatMessage[],
    keepHead: number,
    keepTail: number,
    options?: {
      contextInjection?: string;
      focusTopic?: string;
    },
  ): Promise<ChatMessage[]>;

  /** Optional: domain-specific shouldCompress override. */
  shouldCompress?(messages: ChatMessage[], contextLimit: number): boolean;

  /**
   * Optional: pre-compaction memory hook (paired with the [[memory-
   * provider-abc-comparison]] cherry-pick `MemoryService.onPreCompress?`).
   * Lets the engine notify a memory backend before content is dropped.
   */
  onPreCompress?(messages: ChatMessage[]): Promise<void>;
}

// Registry — single live engine at a time (Hermes's "one external provider"
// pattern). Default = the current `compress()` wrapped as an engine.
let activeEngine: ContextEngine = defaultContextEngine;
export function setContextEngine(engine: ContextEngine): void {
  activeEngine = engine;
}
export function getContextEngine(): ContextEngine {
  return activeEngine;
}
```

**Adoption path when a trigger fires:**

1. Land `ContextEngine` interface + registry (~30 LOC).
2. Wrap current `compress()` as `defaultContextEngine` (~10 LOC). No callers change.
3. Build the new engine (e.g., `researchContextEngine`) as a separate file (~50-100 LOC depending on domain logic).
4. Wire the runner-side selection: `setContextEngine(pickEngineForScope(activeGroups))` at the seam where scope is already known (router/fast-runner before the L2 call). Or a per-call `compactConversation(messages, contextLimit, threshold, contextInjection, { engineName: "research" })` parameter — either works.

**Not adopted:** Hermes's `update_from_response` / `update_model` state-on-engine pattern. Our `infer()` already returns usage; the runner can track running totals if needed. Engine-as-state-holder doesn't fit our stateless-function discipline.

## 7. Cherry-pick candidates (not in this commit)

Independent of the plugin slot, two compressor improvements stand on their own:

- **`focusTopic` parameter on `compress()` directly.** No interface change needed; adds one optional argument to the existing function. Pairs naturally with Tier-2 #3 `/compress <focus>` if we ever ship it.
- **`update_from_response` state tracker** — useful for the cross-task cache miss investigation already queued (see queue entry at `next-sessions-queue.md`). A `CompressionTelemetry` singleton that aggregates token counts and compaction events would help diagnose when L2 actually saves bytes vs. when it's a wash.

Memory pointer: `feedback_pluggable_context_engine_design.md` (created in same ship).
