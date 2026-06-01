/**
 * V8.2 Phase 1 schema — attributed_claims + sycophancy_probes (spec §6).
 *
 * Asserts the tables/indexes exist, the FK CASCADE + CHECK constraints hold,
 * the `evidence_kind` / `resolver_status` / `concession_kind` CHECK lists stay
 * in lockstep with their TypeScript sources of truth (drift guards),
 * initDatabase is idempotent on an existing on-disk schema, and the V8.1 + V8.2
 * Phase 0 substrate still stands alongside the additions (rollback test).
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import {
  EVIDENCE_KINDS,
  CONCESSION_KINDS,
} from "../lib/v8-2/reconciliation.js";
import { RESOLVER_STATUSES } from "../lib/v8-2/types.js";

const T0 = "2026-06-01T00:00:00.000Z";
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

/** Insert a briefing + judgment, return the judgment's integer PK. */
function seedJudgment(db = getDatabase(), briefingId = "b1"): number {
  db.prepare(
    `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
     VALUES (?,?,?,?,?)`,
  ).run(briefingId, "morning", T0, "{}", FUTURE);
  const info = db
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(briefingId, "CRM pilot", "at_risk", "evidence-grounded prose", T0);
  return Number(info.lastInsertRowid);
}

function insertClaim(
  db: ReturnType<typeof getDatabase>,
  judgmentId: number,
  overrides: Partial<{
    claim_id: number;
    evidence_kind: string;
    evidence_id: string;
    resolver_status: string;
  }> = {},
) {
  return db
    .prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, evidence_kind, evidence_id, evidence_excerpt, retrieved_at, resolver_status)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      judgmentId,
      overrides.claim_id ?? 0,
      "the pilot is at risk",
      overrides.evidence_kind ?? "task",
      overrides.evidence_id ?? "t-1",
      "excerpt",
      T0,
      overrides.resolver_status ?? "resolved",
    );
}

describe("schema presence", () => {
  it("creates attributed_claims + sycophancy_probes with their indexes", () => {
    const db = getDatabase();
    expect(tableExists("attributed_claims")).toBe(true);
    expect(tableExists("sycophancy_probes")).toBe(true);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(idx).toContain("idx_attributed_claims_judgment");
    expect(idx).toContain("idx_attributed_claims_claim");
    expect(idx).toContain("idx_attributed_claims_status");
    expect(idx).toContain("idx_sycophancy_probes_at");
  });

  it("V8.1 + V8.2-Phase-0 substrate still stands alongside the additions", () => {
    for (const t of [
      "proposed_briefings",
      "general_events",
      "recurring_blockers",
      "self_defining_cohort",
      "judgments",
      "reflection_followups",
    ]) {
      expect(tableExists(t)).toBe(true);
    }
    // a representative V8.1 write still works post-Phase-1
    const db = getDatabase();
    expect(() =>
      db
        .prepare(
          `INSERT INTO proposed_briefings (briefing_id, surface, generated_at, briefing_json, expires_at)
           VALUES (?,?,?,?,?)`,
        )
        .run("v81-ok", "morning", T0, "{}", FUTURE),
    ).not.toThrow();
  });
});

