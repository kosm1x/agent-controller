import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import type { GateConfig } from "./types.js";

// Mock the tool layer — trigger.ts must never actually run a tool in tests.
vi.mock("../../tools/registry.js", () => ({
  toolRegistry: { execute: vi.fn() },
}));

import { toolRegistry } from "../../tools/registry.js";
import { executeGatedCapability, CAPABILITY_BY_TOOL } from "./trigger.js";

const mockExecute = vi.mocked(toolRegistry.execute);

/** Seed one capability_autonomy row (mirrors pipeline.test.ts). */
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

const FILE_GATE: GateConfig = { reversible_required: false, max_level: 2 };
/** `schedule_task`'s real seed shape (CAPABILITY_SEEDS) — `delete_schedule` maps onto it. */
const SCHEDULE_GATE: GateConfig = { reversible_required: true, max_level: 5 };
const OK = JSON.stringify({ ok: true });

function decisionCount(): number {
  return (
    getDatabase().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  initDatabase(":memory:");
  seedCapability("jarvis_file_delete", 1, FILE_GATE);
  seedCapability("gmail_send", 1, FILE_GATE);
  seedCapability("schedule_task", 1, SCHEDULE_GATE);
  mockExecute.mockResolvedValue(OK);
  delete process.env.V83_ENABLED;
  delete process.env.V83_GATED_CAPABILITIES;
});
afterEach(() => {
  closeDatabase();
  vi.clearAllMocks();
  delete process.env.V83_ENABLED;
  delete process.env.V83_GATED_CAPABILITIES;
});

describe("executeGatedCapability — passthrough (dormant)", () => {
  it("passes through when V83_ENABLED is unset (zero ledger writes)", async () => {
    const out = await executeGatedCapability(
      "jarvis_file_delete",
      { path: "x.md" },
      { threadId: "t1" },
    );
    expect(out).toBe(OK);
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith("jarvis_file_delete", {
      path: "x.md",
    });
    expect(decisionCount()).toBe(0);
  });

  it("passes through for a tool that maps to no gated capability, even when enabled", async () => {
    process.env.V83_ENABLED = "true";
    expect(CAPABILITY_BY_TOOL["send_telegram"]).toBeUndefined();
    const out = await executeGatedCapability(
      "send_telegram",
      { text: "hi" },
      { threadId: "t1" },
    );
    expect(out).toBe(OK);
    expect(decisionCount()).toBe(0);
  });

  it("passes through for a gated capability OUTSIDE the active canary set", async () => {
    process.env.V83_ENABLED = "true"; // gmail_send is mapped but not in DEFAULT_CANARY
    const out = await executeGatedCapability(
      "gmail_send",
      { to: "a@b.c" },
      { threadId: "t1" },
    );
    expect(out).toBe(OK);
    expect(decisionCount()).toBe(0);
  });
});

