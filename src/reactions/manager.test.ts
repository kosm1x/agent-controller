/**
 * Tests for ReactionManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { ReactionManager } from "./manager.js";
import { getReactionsBySourceTask } from "./store.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track event subscriptions so we can trigger them in tests
let capturedHandlers: Map<string, (event: any) => void>;

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
    emitEvent: vi.fn(),
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
    db = new Database(":memory:");
    // Create dependent tables BEFORE ensureReactionsTable (it adds indexes on these)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        task_id TEXT UNIQUE,
        parent_task_id TEXT,
        spawn_type TEXT DEFAULT 'root',
        title TEXT,
        description TEXT,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'queued',
        agent_type TEXT,
        classification TEXT,
        assigned_to TEXT,
        input TEXT,
        output TEXT,
        error TEXT,
        progress INTEGER DEFAULT 0,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY,
        task_id TEXT,
        classified_as TEXT,
        ran_on TEXT,
        tools_used TEXT,
        duration_ms INTEGER,
        success INTEGER,
        feedback_signal TEXT DEFAULT 'neutral',
        tags TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    mockSubmitTask.mockClear();
    mockGoalSnapshot.mockReset();
    mockGoalSnapshot.mockReturnValue(null); // default: no reflector data
    manager = new ReactionManager(db);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
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
  });

  it("retry_adjusted forwards agent_type + tools + ritualId from the failed ritual task", async () => {
    await triggerTaskFailed("task-ritual", "Tool xyz not found");

    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const call = mockSubmitTask.mock.calls[0][0];
    expect(call.description).toContain("[Auto-retry]");
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
    expect(call.tags).toBeUndefined();
  });

  it("skips subtask failures (managed by swarm runner)", async () => {
    await triggerTaskFailed("task-subtask", "Sub task failed");

    expect(mockSubmitTask).not.toHaveBeenCalled();
    const reactions = getReactionsBySourceTask(db, "task-subtask");
    expect(reactions).toHaveLength(0);
  });

  it("respects cooldown (no rapid-fire reactions)", async () => {
    // First reaction goes through
    await triggerTaskFailed("task-1", "ECONNRESET");
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);

    // Second reaction within cooldown should be skipped
    await triggerTaskFailed("task-1", "ECONNRESET again");
    expect(mockSubmitTask).toHaveBeenCalledTimes(1); // Still 1
  });
});
