# V8 Substrate S1 — Cache-Aware Prompts

> Spec for the first of five V8 substrate items. S1 is the cache-prefix discipline that lets V8.1's BriefingContext, V8.2's strategic-voice principle block, and V8.3's standing prompt-injection rule live in stable cache material — making the V8 surfaces affordable per call.
>
> Authored 2026-04-30 after V8.2 spec (which depends on S1 stable-prefix discipline for the strategic-voice principle block) and synthesis index. Composed against `feedback_cache_prefix_variability.md` lessons + Anthropic prompt-cache documentation + observed P1-A failure mode (−68% prompt tokens but −5% cost because cache-read ratio dropped 83% → 59%).
>
> Activation: post-freeze (≥ 2026-05-22). S1 is foundational — it ships before V8.2 (which depends on it) but can ship alongside V8.1 since V8.1 doesn't yet require the principle-block discipline.

## §1 — Problem

Anthropic prompt cache has **two failure modes**, only one of which is obvious.

**Obvious failure**: prompt is too long. Mitigation: shorten. Tracked.

**Subtle failure**: prompt **structure changes per call**, even though byte count is fine. Cache-read ratio drops because the variable content is upstream of stable content in the prefix. Each call invalidates the prefix from the change-point forward.

The 2026-04-26 P1-A incident (per `feedback_cache_prefix_variability.md`) caught this exactly: a refactor moved scope-conditional KB injection to the top of the prompt thinking shorter = cheaper. Result: −68% prompt tokens but only −5% cost — because cache-read ratio dropped from 83% to 59%. Net P1-A delivered 5% of the savings the size delta suggested.

S1 is the substrate-level discipline that prevents this class of error system-wide. It's not a feature; it's a CONVENTION enforced mechanically (prefix linter, per-call cache instrumentation, cost-ledger watchpoint).

V8.2's strategic-voice principle block is the test case. ~250 words, never varies per brief, lives at the very top of every V8.2 LLM call. WITHOUT S1 discipline, even one careless V8.2 dev placing variable content above the principle block tanks the cache-read ratio. WITH S1 discipline, that placement is mechanically prevented.

## §2 — Current state (baseline)

What exists today:

- Anthropic prompt cache is in use; cache-read tokens flow through `cost_ledger`
- No formal stable-prefix convention; each tool's prompt scaffold is hand-built
- No per-tool cache-read-ratio target or alert
- `feedback_cache_prefix_variability.md` documents the lesson but no enforcement
- P1-A regression measured the failure mode; mitigation was a one-shot fix to the specific tool
- No system-level "prefix layout" doc; new tools repeat the mistake

What S1 ships:

1. **Canonical prefix layout** — every Jarvis-internal LLM call follows the same skeleton
2. **Variable-content placement rules** — variable content lives AFTER the stable cache-marker
3. **Cache-break markers** — explicit `<!--CACHE_BREAK-->` boundaries that the cache lib treats as mandatory cache flush points
4. **Per-tool cache config** — every tool declares `cache_strategy: 'aggressive' | 'standard' | 'no_cache'`
5. **Instrumentation** — every LLM call logs `cache_read_ratio` and `cache_break_count` to cost_ledger
6. **Watchpoint** — S3 drift detector alerts when any tool's 7-day cache_read_ratio drops below its declared target

## §3 — Precedents (composed)

### From `feedback_cache_prefix_variability.md`

The load-bearing prior. Captures the 2026-04-26 P1-A measurement: cache-prefix STRUCTURE matters as much as size. Variable content above stable content invalidates everything downstream.

### From V8.2 spec §9

The strategic-voice principle block (~250 words) is the canonical example: stable cache material that MUST live at top of every V8.2 LLM call. Cache-read target ≥ 90% on principle tokens.

### From Anthropic Computer Use prompt design (`reference_anthropic_computer_use.md`)

