/**
 * A2A mapper tests — bidirectional MC <-> A2A conversion.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the database module
vi.mock("../db/index.js", () => {
  const mockDb = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  };
  return {
    getDatabase: vi.fn(() => mockDb),
  };
});

import {
  mcStatusToA2A,
  mcTaskToA2ATask,
  a2aMessageToSubmission,
  mcEventToA2AStatusEvent,
} from "./mapper.js";
import type { TaskRow } from "../dispatch/dispatcher.js";

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1,
    task_id: "task-123",
    parent_task_id: null,
    spawn_type: "root",
    title: "Test task",
    description: "Test description",
    priority: "medium",
    status: "completed",
    agent_type: "fast",
    classification: null,
    assigned_to: null,
    input: null,
    output: null,
    error: null,
    progress: 100,
    metadata: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("mcStatusToA2A", () => {
  it("should map all MC statuses correctly", () => {
    expect(mcStatusToA2A("pending")).toBe("submitted");
    expect(mcStatusToA2A("classifying")).toBe("submitted");
    expect(mcStatusToA2A("queued")).toBe("submitted");
    expect(mcStatusToA2A("running")).toBe("working");
    expect(mcStatusToA2A("completed")).toBe("completed");
    expect(mcStatusToA2A("failed")).toBe("failed");
    expect(mcStatusToA2A("cancelled")).toBe("canceled");
  });

  it("should default unknown statuses to submitted", () => {
    expect(mcStatusToA2A("unknown")).toBe("submitted");
  });
});

describe("mcTaskToA2ATask", () => {
  it("should convert completed task with text output", () => {
    const task = makeTask({
      output: JSON.stringify("The result is 42"),
    });
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.id).toBe("task-123");
    expect(a2a.status.state).toBe("completed");
    expect(a2a.artifacts).toHaveLength(1);
    expect(a2a.artifacts![0].parts[0]).toEqual({
      type: "text",
      text: "The result is 42",
    });
  });

  it("should convert completed task with JSON output", () => {
    const task = makeTask({
      output: JSON.stringify({ answer: 42 }),
    });
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.artifacts).toHaveLength(1);
    expect(a2a.artifacts![0].parts[0]).toEqual({
      type: "data",
      data: { answer: 42 },
    });
  });

  it("should convert task with no output", () => {
    const task = makeTask({ status: "running", output: null });
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.status.state).toBe("working");
    expect(a2a.artifacts).toBeUndefined();
  });

  it("should include error message for failed tasks", () => {
    const task = makeTask({
      status: "failed",
      error: "Something went wrong",
    });
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.status.state).toBe("failed");
    expect(a2a.status.message).toBe("Something went wrong");
  });

  it("should build history from title + description", () => {
    const task = makeTask();
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.history).toHaveLength(1);
    expect(a2a.history![0].role).toBe("user");
    expect(a2a.history![0].parts[0]).toEqual({
      type: "text",
      text: "Test task\n\nTest description",
    });
  });

  it("should include agent messages from runs", () => {
    const task = makeTask({ output: JSON.stringify("final") });
    const runs = [
      {
        run_id: "run-1",
        agent_type: "fast",
        status: "completed",
        output: JSON.stringify("run output"),
        error: null,
        duration_ms: 1000,
      },
    ];

    const a2a = mcTaskToA2ATask(task, runs);
    expect(a2a.history).toHaveLength(2);
    expect(a2a.history![1].role).toBe("agent");
    expect(a2a.history![1].parts[0]).toEqual({
      type: "text",
      text: "run output",
    });
  });

  it("should handle raw (non-JSON) output gracefully", () => {
    const task = makeTask({ output: "plain text output" });
    const a2a = mcTaskToA2ATask(task);

    expect(a2a.artifacts![0].parts[0]).toEqual({
      type: "text",
      text: "plain text output",
    });
  });
});

describe("a2aMessageToSubmission", () => {
  it("should extract title from first line of text", () => {
    const submission = a2aMessageToSubmission({
      role: "user",
      parts: [{ type: "text", text: "My Title\n\nDetailed description here" }],
    });

    expect(submission.title).toBe("My Title");
    expect(submission.description).toBe("Detailed description here");
  });

  it("should use full text as title and description for single line", () => {
    const submission = a2aMessageToSubmission({
      role: "user",
      parts: [{ type: "text", text: "What is 2+2?" }],
    });

    expect(submission.title).toBe("What is 2+2?");
    expect(submission.description).toBe("What is 2+2?");
  });

  it("should extract input from data parts", () => {
    const submission = a2aMessageToSubmission({
      role: "user",
      parts: [
        { type: "text", text: "Process this" },
        { type: "data", data: { key: "value" } },
      ],
    });

    expect(submission.input).toEqual({ key: "value" });
  });

  it("should combine multiple data parts into array", () => {
    const submission = a2aMessageToSubmission({
      role: "user",
      parts: [
        { type: "text", text: "Process these" },
        { type: "data", data: { a: 1 } },
        { type: "data", data: { b: 2 } },
      ],
    });

    expect(submission.input).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("should handle message with no text parts", () => {
    const submission = a2aMessageToSubmission({
      role: "user",
      parts: [{ type: "data", data: { only: "data" } }],
    });

    expect(submission.title).toBe("A2A Task");
    expect(submission.input).toEqual({ only: "data" });
  });
});

describe("mcEventToA2AStatusEvent", () => {
  it("should convert task.created event", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "task.created", data: { task_id: "t1" } },
      "t1",
    );
    expect(result).not.toBeNull();
    expect(result!.status.state).toBe("submitted");
    expect(result!.final).toBe(false);
  });

  it("should convert task.completed event as terminal", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "task.completed", data: { task_id: "t1" } },
      "t1",
    );
    expect(result!.status.state).toBe("completed");
    expect(result!.final).toBe(true);
  });

  it("should convert task.failed event with error message", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "task.failed", data: { task_id: "t1", error: "boom" } },
      "t1",
    );
    expect(result!.status.state).toBe("failed");
    expect(result!.status.message).toBe("boom");
    expect(result!.final).toBe(true);
  });

  it("should convert task.cancelled to canceled", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "task.cancelled", data: { task_id: "t1" } },
      "t1",
    );
    expect(result!.status.state).toBe("canceled");
    expect(result!.final).toBe(true);
  });

  it("should return null for non-matching task_id", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "task.created", data: { task_id: "other" } },
      "t1",
    );
    expect(result).toBeNull();
  });

  it("should return null for irrelevant event types", () => {
    const result = mcEventToA2AStatusEvent(
      { type: "agent.registered", data: { task_id: "t1" } },
      "t1",
    );
    expect(result).toBeNull();
  });

  it("should include progress message for working state", () => {
    const result = mcEventToA2AStatusEvent(
      {
        type: "task.progress",
        data: { task_id: "t1", message: "50% done" },
      },
      "t1",
    );
    expect(result!.status.state).toBe("working");
    expect(result!.status.message).toBe("50% done");
    expect(result!.final).toBe(false);
  });
});
