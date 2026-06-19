import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { ensureSelfHealingTables } from "./schema.js";
import { persistTriageReport, hasOpenTriageWithin } from "./persist.js";
import type { Anomaly, TriageReport } from "./types.js";

const anomalies: Anomaly[] = [
  {
    kind: "inference_degraded",
    detail: "success 60% < 80%",
    metric: "mc_provider_success_rate",
    observed: 0.6,
    threshold: 0.8,
    severity: "high",
  },
];
const report: TriageReport = {
  severity: "high",
  rootCause: "Sonnet quota exceeded",
  affectedComponents: ["inference"],
  recommendedActions: ["check the provider quota", "consider Haiku fallback"],
  confidence: "high",
};

describe("persistTriageReport / hasOpenTriageWithin", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    ensureSelfHealingTables(db);
  });
  afterEach(() => db.close());

  it("writes a triage_report row carrying the full diagnosis", () => {
    const id = persistTriageReport(db, report, anomalies, {
      model: "haiku",
      costUsd: 0.02,
    });
    const row = db
      .prepare("SELECT * FROM triage_report WHERE report_id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.severity).toBe("high");
    expect(row.root_cause).toBe("Sonnet quota exceeded");
    expect(JSON.parse(row.recommended_json as string)).toEqual([
      "check the provider quota",
      "consider Haiku fallback",
    ]);
    expect(JSON.parse(row.anomalies_json as string)).toHaveLength(1);
    expect(row.status).toBe("open");
    expect(row.model).toBe("haiku");
    expect(row.cost_usd).toBe(0.02);
  });

  it("throttle sees a fresh OPEN report and clears once acknowledged", () => {
    expect(hasOpenTriageWithin(db, 6)).toBe(false);
    const id = persistTriageReport(db, report, anomalies);
    expect(hasOpenTriageWithin(db, 6)).toBe(true);
    db.prepare(
      "UPDATE triage_report SET acknowledged_at = datetime('now') WHERE report_id = ?",
    ).run(id);
    expect(hasOpenTriageWithin(db, 6)).toBe(false);
  });
});
