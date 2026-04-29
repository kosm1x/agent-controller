/**
 * Outcome-tag helper tests — status→tag mapping + DB lookup safety.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock store keyed by task_id → status
const taskStore = new Map<string, string | null>();

const mockDb = {
  prepare: (sql: string) => {
    if (sql.startsWith("SELECT status FROM tasks")) {
      return {
        get: (taskId: string) => {
          if (!taskStore.has(taskId)) return undefined;
          return { status: taskStore.get(taskId) ?? null };
        },
      };
    }
    throw new Error(`unmocked query: ${sql.slice(0, 60)}`);
  },
};

let throwOnGetDatabase = false;

vi.mock("../db/index.js", () => ({
  getDatabase: () => {
    if (throwOnGetDatabase) {
      throw new Error("DB not initialized");
    }
    return mockDb;
  },
}));

import { getOutcomeTag, statusToOutcomeTag } from "./outcome-tag.js";

beforeEach(() => {
  taskStore.clear();
  throwOnGetDatabase = false;
});

describe("statusToOutcomeTag", () => {
  it("maps completed → outcome:success", () => {
    expect(statusToOutcomeTag("completed")).toBe("outcome:success");
  });

  it("maps completed_with_concerns → outcome:concerns", () => {
    expect(statusToOutcomeTag("completed_with_concerns")).toBe(
      "outcome:concerns",
    );
  });

  it("maps failed → outcome:failed", () => {
    expect(statusToOutcomeTag("failed")).toBe("outcome:failed");
  });

  it("maps blocked → outcome:failed (didn't reach success)", () => {
    expect(statusToOutcomeTag("blocked")).toBe("outcome:failed");
  });

  it("maps cancelled → outcome:failed (early termination)", () => {
    expect(statusToOutcomeTag("cancelled")).toBe("outcome:failed");
  });

  it("maps needs_context → outcome:unknown (incomplete signal)", () => {
    expect(statusToOutcomeTag("needs_context")).toBe("outcome:unknown");
  });

  it("maps running → outcome:unknown (task hasn't terminated)", () => {
    expect(statusToOutcomeTag("running")).toBe("outcome:unknown");
  });

  it("maps null → outcome:unknown", () => {
    expect(statusToOutcomeTag(null)).toBe("outcome:unknown");
  });

  it("maps undefined → outcome:unknown", () => {
    expect(statusToOutcomeTag(undefined)).toBe("outcome:unknown");
  });

  it("maps unrecognized status → outcome:unknown", () => {
    expect(statusToOutcomeTag("frobnicated")).toBe("outcome:unknown");
  });
});

describe("getOutcomeTag", () => {
  it("returns outcome:success for a completed task", () => {
    taskStore.set("task-A", "completed");
    expect(getOutcomeTag("task-A")).toBe("outcome:success");
  });

  it("returns outcome:concerns for completed_with_concerns", () => {
    taskStore.set("task-B", "completed_with_concerns");
    expect(getOutcomeTag("task-B")).toBe("outcome:concerns");
  });

  it("returns outcome:failed for cancelled", () => {
    taskStore.set("task-C", "cancelled");
    expect(getOutcomeTag("task-C")).toBe("outcome:failed");
  });

  it("returns outcome:unknown when task is missing", () => {
    expect(getOutcomeTag("task-nonexistent")).toBe("outcome:unknown");
  });

  it("returns outcome:unknown when taskId is null", () => {
    expect(getOutcomeTag(null)).toBe("outcome:unknown");
  });

  it("returns outcome:unknown when taskId is undefined", () => {
    expect(getOutcomeTag(undefined)).toBe("outcome:unknown");
  });

  it("returns outcome:unknown when taskId is empty string", () => {
    expect(getOutcomeTag("")).toBe("outcome:unknown");
  });

  it("returns outcome:unknown on DB error (degrades silently)", () => {
    throwOnGetDatabase = true;
    expect(getOutcomeTag("task-X")).toBe("outcome:unknown");
  });

  it("returns outcome:unknown when row exists with null status", () => {
    taskStore.set("task-D", null);
    expect(getOutcomeTag("task-D")).toBe("outcome:unknown");
  });
});
