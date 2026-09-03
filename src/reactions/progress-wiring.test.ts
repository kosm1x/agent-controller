/**
 * Real-bus wiring for the stuck-watchdog liveness stamp.
 *
 * manager.test.ts mocks the event bus entirely, which is exactly how the
 * heavy orchestrator's dead heartbeat stayed invisible to 129 green tests
 * (qa R2 #1/#10, 2026-09-03): `eventBus.emit` (the EventEmitter facade) never
 * reaches `subscribe()` handlers — only `emitEvent` does. This file uses the
 * real PersistentEventBus on an in-memory DB and pins both doors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../dispatch/dispatcher.js", () => ({
  getTask: vi.fn(() => undefined),
  submitTask: vi.fn(),
}));
vi.mock("../db/reflector-gap.js", () => ({
  getLatestGoalSnapshot: () => null,
}));

import { initEventBus, getEventBus, eventBus } from "../lib/event-bus.js";
import { ReactionManager } from "./manager.js";

describe("task.progress → tasks liveness (real PersistentEventBus)", () => {
  let db: Database.Database;
  let manager: ReactionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
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
      );
      CREATE TABLE runs (id INTEGER PRIMARY KEY, run_id TEXT UNIQUE, task_id TEXT NOT NULL, status TEXT DEFAULT 'running', error TEXT, completed_at TEXT);
      CREATE TABLE task_outcomes (id INTEGER PRIMARY KEY, task_id TEXT, classified_as TEXT, ran_on TEXT, tools_used TEXT, duration_ms INTEGER, success INTEGER, feedback_signal TEXT DEFAULT 'neutral', tags TEXT, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO tasks (task_id, status, title, progress, started_at, updated_at)
        VALUES ('live-1', 'running', 'Live', 0, datetime('now','-20 minutes'), datetime('now','-20 minutes'));
    `);
    initEventBus(db); // module singleton — the first DB of this file wins
    manager = new ReactionManager(db);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
  });

  const row = () =>
    db
      .prepare(
        "SELECT progress, (updated_at > datetime('now','-1 minute')) AS fresh FROM tasks WHERE task_id='live-1'",
      )
      .get() as { progress: number; fresh: number };

  it("emitEvent('task.progress') reaches the subscriber and stamps the row", async () => {
    getEventBus().emitEvent("task.progress", {
      task_id: "live-1",
      agent_id: "swarm",
      progress: 40,
      phase: "execute",
      message: "2/5 goals",
    });
    await vi.waitFor(() => expect(row()).toEqual({ progress: 40, fresh: 1 }));
  });

  it("the EventEmitter facade's emit() is the WRONG door — subscribers never see it", async () => {
    eventBus.emit("task.progress", {
      task_id: "live-1",
      agent_id: "heavy",
      progress: 55,
      phase: "execute",
      message: "facade",
    });
    await new Promise((r) => setImmediate(r));
    expect(row()).toEqual({ progress: 0, fresh: 0 });
  });
});
