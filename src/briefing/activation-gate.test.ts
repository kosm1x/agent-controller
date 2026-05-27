/**
 * §13 activation-gate evaluator tests (V8.1 Phase 9 + 2026-05-27 spec
 * correction). Real in-memory DB — synthetic `cost_ledger` +
 * `proposed_briefings` rows. See activation-gate.ts header for the spec
 * correction rationale (cache-read measured on cacheable inference, NOT
 * on `reflection:%` — those rows fire too infrequently for cache TTL).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { evaluateActivationGate } from "./activation-gate.js";

/**
 * Insert a `cost_ledger` row with a given prompt/cache split. Default
 * agent_type `fast` is the dominant cacheable path (n-turn operator runner)
 * — that's the population the gate now measures. Callers may pass a
 * `reflection:*` agent_type when they want to verify those rows are
 * correctly EXCLUDED — see `EXCLUDES reflection:%` test.
 */
function insertCacheableCost(
  promptTokens: number,
  cacheReadTokens: number,
  agentType = "fast",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger
         (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
          cost_usd, cache_read_tokens, cache_creation_tokens)
       VALUES (?, 'gate-test', ?, 'sonnet', ?, 100, 0, ?, 0)`,
    )
    .run(crypto.randomUUID(), agentType, promptTokens, cacheReadTokens);
}

/** Insert N cacheable runs, each with the same prompt/cache split. */
function insertCacheableRuns(
  n: number,
  promptEach: number,
  cacheEach: number,
): void {
  for (let i = 0; i < n; i++) insertCacheableCost(promptEach, cacheEach);
}

/** Insert a proposed_briefings row with a given surface + status. */
function insertBriefing(surface: string, status: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings
         (briefing_id, surface, generated_at, briefing_json, status, expires_at)
       VALUES (?, ?, datetime('now'), '{}', ?, datetime('now','+1 day'))`,
    )
    .run(crypto.randomUUID(), surface, status);
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("evaluateActivationGate", () => {
  it("returns insufficient_data on an empty system", () => {
    const r = evaluateActivationGate();
    expect(r.verdict).toBe("insufficient_data");
    expect(r.cacheReadPct).toBeNull();
    expect(r.cacheableRuns).toBe(0);
  });

  it("PASSES when cache-read ≥80% over ≥20 runs and morning promote-rate ≥60%", () => {
    insertCacheableRuns(20, 1000, 850); // 85% cache-read
    // 7 morning briefs, 5 promoted → 71% promote-rate.
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate();
    expect(r.cacheReadPct).toBe(85);
    expect(r.checks.cacheRead.pass).toBe(true);
    expect(r.checks.promoteRate.pass).toBe(true);
    expect(r.verdict).toBe("pass");
  });

  it("FAILS when the cache-read ratio is below 80%", () => {
    insertCacheableRuns(20, 1000, 700); // 70% cache-read
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheReadPct).toBe(70);
    expect(r.checks.cacheRead.pass).toBe(false);
    expect(r.verdict).toBe("fail");
  });

  it("FAILS when the morning promote-rate is below 60%", () => {
    insertCacheableRuns(20, 1000, 900); // 90% — cache check passes
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired"); // 2/5 resolved promoted = 40%

    const r = evaluateActivationGate();
    expect(r.checks.cacheRead.pass).toBe(true);
    expect(r.checks.promoteRate.pass).toBe(false);
    expect(r.verdict).toBe("fail");
  });

  it("is insufficient_data with fewer than 20 cacheable runs", () => {
    insertCacheableRuns(10, 1000, 950);
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(10);
    expect(r.checks.cacheRead.pass).toBe(false);
    expect(r.verdict).toBe("insufficient_data");
  });

  it("is insufficient_data while morning briefs are generated but unresolved", () => {
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "pending");
    insertBriefing("morning", "pending");

    const r = evaluateActivationGate();
    expect(r.checks.promoteRate.pass).toBe(false);
    expect(r.checks.promoteRate.detail).toContain("none resolved");
    expect(r.verdict).toBe("insufficient_data");
  });

  it("excludes cost rows older than the 24h window", () => {
    insertCacheableRuns(20, 1000, 900); // 20 in-window rows at 90%
    // A stale 0%-cache row 2 days old — must NOT drag the ratio down.
    getDatabase()
      .prepare(
        `INSERT INTO cost_ledger
           (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
            cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, 't', 'fast', 'sonnet', 9999, 100, 0, 0, 0,
                 datetime('now','-2 days'))`,
      )
      .run(crypto.randomUUID());

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20); // stale row excluded
    expect(r.cacheReadPct).toBe(90); // ratio undragged
  });

  it("EXCLUDES reflection:% rows from the cache-read ratio", () => {
    // 20 cacheable rows at 90% — should drive the ratio.
    insertCacheableRuns(20, 1000, 900);
    // 10 reflection rows at 0% — must NOT drag the ratio down.
    for (let i = 0; i < 10; i++) {
      insertCacheableCost(5000, 0, "reflection:morning");
    }
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20); // reflection rows excluded from count
    expect(r.cacheReadPct).toBe(90); // ratio undragged by reflection 0%
    expect(r.checks.cacheRead.pass).toBe(true);
  });

  it("EXCLUDES rows with prompt_tokens = 0 (null-usage pollution)", () => {
    insertCacheableRuns(20, 1000, 900);
    // 5 null-usage rows that would otherwise count as 0% reads.
    for (let i = 0; i < 5; i++) insertCacheableCost(0, 0);

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20);
    expect(r.cacheReadPct).toBe(90);
  });

  // (Audit-R1 dropped: `cost_ledger.prompt_tokens` is `INTEGER NOT NULL
  // DEFAULT 0` per schema.sql — a NULL row cannot be inserted, so the
  // gate's `prompt_tokens > 0` filter never sees one. The `= 0` test above
  // covers the only path that reaches the filter.)

  it("treats exactly 20 runs at exactly 80% cache-read as a pass (>= boundary)", () => {
    insertCacheableRuns(20, 1000, 800); // exactly 80%, exactly 20 runs
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20);
    expect(r.cacheReadPct).toBe(80);
    expect(r.checks.cacheRead.pass).toBe(true);
    expect(r.verdict).toBe("pass");
  });

  it("reports per-surface briefing health", () => {
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "pending");
    insertBriefing("weekly", "discarded");

    const health = evaluateActivationGate().briefingHealth;
    const morning = health.find((h) => h.surface === "morning")!;
    expect(morning.generated).toBe(2);
    expect(morning.promoted).toBe(1);
    expect(morning.promoteRatePct).toBe(50);
  });
});
