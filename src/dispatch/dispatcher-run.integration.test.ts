/**
 * The run phase of `dispatch/dispatcher` on the real schema
 * (`initDatabase(":memory:")`): what the dispatcher writes once the claim is
 * granted and a runner has returned — the cancel check, the cancelled close,
 * the sandbox-to-fast fallback, the run close and the thrown-run close.
 *
 * The claim is the real `checkoutTask`. The runners are stand-ins registered
 * here for `fast` and `nanoclaw`: each returns the canned result its case set
 * (and throws when a case set none); no runner module is imported. Every other
 * effect after the runner returns is either real against the in-memory
 * database (gates ledger, task status, concern detail, run-tool context) or a
 * stub: event bus, trace, cost and the completion ledger record; the knowledge
 * base write, the memory write, the router, the schedule alert and the budget
 * read throw and are asserted never called.
 *
 * Every keyed write has a neighbour row whose key sorts below and one whose
 * key sorts above every generated id, so a widened key must touch a
 * neighbour. Every column a write sets is pre-set to a seed value first, so a
 * dropped assignment leaves the seed behind.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerInput, RunnerOutput } from "../runners/types.js";

const mocks = vi.hoisted(() => {
  const never = (name: string) =>
    vi.fn((..._args: unknown[]): never => {
      throw new Error(`${name} must not be reached from the run phase in this file`);
    });
  return {
    emitEvent: vi.fn(),
    emitTrace: vi.fn(),
    classify: vi.fn(),
    ledger: vi.fn(),
    recordCost: vi.fn(),
    taskStarted: vi.fn(),
    taskCompleted: vi.fn(),
    never: {
      appendToDeliverable: never("appendToDeliverable"),
      upsertFile: never("upsertFile"),
      getMemoryService: never("getMemoryService"),
      getRouter: never("getRouter"),
      recordRitualFailure: never("recordRitualFailure"),
      isAnyWindowExceeded: never("isAnyWindowExceeded"),
      getThreeWindowStatus: never("getThreeWindowStatus"),
    },
  };
});

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: mocks.emitEvent }),
}));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: mocks.emitTrace }));
vi.mock("./classifier.js", () => ({ classify: mocks.classify }));
// The completion ledger passes the status and output through unchanged.
vi.mock("../lib/v8-4/consumer.js", () => ({
  applyCompletionLedger: mocks.ledger,
  appendToDeliverable: mocks.never.appendToDeliverable,
}));
vi.mock("../budget/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../budget/service.js")>()),
  recordCost: mocks.recordCost,
  isAnyWindowExceeded: mocks.never.isAnyWindowExceeded,
  getThreeWindowStatus: mocks.never.getThreeWindowStatus,
}));
vi.mock("../observability/prometheus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/prometheus.js")>()),
  taskStarted: mocks.taskStarted,
  taskCompleted: mocks.taskCompleted,
}));
vi.mock("../db/jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/jarvis-fs.js")>()),
  upsertFile: mocks.never.upsertFile,
}));
vi.mock("../memory/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory/index.js")>()),
  getMemoryService: mocks.never.getMemoryService,
}));
vi.mock("../messaging/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../messaging/index.js")>()),
  getRouter: mocks.never.getRouter,
}));
vi.mock("../rituals/scheduler.js", () => ({
  recordRitualFailure: mocks.never.recordRitualFailure,
}));
// Only the keys the run phase reads on these paths; any other read fails.
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
import { registerRunner, submitTask, type TaskSubmission } from "./dispatcher.js";

type Row = Record<string, unknown>;
type Plan = (input: RunnerInput) => Promise<RunnerOutput>;

// Below and above every generated (random v4) id, in both tables.
const LOW = "00000000-0000-4000-8000-000000000000";
const HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const OLD_STARTED = "2001-01-01 00:00:01";
const OLD_COMPLETED = "2001-01-01 00:00:02";
const OLD_UPDATED = "2001-01-01 00:00:03";
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Seed values of every column a run close can set, each distinct.
const RUN_SEED = {
  status: "running",
  runner_status: "SEED_STATUS",
  output: JSON.stringify("seed output"),
  error: "seed error",
  token_usage: JSON.stringify({ seed: 1 }),
  goal_graph: JSON.stringify({ seedGraph: 2 }),
  trace: JSON.stringify(["seed trace"]),
  tool_calls: JSON.stringify(["seed_tool"]),
  duration_ms: 7,
  completed_at: OLD_COMPLETED,
};

const db = () => getDatabase();
const taskRow = (taskId: string): Row =>
  db().prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Row;
const runRow = (runId: string): Row =>
  db().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row;
const runsOf = (taskId: string): Row[] =>
  db().prepare("SELECT * FROM runs WHERE task_id = ?").all(taskId) as Row[];

function seedNeighbourTask(taskId: string, status: string): void {
  db()
    .prepare(
      `INSERT INTO tasks (task_id, spawn_type, title, description, status, agent_type, assigned_to,
                          output, error, progress, created_at, updated_at, started_at, completed_at)
       VALUES (?, 'root', ?, ?, ?, 'nanoclaw', ?, ?, ?, 7, '2026-01-01 09:00:00', ?, ?, ?)`,
    )
    .run(
      taskId,
      `title ${taskId}`,
      `description ${taskId}`,
      status,
      `claim ${taskId}`,
      JSON.stringify(`old output ${taskId}`),
      `old error ${taskId}`,
      OLD_UPDATED,
      OLD_STARTED,
      OLD_COMPLETED,
    );
}

function seedNeighbourRun(runId: string, taskId: string): void {
  db()
    .prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, status, runner_status, output, error,
                         token_usage, goal_graph, trace, tool_calls, duration_ms, completed_at)
       VALUES (@runId, @taskId, 'nanoclaw', '{}', @status, @runner_status, @output, @error,
               @token_usage, @goal_graph, @trace, @tool_calls, @duration_ms, @completed_at)`,
    )
    .run({ runId, taskId, ...RUN_SEED });
}

/** Pre-set every column a run close can write on the running run's row. */
function seedOwnRun(runId: string): Row {
  db()
    .prepare(
      `UPDATE runs SET runner_status = @runner_status, output = @output, error = @error,
         token_usage = @token_usage, goal_graph = @goal_graph, trace = @trace,
         tool_calls = @tool_calls, duration_ms = @duration_ms, completed_at = @completed_at
       WHERE run_id = @runId`,
    )
    .run({ runId, ...RUN_SEED });
  return runRow(runId);
}

