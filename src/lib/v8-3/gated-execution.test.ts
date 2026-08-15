/**
 * Background-seam tests (2026-08-08 gate-validity assessment): the REAL
 * `ToolRegistry.execute` chokepoint must record gated-capability executions in
 * the V8.3 decision ledger — the traffic §14's shadow previously never saw —
 * without double-recording the interactive seam and without ever blocking or
 * re-running a tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool } from "../../tools/types.js";
import type { GateConfig } from "./types.js";
import { recordGatedExecution } from "./gated-execution.js";
import { enterRunToolContext } from "../../tools/rule-of-two.js";

/** Seed one capability_autonomy row (mirrors trigger.test.ts). */
function seedCapability(capability: string, level: number, gate: GateConfig) {
  getDatabase()
    .prepare(
      `INSERT INTO capability_autonomy
         (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
          blast_radius, reversible_default, override_window_start_at, description)
       VALUES (?, ?, ?, ?, 0, 'persistent', 0, datetime('now'), ?)`,
    )
    .run(
      capability,
      level,
      JSON.stringify({ op: "eq", field: "ok", value: true }),
      JSON.stringify(gate),
      `test ${capability}`,
    );
}

function fakeTool(name: string, result: () => string, calls: string[]): Tool {
  return {
    name,
    definition: {
      type: "function",
      function: { name, description: "t", parameters: { type: "object" } },
    },
    execute: async () => {
      calls.push(name);
      return result();
    },
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  } as unknown as Tool;
}

function decisionRows(): Array<{
  capability: string;
  thread_id: string;
  status: string;
  payload_json: string;
  reversal_op_json: string | null;
}> {
  return getDatabase()
    .prepare(
      `SELECT capability, thread_id, status, payload_json, reversal_op_json FROM decisions`,
    )
    .all() as never;
}

let registry: ToolRegistry;
let calls: string[];

beforeEach(() => {
  initDatabase(":memory:");
  seedCapability("schedule_task", 1, {
    reversible_required: true,
    max_level: 5,
  });
  seedCapability("gmail_send", 1, { reversible_required: true, max_level: 2 });
  registry = new ToolRegistry();
  calls = [];
  delete process.env.V83_ENABLED;
  delete process.env.V83_GATED_CAPABILITIES;
});
afterEach(() => {
  closeDatabase();
  delete process.env.V83_ENABLED;
  delete process.env.V83_GATED_CAPABILITIES;
});

describe("ToolRegistry.execute — V8.3 background seam", () => {
  it("dormant (V83_ENABLED unset): gated tool executes with ZERO ledger writes", async () => {
    registry.register(fakeTool("gmail_send", () => "sent", calls));
    const out = await registry.execute("gmail_send", { to: "a@b.c" });
    expect(out).toBe("sent");
    expect(calls).toEqual(["gmail_send"]);
    expect(decisionRows()).toEqual([]);
  });

  it("armed: a background execution of a gated tool writes ONE decision with source=background", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    registry.register(fakeTool("gmail_send", () => "sent", calls));
    const out = await registry.execute("gmail_send", { to: "a@b.c" });
    expect(out).toBe("sent"); // output fidelity through the wrapper
    expect(calls).toEqual(["gmail_send"]); // at-most-once
    const rows = decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].capability).toBe("gmail_send");
    expect(rows[0].thread_id).toBe("background");
    expect(rows[0].status).toBe("committed");
  });

  it("a schedule_task creation through the background seam lands a COMPLETED delete_inverse op", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "schedule_task";
    registry.register(
      fakeTool(
        "schedule_task",
        () => JSON.stringify({ success: true, schedule_id: "sched-9" }),
        calls,
      ),
    );
    await registry.execute("schedule_task", { name: "n" });
    const rows = decisionRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].reversal_op_json ?? "null")).toEqual({
      kind: "delete_inverse",
      table: "scheduled_tasks",
      pkColumn: "schedule_id",
      pkValue: "sched-9",
    });
  });

  it("{v83:'skip'} bypasses the seam — the interactive wrapper's double-record guard", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    registry.register(fakeTool("gmail_send", () => "sent", calls));
    const out = await registry.execute(
      "gmail_send",
      { to: "a@b.c" },
      { v83: "skip" },
    );
    expect(out).toBe("sent");
    expect(decisionRows()).toEqual([]);
  });

  it("an ungated tool never touches the ledger even when armed", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    registry.register(fakeTool("echo_tool", () => "ok", calls));
    const out = await registry.execute("echo_tool", {});
    expect(out).toBe("ok");
    expect(decisionRows()).toEqual([]);
  });

  it("pipeline failure (armed but UNSEEDED capability) degrades to a single direct execute", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "northstar_sync"; // not seeded here
    registry.register(fakeTool("northstar_sync", () => "synced", calls));
    const out = await registry.execute("northstar_sync", { do: "x" });
    expect(out).toBe("synced"); // never blocks
    expect(calls).toEqual(["northstar_sync"]); // at-most-once across the degrade
    expect(decisionRows()).toEqual([]);
  });
});

