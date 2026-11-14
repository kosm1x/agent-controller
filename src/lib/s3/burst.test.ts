/**
 * v7.7 Spine 2 — correlated-burst tests.
 *
 * Pure logic tests for detectBursts + persistBurstBundle. Uses :memory: DB
 * for the persist path so SQL is exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  detectBursts,
  persistBurstBundle,
  loadRecentUnbundledAlerts,
  BURST_WINDOW_MS,
  BURST_THRESHOLD,
} from "./burst.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import type { DriftAlertRecord } from "./evaluator.js";
import { evaluateSignal } from "./evaluator.js";
import { insertSignalIfMissing, loadAllSignals } from "./registry.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

function mkAlert(
  id: number,
  signalId: number,
  triggeredAtMsOffset: number,
  overrides: Partial<DriftAlertRecord> = {},
): DriftAlertRecord {
  const now = Date.now();
  return {
    id,
    signal_id: signalId,
    triggered_at: new Date(now + triggeredAtMsOffset).toISOString(),
    observed_value_json: '{"value":1}',
    baseline_value_json: '{"value":0}',
    deviation_kind: "above",
    severity: "P1",
    ...overrides,
  };
}

describe("detectBursts — pure logic", () => {
  it("empty input → no bundles", () => {
    expect(detectBursts([])).toEqual([]);
  });

  it("below threshold → no bundles", () => {
    const alerts = [mkAlert(1, 10, 0), mkAlert(2, 20, -1000)];
    expect(detectBursts(alerts)).toEqual([]);
  });

  it("exactly THRESHOLD alerts across different signals within window → 1 bundle", () => {
    const alerts = [
      mkAlert(1, 10, 0), // anchor (most recent)
      mkAlert(2, 20, -60_000), // 1 min ago
      mkAlert(3, 30, -120_000), // 2 min ago
    ];
    const bundles = detectBursts(alerts);
    expect(bundles.length).toBe(1);
    expect(bundles[0].members.length).toBe(BURST_THRESHOLD);
    expect(bundles[0].anchor.id).toBe(1);
  });

  it("does NOT bundle when all alerts share the same signal", () => {
    // Per spec §8: correlated burst requires DIFFERENT signals
    const alerts = [
      mkAlert(1, 10, 0),
      mkAlert(2, 10, -30_000),
      mkAlert(3, 10, -60_000),
    ];
    expect(detectBursts(alerts)).toEqual([]);
  });

  it("does NOT bundle when alerts are outside the 5-min window", () => {
    const alerts = [
      mkAlert(1, 10, 0),
      mkAlert(2, 20, -2 * BURST_WINDOW_MS),
      mkAlert(3, 30, -3 * BURST_WINDOW_MS),
    ];
    expect(detectBursts(alerts)).toEqual([]);
  });

  it("anchor is the most recent alert (sorted desc)", () => {
    const alerts = [
      mkAlert(2, 20, -60_000), // not the anchor — anchor is the most recent
      mkAlert(1, 10, 0), // most recent
      mkAlert(3, 30, -120_000),
    ];
    const bundles = detectBursts(alerts);
    expect(bundles[0].anchor.id).toBe(1);
  });

  it("already-bundled alerts (correlated_burst) are excluded", () => {
    const alerts = [
      mkAlert(1, 10, 0),
      mkAlert(2, 20, -30_000),
      mkAlert(3, 30, -60_000, { deviation_kind: "correlated_burst" }),
      mkAlert(4, 40, -90_000),
    ];
    const bundles = detectBursts(alerts);
    // 4 alerts → 3 eligible (excluding the correlated_burst) — still ≥ threshold
    expect(bundles.length).toBe(1);
    expect(bundles[0].members.map((m) => m.id).sort()).toEqual([1, 2, 4]);
  });

  it("each alert claimed by at most one bundle (no double-counting)", () => {
    // 5 alerts in window across 5 signals → ONE bundle of 5, not multiple
    // overlapping bundles
    const alerts = [
      mkAlert(1, 10, 0),
      mkAlert(2, 20, -30_000),
      mkAlert(3, 30, -60_000),
      mkAlert(4, 40, -90_000),
      mkAlert(5, 50, -120_000),
    ];
    const bundles = detectBursts(alerts);
    expect(bundles.length).toBe(1);
    expect(bundles[0].members.length).toBe(5);
  });

  it("two non-overlapping bursts → two bundles", () => {
    const alerts = [
      // Burst 1: 3 alerts within 1 minute
      mkAlert(1, 10, 0),
      mkAlert(2, 20, -30_000),
      mkAlert(3, 30, -60_000),
      // Burst 2: 3 alerts ~30 min later in time (older), distinct window
      mkAlert(4, 40, -30 * 60_000),
      mkAlert(5, 50, -30 * 60_000 - 30_000),
      mkAlert(6, 60, -30 * 60_000 - 60_000),
    ];
    const bundles = detectBursts(alerts);
    expect(bundles.length).toBe(2);
  });
});

describe("persistBurstBundle — SQL side-effects", () => {
  beforeEach(() => {
    // Seed a signal row so foreign-key-like joins work in queries below
    getDatabase()
      .prepare(
        `INSERT INTO drift_signals
           (signal_name, signal_kind, source_substrate, baseline_query,
            baseline_value_json, tolerance_json, cadence, alert_priority,
            established_at, established_by)
         VALUES ('s1','k','x','SELECT 1','{}','{}','hourly','P1',
                 '2026-05-19','test')`,
      )
      .run();
  });

  function insertRawAlert(
    signalId: number,
    severity: "P0" | "P1" | "P2" = "P1",
  ): number {
    const r = getDatabase()
      .prepare(
        `INSERT INTO drift_alerts
           (signal_id, triggered_at, observed_value_json, baseline_value_json,
            deviation_kind, severity, delivery_status)
         VALUES (?, datetime('now'), '{}', '{}', 'above', ?, 'pending')`,
      )
      .run(signalId, severity);
    return Number(r.lastInsertRowid);
  }

  it("persists bundle row + updates members' bundle_id", () => {
    const a1 = insertRawAlert(1, "P1");
    const a2 = insertRawAlert(1, "P2");
    const a3 = insertRawAlert(1, "P1");
    const members: DriftAlertRecord[] = [a1, a2, a3].map((id, i) =>
      mkAlert(id, 1, -i * 30_000, { severity: "P1" }),
    );
    const bundleId = persistBurstBundle({ anchor: members[0], members });

    const bundle = getDatabase()
      .prepare("SELECT * FROM drift_alerts WHERE id = ?")
      .get(bundleId) as Record<string, unknown>;
    expect(bundle.deviation_kind).toBe("correlated_burst");
    expect(bundle.severity).toBe("P1");

    const linked = getDatabase()
      .prepare("SELECT id, bundle_id FROM drift_alerts WHERE bundle_id = ?")
      .all(bundleId) as Array<{ id: number; bundle_id: number }>;
    expect(linked.length).toBe(3);
  });

  it("bundle severity inherits highest-severity member (P0 > P1 > P2)", () => {
    const a1 = insertRawAlert(1, "P2");
    const a2 = insertRawAlert(1, "P0"); // highest
    const a3 = insertRawAlert(1, "P1");
    const members: DriftAlertRecord[] = [
      mkAlert(a1, 1, 0, { severity: "P2" }),
      mkAlert(a2, 1, -30_000, { severity: "P0" }),
      mkAlert(a3, 1, -60_000, { severity: "P1" }),
    ];
    const bundleId = persistBurstBundle({ anchor: members[0], members });
    const bundle = getDatabase()
      .prepare("SELECT severity FROM drift_alerts WHERE id = ?")
      .get(bundleId) as { severity: string };
    expect(bundle.severity).toBe("P0");
  });
});

describe("loadRecentUnbundledAlerts — SQL query", () => {
  it("returns alerts within window, excludes bundled / resolved / correlated_burst", () => {
    // signal row first
    getDatabase()
      .prepare(
        `INSERT INTO drift_signals
           (signal_name, signal_kind, source_substrate, baseline_query,
            baseline_value_json, tolerance_json, cadence, alert_priority,
            established_at, established_by)
         VALUES ('s1','k','x','SELECT 1','{}','{}','hourly','P1',
                 '2026-05-19','test')`,
      )
      .run();
    const ins = getDatabase().prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status, bundle_id, resolution_at)
       VALUES (1, ?, '{}', '{}', ?, 'P1', 'pending', ?, ?)`,
    );
    // (a) recent + unbundled + unresolved + above — INCLUDED
    ins.run(new Date().toISOString(), "above", null, null);
    // (b) recent but already bundled — EXCLUDED
    ins.run(new Date().toISOString(), "above", 42, null);
    // (c) recent but resolved — EXCLUDED
    ins.run(new Date().toISOString(), "above", null, new Date().toISOString());
    // (d) recent but correlated_burst — EXCLUDED
    ins.run(new Date().toISOString(), "correlated_burst", null, null);

    const recent = loadRecentUnbundledAlerts();
    expect(recent.length).toBe(1);
    expect(recent[0].deviation_kind).toBe("above");
  });
});

// The evaluator writes `triggered_at` with datetime('now'): UTC text without a
// zone marker. The window bound must be in that format too — an ISO bound
// (`T…Z`) sorts above every zone-less value of the same calendar date, so the
// five-minute window would match nothing.
describe("loadRecentUnbundledAlerts — alerts as the evaluator writes them", () => {
  function seedSignal(name: string): number {
    return insertSignalIfMissing({
      signal_name: name,
      signal_kind: "k",
      source_substrate: "x",
      baseline_query: "SELECT n FROM zone_window_missing_table",
      baseline_value_json: "{}",
      tolerance_json: "{}",
      cadence: "hourly",
      alert_priority: "P1",
      established_at: "2026-01-01",
      established_by: "test",
    });
  }

  it("loads a burst the evaluator just wrote, so it gets bundled", async () => {
    seedSignal("zone-a");
    seedSignal("zone-b");
    seedSignal("zone-c");
    // A failing baseline query makes the evaluator write a query_failure alert.
    for (const s of loadAllSignals()) await evaluateSignal(s);
    const written = getDatabase()
      .prepare("SELECT triggered_at FROM drift_alerts")
      .all() as Array<{ triggered_at: string }>;
    expect(written).toHaveLength(3);
    for (const r of written) {
      expect(r.triggered_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }

    const recent = loadRecentUnbundledAlerts();
    expect(recent).toHaveLength(3);
    const bundles = detectBursts(recent);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].members).toHaveLength(3);
  });

  it("keeps a zone-less alert just inside the window and drops one just outside", () => {
    const id = seedSignal("zone-edge");
    const ins = getDatabase().prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status)
       VALUES (?, datetime('now', ?), '{}', '{}', ?, 'P1', 'pending')`,
    );
    ins.run(id, `-${BURST_WINDOW_MS / 1000 - 60} seconds`, "above"); // inside
    ins.run(id, `-${BURST_WINDOW_MS / 1000 + 60} seconds`, "below"); // outside
    const recent = loadRecentUnbundledAlerts();
    expect(recent.map((r) => r.deviation_kind)).toEqual(["above"]);
  });

  it("includes an alert exactly on the window's first second and drops one a second earlier", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z")); // bound: 11:55:00
      const id = seedSignal("zone-bound");
      const ins = getDatabase().prepare(
        `INSERT INTO drift_alerts
           (signal_id, triggered_at, observed_value_json, baseline_value_json,
            deviation_kind, severity, delivery_status)
         VALUES (?, ?, '{}', '{}', ?, 'P1', 'pending')`,
      );
      ins.run(id, "2026-03-10 11:55:00", "above"); // on the bound: inclusive
      ins.run(id, "2026-03-10 11:54:59", "below"); // one second before
      expect(loadRecentUnbundledAlerts().map((r) => r.deviation_kind)).toEqual(["above"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
