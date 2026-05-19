/**
 * v7.7 Spine 2 Bundle 3 — suppression tests.
 *
 * Real :memory: DB so reason-prefix routing → resolution_kind + row
 * mutations actually run. Idempotency + error paths covered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { suppressAlert } from "./suppression.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

function seedSignal(name: string = "sig_a"): number {
  const r = getDatabase()
    .prepare(
      `INSERT INTO drift_signals
         (signal_name, signal_kind, source_substrate, baseline_query,
          baseline_value_json, tolerance_json, cadence, alert_priority,
          established_at, established_by)
       VALUES (?, 'test', 'S1', 'SELECT 1', '{}', '{}', 'nightly', 'P1',
               '2026-05-19', 'test')`,
    )
    .run(name);
  return Number(r.lastInsertRowid);
}

function insertAlert(signalId: number, severity: "P0" | "P1" | "P2" = "P1") {
  const r = getDatabase()
    .prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status)
       VALUES (?, datetime('now'), '{"value":1}', '{}', 'above', ?, 'pending')`,
    )
    .run(signalId, severity);
  return Number(r.lastInsertRowid);
}

describe("suppressAlert — happy path", () => {
  it("operator_acknowledged when reason doesn't start with 'false positive: '", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    const r = suppressAlert(alertId, "Looked into it, expected behavior.");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolutionKind).toBe("operator_acknowledged");
      expect(r.alertId).toBe(alertId);
    }
    const row = getDatabase()
      .prepare("SELECT * FROM drift_alerts WHERE id = ?")
      .get(alertId) as Record<string, unknown>;
    expect(row.delivery_status).toBe("suppressed");
    expect(row.resolution_kind).toBe("operator_acknowledged");
    expect(typeof row.resolution_at).toBe("string");
    expect(row.acknowledged_by).toBe("operator");
  });

  it("false_positive when reason starts with 'false positive: '", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    const r = suppressAlert(
      alertId,
      "false positive: baseline placeholder out of date",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolutionKind).toBe("false_positive");

    const row = getDatabase()
      .prepare("SELECT resolution_kind FROM drift_alerts WHERE id = ?")
      .get(alertId) as { resolution_kind: string };
    expect(row.resolution_kind).toBe("false_positive");
  });

  it("appends until-timestamp to resolution_notes when provided", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    suppressAlert(alertId, "team will investigate", "2026-06-19T00:00:00Z");
    const row = getDatabase()
      .prepare("SELECT resolution_notes FROM drift_alerts WHERE id = ?")
      .get(alertId) as { resolution_notes: string };
    expect(row.resolution_notes).toContain("team will investigate");
    expect(row.resolution_notes).toContain("[until=2026-06-19T00:00:00Z]");
  });

  it("honors custom acknowledged_by", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    suppressAlert(alertId, "ack", undefined, "fede");
    const row = getDatabase()
      .prepare("SELECT acknowledged_by FROM drift_alerts WHERE id = ?")
      .get(alertId) as { acknowledged_by: string };
    expect(row.acknowledged_by).toBe("fede");
  });
});

describe("suppressAlert — error paths", () => {
  it("returns not_found for missing alert id", () => {
    const r = suppressAlert(99999, "any reason");
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "not_found") {
      expect(r.alertId).toBe(99999);
    } else if (!r.ok) {
      throw new Error(`expected not_found, got kind=${r.kind}`);
    }
  });

  it("returns already_resolved when alert is already suppressed", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    suppressAlert(alertId, "first call");
    const second = suppressAlert(alertId, "second call");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.kind).toBe("already_resolved");
      if (second.kind === "already_resolved") {
        expect(typeof second.resolvedAt).toBe("string");
      }
    }
  });

  it("rejects empty reason", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    const r = suppressAlert(alertId, "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_reason");
  });

  it("rejects whitespace-only reason", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    const r = suppressAlert(alertId, "   \n  ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_reason");
  });

  it("rejects invalid until ISO datetime", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    const r = suppressAlert(alertId, "reason", "not-a-date");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("invalid_reason");
      if (r.kind === "invalid_reason") {
        expect(r.detail).toContain("until");
      }
    }
  });
});

describe("suppressAlert — filtering behavior", () => {
  it("suppressed alert is filtered from active-alerts queries (resolution_at IS NOT NULL)", () => {
    const sig = seedSignal();
    const alertId = insertAlert(sig);
    suppressAlert(alertId, "ack");

    const active = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS c FROM drift_alerts WHERE resolution_at IS NULL",
      )
      .get() as { c: number };
    expect(active.c).toBe(0);
  });
});
