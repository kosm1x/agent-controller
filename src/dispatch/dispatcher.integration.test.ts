/**
 * `dispatch/dispatcher` statements on the real schema (`initDatabase(":memory:")`),
 * asserting the exact rows and columns each statement reads or writes.
 * dispatcher.test.ts stubs the database. Every keyed read or write acts on the
 * middle of three rows, so a neighbour on either side of the key must stay out
 * of the result or unchanged; sorted reads are seeded against insertion and id
 * order.
 *
 * No runner executes here. `submitTask` is called with a stub `fast` runner
 * that throws if it is ever executed and a checkout that always refuses the
 * claim, so dispatch stops after the run row is created and rolled back (the
 * checkout stub records the rows as they stand at the claim).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  emitTrace: vi.fn(),
  classify: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: mocks.emitEvent }),
}));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: mocks.emitTrace }));
vi.mock("./classifier.js", () => ({ classify: mocks.classify }));
vi.mock("./checkout.js", () => ({ checkoutTask: mocks.checkout }));
// Only the keys the dispatch path reads before the claim; any other read fails.
vi.mock("../config.js", () => ({
  getConfig: () =>
    new Proxy(
      { budgetEnabled: false, budgetEnforce: false, heavyRunnerContainerized: false } as Record<string, unknown>,
      {
        get(target, key) {
          if (typeof key === "string" && !(key in target)) {
            throw new Error(`config.${key} is not stubbed in this test`);
          }
          return target[key as string];
        },
      },
    ),
}));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  cancelTask,
  getRunToolCalls,
  getTask,
  getTaskWithRuns,
  listTasks,
  registerRunner,
  submitTask,
  updateTaskStatus,
  type TaskSubmission,
} from "./dispatcher.js";

const OLD_STARTED = "2001-01-01 00:00:01";
const OLD_COMPLETED = "2001-01-01 00:00:02";
const OLD_UPDATED = "2001-01-01 00:00:03";
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

type Row = Record<string, unknown>;

function seedTask(
  taskId: string,
  cols: { status?: string; parent?: string; agentType?: string; createdAt?: string } = {},
): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, status, agent_type,
                          output, error, progress, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 7, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      cols.parent ?? null,
      cols.parent ? "subtask" : "root",
      `title ${taskId}`,
      `description ${taskId}`,
      cols.status ?? "queued",
      cols.agentType ?? "fast",
      JSON.stringify(`old output ${taskId}`),
      `old error ${taskId}`,
      cols.createdAt ?? "2026-01-01 09:00:00",
      OLD_UPDATED,
      OLD_STARTED,
      OLD_COMPLETED,
    );
}

function seedRun(
  runId: string,
  taskId: string,
  cols: { status?: string; createdAt?: string; toolCalls?: string; completedAt?: string } = {},
): void {
  getDatabase()
    .prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, status, input, tool_calls, created_at, completed_at)
       VALUES (?, ?, 'fast', ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      taskId,
      cols.status ?? "running",
      JSON.stringify({ seeded: runId }),
      cols.toolCalls ?? null,
      cols.createdAt ?? "2026-01-01 09:00:00",
      cols.completedAt ?? OLD_COMPLETED,
    );
}

const taskRow = (taskId: string): Row =>
  getDatabase().prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row;
const runRow = (runId: string): Row =>
  getDatabase().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row;
const allTasks = (): Row[] =>
  getDatabase().prepare("SELECT * FROM tasks ORDER BY id").all() as Row[];
const allRuns = (): Row[] =>
  getDatabase().prepare("SELECT * FROM runs ORDER BY id").all() as Row[];

/** `row` equals `before` except `fixed` columns and freshly stamped `stamped` columns. */
function expectWritten(row: Row, before: Row, fixed: Row, stamped: string[]): void {
  const want: Row = { ...before, ...fixed };
  for (const c of stamped) want[c] = expect.stringMatching(STAMP_RE);
  expect(row).toEqual(want);
  for (const c of stamped) expect(row[c]).not.toBe(before[c]);
}

