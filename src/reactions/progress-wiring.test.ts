/**
 * Real-bus wiring for the stuck-watchdog liveness stamp.
 *
 * manager.test.ts mocks the event bus entirely, which is exactly how the
 * heavy orchestrator's dead heartbeat stayed invisible to 129 green tests
 * (qa R2 #1/#10, 2026-09-03): `eventBus.emit` (the EventEmitter facade) never
 * reaches `subscribe()` handlers — only `emitEvent` does. This file uses the
 * real PersistentEventBus on the real schema (initDatabase(":memory:")) and
 * pins both doors.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "../db/index.js";

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

  // One database for the file: the event bus is a module singleton bound to
  // the first handle it sees, so a per-test database would leave the bus on
  // a closed one. Each test starts from a fresh live-1 row instead.
  beforeAll(() => {
    db = initDatabase(":memory:");
    initEventBus(db);
  });

  afterAll(() => {
    closeDatabase();
  });

  beforeEach(() => {
    db.exec(`
      DELETE FROM tasks;
      INSERT INTO tasks (task_id, title, description, status, progress, started_at, updated_at)
        VALUES ('live-1', 'Live', 'd', 'running', 0, datetime('now','-20 minutes'), datetime('now','-20 minutes'));
    `);
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
