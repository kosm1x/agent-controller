/**
 * `memory/knowledge-graph` statements on the real schema
 * (`initDatabase(":memory:")`), asserting the exact rows each statement reads
 * or writes — and neighbouring rows on both sides of every key that must stay
 * out of the result or as they were. Seeds are written with a plain INSERT so
 * they do not depend on the statement under test. Fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  addTriple,
  getEntityHistory,
  invalidateTriple,
  queryTriples,
} from "./knowledge-graph.js";

interface Seed {
  confidence?: number;
  validTo?: string | null;
  source?: string;
  taskId?: string | null;
  createdAt?: string;
}

function seed(
  subject: string,
  predicate: string,
  object: string,
  validFrom: string,
  o: Seed = {},
): number {
  const info = getDatabase()
    .prepare(
      `INSERT INTO knowledge_triples
         (subject, predicate, object, confidence, valid_from, valid_to, source, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      subject,
      predicate,
      object,
      o.confidence ?? 0.9,
      validFrom,
      o.validTo ?? null,
      o.source ?? "extraction",
      o.taskId ?? null,
      o.createdAt ?? "2026-01-01 00:00:00",
    );
  return Number(info.lastInsertRowid);
}

function rowOf(id: number): Record<string, unknown> {
  return getDatabase()
    .prepare("SELECT * FROM knowledge_triples WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

const OLD_END = "2025-06-01 08:00:00";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("addTriple — supersede", () => {
  // Only the open rows with this subject AND this predicate (compared in
  // lower case) are closed. Subjects and predicates sorting just before and
  // just after stay open, and a row closed earlier keeps its old end.
  it("closes the open rows with the same subject and predicate, nothing else", () => {
    const target = seed("Beta Unit", "Status_Is", "phase one", "2026-01-05 10:00:00");
    const closedBefore = seed("BETA UNIT", "status_is", "phase zero", "2026-01-02 10:00:00", {
      validTo: OLD_END,
    });
    const subjBelow = seed("Beta Unis", "status_is", "kept a", "2026-01-05 10:00:00");
    const subjAbove = seed("Beta Uniu", "status_is", "kept b", "2026-01-05 10:00:00");
    const predBelow = seed("Beta Unit", "status_ir", "kept c", "2026-01-05 10:00:00");
    const predAbove = seed("Beta Unit", "status_it", "kept d", "2026-01-05 10:00:00");

    const id = addTriple("  beta unit ", " STATUS_IS ", "phase two");

    const t = rowOf(target);
    expect(t.valid_to).not.toBeNull();
    expect((t.valid_to as string) > (t.valid_from as string)).toBe(true);
    expect(t.valid_to).not.toBe(OLD_END);
    expect(rowOf(closedBefore).valid_to).toBe(OLD_END);
    for (const keep of [subjBelow, subjAbove, predBelow, predAbove]) {
      expect(rowOf(keep).valid_to).toBeNull();
    }
    expect(rowOf(id).valid_to).toBeNull();
  });

  it("supersede: false leaves the prior open row open", () => {
    const prior = seed("Beta Unit", "status_is", "phase one", "2026-01-05 10:00:00");
    const id = addTriple("Beta Unit", "status_is", "phase two", { supersede: false });
    expect(rowOf(prior).valid_to).toBeNull();
    expect(rowOf(id).valid_to).toBeNull();
  });
});

describe("addTriple — insert", () => {
  // Every column the insert sets carries its own argument (each value is
  // distinct from the row's other text columns); the optional fields are
  // checked both given and omitted.
  it("stores each argument in its own column, trimmed, with the options given", () => {
    const id = addTriple("  Gamma Node ", " owner_is ", "  team delta  ", {
      confidence: 0.4,
      source: "ritual",
      taskId: "t-kg-insert",
    });
    const r = rowOf(id);
    expect(r).toMatchObject({
      subject: "Gamma Node",
      predicate: "owner_is",
      object: "team delta",
      confidence: 0.4,
      source: "ritual",
      task_id: "t-kg-insert",
      valid_to: null,
    });
    expect(r.valid_from).toEqual(expect.any(String));
    expect(r.created_at).toEqual(expect.any(String));
  });

  it("uses the defaults when the options are omitted", () => {
    const id = addTriple("Gamma Node", "owner_is", "team delta");
    expect(rowOf(id)).toMatchObject({
      confidence: 1,
      source: "agent",
      task_id: null,
      valid_to: null,
    });
  });
});

describe("queryTriples", () => {
  // valid_from order differs from insertion (id) order and from created_at
  // order, so only ORDER BY valid_from DESC gives the expected list.
  function seedOrdered(): Record<string, number> {
    return {
      mid: seed("Delta Hub", "phase_is", "mid step", "2026-02-10 09:00:00", {
        createdAt: "2026-02-20 00:00:00",
      }),
      newest: seed("delta hub", "phase_is", "late step", "2026-02-12 09:00:00", {
        createdAt: "2026-02-01 00:00:00",
      }),
      oldest: seed("DELTA HUB", "phase_is", "early step", "2026-02-08 09:00:00", {
        createdAt: "2026-02-15 00:00:00",
      }),
    };
  }

  it("subject filter: case-insensitive, newest valid_from first, neighbours left out", () => {
    const ids = seedOrdered();
    seed("Delta Hua", "phase_is", "neighbour below", "2026-02-11 09:00:00");
    seed("Delta Huc", "phase_is", "neighbour above", "2026-02-11 09:00:00");
    const got = queryTriples({ subject: " Delta HUB " });
    expect(got.map((t) => t.id)).toEqual([ids.newest, ids.mid, ids.oldest]);
    expect(got[0]).toEqual({
      id: ids.newest,
      subject: "delta hub",
      predicate: "phase_is",
      object: "late step",
      confidence: 0.9,
      validFrom: "2026-02-12 09:00:00",
      validTo: null,
      source: "extraction",
      taskId: null,
      createdAt: "2026-02-01 00:00:00",
    });
  });

  it("limit keeps the newest rows", () => {
    const ids = seedOrdered();
    expect(queryTriples({ subject: "delta hub", limit: 2 }).map((t) => t.id)).toEqual([
      ids.newest,
      ids.mid,
    ]);
  });

  it("predicate filter: case-insensitive, neighbours left out", () => {
    const hit = seed("Epsilon", "Lead_Is", "first lead", "2026-02-10 09:00:00");
    seed("Epsilon", "lead_ir", "neighbour below", "2026-02-10 09:00:00");
    seed("Epsilon", "lead_it", "neighbour above", "2026-02-10 09:00:00");
    expect(queryTriples({ predicate: "LEAD_IS" }).map((t) => t.id)).toEqual([hit]);
  });

  it("object filter matches a case-insensitive substring only", () => {
    const hit = seed("Zeta", "note_is", "Waiting On The Vendor reply", "2026-02-10 09:00:00");
    seed("Zeta", "note_is", "vendo reply pending", "2026-02-10 09:00:00");
    expect(queryTriples({ object: "the VENDOR" }).map((t) => t.id)).toEqual([hit]);
  });

  it("default reads open rows only; activeOnly false and getEntityHistory read closed rows too", () => {
    const open = seed("Eta Line", "state_is", "open now", "2026-02-10 09:00:00");
    const closed = seed("Eta Line", "state_is", "closed before", "2026-02-11 09:00:00", {
      validTo: "2026-02-12 09:00:00",
    });
    expect(queryTriples({ subject: "eta line" }).map((t) => t.id)).toEqual([open]);
    expect(queryTriples({ subject: "eta line", activeOnly: false }).map((t) => t.id)).toEqual([
      closed,
      open,
    ]);
    expect(getEntityHistory("ETA LINE").map((t) => t.id)).toEqual([closed, open]);
  });

  // asOf: valid_from at or before the instant AND (open OR ending strictly
  // after it). Rows start or end minutes on each side of the instant and
  // exactly on it.
  it("asOf reads what was valid at that instant, edges included and excluded", () => {
    const AS_OF = "2026-03-10 12:00:00";
    const startsBefore = seed("Theta", "stage_is", "starts before", "2026-03-10 11:55:00");
    const startsAt = seed("Theta", "stage_is", "starts at", "2026-03-10 12:00:00", {
      validTo: "2026-03-10 13:00:00",
    });
    seed("Theta", "stage_is", "starts after", "2026-03-10 12:05:00");
    const endsAfter = seed("Theta", "stage_is", "ends after", "2026-03-09 12:00:00", {
      validTo: "2026-03-10 12:05:00",
    });
    seed("Theta", "stage_is", "ends at", "2026-03-09 13:00:00", { validTo: AS_OF });
    seed("Theta", "stage_is", "ends before", "2026-03-09 14:00:00", {
      validTo: "2026-03-10 11:55:00",
    });
    expect(queryTriples({ subject: "theta", asOf: AS_OF }).map((t) => t.id)).toEqual([
      startsAt,
      startsBefore,
      endsAfter,
    ]);
  });
});

describe("invalidateTriple", () => {
  // Only the row with this id is closed: the ids on each side stay open, and
  // an id below the lowest closes nothing.
  it("closes the one row by id", () => {
    const below = seed("Iota", "flag_is", "below", "2026-02-10 09:00:00");
    const mid = seed("Iota", "flag_is", "middle", "2026-02-10 09:00:00");
    const above = seed("Iota", "flag_is", "above", "2026-02-10 09:00:00");

    invalidateTriple(below - 1);
    for (const id of [below, mid, above]) expect(rowOf(id).valid_to).toBeNull();

    invalidateTriple(mid);
    const m = rowOf(mid);
    expect(m.valid_to).not.toBeNull();
    expect((m.valid_to as string) > (m.valid_from as string)).toBe(true);
    expect(rowOf(below).valid_to).toBeNull();
    expect(rowOf(above).valid_to).toBeNull();
  });
});
