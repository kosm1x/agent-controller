import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  applyReversal,
  buildReversalOp,
  captureSqlPreState,
  fingerprint,
  revertDecision,
  validateBlastRadius,
  verifyRestored,
  type ReversalOp,
  type SqlPreState,
} from "./reversal.js";
import { getDecisionForRevert, insertDecision } from "./decisions-store.js";

function db() {
  return getDatabase();
}

/** A scratch table to mutate + reverse (not a v8-3 table). */
function makeWidgets(): void {
  db().exec(
    `CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)`,
  );
  db()
    .prepare(
      `INSERT INTO widgets (id, name, qty) VALUES (1, 'alpha', 10), (2, 'beta', 20)`,
    )
    .run();
}

/** Seed a minimal capability_autonomy row (FK target for decisions.capability). */
function seedCap(capability: string): void {
  db()
    .prepare(
      `INSERT INTO capability_autonomy
         (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
          blast_radius, reversible_default, override_window_start_at, description)
       VALUES (?, 1, '{"op":"eq","field":"ok","value":true}',
               '{"reversible_required":true,"max_level":5}', 0,
               'persistent', 1, datetime('now'), 'test')`,
    )
    .run(capability);
}

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("fingerprint", () => {
  it("is key-order independent and value-sensitive", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("captureSqlPreState", () => {
  it("snapshots existing rows and nulls for absent ones", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [
      { table: "widgets", pk: { id: 1 } },
      { table: "widgets", pk: { id: 99 } },
    ]);
    expect(pre.kind).toBe("sql");
    expect(pre.rows[0].before).toEqual({ id: 1, name: "alpha", qty: 10 });
    expect(pre.rows[1].before).toBeNull();
    expect(pre.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an empty primary key", () => {
    makeWidgets();
    expect(() =>
      captureSqlPreState(db(), [{ table: "widgets", pk: {} }]),
    ).toThrow(/empty primary key/);
  });

  it("rejects an unsafe SQL identifier", () => {
    expect(() =>
      captureSqlPreState(db(), [{ table: "wid;gets", pk: { id: 1 } }]),
    ).toThrow(/unsafe SQL identifier/);
  });
});

describe("buildReversalOp + applyReversal (round-trips)", () => {
  it("sql_inverse round-trips an UPDATE", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 1 } }]);
    db()
      .prepare(`UPDATE widgets SET qty = 999, name = 'mutated' WHERE id = 1`)
      .run();
    const op = buildReversalOp({
      strategy: "sql_inverse",
      preState: pre,
      allowedTables: ["widgets"],
      level: 4,
      reversibleRequired: true,
    });
    expect(op.kind).toBe("sql_inverse");
    expect(applyReversal(db(), op).ok).toBe(true);
    expect(
      db().prepare(`SELECT name, qty FROM widgets WHERE id = 1`).get(),
    ).toEqual({
      name: "alpha",
      qty: 10,
    });
    expect(verifyRestored(db(), pre)).toBe(true);
  });

  it("sql_inverse undoes an INSERT (before=null → delete)", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 3 } }]);
    db()
      .prepare(`INSERT INTO widgets (id, name, qty) VALUES (3, 'gamma', 30)`)
      .run();
    const op = buildReversalOp({
      strategy: "sql_inverse",
      preState: pre,
      level: 4,
      reversibleRequired: true,
    });
    expect(applyReversal(db(), op).ok).toBe(true);
    expect(
      db().prepare(`SELECT COUNT(*) AS n FROM widgets WHERE id = 3`).get(),
    ).toEqual({
      n: 0,
    });
    expect(verifyRestored(db(), pre)).toBe(true);
  });

  it("sql_inverse undoes a DELETE (re-inserts the captured row)", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 2 } }]);
    db().prepare(`DELETE FROM widgets WHERE id = 2`).run();
    const op = buildReversalOp({
      strategy: "sql_inverse",
      preState: pre,
      level: 4,
      reversibleRequired: true,
    });
    expect(applyReversal(db(), op).ok).toBe(true);
    expect(
      db().prepare(`SELECT name, qty FROM widgets WHERE id = 2`).get(),
    ).toEqual({
      name: "beta",
      qty: 20,
    });
    expect(verifyRestored(db(), pre)).toBe(true);
  });

  it("sql_inverse without a pre-state throws", () => {
    expect(() =>
      buildReversalOp({
        strategy: "sql_inverse",
        level: 4,
        reversibleRequired: true,
      }),
    ).toThrow(/requires a captured pre-state/);
  });
});

