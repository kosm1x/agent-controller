/**
 * v7.7 Spine 2 Bundle 2 — delivery.ts tests.
 *
 * Pure rendering + SQL-against-:memory: coverage. The truncation cap, the
 * weekly-digest gating, and the empty-state-omits-section semantic are the
 * load-bearing assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadActiveAlertsForBrief,
  formatAlertSection,
  isSundayInMxTime,
  ALERT_SECTION_CAP,
  type BriefAlertRow,
  type BriefAlertSet,
} from "./delivery.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSignal(
  name: string,
  substrate: string = "test",
  priority: "P0" | "P1" | "P2" = "P1",
): number {
  const r = getDatabase()
    .prepare(
      `INSERT INTO drift_signals
         (signal_name, signal_kind, source_substrate, baseline_query,
          baseline_value_json, tolerance_json, cadence, alert_priority,
          established_at, established_by)
       VALUES (?, 'test', ?, 'SELECT 1', '{}', '{}', 'nightly', ?,
               '2026-05-19', 'test')`,
    )
    .run(name, substrate, priority);
  return Number(r.lastInsertRowid);
}

function insertAlert(
  signalId: number,
  severity: "P0" | "P1" | "P2",
  opts: {
    deviation_kind?: string;
    observed?: { value?: unknown; error?: string };
    triggeredAtMsOffset?: number;
    resolved?: boolean;
  } = {},
): number {
  const triggeredAt = new Date(
    Date.now() + (opts.triggeredAtMsOffset ?? 0),
  ).toISOString();
  const observedJson = JSON.stringify(opts.observed ?? { value: 1 });
  const r = getDatabase()
    .prepare(
      `INSERT INTO drift_alerts
         (signal_id, triggered_at, observed_value_json, baseline_value_json,
          deviation_kind, severity, delivery_status, resolution_at)
       VALUES (?, ?, ?, '{}', ?, ?, 'pending', ?)`,
    )
    .run(
      signalId,
      triggeredAt,
      observedJson,
      opts.deviation_kind ?? "above",
      severity,
      opts.resolved ? new Date().toISOString() : null,
    );
  return Number(r.lastInsertRowid);
}

function mkRow(overrides: Partial<BriefAlertRow> = {}): BriefAlertRow {
  return {
    id: 1,
    signal_name: "test_signal",
    signal_kind: "test",
    source_substrate: "test",
    triggered_at: new Date(Date.now() - 60_000).toISOString(),
    observed_value_json: '{"value":1.5}',
    deviation_kind: "above",
    severity: "P1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadActiveAlertsForBrief — SQL filter behavior
// ---------------------------------------------------------------------------

describe("loadActiveAlertsForBrief — SQL filtering", () => {
  it("returns empty sets when no alerts exist", () => {
    const set = loadActiveAlertsForBrief({});
    expect(set.p0).toEqual([]);
    expect(set.p1).toEqual([]);
    expect(set.p2_digest).toEqual([]);
  });

  it("groups by severity and excludes resolved alerts", () => {
    const sig = seedSignal("sig_a", "S1", "P1");
    insertAlert(sig, "P0");
    insertAlert(sig, "P1");
    insertAlert(sig, "P1", { resolved: true }); // excluded
    insertAlert(sig, "P2");

    const set = loadActiveAlertsForBrief({ includeP2Digest: true });
    expect(set.p0.length).toBe(1);
    expect(set.p1.length).toBe(1);
    expect(set.p2_digest.length).toBe(1);
  });

  it("omits P2 digest when includeP2Digest is false", () => {
    const sig = seedSignal("sig_a");
    insertAlert(sig, "P0");
    insertAlert(sig, "P2");
    insertAlert(sig, "P2");

    const set = loadActiveAlertsForBrief({ includeP2Digest: false });
    expect(set.p0.length).toBe(1);
    expect(set.p2_digest).toEqual([]);
  });

  it("joins signal metadata (signal_name + source_substrate)", () => {
    const sig = seedSignal("named_signal", "V8.2", "P0");
    insertAlert(sig, "P0");
    const set = loadActiveAlertsForBrief({});
    expect(set.p0[0].signal_name).toBe("named_signal");
    expect(set.p0[0].source_substrate).toBe("V8.2");
  });

  it("orders alerts newest-first", () => {
    const sig = seedSignal("sig_a");
    insertAlert(sig, "P1", { triggeredAtMsOffset: -120_000 }); // 2 min ago
    insertAlert(sig, "P1", { triggeredAtMsOffset: 0 }); // now (newest)
    insertAlert(sig, "P1", { triggeredAtMsOffset: -60_000 }); // 1 min ago

    const set = loadActiveAlertsForBrief({});
    expect(set.p1.length).toBe(3);
    expect(Date.parse(set.p1[0].triggered_at)).toBeGreaterThan(
      Date.parse(set.p1[1].triggered_at),
    );
    expect(Date.parse(set.p1[1].triggered_at)).toBeGreaterThan(
      Date.parse(set.p1[2].triggered_at),
    );
  });

  it("R1-W2 regression: SQL LIMIT caps fetch at ALERT_SECTION_CAP+1 rows", () => {
    const sig = seedSignal("sig_a");
    for (let i = 0; i < ALERT_SECTION_CAP + 10; i++) {
      insertAlert(sig, "P1", { triggeredAtMsOffset: -i * 1000 });
    }
    const set = loadActiveAlertsForBrief({});
    // SQL must return at most cap+1 rows — the +1 row signals overflow to
    // formatAlertSection without requiring a separate COUNT(*).
    expect(set.p1.length).toBe(ALERT_SECTION_CAP + 1);
  });

  it("R1-W3 regression: alert whose signal was deleted still surfaces with placeholder name (LEFT JOIN + COALESCE)", () => {
    const sig = seedSignal("orphan_signal", "S5", "P1");
    insertAlert(sig, "P1");
    // Simulate signal removal (operator-initiated, or migration cleanup)
    getDatabase().prepare("DELETE FROM drift_signals WHERE id = ?").run(sig);
    const set = loadActiveAlertsForBrief({});
    expect(set.p1.length).toBe(1); // alert MUST still appear, not silently dropped
    expect(set.p1[0].signal_name).toMatch(/<deleted signal \d+>/);
    expect(set.p1[0].source_substrate).toBe("<unknown>");
  });
});

// ---------------------------------------------------------------------------
// isSundayInMxTime — weekly digest gating
// ---------------------------------------------------------------------------

describe("isSundayInMxTime", () => {
  it("returns true for a known Sunday in MX time", () => {
    // 2026-05-17 12:00 UTC = 2026-05-17 06:00 MX = Sunday
    expect(isSundayInMxTime(new Date("2026-05-17T12:00:00Z"))).toBe(true);
  });

  it("returns false for a Monday", () => {
    expect(isSundayInMxTime(new Date("2026-05-18T12:00:00Z"))).toBe(false);
  });

  it("handles the midnight rollover in MX time", () => {
    // 2026-05-18 04:00 UTC = 2026-05-17 22:00 MX (still Sunday)
    expect(isSundayInMxTime(new Date("2026-05-18T04:00:00Z"))).toBe(true);
    // 2026-05-18 07:00 UTC = 2026-05-18 01:00 MX (now Monday)
    expect(isSundayInMxTime(new Date("2026-05-18T07:00:00Z"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatAlertSection — markdown rendering
// ---------------------------------------------------------------------------

describe("formatAlertSection — empty-state", () => {
  it("returns empty string when all sets are empty (OMIT discipline)", () => {
    const out = formatAlertSection({ p0: [], p1: [], p2_digest: [] });
    expect(out).toBe("");
  });
});

describe("formatAlertSection — populated", () => {
  it("renders P0 + P1 + P2 sections with counts and Spanish headers", () => {
    const set: BriefAlertSet = {
      p0: [mkRow({ severity: "P0", signal_name: "crit_a" })],
      p1: [mkRow({ severity: "P1", signal_name: "warn_a" })],
      p2_digest: [mkRow({ severity: "P2", signal_name: "info_a" })],
    };
    const out = formatAlertSection(set);
    expect(out).toContain("Alertas de deriva (S3)");
    expect(out).toContain("Crítico (P0) — 1");
    expect(out).toContain("Alta (P1) — 1");
    expect(out).toContain("Resumen semanal (P2) — 1");
    expect(out).toContain("crit_a");
    expect(out).toContain("warn_a");
    expect(out).toContain("info_a");
  });

  it("omits a section entirely when its bucket is empty", () => {
    const set: BriefAlertSet = {
      p0: [],
      p1: [mkRow({ severity: "P1" })],
      p2_digest: [],
    };
    const out = formatAlertSection(set);
    expect(out).not.toContain("Crítico (P0)");
    expect(out).not.toContain("Resumen semanal");
    expect(out).toContain("Alta (P1) — 1");
  });

  it("includes observed value extracted from observed_value_json", () => {
    const set: BriefAlertSet = {
      p0: [
        mkRow({
          severity: "P0",
          observed_value_json: '{"value":42.5}',
        }),
      ],
      p1: [],
      p2_digest: [],
    };
    const out = formatAlertSection(set);
    expect(out).toContain("observado: 42.5");
  });

  it("surfaces error message for query_failure alerts", () => {
    const set: BriefAlertSet = {
      p0: [],
      p1: [
        mkRow({
          severity: "P1",
          deviation_kind: "query_failure",
          observed_value_json: '{"value":null,"error":"no such column: foo"}',
        }),
      ],
      p2_digest: [],
    };
    const out = formatAlertSection(set);
    expect(out).toContain("error (no such column: foo)");
  });

  it("includes Spanish relative-time hints", () => {
    const set: BriefAlertSet = {
      p0: [],
      p1: [
        mkRow({
          severity: "P1",
          triggered_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      ],
      p2_digest: [],
    };
    const out = formatAlertSection(set);
    expect(out).toMatch(/hace 5 min/);
  });

  it("renders source_substrate next to the signal name", () => {
    const set: BriefAlertSet = {
      p0: [
        mkRow({
          severity: "P0",
          signal_name: "test_signal",
          source_substrate: "V8.3",
        }),
      ],
      p1: [],
      p2_digest: [],
    };
    expect(formatAlertSection(set)).toContain("(V8.3)");
  });

  it("truncates at ALERT_SECTION_CAP with explicit overflow footer (R1-W2 SQL LIMIT cap+1)", () => {
    // SQL fetches at most ALERT_SECTION_CAP + 1 rows; renderer detects
    // overflow without knowing the exact total (deliberately — no extra
    // COUNT(*) query). Simulate by feeding cap+1 rows.
    const many = Array.from({ length: ALERT_SECTION_CAP + 1 }, (_, i) =>
      mkRow({ id: i + 1, signal_name: `sig_${i}` }),
    );
    const set: BriefAlertSet = { p0: [], p1: many, p2_digest: [] };
    const out = formatAlertSection(set);
    // Only first N appear
    expect(out).toContain("sig_0");
    expect(out).toContain(`sig_${ALERT_SECTION_CAP - 1}`);
    expect(out).not.toContain(`sig_${ALERT_SECTION_CAP}`);
    // Overflow footer mentions "Más alertas activas" (no specific count)
    expect(out).toMatch(/Más alertas activas/);
    expect(out).toContain("drift_alerts");
    expect(out).toContain(`mostrando primeras ${ALERT_SECTION_CAP}`);
  });

  it("R1-W2 regression: at-cap-exactly does NOT show overflow footer", () => {
    const exactly = Array.from({ length: ALERT_SECTION_CAP }, (_, i) =>
      mkRow({ id: i + 1, signal_name: `sig_${i}` }),
    );
    const set: BriefAlertSet = { p0: [], p1: exactly, p2_digest: [] };
    const out = formatAlertSection(set);
    expect(out).not.toMatch(/Más alertas activas/);
  });
});

describe("formatAlertSection — markdown shape sanity (LLM copies verbatim)", () => {
  it("starts with the section heading", () => {
    const set: BriefAlertSet = {
      p0: [mkRow({ severity: "P0" })],
      p1: [],
      p2_digest: [],
    };
    expect(formatAlertSection(set).startsWith("## 🚨 Alertas de deriva")).toBe(
      true,
    );
  });

  it("has no trailing whitespace (clean copy boundary)", () => {
    const set: BriefAlertSet = {
      p0: [mkRow({ severity: "P0" })],
      p1: [],
      p2_digest: [],
    };
    const out = formatAlertSection(set);
    expect(out).toBe(out.trimEnd());
  });

  it("preserves signal names verbatim (no Spanish translation of identifiers)", () => {
    const set: BriefAlertSet = {
      p0: [
        mkRow({
          severity: "P0",
          signal_name: "mc_whatsapp_disconnects_total",
        }),
      ],
      p1: [],
      p2_digest: [],
    };
    expect(formatAlertSection(set)).toContain("mc_whatsapp_disconnects_total");
  });
});