/** Write a cancel into the task row, as any other writer of the task store would. */
function cancelInStore(taskId: string): void {
  db().prepare("UPDATE tasks SET status = 'cancelled' WHERE task_id = ?").run(taskId);
}

/** Move the faked clock forward so the run's duration is a known number. */
function elapse(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** `row` equals `before` except `fixed` columns and freshly stamped `stamped` columns. */
function expectWritten(row: Row, before: Row, fixed: Row, stamped: string[]): void {
  const want: Row = { ...before, ...fixed };
  for (const c of stamped) want[c] = expect.stringMatching(STAMP_RE);
  expect(row).toEqual(want);
  for (const c of stamped) expect(row[c]).not.toBe(before[c]);
}

const plans: Partial<Record<"fast" | "nanoclaw", Plan>> = {};
const standIn = (type: "fast" | "nanoclaw") => ({
  type,
  execute: (input: RunnerInput): Promise<RunnerOutput> => {
    const plan = plans[type];
    if (!plan) throw new Error(`stand-in ${type} runner has no canned result in this case`);
    return plan(input);
  },
});

/** Submit, then wait for the run's own `finally` (its first line counts the task as finished). */
async function runToEnd(submission: TaskSubmission): Promise<string> {
  const ended = new Promise<void>((resolve) => {
    mocks.taskCompleted.mockImplementationOnce(() => resolve());
  });
  const { taskId } = await submitTask(submission);
  await ended;
  return taskId;
}

const events = (name: string) => mocks.emitEvent.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const traces = (name: string) =>
  mocks.emitTrace.mock.calls.map((c) => c[0] as Row).filter((e) => e.name === name);

let neighbours: { lowTask: Row; highTask: Row; lowRun: Row; highRun: Row };

function seedNeighbours(taskStatus: string): void {
  seedNeighbourTask(LOW, taskStatus);
  seedNeighbourTask(HIGH, taskStatus);
  seedNeighbourRun(LOW, LOW);
  seedNeighbourRun(HIGH, HIGH);
  neighbours = { lowTask: taskRow(LOW), highTask: taskRow(HIGH), lowRun: runRow(LOW), highRun: runRow(HIGH) };
}

function expectNeighboursUnchanged(): void {
  expect(taskRow(LOW)).toEqual(neighbours.lowTask);
  expect(taskRow(HIGH)).toEqual(neighbours.highTask);
  expect(runRow(LOW)).toEqual(neighbours.lowRun);
  expect(runRow(HIGH)).toEqual(neighbours.highRun);
}

function classifyAs(agentType: "fast" | "nanoclaw"): void {
  mocks.classify.mockImplementation(() => ({
    agentType,
    score: 2,
    reason: "syn reason",
    explicit: false,
    modelTier: "standard",
  }));
}

let tick = 0;

beforeAll(() => {
  registerRunner(standIn("fast"));
  registerRunner(standIn("nanoclaw"));
});

afterAll(() => {
  for (const [name, stub] of Object.entries(mocks.never)) {
    expect(stub, name).not.toHaveBeenCalled();
  }
});

beforeEach(() => {
  initDatabase(":memory:");
  // The foreign-project list is cached for 30 s; each case runs an hour later.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + ++tick * 3_600_000));
  for (const m of [mocks.emitEvent, mocks.emitTrace, mocks.classify, mocks.ledger, mocks.recordCost]) m.mockReset();
  mocks.taskStarted.mockReset();
  mocks.taskCompleted.mockReset();
  mocks.ledger.mockImplementation(async (args: { taskStatus: string; result: RunnerOutput }) => ({
    taskStatus: args.taskStatus,
    output: args.result.output,
    gates: null,
    numbers: null,
  }));
  delete plans.fast;
  delete plans.nanoclaw;
  classifyAs("fast");
});

afterEach(() => {
  // Cleanup first, so a failing case leaves neither the database nor the fake clock to the next one.
  const classified = mocks.classify.mock.calls.length;
  const started = mocks.taskStarted.mock.calls.length;
  const completed = mocks.taskCompleted.mock.calls.length;
  closeDatabase();
  vi.useRealTimers();
  // One classification per case: no follow-up task was submitted.
  expect(classified).toBe(1);
  expect(completed).toBe(started);
});

// ---------------------------------------------------------------------------
// The run close (UPDATE runs … WHERE run_id) and the cancel check (SELECT status)
// ---------------------------------------------------------------------------

describe("a returned run is closed with every field of the runner's result", () => {
  it("a success with concerns: each column holds its own field, omitted fields are cleared; nothing else changes", async () => {
    seedNeighbours("running");
    const output = { finalAnswer: "syn final answer" };
    const tokenUsage = { promptTokens: 11, completionTokens: 22, actualModel: "syn-model-a", actualCostUsd: 0.25 };
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      elapse(1500);
      return { success: true, status: "DONE_WITH_CONCERNS", concerns: ["syn concern"], output, tokenUsage, durationMs: 1 };
    };

    const taskId = await runToEnd({ title: "syn title a", description: "syn description a" });

    const [run] = runsOf(taskId);
    expectWritten(
      run,
      before,
      {
        status: "completed",
        runner_status: "DONE_WITH_CONCERNS",
        output: JSON.stringify(output),
        error: null,
        token_usage: JSON.stringify(tokenUsage),
        goal_graph: null,
        trace: null,
        tool_calls: "[]",
        duration_ms: 1500,
      },
      ["completed_at"],
    );
    expect(taskRow(taskId)).toMatchObject({
      status: "completed_with_concerns",
      agent_type: "fast",
      assigned_to: `runner:fast:${run.run_id as string}`,
      output: JSON.stringify(output),
      progress: 100,
    });
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(mocks.ledger.mock.calls[0][0]).toMatchObject({ taskId, runId: run.run_id, taskStatus: "completed_with_concerns" });
    expect(mocks.recordCost.mock.calls).toEqual([
      [{ runId: run.run_id, taskId, agentType: "fast", model: "syn-model-a", promptTokens: 11, completionTokens: 22, costUsdOverride: 0.25 }],
    ]);
    expect(events("task.completed")).toEqual([
      { task_id: taskId, agent_id: "fast", result: output, duration_ms: 1500 },
    ]);
    expect(events("task.failed")).toEqual([]);
    expect(events("task.cancelled")).toEqual([]);
    expectNeighboursUnchanged();
  });

  it("a blocked failure: every column, including goal graph, trace and tool calls, holds its own field", async () => {
    seedNeighbours("running");
    const result = {
      success: false,
      status: "BLOCKED" as const,
      output: { text: "syn blocker text" },
      error: "syn blocked reason",
      tokenUsage: { promptTokens: 33, completionTokens: 44, actualModel: "syn-model-b", actualCostUsd: 0.5 },
      goalGraph: { nodes: ["syn-goal"] },
      trace: [{ step: "syn-step" }],
      toolCalls: ["syn_tool_a", "syn_tool_b"],
      durationMs: 2,
    };
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      elapse(2500);
      return result;
    };

    const taskId = await runToEnd({ title: "syn title b", description: "syn description b" });

    const [run] = runsOf(taskId);
    expectWritten(
      run,
      before,
      {
        status: "failed",
        runner_status: "BLOCKED",
        output: JSON.stringify(result.output),
        error: "syn blocked reason",
        token_usage: JSON.stringify(result.tokenUsage),
        goal_graph: JSON.stringify(result.goalGraph),
        trace: JSON.stringify(result.trace),
        tool_calls: JSON.stringify(result.toolCalls),
        duration_ms: 2500,
      },
      ["completed_at"],
    );
    expect(taskRow(taskId)).toMatchObject({ status: "blocked", error: "syn blocked reason" });
    expect(events("task.failed")).toEqual([
      {
        task_id: taskId,
        agent_id: "fast",
        error: "syn blocked reason",
        recoverable: false,
        attempts: 1,
        result: result.output,
      },
    ]);
    expect(events("task.completed")).toEqual([]);
    expectNeighboursUnchanged();
  });

  // The cancel check reads this task's own row: a cancel recorded on any
  // other task, below or above this one's id, does not cancel this run.
  it("cancelled neighbours on both sides of the id do not cancel a running task", async () => {
    seedNeighbours("cancelled");
    plans.fast = async () => ({ success: true, output: { finalAnswer: "syn answer c" }, durationMs: 1 });

    const taskId = await runToEnd({ title: "syn title c", description: "syn description c" });

    expect(runsOf(taskId)).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(taskRow(taskId)).toMatchObject({ status: "completed" });
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(events("task.cancelled")).toEqual([]);
    expect(traces("task.cancelled")).toEqual([]);
    expectNeighboursUnchanged();
  });
});

