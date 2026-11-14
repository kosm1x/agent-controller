/**
 * jarvis_diagnose failed-task read on the real `tasks` table.
 *
 * jarvis-self-repair.test.ts mocks `fs` whole, which `initDatabase` needs, so
 * the diagnose SELECT runs here on `initDatabase(":memory:")` instead.
 *
 * No child process starts: every `execFile` (the two log reads and the branch
 * read) is recorded and rejected, `execFileSync` and the group-kill runner
 * throw. The time window is computed by SQLite's clock, so rows are aged with
 * that same clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const refuse = () => {
    throw new Error("no child process may start in this test");
  };
  const execFile = vi.fn(refuse);
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return Object.assign(
        Promise.reject(new Error("no child process may start in this test")),
        { child: { stdin: { end: () => {} } } },
      );
    },
  });
  return { calls, refuse, execFile };
});

vi.mock("child_process", () => ({
  execFile: child.execFile,
  execFileSync: vi.fn(child.refuse),
}));
vi.mock("./shell.js", () => ({ execGroupKill: vi.fn(child.refuse) }));

import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { jarvisDiagnoseTool } from "./jarvis-self-repair.js";

function seedTask(
  taskId: string,
  status: string,
  age: string,
  agentType: string,
  error: string | null,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, agent_type, error, created_at)
       VALUES (?, ?, 'synthetic', ?, ?, ?, datetime('now', ?))`,
    )
    .run(taskId, `title ${taskId}`, status, agentType, error, age);
}

/** The task lines of the "Failed tasks" block, in output order. */
const taskLines = (out: string) =>
  out.split("\n").filter((l) => / — title t-/.test(l));

beforeEach(() => {
  child.calls.length = 0;
  initDatabase(":memory:");
  seedTask("t-new", "failed", "-10 minutes", "heavy", "synthetic boom");
  seedTask("t-older", "failed", "-40 minutes", "fast", null);
  seedTask("t-done", "completed", "-5 minutes", "fast", null);
  seedTask("t-aged", "failed", "-3 hours", "swarm", "aged boom");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("jarvis_diagnose on the real tasks table", () => {
  it("lists only failed tasks inside the hour window, newest first, with their errors", async () => {
    const out = await jarvisDiagnoseTool.execute({ hours: 1 });

    expect(out).toContain("**Failed tasks (2):**");
    const lines = taskLines(out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("— title t-new (heavy)");
    expect(lines[1]).toContain("— title t-older (fast)");
    expect(out).toContain("    Error: synthetic boom");
    expect(out).not.toContain("t-done");
    expect(out).not.toContain("t-aged");

    // The children were asked for, never run.
    expect(out).toContain("**Error logs:** Could not read journalctl");
    expect(out).toContain("**Current branch:** HEAD");
    expect(child.calls.map((c) => c.cmd)).toEqual(["journalctl", "journalctl", "git"]);
  });

  it("a wider window takes in the older failure", async () => {
    const out = await jarvisDiagnoseTool.execute({ hours: 4 });

    expect(out).toContain("**Failed tasks (3):**");
    expect(taskLines(out).map((l) => l.replace(/^.* — /, ""))).toEqual([
      "title t-new (heavy)",
      "title t-older (fast)",
      "title t-aged (swarm)",
    ]);
    expect(out).toContain("    Error: aged boom");
  });

  it("shows at most the five newest failures inside the window", async () => {
    // With the three failures already seeded: six inside the window.
    for (const n of [1, 2, 3]) {
      seedTask(`t-extra${n}`, "failed", `-${n * 2} hours`, "fast", null);
    }

    const out = await jarvisDiagnoseTool.execute({ hours: 12 });

    expect(out).toContain("**Failed tasks (5):**");
    expect(taskLines(out).map((l) => l.replace(/^.* — /, ""))).toEqual([
      "title t-new (heavy)",
      "title t-older (fast)",
      "title t-extra1 (fast)",
      "title t-aged (swarm)",
      "title t-extra2 (fast)",
    ]);
    expect(out).not.toContain("t-extra3");
  });
});
