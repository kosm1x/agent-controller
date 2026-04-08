/**
 * Tests for canary — self-monitoring health checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCanaryCheck } from "./canary.js";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("runCanaryCheck", () => {
  it("returns healthy metrics on empty DB", () => {
    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(1);
    expect(result.totalTasks).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it("detects low success rate", () => {
    const db = getDatabase();
    // Insert 10 tasks: 5 completed, 5 failed
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", i < 5 ? "completed" : "failed");
    }

    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(0.5);
    expect(result.totalTasks).toBe(10);
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.alerts[0]).toContain("50%");
  });

  it("does not alert when success rate is above threshold", () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", i < 8 ? "completed" : "failed");
    }

    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(0.8);
    expect(result.alerts).toHaveLength(0);
  });

  it("does not alert with fewer than 5 tasks", () => {
    const db = getDatabase();
    // 2 tasks, both failed — but total < 5 so no alert
    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", "failed");
    }

    const result = runCanaryCheck();
    expect(result.alerts).toHaveLength(0);
  });
});
