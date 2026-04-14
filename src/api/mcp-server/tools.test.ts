/**
 * Tests for the jarvis_* MCP tool handlers.
 *
 * Uses an in-memory SQLite DB + mocked MemoryService so we don't touch
 * real state. Exercises each tool through a minimal McpServer-like
 * shim that captures registered handlers.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { registerJarvisTools } from "./tools.js";
import type { McpDeps } from "./types.js";
import type { MemoryItem, RecallOptions } from "../../memory/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

// Minimal shim matching the McpServer.registerTool() signature we use.
class ToolRegistry {
  handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _config: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

let db: Database.Database;
let registry: ToolRegistry;
let deps: McpDeps;
let recallResult: MemoryItem[];
let memoryHealthy: boolean;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      spawn_type TEXT DEFAULT 'root',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL,
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
    );
    CREATE TABLE scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      delivery TEXT DEFAULT 'telegram',
      email_to TEXT,
      active INTEGER DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      data TEXT NOT NULL,
      correlation_id TEXT NOT NULL DEFAULT '',
      causation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE reflector_gap_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      llm_score REAL NOT NULL,
      heuristic_score REAL NOT NULL,
      abs_diff REAL NOT NULL,
      llm_available INTEGER NOT NULL,
      goals_total INTEGER NOT NULL,
      goals_completed INTEGER NOT NULL,
      goals_failed INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed tasks
  db.prepare(
    "INSERT INTO tasks (task_id, title, description, status, agent_type, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).run("t-1", "First task", "desc", "completed", "fast");
  db.prepare(
    "INSERT INTO tasks (task_id, title, description, status, agent_type, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).run("t-2", "Failed task", "desc", "failed", "fast");
  db.prepare(
    "INSERT INTO tasks (task_id, title, description, status, agent_type, parent_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run("t-3", "Child of t-1", "desc", "completed", "fast", "t-1");

  // Seed schedule
  db.prepare(
    "INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, delivery, active) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("s-1", "Morning brief", "daily", "0 9 * * *", "telegram", 1);

  // Seed gap log — 10 rows, one with wide gap
  const insertGap = db.prepare(
    "INSERT INTO reflector_gap_log (task_id, llm_score, heuristic_score, abs_diff, llm_available, goals_total, goals_completed, goals_failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 9; i++) {
    insertGap.run(`g-${i}`, 0.8, 0.8, 0.0, 1, 5, 5, 0);
  }
  insertGap.run("g-wide", 0.5, 0.9, 0.4, 1, 10, 5, 5);

  // Seed events — one recent error
  db.prepare(
    "INSERT INTO events (id, type, category, timestamp, workspace_id, data) VALUES (?, ?, ?, datetime('now'), 'default', ?)",
  ).run("e-1", "task.failed", "task", JSON.stringify({ taskId: "t-2" }));

  recallResult = [];
  memoryHealthy = true;

  const memory: McpDeps["memory"] = {
    retain: vi.fn(async () => {}),
    recall: vi.fn(async (_q: string, _opts: RecallOptions) => recallResult),
    reflect: vi.fn(async () => ""),
    isHealthy: vi.fn(async () => memoryHealthy),
    backend: "sqlite",
  };

  deps = {
    db,
    memory,
    startedAt: Date.now() - 5000,
  };

  registry = new ToolRegistry();
  registerJarvisTools(
    registry as unknown as Parameters<typeof registerJarvisTools>[0],
    deps,
  );
});

function parseResult(r: { content: Array<{ type: "text"; text: string }> }): {
  ok: boolean;
  data?: unknown;
  error?: string;
} {
  return JSON.parse(r.content[0].text);
}

describe("registerJarvisTools", () => {
  it("registers all 8 jarvis_* tools", () => {
    const names = Array.from(registry.handlers.keys()).sort();
    expect(names).toEqual([
      "jarvis_feedback_search",
      "jarvis_memory_query",
      "jarvis_recent_events",
      "jarvis_reflector_gap_stats",
      "jarvis_schedule_list",
      "jarvis_status",
      "jarvis_task_detail",
      "jarvis_task_list",
    ]);
  });

  it("jarvis_status returns pid, uptime, task counts", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_status")!({}),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      pid: number;
      uptimeSec: number;
      totalTasks: number;
      tasksByStatus: Record<string, number>;
      memoryHealthy: boolean;
    };
    expect(data.pid).toBe(process.pid);
    expect(data.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(data.totalTasks).toBe(3);
    expect(data.tasksByStatus.completed).toBe(2);
    expect(data.tasksByStatus.failed).toBe(1);
    expect(data.memoryHealthy).toBe(true);
  });

  it("jarvis_task_list returns all tasks without filters", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_task_list")!({}),
    );
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; tasks: unknown[] };
    expect(data.count).toBe(3);
  });

  it("jarvis_task_list filters by status", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_task_list")!({ status: "failed" }),
    );
    const data = result.data as {
      count: number;
      tasks: Array<{ task_id: string; status: string }>;
    };
    expect(data.count).toBe(1);
    expect(data.tasks[0].task_id).toBe("t-2");
    expect(data.tasks[0].status).toBe("failed");
  });

  it("jarvis_task_detail returns task + subtasks for known id", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_task_detail")!({ task_id: "t-1" }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      task: { task_id: string; title: string };
      subtasks: Array<{ task_id: string }>;
    };
    expect(data.task.task_id).toBe("t-1");
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0].task_id).toBe("t-3");
  });

  it("jarvis_task_detail returns error for unknown id", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_task_detail")!({
        task_id: "nonexistent",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/task not found/);
  });

  it("jarvis_memory_query delegates to memory.recall", async () => {
    recallResult = [
      { content: "autoreason k=2 lesson", relevance: 0.95, trustTier: 2 },
    ];
    const result = parseResult(
      await registry.handlers.get("jarvis_memory_query")!({
        query: "autoreason",
      }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; items: MemoryItem[] };
    expect(data.count).toBe(1);
    expect(data.items[0].content).toContain("autoreason");
    expect(deps.memory.recall).toHaveBeenCalledWith("autoreason", {
      bank: "mc-operational",
      tags: undefined,
      maxResults: 10,
    });
  });

  it("jarvis_schedule_list returns active schedules by default", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_schedule_list")!({}),
    );
    const data = result.data as {
      count: number;
      schedules: Array<{ schedule_id: string; active: number }>;
    };
    expect(data.count).toBe(1);
    expect(data.schedules[0].schedule_id).toBe("s-1");
  });

  it("jarvis_recent_events returns recent events", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_recent_events")!({}),
    );
    const data = result.data as { count: number; events: unknown[] };
    expect(data.count).toBe(1);
  });

  it("jarvis_recent_events filters by category", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_recent_events")!({
        category: "task",
      }),
    );
    const data = result.data as { count: number };
    expect(data.count).toBe(1);
  });

  it("jarvis_reflector_gap_stats aggregates gap telemetry", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_reflector_gap_stats")!({}),
    );
    const data = result.data as {
      n: number;
      avgGap: number;
      maxGap: number;
      wideGapCount: number;
      wideGapPct: number;
      decisionHint: string;
    };
    expect(data.n).toBe(10);
    expect(data.maxGap).toBe(0.4);
    expect(data.wideGapCount).toBe(1);
    expect(data.wideGapPct).toBe(10);
    expect(data.decisionHint).toMatch(/skip|targeted|close|tournament/);
  });

  it("jarvis_feedback_search runs without crashing (real memory dir)", async () => {
    const result = parseResult(
      await registry.handlers.get("jarvis_feedback_search")!({
        query: "autoreason",
        limit: 3,
      }),
    );
    expect(result.ok).toBe(true);
    // Real memory dir is present on this host — don't assert count, just shape.
    const data = result.data as { count: number; matches: unknown[] };
    expect(Array.isArray(data.matches)).toBe(true);
  });

  // v7.7.1 C2 regression — parameterized hours bind. The previous
  // `-${hours} hours` interpolation was a latent SQLi trap. Verify that
  // the query shape still works end-to-end across the whole Zod range.
  it("jarvis_recent_events respects hours parameter across full range", async () => {
    // 1-hour window: the seeded event is from datetime('now'), should match
    const r1 = parseResult(
      await registry.handlers.get("jarvis_recent_events")!({ hours: 1 }),
    );
    expect(r1.ok).toBe(true);
    expect((r1.data as { count: number }).count).toBe(1);

    // 168-hour window (max per Zod): should also match the single event
    const r168 = parseResult(
      await registry.handlers.get("jarvis_recent_events")!({ hours: 168 }),
    );
    expect(r168.ok).toBe(true);
    expect((r168.data as { count: number }).count).toBe(1);
  });

  it("jarvis_reflector_gap_stats respects days parameter across full range", async () => {
    // 1-day window: seeded rows are from now, should match
    const r1 = parseResult(
      await registry.handlers.get("jarvis_reflector_gap_stats")!({ days: 1 }),
    );
    expect(r1.ok).toBe(true);
    expect((r1.data as { n: number }).n).toBe(10);

    // 30-day window (max per Zod)
    const r30 = parseResult(
      await registry.handlers.get("jarvis_reflector_gap_stats")!({ days: 30 }),
    );
    expect(r30.ok).toBe(true);
    expect((r30.data as { n: number }).n).toBe(10);
  });

  // v7.7.1 M3 regression — secret redaction in jarvis_task_detail.
  // Operators pasting API keys into task descriptions or tool output
  // must not leak credentials via the MCP read-only surface.
  describe("jarvis_task_detail secret redaction (M3)", () => {
    it("redacts Bearer tokens in description", async () => {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(
        "t-secret-1",
        "test",
        "curl -H 'Authorization: Bearer sk-abcdefghijklmnop1234567890ABCDEF' ...",
        "completed",
      );
      const result = parseResult(
        await registry.handlers.get("jarvis_task_detail")!({
          task_id: "t-secret-1",
        }),
      );
      expect(result.ok).toBe(true);
      const task = (result.data as { task: { description: string } }).task;
      expect(task.description).not.toContain(
        "sk-abcdefghijklmnop1234567890ABCDEF",
      );
      expect(task.description).toContain("[REDACTED");
    });

    it("redacts jrvs_ bearer tokens in output", async () => {
      const realToken = "jrvs_" + "a".repeat(64);
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, output, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        "t-secret-2",
        "test",
        "desc",
        "completed",
        JSON.stringify({ token: realToken }),
      );
      const result = parseResult(
        await registry.handlers.get("jarvis_task_detail")!({
          task_id: "t-secret-2",
        }),
      );
      const task = (result.data as { task: { output: string } }).task;
      expect(task.output).not.toContain(realToken);
    });

    it("redacts JSON fields named 'api_key'/'password'/'access_token'", async () => {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        "t-secret-3",
        "test",
        "d",
        "completed",
        JSON.stringify({
          api_key: "abc123xyz",
          password: "hunter2",
          access_token: "ya29.a0Afh6",
          harmless: "keep me",
        }),
      );
      const result = parseResult(
        await registry.handlers.get("jarvis_task_detail")!({
          task_id: "t-secret-3",
        }),
      );
      const task = (result.data as { task: { metadata: string } }).task;
      expect(task.metadata).not.toContain("abc123xyz");
      expect(task.metadata).not.toContain("hunter2");
      expect(task.metadata).not.toContain("ya29.a0Afh6");
      expect(task.metadata).toContain("keep me"); // non-secret preserved
      expect(task.metadata).toContain("[REDACTED]");
    });

    it("redacts long hex blobs (SHA/HMAC shape)", async () => {
      const hmac = "a".repeat(64); // 64-char hex
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run("t-secret-4", "test", `checksum=${hmac} computed`, "completed");
      const result = parseResult(
        await registry.handlers.get("jarvis_task_detail")!({
          task_id: "t-secret-4",
        }),
      );
      const task = (result.data as { task: { description: string } }).task;
      expect(task.description).not.toContain(hmac);
      expect(task.description).toContain("[REDACTED_HEX]");
    });
  });

  // v7.7.1 M2 regression — generic error + correlation id.
  // Raw exception messages must NOT leak through the MCP surface.
  it("jarvis_task_detail error response includes correlation id, not exception message", async () => {
    // Force an error by closing the DB
    db.close();
    const result = parseResult(
      await registry.handlers.get("jarvis_task_detail")!({
        task_id: "anything",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("jarvis_task_detail failed");
    expect(
      (result as unknown as { correlation_id: string }).correlation_id,
    ).toMatch(/^[0-9a-f-]{36}$/);
  });
});
