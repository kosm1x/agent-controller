/**
 * Tests for ReactionManager.
 *
 * The database is the real schema (initDatabase(":memory:")): the watchdog
 * and progress statements run against the real tasks/runs CHECK, NOT NULL
 * and FK constraints, so a run row needs its task row first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "../db/index.js";
import { ReactionManager } from "./manager.js";
import { getReactionsBySourceTask } from "./store.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track event subscriptions so we can trigger them in tests
let capturedHandlers: Map<string, (event: any) => void>;

// Risk tier: gmail_send is the one high-risk tool in these fixtures.
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    getEffectiveRiskTier: (name: string) =>
      name === "gmail_send" ? "high" : "low",
  },
}));

const mockEmitEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    subscribe: vi.fn((pattern: string, handler: (event: any) => void) => {
      capturedHandlers.set(pattern, handler);
      return {
        id: "sub-1",
        pattern,
        unsubscribe: vi.fn(),
      };
    }),
    emitEvent: mockEmitEvent,
  }),
}));

const mockSubmitTask = vi.fn().mockResolvedValue({
  taskId: "spawned-1",
  agentType: "fast",
  classification: { score: 1, reason: "auto", explicit: false },
});

// Mock the reflector-gap reader so we can inject the goal snapshot per test.
// Default: no reflector data → preserves legacy retry behavior. Override per
// test via mockGoalSnapshot.mockReturnValueOnce(...).
const mockGoalSnapshot = vi.fn();
vi.mock("../db/reflector-gap.js", () => ({
  getLatestGoalSnapshot: (...args: unknown[]) => mockGoalSnapshot(...args),
}));

vi.mock("../dispatch/dispatcher.js", () => ({
  getTask: vi.fn((taskId: string) => {
    if (taskId === "task-jarvis-pull") {
      return {
        task_id: "task-jarvis-pull",
        spawn_type: "root",
        title: "CRM jarvis-pull: q",
        description: "persona",
        priority: "medium",
        status: "failed",
        error: "Request timeout after 30s",
        classification: null,
        agent_type: "fast",
        metadata: JSON.stringify({ tags: ["jarvis-pull", "crm"] }),
      };
    }
    if (taskId === "task-subtask") {
      return {
        task_id: "task-subtask",
        spawn_type: "subtask",
        title: "Sub task",
        description: "Child of swarm",
        priority: "medium",
        status: "failed",
        error: "Failed",
        classification: null,
        agent_type: null,
        metadata: null,
      };
    }
    // Skill-evolution-style ritual task: explicit agentType=heavy, curated
    // tools list, ritualId tag. Used to verify retry forwarding (queue P3).
    if (taskId === "task-ritual") {
      return {
        task_id: "task-ritual",
        spawn_type: "root",
        title: "Skill evolution — 2026-05-24",
        description: "Ritual description",
        priority: "medium",
        status: "failed",
        error: "Planning failed: LLM plan response missing 'goals' array",
        classification: JSON.stringify({
          agentType: "heavy",
          score: -1,
          explicit: true,
        }),
        agent_type: "heavy",
        metadata: JSON.stringify({
          tools: [
            "evolution_get_data",
            "evolution_deactivate_skill",
            "memory_store",
          ],
          ritualId: "skill-evolution",
        }),
      };
    }
    // Dynamic scheduled task: persisted tags only (no ritualId).
    if (taskId === "task-scheduled") {
      return {
        task_id: "task-scheduled",
        spawn_type: "root",
        title: "[Scheduled] Reporte — 2026-09-29",
        description: "Schedule description",
        priority: "medium",
        status: "failed",
        error: "Unknown error",
        classification: JSON.stringify({ agentType: "fast" }),
        agent_type: "fast",
        metadata: JSON.stringify({
          tags: ["scheduled", "schedule:abc"],
          tools: ["web_search", "gmail_send"],
        }),
      };
    }
    return {
      task_id: taskId,
      spawn_type: "root",
      title: "Test task",
      description: "Do something",
      priority: "medium",
      status: "failed",
      error: "Something went wrong",
      classification: JSON.stringify({ agentType: "fast" }),
      agent_type: "fast",
      metadata: null,
    };
  }),
  submitTask: (...args: unknown[]) => mockSubmitTask(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReactionManager", () => {
  let db: Database.Database;
  let manager: ReactionManager;

  beforeEach(() => {
    capturedHandlers = new Map();
    db = initDatabase(":memory:");

    mockSubmitTask.mockClear();
    mockEmitEvent.mockClear();
    mockGoalSnapshot.mockReset();
    mockGoalSnapshot.mockReturnValue(null); // default: no reflector data
    manager = new ReactionManager(db);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    closeDatabase();
  });

  async function triggerTaskFailed(
    taskId: string,
    error: string,
  ): Promise<void> {
    const handler = capturedHandlers.get("task.failed");
    expect(handler).toBeDefined();
    await handler!({
      id: "evt-1",
      type: "task.failed",
      category: "task",
      timestamp: new Date().toISOString(),
      workspace_id: "default",
      correlation_id: "corr-1",
      data: { task_id: taskId, error },
    });
  }

  it("retries on transient error (timeout)", async () => {
    await triggerTaskFailed("task-1", "Request timeout after 30s");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.title).toBe("Test task");
    expect(call.description).toBe("Do something"); // Identical retry

    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe("retry");
    expect(reactions[0].spawned_task_id).toBe("spawned-1");
  });

  it("performs adjusted retry on first non-transient error", async () => {
    await triggerTaskFailed("task-1", "Tool xyz not found");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.description).toContain("[Auto-retry]");
    expect(call.description).toContain("Tool xyz not found");
    expect(call.description).toContain("Do something"); // Original description

    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe("retry_adjusted");
  });

  // S3 deterministic-retry-gate: when the reflector recorded goals_failed=0
  // AND goals_total>0 for a real heavy run, adjusted_retry must NOT fire —
  // the failure is score-only (criteriaMet=false discount) and retrying
  // burns tokens on a deterministic same-prompt rerun. Live source of this
  // test: 2026-05-27 23:00 MX skill-evolution burn loop (tasks 9ea36c4f +
  // e4a60c0f, both 4/4 goals completed, 0 failed, score 0.72, retried).
  it("does NOT retry when reflector snapshot is {goalsTotal>0, goalsFailed=0} (score-only failure)", async () => {
    mockGoalSnapshot.mockReturnValue({ goalsTotal: 4, goalsFailed: 0 });
    await triggerTaskFailed("task-1", "criteriaMet=false on g-4");

    expect(mockSubmitTask).not.toHaveBeenCalled();
    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions).toHaveLength(0);
  });

  it("DOES retry when reflector snapshot is {goalsTotal>0, goalsFailed>0} (real goal failure)", async () => {
    mockGoalSnapshot.mockReturnValue({ goalsTotal: 4, goalsFailed: 2 });
    await triggerTaskFailed("task-1", "Tool xyz not found");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions[0].action).toBe("retry_adjusted");
  });

  it("escalates after 2 previous attempts", async () => {
    // Construct a 2-step retry chain ending at task-1:
    //   root-A → retry → intermediate-B → retry → task-1 (current failure)
    // countReactionChainLength walks backward via spawned_task_id links,
    // so the chain must be modeled with real parent→child edges.
    db.prepare(
      `INSERT INTO reactions (reaction_id, trigger_type, source_task_id, spawned_task_id, action, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-5 minutes'))`,
    ).run("r1", "task_failed", "root-A", "intermediate-B", "retry", 1);
    db.prepare(
      `INSERT INTO reactions (reaction_id, trigger_type, source_task_id, spawned_task_id, action, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 minutes'))`,
    ).run("r2", "task_failed", "intermediate-B", "task-1", "retry_adjusted", 2);

    await triggerTaskFailed("task-1", "Still broken");

    expect(mockSubmitTask).not.toHaveBeenCalled(); // No retry
    // The escalate reaction is recorded against source_task_id=task-1
    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe("escalate");
    const note = mockEmitEvent.mock.calls.find(
      (c) => c[0] === "notification.warning",
    )?.[1];
    expect(note.message).toBe('Task "Test task" failed after 2 retries: Still broken');
    expect(note.context).toEqual({ taskId: "task-1", error: "Still broken" });
  });

  it("suppresses when 3+ classification failures in 24h", async () => {
    // Insert 3 failures with same classification
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO task_outcomes (task_id, classified_as, ran_on, tools_used, duration_ms, success, tags) VALUES (?, ?, ?, '[]', 100, 0, '[]')`,
      ).run(`t-fail-${i}`, "fast", "fast");
    }

    await triggerTaskFailed("task-1", "Something failed");

    expect(mockSubmitTask).not.toHaveBeenCalled();
    const reactions = getReactionsBySourceTask(db, "task-1");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe("suppress");
    expect(reactions[0].status).toBe("suppressed");
  });

  it("retry forwards agent_type + tools + ritualId from the failed ritual task (P3 cascade fix)", async () => {
    // task-ritual is the failed Skill-evolution-style mock with explicit
    // agentType=heavy, curated tools, ritualId. Before this fix the retry
    // submission dropped these and the classifier re-routed to nanoclaw
    // (which can't handle the workload). Verify all three are forwarded.
    await triggerTaskFailed("task-ritual", "Request timeout after 30s");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.agentType).toBe("heavy");
    expect(call.tools).toEqual([
      "evolution_get_data",
      "evolution_deactivate_skill",
      "memory_store",
    ]);
    expect(call.ritualId).toBe("skill-evolution");
    // DENUE guard detects on the title, never the log-bearing description.
    expect(call.detectionText).toBe("Skill evolution — 2026-05-24");
  });

  it("retry_adjusted forwards agent_type + tools + ritualId from the failed ritual task", async () => {
    await triggerTaskFailed("task-ritual", "Tool xyz not found");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.description).toContain("[Auto-retry]");
    expect(call.detectionText).toBe("Skill evolution — 2026-05-24");
    expect(call.agentType).toBe("heavy");
    expect(call.tools).toEqual([
      "evolution_get_data",
      "evolution_deactivate_skill",
      "memory_store",
    ]);
    expect(call.ritualId).toBe("skill-evolution");
  });

  it("retry of a non-ritual task with null metadata still forwards agent_type (no crash on missing tools/ritualId)", async () => {
    // task-1 mock has metadata=null. Forwarding logic must default safely.
    await triggerTaskFailed("task-1", "Request timeout after 30s");

    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.agentType).toBe("fast");
    expect(call.tools).toBeUndefined();
    expect(call.ritualId).toBeUndefined();
    expect(call.detectionText).toBeUndefined();
    expect(call.tags).toBeUndefined();
    expect(call.interactive).toBeUndefined();
  });

  it("retry of a ritual task stays non-interactive (ritualId in metadata)", async () => {
    await triggerTaskFailed("task-ritual", "Request timeout after 30s");
    expect(mockSubmitTask.mock.calls[0][0].interactive).toBe(false);
  });

  it("retry of a scheduled task stays non-interactive ('scheduled' tag)", async () => {
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask.mock.calls[0][0].interactive).toBe(false);
  });

  // A non-interactive retry skips the confirm gate, so a send the failed
  // attempt already made would go out twice (round-2 audit W2, 2026-09-29).
  // getTask is mocked, but the runs FK still needs the task row.
  const recordRun = (taskId: string, toolCalls: string[] | null) => {
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, status) VALUES (?, 't', 'd', 'failed')",
    ).run(taskId);
    db.prepare(
      "INSERT INTO runs (run_id, task_id, agent_type, input, status, tool_calls) VALUES (?, ?, 'fast', 'in', 'failed', ?)",
    ).run(`run-${taskId}`, taskId, toolCalls ? JSON.stringify(toolCalls) : null);
  };

  it("scheduled task whose attempt called a high-risk tool escalates instead of retrying", async () => {
    recordRun("task-scheduled", ["web_search", "gmail_send"]);
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    const reactions = getReactionsBySourceTask(db, "task-scheduled");
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe("escalate");
    expect(JSON.parse(reactions[0].metadata).reason).toBe(
      "attempt already called gmail_send — not retrying an irreversible action",
    );
    // The operator is told the tool already ran (a manual re-run duplicates it).
    const note = mockEmitEvent.mock.calls.find(
      (c) => c[0] === "notification.warning",
    )?.[1];
    expect(note.message).toContain("attempt already called gmail_send");
    expect(note.context.reason).toContain("gmail_send");
  });

  it("the newest run of the task decides: an earlier low-risk run does not hide the latest attempt's send", async () => {
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, status) VALUES ('task-scheduled', 't', 'd', 'failed')",
    ).run();
    const run = db.prepare(
      "INSERT INTO runs (run_id, task_id, agent_type, input, status, tool_calls, created_at) VALUES (?, 'task-scheduled', 'fast', 'in', 'failed', ?, ?)",
    );
    // Inserted newest first, so insertion order cannot stand in for created_at.
    run.run("run-new", JSON.stringify(["gmail_send"]), "2026-01-01 00:00:05");
    run.run("run-old", JSON.stringify(["web_search"]), "2026-01-01 00:00:00");
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-scheduled")[0].action).toBe("escalate");
  });

  it("a recorded mcp__jarvis__ name is normalized before the tier lookup", async () => {
    recordRun("task-scheduled", ["mcp__jarvis__gmail_send"]);
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-scheduled")[0].action).toBe("escalate");
  });

  it("a ritualId-only task (no 'scheduled' tag) that already sent escalates", async () => {
    recordRun("task-ritual", ["gmail_send"]);
    await triggerTaskFailed("task-ritual", "Request timeout after 30s");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-ritual")[0].action).toBe("escalate");
  });

  it("retry_adjusted of a scheduled task that already sent also escalates", async () => {
    recordRun("task-scheduled", ["gmail_send"]);
    await triggerTaskFailed("task-scheduled", "Tool xyz not found");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-scheduled")[0].action).toBe("escalate");
  });

  it("a tool.called trace row counts when the run's tool_calls is still NULL (watchdog kill)", async () => {
    recordRun("task-scheduled", null);
    db.prepare(
      "INSERT INTO task_trace_events (task_id, name, tool) VALUES ('task-scheduled', 'tool.called', 'gmail_send')",
    ).run();
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-scheduled")[0].action).toBe("escalate");
  });

  it("scheduled task with only low-risk calls still retries non-interactive", async () => {
    recordRun("task-scheduled", ["web_search", "web_read"]);
    await triggerTaskFailed("task-scheduled", "Request timeout after 30s");
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    expect(mockSubmitTask.mock.calls[0][0].interactive).toBe(false);
  });

  it("interactive task with a high-risk call retries unchanged (confirm gate still applies)", async () => {
    recordRun("task-1", ["gmail_send"]);
    await triggerTaskFailed("task-1", "Request timeout after 30s");
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    expect(mockSubmitTask.mock.calls[0][0].interactive).toBeUndefined();
  });

  it("retry_adjusted of a scheduled task stays non-interactive ('scheduled' tag)", async () => {
    // 2026-09-29: the Pharma schedule's retry_adjusted ran as interactive and
    // got the chat-only DENUE advisory.
    await triggerTaskFailed("task-scheduled", "Tool xyz not found");
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.description).toContain("[Auto-retry]");
    expect(call.interactive).toBe(false);
  });

  it("skips subtask failures (managed by swarm runner)", async () => {
    await triggerTaskFailed("task-subtask", "Sub task failed");

    expect(mockSubmitTask).not.toHaveBeenCalled();
    const reactions = getReactionsBySourceTask(db, "task-subtask");
    expect(reactions).toHaveLength(0);
  });

  it("skips a failed jarvis-pull task: the route already answered via its fallback", async () => {
    await triggerTaskFailed("task-jarvis-pull", "Request timeout after 30s");

    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(mockEmitEvent).not.toHaveBeenCalled();
    expect(getReactionsBySourceTask(db, "task-jarvis-pull")).toHaveLength(0);
  });

  // reactions.created_at is SQLite datetime('now') text: UTC with no zone
  // marker. The 30 s cooldown must read it as UTC whatever the process time
  // zone, so each case runs in a zone west of UTC and one east of it.
  describe.each(["America/Mexico_City", "Asia/Tokyo"])(
    "cooldown in process time zone %s",
    (zone) => {
      let prevTz: string | undefined;
      beforeEach(() => {
        prevTz = process.env.TZ;
        process.env.TZ = zone;
      });
      afterEach(() => {
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
      });

      it("respects cooldown (no rapid-fire reactions)", async () => {
        // First reaction goes through
        await triggerTaskFailed("task-1", "ECONNRESET");
        expect(mockSubmitTask).toHaveBeenCalledTimes(1);

        // Second reaction within cooldown should be skipped
        await triggerTaskFailed("task-1", "ECONNRESET again");
        expect(mockSubmitTask).toHaveBeenCalledTimes(1); // Still 1
      });

      it("reacts again once the 30 s window since the last reaction has passed", async () => {
        await triggerTaskFailed("task-1", "ECONNRESET");
        expect(mockSubmitTask).toHaveBeenCalledTimes(1);
        db.prepare(
          "UPDATE reactions SET created_at = datetime('now', '-60 seconds') WHERE source_task_id = ?",
        ).run("task-1");

        await triggerTaskFailed("task-1", "ECONNRESET again");
        expect(mockSubmitTask).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("checkStuckTasks cascades ONLY the stuck task's run to failed (scoped, not blanket)", () => {
    // Stuck task: started 20 min ago and never reported progress since
    // (updated_at = started_at > 15 min threshold), still running.
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, started_at, updated_at) VALUES (?, 'd', 'running', ?, datetime('now','-20 minutes'), datetime('now','-20 minutes'))`,
    ).run("stuck-1", "Stuck one");
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, status) VALUES ('run-stuck', 'stuck-1', 'fast', 'in', 'running')`,
    ).run();
    // A different, healthy task whose run is live — must be left alone. A
    // blanket `WHERE status='running'` cascade would wrongly fail this too.
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, started_at) VALUES (?, 'd', 'running', ?, datetime('now'))`,
    ).run("live-1", "Live one");
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, status) VALUES ('run-live', 'live-1', 'fast', 'in', 'running')`,
    ).run();

    // Invoke the private poll handler directly.
    (manager as unknown as { checkStuckTasks(): void }).checkStuckTasks();

    const stuckRun = db
      .prepare("SELECT status, completed_at FROM runs WHERE run_id='run-stuck'")
      .get() as { status: string; completed_at: string | null };
    const liveRun = db
      .prepare("SELECT status FROM runs WHERE run_id='run-live'")
      .get() as { status: string };

    expect(stuckRun.status).toBe("failed");
    expect(stuckRun.completed_at).not.toBeNull();
    expect(liveRun.status).toBe("running"); // scoped — untouched
    // The task row itself flips to failed with the watchdog's reason, and the
    // kill leaves its own terminal row in the task trace.
    expect(
      db
        .prepare(
          "SELECT status, error, completed_at IS NOT NULL AS done FROM tasks WHERE task_id='stuck-1'",
        )
        .get(),
    ).toEqual({
      status: "failed",
      error: "Stuck task detected (no progress for 15 minutes)",
      done: 1,
    });
    expect(
      db
        .prepare("SELECT task_id, name FROM task_trace_events ORDER BY id")
        .all(),
    ).toEqual([{ task_id: "stuck-1", name: "task.watchdog_failed" }]);
  });

  it('a /loop task (tag "loop" in metadata) is NEVER marked stuck — operator-instructed unbounded run', () => {
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, started_at, updated_at, metadata) VALUES (?, 'd', 'running', ?, datetime('now','-3 hours'), datetime('now','-3 hours'), ?)`,
    ).run(
      "loop-1",
      "Loop one",
      JSON.stringify({ tags: ["messaging", "telegram", "loop"] }),
    );
    db.prepare(
      `INSERT INTO runs (run_id, task_id, agent_type, input, status) VALUES ('run-loop', 'loop-1', 'fast', 'in', 'running')`,
    ).run();

    (manager as unknown as { checkStuckTasks(): void }).checkStuckTasks();

    const task = db
      .prepare("SELECT status FROM tasks WHERE task_id='loop-1'")
      .get() as { status: string };
    const run = db
      .prepare("SELECT status FROM runs WHERE run_id='run-loop'")
      .get() as { status: string };
    expect(task.status).toBe("running");
    expect(run.status).toBe("running");
  });

  it("a long-running task that keeps reporting progress is NOT stuck — liveness is updated_at, not started_at (2026-09-03 swarm roots 9036/9043)", () => {
    // Swarm root: started 25 min ago, last progress report 1 min ago.
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, started_at, updated_at) VALUES (?, 'd', 'running', ?, datetime('now','-25 minutes'), datetime('now','-1 minute'))`,
    ).run("live-long", "Swarm root");
    // Same age, but silent for 16 min — that one IS stuck.
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, started_at, updated_at) VALUES (?, 'd', 'running', ?, datetime('now','-25 minutes'), datetime('now','-16 minutes'))`,
    ).run("silent-long", "Silent");

    (manager as unknown as { checkStuckTasks(): void }).checkStuckTasks();

    const status = (id: string) =>
      (
        db.prepare("SELECT status FROM tasks WHERE task_id=?").get(id) as {
          status: string;
        }
      ).status;
    expect(status("live-long")).toBe("running");
    expect(status("silent-long")).toBe("failed");
  });

  it("task.progress persists progress and refreshes the liveness stamp — only while running", () => {
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, progress, started_at, updated_at) VALUES (?, 'd', 'running', ?, 0, datetime('now','-20 minutes'), datetime('now','-20 minutes'))`,
    ).run("prog-1", "Running");
    db.prepare(
      `INSERT INTO tasks (task_id, description, status, title, progress, started_at, updated_at, completed_at) VALUES (?, 'd', 'completed', ?, 100, datetime('now','-20 minutes'), datetime('now','-20 minutes'), datetime('now','-20 minutes'))`,
    ).run("done-1", "Done");

    const handler = capturedHandlers.get("task.progress");
    expect(handler).toBeDefined();
    const emit = (task_id: string, progress: number) =>
      handler!({
        id: "evt-p",
        type: "task.progress",
        data: {
          task_id,
          agent_id: "swarm",
          progress,
          phase: "execute",
          message: "x",
        },
      });
    const row = (id: string) =>
      db
        .prepare(
          "SELECT progress, (updated_at > datetime('now','-1 minute')) AS fresh FROM tasks WHERE task_id=?",
        )
        .get(id) as { progress: number; fresh: number };

    emit("prog-1", 42.6); // rounded — the column is INTEGER
    expect(row("prog-1")).toEqual({ progress: 43, fresh: 1 });
    emit("prog-1", -5); // clamped low
    expect(row("prog-1").progress).toBe(0);
    emit("prog-1", 250); // clamped high, never violates the 0..100 CHECK
    expect(row("prog-1").progress).toBe(100);
    // A heartbeat without a percentage (container sentinel) refreshes
    // liveness and keeps the last progress.
    db.prepare(
      "UPDATE tasks SET updated_at = datetime('now','-20 minutes') WHERE task_id='prog-1'",
    ).run();
    emit("prog-1", Number.NaN);
    expect(row("prog-1")).toEqual({ progress: 100, fresh: 1 });
    // Terminal row untouched by a late event.
    emit("done-1", 5);
    expect(row("done-1")).toEqual({ progress: 100, fresh: 0 });

    // The refreshed task is no longer a watchdog candidate.
    (manager as unknown as { checkStuckTasks(): void }).checkStuckTasks();
    expect(
      (
        db.prepare("SELECT status FROM tasks WHERE task_id='prog-1'").get() as {
          status: string;
        }
      ).status,
    ).toBe("running");
  });
});
