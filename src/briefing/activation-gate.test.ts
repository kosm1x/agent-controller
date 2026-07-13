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
    // 7 morning briefs; 5 promoted + 1 discarded = 6 RULED → 83% promote-rate.
    // The `expired` brief is unruled and excluded from the denominator.
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
    insertBriefing("morning", "expired"); // unruled → excluded
    // 2 promoted / 4 RULED = 50%, below the 60% bar.

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
    expect(r.checks.promoteRate.detail).toContain("only 0 ruled on");
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

  it("EXCLUDES the 3.3 seam-metering row classes (allow-list, not exclusion)", () => {
    // 20 allow-listed rows at 90% — the intended §13 population.
    insertCacheableRuns(20, 1000, 900);
    // New classes written by the claude-sdk seam hook since V8.5 Phase 3.3 —
    // tiny cache-cold aux calls. Under the old NOT-LIKE/NOT-IN filter every
    // one of these would have joined the denominator and dragged 90% → FAIL.
    for (const agentType of [
      "sdk:unattributed",
      "chat:fast-path",
      "aux:scope-classifier",
      "v82:critic",
      "audit:critic",
      "tuning:eval-probe",
    ]) {
      for (let i = 0; i < 5; i++) insertCacheableCost(2000, 0, agentType);
    }
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20); // seam rows excluded from count
    expect(r.cacheReadPct).toBe(90); // ratio undragged
    expect(r.checks.cacheRead.pass).toBe(true);
  });

  it("KEEPS skill:% prefix rows in the ratio (pre-3.3 population preserved)", () => {
    insertCacheableRuns(18, 1000, 900);
    insertCacheableCost(1000, 900, "skill:weekly-report");
    insertCacheableCost(1000, 900, "skill:kb-cleanup");
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20); // skill:% still counted
    expect(r.cacheReadPct).toBe(90);
  });

  it("EXCLUDES once-daily `heavy` cold-start rows from the cache-read ratio", () => {
    // Mirrors the live 2026-07-10 shape that failed §13: `fast` sits ABOVE the
    // 80% bar, and a single once-daily `heavy` cold start (~47%, a (N-1)/N
    // ceiling at ~1.9 turns) is heavy enough in TOKENS to drag the weighted
    // aggregate under it. Without the exclusion this is 20,960/30,000 = 69.9%
    // → FAIL; with it, 81% → PASS.
    insertCacheableRuns(20, 1000, 810); // fast: 81%, above the bar
    insertCacheableCost(10_000, 4_760, "heavy"); // heavy: 47.6%, cold start
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheableRuns).toBe(20); // heavy row excluded from the count
    expect(r.cacheReadPct).toBe(81); // ratio undragged by heavy's cold start
    expect(r.checks.cacheRead.pass).toBe(true);

    // ...but the excluded row stays VISIBLE and non-gating, so the exclusion
    // can't silently hide a heavy cache regression (audit W1).
    expect(r.excludedColdStart).toEqual({
      runs: 1,
      cacheReadPct: 47.6,
      costUsd: 0,
    });
  });

  it("reports excludedColdStart as zero/null when no heavy rows are in the window", () => {
    insertCacheableRuns(20, 1000, 900);
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.excludedColdStart).toEqual({
      runs: 0,
      cacheReadPct: null,
      costUsd: 0,
    });
    expect(r.checks.cacheRead.pass).toBe(true); // absence never gates
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
    // promote-rate is over RULED briefs (promoted + discarded), not generated.
    // The `pending` brief carries no verdict, so it neither helps nor hurts:
    // 1/1 = 100%, not 1/2 = 50%. Silence is not a rejection.
    expect(morning.ruled).toBe(1);
    expect(morning.promoteRatePct).toBe(100);
  });

  it("does NOT let an EXPIRED (unanswered) brief count as a rejection", () => {
    // Since promotion requires an explicit "sirve"/"descarta", an unanswered
    // brief expires. Charging that silence against the promote-rate would fail
    // §13 for a reason unrelated to briefing quality.
    insertCacheableRuns(20, 1000, 900);
    for (let i = 0; i < 3; i++) insertBriefing("morning", "promoted"); // ≥ floor
    insertBriefing("morning", "expired");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate();
    const morning = r.briefingHealth.find((h) => h.surface === "morning")!;
    expect(morning.expired).toBe(2);
    expect(morning.ruled).toBe(3);
    expect(morning.promoteRatePct).toBe(100); // 3/3 ruled, NOT 3/5 generated
    expect(r.checks.promoteRate.pass).toBe(true);
  });

  it("does NOT let a single ruled brief decide the gate (audit W-B)", () => {
    // One discarded brief in a quiet week is 0/1 = 0% → would FAIL §13 on n=1.
    // Below the floor the check must be insufficient_data, never fail.
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired");
    insertBriefing("morning", "pending");

    const r = evaluateActivationGate();
    expect(r.checks.promoteRate.pass).toBe(false);
    expect(r.checks.promoteRate.detail).toContain("only 1 ruled on");
    expect(r.verdict).toBe("insufficient_data"); // NOT "fail"
  });

  it("is insufficient_data when every morning brief expired unanswered", () => {
    // Zero rulings → the rate is unknowable, not zero. Cadence trap: never fail.
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "expired");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate();
    expect(r.checks.promoteRate.pass).toBe(false);
    expect(r.checks.promoteRate.detail).toContain("only 0 ruled on");
    expect(r.verdict).toBe("insufficient_data"); // NOT "fail"
  });
});