beforeEach(() => {
  initDatabase(":memory:");
  mocks.emitEvent.mockReset();
  mocks.emitTrace.mockReset();
  mocks.classify.mockReset();
  mocks.checkout.mockReset();
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// updateTaskStatus
// ---------------------------------------------------------------------------

const OUT = { finalAnswer: "syn answer", score: 0.5 };
const ERR = "syn failure text";

interface Branch {
  status: string;
  output?: unknown;
  error?: string;
  fixed: Row;
  stamped: string[];
}

const BRANCHES: Branch[] = [
  { status: "running", fixed: { status: "running" }, stamped: ["started_at", "updated_at"] },
  {
    status: "completed",
    output: OUT,
    fixed: { status: "completed", progress: 100, output: JSON.stringify(OUT) },
    stamped: ["updated_at", "completed_at"],
  },
  {
    status: "completed",
    fixed: { status: "completed", progress: 100, output: null },
    stamped: ["updated_at", "completed_at"],
  },
  {
    status: "completed_with_concerns",
    output: OUT,
    fixed: { status: "completed_with_concerns", progress: 100, output: JSON.stringify(OUT) },
    stamped: ["updated_at", "completed_at"],
  },
  {
    status: "completed_with_concerns",
    fixed: { status: "completed_with_concerns", progress: 100, output: null },
    stamped: ["updated_at", "completed_at"],
  },
  {
    status: "needs_context",
    error: ERR,
    fixed: { status: "needs_context", error: ERR },
    stamped: ["updated_at"],
  },
  { status: "blocked", error: ERR, fixed: { status: "blocked", error: ERR }, stamped: ["updated_at"] },
  {
    status: "failed",
    output: OUT,
    error: ERR,
    fixed: { status: "failed", error: ERR, output: JSON.stringify(OUT) },
    stamped: ["updated_at", "completed_at"],
  },
  {
    status: "failed",
    error: ERR,
    fixed: { status: "failed", error: ERR, output: null },
    stamped: ["updated_at", "completed_at"],
  },
  { status: "pending", fixed: { status: "pending" }, stamped: ["updated_at"] },
];

const TERMINAL = ["cancelled", "completed", "completed_with_concerns", "failed"];

// Unfinished states a task can be in when its status is written; the
// terminal-state guard must let every one of them through.
const UNFINISHED_STARTS = ["queued", "running"];

describe("updateTaskStatus on the real schema", () => {
  it.each(
    BRANCHES.flatMap((b) =>
      UNFINISHED_STARTS.map(
        (start) => [`${b.status}${b.output ? " with output" : ""}`, start, b] as const,
      ),
    ),
  )(
    "%s from %s: writes exactly its columns on the middle task; the neighbours stay as they were",
    (_name, start, b) => {
      for (const id of ["t-1", "t-2", "t-3"]) seedTask(id, { status: start });
      const before = { t1: taskRow("t-1"), t2: taskRow("t-2"), t3: taskRow("t-3") };

      updateTaskStatus("t-2", b.status, b.output, b.error);

      expectWritten(taskRow("t-2"), before.t2, b.fixed, b.stamped);
      expect(taskRow("t-1")).toEqual(before.t1);
      expect(taskRow("t-3")).toEqual(before.t3);
    },
  );

  it.each(BRANCHES.map((b) => [`${b.status}${b.output ? " with output" : ""}`, b] as const))(
    "%s: a task already in any terminal status is left unchanged",
    (_name, b) => {
      for (const status of TERMINAL) {
        closeDatabase();
        initDatabase(":memory:");
        seedTask("t-1", { status: "queued" });
        seedTask("t-2", { status });
        seedTask("t-3", { status: "queued" });
        const before = allTasks();
        updateTaskStatus("t-2", b.status, b.output, b.error);
        expect(allTasks()).toEqual(before);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

describe("getTask / getTaskWithRuns on the real schema", () => {
  beforeEach(() => {
    seedTask("t-2");
    seedTask("t-1");
    seedTask("t-3");
    // The middle task's runs, inserted out of time order.
    seedRun("r-2a", "t-2", { createdAt: "2026-01-01 10:02:00" });
    seedRun("r-2b", "t-2", { createdAt: "2026-01-01 10:00:00" });
    seedRun("r-2c", "t-2", { createdAt: "2026-01-01 10:01:00" });
    seedRun("r-1x", "t-1", { createdAt: "2026-01-01 10:05:00" });
    seedRun("r-3x", "t-3", { createdAt: "2026-01-01 10:06:00" });
    // Its subtasks: insertion, id and created_at order all differ.
    seedTask("s-b", { parent: "t-2", createdAt: "2026-01-01 10:03:00" });
    seedTask("s-a", { parent: "t-2", createdAt: "2026-01-01 10:01:00" });
    seedTask("s-c", { parent: "t-2", createdAt: "2026-01-01 10:02:00" });
    seedTask("s-1", { parent: "t-1", createdAt: "2026-01-01 10:00:00" });
    seedTask("s-3", { parent: "t-3", createdAt: "2026-01-01 10:04:00" });
  });

  it("getTask returns the one row; an absent id below or above every row is null", () => {
    expect(getTask("t-2")).toEqual(taskRow("t-2"));
    expect(getTask("t-2")?.title).toBe("title t-2");
    expect(getTask("a-0")).toBeNull();
    expect(getTask("t-0")).toBeNull();
    expect(getTask("t-9")).toBeNull();
  });

  it("getTaskWithRuns: the task, its runs newest first, its subtasks oldest first", () => {
    const got = getTaskWithRuns("t-2")!;
    expect(got.task).toEqual(taskRow("t-2"));
    expect(got.runs.map((r) => r.run_id)).toEqual(["r-2a", "r-2c", "r-2b"]);
    expect(got.runs[0]).toEqual(runRow("r-2a"));
    expect(got.subtasks.map((t) => t.task_id)).toEqual(["s-a", "s-c", "s-b"]);
    expect(got.subtasks[0]).toEqual(taskRow("s-a"));
    expect(getTaskWithRuns("t-0")).toBeNull();
  });
});

describe("getRunToolCalls on the real schema (neighbours on both sides)", () => {
  it("reads the middle task's most recent run; tasks below and above, or an absent id, do not leak in", () => {
    for (const id of ["t-1", "t-2", "t-3"]) seedTask(id);
    seedRun("r-new", "t-2", { createdAt: "2026-01-01 10:03:00", toolCalls: '["new_tool","second_tool"]' });
    seedRun("r-old", "t-2", { createdAt: "2026-01-01 10:01:00", toolCalls: '["old_tool"]' });
    seedRun("r-low", "t-1", { createdAt: "2026-01-01 10:09:00", toolCalls: '["low_tool"]' });
    seedRun("r-high", "t-3", { createdAt: "2026-01-01 10:08:00", toolCalls: '["high_tool"]' });
    expect(getRunToolCalls("t-2")).toEqual(["new_tool", "second_tool"]);
    expect(getRunToolCalls("t-0")).toEqual([]);
    expect(getRunToolCalls("t-9")).toEqual([]);
  });
});

describe("listTasks filters on the real schema (values below and above each filter)", () => {
  beforeEach(() => {
    // Parents first (foreign key). Every filtered set holds at least three
    // rows whose insertion (id) order is neither newest-first nor oldest-first,
    // so only created_at gives the order the read must return.
    seedTask("p-3", { status: "cancelled", agentType: "heavy", createdAt: "2026-01-01 10:02:00" });
    seedTask("p-1", { status: "completed", agentType: "fast", createdAt: "2026-01-01 10:00:00" });
    seedTask("p-2", { status: "running", agentType: "swarm", createdAt: "2026-01-01 10:01:00" });
    seedTask("k-2b", { parent: "p-2", status: "running", agentType: "heavy", createdAt: "2026-01-01 10:05:00" });
    seedTask("k-2c", { parent: "p-2", status: "failed", agentType: "heavy", createdAt: "2026-01-01 10:06:00" });
    seedTask("k-1", { parent: "p-1", status: "failed", agentType: "heavy", createdAt: "2026-01-01 10:03:00" });
    seedTask("k-2d", { parent: "p-2", status: "pending", agentType: "fast", createdAt: "2026-01-01 10:07:00" });
    seedTask("k-2a", { parent: "p-2", status: "failed", agentType: "heavy", createdAt: "2026-01-01 10:04:00" });
    seedTask("k-3", { parent: "p-3", status: "pending", agentType: "swarm", createdAt: "2026-01-01 10:08:00" });
  });

  const ids = (rows: Array<{ task_id: string }>) => rows.map((r) => r.task_id);

  it("by parent", () => {
    expect(ids(listTasks({ parentTaskId: "p-2" }))).toEqual(["k-2d", "k-2c", "k-2b", "k-2a"]);
  });

  it("by status", () => {
    expect(ids(listTasks({ status: "failed" }))).toEqual(["k-2c", "k-2a", "k-1"]);
  });

  it("by agent type", () => {
    expect(ids(listTasks({ agentType: "heavy" }))).toEqual(["k-2c", "k-2b", "k-2a", "k-1", "p-3"]);
  });

  it("parent and agent type together", () => {
    expect(ids(listTasks({ parentTaskId: "p-2", agentType: "heavy" }))).toEqual(["k-2c", "k-2b", "k-2a"]);
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe("cancelTask on the real schema", () => {
  beforeEach(() => {
    seedTask("t-1", { status: "running" });
    seedTask("t-2", { status: "running" });
    seedTask("t-3", { status: "running" });
    seedTask("c-1a", { parent: "t-1", status: "queued" });
    seedTask("c-3a", { parent: "t-3", status: "queued" });
    seedTask("c-2-queued", { parent: "t-2", status: "queued" });
    seedTask("c-2-running", { parent: "t-2", status: "running" });
    seedTask("c-2-done", { parent: "t-2", status: "completed" });
    seedTask("c-2-failed", { parent: "t-2", status: "failed" });
    seedTask("c-2-cwc", { parent: "t-2", status: "completed_with_concerns" });
    seedTask("c-2-cancelled", { parent: "t-2", status: "cancelled" });
    seedTask("g-2", { parent: "c-2-queued", status: "running" });
    seedRun("r-1", "t-1");
    seedRun("r-2-run", "t-2");
    seedRun("r-2-done", "t-2", { status: "completed" });
    // Finished runs in the other end states, each with its own completion time.
    seedRun("r-2-failed", "t-2", { status: "failed", completedAt: "2001-01-01 00:00:04" });
    seedRun("r-2-cancelled", "t-2", { status: "cancelled", completedAt: "2001-01-01 00:00:05" });
    seedRun("r-3", "t-3");
    seedRun("r-g", "g-2");
  });

  it("cancels the task, its running runs and its unfinished subtasks (recursively); nothing else changes", () => {
    const tasksBefore = new Map(allTasks().map((r) => [r.task_id as string, r]));
    const runsBefore = new Map(allRuns().map((r) => [r.run_id as string, r]));

    expect(cancelTask("t-2")).toBe(true);

    const cancelled = ["t-2", "c-2-queued", "c-2-running", "g-2"];
    for (const id of cancelled) {
      expectWritten(taskRow(id), tasksBefore.get(id)!, { status: "cancelled" }, ["updated_at", "completed_at"]);
    }
    for (const [id, before] of tasksBefore) {
      if (!cancelled.includes(id)) expect(taskRow(id)).toEqual(before);
    }
    for (const id of ["r-2-run", "r-g"]) {
      expectWritten(runRow(id), runsBefore.get(id)!, { status: "cancelled" }, ["completed_at"]);
    }
    for (const id of ["r-1", "r-2-done", "r-2-failed", "r-2-cancelled", "r-3"]) {
      expect(runRow(id)).toEqual(runsBefore.get(id));
    }
    expect(runRow("r-2-failed")).toMatchObject({ status: "failed", completed_at: "2001-01-01 00:00:04" });
    expect(runRow("r-2-cancelled")).toMatchObject({ status: "cancelled", completed_at: "2001-01-01 00:00:05" });
    const announced = mocks.emitEvent.mock.calls
      .filter((c) => c[0] === "task.cancelled")
      .map((c) => (c[1] as { task_id: string }).task_id)
      .sort();
    expect(announced).toEqual([...cancelled].sort());
  });
});

// ---------------------------------------------------------------------------
// submitTask: the task INSERT, the foreign-project read, the run row and its rollback
// ---------------------------------------------------------------------------

const LOW_RUN = "00000000-0000-4000-8000-000000000000";
const HIGH_RUN = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const CLASSIFIED = {
  agentType: "fast",
  score: 2,
  reason: "syn reason",
  explicit: false,
  modelTier: "standard",
};

// Every value of the submission's spawn-type and priority unions, each exactly
// once: a value added to or removed from a union without this list fails the
// test typecheck.
const SPAWN_TYPES = { root: true, subtask: true, "user-background": true } satisfies Record<
  NonNullable<TaskSubmission["spawnType"]>,
  true
>;
const PRIORITIES = { critical: true, high: true, medium: true, low: true } satisfies Record<
  NonNullable<TaskSubmission["priority"]>,
  true
>;

const stubRunnerExecute = vi.fn(async () => {
  throw new Error("stub runner must never execute in this file");
});

describe("submitTask on the real schema (dispatch stops at a refused claim)", () => {
  let tick = 0;
  let atClaim: { claimId: string; task: Row; runs: Row[] } | null = null;

  beforeAll(() => {
    registerRunner({ type: "fast", execute: stubRunnerExecute });
  });

  afterAll(() => {
    expect(stubRunnerExecute).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    // The foreign-project list is cached for 30 s; each case runs an hour later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + ++tick * 3_600_000));
    atClaim = null;
    mocks.classify.mockImplementation(() => ({ ...CLASSIFIED }));
    mocks.checkout.mockImplementation((taskId: string, claimId: string) => {
      const db = getDatabase();
      atClaim = {
        claimId,
        task: db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row,
        runs: db.prepare("SELECT * FROM runs WHERE task_id = ?").all(taskId) as Row[],
      };
      return { success: false, reason: "stub refuses every claim" };
    });

    const project = getDatabase().prepare(
      "INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, ?, ?)",
    );
    project.run("pr-1", "mission-control", "Mission Hub", "active", "{}");
    project.run("pr-2", "Agent-Controller", "Controller Two", "active", "{}");
    project.run("pr-3", "jarvis", "Jarvis Core", "active", "{}");
    project.run("pr-4", "proj-archived", "Archived One", "archived", "{}");
    project.run("pr-5", "proj-done", "Done One", "completed", "{}");
    project.run("pr-6", "proj-paused", "Paused Two", "paused", "{}");
    project.run("pr-7", "proj-active", "Active One", "active", JSON.stringify({ aliases: ["alias-one"] }));
    project.run("pr-8", "proj-null", "Null Status", null, "{}");

    seedTask("parent-1", { status: "running" });
    seedTask("nb-task", { status: "running" });
    seedRun(LOW_RUN, "nb-task");
    seedRun(HIGH_RUN, "nb-task");
  });

  it("classifies with the names of active, paused and status-less projects other than this repository", async () => {
    await submitTask({ title: "syn title", description: "syn description" });
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    const names = [...(mocks.classify.mock.calls[0][0].foreignProjectNames as string[])].sort();
    expect(names).toEqual(
      ["Active One", "Null Status", "Paused Two", "alias-one", "proj-active", "proj-null", "proj-paused"].sort(),
    );
  });

  it("stores every given submission field in its own column, status queued", async () => {
    const neighboursBefore = allRuns();
    const r = await submitTask({
      title: "syn title",
      description: "syn description text",
      priority: "high",
      tags: ["tag-a"],
      tools: ["tool_a"],
      ritualId: "ritual-x",
      threadId: "thread-x",
      parentTaskId: "parent-1",
      spawnType: "subtask",
      input: { q: "syn input" },
      retryCount: 3,
      projectSlug: "proj-active",
      projectSource: "inbound",
    });

    const attributed = mocks.emitTrace.mock.calls
      .map((c) => c[0])
      .find((e) => e.name === "attribution.resolved" && e.taskId === r.taskId);
    expect(attributed.attrs.slug).toBe("proj-active");
    const row = taskRow(r.taskId);
    expect(row).toMatchObject({
      task_id: r.taskId,
      parent_task_id: "parent-1",
      spawn_type: "subtask",
      title: "syn title",
      description: "syn description text",
      priority: "high",
      status: "queued",
      agent_type: "fast",
      classification: JSON.stringify(CLASSIFIED),
      input: JSON.stringify({ q: "syn input" }),
      metadata: JSON.stringify({ tags: ["tag-a"], tools: ["tool_a"], ritualId: "ritual-x", threadId: "thread-x" }),
      retry_count: 3,
      project_slug: attributed.attrs.slug,
      project_source: attributed.attrs.source,
      assigned_to: null,
      output: null,
      error: null,
    });
    expect(atClaim!.task).toEqual(row);

    // The run row as it stood at the claim, then rolled back; the neighbours stay.
    const runId = atClaim!.claimId.replace(/^runner:fast:/, "");
    expect(atClaim!.runs).toEqual([
      expect.objectContaining({
        run_id: runId,
        task_id: r.taskId,
        agent_type: "fast",
        status: "running",
        input: JSON.stringify({ title: "syn title", descriptionChars: "syn description text".length }),
        output: null,
        error: null,
        tool_calls: null,
      }),
    ]);
    expect(allRuns()).toEqual(neighboursBefore);
    expect(runRow(LOW_RUN)).toBeDefined();
    expect(runRow(HIGH_RUN)).toBeDefined();
  });

  it("omitted submission fields take their defaults", async () => {
    const r = await submitTask({ title: "bare title", description: "bare description" });
    expect(taskRow(r.taskId)).toMatchObject({
      parent_task_id: null,
      spawn_type: "root",
      title: "bare title",
      description: "bare description",
      priority: "medium",
      status: "queued",
      input: null,
      metadata: null,
      retry_count: 0,
      project_slug: null,
      project_source: null,
    });
    expect(allRuns().map((x) => x.run_id)).toEqual([LOW_RUN, HIGH_RUN]);
  });

  // Every spawn type the submission type allows must be storable on a database
  // built from the schema file.
  it("a background-agent submission is stored with its spawn type", async () => {
    const neighboursBefore = allTasks();
    const r = await submitTask({
      title: "bg title",
      description: "bg description",
      spawnType: "user-background",
    });
    const row = taskRow(r.taskId);
    expect(row).toEqual({
      id: expect.any(Number),
      task_id: r.taskId,
      parent_task_id: null,
      spawn_type: "user-background",
      title: "bg title",
      description: "bg description",
      priority: "medium",
      status: "queued",
      agent_type: "fast",
      classification: JSON.stringify(CLASSIFIED),
      assigned_to: null,
      input: null,
      output: null,
      error: null,
      progress: 0,
      metadata: null,
      created_at: expect.stringMatching(STAMP_RE),
      updated_at: expect.stringMatching(STAMP_RE),
      started_at: null,
      completed_at: null,
      retry_count: 0,
      project_slug: null,
      project_source: null,
    });
    expect(atClaim!.task).toEqual(row);
    expect(allTasks().filter((t) => t.task_id !== r.taskId)).toEqual(neighboursBefore);
  });

  // The schema rule and the submission type list the same values: the rule
  // lists nothing else, and a value outside it is refused by the database.
  function expectRuleIsExactly(column: string, values: string[], outside: string[]): void {
    const tableSql = (
      getDatabase().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as {
        sql: string;
      }
    ).sql;
    const rule = tableSql.match(new RegExp(`CHECK\\(${column} IN \\(([^)]*)\\)\\)`));
    expect(rule).not.toBeNull();
    expect(rule![1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).sort()).toEqual([...values].sort());

    const before = allTasks();
    for (const value of outside) {
      expect(() =>
        getDatabase()
          .prepare(`INSERT INTO tasks (task_id, title, description, ${column}) VALUES ('outside-1', 't', 'd', ?)`)
          .run(value),
      ).toThrow(/CHECK constraint failed/);
    }
    expect(allTasks()).toEqual(before);
  }

  it("every spawn type of the submission type is stored as given; the schema rule allows no other", async () => {
    const values = Object.keys(SPAWN_TYPES) as Array<keyof typeof SPAWN_TYPES>;
    for (const spawnType of values) {
      const r = await submitTask({ title: `t ${spawnType}`, description: "d", spawnType });
      expect(taskRow(r.taskId).spawn_type).toBe(spawnType);
    }
    expectRuleIsExactly("spawn_type", values, ["user_background", "background", ""]);
  });

  it("every priority of the submission type is stored as given; the schema rule allows no other", async () => {
    const values = Object.keys(PRIORITIES) as Array<keyof typeof PRIORITIES>;
    for (const priority of values) {
      const r = await submitTask({ title: `t ${priority}`, description: "d", priority });
      expect(taskRow(r.taskId).priority).toBe(priority);
    }
    expectRuleIsExactly("priority", values, ["normal", "urgent", ""]);
  });
});
