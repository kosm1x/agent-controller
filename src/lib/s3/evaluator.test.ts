/**
 * v7.7 Spine 2 — evaluator tests.
 *
 * Uses real in-memory SQLite (initDatabase(":memory:")) so the SQL paths
 * (INSERT into drift_alerts, UPDATE drift_signals) actually run. Mocks
 * prom-client for the prom: query path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { evaluateSignal, runBaselineQuery } from "./evaluator.js";
import { insertSignalIfMissing } from "./registry.js";
import client from "prom-client";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  client.register.clear();
  vi.restoreAllMocks();
});

function insertTestSignal(
  overrides: Partial<Parameters<typeof insertSignalIfMissing>[0]> = {},
) {
  const id = insertSignalIfMissing({
    signal_name: overrides.signal_name ?? "test_signal",
    signal_kind: "test",
    source_substrate: "test",
    baseline_query: overrides.baseline_query ?? "SELECT 100 AS value",
    baseline_value_json: overrides.baseline_value_json ?? '{"value":50}',
    tolerance_json:
      overrides.tolerance_json ??
      '{"kind":"absolute_threshold","op":"gt","value":50}',
    cadence: overrides.cadence ?? "nightly",
    alert_priority: overrides.alert_priority ?? "P1",
    enabled: overrides.enabled ?? 1,
    established_at: "2026-05-19T00:00:00.000Z",
    established_by: "test",
    notes: overrides.notes,
  });
  const signal = getDatabase()
    .prepare("SELECT * FROM drift_signals WHERE id = ?")
    .get(id) as Parameters<typeof evaluateSignal>[0];
  return signal;
}

describe("runBaselineQuery — SQL path", () => {
  it("returns first column of first row for valid SELECT", async () => {
    const v = await runBaselineQuery("SELECT 42 AS x");
    expect(v).toBe(42);
  });

  it("returns string when first column is text", async () => {
    const v = await runBaselineQuery("SELECT 'hello' AS x");
    expect(v).toBe("hello");
  });

  it("returns null when no rows", async () => {
    // drift_signals starts empty in :memory: → empty result
    const v = await runBaselineQuery(
      "SELECT signal_name FROM drift_signals WHERE id = -1",
    );
    expect(v).toBeNull();
  });

  it("throws on invalid SQL", async () => {
    await expect(
      runBaselineQuery("SELECT * FROM nonexistent_table"),
    ).rejects.toThrow();
  });

  it("throws on awaiting: sentinel (defensive — caller should skip)", async () => {
    await expect(runBaselineQuery("awaiting:something")).rejects.toThrow(
      /awaiting/,
    );
  });
});

describe("runBaselineQuery — prom path", () => {
  it("returns 0 for a registered counter with no samples", async () => {
    new client.Counter({
      name: "test_counter_empty",
      help: "test",
      labelNames: ["x"],
    });
    const v = await runBaselineQuery("prom:test_counter_empty");
    expect(v).toBe(0);
  });

  it("sums all label combinations into a scalar", async () => {
    const c = new client.Counter({
      name: "test_counter_summed",
      help: "test",
      labelNames: ["bucket"],
    });
    c.inc({ bucket: "a" }, 3);
    c.inc({ bucket: "b" }, 5);
    const v = await runBaselineQuery("prom:test_counter_summed");
    expect(v).toBe(8);
  });

  it("throws when metric not registered", async () => {
    await expect(runBaselineQuery("prom:nonexistent_metric")).rejects.toThrow(
      /not registered/,
    );
  });
});

describe("evaluateSignal — pass path (no alert)", () => {
  it("observed within tolerance → no alert, last_observed_value_json updated", async () => {
    const signal = insertTestSignal({
      baseline_query: "SELECT 30 AS value", // below threshold 50
    });
    const alertId = await evaluateSignal(signal);
    expect(alertId).toBeNull();

    const row = getDatabase()
      .prepare(
        "SELECT last_observed_value_json FROM drift_signals WHERE id = ?",
      )
      .get(signal.id) as { last_observed_value_json: string };
    expect(row.last_observed_value_json).toContain("30");

    const alertCount = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM drift_alerts")
      .get() as { c: number };
    expect(alertCount.c).toBe(0);
  });
});

describe("evaluateSignal — trip path (alert emitted)", () => {
  it("observed > threshold → drift_alert row, last_alert_id linked", async () => {
    const signal = insertTestSignal(); // SELECT 100, threshold gt 50
    const alertId = await evaluateSignal(signal);
    expect(alertId).not.toBeNull();

    const alert = getDatabase()
      .prepare("SELECT * FROM drift_alerts WHERE id = ?")
      .get(alertId) as Record<string, unknown>;
    expect(alert.signal_id).toBe(signal.id);
    expect(alert.deviation_kind).toBe("above");
    expect(alert.severity).toBe("P1");
    expect(alert.delivery_status).toBe("pending");
    expect(alert.observed_value_json).toContain("100");
  });
});

describe("evaluateSignal — query failure path", () => {
  it("invalid SQL → query_failure alert at P2 (NOT the signal's P-level)", async () => {
    const signal = insertTestSignal({
      baseline_query: "SELECT * FROM nonexistent_table",
      alert_priority: "P0", // signal's normal severity is P0
    });
    const alertId = await evaluateSignal(signal);
    expect(alertId).not.toBeNull();

    const alert = getDatabase()
      .prepare("SELECT * FROM drift_alerts WHERE id = ?")
      .get(alertId) as Record<string, unknown>;
    expect(alert.deviation_kind).toBe("query_failure");
    expect(alert.severity).toBe("P2"); // forced down to P2 per spec §7
    expect(alert.observed_value_json).toContain("error");
  });
});

describe("evaluateSignal — awaiting: sentinel path", () => {
  it("awaiting:* baseline_query short-circuits (no alert, no DB write)", async () => {
    const signal = insertTestSignal({
      baseline_query: "awaiting:V8.3-override-events",
      enabled: 1, // even if accidentally enabled, the awaiting path skips
    });
    const alertId = await evaluateSignal(signal);
    expect(alertId).toBeNull();

    const alertCount = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM drift_alerts")
      .get() as { c: number };
    expect(alertCount.c).toBe(0);

    // last_evaluated_at NOT updated for awaiting-source signals (caller
    // should mark them disabled anyway)
    const row = getDatabase()
      .prepare("SELECT last_evaluated_at FROM drift_signals WHERE id = ?")
      .get(signal.id) as { last_evaluated_at: string | null };
    expect(row.last_evaluated_at).toBeNull();
  });
});

describe("evaluateSignal — malformed signal JSON path", () => {
  it("corrupt baseline_value_json → query_failure alert", async () => {
    const signal = insertTestSignal({
      baseline_value_json: "not-valid-json",
    });
    const alertId = await evaluateSignal(signal);
    const alert = getDatabase()
      .prepare("SELECT * FROM drift_alerts WHERE id = ?")
      .get(alertId) as Record<string, unknown>;
    expect(alert.deviation_kind).toBe("query_failure");
    expect(alert.observed_value_json).toContain("bad signal JSON");
  });
});
