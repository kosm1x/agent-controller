import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { ensureSelfHealingTables } from "./schema.js";
import { persistTriageReport, hasOpenTriageWithin } from "./persist.js";
import { runTriageAnalysis } from "./analyze.js";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import { CONFIDENCE_VALUES, SEVERITY_VALUES } from "./types.js";
import type { Anomaly, TriageReport } from "./types.js";

// The analysis is run only to read the submit tool it hands to the model. No
// model call: the SDK seam is replaced whole (any other export is absent and
// throws if used), and the cost ledger write is a no-op, so no database opens.
vi.mock("../../inference/claude-sdk.js", () => ({
  HAIKU_MODEL_ID: "stub-model",
  queryClaudeSdk: vi.fn(async () => ({
    model: "stub-model",
    costUsd: 0,
    usage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));
vi.mock("../../budget/service.js", () => ({ recordCost: vi.fn() }));

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

// Every severity and confidence a triage report may carry, each exactly once:
// a value added to or removed from the report type without these lists fails
// the test typecheck.
const SEVERITIES = { critical: true, high: true, medium: true, low: true } satisfies Record<
  TriageReport["severity"],
  true
>;
const CONFIDENCES = { high: true, medium: true, low: true } satisfies Record<
  TriageReport["confidence"],
  true
>;

describe("triage_report.severity and .confidence — the report type and the schema rules agree", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    ensureSelfHealingTables(db);
  });
  afterEach(() => db.close());

  // The values a column's CHECK rule lists, in the order it lists them.
  const ruleList = (column: string): string[] => {
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'triage_report'")
        .get() as { sql: string }
    ).sql;
    const rule = tableSql.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
    expect(rule).not.toBeNull();
    return rule![1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  };
  const ruleValues = (column: string): string[] => ruleList(column).sort();
  const stored = (id: string) =>
    db
      .prepare("SELECT severity, confidence FROM triage_report WHERE report_id = ?")
      .get(id);

  it("a report of every severity and of every confidence is written and read back with it", () => {
    for (const severity of Object.keys(SEVERITIES) as Array<TriageReport["severity"]>) {
      const id = persistTriageReport(db, { ...report, severity, confidence: "medium" }, anomalies);
      expect(stored(id)).toEqual({ severity, confidence: "medium" });
    }
    for (const confidence of Object.keys(CONFIDENCES) as Array<TriageReport["confidence"]>) {
      const id = persistTriageReport(db, { ...report, severity: "critical", confidence }, anomalies);
      expect(stored(id)).toEqual({ severity: "critical", confidence });
    }
  });

  it("the schema rules list exactly the report's severities and confidences and refuse any other", () => {
    expect(ruleValues("severity")).toEqual(Object.keys(SEVERITIES).sort());
    expect(ruleValues("confidence")).toEqual(Object.keys(CONFIDENCES).sort());

    // An unknown value, a known one in the wrong case, and an empty name — in
    // each column while the other holds an allowed value.
    const insert = db.prepare(
      "INSERT INTO triage_report (report_id, severity, root_cause, confidence) VALUES (?, ?, 'rc', ?)",
    );
    for (const severity of ["info", "HIGH", ""]) {
      expect(() => insert.run(`s-${severity}`, severity, "low")).toThrow(/CHECK constraint failed/);
    }
    for (const confidence of ["none", "Low", ""]) {
      expect(() => insert.run(`c-${confidence}`, "low", confidence)).toThrow(
        /CHECK constraint failed/,
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM triage_report").get()).toEqual({ n: 0 });
  });

  // The model fills the submit schema; the database refuses anything its rule
  // does not list. All three must name the same values, and the schema's order
  // is what the model sees, so the list, the rule and the schema agree in order.
  it("the value lists, the schema rules and the triage model's submit schema name the same values in the same order", async () => {
    await runTriageAnalysis(anomalies);
    const calls = vi.mocked(queryClaudeSdk).mock.calls;
    expect(calls).toHaveLength(1);
    const tools = calls[0][0].extraTools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["submit_triage_report"]);
    const shape = tools[0].inputSchema as Record<string, { options: readonly string[] }>;

    expect([...SEVERITY_VALUES]).toEqual(ruleList("severity"));
    expect(shape.severity.options).toEqual([...SEVERITY_VALUES]);
    expect([...SEVERITY_VALUES].sort()).toEqual(Object.keys(SEVERITIES).sort());

    expect([...CONFIDENCE_VALUES]).toEqual(ruleList("confidence"));
    expect(shape.confidence.options).toEqual([...CONFIDENCE_VALUES]);
    expect([...CONFIDENCE_VALUES].sort()).toEqual(Object.keys(CONFIDENCES).sort());
  });
});