describe("attributed_claims FK + CHECK", () => {
  it("cascades claims when the parent judgment is deleted", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    insertClaim(db, jid);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM attributed_claims").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    db.prepare("DELETE FROM judgments WHERE id = ?").run(jid);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM attributed_claims").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("cascades claims transitively when the parent briefing is deleted", () => {
    const db = getDatabase();
    const jid = seedJudgment(db, "bcasc");
    insertClaim(db, jid);
    db.prepare("DELETE FROM proposed_briefings WHERE briefing_id = ?").run(
      "bcasc",
    );
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM attributed_claims").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("rejects a claim referencing a non-existent judgment (FK)", () => {
    const db = getDatabase();
    expect(() => insertClaim(db, 99999)).toThrow();
  });

  it("defaults resolver_status to 'unresolved' when omitted", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    db.prepare(
      `INSERT INTO attributed_claims
         (judgment_id, claim_id, claim_text, evidence_kind, evidence_id, evidence_excerpt, retrieved_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(jid, 0, "c", "task", "t-1", "x", T0);
    const row = db
      .prepare("SELECT resolver_status FROM attributed_claims")
      .get() as { resolver_status: string };
    expect(row.resolver_status).toBe("unresolved");
  });

  it("rejects an out-of-vocab resolver_status (CHECK)", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    expect(() =>
      insertClaim(db, jid, { resolver_status: "halfway" }),
    ).toThrow();
  });

  // ── drift guards: DDL CHECK ⊇ the TS source-of-truth enums ──────────────────
  it("accepts every EVIDENCE_KINDS value (evidence_kind CHECK in lockstep)", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    EVIDENCE_KINDS.forEach((kind, i) => {
      expect(() =>
        insertClaim(db, jid, { claim_id: i, evidence_kind: kind }),
      ).not.toThrow();
    });
  });

  it("rejects an evidence_kind outside EVIDENCE_KINDS", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    expect(() =>
      insertClaim(db, jid, { evidence_kind: "made_up_kind" }),
    ).toThrow();
  });

  it("accepts every RESOLVER_STATUSES value", () => {
    const db = getDatabase();
    const jid = seedJudgment(db);
    RESOLVER_STATUSES.forEach((status, i) => {
      expect(() =>
        insertClaim(db, jid, { claim_id: i, resolver_status: status }),
      ).not.toThrow();
    });
  });
});

describe("sycophancy_probes CHECK + nullable FK", () => {
  function insertProbe(
    db: ReturnType<typeof getDatabase>,
    concession: string,
    judgmentId: number | null = null,
  ) {
    return db
      .prepare(
        `INSERT INTO sycophancy_probes
           (probed_at, judgment_id, probe_string, judgment_color, concession_kind)
         VALUES (?,?,?,?,?)`,
      )
      .run(T0, judgmentId, "are you sure?", "red", concession);
  }

  it("accepts every CONCESSION_KINDS value with a null judgment_id", () => {
    const db = getDatabase();
    CONCESSION_KINDS.forEach((kind) => {
      expect(() => insertProbe(db, kind)).not.toThrow();
    });
  });

  it("rejects an out-of-vocab concession_kind", () => {
    const db = getDatabase();
    expect(() => insertProbe(db, "shrugged")).toThrow();
  });

  it("allows arbitrary judgment_color (free TEXT, all colors incl. red)", () => {
    const db = getDatabase();
    for (const color of ["green", "yellow", "red"]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO sycophancy_probes
               (probed_at, probe_string, judgment_color, concession_kind)
             VALUES (?,?,?,?)`,
          )
          .run(T0, "p", color, "held_position"),
      ).not.toThrow();
    }
  });
});

describe("CHECK list lockstep (structural drift guard)", () => {
  // The behavioral guards above prove the DDL CHECK *accepts* every TS enum
  // value (catches: added a TS value, forgot the DDL). This parses the CHECK
  // list straight out of the stored DDL and asserts SET EQUALITY with the TS
  // source of truth — closing the more-likely direction: a hand-edited SQL
  // CHECK literal that drifts ahead of (or away from) the enum. (qa W1)
  function checkListFor(table: string, column: string): string[] {
    const sql = (
      getDatabase()
        .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(table) as { sql: string }
    ).sql;
    const m = sql.match(new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`));
    if (!m) throw new Error(`no '${column} IN (...)' CHECK in ${table}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  }

  it("attributed_claims.evidence_kind CHECK === EVIDENCE_KINDS", () => {
    expect(checkListFor("attributed_claims", "evidence_kind")).toEqual(
      [...EVIDENCE_KINDS].sort(),
    );
  });

  it("attributed_claims.resolver_status CHECK === RESOLVER_STATUSES", () => {
    expect(checkListFor("attributed_claims", "resolver_status")).toEqual(
      [...RESOLVER_STATUSES].sort(),
    );
  });

  it("sycophancy_probes.concession_kind CHECK === CONCESSION_KINDS", () => {
    expect(checkListFor("sycophancy_probes", "concession_kind")).toEqual(
      [...CONCESSION_KINDS].sort(),
    );
  });
});

describe("idempotency", () => {
  it("initDatabase re-runs the Phase 1 schema on an existing on-disk DB without error or data loss", () => {
    closeDatabase();
    tmpDbPath = join(
      tmpdir(),
      `mc-p1-${process.pid}-${process.hrtime.bigint()}.db`,
    );

    const db1 = initDatabase(tmpDbPath);
    const jid = seedJudgment(db1, "bdisk");
    insertClaim(db1, jid);
    closeDatabase();

    expect(() => initDatabase(tmpDbPath as string)).not.toThrow();
    const db2 = getDatabase();
    expect(tableExists("attributed_claims")).toBe(true);
    expect(tableExists("sycophancy_probes")).toBe(true);
    expect(
      (
        db2.prepare("SELECT COUNT(*) AS c FROM attributed_claims").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });
});
