/**
 * detectImprovements' two task queries on the real schema. The sibling test
 * stubs the database by SQL text, so a wrong column or window there passes.
 * The journal read is a child process: here it is a stub that never spawns
 * and rejects like an unavailable journal, so only the database-derived
 * candidates are produced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const journal = vi.hoisted(() => ({
  calls: [] as unknown[][],
  stdinEnd: vi.fn(),
}));

// The module promisifies execFile; util.promisify takes the custom form. The
// plain form throws so a call that bypasses promisify can never spawn.
vi.mock("child_process", () => {
  const execFile = () => {
    throw new Error("execFile must not be called directly in tests");
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => {
      journal.calls.push(args);
      return Object.assign(
        Promise.reject(new Error("journal unavailable in tests")),
        { child: { stdin: { end: journal.stdinEnd } } },
      );
    },
  });
  return { execFile };
});

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectImprovements } from "./improvement-detector.js";

/** A task row whose age comes from the database clock, like the queries' window. */
function insertTask(
  taskId: string,
  status: string,
  error: string,
  ageHours: number,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, error, created_at)
       VALUES (?, 't', 'd', ?, ?, datetime('now', '-' || ? || ' hours'))`,
    )
    .run(taskId, status, error, ageHours);
}

const MISSED = "Required tools not called: jarvis_dev";

beforeEach(() => {
  initDatabase(":memory:");
  journal.calls = [];
  // Recurring failure: three in the window, one older, plus rows the query excludes.
  insertTask("f-1", "failed", "ECONNRESET upstream", 1);
  insertTask("f-2", "failed", "ECONNRESET upstream", 2);
  insertTask("f-3", "failed", "ECONNRESET upstream", 3);
  insertTask("f-old", "failed", "ECONNRESET upstream", 30);
  insertTask("f-done", "completed", "ECONNRESET upstream", 1);
  insertTask("s-1", "failed", "Service shutdown", 1);
  insertTask("s-2", "failed", "Service shutdown", 2);
  insertTask("once", "failed", "a one-off error", 1);
  // Missed required tools: the runner suffix is grouped away.
  insertTask("m-1", "completed", `${MISSED} — runner: ran out of turns`, 1);
  insertTask("m-2", "completed", MISSED, 2);
  insertTask("m-old", "completed", MISSED, 30);
});

afterEach(() => {
  closeDatabase();
});

describe("detectImprovements on the real schema", () => {
  it("ranks recurring failures and missed required tools from the window only", async () => {
    const out = await detectImprovements(24);
    expect(out).toEqual([
      {
        type: "task-failure",
        description: "ECONNRESET upstream",
        frequency: 3,
        severity: "medium",
        suggestedAction: 'Investigate recurring failure: "ECONNRESET upstream"',
      },
      {
        type: "scope-miss",
        description: MISSED,
        frequency: 2,
        severity: "medium",
        suggestedAction:
          "Check tool descriptions — LLM may not understand when to call required tools",
      },
    ]);
    // The stub, not a real journal, answered the one child call.
    expect(journal.calls).toHaveLength(1);
    expect(journal.calls[0]![0]).toBe("journalctl");
  });

  it("widens both windows with hoursBack", async () => {
    const out = await detectImprovements(48);
    expect(out.map((c) => [c.type, c.frequency])).toEqual([
      ["task-failure", 4],
      ["scope-miss", 3],
    ]);
  });
});