describe("executeGatedCapability — wrapped (armed canary)", () => {
  beforeEach(() => {
    process.env.V83_ENABLED = "true";
  });

  it("records a decision + surfaces the tool output verbatim for the canary capability", async () => {
    const toolOut = JSON.stringify({ ok: true, deleted: "x.md" });
    mockExecute.mockResolvedValue(toolOut);
    const out = await executeGatedCapability(
      "jarvis_file_delete",
      { path: "x.md", confirmed: true },
      { threadId: "t1" },
    );
    expect(out).toBe(toolOut); // output fidelity — operator sees the tool's own result
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith("jarvis_file_delete", {
      path: "x.md",
      confirmed: true,
    });
    expect(decisionCount()).toBe(1);
    const row = getDatabase()
      .prepare(
        `SELECT capability, status, autonomy_level FROM decisions LIMIT 1`,
      )
      .get() as { capability: string; status: string; autonomy_level: number };
    expect(row.capability).toBe("jarvis_file_delete");
    expect(row.autonomy_level).toBe(1);
    expect(row.status).toBe("committed"); // L1 confirm → executed → committed
  });

  it("runs the tool AT MOST ONCE and does not throw when the tool itself throws", async () => {
    mockExecute.mockRejectedValueOnce(new Error("fs boom"));
    const out = await executeGatedCapability(
      "jarvis_file_delete",
      { path: "x.md" },
      { threadId: "t1" },
    );
    expect(mockExecute).toHaveBeenCalledTimes(1); // no double execution
    expect(JSON.parse(out).error).toContain("fs boom"); // error surfaced, not thrown
    expect(decisionCount()).toBe(1); // decision still recorded (not committed)
    const status = (
      getDatabase().prepare(`SELECT status FROM decisions LIMIT 1`).get() as {
        status: string;
      }
    ).status;
    expect(status).not.toBe("committed"); // failed exec → not committed
  });

  it("V83_GATED_CAPABILITIES env narrows/widens the active set without redeploy", async () => {
    process.env.V83_GATED_CAPABILITIES = "gmail_send"; // canary now gmail_send only
    // jarvis_file_delete no longer active → passthrough, no ledger row.
    await executeGatedCapability("jarvis_file_delete", {}, { threadId: "t1" });
    expect(decisionCount()).toBe(0);
    // gmail_send now active → wrapped.
    await executeGatedCapability("gmail_send", {}, { threadId: "t1" });
    expect(decisionCount()).toBe(1);
  });

  // 2026-08-01: both DELETE tools below reach the router confirm seam
  // (`requiresConfirmation: true`) but were absent from CAPABILITY_BY_TOOL, so
  // they executed unlogged. They map onto an already-seeded capability whose
  // name differs from the tool name — these assert the CAPABILITY is recorded,
  // which an identity-map "simplification" would break.
  it("delete_schedule records under the schedule_task capability", async () => {
    process.env.V83_GATED_CAPABILITIES = "schedule_task";
    const toolOut = JSON.stringify({ ok: true, deleted: "0b107bb0" });
    mockExecute.mockResolvedValue(toolOut);
    const out = await executeGatedCapability(
      "delete_schedule",
      { schedule_id: "0b107bb0", confirmed: true },
      { threadId: "t1" },
    );
    expect(out).toBe(toolOut);
    expect(decisionCount()).toBe(1);
    const row = getDatabase()
      .prepare(
        `SELECT capability, status, autonomy_level FROM decisions LIMIT 1`,
      )
      .get() as { capability: string; status: string; autonomy_level: number };
    expect(row.capability).toBe("schedule_task"); // capability, NOT the tool name
    expect(row.autonomy_level).toBe(1);
    expect(row.status).toBe("committed");
  });

  it("jarvis_files_batch_delete records under the jarvis_file_delete capability", async () => {
    mockExecute.mockResolvedValue(JSON.stringify({ ok: true, deleted: 3 }));
    await executeGatedCapability(
      "jarvis_files_batch_delete",
      { paths: ["a.md", "b.md", "c.md"], confirmed: true },
      { threadId: "t1" },
    );
    expect(decisionCount()).toBe(1); // default canary covers jarvis_file_delete
    const row = getDatabase()
      .prepare(`SELECT capability FROM decisions LIMIT 1`)
      .get() as { capability: string };
    expect(row.capability).toBe("jarvis_file_delete");
  });

  it("a mapped tool stays dormant while its capability is outside the canary", async () => {
    process.env.V83_GATED_CAPABILITIES = "jarvis_file_delete";
    // delete_schedule maps to schedule_task, which is NOT armed here.
    await executeGatedCapability("delete_schedule", {}, { threadId: "t1" });
    expect(decisionCount()).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1); // still executed, just unlogged
  });

  it("empty V83_GATED_CAPABILITIES disables all (passthrough)", async () => {
    process.env.V83_GATED_CAPABILITIES = "";
    await executeGatedCapability("jarvis_file_delete", {}, { threadId: "t1" });
    expect(decisionCount()).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("degrades to a single direct execute when the pipeline throws (unseeded active capability, qa-W1)", async () => {
    // northstar_sync is mapped + made active but is NOT seeded in this DB →
    // runDecisionPipeline throws "unknown capability" BEFORE execute runs →
    // outer catch → output undefined → one fallback direct execute, no re-throw.
    process.env.V83_GATED_CAPABILITIES = "northstar_sync";
    const out = await executeGatedCapability(
      "northstar_sync",
      { do: "x" },
      { threadId: "t1" },
    );
    expect(out).toBe(OK); // fallback returned the tool output
    expect(mockExecute).toHaveBeenCalledExactlyOnceWith("northstar_sync", {
      do: "x",
    }); // AT MOST ONCE across the throw path
    expect(decisionCount()).toBe(0); // nothing persisted (threw before any write)
  });

  it("a non-throwing structured-error tool result marks the decision not-committed but preserves the output", async () => {
    const errOut = JSON.stringify({ error: "precious path" });
    mockExecute.mockResolvedValue(errOut);
    const out = await executeGatedCapability(
      "jarvis_file_delete",
      { path: "x.md" },
      { threadId: "t1" },
    );
    expect(out).toBe(errOut); // output preserved verbatim
    expect(decisionCount()).toBe(1);
    const status = (
      getDatabase().prepare(`SELECT status FROM decisions LIMIT 1`).get() as {
        status: string;
      }
    ).status;
    expect(status).not.toBe("committed"); // {error:...} → ok:false → not committed
  });
});