describe("blast-radius validation", () => {
  it("rejects an inverse touching out-of-scope tables", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 1 } }]);
    expect(() =>
      buildReversalOp({
        strategy: "sql_inverse",
        preState: pre,
        allowedTables: ["tasks"],
        level: 4,
        reversibleRequired: true,
      }),
    ).toThrow(/out-of-blast-radius/);
  });

  it("is a no-op for non-sql_inverse ops", () => {
    expect(() =>
      validateBlastRadius(
        { kind: "compensating", proposal: "x", autoExecutable: false },
        [],
      ),
    ).not.toThrow();
  });
});

describe("compensating / irreversible / deferred strategies", () => {
  it("compensating builds a proposed (non-auto) reversal", () => {
    const op = buildReversalOp({
      strategy: "compensating",
      level: 2,
      reversibleRequired: false,
      compensatingProposal: "send a correction",
    });
    expect(op).toEqual({
      kind: "compensating",
      proposal: "send a correction",
      autoExecutable: false,
    });
    const res = applyReversal(db(), op);
    expect(res).toMatchObject({
      ok: false,
      requiresOperator: true,
      reason: "send a correction",
    });
  });

  it("none → irreversible marker only at L≤2 with reversible_required=false", () => {
    expect(
      buildReversalOp({ strategy: "none", level: 2, reversibleRequired: false })
        .kind,
    ).toBe("irreversible");
    expect(() =>
      buildReversalOp({
        strategy: "none",
        level: 3,
        reversibleRequired: false,
      }),
    ).toThrow(/not permitted/);
    expect(() =>
      buildReversalOp({ strategy: "none", level: 1, reversibleRequired: true }),
    ).toThrow(/not permitted/);
  });

  it("delete_inverse / tri_restore build deferred ops not replayable in v1", () => {
    for (const strategy of ["delete_inverse", "tri_restore"] as const) {
      const op = buildReversalOp({
        strategy,
        level: 2,
        reversibleRequired: true,
      });
      expect(op.kind).toBe("deferred");
      const res = applyReversal(db(), op);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/not replayable in v1/);
    }
  });
});

describe("verifyRestored", () => {
  it("is false when the row no longer matches the snapshot", () => {
    makeWidgets();
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 1 } }]);
    db().prepare(`UPDATE widgets SET qty = 5 WHERE id = 1`).run();
    expect(verifyRestored(db(), pre)).toBe(false);
  });
});

