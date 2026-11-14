/**
 * `decisions-store` statements on the real schema (`initDatabase(":memory:")`),
 * asserting the exact columns each statement writes or reads. Every keyed read
 * or write runs on the MIDDLE of three rows, so a neighbour on either side of
 * the key must stay out of the result or unchanged, and a lookup of a key below
 * the lowest one returns nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  appendDecisionEvent,
  getCapabilityRow,
  getDecisionForRevert,
  insertDecision,
  markReverted,
  nextSequenceNo,
  updateDecisionReversalOp,
  updateDecisionStatus,
  type NewDecision,
} from "./decisions-store.js";

const T0 = "2026-06-26T12:00:00.000Z";
const T1 = "2026-06-26T12:05:00.000Z";
const T2 = "2026-06-26T12:10:00.000Z";

/** A `capability_autonomy` row (FK target of `decisions.capability`). */
function seedCap(capability: string, level: number, description: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO capability_autonomy
         (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
          blast_radius, reversible_default, override_window_start_at, description)
       VALUES (?, ?, '{"op":"eq","field":"ok","value":true}',
               '{"reversible_required":true,"max_level":5}', 0,
               'persistent', 1, ?, ?)`,
    )
    .run(capability, level, T0, description);
}

function decision(over: Partial<NewDecision> = {}): NewDecision {
  return {
    capability: "cap_b",
    judgmentId: null,
    autonomyLevel: 1,
    status: "pending",
    capabilityToken: { token: "tok-b" },
    payload: { action: "write-b" },
    threadId: "thread-b",
    proposedAt: T0,
    ...over,
  };
}

/** Three decisions (low, mid, high ids) with distinct values per column. */
function threeDecisions(): { low: number; mid: number; high: number } {
  return {
    low: insertDecision(
      decision({
        capability: "cap_a",
        autonomyLevel: 3,
        reversalOp: { kind: "none", tag: "low" },
      }),
    ),
    mid: insertDecision(
      decision({ reversalOp: { kind: "none", tag: "mid" } }),
    ),
    high: insertDecision(
      decision({
        capability: "cap_c",
        autonomyLevel: 4,
        reversalOp: { kind: "none", tag: "high" },
      }),
    ),
  };
}

function row(id: number): Record<string, unknown> {
  return getDatabase()
    .prepare(`SELECT * FROM decisions WHERE id = ?`)
    .get(id) as Record<string, unknown>;
}

beforeEach(() => {
  initDatabase(":memory:");
  // Seeded out of name order so a lookup cannot rely on insertion order.
  seedCap("cap_c", 3, "capability c");
  seedCap("cap_a", 1, "capability a");
  seedCap("cap_b", 2, "capability b");
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
});

describe("getCapabilityRow", () => {
  // The resolver must get exactly the named capability's autonomy row: a
  // neighbour's row would carry another capability's level and gates.
  it("returns the named capability's row, and undefined for an unseeded name", () => {
    expect(getCapabilityRow("cap_b")).toMatchObject({
      capability: "cap_b",
      level: 2,
      description: "capability b",
    });
    expect(getCapabilityRow("cap_0")).toBeUndefined(); // sorts below every seeded name
    expect(getCapabilityRow("cap_bb")).toBeUndefined(); // between two seeded names
    expect(getCapabilityRow("cap_z")).toBeUndefined(); // above every seeded name
  });
});

describe("insertDecision", () => {
  // Every input lands in its own column: the token and the payload are both
  // JSON text, so a column mix-up would still insert without error.
  it("writes each field to its own column", () => {
    const id = insertDecision(
      decision({
        autonomyLevel: 2,
        preState: { before: 1 },
        reversalOp: { kind: "sql_inverse", steps: [] },
        pheropathSignal: "SAFE",
      }),
    );
    expect(row(id)).toMatchObject({
      capability: "cap_b",
      judgment_id: null,
      autonomy_level: 2,
      status: "pending",
      capability_token_json: JSON.stringify({ token: "tok-b" }),
      payload_json: JSON.stringify({ action: "write-b" }),
      pre_state_json: JSON.stringify({ before: 1 }),
      reversal_op_json: JSON.stringify({ kind: "sql_inverse", steps: [] }),
      pheropath_signal: "SAFE",
      proposed_at: T0,
      decided_at: null,
      reverted_at: null,
      thread_id: "thread-b",
    });
  });

  // Omitted optional fields store null, and an omitted proposal time is the
  // current time.
  it("stores null for omitted optional fields and stamps proposed_at with now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T2));
    const input = decision();
    delete input.proposedAt;
    const id = insertDecision(input);
    expect(row(id)).toMatchObject({
      pre_state_json: null,
      reversal_op_json: null,
      pheropath_signal: null,
      proposed_at: T2,
    });
  });
});

describe("updateDecisionReversalOp", () => {
  // Completes ONE decision's stored op; the neighbours keep theirs.
  it("replaces only the named decision's op", () => {
    const { low, mid, high } = threeDecisions();
    updateDecisionReversalOp(mid, { kind: "delete_inverse", pkValue: 7 });
    expect(row(mid).reversal_op_json).toBe(
      JSON.stringify({ kind: "delete_inverse", pkValue: 7 }),
    );
    expect(row(low).reversal_op_json).toBe(JSON.stringify({ kind: "none", tag: "low" }));
    expect(row(high).reversal_op_json).toBe(JSON.stringify({ kind: "none", tag: "high" }));
  });
});

describe("updateDecisionStatus", () => {
  // Advances ONE decision and stamps decided_at with the given time; a later
  // explicit time replaces it, an omitted time keeps it. Neighbours stay
  // pending and undecided.
  it("changes only the named decision; a given stamp is stored, an omitted one keeps the last", () => {
    const { low, mid, high } = threeDecisions();
    updateDecisionStatus(mid, "committed", T1);
    expect(row(mid)).toMatchObject({ status: "committed", decided_at: T1 });
    updateDecisionStatus(mid, "interrupted", T2);
    expect(row(mid)).toMatchObject({ status: "interrupted", decided_at: T2 });
    updateDecisionStatus(mid, "vetoed");
    expect(row(mid)).toMatchObject({ status: "vetoed", decided_at: T2 });
    for (const other of [low, high]) {
      expect(row(other)).toMatchObject({ status: "pending", decided_at: null });
    }
  });
});

describe("getDecisionForRevert", () => {
  // The revert path must read the decision it was asked for — not a neighbour —
  // and nothing for an id that does not exist on either side.
  it("returns the named decision's revert columns, and undefined for an absent id", () => {
    const { low, mid, high } = threeDecisions();
    getDatabase()
      .prepare(`UPDATE decisions SET pre_state_json = ? WHERE id = ?`)
      .run(JSON.stringify({ kind: "sql", rows: [] }), mid);
    expect(getDecisionForRevert(mid)).toEqual({
      id: mid,
      capability: "cap_b",
      status: "pending",
      autonomy_level: 1,
      reversal_op_json: JSON.stringify({ kind: "none", tag: "mid" }),
      pre_state_json: JSON.stringify({ kind: "sql", rows: [] }),
    });
    expect(getDecisionForRevert(low)?.capability).toBe("cap_a");
    expect(getDecisionForRevert(high)?.capability).toBe("cap_c");
    expect(getDecisionForRevert(low - 1)).toBeUndefined();
    expect(getDecisionForRevert(high + 1)).toBeUndefined();
  });
});

describe("markReverted", () => {
  // Marks ONE decision reverted with its time; neighbours keep their status and
  // stay un-reverted.
  it("marks only the named decision reverted and stamps reverted_at", () => {
    const { low, mid, high } = threeDecisions();
    updateDecisionStatus(low, "committed", T1);
    updateDecisionStatus(mid, "committed", T1);
    updateDecisionStatus(high, "committed", T1);
    markReverted(mid, T2);
    expect(row(mid)).toMatchObject({ status: "reverted", reverted_at: T2 });
    for (const other of [low, high]) {
      expect(row(other)).toMatchObject({ status: "committed", reverted_at: null });
    }
  });
});

describe("nextSequenceNo", () => {
  // The next event number is one past the decision's OWN highest sequence_no
  // (a gap in the stream does not lower it); neighbours' streams do not count,
  // and an empty stream starts at 1.
  it("is one past the decision's own highest sequence_no", () => {
    const { low, mid, high } = threeDecisions();
    const empty = insertDecision(decision());
    const events: Array<[number, number]> = [
      [low, 1], [low, 2], [low, 7],
      [mid, 1], [mid, 3],
      [high, 1], [high, 2], [high, 3], [high, 9],
    ];
    for (const [decisionId, sequenceNo] of events) {
      appendDecisionEvent({ decisionId, sequenceNo, eventKind: "proposed", occurredAt: T0 });
    }
    expect(nextSequenceNo(mid)).toBe(4);
    expect(nextSequenceNo(low)).toBe(8);
    expect(nextSequenceNo(high)).toBe(10);
    expect(nextSequenceNo(empty)).toBe(1);
  });
});
