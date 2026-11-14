/**
 * Task checkout compare-and-set on the real `tasks` table.
 *
 * checkout.test.ts stubs `prepare`, so it only proves which SQL text is sent.
 * These cases run the claim and release UPDATEs and the status SELECT on
 * `initDatabase(":memory:")` (with the real status CHECK) and read the row.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { checkoutTask, releaseCheckout } from "./checkout.js";

// An old timestamp so a write by the module is visible as a change.
const SEEDED_AT = "2000-01-01 00:00:00";

interface TaskRow {
  status: string;
  assigned_to: string | null;
  started_at: string | null;
  updated_at: string;
}

function seedTask(taskId: string, status: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, created_at, updated_at)
       VALUES (?, 'synthetic task', 'synthetic description', ?, ?, ?)`,
    )
    .run(taskId, status, SEEDED_AT, SEEDED_AT);
}

function row(taskId: string): TaskRow {
  return getDatabase()
    .prepare(
      "SELECT status, assigned_to, started_at, updated_at FROM tasks WHERE task_id = ?",
    )
    .get(taskId) as TaskRow;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("checkout on the real tasks table", () => {
  it("claims a queued task once: running, assigned, started; a second claim is refused", () => {
    seedTask("t-queued", "queued");
    seedTask("t-other", "queued");

    expect(checkoutTask("t-queued", "runner-a")).toEqual({
      success: true,
      taskId: "t-queued",
    });
    const claimed = row("t-queued");
    expect(claimed.status).toBe("running");
    expect(claimed.assigned_to).toBe("runner-a");
    expect(claimed.started_at).not.toBeNull();
    expect(claimed.updated_at).not.toBe(SEEDED_AT);

    expect(checkoutTask("t-queued", "runner-b")).toEqual({
      success: false,
      taskId: "t-queued",
      reason: "already_claimed",
    });
    expect(row("t-queued").assigned_to).toBe("runner-a");
    // The claim touched only its own row.
    expect(row("t-other")).toEqual({
      status: "queued",
      assigned_to: null,
      started_at: null,
      updated_at: SEEDED_AT,
    });
  });

  it("refuses a task that is not queued and leaves it unchanged", () => {
    seedTask("t-pending", "pending");

    // A task that is not queued cannot be claimed; the reason reported for it is not part of the contract.
    expect(checkoutTask("t-pending", "runner-a")).toMatchObject({
      success: false,
      taskId: "t-pending",
    });
    expect(row("t-pending")).toEqual({
      status: "pending",
      assigned_to: null,
      started_at: null,
      updated_at: SEEDED_AT,
    });
  });

  it("reports not_found for an unknown task id", () => {
    seedTask("t-queued", "queued");

    expect(checkoutTask("t-missing", "runner-a")).toEqual({
      success: false,
      taskId: "t-missing",
      reason: "not_found",
    });
    expect(row("t-queued").status).toBe("queued");
  });

  it("only the claimant can release: the task returns to queued, unassigned, not started", () => {
    seedTask("t-queued", "queued");
    checkoutTask("t-queued", "runner-a");

    expect(releaseCheckout("t-queued", "runner-b")).toBe(false);
    expect(row("t-queued")).toMatchObject({
      status: "running",
      assigned_to: "runner-a",
    });

    // Back to the seeded value so the release's own updated_at write is visible.
    getDatabase()
      .prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?")
      .run(SEEDED_AT, "t-queued");
    expect(releaseCheckout("t-queued", "runner-a")).toBe(true);
    const released = row("t-queued");
    expect(released.status).toBe("queued");
    expect(released.assigned_to).toBeNull();
    expect(released.started_at).toBeNull();
    expect(released.updated_at).not.toBe(SEEDED_AT);

    // Released twice: the task is no longer running, nothing changes.
    expect(releaseCheckout("t-queued", "runner-a")).toBe(false);
    // And it can be claimed again.
    expect(checkoutTask("t-queued", "runner-b").success).toBe(true);
  });

  it("does not release a finished task even for its former claimant", () => {
    seedTask("t-done", "completed");
    getDatabase()
      .prepare("UPDATE tasks SET assigned_to = 'runner-a' WHERE task_id = ?")
      .run("t-done");

    expect(releaseCheckout("t-done", "runner-a")).toBe(false);
    expect(row("t-done")).toMatchObject({
      status: "completed",
      assigned_to: "runner-a",
      updated_at: SEEDED_AT,
    });
  });
});
