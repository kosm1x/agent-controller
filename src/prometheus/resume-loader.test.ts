/**
 * resume-loader — reconstruct a resumable OrchestratorResult from a persisted
 * `runs` row. Real :memory: better-sqlite3 DB (mirrors the live runs columns
 * this loader reads); getDatabase() is mocked to return it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: Database.Database;

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

import { GoalGraph } from "./goal-graph.js";
import { GoalStatus } from "./types.js";
import { loadResumableRun } from "./resume-loader.js";

// --- Fixtures ---------------------------------------------------------------

/** A 3-goal chain (g-1 → g-2 → g-3) with g-1,g-2 completed and g-3 failed. */
function buildGraphJson(): string {
  const g = new GoalGraph();
  g.addGoal({ id: "g-1", description: "A" });
  g.addGoal({ id: "g-2", description: "B", dependsOn: ["g-1"] });
  g.addGoal({ id: "g-3", description: "C", dependsOn: ["g-2"] });
  g.updateStatus("g-1", GoalStatus.COMPLETED);
  g.updateStatus("g-2", GoalStatus.COMPLETED);
  g.updateStatus("g-3", GoalStatus.FAILED);
  return JSON.stringify(g.toJSON());
}

const OUTPUT_JSON = JSON.stringify({
  content: "meta summary",
  score: 0.42,
  learnings: ["learned x", "learned y"],
  finalAnswer: "joined per-goal answers",
});

const TRACE_JSON = JSON.stringify([
  { type: "planned", timestamp: 111 },
  { type: "executed", timestamp: 222 },
]);

const TOKEN_USAGE_JSON = JSON.stringify({
  promptTokens: 1000,
  completionTokens: 200,
  cacheReadTokens: 800,
  actualModel: "claude-opus-4",
  actualCostUsd: 0.12,
});

