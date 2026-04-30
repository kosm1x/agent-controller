# V8 Substrate S4 — `cost_ledger` v2 (Universal Inference Path)

> Spec for the fourth of five V8 substrate items. S4 universalizes inference logging across ALL provider paths (claude-sdk, anthropic-direct, openai-compat, qwen, vllm-local, custom) so cost + cache + latency are observable end-to-end, not just on the path that happened to get instrumented first.
>
> Authored 2026-04-30 as a round-out of V8 substrate documentation. S4 is the data substrate that S1 (cache instrumentation) and S3 (cost-drift signals) consume. Without S4, we have ~30% visibility into Jarvis's actual inference economics.
>
> Activation: any time. Not freeze-blocking. S4 is mostly schema + a small adapter wrapper; no core inference path logic changes (only the surrounding instrumentation is unified).

## §1 — Problem

Today's `cost_ledger` is partial. The Claude Agent SDK path writes to it. Every other inference path — direct Anthropic API calls (used by some legacy tools), OpenAI-compatible endpoints (qwen, vLLM local, custom), and any provider that gets added next — is INVISIBLE to cost tracking.

The downstream effects:

- Cost-per-task math is wrong (we attribute SDK costs to a task and call it total; non-SDK calls don't show up)
- Per-model breakdown is incomplete (the qwen calls used by some specific tools don't surface)
- Cache instrumentation (S1) lives in the SDK adapter; non-SDK paths can't be lint-watched
- Drift detection (S3) on cost spikes is blind to non-SDK regressions
- V8.3 decision-cost linkage requires every decision's LLM calls flow through the same logger; today they don't

The 2026-04-26 P1-A measurement was specifically on the SDK path because that's what's logged. If the same regression happened on a non-SDK path, we wouldn't have caught it.

S4 is the discipline of "every inference call, regardless of provider, writes one row to one table." Single source of truth for cost, latency, cache, and decision-linkage.

## §2 — Current state (baseline)

What exists:

- `cost_ledger` table with columns for input_tokens, output_tokens, cost_usd, model, tool_name, timestamp, conversation_id
- The claude-sdk path (`src/inference/claude-sdk.ts`) logs every call to cost_ledger
- Per-task aggregation queries assume cost_ledger is complete (overstating visibility)
- Anthropic-direct adapter (`src/inference/anthropic.ts`) — used in some test paths — does NOT log
- OpenAI-compat adapter (`src/inference/adapter.ts` for raw fetch) — does NOT log to cost_ledger; partial logging to a different mechanism
- vLLM local + qwen + custom adapters — no centralized logging

What's missing (this spec ships):

1. **Universal `inference_events` schema** — one row per LLM call, regardless of provider
2. **Logging adapter wrapper** — every provider adapter calls `logInferenceEvent()` after the call
3. **Per-provider cost calculation** — `calculateCost(provider, model, tokens, cache)` with up-to-date pricing
4. **Budget table** — declared per-scope spending limits with warning thresholds
5. **Rollup views** — daily/weekly/monthly per-tool, per-provider, per-model, per-decision
6. **S1 cache extension columns** (already in V8.1 / S1 spec; consolidated here)
7. **V8.3 decision_id + V8.2 judgment_id linkage** for end-to-end attribution

## §3 — Precedents (composed)

### From `feedback_metrics_extrapolation.md`

n-floor + sample-list discipline. Cost per-tool computed under n<5 is junk; the rollup views must encode this constraint as a CHECK in queries.

### From `feedback_ipc_type_narrowing.md`

When passing usage from heavy/nanoclaw runners back to the parent, parse-side type narrowing (`as { ... }`) silently drops fields. S4 v2 schema requires the IPC parsers to surface every column or the data dies at the boundary. Type discipline is part of S4's correctness story.

### From `feedback_cache_prefix_variability.md` + S1 spec

Cache_read_tokens and cache_creation_tokens are first-class columns on the inference event. S1's `v_tool_cache_health` view reads from S4's table.

### From V8.3 spec §5 decisions

Every V8.3 decision's payload includes the LLM calls that produced it. S4's `decision_id` foreign key + V8.2's `judgment_id` foreign key let us answer "what did decision 0042 cost in inference?" with one query.

### From `feedback_phase_beta_gamma_patterns.md`

Schema/migration discipline: additive-only, idempotent, with a rollback path. S4 v2 is additive-extensions to existing `cost_ledger`, NOT a rename or replacement (which would be destructive).

### Explicit divergences

- **NOT a billing system** — S4 tracks cost as observation, not as basis for invoicing or cost-allocation. Single-operator scope.
- **NOT real-time streaming** — costs are logged at call-completion, not mid-stream. Streaming token counts captured at completion (per `feedback_streaming_token_counting.md` discipline: include `stream_options: {include_usage: true}` for OpenAI streaming).
- **NOT model-pricing-canonical** — pricing is a TABLE; we update it as providers update theirs. Don't hardcode in adapters.

## §4 — Architecture overview

```
[ inference adapters: claude-sdk / anthropic-direct / openai / qwen / vllm-local ]
                    │
                    └─→ All call logInferenceEvent() after API response
                                        │
                                        ▼
                          [ S4 logging adapter ]
                                        │
                                        ├─ calculateCost(provider, model, tokens, cache)
                                        │
                                        ▼
                          [ inference_events table ]  (one row per call)
                                        │
                            ┌───────────┼───────────┐
                            ▼           ▼           ▼
                  [ daily rollup ]  [ tool rollup ]  [ decision rollup ]
                                        │
                                        ▼
                          [ S3 drift detector reads here ]
                                        │
                                        ▼
                          [ V8.1 morning brief cost section ]
                                        │
                                        ▼
                          [ budget watchpoints + alerts ]
```

Five new tables (`inference_events`, `inference_daily_rollup`, `cost_budgets`, `provider_pricing`, `model_pricing`) + extensions to migrate from existing `cost_ledger`.

## §5 — Schema

### Universal inference event

```sql
CREATE TABLE inference_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  tool_name TEXT,
  conversation_id TEXT,
  decision_id INTEGER REFERENCES decisions(id),       -- V8.3 linkage
  judgment_id INTEGER REFERENCES judgments(id),       -- V8.2 linkage
  thread_id TEXT,                                      -- LangGraph linkage
  provider TEXT NOT NULL CHECK (provider IN
    ('claude-sdk','anthropic-direct','openai','qwen','vllm-local','custom')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,                 -- Anthropic extended thinking; OpenAI o1/o3
  cost_usd REAL NOT NULL,                              -- computed at insert time
  duration_ms INTEGER NOT NULL,
  cache_strategy TEXT CHECK (cache_strategy IN
    ('aggressive','standard','no_cache') OR cache_strategy IS NULL),
  cache_break_count INTEGER NOT NULL DEFAULT 0,
  prompt_lint_warnings_json TEXT,                      -- S1 lint output
  request_id TEXT,                                     -- provider-side request ID (for cross-reference)
  error_kind TEXT,                                     -- 'timeout','rate_limit','context_overflow','provider_error','none'
  metadata_json TEXT                                   -- arbitrary per-provider extras
);
CREATE INDEX idx_inference_events_at ON inference_events(occurred_at);
CREATE INDEX idx_inference_events_tool ON inference_events(tool_name, occurred_at);
CREATE INDEX idx_inference_events_provider_model ON inference_events(provider, model);
CREATE INDEX idx_inference_events_decision ON inference_events(decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX idx_inference_events_judgment ON inference_events(judgment_id) WHERE judgment_id IS NOT NULL;
CREATE INDEX idx_inference_events_conversation ON inference_events(conversation_id) WHERE conversation_id IS NOT NULL;
```

### Pricing tables

```sql
CREATE TABLE provider_pricing (
  provider TEXT PRIMARY KEY CHECK (provider IN
    ('claude-sdk','anthropic-direct','openai','qwen','vllm-local','custom')),
  base_currency TEXT NOT NULL DEFAULT 'USD',
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL REFERENCES provider_pricing(provider),
  model TEXT NOT NULL,
  effective_from TEXT NOT NULL,                        -- pricing effective date
  effective_until TEXT,                                -- NULL = currently active
  input_per_million REAL NOT NULL,                      -- USD per million input tokens
  output_per_million REAL NOT NULL,                     -- USD per million output tokens
  cache_read_per_million REAL,                          -- typically 0.1× input
  cache_creation_per_million REAL,                      -- typically 1.25× input
  reasoning_per_million REAL,                           -- for thinking-token providers
  notes TEXT,
  UNIQUE(provider, model, effective_from)
);
CREATE INDEX idx_model_pricing_active ON model_pricing(provider, model)
  WHERE effective_until IS NULL;
```

### Budgets

```sql
CREATE TABLE cost_budgets (
  scope TEXT PRIMARY KEY,                              -- 'daily','weekly','monthly','tool:morning_brief','provider:openai', etc.
  budget_usd REAL NOT NULL,
  warn_at_pct REAL NOT NULL DEFAULT 0.80,
  hard_cap_at_pct REAL NOT NULL DEFAULT 1.20,         -- 120% = hard alert
  current_period_start_at TEXT NOT NULL,
  current_spend_usd REAL NOT NULL DEFAULT 0,
  last_rolled_over_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);
```

### Rollups (materialized as views; pre-aggregated tables only if perf demands)

```sql
CREATE VIEW v_inference_daily AS
SELECT
  DATE(occurred_at) AS day,
  provider,
  model,
  tool_name,
  COUNT(*) AS calls,
  SUM(input_tokens) AS total_input,
  SUM(output_tokens) AS total_output,
  SUM(cache_read_tokens) AS total_cache_read,
  SUM(cache_creation_tokens) AS total_cache_creation,
  SUM(cost_usd) AS total_cost,
  AVG(duration_ms) AS avg_duration_ms,
  CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens), 0) AS cache_read_ratio
FROM inference_events
GROUP BY DATE(occurred_at), provider, model, tool_name;

CREATE VIEW v_inference_per_decision AS
SELECT
  decision_id,
  COUNT(*) AS llm_calls,
  SUM(cost_usd) AS total_cost_usd,
  SUM(duration_ms) AS total_duration_ms,
  GROUP_CONCAT(DISTINCT model) AS models_used
FROM inference_events
WHERE decision_id IS NOT NULL
GROUP BY decision_id;

CREATE VIEW v_inference_per_judgment AS
SELECT
  judgment_id,
  COUNT(*) AS llm_calls,
  SUM(cost_usd) AS total_cost_usd,
  SUM(duration_ms) AS total_duration_ms
FROM inference_events
WHERE judgment_id IS NOT NULL
GROUP BY judgment_id;

CREATE VIEW v_budget_health AS
SELECT
  scope,
  budget_usd,
  current_spend_usd,
  CAST(current_spend_usd AS REAL) / NULLIF(budget_usd, 0) AS pct_consumed,
  warn_at_pct,
  hard_cap_at_pct,
  CASE
    WHEN current_spend_usd >= budget_usd * hard_cap_at_pct THEN 'over_hard_cap'
    WHEN current_spend_usd >= budget_usd * warn_at_pct THEN 'warn'
    ELSE 'ok'
  END AS status
FROM cost_budgets WHERE enabled = 1;
```

## §6 — Universal logging adapter

The single function every adapter calls after an API response:

```typescript
// src/lib/s4/log.ts

type InferenceEventInput = {
  tool_name?: string;
  conversation_id?: string;
  decision_id?: number;
  judgment_id?: number;
  thread_id?: string;
  provider:
    | "claude-sdk"
    | "anthropic-direct"
    | "openai"
    | "qwen"
    | "vllm-local"
    | "custom";
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  duration_ms: number;
  cache_strategy?: "aggressive" | "standard" | "no_cache";
  cache_break_count?: number;
  prompt_lint_warnings?: string[];
  request_id?: string;
  error_kind?: string;
  metadata?: Record<string, unknown>;
};

export async function logInferenceEvent(
  input: InferenceEventInput,
): Promise<void> {
  const cost_usd = calculateCost(input.provider, input.model, {
    input: input.input_tokens,
    output: input.output_tokens,
    cache_read: input.cache_read_tokens ?? 0,
    cache_creation: input.cache_creation_tokens ?? 0,
    reasoning: input.reasoning_tokens ?? 0,
  });

  await db.run(
    `INSERT INTO inference_events
      (occurred_at, tool_name, conversation_id, decision_id, judgment_id, thread_id,
       provider, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, reasoning_tokens, cost_usd, duration_ms,
       cache_strategy, cache_break_count, prompt_lint_warnings_json,
       request_id, error_kind, metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      now(),
      input.tool_name,
      input.conversation_id,
      input.decision_id,
      input.judgment_id,
      input.thread_id,
      input.provider,
      input.model,
      input.input_tokens,
      input.output_tokens,
      input.cache_read_tokens ?? 0,
      input.cache_creation_tokens ?? 0,
      input.reasoning_tokens ?? 0,
      cost_usd,
      input.duration_ms,
      input.cache_strategy,
      input.cache_break_count ?? 0,
      input.prompt_lint_warnings
        ? JSON.stringify(input.prompt_lint_warnings)
        : null,
      input.request_id,
      input.error_kind ?? "none",
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );

  await updateBudgetSpend(cost_usd, input.tool_name, input.provider);
}
```

### Adapter integration

Each existing adapter (`claude-sdk.ts`, `anthropic.ts`, `adapter.ts`) gets a small shim added at response-completion path:

```typescript
// inside src/inference/anthropic.ts after API call returns
const responseAt = Date.now();
const usage = response.usage;

await logInferenceEvent({
  tool_name: ctx.tool_name,
  conversation_id: ctx.conversation_id,
  decision_id: ctx.decision_id,
  judgment_id: ctx.judgment_id,
  provider: "anthropic-direct",
  model: response.model,
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cache_read_tokens: usage.cache_read_input_tokens ?? 0,
  cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
  reasoning_tokens: usage.reasoning_tokens ?? 0,
  duration_ms: responseAt - requestAt,
  request_id: response.id,
  error_kind: "none",
});
```

### IPC type narrowing guard

Per `feedback_ipc_type_narrowing.md`: heavy/nanoclaw IPC parses receive usage from sub-runners. The parse layer MUST surface the full event shape, not narrow it. The InferenceEventInput type is exported from `src/lib/s4/types.ts` and is the single source of truth; any IPC boundary that downcasts it is a bug.

A regression test:

```typescript
test("IPC parse surfaces all S4 fields", () => {
  const fromHeavyRunner = parseIPCResponse(rawJson);
  expect(fromHeavyRunner.cache_read_tokens).toBeDefined();
  expect(fromHeavyRunner.cache_creation_tokens).toBeDefined();
  expect(fromHeavyRunner.cache_strategy).toBeDefined();
  expect(fromHeavyRunner.cache_break_count).toBeDefined();
});
```

## §7 — Cost calculation

```typescript
// src/lib/s4/cost.ts

type TokenBreakdown = {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  reasoning: number;
};

export function calculateCost(
  provider: string,
  model: string,
  tokens: TokenBreakdown,
): number {
  const pricing = readActivePricing(provider, model);
  if (!pricing) {
    log.warn(`No pricing for ${provider}/${model}; logging cost_usd=0`);
    return 0;
  }

  const cost =
    (tokens.input * pricing.input_per_million) / 1_000_000 +
    (tokens.output * pricing.output_per_million) / 1_000_000 +
    (tokens.cache_read * (pricing.cache_read_per_million ?? 0)) / 1_000_000 +
    (tokens.cache_creation * (pricing.cache_creation_per_million ?? 0)) /
      1_000_000 +
    (tokens.reasoning *
      (pricing.reasoning_per_million ?? pricing.output_per_million)) /
      1_000_000;

  return cost;
}

function readActivePricing(
  provider: string,
  model: string,
): ModelPricing | null {
  return db
    .prepare(
      `SELECT * FROM model_pricing
     WHERE provider=? AND model=? AND effective_until IS NULL
     ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(provider, model);
}
```

### Pricing seed (current as of 2026-04-30)

| Provider         | Model                      | Input $/M | Output $/M | Cache read $/M | Cache create $/M |
| ---------------- | -------------------------- | --------- | ---------- | -------------- | ---------------- |
| anthropic-direct | claude-opus-4-7            | 15.00     | 75.00      | 1.50           | 18.75            |
| anthropic-direct | claude-sonnet-4-6          | 3.00      | 15.00      | 0.30           | 3.75             |
| anthropic-direct | claude-haiku-4-5-20251001  | 0.80      | 4.00       | 0.08           | 1.00             |
| claude-sdk       | (mirrors anthropic-direct) | (same)    | (same)     | (same)         | (same)           |
| openai           | gpt-5                      | 5.00      | 20.00      | 0.50           | 6.25             |
| openai           | o3                         | 15.00     | 60.00      | 1.50           | n/a              |
| qwen             | qwen3-coder-plus           | 0.50      | 2.00       | n/a            | n/a              |
| vllm-local       | (any)                      | 0.00      | 0.00       | n/a            | n/a              |

Pricing is a TABLE not a hardcoded constant. Provider price changes = INSERT new row with `effective_from`, UPDATE prior row's `effective_until`. Old events keep their original cost (don't re-price history).

### Local-model pricing rationale

vllm-local entries are at $0/M because there's no marginal cost per call. We DO log them (so latency + token counts are observable) but don't accrue dollar cost. If GPU operating cost matters as observability data, add it to provider_pricing as a fixed per-hour amortization.

## §8 — Rollup queries

### Per-tool last 7 days

```sql
SELECT tool_name,
       COUNT(*) AS calls,
       SUM(cost_usd) AS spend,
       AVG(cost_usd) AS avg_cost_per_call,
       AVG(duration_ms) AS avg_latency_ms,
       cache_read_ratio
FROM v_inference_daily
WHERE day > date('now', '-7 days')
GROUP BY tool_name
ORDER BY spend DESC;
```

### Per-decision cost (V8.3 attribution)

```sql
SELECT d.id, d.capability, d.autonomy_level,
       v.llm_calls, v.total_cost_usd, v.total_duration_ms
FROM decisions d
JOIN v_inference_per_decision v ON v.decision_id = d.id
WHERE d.proposed_at > datetime('now', '-7 days')
ORDER BY v.total_cost_usd DESC;
```

### Per-brief cost (V8.2 attribution via judgment chain)

```sql
SELECT j.briefing_id, COUNT(DISTINCT j.id) AS judgments,
       SUM(v.total_cost_usd) AS brief_inference_cost
FROM judgments j
JOIN v_inference_per_judgment v ON v.judgment_id = j.id
WHERE j.created_at > datetime('now', '-7 days')
GROUP BY j.briefing_id;
```

### Provider mix

```sql
SELECT provider,
       SUM(cost_usd) AS spend,
       COUNT(*) AS calls,
       CAST(SUM(cost_usd) AS REAL) / (SELECT SUM(cost_usd) FROM inference_events WHERE occurred_at > datetime('now', '-7 days')) AS share
FROM inference_events
WHERE occurred_at > datetime('now', '-7 days')
GROUP BY provider;
```

## §9 — Budget tracking + warning

### Default budgets (seeded at activation)

| Scope                | Budget USD | Warn at | Hard cap | Notes                                  |
| -------------------- | ---------- | ------- | -------- | -------------------------------------- |
| `daily`              | 5.00       | 80%     | 120%     | Total system spend per day             |
| `weekly`             | 30.00      | 80%     | 120%     | Total system spend per week            |
| `monthly`            | 100.00     | 80%     | 130%     | Total system spend per month           |
| `tool:morning_brief` | 0.50       | 80%     | 200%     | One brief should cost ≤ $0.20 normally |
| `provider:openai`    | 5.00       | 80%     | 120%     | Per week; we use Anthropic primarily   |

Budgets are operator-tunable. Hard cap > 100% allows occasional spikes without freezing the system; sustained over-cap triggers an S3 alert.

### Update logic

`updateBudgetSpend()` is called from `logInferenceEvent()`:

```typescript
async function updateBudgetSpend(
  cost: number,
  toolName?: string,
  provider?: string,
): Promise<void> {
  const scopes: string[] = ["daily", "weekly", "monthly"];
  if (toolName) scopes.push(`tool:${toolName}`);
  if (provider) scopes.push(`provider:${provider}`);

  for (const scope of scopes) {
    const budget = await readBudget(scope);
    if (!budget?.enabled) continue;

    // Reset budget if period has rolled over
    if (periodHasRolledOver(scope, budget.current_period_start_at)) {
      await rolloverBudget(scope);
    }

    await db.run(
      `UPDATE cost_budgets SET current_spend_usd = current_spend_usd + ? WHERE scope = ?`,
      [cost, scope],
    );

    // S3 watchpoint check
    const updated = await readBudget(scope);
    if (
      updated.current_spend_usd >=
      updated.budget_usd * updated.hard_cap_at_pct
    ) {
      await emitDriftAlert("s4_budget_hard_cap", { scope, ...updated });
    } else if (
      updated.current_spend_usd >=
      updated.budget_usd * updated.warn_at_pct
    ) {
      await emitDriftAlert("s4_budget_warn", { scope, ...updated });
    }
  }
}
```

Period rollover for `daily` is at local midnight (operator timezone, currently America/Mexico_City). Weekly is Sunday 00:00. Monthly is 1st of month 00:00.

### S3 signal integration

S4 emits two drift signals to S3:

- `s4_budget_warn` (P2) — any budget at warn threshold
- `s4_budget_hard_cap` (P0) — any budget at hard-cap threshold

These are wired in S3's seed signal registry (per `docs/planning/v8-substrate-s3-spec.md` §5). S3 owns the alerting; S4 owns the data.

## §10 — Cross-substrate alignment

| Substrate | S4 dependency                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1**    | S1 cache instrumentation columns (cache_read, cache_creation, cache_strategy, cache_break_count, lint warnings) ARE S4 columns. S1 is the WRITER discipline; S4 is the storage discipline. |
| **S2**    | CRITIC pass cost attributable to specific judgments via judgment_id linkage                                                                                                                |
| **S3**    | S3 reads `v_budget_health` + `v_inference_daily`; S4 emits 2 drift signals                                                                                                                 |
| **S5**    | Skill-invocation cost attribution via tool_name (each skill is a tool)                                                                                                                     |
| **V8.1**  | Brief generation cost queryable end-to-end via judgment_id chain                                                                                                                           |
| **V8.2**  | Per-judgment cost (CRITIC + multi-option + decomposition all attributed)                                                                                                                   |
| **V8.3**  | Per-decision cost (decision_id linkage; total V8.3-execution cost queryable)                                                                                                               |

## §11 — Phasing (~4-5 days)

### Phase 1 — Schema additions + pricing seed (~1 day)

- Migration: 4 new tables (`inference_events`, `provider_pricing`, `model_pricing`, `cost_budgets`) + 4 views
- Seed pricing rows for currently-used provider/model combinations
- Seed default budgets
- Idempotent migration test

### Phase 2 — Universal logger + cost calculation (~1 day)

- `src/lib/s4/log.ts` — `logInferenceEvent` API
- `src/lib/s4/cost.ts` — `calculateCost` with pricing lookup
- `src/lib/s4/budget.ts` — `updateBudgetSpend` + period rollover
- Test: synthetic events log correctly; cost matches expected for known prices
- Test: budget rollover happens at boundary

### Phase 3 — Adapter integration (~1.5 days)

- Add logging shim to all 4 inference adapters (`claude-sdk.ts`, `anthropic.ts`, `adapter.ts` for OpenAI-compat, qwen path)
- IPC parse layer surfaces full event shape from heavy/nanoclaw runners
- Regression test: 10 synthetic calls per adapter all produce inference_events rows
- Backfill mode: existing cost_ledger rows can OPTIONALLY be migrated to inference_events (operator decision)

### Phase 4 — Rollup view validation (~0.5 day)

- All 4 views return expected aggregations against test data
- v_budget_health correctly classifies ok/warn/over_hard_cap

### Phase 5 — S3 signal wiring (~0.5 day)

- Two drift signals registered in S3 (`s4_budget_warn` P2, `s4_budget_hard_cap` P0)
- Test: synthetic spend triggers expected alerts

### Phase 6 — Operator dashboard query helpers (~0.5 day)

- `mc-ctl s4 spend --since=7d` — quick CLI roll-up
- `mc-ctl s4 budget` — current period status
- Test: CLI commands produce readable output

### Total: ~4.5 days

S4 is freeze-friendly because it's additive instrumentation with no behavior change to inference paths beyond a function call at the response-completion path. Risk is low; visibility gain is large.

## §12 — Activation gate & measurement

### Activation queries

```sql
-- Schema in place
SELECT name FROM sqlite_master WHERE name IN
  ('inference_events','provider_pricing','model_pricing','cost_budgets',
   'v_inference_daily','v_inference_per_decision','v_inference_per_judgment','v_budget_health');
-- Expected: 8 rows (4 tables + 4 views)

-- All adapters integrated (no inference call goes unlogged)
-- 7-day post-activation:
SELECT provider, COUNT(*) AS calls
FROM inference_events
WHERE occurred_at > datetime('now', '-7 days')
GROUP BY provider;
-- Expected: ≥ 1 row per active provider in actual workload

-- Pricing coverage: zero events with cost_usd=0 unless provider=vllm-local
SELECT COUNT(*) FROM inference_events
WHERE cost_usd = 0 AND provider != 'vllm-local'
  AND occurred_at > datetime('now', '-7 days');
-- Expected: 0 (any non-zero indicates missing pricing seed)

-- Budget tracking working
SELECT scope, current_spend_usd, status FROM v_budget_health;
-- Expected: 5 rows, current_spend_usd > 0 on at least 'daily' and 'weekly'

-- Decision linkage working
SELECT COUNT(*) FROM inference_events
WHERE decision_id IS NOT NULL AND occurred_at > datetime('now', '-7 days');
-- Expected: > 0 if V8.3 is also active
```

### Operational metrics

- **Adapter coverage**: % of inference paths writing to inference_events (target 100%)
- **Pricing coverage**: % of events with non-zero cost_usd (excl. local) — target 100%
- **Per-tool spend** — visible top-10 spenders monthly
- **Per-decision spend** — visible for V8.3 cost attribution
- **Provider mix** — share of spend per provider; track migrations
- **Cache_read_ratio at provider level** — Anthropic should be high (cached), OpenAI lower
- **Budget hit-rate** — frequency of warn/hard-cap fires per period

### Watchpoints

- **Sustained 0 events from a known-active provider** — that path's logging shim isn't wired or cache-busted; investigate
- **cost_usd = 0 anomaly** for non-local providers — pricing missing or stale
- **Per-decision cost > 1.5× p95** — investigate either bad pricing or runaway loop in V8.3 pipeline
- **Budget status='over_hard_cap'** for >24h — investigate cost spike root cause; possibly raise budget if expected
- **IPC parse drops a column** (test fails) — type narrowing regression; fix before merge per `feedback_ipc_type_narrowing.md`

## §13 — Open questions

1. **Migration of existing `cost_ledger` data** — backfill into `inference_events` or leave historical data in old table? Lean: backfill the last 90 days with provider='claude-sdk' inferred; older rows stay in legacy table for forensics.

2. **Provider-side cost reconciliation** — Anthropic's billing dashboard says X; our calculated cost says Y. How often to compare? Manual quarterly, automated would require billing API integration (out of scope for V8).

3. **vLLM-local opportunity cost** — should we attribute the GPU operating cost as a fixed amortization? Probably yes for observability, but rate-of-amortization is operator-set.

4. **Cost per skill** — skill_health includes failure rate but not cost-per-invocation. Should `v_inference_per_skill` join skill_invocations? Lean yes; small follow-on.

5. **Streaming token completion tracking** — for streaming responses, total tokens are known at completion. Are we capturing them on stream-end correctly across all providers? Per `feedback_streaming_token_counting.md`, OpenAI requires `include_usage: true`. Checklist for activation gate.

6. **Reasoning/thinking tokens for Anthropic extended-thinking + OpenAI o-series** — pricing varies; some providers charge thinking tokens at output rate, some at input rate. Pricing table column captures this; verify each provider's actual behavior.

7. **Multi-tenant cost attribution** — single-operator V8 doesn't need it. Flag for V9.

8. **Backfill conflict with budgets** — if we backfill 90 days, budgets shouldn't retroactively trigger alerts. Backfill with `skip_budget_update=true` flag.

9. **Log retention** — inference_events grows monotonically. Archive policy? Prune events > 365 days but keep daily rollups indefinitely. Operator-set.

10. **Currency support** — all USD today. Multi-currency = post-V9.

## §14 — Cross-references

### Reference memories + feedback

- `feedback_metrics_extrapolation.md` — n-floor discipline for rollups
- `feedback_ipc_type_narrowing.md` — IPC parse layer must surface full event shape
- `feedback_cache_prefix_variability.md` — the lesson that motivated the cache columns
- `feedback_streaming_token_counting.md` — OpenAI streaming usage capture
- `feedback_phase_beta_gamma_patterns.md` — additive migration discipline

### Specs

- `docs/V8-VISION.md` — V8 master vision (S4 substrate item §3)
- `docs/planning/v8-substrate-s1-spec.md` — S1 cache instrumentation columns are S4 columns
- `docs/planning/v8-substrate-s2-spec.md` — S2 CRITIC cost via judgment_id
- `docs/planning/v8-substrate-s3-spec.md` — S3 reads S4 budget signals
- `docs/planning/v8-substrate-s5-spec.md` — S5 skill-invocation cost via tool_name
- `docs/planning/v8-capability-1-spec.md` — V8.1 brief cost via judgment chain
- `docs/planning/v8-capability-2-spec.md` — V8.2 per-judgment cost queries
- `docs/planning/v8-capability-3-spec.md` — V8.3 per-decision cost queries

### Code (post-Phase 1)

- `src/lib/s4/log.ts` — logInferenceEvent
- `src/lib/s4/cost.ts` — calculateCost
- `src/lib/s4/budget.ts` — updateBudgetSpend + rollover
- `src/lib/s4/types.ts` — single-source InferenceEventInput
- `src/inference/{claude-sdk,anthropic,adapter}.ts` — adapter shims

### Migrations

- `migrations/NN_s4_inference_events.sql`
- `migrations/NN_s4_pricing.sql`
- `migrations/NN_s4_budgets.sql`
- `migrations/NN_s4_views.sql`
- `migrations/NN_s4_seed_pricing.sql`
- `migrations/NN_s4_seed_budgets.sql`

## §15 — One-page summary

**What S4 is**: universal inference-event logging across ALL provider paths, with cache instrumentation, budget tracking, and rollup views attributing cost to tools / decisions / judgments.

**What it changes**:

1. Every inference call writes to ONE table — no more per-provider blind spots.
2. Cost is **calculated from a pricing table**, not hardcoded — provider price changes are migrations, not code edits.
3. Cache columns (S1) are first-class — `cache_read_ratio` is queryable system-wide.
4. **Decision-level cost attribution** — "what did decision 0042 cost?" is one query.
5. **Budget tracking** with operator-set thresholds — S3 alerts on warn/hard-cap.
6. **IPC parse correctness** — heavy/nanoclaw runner usage flows through without column-narrowing.

**What it costs**: ~4.5 days, additive schema, low-risk adapter shim per provider path.

**What activates it**: schema migration + 4 adapter shims + 7-day shadow run with 100% inference path coverage + non-zero cost on all non-local events.

**Why it matters**: today we have ~30% visibility into Jarvis's actual inference economics. The other 70% is invisible to S3 drift detection, V8.3 decision-cost attribution, and any post-hoc "what did this brief cost end-to-end?" question. S4 closes the visibility gap.

> "If you can't measure it, you can't manage it." — the conventional wisdom S4 institutionalizes for the V8 inference layer.
