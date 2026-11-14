/**
 * The autonomous-improvement safety gates on the real schema through
 * initDatabase(":memory:"): the daily PR cap joins `tasks` to `runs` and
 * counts only auto-improvement tasks of the last 24 hours whose run output
 * holds a pull-request URL; the nanoclaw circuit-breaker reads the three
 * newest nanoclaw tasks of the last 24 hours. Row ages are written with the
 * database's own clock (`datetime('now', <offset>)`), the same clock both
 * statements compare against. The candidate detector is mocked: it reads the
 * service journal through a child process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../intelligence/improvement-detector.js", () => ({
  detectImprovements: vi.fn(async () => [
    {
      type: "scope-miss",
      severity: "high",
      frequency: 4,
      suggestedAction: "Anchor the synthetic pattern",
    },
  ]),
  formatCandidates: vi.fn(() => "candidate text"),
}));

import { initDatabase, closeDatabase } from "../db/index.js";
import { detectImprovements } from "../intelligence/improvement-detector.js";
import { createImprovementTask } from "./autonomous-improvement.js";

const AUTO = "🤖 Auto-improvement: synthetic fix";
const PR_OUTPUT = "Opened https://github.com/example/repo/pull/7";
const IMAGE_MISSING =
  "Container exited with code 125: Unable to find image 'synthetic:latest' locally";
const TIMED_OUT = "Container timed out after 600000ms";

const ORIGINAL_ENV = process.env.AUTONOMOUS_IMPROVEMENT_ENABLED;
let db: ReturnType<typeof initDatabase>;

function task(
  taskId: string,
  opts: {
    title?: string;
    age: string;
    status?: string;
    error?: string;
    agentType?: string;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (task_id, title, description, agent_type, status, error, created_at)
     VALUES (?, ?, 'synthetic', ?, ?, ?, datetime('now', ?))`,
  ).run(
    taskId,
    opts.title ?? "synthetic task",
    opts.agentType ?? "nanoclaw",
    opts.status ?? "completed",
    opts.error ?? null,
    opts.age,
  );
}

function run(taskId: string, output: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, task_id, agent_type, input, output)
     VALUES (?, ?, 'nanoclaw', 'synthetic', ?)`,
  ).run(`run-${taskId}`, taskId, output);
}

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.clearAllMocks();
  process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "true";
});

afterEach(() => {
  closeDatabase();
  if (ORIGINAL_ENV === undefined) {
    delete process.env.AUTONOMOUS_IMPROVEMENT_ENABLED;
  } else {
    process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = ORIGINAL_ENV;
  }
});

describe("createImprovementTask — daily PR cap on the real schema", () => {
  it("skips once three auto-improvement tasks of the last 24 hours opened a PR", async () => {
    for (const [id, age] of [
      ["pr-1", "-3 hours"],
      ["pr-2", "-2 hours"],
      ["pr-3", "-1 hours"],
    ]) {
      task(id, { title: AUTO, age });
      run(id, PR_OUTPUT);
    }

    expect(await createImprovementTask()).toBeNull();
    expect(detectImprovements).not.toHaveBeenCalled();
  });

  it("counts only recent auto-improvement tasks whose run output holds a PR URL", async () => {
    task("pr-1", { title: AUTO, age: "-3 hours" });
    run("pr-1", PR_OUTPUT);
    task("pr-2", { title: AUTO, age: "-2 hours" });
    run("pr-2", PR_OUTPUT);
    // Older than 24 hours.
    task("pr-old", { title: AUTO, age: "-25 hours" });
    run("pr-old", PR_OUTPUT);
    // Recent auto-improvement task whose run opened no PR.
    task("no-pr", { title: AUTO, age: "-1 hours" });
    run("no-pr", "Tests failed; no PR opened");
    // Recent PR from a task that is not an auto-improvement task.
    task("other", { title: "Manual fix", age: "-1 hours" });
    run("other", PR_OUTPUT);

    const submission = await createImprovementTask();
    expect(submission?.title).toBe(
      "🤖 Auto-improvement: Anchor the synthetic pattern",
    );
    expect(submission?.agentType).toBe("nanoclaw");
    expect(detectImprovements).toHaveBeenCalledWith(24);
  });
});

describe("createImprovementTask — nanoclaw circuit-breaker on the real schema", () => {
  it("opens when the three newest nanoclaw tasks of the last 24 hours all failed on the substrate", async () => {
    // An older success falls outside the three newest.
    task("ok-old", { age: "-4 hours" });
    task("f-1", { age: "-3 hours", status: "failed", error: IMAGE_MISSING });
    task("f-2", { age: "-2 hours", status: "failed", error: TIMED_OUT });
    task("f-3", {
      age: "-1 hours",
      status: "failed",
      error: "Container exited with code 125: <unknown>",
    });
    // A newer success of another runner does not close the circuit.
    task("fast-new", { age: "-10 minutes", agentType: "fast" });

    expect(await createImprovementTask()).toBeNull();
    expect(detectImprovements).not.toHaveBeenCalled();
  });

  it("stays closed when the newest nanoclaw task succeeded", async () => {
    task("f-1", { age: "-4 hours", status: "failed", error: IMAGE_MISSING });
    task("f-2", { age: "-3 hours", status: "failed", error: IMAGE_MISSING });
    task("f-3", { age: "-2 hours", status: "failed", error: IMAGE_MISSING });
    task("ok-new", { age: "-30 minutes" });

    expect(await createImprovementTask()).not.toBeNull();
  });

  it("stays closed when one of three substrate failures is older than 24 hours", async () => {
    task("f-old", { age: "-25 hours", status: "failed", error: IMAGE_MISSING });
    task("f-1", { age: "-2 hours", status: "failed", error: IMAGE_MISSING });
    task("f-2", { age: "-1 hours", status: "failed", error: TIMED_OUT });

    expect(await createImprovementTask()).not.toBeNull();
  });
});