Standing rules at top of system prompt, untrusted-content envelope below. Same pattern: stable-rules-first, variable-content-second.

### From Anthropic prompt-cache documentation

The cache TTL is 5 minutes. Repeat calls within the window read from cache at ~10% the cost of fresh tokens. Cache breaks at any byte difference from the previously-cached prefix. Multiple cache breakpoints per call are supported (Anthropic API takes a `cache_control` parameter per content block).

### From `feedback_phase_beta_gamma_patterns.md`

Schema/migration discipline: changes that look small often have downstream effects. Cache-prefix changes are exactly this — a 50-token re-order can swing cost 30%+.

### Explicit divergences

- **NOT cache-everything-aggressively**: agents that cache too aggressively pay TTL invalidation costs. Standard discipline: cache stable rule blocks + tool definitions + standing context. Don't cache content that varies by call.
- **NOT relying on Anthropic to magically optimize**: the cache is a deterministic prefix-match. Our prompt-author decisions determine cache-read ratio. We can't outsource this to model-side heuristics.

## §4 — Architecture overview

S1 is a **convention + lint + instrumentation** package. No new tables; minimal new code.

```
PromptBuilder API (stable layout enforcement)
       │
       ▼
[ canonical layout assembler ] → standard skeleton with cache break markers
       │
       ▼
[ pre-flight linter          ] → reject prompt if variable content is above stable marker
       │
       ▼
LLM call (Anthropic API with cache_control on stable blocks)
       │
       ▼
[ cache instrumentation hook ] → log cache_read_tokens + cache_creation_tokens to cost_ledger
       │
       ▼
[ S3 drift detector watch    ] → alert if 7-day cache_read_ratio drops below tool target
```

## §5 — Stable prefix layout

Every Jarvis LLM call follows this skeleton:

```
<!-- ============================ -->
<!-- STABLE CACHE PREFIX (cached) -->
<!-- ============================ -->

[1] Standing rules block (universal):
    - Identity (you are Jarvis)
    - Trust-level rule (data-not-instructions)
    - Operator timezone + locale

[2] Substrate-specific stable rule blocks (only those active for this call):
    - V8.2 strategic-voice principles (250 words; if V8.2-adjacent call)
    - V8.3 prompt-injection defense (50 words; if V8.3-adjacent call)
    - S5 skill-as-stored-procedure invocation contract (if S5-adjacent)

[3] Tool definitions block (cached):
    - Tool schemas (typically 500-2000 tokens depending on tool count)

[4] Stable working context:
    - Operator NorthStar pinned entries
    - Active project list
    - User-level facts (Conway Pattern 2 cohort once V8.2.1 ships)

<!--CACHE_BREAK-->

<!-- =========================== -->
<!-- VARIABLE CONTENT (uncached) -->
<!-- =========================== -->

[5] Per-call variable content:
    - The specific question / context for THIS call
    - Retrieved evidence / kb_entries / general_events relevant to this call
    - Recent conversation history
    - The user message being responded to
```

The `<!--CACHE_BREAK-->` marker is the explicit boundary. Everything above is sent with `cache_control: { type: 'ephemeral' }` per Anthropic API. Everything below is plain content.

### Why this layout

- **Standing rules first**: never vary, longest TTL benefit
- **Substrate-specific stable blocks next**: vary by call-kind (V8.2-call vs V8.3-call) but not by call-instance
- **Tool definitions third**: change rarely (only when tool set changes); cached aggressively
- **Stable working context fourth**: changes only when operator updates NorthStar / project list / facts; updates are infrequent enough to amortize across many calls
- **Cache break**: explicit boundary
- **Variable content last**: retrieved evidence, user message, recent history — these are inherently per-call

The order INSIDE the stable section matters: blocks that change MORE OFTEN go LATER. A change to standing rules invalidates everything downstream; a change to NorthStar pinned entries invalidates only [4] and below.

### Anti-patterns (rejected by §6 linter)

