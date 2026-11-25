/**
 * The degrade path of recordGatedExecution: the decision pipeline fails after
 * the tool ran, or before it.
 *
 * After: updateDecisionStatus raises (e.g. SQLITE_BUSY) once the tool has run;
 * the guard `if (output === undefined) return executeThunk()` in the catch
 * keeps it at one run and returns its output. With an unconditional
 * `return executeThunk()` the first case fails (ran === 2 — in production,
 * two sent emails or two created schedules).
 *
 * Before: a database handle whose first read throws stops the pipeline before
 * the tool runs; the fallback runs it once and returns its output.
 *
 * The cases that throw a value whose text form throws check that the catch's
 * log line does not change these results.
 *
 * Own file because the decisions-store vi.mock is hoisted file-wide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { updateDecisionStatus } from "./decisions-store.js";
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

  // The degrade catch logs the pipeline's thrown value through the error-text
  // helper before it decides; a value whose text form throws must not stop it.
  it("a pipeline that throws an unreadable value after the call returns the output and never runs the call again", async () => {
    vi.mocked(updateDecisionStatus).mockImplementationOnce(() => {
      throw Object.create(null) as unknown;
    });
    let ran = 0;
    const out: unknown = await recordGatedExecution(
      "gmail_send",
      { to: "a@b.c" },
      async () => {
        ran++;
        return "sent";
      },
      { source: "background", threadId: "background" },
    ).catch((e: unknown) => e);
    expect({ out, ran }).toEqual({ out: "sent", ran: 1 });
  });
});

describe("recordGatedExecution — pipeline throw BEFORE the tool ran", () => {
  it.each(["interactive", "background"] as const)(
    "a pipeline that throws an unreadable value before the call runs the call once and returns its output (%s)",
    async (source) => {
      // The capability read is the pipeline's first step: a handle whose
      // prepare throws makes the pipeline fail before the call.
      const db = {
        prepare: () => {
          throw Object.create(null) as unknown;
        },
      } as unknown as Database.Database;
      let ran = 0;
      const out: unknown = await recordGatedExecution(
        "gmail_send",
        { to: "a@b.c" },
        async () => {
          ran++;
          return "sent";
        },
        { source, threadId: "t1", db },
      ).catch((e: unknown) => e);
      expect({ out, ran }).toEqual({ out: "sent", ran: 1 });
    },
  );
});
