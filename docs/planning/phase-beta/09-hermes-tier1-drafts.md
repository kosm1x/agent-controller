# Hermes Tier 1 Adoption — F1 Fold-In Design Drafts

> **Exploration item:** D (from `05-exploration-plan.md`)
> **Run date:** 2026-04-14 session 67 wrap+3
> **Sources:** NousResearch/hermes-agent PR #6488 (empty response retry) + PR #6541 (rate-limit header capture) + `src/inference/adapter.ts` current surface
> **Purpose:** Draft two small Hermes adoption items as concrete code sketches so F1 doesn't get derailed by "how do we do this" mid-session. Both naturally fit inside F1's existing edits to `adapter.ts` for the Polygon fallback wiring.

---

## Headline findings

1. **Both items fit inside F1 cleanly.** Each adds 40-80 LOC in `src/inference/adapter.ts`, co-locates with the edit F1 is already making for the `PolygonAdapter`, and doesn't require new files, new dependencies, or new table columns.

2. **Empty response retry (#6488) is cheaper than Hermes's version.** Hermes had to handle "structured reasoning vs true empty" because they support reasoning-only outputs; we don't. Our version is ~25 LOC total.

3. **Rate-limit header capture (#6541) is bigger than the empty-response fix but still contained.** Hermes's 242-line `rate_limit_tracker.py` module parses 12 headers with formatting logic for CLI + gateway displays. Our version can be much simpler — ~60 LOC for parsing + stashing in `providerMetrics`, plus surfacing via a single new MCP tool `jarvis_rate_limit_stats`.

4. **Both items strengthen F1's `api_call_budget` table.** The budget table already tracks provider consumption client-side. These additions let us see what the _upstream_ thinks about our consumption, so we can cross-check and warn before a hard 429 lands. It's the right architectural direction — observability + client-side enforcement layered together.

5. **Tests for both are straightforward.** The empty-response fix has a 5-test matrix (truly empty, partial content, reasoning-only, tool-only, mixed). The rate-limit header parser has ~8 tests (12-header parse, absent headers, malformed values, multi-window, 80% warn threshold).

6. **No F1 estimate impact.** Both items fit inside the existing 1.7-session budget. Zero bloat risk per the exploration plan's original intent.

---

## Item 1 — Empty response retry with nudge

### What Hermes did (PR #6488)

**22 lines in `run_agent.py`**, 28 lines in tests. The minimal diff summary:

> When a model returns **no content, no structured reasoning, and no tool calls** (common with open models via OpenRouter/Ollama), the agent nudges the model up to 3 times before falling through to `(empty)`. Each retry appends the empty assistant message (to maintain role alternation) and a system nudge:
> `[System: Your last response was empty. Please provide a response to the user.]`

The key recovery-chain logic:

| Step | Condition                                  | Action                                  |
| ---- | ------------------------------------------ | --------------------------------------- |
| 1    | Prior tool turn had content                | Use `_last_content_with_tools` fallback |
| 2    | Structured reasoning, no text              | Thinking prefill continuation (#5931)   |
| 3    | **Truly empty (no content, no reasoning)** | **Nudge retry up to 3 times**           |
| 4    | All recovery exhausted                     | `(empty)` terminal                      |

Hermes gates retry on `_truly_empty` (content is None or whitespace-only) AND `not _has_structured` (no API reasoning fields). Inline `<think>` blocks are excluded — the model chose to reason, it just produced no visible text.

### Our current surface

In `src/inference/adapter.ts` the non-streaming path at line ~598-611 has a thin check:

```typescript
// Line 600
if (!choice) throw new Error("Empty response: no choices returned");
result = {
  content: choice.message.content,          // may be null or ""
  tool_calls: choice.message.tool_calls,    // may be undefined
  usage: data.usage ?? {...},
  provider: provider.name,
  latency_ms: Date.now() - start,
};
```

Two gaps:

1. **`!choice`** — we catch the extreme case (no choices at all) but throw immediately without retry.
2. **Content null/whitespace with no tool_calls** — we return it as a successful response with `content: null`, and the fast-runner's hallucination guard catches it downstream as a layer-1 read hallucination. That's too late — by the time we hit the guard, we've already lost a turn.

The observable symptoms in our production data:

- Qwen3 occasionally returns `content: null, tool_calls: []` on the first round of a fresh task. The existing doom-loop detector catches it but costs us one wasted round.
- GLM-5 returns `content: ""` (empty string) during provider degradation — same wasted-round cost.
- Sonnet via the SDK path almost never returns empty; this is an openai-adapter path problem only.

### Proposed implementation (~25 LOC)

Add a single helper function and call it inside the non-streaming path. Streaming path isn't affected because SSE always produces at least a `[DONE]` terminal — empty-stream is indistinguishable from "content is empty string" which the existing truncation detector handles.

```typescript
// src/inference/adapter.ts — new helper

const MAX_EMPTY_RETRIES = 3;
const EMPTY_NUDGE_CONTENT =
  "[System: Your last response was empty. Please provide a response to the user.]";

/**
 * Detects a truly-empty response from a reasoning model.
 * "Truly empty" = no visible content AND no tool calls AND no structured reasoning.
 * Inline <think> blocks in content are NOT empty — the model chose to reason.
 *
 * Adopted from NousResearch/hermes-agent PR #6488. Addresses Qwen/GLM/MiMo
 * occasional empty-first-round behavior on the openai-adapter path.
 * Sonnet via claude-sdk doesn't hit this because the SDK already retries.
 */
function isTrulyEmptyResponse(choice: OpenAIChoice): boolean {
  const content = choice.message.content;
  const hasContent = typeof content === "string" && content.trim().length > 0;
  const hasToolCalls =
    Array.isArray(choice.message.tool_calls) &&
    choice.message.tool_calls.length > 0;
  return !hasContent && !hasToolCalls;
}
```

Then in `callOpenAIProvider` (around line 598), wrap the non-streaming parse in a retry loop:

```typescript
} else {
  const data = (await response.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new Error("Empty response: no choices returned");

  // v7.7.5 Hermes #6488 adoption: retry up to 3 times with a nudge
  // when the response is truly empty (no content, no tool calls).
  // Qwen3 / GLM-5 occasionally produce empty first responses; nudge
  // rescues the round without falling back to a different provider.
  if (isTrulyEmptyResponse(choice)) {
    const retryMessages: ChatMessage[] = [
      ...request.messages,
      { role: "assistant", content: "" }, // maintain role alternation
      { role: "user", content: EMPTY_NUDGE_CONTENT },
    ];
    for (let attempt = 1; attempt <= MAX_EMPTY_RETRIES; attempt++) {
      console.log(
        `[inference] ${provider.name}/${provider.model} truly-empty response, nudge retry ${attempt}/${MAX_EMPTY_RETRIES}`,
      );
      const retryBody = { ...body, messages: retryMessages };
      const retryRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(retryBody),
        signal: combinedSignal,
      });
      if (!retryRes.ok) break; // fall through to provider fallback
      const retryData = (await retryRes.json()) as OpenAIResponse;
      const retryChoice = retryData.choices?.[0];
      if (retryChoice && !isTrulyEmptyResponse(retryChoice)) {
        result = {
          content: retryChoice.message.content,
          tool_calls: retryChoice.message.tool_calls,
          usage: retryData.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          provider: provider.name,
          latency_ms: Date.now() - start,
        };
        console.log(
          `[inference] ${provider.name}/${provider.model} nudge succeeded on attempt ${attempt}`,
        );
        break; // jump past the normal result-assignment below
      }
    }
  }

  // Fall-through: either non-empty on first try, or nudge retries exhausted.
  // In the exhausted case, result may still be the original empty choice,
  // which propagates to the fast-runner hallucination guard as before.
  if (!result!) {
    result = {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      provider: provider.name,
      latency_ms: Date.now() - start,
    };
  }
}
```

### Tests (~5 cases)

`src/inference/adapter.test.ts` (extend existing file):

```typescript
describe("empty response recovery (Hermes #6488)", () => {
  it("returns the first response when it has content", async () => {
    // Mock fetch → {choices: [{message: {content: "hello", tool_calls: []}}]}
    // Assert: 1 fetch call, result.content === "hello"
  });

  it("retries with nudge when content is null and no tool calls", async () => {
    // Mock fetch sequence: [truly_empty, {content: "recovered"}]
    // Assert: 2 fetch calls, second body contains EMPTY_NUDGE_CONTENT, result.content === "recovered"
  });

  it("retries up to 3 times on persistent emptiness", async () => {
    // Mock fetch sequence: [empty, empty, empty, {content: "finally"}]
    // Assert: 4 fetch calls total, result.content === "finally"
  });

  it("gives up after 3 retries and returns the last empty response", async () => {
    // Mock fetch sequence: [empty, empty, empty, empty]
    // Assert: 4 fetch calls, result.content === null (no throw)
  });

  it("does NOT retry when the response has tool_calls even if content is null", async () => {
    // Mock fetch → {content: null, tool_calls: [{...}]}
    // Assert: 1 fetch call, result.tool_calls.length === 1
  });

  it("does NOT retry when content is non-empty even if whitespace", async () => {
    // Mock fetch → {content: "   ok   ", tool_calls: []}
    // Note: our definition of "empty" uses .trim() so this is NOT retried
    // Assert: 1 fetch call, result.content === "   ok   "
    // Or alternatively: if we DO want to retry whitespace-only, change the test
  });
});
```

### Risks

| Risk                                                                    | Severity | Mitigation                                                                                                                                                                         |
| ----------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry loop amplifies cost on a broken provider                          | Low      | Capped at 3 retries; `api_call_budget` table tracks cost_units                                                                                                                     |
| Nudge message triggers a different failure mode in some models          | Low      | The message is plain English, not a magic token. If it backfires, adjust the string                                                                                                |
| Streaming path not covered                                              | Medium   | Streaming has its own truncation detector; the existing SSE parser already handles the "empty stream" case. If we see empty streaming responses in production, add a symmetric fix |
| Kimi's known behavior of returning empty on first round with tools > 20 | N/A      | v6.4 ST1 already strips tools from kimi requests, so kimi never reaches this code path with tools                                                                                  |

---

## Item 2 — Rate-limit header capture

### What Hermes did (PR #6541)

**New 242-line module** `agent/rate_limit_tracker.py` + 32 LOC in `run_agent.py` + 16 LOC each in `cli.py` and `gateway/run.py`. Parses 12 headers from every streaming API response:

```
x-ratelimit-{limit,remaining,reset}-{requests,tokens}{,-1h}
```

(4 buckets: per-minute requests, per-hour requests, per-minute tokens, per-hour tokens — each with limit/remaining/reset triples = 12 headers.)

Displays as:

```
Nous Rate Limits (captured just now):

  Requests/min   [░░░░░░░░░░░░░░░░░░░░]   0.1%  1/800 used  (799 left, resets in 59s)
  Requests/hr    [░░░░░░░░░░░░░░░░░░░░]   0.0%  7/33.6K used  (33.6K left, resets in 52m 40s)
  Tokens/min     [░░░░░░░░░░░░░░░░░░░░]   0.0%  1/8.0M used  (8.0M left, resets in 58s)
  Tokens/hr      [░░░░░░░░░░░░░░░░░░░░]   0.0%  49/336.0M used  (336.0M left, resets in 52m 39s)
```

Warnings fire when any bucket exceeds 80% usage.

### Our current surface

In `src/inference/adapter.ts` we read `response.body` but never touch `response.headers` on success paths. The fetch call at line 461 and line 576 just consumes the body. Rate-limit data from upstream providers (Nous Portal, OpenRouter, OpenAI, Anthropic via claude-sdk) is invisible to us except when we get a hard 429.

`providerMetrics` already stores per-provider latency, success, token counts in a rolling window. It's the natural home for rate-limit snapshots.

### Proposed implementation (~60 LOC total)

**Part A: Header parser (~30 LOC)** — new file `src/inference/rate-limit-tracker.ts`:

```typescript
/**
 * Parses x-ratelimit-* headers from OpenAI-compatible responses.
 * Adopted from NousResearch/hermes-agent PR #6541, simplified for our scope.
 *
 * Providers that emit these headers: Nous Portal, OpenRouter, Groq,
 * Anthropic (via claude-sdk path), some OpenAI deployments. Silent no-op
 * for providers that don't (local Ollama, some custom endpoints).
 */

export interface RateLimitBucket {
  limit: number;
  remaining: number;
  resetSeconds: number; // seconds until window resets
  usagePct: number; // 0-100
}

export interface RateLimitSnapshot {
  capturedAt: number; // Date.now() ms
  requestsPerMin?: RateLimitBucket;
  requestsPerHour?: RateLimitBucket;
  tokensPerMin?: RateLimitBucket;
  tokensPerHour?: RateLimitBucket;
}

export function parseRateLimitHeaders(
  headers: Headers,
): RateLimitSnapshot | null {
  const read = (key: string): number | undefined => {
    const v = headers.get(key);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const bucket = (
    limitKey: string,
    remainingKey: string,
    resetKey: string,
  ): RateLimitBucket | undefined => {
    const limit = read(limitKey);
    const remaining = read(remainingKey);
    const reset = read(resetKey);
    if (limit == null || remaining == null || reset == null) return undefined;
    const used = Math.max(0, limit - remaining);
    return {
      limit,
      remaining,
      resetSeconds: reset,
      usagePct: limit > 0 ? Math.round((used / limit) * 10000) / 100 : 0,
    };
  };

  const snapshot: RateLimitSnapshot = {
    capturedAt: Date.now(),
    requestsPerMin: bucket(
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-reset-requests",
    ),
    requestsPerHour: bucket(
      "x-ratelimit-limit-requests-1h",
      "x-ratelimit-remaining-requests-1h",
      "x-ratelimit-reset-requests-1h",
    ),
    tokensPerMin: bucket(
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-tokens",
    ),
    tokensPerHour: bucket(
      "x-ratelimit-limit-tokens-1h",
      "x-ratelimit-remaining-tokens-1h",
      "x-ratelimit-reset-tokens-1h",
    ),
  };

  // If NO buckets parsed, provider doesn't emit these headers — return null
  const anyBucket =
    snapshot.requestsPerMin ||
    snapshot.requestsPerHour ||
    snapshot.tokensPerMin ||
    snapshot.tokensPerHour;
  return anyBucket ? snapshot : null;
}
```

**Part B: Capture in adapter.ts (~15 LOC)** — after each successful fetch, stash the snapshot in `providerMetrics`:

```typescript
// After line 485 (non-streaming) and inside parseSSEStream completion (streaming),
// both paths reach this point with a valid response object.

const rateLimitSnapshot = parseRateLimitHeaders(response.headers);
if (rateLimitSnapshot) {
  providerMetrics.recordRateLimit(
    provider.name,
    provider.model,
    rateLimitSnapshot,
  );
  if (shouldWarnRateLimit(rateLimitSnapshot)) {
    console.warn(
      `[inference] ${provider.name}/${provider.model} rate limit warning:`,
      formatRateLimitWarning(rateLimitSnapshot),
    );
  }
}
```

**Part C: Extend `providerMetrics` (~10 LOC)** — `src/inference/provider-metrics.ts`:

```typescript
// New map keyed by `${provider}/${model}` → last snapshot
private rateLimits = new Map<string, RateLimitSnapshot>();

recordRateLimit(providerName: string, model: string, snapshot: RateLimitSnapshot): void {
  this.rateLimits.set(`${providerName}/${model}`, snapshot);
}

getRateLimits(): Array<{ providerModel: string; snapshot: RateLimitSnapshot }> {
  return Array.from(this.rateLimits.entries()).map(([pm, snap]) => ({
    providerModel: pm,
    snapshot: snap,
  }));
}
```

**Part D: MCP tool for Jarvis self-inspection (~20 LOC)** — new MCP tool in `src/api/mcp-server/tools.ts`:

```typescript
server.registerTool(
  "jarvis_rate_limit_stats",
  {
    description:
      "Recent rate-limit header snapshots from inference providers. Shows the remaining capacity per minute/hour for requests and tokens, sourced from x-ratelimit-* headers on the last response from each provider. Returns empty list if no providers emit rate-limit headers.",
    inputSchema: {},
  },
  async () => {
    try {
      const { providerMetrics } =
        await import("../../inference/provider-metrics.js");
      const snapshots = providerMetrics.getRateLimits();
      return ok({
        count: snapshots.length,
        capturedNewestFirst: snapshots.sort(
          (a, b) => b.snapshot.capturedAt - a.snapshot.capturedAt,
        ),
      });
    } catch (e) {
      return toolErr("jarvis_rate_limit_stats", e);
    }
  },
);
```

This becomes the 9th read-only jarvis\_\* MCP tool — Claude Code sessions can query rate-limit state without hitting mc-ctl.

### Warning threshold logic (~10 LOC)

```typescript
const RATE_LIMIT_WARN_PCT = 80;

export function shouldWarnRateLimit(snap: RateLimitSnapshot): boolean {
  return [
    snap.requestsPerMin,
    snap.requestsPerHour,
    snap.tokensPerMin,
    snap.tokensPerHour,
  ].some((b) => b && b.usagePct >= RATE_LIMIT_WARN_PCT);
}
```

Warnings go to console (visible in journalctl) and — future — can trigger a Jarvis self-notification if we add a `rate_limit_warning` event type.

### Tests (~8 cases)

`src/inference/rate-limit-tracker.test.ts` (new file):

```typescript
describe("parseRateLimitHeaders", () => {
  it("parses all 12 headers into 4 buckets", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "800",
      "x-ratelimit-remaining-requests": "799",
      "x-ratelimit-reset-requests": "59",
      // ... 9 more headers
    });
    const snap = parseRateLimitHeaders(headers);
    expect(snap?.requestsPerMin?.usagePct).toBeCloseTo(0.125);
    expect(snap?.requestsPerMin?.limit).toBe(800);
  });

  it("returns null when provider emits no rate-limit headers", () => {
    expect(parseRateLimitHeaders(new Headers())).toBeNull();
  });

  it("parses partial headers (only requests, no tokens)", () => {
    // Some providers emit only request limits
  });

  it("skips malformed numeric values", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "not-a-number",
      // ...
    });
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it("computes usagePct correctly at boundary values", () => {
    // 0% (remaining === limit), 100% (remaining === 0), 50%
  });
});

describe("shouldWarnRateLimit", () => {
  it("fires at 80% usage", () => {
    /* ... */
  });
  it("doesn't fire at 79% usage", () => {
    /* ... */
  });
  it("fires if ANY bucket crosses 80% even if others are at 0%", () => {
    /* ... */
  });
});
```

### Risks

| Risk                                                                               | Severity | Mitigation                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider doesn't emit rate-limit headers → parser returns null                     | Low      | Null path is silent no-op; no error, no metric write                                                                                                                                   |
| Header names differ across providers (Nous vs OpenAI vs Anthropic)                 | Medium   | Parser reads standard `x-ratelimit-*` shape; providers not emitting this shape simply return null. If we see divergence in production, add per-provider parsers inside the same module |
| `response.headers` isn't readable on streaming bodies in all fetch implementations | Low      | Node 20+ fetch exposes headers before consuming body; confirmed in Node docs. Test against our runtime                                                                                 |
| `providerMetrics.getRateLimits()` grows unbounded if we rotate models frequently   | Low      | Map keyed by `provider/model` caps at ~10 entries in practice (3 providers × 3 models max). If bigger, add LRU eviction                                                                |
| Warnings spam the console on a consistently-saturated provider                     | Medium   | Dedupe warnings: only log on state transitions (below-threshold → above-threshold), not every response                                                                                 |

---

## Integration plan — both items in F1

Both items land inside F1 because F1 is already editing `src/inference/adapter.ts` to wire up the `PolygonAdapter` work (which needs its own rate-limit tracking). The edit clustering is natural.

### Where each item goes in the F1 implementation order

Per `03-f1-preplan.md` Section 10 "Implementation order (single session, ~1.7x time)":

1. Schema DDL (15 min)
2. Types (15 min)
3. `timezone.ts` (30 min)
4. `validation.ts` (45 min)
5. `FredAdapter` (30 min)
6. `AlphaVantageAdapter` (90 min)
7. `PolygonAdapter` (60 min)
8. `DataLayer` facade (60 min)
9. Tools (45 min)
10. Smoke tests (15 min)
11. Live WhatsApp test (30 min)
12. Commit + push (10 min)

**Insert the Hermes items as steps 6.5 and 7.5** (adjacent to the adapter edits):

- **6.5 — Empty response retry** (~20 min): added while touching `adapter.ts` for the Alpha Vantage adapter's error handling. Pure diff inside `callOpenAIProvider`. Tests land alongside.
- **7.5 — Rate-limit header capture** (~35 min): new `rate-limit-tracker.ts` file + adapter.ts integration + providerMetrics extension + `jarvis_rate_limit_stats` MCP tool + tests. The MCP tool addition bumps our MCP tool count from 8 to 9.

**Total F1 session time delta:** +55 minutes ≈ +0.15 sessions. The F1 estimate stays at **~1.85 sessions** (was 1.7). Still inside the bound, still shippable in one sitting.

### Where each item gets tested

- **Empty response retry**: `src/inference/adapter.test.ts` (extend existing file) — 5-6 new tests
- **Rate-limit header parser**: `src/inference/rate-limit-tracker.test.ts` (new file) — 8 tests
- **MCP tool**: `src/api/mcp-server/tools.test.ts` (extend existing file) — 2 tests (happy path, empty-list case)

**Test count delta for F1:** +15 tests. Phase β's F1 test target moves from ~42 to ~57.

### What stays out of F1 (deferred to later Hermes adoption work)

These Tier 1 items from the Hermes review do NOT fit in F1:

| Item                                          | Why not F1                                                                  | Target session                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Compression floor + activity tracking (#7983) | Touches `src/prometheus/orchestrator.ts`, not adapter.ts. Non-adjacent edit | Before F3 (per original recommendation)                          |
| Background `watch_patterns` (#7635)           | New subsystem for runner subtasks; not adapter-layer                        | S3 or later, optional                                            |
| Adaptive streaming backoff (#7683)            | Streaming path tweak; correct layer but wider test surface                  | Post-F1 hardening pass if we see stream truncation in production |
| Turn-exit diagnostic logging (#6549)          | Low priority; nice-to-have observability                                    | Any session                                                      |

All four remain in `feedback_prometheus_upstream.md` Tier 1 adoption list. Deferring them until their natural edit cluster (F3 for compression floor, Phase γ for watch_patterns, etc.) avoids forcing unrelated changes into F1.

---

## Acceptance criteria for the F1 session

When F1 ships, the two Hermes adoptions are considered done if:

### Empty response retry (Item 1)

- [ ] `isTrulyEmptyResponse()` helper exists in adapter.ts
- [ ] Non-streaming path in `callOpenAIProvider` calls the retry loop when triggered
- [ ] Retry message sequence preserves role alternation (`user → assistant(empty) → user(nudge) → assistant(retry)`)
- [ ] Cap at 3 retries is enforced
- [ ] 5 new tests in `adapter.test.ts` cover: happy path, retry-succeeds, retry-exhausted, tool-only response (no retry), content-whitespace response
- [ ] Log line emits `[inference] <provider>/<model> nudge succeeded on attempt N` when retry works
- [ ] Log line emits `[inference] <provider>/<model> nudge exhausted after N attempts` when retry fails

### Rate-limit header capture (Item 2)

- [ ] `src/inference/rate-limit-tracker.ts` module exists with `parseRateLimitHeaders()` and `shouldWarnRateLimit()`
- [ ] `providerMetrics.recordRateLimit()` and `.getRateLimits()` methods added
- [ ] `adapter.ts` `callOpenAIProvider` calls the parser after every successful fetch (streaming + non-streaming)
- [ ] `anthropic.ts` path (claude-sdk bridge) also parses headers if present
- [ ] New MCP tool `jarvis_rate_limit_stats` registered in `src/api/mcp-server/tools.ts`
- [ ] 8 tests in `rate-limit-tracker.test.ts` cover: 12-header happy path, partial headers, missing headers, malformed values, boundary percentages, warn threshold
- [ ] 2 MCP tests in `tools.test.ts` cover the new tool (happy path, empty-provider-map case)
- [ ] Warning dedupe: don't spam console on every response — only log on state transitions

### Both

- [ ] F1 session total time stays under 2 sessions even with these additions (~1.85 est.)
- [ ] Test count delta is +15 (42 → 57 new F1 tests)
- [ ] No new dependencies
- [ ] No breaking changes to `InferenceResponse` interface (rate-limit data lives in `providerMetrics`, not in the response)

---

## Summary

Both items fit cleanly inside F1's existing adapter.ts edits, add ~85 LOC total, add 15 tests, and cost ~55 minutes of session time. The empty-response retry addresses a real production failure mode we've seen in Qwen/GLM. The rate-limit header capture is pure observability win — we'll finally know how close we are to hitting rate limits across all our providers instead of discovering it via 429s.

Neither item is a blocker for F1 starting. Both are pre-wired enough that the F1 session can implement them as a single 55-minute mechanical translation, not a design exercise.

The remaining four Hermes Tier 1 items (compression floor, watch_patterns, streaming backoff, turn-exit logging) stay deferred to their natural edit clusters, per the exploration plan's "don't bloat F1" principle.
