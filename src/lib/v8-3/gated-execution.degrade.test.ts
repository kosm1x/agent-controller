/**
 * qa W5 (2026-08-08): the ONLY line preventing a double-execute on a pipeline
 * failure AFTER the tool ran is `if (output === undefined) return executeThunk()`
 * in recordGatedExecution's catch. The sibling degrade tests all throw BEFORE
 * execute (unseeded capability), so this file forces a POST-execute pipeline
 * throw (updateDecisionStatus raising, e.g. SQLITE_BUSY) and pins:
 * at-most-once execution + output fidelity. Mutation check: replace the guard
 * with an unconditional `return executeThunk()` and this fails (ran === 2 —
 * in production that is two sent emails / two created schedules).
 *
 * Own file because the decisions-store vi.mock is hoisted file-wide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { recordGatedExecution } from "./gated-execution.js";

vi.mock("./decisions-store.js", async (importActual) => {
  const actual = await importActual<typeof import("./decisions-store.js")>();
  return {
    ...actual,
    updateDecisionStatus: vi.fn(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    }),
  };
});

beforeEach(() => {
  initDatabase(":memory:");
  getDatabase()
    .prepare(
      `INSERT INTO capability_autonomy
         (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
          blast_radius, reversible_default, override_window_start_at, description)
       VALUES ('gmail_send', 1, '{"op":"eq","field":"ok","value":true}',
               '{"reversible_required":true,"max_level":2}', 0, 'persistent', 0,
               datetime('now'), 'test')`,
    )
    .run();
  process.env.V83_ENABLED = "true";
  process.env.V83_GATED_CAPABILITIES = "gmail_send";
});
afterEach(() => {
  closeDatabase();
  vi.clearAllMocks();
  delete process.env.V83_ENABLED;
  delete process.env.V83_GATED_CAPABILITIES;
});

describe("recordGatedExecution — pipeline throw AFTER the tool ran", () => {
  it("returns the tool's output and never re-executes (at-most-once across the post-execute degrade)", async () => {
    let ran = 0;
    const out = await recordGatedExecution(
      "gmail_send",
      { to: "a@b.c" },
      async () => {
        ran++;
        return "sent";
      },
      { source: "background", threadId: "background" },
    );
    expect(out).toBe("sent"); // output fidelity through the degrade
    expect(ran).toBe(1); // the double-execute guard — the point of this file
  });
});
