/**
 * Outcome tag lookup on the real `tasks` table.
 *
 * outcome-tag.test.ts answers `prepare` with a fake keyed on the SQL prefix,
 * so it never runs the SELECT. Here the lookup runs on
 * `initDatabase(":memory:")`; `getOutcomeTag` swallows errors into
 * "outcome:unknown", so each case asserts a tag other than unknown.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { getOutcomeTag } from "./outcome-tag.js";

function seedTask(taskId: string, status: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status)
       VALUES (?, 'synthetic task', 'synthetic description', ?)`,
    )
    .run(taskId, status);
}

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => closeDatabase());

describe("getOutcomeTag on the real schema", () => {
  it("tags each task by its own stored status", () => {
    seedTask("task-ok", "completed");
    seedTask("task-concerns", "completed_with_concerns");
    seedTask("task-failed", "failed");
    expect(getOutcomeTag("task-ok")).toBe("outcome:success");
    expect(getOutcomeTag("task-concerns")).toBe("outcome:concerns");
    expect(getOutcomeTag("task-failed")).toBe("outcome:failed");
  });

  it("a task id with no row is unknown", () => {
    seedTask("task-ok", "completed");
    expect(getOutcomeTag("task-missing")).toBe("outcome:unknown");
  });
});