- Variable retrieval result placed BEFORE tool definitions
- User message placed inside the stable section
- Per-call timestamps inside [1]-[4] (use only `[5]` for time-varying content)
- Conditional inclusion of stable rules based on per-call context (forces structure variation)

## §6 — Variable-content placement rules

Hard rules enforced by the pre-flight linter:

1. **No variable content above the cache break**. The linter scans content destined for the stable section for tokens that VARY across calls (timestamps, user message hashes, retrieved IDs). If detected, prompt rejected with explicit error.

2. **Cache break is mandatory** for any call where stable content > 1000 tokens. Below 1000 tokens, caching is not cost-effective and may be skipped.

3. **Substrate stable blocks live in declared order**. The order is: standing → V8.x-substrate-specific → tool defs → stable context. Reordering requires updating S1 spec + bumping cache-layout version.

4. **No "conditional stable" content**. If a block sometimes appears and sometimes doesn't based on per-call routing, it's NOT stable for caching purposes — move it after the cache break.

5. **Tool definition stability**. Tool schemas in the stable section are sorted alphabetically by name. Adding a new tool to the active set causes ONE cache invalidation, not a series.

### The linter

```typescript
type PromptLintResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimated_stable_tokens: number;
  estimated_variable_tokens: number;
};

function lintPromptStructure(prompt: PromptShape): PromptLintResult {
  // Checks:
  //  - cache_break is present iff stable > 1000 tokens
  //  - no timestamp / user-message / retrieved-id tokens in stable
  //  - substrate blocks in declared order
  //  - tool defs sorted
  //  - no conditional stable blocks
  // Errors block the LLM call. Warnings are logged to cost_ledger.
}
```

The linter runs in pre-flight (BEFORE the API call). Errors block the call entirely; the prompt-builder must produce a compliant structure or the call doesn't fire.

## §7 — Cache break markers

Anthropic API supports up to 4 cache breakpoints per request. S1 standard usage:

```typescript
type CacheBreakPlan =
  | { kind: "simple"; locations: ["after_stable_context"] } // most common
  | {
      kind: "two_stage";
      locations: ["after_standing_rules", "after_stable_context"];
    } // for tools that update NorthStar mid-call
  | {
      kind: "aggressive";
      locations: [
        "after_standing_rules",
        "after_substrate",
        "after_tools",
        "after_stable_context",
      ];
    }; // 4-breakpoint, max granularity
```

Default is `simple` (1 breakpoint at the canonical layout boundary). `two_stage` for tools that mutate operator-state mid-prompt (rare). `aggressive` only for tools with extremely heterogeneous variable content where partial cache hits are valuable.

### Marker syntax

In our internal prompt-build code:

```typescript
const prompt = builder
  .standingRules()
  .substrate(["v8-2", "s5"])
  .toolDefinitions()
  .stableContext()
  .cacheBreak() // <-- explicit boundary
  .variableContext({ retrieval, conversation, message })
  .build();
```

The builder API enforces order. `cacheBreak()` may only be called after `stableContext()` and before `variableContext()`.

## §8 — Per-tool cache configuration

Every tool declares its cache strategy in its tool definition:

```typescript
type CacheStrategy = "aggressive" | "standard" | "no_cache";

type ToolCacheConfig = {
  strategy: CacheStrategy;
  target_cache_read_ratio: number; // 0.0 - 1.0, e.g. 0.65 for 65%
  expected_stable_tokens: number;
  notes?: string;
};
```

Examples:

| Tool                      | Strategy   | Target | Notes                                                            |
| ------------------------- | ---------- | ------ | ---------------------------------------------------------------- |
| `morning_brief`           | aggressive | 0.85   | Daily call, mostly stable; principle block + tools               |
| `kb_search`               | standard   | 0.65   | Mid-frequency; tool defs cached, retrieval is variable           |
| `quick_classify`          | no_cache   | 0.0    | Many small heterogeneous calls; caching overhead > save          |
| `v8_2_judgment_generator` | aggressive | 0.90   | High-stakes, high-volume in mornings; principle block lives here |
| `v8_3_decision_proposer`  | aggressive | 0.85   | Standing rules + injection defense + tool defs all stable        |