// ---------------------------------------------------------------------------
// The cancelled close (UPDATE runs SET status = 'cancelled' … WHERE run_id)
// ---------------------------------------------------------------------------

describe("a run whose task was cancelled in the store while the runner worked closes as cancelled", () => {
  it("each column holds its own field; goal graph and trace are not written; the spend is booked", async () => {
    seedNeighbours("running");
    const result = {
      success: true,
      output: { finalAnswer: "syn partial answer" },
      error: "syn cancel-time error",
      tokenUsage: { promptTokens: 55, completionTokens: 66, actualModel: "syn-model-d", actualCostUsd: 0.75 },
      goalGraph: { nodes: ["unwritten-goal"] },
      trace: [{ step: "unwritten-step" }],
      toolCalls: ["syn_tool_c"],
      durationMs: 3,
    };
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      cancelInStore(input.taskId);
      elapse(900);
      return result;
    };

    const taskId = await runToEnd({ title: "syn title d", description: "syn description d" });

    const [run] = runsOf(taskId);
    expectWritten(
      run,
      before,
      {
        status: "cancelled",
        runner_status: null,
        output: JSON.stringify(result.output),
        error: "syn cancel-time error",
        token_usage: JSON.stringify(result.tokenUsage),
        tool_calls: JSON.stringify(result.toolCalls),
        duration_ms: 900,
      },
      ["completed_at"],
    );
    expect(run.goal_graph).toBe(RUN_SEED.goal_graph);
    expect(run.trace).toBe(RUN_SEED.trace);
    expect(taskRow(taskId)).toMatchObject({ status: "cancelled", output: null, error: null });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.recordCost.mock.calls).toEqual([
      [{ runId: run.run_id, taskId, agentType: "fast", model: "syn-model-d", promptTokens: 55, completionTokens: 66, costUsdOverride: 0.75 }],
    ]);
    expect(events("task.cancelled")).toEqual([
      { task_id: taskId, cancelled_by: "db", reason: "Cancelled in the task store" },
    ]);
    expect(events("task.completed")).toEqual([]);
    expect(traces("task.cancelled")).toEqual([expect.objectContaining({ taskId, runId: run.run_id, latencyMs: 900 })]);
    expectNeighboursUnchanged();
  });

  it("omitted fields are cleared and an empty tool list is stored as []", async () => {
    seedNeighbours("running");
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      cancelInStore(input.taskId);
      elapse(400);
      return { success: false, durationMs: 4 };
    };

    const taskId = await runToEnd({ title: "syn title e", description: "syn description e" });

    const [run] = runsOf(taskId);
    expectWritten(
      run,
      before,
      {
        status: "cancelled",
        runner_status: null,
        output: null,
        error: null,
        token_usage: null,
        tool_calls: "[]",
        duration_ms: 400,
      },
      ["completed_at"],
    );
    expect(mocks.recordCost).not.toHaveBeenCalled();
    expectNeighboursUnchanged();
  });
});

