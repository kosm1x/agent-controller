import { afterEach, beforeEach, describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, initDatabase } from "../../db/index.js";
import {
  detectAnomalies,
  getStuckTaskCount,
  recentTaskErrors,
  type DetectDeps,
} from "./detect.js";

const P_SUCCESS = "min(mc_provider_success_rate)";
const P_TOOLERR = "sum(increase(mc_tool_errors_total[10m]))";
const P_KBDRIFT = "max(mc_kb_reindex_drift)";
const P_WAFLAP = "sum(increase(mc_whatsapp_disconnects_total[15m]))";
const P_BUDGET = "max(mc_budget_daily_spend_usd)";

function deps(
  metrics: Record<string, number | null>,
  stuck = 0,
  budgetDailyLimitUsd = 50,
): DetectDeps {
  return {
    queryPrometheus: async (expr) => (expr in metrics ? metrics[expr]! : null),
    getStuckTaskCount: () => stuck,
    budgetDailyLimitUsd,
  };
}

describe("detectAnomalies", () => {
  it("returns nothing when every metric is unavailable (null) and no tasks stuck", async () => {
    expect(await detectAnomalies(deps({}, 0))).toEqual([]);
  });

  it("returns nothing when all metrics are healthy", async () => {
    const a = await detectAnomalies(
      deps(
        {
          [P_SUCCESS]: 0.97,
          [P_TOOLERR]: 1,
          [P_KBDRIFT]: 0,
          [P_WAFLAP]: 0,
          [P_BUDGET]: 1.5,
        },
        0,
      ),
    );
    expect(a).toEqual([]);
  });

  it("flags inference degradation when success rate < 0.8", async () => {
    const a = await detectAnomalies(deps({ [P_SUCCESS]: 0.68 }));
    expect(a).toHaveLength(1);
    expect(a[0]!.kind).toBe("inference_degraded");
    expect(a[0]!.severity).toBe("high");
  });

  it("SKIPS a check whose metric is unavailable — null never manufactures an alarm", async () => {
    const a = await detectAnomalies(deps({ [P_SUCCESS]: null }));
    expect(a).toEqual([]);
  });

  it("flags stuck tasks from the DB signal", async () => {
    const a = await detectAnomalies(deps({}, 5));
    expect(a.map((x) => x.kind)).toContain("stuck_tasks");
  });

  it("flags a budget overrun above the limit supplied in deps", async () => {
    const a = await detectAnomalies(deps({ [P_BUDGET]: 42 }, 0, 10));
    const overrun = a.find((x) => x.kind === "budget_overrun");
    expect(overrun?.threshold).toBe(10);
    expect(overrun?.observed).toBe(42);
  });

  it("judges spend against the deps limit, not the environment", async () => {
    const prev = process.env.BUDGET_DAILY_LIMIT_USD;
    delete process.env.BUDGET_DAILY_LIMIT_USD;
    try {
      const a = await detectAnomalies(deps({ [P_BUDGET]: 20 }, 0, 50));
      expect(a.map((x) => x.kind)).not.toContain("budget_overrun");
    } finally {
      if (prev !== undefined) process.env.BUDGET_DAILY_LIMIT_USD = prev;
    }
  });

  it("raises no budget anomaly when the limit is infinite (limit unavailable)", async () => {
    const a = await detectAnomalies(
      deps({ [P_BUDGET]: 1e9 }, 0, Number.POSITIVE_INFINITY),
    );
    expect(a.map((x) => x.kind)).not.toContain("budget_overrun");
  });

  it("collects multiple distinct anomalies in one pass", async () => {
    const a = await detectAnomalies(
      deps({ [P_SUCCESS]: 0.5, [P_TOOLERR]: 99 }, 9),
    );
    expect(a.map((x) => x.kind).sort()).toEqual(
      ["inference_degraded", "stuck_tasks", "tool_error_spike"].sort(),
    );
  });
});

// The two DB signals run on the real `tasks` table (status CHECK, NOT NULL
// title/description). Both helpers swallow errors into 0 / [], so every case
// asserts a non-empty result: a broken statement must not pass as "nothing".
describe("detector statements on the real schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => closeDatabase());

  // started_at uses the database clock, the same clock the statement reads.
  function seed(taskId: string, status: string, startedAgo: string | null): void {
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, started_at)
       VALUES (?, 'synthetic task', 'synthetic description', ?,
               CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    ).run(taskId, status, startedAgo, startedAgo);
  }

  it("counts only running tasks started longer ago than the window", () => {
    seed("stuck-60", "running", "-60 minutes");
    seed("stuck-45", "running", "-45 minutes");
    seed("fresh-10", "running", "-10 minutes");
    seed("never-started", "running", null);
    seed("finished", "completed", "-120 minutes");
    expect(getStuckTaskCount(db)).toBe(2);
    expect(getStuckTaskCount(db, 50)).toBe(1);
    expect(getStuckTaskCount(db, 5)).toBe(3);
  });

  function seedFailed(
    taskId: string,
    status: string,
    error: string | null,
    updatedAt: string,
  ): void {
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, status, error, updated_at)
       VALUES (?, 'synthetic task', 'synthetic description', ?, ?, ?)`,
    ).run(taskId, status, error, updatedAt);
  }

  it("returns failed-task errors newest first, skips empty ones, truncates to 500 chars", () => {
    seedFailed("f1", "failed", "error one", "2026-01-01 10:00:00");
    seedFailed("f2", "failed", "error two", "2026-01-01 11:00:00");
    seedFailed("f3", "failed", "error three", "2026-01-01 12:00:00");
    seedFailed("f4", "failed", "x".repeat(600), "2026-01-01 13:00:00");
    seedFailed("f-null", "failed", null, "2026-01-01 14:00:00");
    seedFailed("f-empty", "failed", "", "2026-01-01 15:00:00");
    seedFailed("done", "completed", "not a failure", "2026-01-01 16:00:00");
    expect(recentTaskErrors(db)).toEqual([
      "x".repeat(500),
      "error three",
      "error two",
      "error one",
    ]);
    expect(recentTaskErrors(db, 2)).toEqual(["x".repeat(500), "error three"]);
  });
});