### Why a per-tool target instead of system-wide

Different tools have different stable/variable token ratios. A tool with 5000 stable + 500 variable should hit ≥ 90% read. A tool with 200 stable + 2000 variable can't realistically exceed ~10%. System-wide targets penalize the wrong tools.

## §9 — Instrumentation

Every LLM call logs cache metrics to `cost_ledger`. Schema additions to existing `cost_ledger`:

```sql
ALTER TABLE cost_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cost_ledger ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cost_ledger ADD COLUMN prompt_lint_warnings_json TEXT;
ALTER TABLE cost_ledger ADD COLUMN cache_break_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cost_ledger ADD COLUMN cache_strategy TEXT
  CHECK (cache_strategy IN ('aggressive','standard','no_cache') OR cache_strategy IS NULL);
```

(Note: per `feedback_ipc_type_narrowing.md`, the IPC parse layer must also be updated to surface these fields — `as { ... }` narrowing at the boundary will silently drop them otherwise.)

### Computed metric: cache_read_ratio

```sql
CREATE VIEW v_tool_cache_health AS
SELECT
  tool_name,
  COUNT(*) AS calls,
  SUM(cache_read_tokens) AS total_cache_read,
  SUM(cache_creation_tokens) AS total_cache_creation,
  SUM(input_tokens) AS total_input,
  CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens), 0) AS cache_read_ratio,
  AVG(cache_break_count) AS avg_breaks,
  COUNT(CASE WHEN prompt_lint_warnings_json IS NOT NULL THEN 1 END) AS calls_with_warnings
FROM cost_ledger
WHERE timestamp > datetime('now', '-7 days')
GROUP BY tool_name;
```

### S3 drift detector watchpoint

S3 reads `v_tool_cache_health` nightly and alerts when any tool's `cache_read_ratio` drops below the declared `target_cache_read_ratio` — 7 day rolling.

The alert format:

```
[S1 watchpoint] Tool 'morning_brief' cache-read ratio dropped to 0.62 (target 0.85)
over 7-day window. Investigate prompt structure changes. Likely culprits:
  - per-call timestamp added to stable section
  - retrieval IDs leaking into substrate block
  - tool set changed mid-window (1 invalidation amortizes after ~24h)
Recent prompt commits affecting this tool: [list]
```

## §10 — Cross-substrate alignment

| Substrate | S1 dependency / consumption                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **V8.1**  | BriefingContext is variable per call → lives below cache break                                                                        |
| **V8.2**  | Strategic-voice principle block + decomposition contract template → stable; CRITIC prompts → stable; per-judgment evidence → variable |
| **V8.3**  | Standing prompt-injection rule + capability-token format docs → stable; per-decision payload → variable                               |
| **S2**    | CRITIC critic agent system prompt → stable; per-claim evidence → variable                                                             |
| **S3**    | Drift detector watches `v_tool_cache_health`; alerts on cache_read_ratio drop                                                         |
| **S4**    | cost_ledger schema extension (this spec); cache cost tracked per call per tool                                                        |
| **S5**    | Skill descriptions (frontmatter) → stable; skill invocation parameters → variable                                                     |

## §11 — Phasing (~5 days)

S1 is small but cuts across many tools. Phasing minimizes risk to existing callers.

### Phase 1 — PromptBuilder library + linter (~1.5 days)

- `src/lib/s1/builder.ts` — typed builder enforcing layout order
- `src/lib/s1/linter.ts` — pre-flight linter with rules from §6
- Test: 20 sample prompts, mix of compliant + violating, verify lint outcome
- Test: each error message has actionable text

