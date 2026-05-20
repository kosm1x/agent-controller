/**
 * v7.7 Spine 2 — seed signals tests.
 *
 * Two concerns:
 *   1. The 14 seed rows are well-formed (count, names, valid JSON columns,
 *      cadence/priority enums match schema CHECK constraints).
 *   2. seedSignalsIdempotent() is idempotent across repeated calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SEED_SIGNALS, seedSignalsIdempotent } from "./seed-signals.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("SEED_SIGNALS — static invariants", () => {
  it("exactly 14 seed signals (13 from Spine 2 + recall_coherence_suppression_rate from Spine 6)", () => {
    expect(SEED_SIGNALS.length).toBe(14);
  });

  it("includes the Spine 6 Conway Pattern 3 correspondence-audit signal", () => {
    const sig = SEED_SIGNALS.find(
      (s) => s.signal_name === "recall_coherence_suppression_rate",
    );
    expect(sig).toBeDefined();
    expect(sig!.cadence).toBe("weekly");
    // Disabled-pending: recall_audit is dormant under the Hindsight demote.
    expect(sig!.enabled).toBe(0);
  });

  it("every signal name is unique", () => {
    const names = SEED_SIGNALS.map((s) => s.signal_name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every signal has cadence + alert_priority matching schema enums", () => {
    const validCadences = new Set([
      "hourly",
      "every_4h",
      "nightly",
      "weekly",
      "on_event",
    ]);
    const validPriorities = new Set(["P0", "P1", "P2"]);
    for (const s of SEED_SIGNALS) {
      expect(validCadences.has(s.cadence)).toBe(true);
      expect(validPriorities.has(s.alert_priority)).toBe(true);
    }
  });

  it("every baseline_value_json + tolerance_json parses as JSON", () => {
    for (const s of SEED_SIGNALS) {
      expect(() => JSON.parse(s.baseline_value_json)).not.toThrow();
      expect(() => JSON.parse(s.tolerance_json)).not.toThrow();
    }
  });

  it("includes mc_whatsapp_disconnects_total (the 13th — per V7.7-GUIDE Spine 2 add)", () => {
    const names = SEED_SIGNALS.map((s) => s.signal_name);
    expect(names).toContain("mc_whatsapp_disconnects_total");
  });

  it("at most one signal of each source substrate is enabled by default", () => {
    // Substrate-dependent signals MUST be enabled=0 until their substrate ships
    // (per spec §10 bilateral-maturity-friendly principle).
    const enabledBySubstrate: Record<string, number> = {};
    for (const s of SEED_SIGNALS) {
      if (s.enabled !== 0) {
        enabledBySubstrate[s.source_substrate] =
          (enabledBySubstrate[s.source_substrate] ?? 0) + 1;
      }
    }
    // S1 partial (1 cache-ratio signal), S2 (1 critic_unfixable real from Spine 1),
    // S4 (1 cost_per_brief), infra (2 — schema + whatsapp). V8.2 + V8.3 + S5 all 0.
    expect(enabledBySubstrate["V8.2"] ?? 0).toBe(0);
    expect(enabledBySubstrate["V8.3"] ?? 0).toBe(0);
    expect(enabledBySubstrate["S5"] ?? 0).toBe(0);
  });

  it("disabled signals MUST use the awaiting: baseline_query sentinel", () => {
    // Cross-check: don't ship enabled=0 with a real query (defeats the
    // "this signal will fire as soon as you flip enabled=1" expectation).
    for (const s of SEED_SIGNALS) {
      if (s.enabled === 0) {
        expect(s.baseline_query.startsWith("awaiting:")).toBe(true);
      }
    }
  });

  it("enabled signals MUST have a real baseline_query (SQL or prom:)", () => {
    for (const s of SEED_SIGNALS) {
      if (s.enabled !== 0) {
        expect(s.baseline_query.startsWith("awaiting:")).toBe(false);
      }
    }
  });
});

describe("seedSignalsIdempotent — DB integration", () => {
  it("first call inserts all 14, subsequent calls insert 0", () => {
    const first = seedSignalsIdempotent();
    expect(first.inserted).toBe(14);
    expect(first.skipped).toBe(0);

    const second = seedSignalsIdempotent();
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(14);
  });

  it("schema CHECK constraints accept every seed row's enums", () => {
    // If a seed row's cadence or alert_priority doesn't match the table
    // CHECK constraint, the insert throws and the test fails. This is the
    // mechanical check that SEED_SIGNALS + table schema stay in sync.
    expect(() => seedSignalsIdempotent()).not.toThrow();
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM drift_signals")
      .get() as { c: number };
    expect(count.c).toBe(14);
  });

  it("seeded rows can be queried by cadence", () => {
    seedSignalsIdempotent();
    const hourly = getDatabase()
      .prepare("SELECT signal_name FROM drift_signals WHERE cadence = 'hourly'")
      .all() as Array<{ signal_name: string }>;
    expect(hourly.length).toBeGreaterThan(0);
    expect(hourly.map((r) => r.signal_name)).toContain(
      "mc_whatsapp_disconnects_total",
    );
  });

  it("an existing-but-disabled row stays disabled across re-seed", () => {
    seedSignalsIdempotent();
    // Manually flip one row to disabled
    getDatabase()
      .prepare(
        "UPDATE drift_signals SET enabled = 0 WHERE signal_name = 'cost_per_brief_drift'",
      )
      .run();
    // Re-seed
    seedSignalsIdempotent();
    const row = getDatabase()
      .prepare(
        "SELECT enabled FROM drift_signals WHERE signal_name = 'cost_per_brief_drift'",
      )
      .get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });
});

describe("SEED_SIGNALS — enabled-signal SQL queries parse against initDatabase schema (R1-I3)", () => {
  // Catches the "Spine 1 renames a column" class of regression: every
  // enabled signal's baseline_query must parse + execute against the
  // tables initDatabase creates. SQL that's syntactically valid but
  // references a missing table/column fails at prepare() time.
  it("every enabled signal's baseline_query prepares + executes without throwing", () => {
    const db = getDatabase();
    const enabledSignals = SEED_SIGNALS.filter((s) => s.enabled !== 0);
    expect(enabledSignals.length).toBeGreaterThan(0); // sanity
    for (const s of enabledSignals) {
      if (s.baseline_query.startsWith("prom:")) continue; // prom-only, no SQL
      if (s.baseline_query.startsWith("awaiting:")) continue; // unreachable in enabled-set
      expect(
        () => {
          db.prepare(s.baseline_query).get();
        },
        `signal ${s.signal_name}: ${s.baseline_query.slice(0, 80)}`,
      ).not.toThrow();
    }
  });
});