function insertRun(opts: {
  runId: string;
  taskId: string;
  status?: string;
  goalGraph?: string | null;
  output?: string | null;
  trace?: string | null;
  tokenUsage?: string | null;
  durationMs?: number | null;
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO runs
       (run_id, task_id, agent_type, status, goal_graph, output, trace, token_usage, duration_ms, created_at)
     VALUES (@runId, @taskId, 'heavy', @status, @goalGraph, @output, @trace, @tokenUsage, @durationMs, @createdAt)`,
  ).run({
    runId: opts.runId,
    taskId: opts.taskId,
    status: opts.status ?? "failed",
    goalGraph: opts.goalGraph ?? null,
    output: opts.output ?? null,
    trace: opts.trace ?? null,
    tokenUsage: opts.tokenUsage ?? null,
    durationMs: opts.durationMs ?? null,
    createdAt: opts.createdAt ?? "2026-07-05 12:00:00",
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  // Mirror only the runs columns loadResumableRun reads (representative subset
  // of the live schema.sql runs table).
  db.exec(`
    CREATE TABLE runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT UNIQUE NOT NULL,
      task_id      TEXT NOT NULL,
      agent_type   TEXT NOT NULL,
      status       TEXT,
      goal_graph   TEXT,
      output       TEXT,
      trace        TEXT,
      token_usage  TEXT,
      duration_ms  INTEGER,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe("loadResumableRun — happy path", () => {
  it("round-trips a well-formed persisted run", () => {
    insertRun({
      runId: "run-1",
      taskId: "task-1",
      status: "failed",
      goalGraph: buildGraphJson(),
      output: OUTPUT_JSON,
      trace: TRACE_JSON,
      tokenUsage: TOKEN_USAGE_JSON,
      durationMs: 54321,
    });

    const loaded = loadResumableRun("task-1");
    expect(loaded).not.toBeNull();
    const { graph, priorResult } = loaded!;

    // Graph reconstructed with statuses preserved.
    expect(graph.size).toBe(3);
    expect(graph.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(graph.getGoal("g-2").status).toBe(GoalStatus.COMPLETED);
    expect(graph.getGoal("g-3").status).toBe(GoalStatus.FAILED);

    // priorResult.goalGraph is the exact input resumeFromGoal consumes.
    expect(Object.keys(priorResult.goalGraph.goals).sort()).toEqual([
      "g-1",
      "g-2",
      "g-3",
    ]);

    // Per-goal stubs: ok mirrors COMPLETED status.
    const gr = priorResult.executionResults.goalResults;
    expect(gr["g-1"].ok).toBe(true);
    expect(gr["g-2"].ok).toBe(true);
    expect(gr["g-3"].ok).toBe(false);
    expect(gr["g-1"].tokenUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });

    // executionResults.summary counts reflect the graph.
    expect(priorResult.executionResults.summary.completed).toBe(2);
    expect(priorResult.executionResults.summary.failed).toBe(1);

    // Reflection reconstructed from runs.output.
    expect(priorResult.reflection.summary).toBe("meta summary");
    expect(priorResult.reflection.score).toBe(0.42);
    expect(priorResult.reflection.learnings).toEqual([
      "learned x",
      "learned y",
    ]);
    expect(priorResult.reflection.success).toBe(false); // status='failed'

    // Trace, tokenUsage, duration, identity.
    expect(priorResult.trace).toHaveLength(2);
    expect(priorResult.tokenUsage.promptTokens).toBe(1000);
    expect(priorResult.tokenUsage.completionTokens).toBe(200);
    expect(priorResult.tokenUsage.cacheReadTokens).toBe(800);
    expect(priorResult.tokenUsage.actualModel).toBe("claude-opus-4");
    expect(priorResult.tokenUsage.actualCostUsd).toBe(0.12);
    expect(priorResult.durationMs).toBe(54321);
    expect(priorResult.traceId).toBe("run-1");
    expect(priorResult.success).toBe(false);
  });

  it("reflects a completed run's success flag", () => {
    insertRun({
      runId: "run-ok",
      taskId: "task-ok",
      status: "completed",
      goalGraph: buildGraphJson(),
      output: OUTPUT_JSON,
    });
    const loaded = loadResumableRun("task-ok");
    expect(loaded!.priorResult.success).toBe(true);
    expect(loaded!.priorResult.reflection.success).toBe(true);
  });

  it("selects the latest run for the task by created_at", () => {
    insertRun({
      runId: "run-old",
      taskId: "task-multi",
      goalGraph: buildGraphJson(),
      output: JSON.stringify({ content: "old" }),
      createdAt: "2026-07-05 10:00:00",
    });
    insertRun({
      runId: "run-new",
      taskId: "task-multi",
      goalGraph: buildGraphJson(),
      output: JSON.stringify({ content: "new" }),
      createdAt: "2026-07-05 11:00:00",
    });

    const loaded = loadResumableRun("task-multi");
    expect(loaded!.priorResult.traceId).toBe("run-new");
    expect(loaded!.priorResult.reflection.summary).toBe("new");
  });

  it("degrades to defaults when output/trace/token_usage are malformed", () => {
    insertRun({
      runId: "run-partial",
      taskId: "task-partial",
      goalGraph: buildGraphJson(),
      output: "not json{{",
      trace: "also not json",
      tokenUsage: "{broken",
    });

    const loaded = loadResumableRun("task-partial");
    expect(loaded).not.toBeNull();
    // goal_graph is intact so the run is still resumable; the non-critical
    // columns fall back to safe defaults instead of failing the load.
    expect(loaded!.priorResult.reflection.summary).toBe("");
    expect(loaded!.priorResult.reflection.score).toBe(0);
    expect(loaded!.priorResult.trace).toEqual([]);
    expect(loaded!.priorResult.tokenUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(loaded!.priorResult.durationMs).toBe(0);
  });
});

describe("loadResumableRun — null / not-resumable cases", () => {
  it("returns null when no runs row exists for the task", () => {
    expect(loadResumableRun("does-not-exist")).toBeNull();
  });

  it("returns null when the latest run has a NULL goal_graph", () => {
    insertRun({
      runId: "run-nograph",
      taskId: "task-nograph",
      goalGraph: null,
      output: OUTPUT_JSON,
    });
    expect(loadResumableRun("task-nograph")).toBeNull();
  });

  it("returns null when goal_graph is malformed JSON", () => {
    insertRun({
      runId: "run-badjson",
      taskId: "task-badjson",
      goalGraph: "{ this is not : valid json ]",
    });
    expect(loadResumableRun("task-badjson")).toBeNull();
  });

  it("returns null when goal_graph JSON has the wrong shape (no goals)", () => {
    insertRun({
      runId: "run-badshape",
      taskId: "task-badshape",
      goalGraph: JSON.stringify({ notGoals: [] }),
    });
    expect(loadResumableRun("task-badshape")).toBeNull();
  });

  it("returns null when goal_graph is a JSON array (wrong shape)", () => {
    insertRun({
      runId: "run-array",
      taskId: "task-array",
      goalGraph: JSON.stringify([1, 2, 3]),
    });
    expect(loadResumableRun("task-array")).toBeNull();
  });
});