// ---------------------------------------------------------------------------
// The thrown-run close (UPDATE runs SET status, error, completed_at … WHERE run_id)
// ---------------------------------------------------------------------------

describe("a runner that throws closes its run with the error and nothing else", () => {
  it("failed: status, error and completion time are written; every other column keeps its value", async () => {
    seedNeighbours("running");
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      throw new Error("syn runner threw");
    };

    const taskId = await runToEnd({ title: "syn title f", description: "syn description f" });

    const [run] = runsOf(taskId);
    expectWritten(run, before, { status: "failed", error: "syn runner threw" }, ["completed_at"]);
    expect(taskRow(taskId)).toMatchObject({ status: "failed", error: "syn runner threw" });
    expect(traces("task.failed")).toEqual([
      expect.objectContaining({ taskId, runId: run.run_id, attrs: expect.objectContaining({ thrown: true }) }),
    ]);
    expect(events("task.cancelled")).toEqual([]);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expectNeighboursUnchanged();
  });

  it("cancelled: a throw after a cancel in the store closes the run as cancelled and announces it once", async () => {
    seedNeighbours("running");
    let before: Row = {};
    plans.fast = async (input) => {
      before = seedOwnRun(input.runId);
      cancelInStore(input.taskId);
      throw new Error("syn throw after cancel");
    };

    const taskId = await runToEnd({ title: "syn title g", description: "syn description g" });

    const [run] = runsOf(taskId);
    expectWritten(run, before, { status: "cancelled", error: "syn throw after cancel" }, ["completed_at"]);
    expect(taskRow(taskId)).toMatchObject({ status: "cancelled", error: null });
    expect(events("task.cancelled")).toEqual([
      { task_id: taskId, cancelled_by: "db", reason: "Cancelled in the task store" },
    ]);
    expectNeighboursUnchanged();
  });
});

