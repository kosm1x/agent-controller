import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import type { GateConfig, ODDPredicate } from "./types.js";
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

  it("L4 in-ODD → autonomous, no approve, no demote", async () => {
    seedCapability({
      capability: "c_l4",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l4"));
    expect(r.route).toBe("autonomous");
    expect(r.inODD).toBe(true);
    expect(r.demoted).toBe(false);
    expect(r.effectiveLevel).toBe(4);
    expect(r.events).toEqual(["proposed", "executed"]);
  });

  it("L4 out-of-ODD → demote to L3 (still autonomous), emits autonomy_demoted", async () => {
    seedCapability({
      capability: "c_l4o",
      level: 4,
      odd: ALWAYS_OUT,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l4o"));
    expect(r.demoted).toBe(true);
    expect(r.effectiveLevel).toBe(3);
    expect(r.route).toBe("autonomous");
    expect(r.events).toEqual(["proposed", "autonomy_demoted", "executed"]);
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

  it("ux_confirm_flag forces confirm even for an L4 in-ODD capability", async () => {
    seedCapability({
      capability: "c_ux",
      level: 4,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
      uxConfirm: true,
    });
    const r = await runDecisionPipeline(trigger("c_ux"));
    expect(r.effectiveLevel).toBe(4);
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

  it("base L5 in-ODD → autonomous (silent), no approve", async () => {
    seedCapability({
      capability: "c_l5",
      level: 5,
      odd: ALWAYS_IN,
      gate: OPEN_GATE,
    });
    const r = await runDecisionPipeline(trigger("c_l5"));
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
