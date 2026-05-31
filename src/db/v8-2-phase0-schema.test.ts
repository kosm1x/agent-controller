/**
 * V8.2 Phase 0 schema — judgments + reflection_followups (spec §5).
 *
 * Asserts the tables/indexes exist, the FK CASCADE + CHECK constraints hold,
 * initDatabase is idempotent on an existing on-disk schema, and the V8.1
 * substrate still stands alongside the additions.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";

const T0 = "2026-05-31T00:00:00.000Z";
const FUTURE = "2026-12-31T00:00:00.000Z";

let tmpDbPath: string | null = null;

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    tmpDbPath = null;
  }
});

function tableExists(name: string): boolean {
  return (
    getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) !== undefined
  );
}

describe("schema presence", () => {
  it("creates judgments + reflection_followups with their indexes", () => {
    const db = getDatabase();
    expect(tableExists("judgments")).toBe(true);
    expect(tableExists("reflection_followups")).toBe(true);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(idx).toContain("idx_judgments_briefing");
    expect(idx).toContain("idx_judgments_created");
    expect(idx).toContain("idx_reflection_followups_due");
  });

  it("V8.1 substrate still stands alongside the additions", () => {
    for (const t of [
      "proposed_briefings",
      "general_events",
      "recurring_blockers",
      "self_defining_cohort",
      "triage_policies",
      "trigger_runs",
    ]) {
      expect(tableExists(t)).toBe(true);
    }
  });
});

describe("judgments FK + CHECK constraints", () => {
  function insertBriefing(db = getDatabase(), id = "b1") {
    db.prepare(
      `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
       VALUES (?,?,?,?,?)`,
    ).run(id, "morning", T0, "{}", FUTURE);
  }

  it("cascades judgments when the parent briefing is deleted", () => {
    const db = getDatabase();
    insertBriefing(db, "b1");
    db.prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
       VALUES (?,?,?,?,?)`,
    ).run("b1", "CRM pilot", "at_risk", "evidence-grounded prose", T0);
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM judgments WHERE briefing_id='b1'")
      .get() as { c: number };
    expect(before.c).toBe(1);

    db.prepare("DELETE FROM proposed_briefings WHERE briefing_id='b1'").run();
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM judgments WHERE briefing_id='b1'")
      .get() as { c: number };
    expect(after.c).toBe(0);
  });

  it("rejects a judgment referencing a non-existent briefing (FK)", () => {
    const db = getDatabase();
    expect(() =>
      db
        .prepare(
          `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run("ghost", "x", "at_risk", "p", T0),
    ).toThrow();
  });

  it("rejects an out-of-vocab posture (CHECK)", () => {
    const db = getDatabase();
    insertBriefing(db, "b1");
    // 'has_momentum' is the V8.1 value — must be normalized to 'momentum' first
    expect(() =>
      db
        .prepare(
          `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run("b1", "x", "has_momentum", "p", T0),
    ).toThrow();
  });

  it("accepts the canonical postures + null confidence/concession", () => {
    const db = getDatabase();
    insertBriefing(db, "b1");
    for (const posture of [
      "at_risk",
      "momentum",
      "highest_leverage",
      "noted",
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
             VALUES (?,?,?,?,?)`,
          )
          .run("b1", "x", posture, "p", T0),
      ).not.toThrow();
    }
  });
});

describe("reflection_followups CHECK", () => {
  it("rejects an out-of-vocab checkpoint_kind", () => {
    const db = getDatabase();
    expect(() =>
      db
        .prepare(
          `INSERT INTO reflection_followups (fire_after, checkpoint_kind, context_ref, created_at)
           VALUES (?,?,?,?)`,
        )
        .run(T0, "verify_nonsense", "judgment:1", T0),
    ).toThrow();
  });
});

describe("idempotency", () => {
  it("initDatabase re-runs the schema on an existing on-disk DB without error or data loss", () => {
    closeDatabase(); // drop the :memory: db from beforeEach
    tmpDbPath = join(
      tmpdir(),
      `mc-p0-${process.pid}-${process.hrtime.bigint()}.db`,
    );

    const db1 = initDatabase(tmpDbPath);
    db1
      .prepare(
        `INSERT INTO reflection_followups (fire_after, checkpoint_kind, context_ref, created_at)
         VALUES (?,?,?,?)`,
      )
      .run(T0, "verify_resolution", "judgment:1", T0);
    closeDatabase();

    // Re-init on the SAME file: every CREATE IF NOT EXISTS runs against existing
    // tables — must not throw and must preserve the row.
    expect(() => initDatabase(tmpDbPath as string)).not.toThrow();
    const db2 = getDatabase();
    expect(tableExists("judgments")).toBe(true);
    const c = db2
      .prepare("SELECT COUNT(*) AS c FROM reflection_followups")
      .get() as { c: number };
    expect(c.c).toBe(1);
  });
});