describe("recordGatedExecution — shared wrapper contract", () => {
  it("background: a thunk that THROWS is recorded, then the ORIGINAL error re-throws (qa W2 — the registry's failure channel is preserved)", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    let ran = 0;
    const boom = new Error("smtp down");
    await expect(
      recordGatedExecution(
        "gmail_send",
        { to: "a@b.c" },
        async () => {
          ran++;
          throw boom;
        },
        { source: "background", threadId: "background" },
      ),
    ).rejects.toThrow(boom);
    expect(ran).toBe(1); // at-most-once even on the throw path
    const rows = decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending"); // executed-with-failure, not committed
  });

  it("interactive: a thunk that THROWS keeps the pre-existing JSON-error contract (router expects a string)", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    const out = await recordGatedExecution(
      "gmail_send",
      { to: "a@b.c" },
      async () => {
        throw new Error("smtp down");
      },
      { source: "interactive", threadId: "t1" },
    );
    expect(JSON.parse(out)).toEqual({ error: "smtp down" });
    expect(decisionRows()[0].status).toBe("pending");
  });

  it("a batch partial-error envelope ({success:false}) grades as not-committed (qa R3 — matches task-executor)", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    const out = await recordGatedExecution(
      "gmail_send",
      { to: "a@b.c" },
      async () => JSON.stringify({ success: false, results: [] }),
      { source: "background", threadId: "background" },
    );
    expect(JSON.parse(out)).toEqual({ success: false, results: [] }); // output fidelity
    expect(decisionRows()[0].status).toBe("pending");
  });
});

describe("background seam — Rule of Two composition end-to-end (V8.5 Phase 5.2)", () => {
  const demotionReasons = (): string[] =>
    (
      getDatabase()
        .prepare(
          "SELECT payload_json FROM decision_events WHERE event_kind = 'autonomy_demoted' ORDER BY id",
        )
        .all() as Array<{ payload_json: string }>
    ).map((r) => (JSON.parse(r.payload_json) as { reason: string }).reason);
  const levels = (): number[] =>
    (
      getDatabase()
        .prepare("SELECT autonomy_level FROM decisions ORDER BY id")
        .all() as Array<{ autonomy_level: number }>
    ).map((r) => r.autonomy_level);

  it("registry ALS → seam priorToolNames → pipeline: gmail_read then gmail_send at L2 ⇒ demoted to L1 (rule_of_two)", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    // Re-seed gmail_send at L2 (the shared beforeEach seeds L1).
    getDatabase().prepare("DELETE FROM capability_autonomy WHERE capability = 'gmail_send'").run();
    seedCapability("gmail_send", 2, { reversible_required: true, max_level: 2 });
    const calls: string[] = [];
    // Real names ⇒ the real classification applies (gmail_read = A+B, gmail_send = B+C).
    const readTool = fakeTool("gmail_read", () => "mail body", calls);
    (readTool as { readOnlyHint: boolean }).readOnlyHint = true;
    registry.register(readTool);
    registry.register(fakeTool("gmail_send", () => "sent", calls));

    await enterRunToolContext("task-r2", async () => {
      await registry.execute("gmail_read", { id: "1" });
      await registry.execute("gmail_send", { to: "a@b.c" });
    });
    expect(calls).toEqual(["gmail_read", "gmail_send"]); // never blocks, at-most-once
    expect(levels()).toEqual([1]);
    expect(demotionReasons()).toEqual(["rule_of_two"]);
  });

  it("control: gmail_send alone at L2 inside a run ⇒ stays L2, no demotion (mutation-verify)", async () => {
    process.env.V83_ENABLED = "true";
    process.env.V83_GATED_CAPABILITIES = "gmail_send";
    getDatabase().prepare("DELETE FROM capability_autonomy WHERE capability = 'gmail_send'").run();
    seedCapability("gmail_send", 2, { reversible_required: true, max_level: 2 });
    const calls: string[] = [];
    registry.register(fakeTool("gmail_send", () => "sent", calls));
    await enterRunToolContext("task-r2b", async () => {
      await registry.execute("gmail_send", { to: "a@b.c" });
    });
    expect(levels()).toEqual([2]);
    expect(demotionReasons()).toEqual([]);
  });
});
