/**
 * V8.3 schema (Phase 0 + Phase 1) — 4 tables + view + the V8.2 dependency gate.
 *
 * Asserts the tables/indexes/view exist, the Phase-0 gate fails loud on a DB with
 * no V8.2 substrate, ensureV83Tables is idempotent, and the V8.1/V8.2 tables still
 * stand alongside the additions (rollback test).
 */

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { assertV82Dependencies, ensureV83Tables } from "./schema.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

function tableExists(name: string): boolean {
  return (
    getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) !== undefined
  );
}
function objectExists(name: string): boolean {
  return (
    getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE name = ?")
      .get(name) !== undefined
  );
}

describe("ensureV83Tables — schema presence", () => {
  it("creates all four decision tables", () => {
    for (const t of [
      "capability_autonomy",
      "capability_trust_signals",
      "decisions",
      "decision_events",
    ]) {
      expect(tableExists(t)).toBe(true);
    }
  });

  it("creates the audit_decisions view", () => {
    expect(
      getDatabase()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='view' AND name='audit_decisions'",
        )
        .get(),
    ).toBeDefined();
  });

  it("creates the declared indexes", () => {
    for (const idx of [
      "idx_decisions_capability_status",
      "idx_decisions_judgment",
      "idx_decision_events_kind",
    ]) {
      expect(objectExists(idx)).toBe(true);
    }
  });

  it("declares the capability + judgment foreign keys on decisions", () => {
    const fks = getDatabase()
      .prepare("PRAGMA foreign_key_list(decisions)")
      .all() as Array<{ table: string; from: string }>;
    const refs = fks.map((f) => `${f.table}.${f.from}`);
    expect(refs).toContain("capability_autonomy.capability");
    expect(refs).toContain("judgments.judgment_id");
  });

  it("is idempotent — re-running does not throw and keeps one table", () => {
    expect(() => ensureV83Tables(getDatabase())).not.toThrow();
    expect(() => ensureV83Tables(getDatabase())).not.toThrow();
    const n = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='capability_autonomy'",
      )
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("assertV82Dependencies — Phase-0 gate", () => {
  it("passes on a DB initialized with the V8.2 substrate", () => {
    expect(() => assertV82Dependencies(getDatabase())).not.toThrow();
  });

  it("throws loud on a bare DB with no V8.2 tables", () => {
    const bare = new BetterSqlite3(":memory:");
    try {
      expect(() => assertV82Dependencies(bare)).toThrow(
        /V8\.3 Phase-0 gate failed/,
      );
      expect(() => assertV82Dependencies(bare)).toThrow(/judgments/);
    } finally {
      bare.close();
    }
  });

  it("ensureV83Tables itself never reads (safe on a DB lacking V8.2 deps)", () => {
    const bare = new BetterSqlite3(":memory:");
    try {
      // Pure DDL — SQLite permits FK refs to tables created later; no throw.
      expect(() => ensureV83Tables(bare)).not.toThrow();
      expect(
        bare
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='capability_autonomy'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      bare.close();
    }
  });

  it("throws when only one of the two dep tables is present", () => {
    const partial = new BetterSqlite3(":memory:");
    partial.exec("CREATE TABLE judgments (id INTEGER PRIMARY KEY)");
    try {
      expect(() => assertV82Dependencies(partial)).toThrow(
        /reflection_followups/,
      );
    } finally {
      partial.close();
    }
  });
});

describe("V8.2 / V8.1 substrate coexists (rollback test)", () => {
  it("leaves the V8.2 dependency tables intact", () => {
    expect(tableExists("judgments")).toBe(true);
    expect(tableExists("reflection_followups")).toBe(true);
    expect(tableExists("attributed_claims")).toBe(true);
  });
});

describe("audit_decisions view — executable, not just present", () => {
  // SQLite validates a view body lazily: a typo in a projected column or a JOIN
  // predicate still creates the view at DDL time and only fails at SELECT. Since
  // the substrate is dormant (no decisions rows in prod), nothing else ever runs
  // the view — so these tests are the only guard against the view's JOIN/
  // projection drifting. The view is a Phase-1 artifact (spec §11 / §14 v1 gate).
  it("compiles and runs on an empty DB (locks all column + join references)", () => {
    expect(() =>
      getDatabase().prepare("SELECT * FROM audit_decisions").all(),
    ).not.toThrow();
  });

  it("projects current_capability_level and LEFT-JOINs trust signals as null", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO capability_autonomy
        (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
         blast_radius, reversible_default, override_window_start_at, description)
       VALUES ('task_edit', 1, '{}', '{}', 0, 'persistent', 1, datetime('now'), 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO decisions
        (capability, autonomy_level, status, capability_token_json, payload_json,
         proposed_at, thread_id)
       VALUES ('task_edit', 1, 'pending', '{}', '{}', datetime('now'), 't1')`,
    ).run();
    const rows = db.prepare("SELECT * FROM audit_decisions").all() as Array<{
      capability: string;
      autonomy_level: number;
      current_capability_level: number;
      override_rate: number | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].capability).toBe("task_edit");
    expect(rows[0].autonomy_level).toBe(1);
    expect(rows[0].current_capability_level).toBe(1); // ca.level alias
    expect(rows[0].override_rate).toBeNull(); // no trust_signals row → LEFT JOIN null
  });
});