### Phase 2 — cost_ledger schema extension + IPC parse update (~0.5 day)

- Migration adds 5 columns to `cost_ledger`
- Update IPC parse types in heavy/nanoclaw to surface fields (per `feedback_ipc_type_narrowing.md`)
- Test: synthetic LLM call → all fields populated end-to-end

### Phase 3 — `v_tool_cache_health` view + S3 watchpoint (~0.5 day)

- SQL view per §9
- S3 drift detector reads view nightly; alerts on threshold breach
- Test: synthetic 7-day cost_ledger data triggers expected alert

### Phase 4 — Tool migration (~2 days)

- Migrate 5 highest-volume tools first: `morning_brief`, `kb_search`, `v8_2_judgment_generator` (when shipped), `quick_classify`, `compose_message`
- Each migration: replace ad-hoc prompt assembly with PromptBuilder, declare cache config
- Test: pre-migration vs post-migration cache_read_ratio measured (should match or improve)

### Phase 5 — Remaining tools sweep (~0.5 day)

- Migrate remaining tools (~50 tools)
- Some may declare `no_cache` strategy explicitly (small heterogeneous calls)
- Test: full tool set passes lint

### Total: ~5 days

S1 ships before V8.2 (V8.2 declares cache_strategy='aggressive' for its tools and depends on the principle-block discipline). S1 can ship alongside V8.1 since V8.1 doesn't yet require the discipline at the same intensity.

## §12 — Activation gate & measurement

### Activation queries

```sql
-- Schema migration applied
SELECT name FROM pragma_table_info('cost_ledger') WHERE name IN
  ('cache_read_tokens','cache_creation_tokens','prompt_lint_warnings_json',
   'cache_break_count','cache_strategy');
-- Expected: 5 rows

-- All tools declare cache config
-- (in code: assert every tool has CacheConfig)

-- Top-5 tools migrated
SELECT tool_name, cache_strategy, COUNT(*) AS calls
FROM cost_ledger
WHERE timestamp > datetime('now', '-1 day')
  AND tool_name IN ('morning_brief','kb_search','v8_2_judgment_generator',
                    'quick_classify','compose_message')
GROUP BY tool_name, cache_strategy;
-- Expected: 5 rows, each with cache_strategy NOT NULL

-- 7-day cache_read_ratio for migrated tools meets target
SELECT tool_name, cache_read_ratio FROM v_tool_cache_health
WHERE tool_name IN (top-5 list);
-- Each row's cache_read_ratio ≥ declared target
```

### Operational metrics (post-S1)

- **Per-tool cache_read_ratio** — primary metric, watched by S3
- **Per-tool calls_with_warnings** — should trend toward 0 after migration
- **System-wide cache_read_tokens / total_input_tokens** — aggregate efficiency
- **Cost per 1000 calls per tool** — should drop after S1 migration on aggressive-strategy tools
- **Lint-rejected calls per day** — should be 0 in steady state (rejections only during dev iteration)

### Watchpoints

- **Cache_read_ratio drop > 10pp on a tool** in 7-day window — investigate prompt commit
- **prompt_lint_warnings_json non-null in production** — should never happen post-migration; investigate
- **Cache break count > 4** — Anthropic API limit; should be impossible via PromptBuilder but defensive
- **No cache reads on a declared-aggressive tool** — likely stale TTL or per-call structure variation; investigate

## §13 — Open questions

1. **Per-conversation cache vs per-tool cache**. Anthropic's cache is per-prefix; long conversations can have shared prefix amortizing across turns. Should S1 explicitly model this or leave it to implicit behavior?

2. **Cache break for streaming**. Streaming responses may want partial-flush semantics. Currently S1 is request-level; streaming is out-of-scope but flag for future.

3. **Cache TTL during low-traffic periods**. Cache TTL is 5 minutes. A tool called once an hour can never cache-hit. Should S1 explicitly recommend `no_cache` for low-frequency tools? Linter warning?

