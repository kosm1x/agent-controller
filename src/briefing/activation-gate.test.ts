/**
 * §13 activation-gate evaluator tests (V8.1 Phase 9). Real in-memory DB —
 * synthetic `cost_ledger` + `proposed_briefings` rows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { evaluateActivationGate } from "./activation-gate.js";

/** Insert a reflection `cost_ledger` row with a given prompt/cache split. */
function insertReflectionCost(
  promptTokens: number,
  cacheReadTokens: number,
  agentType = "reflection:morning",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger
         (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
          cost_usd, cache_read_tokens, cache_creation_tokens)
       VALUES (?, 'reflect-task', ?, 'sonnet', ?, 100, 0, ?, 0)`,
    )
    .run(crypto.randomUUID(), agentType, promptTokens, cacheReadTokens);
}

/** Insert N reflection runs, each with the same prompt/cache split. */
function insertReflectionRuns(
  n: number,
  promptEach: number,
  cacheEach: number,
): void {
  for (let i = 0; i < n; i++) insertReflectionCost(promptEach, cacheEach);
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
    expect(r.reflectionRuns).toBe(0);
  });

  it("PASSES when cache-read ≥80% over ≥5 runs and morning promote-rate ≥60%", () => {
    insertReflectionRuns(5, 1000, 850); // 85% cache-read
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
    insertReflectionRuns(5, 1000, 700); // 70% cache-read
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.cacheReadPct).toBe(70);
    expect(r.checks.cacheRead.pass).toBe(false);
    expect(r.verdict).toBe("fail");
  });

  it("FAILS when the morning promote-rate is below 60%", () => {
    insertReflectionRuns(5, 1000, 900); // 90% — cache check passes
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

  it("is insufficient_data with fewer than 5 reflection runs", () => {
    insertReflectionRuns(3, 1000, 950);
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.reflectionRuns).toBe(3);
    expect(r.checks.cacheRead.pass).toBe(false);
    expect(r.verdict).toBe("insufficient_data");
  });

  it("is insufficient_data while morning briefs are generated but unresolved", () => {
    insertReflectionRuns(5, 1000, 900);
    insertBriefing("morning", "pending");
    insertBriefing("morning", "pending");

    const r = evaluateActivationGate();
    expect(r.checks.promoteRate.pass).toBe(false);
    expect(r.checks.promoteRate.detail).toContain("none resolved");
    expect(r.verdict).toBe("insufficient_data");
  });

  it("excludes reflection cost rows older than the 24h window", () => {
    insertReflectionRuns(5, 1000, 900); // 5 in-window rows at 90%
    // A stale 0%-cache row 2 days old — must NOT drag the ratio down.
    getDatabase()
      .prepare(
        `INSERT INTO cost_ledger
           (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
            cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, 't', 'reflection:morning', 'sonnet', 9999, 100, 0, 0, 0,
                 datetime('now','-2 days'))`,
      )
      .run(crypto.randomUUID());

    const r = evaluateActivationGate();
    expect(r.reflectionRuns).toBe(5); // stale row excluded
    expect(r.cacheReadPct).toBe(90); // ratio undragged
  });

  it("treats exactly 5 runs at exactly 80% cache-read as a pass (>= boundary)", () => {
    insertReflectionRuns(5, 1000, 800); // exactly 80%, exactly 5 runs
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate();
    expect(r.reflectionRuns).toBe(5);
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