describe("revertDecision (ledger-integrated)", () => {
  it("replays a committed sql_inverse decision, restores state, marks reverted", () => {
    makeWidgets();
    seedCap("widget_edit");
    const pre = captureSqlPreState(db(), [{ table: "widgets", pk: { id: 1 } }]);
    db().prepare(`UPDATE widgets SET qty = 777 WHERE id = 1`).run(); // the mutation
    const op = buildReversalOp({
      strategy: "sql_inverse",
      preState: pre,
      allowedTables: ["widgets"],
      level: 4,
      reversibleRequired: true,
    });
    const id = insertDecision({
      capability: "widget_edit",
      judgmentId: null,
      autonomyLevel: 4,
      status: "committed",
      capabilityToken: { capability: "widget_edit" },
      payload: { do: "x" },
      preState: pre,
      reversalOp: op,
      threadId: "t",
      proposedAt: "2026-06-26T00:00:00Z",
    });
    const out = revertDecision(id, db(), {
      allowedTables: ["widgets"],
      nowIso: "2026-06-26T01:00:00Z",
    });
    expect(out).toEqual({ ok: true, status: "reverted", restored: true });
    expect(db().prepare(`SELECT qty FROM widgets WHERE id = 1`).get()).toEqual({
      qty: 10,
    });
    expect(getDecisionForRevert(id, db())?.status).toBe("reverted");
    const events = db()
      .prepare(
        `SELECT event_kind FROM decision_events WHERE decision_id = ? ORDER BY sequence_no`,
      )
      .all(id) as { event_kind: string }[];
    expect(events.map((e) => e.event_kind)).toContain("reverted");
  });

  it("refuses a non-committed decision", () => {
    seedCap("c");
    const id = insertDecision({
      capability: "c",
      judgmentId: null,
      autonomyLevel: 1,
      status: "pending",
      capabilityToken: {},
      payload: {},
      threadId: "t",
    });
    const out = revertDecision(id, db());
    expect(out).toMatchObject({ ok: false, status: "unchanged" });
    expect(out.reason).toMatch(/only committed/);
  });

  it("on a compensating op requires operator confirmation, no state change", () => {
    seedCap("c");
    const id = insertDecision({
      capability: "c",
      judgmentId: null,
      autonomyLevel: 2,
      status: "committed",
      capabilityToken: {},
      payload: {},
      reversalOp: {
        kind: "compensating",
        proposal: "send correction",
        autoExecutable: false,
      },
      threadId: "t",
    });
    const out = revertDecision(id, db());
    expect(out).toMatchObject({
      ok: false,
      status: "unchanged",
      requiresOperator: true,
      reason: "send correction",
    });
    expect(getDecisionForRevert(id, db())?.status).toBe("committed");
  });

  it("returns unchanged when no reversal op is recorded", () => {
    seedCap("c");
    const id = insertDecision({
      capability: "c",
      judgmentId: null,
      autonomyLevel: 2,
      status: "committed",
      capabilityToken: {},
      payload: {},
      threadId: "t",
    });
    const out = revertDecision(id, db());
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no reversal op/);
  });

  it("throws on an unknown decision", () => {
    expect(() => revertDecision(123456, db())).toThrow(/unknown decision/);
  });

  it("enforces blast-radius on replay", () => {
    makeWidgets();
    seedCap("c");
    const op: ReversalOp = {
      kind: "sql_inverse",
      tables: ["widgets"],
      steps: [
        {
          action: "restore",
          table: "widgets",
          pk: { id: 1 },
          row: { id: 1, name: "alpha", qty: 10 },
        },
      ],
      fingerprint: "x",
    };
    const id = insertDecision({
      capability: "c",
      judgmentId: null,
      autonomyLevel: 4,
      status: "committed",
      capabilityToken: {},
      payload: {},
      reversalOp: op,
      threadId: "t",
    });
    expect(() =>
      revertDecision(id, db(), { allowedTables: ["tasks"] }),
    ).toThrow(/out-of-blast-radius/);
  });

  it("flags CRITICAL (state_not_restored) when post-replay verification fails", () => {
    makeWidgets();
    seedCap("c");
    // Reversal restores qty=10, but the stored pre-state claims before qty=99 —
    // a fingerprint that post-replay state cannot match → verify fails.
    const op: ReversalOp = {
      kind: "sql_inverse",
      tables: ["widgets"],
      steps: [
        {
          action: "restore",
          table: "widgets",
          pk: { id: 1 },
          row: { id: 1, name: "alpha", qty: 10 },
        },
      ],
      fingerprint: "x",
    };
    const fakeRows = [
      {
        table: "widgets",
        pk: { id: 1 },
        before: { id: 1, name: "alpha", qty: 99 },
      },
    ];
    const fakePre: SqlPreState = {
      kind: "sql",
      rows: fakeRows,
      fingerprint: fingerprint(fakeRows),
      capturedAt: "",
    };
    db().prepare(`UPDATE widgets SET qty = 5 WHERE id = 1`).run();
    const id = insertDecision({
      capability: "c",
      judgmentId: null,
      autonomyLevel: 4,
      status: "committed",
      capabilityToken: {},
      payload: {},
      preState: fakePre,
      reversalOp: op,
      threadId: "t",
    });
    const out = revertDecision(id, db(), { allowedTables: ["widgets"] });
    expect(out).toMatchObject({
      ok: false,
      status: "unchanged",
      restored: false,
    });
    expect(out.reason).toBe("reversal_failed_state_not_restored");
    // The decision stays committed — frozen for investigation, not mislabeled.
    expect(getDecisionForRevert(id, db())?.status).toBe("committed");
  });
});
