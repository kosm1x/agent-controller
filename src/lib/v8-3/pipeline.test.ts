import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import type { GateConfig, ODDPredicate, ReversalStrategy } from "./types.js";
import { runDecisionPipeline, type DecisionTrigger } from "./pipeline.js";

const ALWAYS_IN: ODDPredicate = { op: "eq", field: "ok", value: true };
const ALWAYS_OUT: ODDPredicate = { op: "eq", field: "ok", value: false };

function seedCapability(opts: {
  capability: string;
  level: number;
  odd: ODDPredicate;
  gate: GateConfig;
  uxConfirm?: boolean;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO capability_autonomy
         (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
          blast_radius, reversible_default, override_window_start_at, description)
       VALUES (?, ?, ?, ?, ?, 'persistent', 1, datetime('now'), ?)`,
    )
    .run(
      opts.capability,
      opts.level,
      JSON.stringify(opts.odd),
      JSON.stringify(opts.gate),
      opts.uxConfirm ? 1 : 0,
      `test capability ${opts.capability}`,
    );
}

function trigger(
  capability: string,
  context: Record<string, unknown> = { ok: true },
): DecisionTrigger {
  return {
    capability,
    payload: { do: "x" },
    context,
    threadId: "t-1",
    preState: { before: 1 },
  };
}

/**
 * A trigger declaring a valid `sql_inverse` mutation — the ONLY strategy that
 * keeps an L≥3 decision on the autonomous path (§7 seam b). The capability must
 * be canonically `sql_inverse` (`task_edit`) or seam (a) refuses it. Targets a
 * non-existent `tasks` row so `captureSqlPreState` snapshots `before:null` (an
 * INSERT-inverse = DELETE) without needing seeded data.
 */
function sqlTrigger(
  capability: string,
  context: Record<string, unknown> = { ok: true },
): DecisionTrigger {
  return {
    ...trigger(capability, context),
    sqlMutation: {
      targets: [{ table: "tasks", pk: { task_id: "svc-nonexistent" } }],
      strategy: "sql_inverse",
      allowedTables: ["tasks"],
    },
  };
}

const OPEN_GATE: GateConfig = { reversible_required: true, max_level: 5 };

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

describe("runDecisionPipeline", () => {
  it("L1 capability → confirm route, proposed→approved→executed, committed", async () => {
    seedCapability({
      capability: "c_l1",
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l1"), {
      nowIso: "2026-06-26T12:00:00Z",
    });
    expect(r.route).toBe("confirm");
    expect(r.effectiveLevel).toBe(1);
    expect(r.inODD).toBeNull(); // L1 never evaluates the ODD
    expect(r.events).toEqual(["proposed", "approved", "executed"]);
    expect(r.status).toBe("committed");
  });

  it("L4 in-ODD WITH a proven sql_inverse reversal → autonomous, no approve, no demote", async () => {
    seedCapability({
      capability: "task_edit",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(sqlTrigger("task_edit"));
    expect(r.route).toBe("autonomous");
    expect(r.inODD).toBe(true);
    expect(r.demoted).toBe(false);
    expect(r.effectiveLevel).toBe(4);
    expect(r.reversal).toBe("sql_inverse");
    expect(r.events).toEqual(["proposed", "executed"]);
  });

  it("L4 out-of-ODD (sql_inverse) → demote to L3 (still autonomous), emits autonomy_demoted", async () => {
    seedCapability({
      capability: "task_edit",
      level: 4,
      odd: ALWAYS_OUT,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(sqlTrigger("task_edit"));
    expect(r.demoted).toBe(true);
    expect(r.effectiveLevel).toBe(3); // ODD demote 4→3; sql_inverse keeps it autonomous
    expect(r.route).toBe("autonomous");
    expect(r.events).toEqual(["proposed", "autonomy_demoted", "executed"]);
  });

  it("seam (b): an L≥3 trigger with NO reversible mutation demotes to confirm — no autonomous path without a proven inverse", async () => {
    seedCapability({
      capability: "c_l4nr",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    // no sqlMutation → reversalOp stays null; previously this reached the
    // autonomous route with reversible_required unenforced.
    const r = await runDecisionPipeline(trigger("c_l4nr"));
    expect(r.effectiveLevel).toBe(2);
    expect(r.route).toBe("confirm");
    expect(r.demoted).toBe(true);
    expect(r.reversal).toBeNull();
    expect(r.events).toContain("autonomy_demoted");
  });

  it("seam (a): a trigger whose declared strategy ≠ the capability's canonical strategy is refused (a compensating-only cap cannot build a local sql_inverse)", async () => {
    seedCapability({
      capability: "northstar_sync", // canonically compensating (see CAPABILITY_SEEDS)
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const badTrigger: DecisionTrigger = {
      ...trigger("northstar_sync"),
      sqlMutation: {
        targets: [{ table: "tasks", pk: { task_id: "x" } }],
        strategy: "sql_inverse",
        allowedTables: ["tasks"],
      },
    };
    await expect(runDecisionPipeline(badTrigger)).rejects.toThrow(
      /canonical strategy is 'compensating'/,
    );
  });

  it("L3 out-of-ODD → demote to L2 → confirm route", async () => {
    seedCapability({
      capability: "c_l3o",
      level: 3,
      odd: ALWAYS_OUT,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l3o"));
    expect(r.effectiveLevel).toBe(2);
    expect(r.route).toBe("confirm");
    expect(r.events).toEqual([
      "proposed",
      "autonomy_demoted",
      "approved",
      "executed",
    ]);
  });

  it("gate_config.max_level caps an L4 capability to L2 → confirm, ODD not evaluated", async () => {
    seedCapability({
      capability: "c_cap",
      level: 4,
      odd: ALWAYS_IN,
      gate: { reversible_required: true, max_level: 2 },
    });
    const r = await runDecisionPipeline(trigger("c_cap"));
    expect(r.effectiveLevel).toBe(2);
    expect(r.route).toBe("confirm");
    expect(r.inODD).toBeNull();
    expect(r.events).toEqual(["proposed", "approved", "executed"]);
  });

  it("ux_confirm_flag forces confirm even for an L4 in-ODD (sql_inverse) capability", async () => {
    seedCapability({
      capability: "task_edit",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
      uxConfirm: true,
    });
    const r = await runDecisionPipeline(sqlTrigger("task_edit"));
    expect(r.effectiveLevel).toBe(4); // reversible, so not demoted; ux_confirm forces route
    expect(r.route).toBe("confirm");
    expect(r.events).toContain("approved");
  });

  it("unknown capability throws", async () => {
    await expect(runDecisionPipeline(trigger("nope"))).rejects.toThrow(
      /unknown capability/,
    );
  });

  it("disabled (effective level 0) capability is refused and writes nothing", async () => {
    seedCapability({
      capability: "c_l0",
      level: 0,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    await expect(runDecisionPipeline(trigger("c_l0"))).rejects.toThrow(
      /disabled/,
    );
    const n = (
      getDatabase().prepare("SELECT COUNT(*) AS n FROM decisions").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  it("max_level=0 caps any base level to disabled → refused", async () => {
    seedCapability({
      capability: "c_cap0",
      level: 4,
      odd: ALWAYS_IN,
      gate: { reversible_required: true, max_level: 0 },
    });
    await expect(runDecisionPipeline(trigger("c_cap0"))).rejects.toThrow(
      /disabled/,
    );
  });

  it("malformed gate_config (missing max_level) fails loud", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO capability_autonomy
           (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
            blast_radius, reversible_default, override_window_start_at, description)
         VALUES ('c_bad', 1, ?, '{}', 0, 'persistent', 1, datetime('now'), 'bad')`,
      )
      .run(JSON.stringify(ALWAYS_IN));
    await expect(runDecisionPipeline(trigger("c_bad"))).rejects.toThrow(
      /malformed gate_config/,
    );
  });

  it("base L2 → confirm route, ODD not evaluated", async () => {
    seedCapability({
      capability: "c_l2",
      level: 2,
      odd: ALWAYS_OUT,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l2"));
    expect(r.effectiveLevel).toBe(2);
    expect(r.route).toBe("confirm");
    expect(r.inODD).toBeNull();
    expect(r.events).toEqual(["proposed", "approved", "executed"]);
  });

  it("base L5 in-ODD (sql_inverse) → autonomous (silent), no approve", async () => {
    seedCapability({
      capability: "task_edit",
      level: 5,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(sqlTrigger("task_edit"));
    expect(r.effectiveLevel).toBe(5);
    expect(r.route).toBe("autonomous");
    expect(r.inODD).toBe(true);
    expect(r.events).toEqual(["proposed", "executed"]);
  });

  it("execute returning {ok:false} leaves the decision pending with no executed event", async () => {
    seedCapability({
      capability: "c_fail",
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_fail"), {
      execute: () => ({ ok: false }),
    });
    expect(r.status).toBe("pending");
    expect(r.events).toEqual(["proposed", "approved"]); // no executed
    const decision = getDatabase()
      .prepare("SELECT status FROM decisions WHERE id = ?")
      .get(r.decisionId) as { status: string };
    expect(decision.status).toBe("pending");
  });

  it("persists decision + events with monotonic sequence_no and captured pre-state", async () => {
    seedCapability({
      capability: "c_p",
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_p"), {
      nowIso: "2026-06-26T12:00:00Z",
    });
    const db = getDatabase();
    const decision = db
      .prepare(
        "SELECT status, pre_state_json, autonomy_level FROM decisions WHERE id = ?",
      )
      .get(r.decisionId) as {
      status: string;
      pre_state_json: string | null;
      autonomy_level: number;
    };
    expect(decision.status).toBe("committed");
    expect(decision.autonomy_level).toBe(1);
    expect(decision.pre_state_json).toBe(JSON.stringify({ before: 1 }));
    const events = db
      .prepare(
        "SELECT sequence_no, event_kind FROM decision_events WHERE decision_id = ? ORDER BY sequence_no",
      )
      .all(r.decisionId) as { sequence_no: number; event_kind: string }[];
    expect(events.map((e) => e.sequence_no)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.event_kind)).toEqual([
      "proposed",
      "approved",
      "executed",
    ]);
  });

  // Spec §13 Phase 2 acceptance test: "10 decisions traverse, all events emit".
  it("10 decisions traverse the pipeline and every stage emits its event", async () => {
    seedCapability({
      capability: "c_confirm",
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    seedCapability({
      capability: "c_auto",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    seedCapability({
      capability: "c_demote",
      level: 4,
      odd: ALWAYS_OUT,
      gate: OPEN_GATE,
    });
    const caps = ["c_confirm", "c_auto", "c_demote"];
    const seen = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const r = await runDecisionPipeline(trigger(caps[i % caps.length]));
      expect(r.status).toBe("committed");
      expect(r.events[0]).toBe("proposed");
      expect(r.events[r.events.length - 1]).toBe("executed");
      r.events.forEach((e) => seen.add(e));
    }

    const db = getDatabase();
    const decisions = db
      .prepare("SELECT COUNT(*) AS n FROM decisions")
      .get() as { n: number };
    const eventCount = db
      .prepare("SELECT COUNT(*) AS n FROM decision_events")
      .get() as { n: number };
    expect(decisions.n).toBe(10);
    expect(eventCount.n).toBeGreaterThanOrEqual(20); // ≥ proposed+executed each
    // Every distinct stage-event the traversal can emit appeared across the batch.
    expect(seen).toEqual(
      new Set(["proposed", "autonomy_demoted", "approved", "executed"]),
    );
  });
});

// ── Phase 3: reversibility wiring (sqlMutation) ───────────────────────────────

function makeWidgets(): void {
  getDatabase().exec(
    `CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)`,
  );
  getDatabase()
    .prepare(`INSERT INTO widgets (id, name, qty) VALUES (1, 'alpha', 10)`)
    .run();
}

function triggerSql(
  capability: string,
  pk: Record<string, unknown>,
  strategy: ReversalStrategy = "sql_inverse",
  context: Record<string, unknown> = { ok: true },
): DecisionTrigger {
  return {
    capability,
    payload: { do: "x" },
    context,
    threadId: "t-1",
    sqlMutation: {
      targets: [{ table: "widgets", pk }],
      strategy,
      allowedTables: ["widgets"],
    },
  };
}

describe("runDecisionPipeline — Phase 3 reversibility", () => {
  it("a sqlMutation trigger records a real sql_inverse reversal op + captured pre-state", async () => {
    makeWidgets();
    seedCapability({
      capability: "task_edit", // canonically sql_inverse (seam a)
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(triggerSql("task_edit", { id: 1 }));
    expect(r.reversal).toBe("sql_inverse");
    expect(r.route).toBe("autonomous");
    expect(r.status).toBe("committed");
    const row = getDatabase()
      .prepare(
        "SELECT pre_state_json, reversal_op_json FROM decisions WHERE id = ?",
      )
      .get(r.decisionId) as {
      pre_state_json: string;
      reversal_op_json: string;
    };
    expect(JSON.parse(row.pre_state_json).kind).toBe("sql");
    expect(JSON.parse(row.reversal_op_json).kind).toBe("sql_inverse");
  });

  it("§7: an autonomous (L4) action with a non-reversible (compensating) op demotes to confirm", async () => {
    makeWidgets();
    seedCapability({
      capability: "gmail_send", // canonically compensating (seam a)
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(
      triggerSql("gmail_send", { id: 1 }, "compensating"),
    );
    expect(r.demoted).toBe(true);
    expect(r.effectiveLevel).toBe(2);
    expect(r.route).toBe("confirm");
    expect(r.reversal).toBe("compensating");
    expect(r.events).toContain("autonomy_demoted");
    const ev = getDatabase()
      .prepare(
        "SELECT payload_json FROM decision_events WHERE decision_id = ? AND event_kind = 'autonomy_demoted'",
      )
      .get(r.decisionId) as { payload_json: string };
    expect(JSON.parse(ev.payload_json).reason).toBe("not_reversible");
  });

  it("auto-reverts on execution failure and restores the mutated row", async () => {
    makeWidgets();
    seedCapability({
      capability: "task_edit", // canonically sql_inverse (seam a)
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(triggerSql("task_edit", { id: 1 }), {
      // simulate a partial mutation that then fails
      execute: () => {
        getDatabase()
          .prepare(`UPDATE widgets SET qty = 999 WHERE id = 1`)
          .run();
        return { ok: false };
      },
    });
    expect(r.status).toBe("reverted");
    expect(r.restored).toBe(true);
    expect(r.events).toEqual(["proposed", "approved", "reverted"]);
    expect(
      getDatabase().prepare(`SELECT qty FROM widgets WHERE id = 1`).get(),
    ).toEqual({
      qty: 10,
    });
    const status = (
      getDatabase()
        .prepare("SELECT status FROM decisions WHERE id = ?")
        .get(r.decisionId) as {
        status: string;
      }
    ).status;
    expect(status).toBe("reverted");
  });

  it("a failed auto-revert (replay errors) stays pending and is NOT mislabeled reverted", async () => {
    makeWidgets();
    seedCapability({
      capability: "task_edit", // canonically sql_inverse (seam a)
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(triggerSql("task_edit", { id: 1 }), {
      // mutate, then destroy the table so the inverse replay throws → not restored
      execute: () => {
        getDatabase()
          .prepare(`UPDATE widgets SET qty = 999 WHERE id = 1`)
          .run();
        getDatabase().exec(`DROP TABLE widgets`);
        return { ok: false };
      },
    });
    expect(r.status).toBe("pending");
    expect(r.restored).toBe(false);
    expect(r.events).not.toContain("reverted"); // never claims a clean rollback
    const status = (
      getDatabase()
        .prepare("SELECT status FROM decisions WHERE id = ?")
        .get(r.decisionId) as {
        status: string;
      }
    ).status;
    expect(status).toBe("pending"); // frozen for investigation, not "reverted"
  });

  it("a failing execute with NO declared mutation stays pending (Phase-2 behaviour)", async () => {
    seedCapability({
      capability: "c_nop",
      level: 1,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_nop"), {
      execute: () => ({ ok: false }),
    });
    expect(r.status).toBe("pending");
    expect(r.reversal).toBeNull();
  });
});