// ---------------------------------------------------------------------------
// The sandbox-to-fast fallback: restart the stuck-task clock, re-stamp the runner
// ---------------------------------------------------------------------------

describe("a chat that failed quietly in the sandbox is re-run once on the fast runner", () => {
  const SANDBOX_USAGE = { promptTokens: 5, completionTokens: 6, actualModel: "syn-sandbox-model", actualCostUsd: 0.125 };
  const FAST_USAGE = { promptTokens: 7, completionTokens: 9, actualModel: "syn-fast-model", actualCostUsd: 0.0625 };

  /** The sandbox attempt sets the task's clock (and optionally its status) back, then fails without an error. */
  function sandboxFailsQuietly(status = "running"): void {
    plans.nanoclaw = async (input) => {
      db()
        .prepare("UPDATE tasks SET status = ?, started_at = ?, updated_at = ? WHERE task_id = ?")
        .run(status, OLD_STARTED, OLD_UPDATED, input.taskId);
      return { success: false, output: { text: "syn sandbox no-op" }, tokenUsage: SANDBOX_USAGE, durationMs: 5 };
    };
  }

  beforeEach(() => {
    classifyAs("nanoclaw");
    seedNeighbours("running");
  });

  it("a running task gets both clock columns restamped before the re-run and is re-attributed to fast", async () => {
    sandboxFailsQuietly();
    let atFallback: Row = {};
    plans.fast = async (input) => {
      atFallback = taskRow(input.taskId);
      return { success: true, output: { finalAnswer: "syn fast answer" }, tokenUsage: FAST_USAGE, durationMs: 6 };
    };

    const taskId = await runToEnd({ title: "syn chat h", description: "syn chat body h", tags: ["messaging"] });

    expect(atFallback).toMatchObject({ status: "running", agent_type: "nanoclaw" });
    for (const c of ["started_at", "updated_at"]) {
      expect(atFallback[c]).toMatch(STAMP_RE);
    }
    expect(atFallback.started_at).not.toBe(OLD_STARTED);
    expect(atFallback.updated_at).not.toBe(OLD_UPDATED);
    const row = taskRow(taskId);
    expect(row).toMatchObject({ status: "completed", agent_type: "fast", started_at: atFallback.started_at });
    const [run] = runsOf(taskId);
    expect(run).toMatchObject({ status: "completed", agent_type: "nanoclaw" });
    expect(mocks.recordCost.mock.calls.map((c) => [c[0].agentType, c[0].model])).toEqual([
      ["nanoclaw", "syn-sandbox-model"],
      ["fast", "syn-fast-model"],
    ]);
    expect(events("task.completed")).toEqual([expect.objectContaining({ task_id: taskId, agent_id: "fast" })]);
    expectNeighboursUnchanged();
  });

  // Only a task still running has a stuck-task clock to restart.
  it("a task no longer running keeps its clock columns; the re-run is still attributed to fast", async () => {
    sandboxFailsQuietly("pending");
    let atFallback: Row = {};
    plans.fast = async (input) => {
      atFallback = taskRow(input.taskId);
      return { success: true, output: { finalAnswer: "syn fast answer i" }, durationMs: 6 };
    };

    const taskId = await runToEnd({ title: "syn chat i", description: "syn chat body i", tags: ["messaging"] });

    expect(atFallback).toMatchObject({ status: "pending", started_at: OLD_STARTED, updated_at: OLD_UPDATED });
    expect(taskRow(taskId)).toMatchObject({ status: "completed", agent_type: "fast", started_at: OLD_STARTED });
    expectNeighboursUnchanged();
  });

  it("a failed re-run leaves the task attributed to the sandbox", async () => {
    sandboxFailsQuietly();
    plans.fast = async () => ({ success: false, error: "syn fast failed", durationMs: 6 });

    const taskId = await runToEnd({ title: "syn chat j", description: "syn chat body j", tags: ["messaging"] });

    expect(taskRow(taskId)).toMatchObject({ status: "failed", agent_type: "nanoclaw" });
    expect(runsOf(taskId)).toEqual([
      expect.objectContaining({ status: "failed", output: JSON.stringify({ text: "syn sandbox no-op" }) }),
    ]);
    expectNeighboursUnchanged();
  });
});