4. **Tool-set instability cost**. Adding a single new tool to the active set invalidates the tool-defs block for all tools sharing that set. How is this amortized? Cluster tools by usage pattern?

5. **Operator-context updates** (NorthStar pinned, project list). Currently invalidate stable section [4]. If operator updates frequently mid-day, [4] should move below cache break. Threshold for that demotion?

6. **Multi-model calls** (Sonnet/Opus/Haiku heterogeneity). Different models have different cache pricing. S1 currently model-agnostic; should it surface per-model cost in `v_tool_cache_health`?

7. **Cost-per-cache-break math**. Anthropic charges 1.25x base for cache write + 0.1x for cache read. Math says: amortize cache write across ≥3 reads to break even. Below that, no_cache wins. S1 doesn't currently codify this; should the linter compute estimated breakeven?

## §14 — Cross-references

### Reference memories + feedback files

- `feedback_cache_prefix_variability.md` — the load-bearing prior (P1-A measurement)
- `feedback_ipc_type_narrowing.md` — IPC parse layer must surface new fields
- `feedback_metrics_extrapolation.md` — n-floor discipline applies to cache metrics
- `feedback_phase_beta_gamma_patterns.md` — schema/migration discipline

### Specs

- `docs/V8-VISION.md` — V8 master vision (S1 substrate item)
- `docs/planning/v8-capability-1-spec.md` — V8.1 spec (BriefingContext is variable; lives below cache break)
- `docs/planning/v8-capability-2-spec.md` — V8.2 spec (strategic-voice principle block; canonical S1 case)
- `docs/planning/v8-capability-3-spec.md` — V8.3 spec (standing prompt-injection rule)
- `docs/planning/v8-substrate-s2-spec.md` — S2 spec (CRITIC system prompt is stable)
- `docs/planning/v8-substrate-s5-spec.md` — S5 spec (skill descriptions are stable)
- `docs/planning/v8-bibliography-synthesis.md` — synthesis index

### Code (post-Phase 1)

- `src/lib/s1/builder.ts` — PromptBuilder API
- `src/lib/s1/linter.ts` — pre-flight structure linter
- `src/lib/s1/cache-config.ts` — per-tool cache config registry
- `src/lib/s1/instrumentation.ts` — cost_ledger logging hook

### Migrations

- `migrations/NN_s1_cost_ledger_extension.sql`
- `migrations/NN_s1_tool_cache_health_view.sql`

## §15 — One-page summary

**What S1 is**: a substrate-level discipline + lint + instrumentation package that ensures Jarvis's prompt cache discipline scales to V8 surfaces.

**What it changes**:

1. Every Jarvis LLM call follows a **canonical prefix layout** (standing rules → substrate-specific blocks → tool defs → stable context → CACHE_BREAK → variable content).
2. A **pre-flight linter** rejects prompts that put variable content above the cache break.
3. Every tool **declares cache strategy + target read ratio**; mismatches are tracked.
4. Per-call cache metrics are logged to `cost_ledger`; **S3 drift detector watches** and alerts on regressions.
5. The 2026-04-26 P1-A class of failure becomes mechanically prevented, not just remembered.

**What it costs**: ~5 days, mostly tool migration. ~50 tools to sweep but most accept the migration boilerplate cleanly.

**What activates it**: schema migration applied + 5 highest-volume tools migrated + 7-day measurement showing each tool meets its declared cache_read_ratio target.

**Why it matters**: V8.2's strategic-voice principle block is ~250 stable tokens that must live in the cache prefix on every brief. Without S1 discipline, even ONE careless dev placing variable content above it tanks brief cost by ~30% per the P1-A measurement. With S1, the placement is mechanically prevented.

> "Prompt-cache structure matters as much as size." — `feedback_cache_prefix_variability.md`, the lesson S1 institutionalizes.
