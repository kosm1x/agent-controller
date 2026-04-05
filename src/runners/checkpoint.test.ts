import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock jarvis-fs before importing checkpoint
const mockUpsertFile = vi.fn();
const mockDeleteFile = vi.fn();
const mockListFiles = vi.fn().mockReturnValue([]);
const mockGetFile = vi.fn().mockReturnValue(null);

vi.mock("../db/jarvis-fs.js", () => ({
  upsertFile: (...args: unknown[]) => mockUpsertFile(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
}));

import {
  writeCheckpoint,
  findRecentCheckpoint,
  clearCheckpoint,
} from "./checkpoint.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockListFiles.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeCheckpoint", () => {
  it("writes checkpoint to workspace/checkpoints/ with correct data", () => {
    writeCheckpoint({
      taskId: "test-123",
      title: "Fix scope regex",
      userMessage: "arregla el regex de scope para español",
      toolsCalled: ["file_read", "file_edit", "shell_exec"],
      scopeGroups: ["coding"],
      exitReason: "max_rounds",
      roundsCompleted: 35,
      maxRounds: 35,
      responseText: "Edité el archivo pero no pude hacer commit...",
    });

    expect(mockUpsertFile).toHaveBeenCalledOnce();
    const [path, title, content, tags, qualifier] =
      mockUpsertFile.mock.calls[0];
    expect(path).toBe("workspace/checkpoints/test-123.md");
    expect(title).toContain("Fix scope regex");
    expect(content).toContain("test-123");
    expect(content).toContain("max_rounds");
    expect(content).toContain("file_read, file_edit, shell_exec");
    expect(content).toContain("arregla el regex");
    expect(tags).toContain("checkpoint");
    expect(qualifier).toBe("workspace");
  });

  it("truncates long response text to 1000 chars", () => {
    writeCheckpoint({
      taskId: "test-456",
      title: "Long task",
      userMessage: "do something",
      toolsCalled: [],
      scopeGroups: [],
      exitReason: "token_budget",
      roundsCompleted: 20,
      maxRounds: 35,
      responseText: "x".repeat(2000),
    });

    const content = mockUpsertFile.mock.calls[0][2] as string;
    // The response section should not contain the full 2000 chars
    expect(content.length).toBeLessThan(1800);
  });
});

describe("findRecentCheckpoint", () => {
  it("returns null when no checkpoints exist", () => {
    mockListFiles.mockReturnValue([]);
    expect(findRecentCheckpoint()).toBeNull();
  });

  it("returns parsed checkpoint from recent file", () => {
    const now = new Date().toISOString();
    const checkpointContent = [
      "# Checkpoint: Fix bug",
      "",
      "**Task ID:** task-abc",
      "**Exit reason:** max_rounds (round 35/35)",
      `**Created:** ${now}`,
      "",
      "## User's Original Request",
      "Fix the scope regex for Spanish plurals",
      "",
      "## What Was Done",
      "Tools called: file_read, grep, file_edit",
      "",
      "## What Was NOT Completed",
      "The task ran out of rounds before finishing.",
      "",
      "## Last Response (truncated)",
      "Edité scope.ts pero no hice commit",
      "",
      "## Scope Groups",
      "coding",
    ].join("\n");
    mockListFiles.mockReturnValue([
      {
        path: "workspace/checkpoints/task-abc.md",
        title: "Checkpoint: Fix bug",
        tags: ["checkpoint"],
        qualifier: "workspace",
        priority: 0,
        size: checkpointContent.length,
        updated_at: now,
      },
    ]);
    mockGetFile.mockReturnValue({ content: checkpointContent });

    const cp = findRecentCheckpoint();
    expect(cp).not.toBeNull();
    expect(cp!.taskId).toBe("task-abc");
    expect(cp!.exitReason).toBe("max_rounds");
    expect(cp!.roundsCompleted).toBe(35);
    expect(cp!.maxRounds).toBe(35);
    expect(cp!.toolsCalled).toEqual(["file_read", "grep", "file_edit"]);
    expect(cp!.userMessage).toContain("Spanish plurals");
  });

  it("returns null for expired checkpoint (>30 min)", () => {
    const old = new Date(Date.now() - 35 * 60_000).toISOString();
    mockListFiles.mockReturnValue([
      {
        path: "workspace/checkpoints/old-task.md",
        title: "Checkpoint: Old",
        tags: ["checkpoint"],
        qualifier: "workspace",
        priority: 0,
        size: 50,
        updated_at: old,
      },
    ]);

    expect(findRecentCheckpoint()).toBeNull();
    // Should have deleted the expired checkpoint
    expect(mockDeleteFile).toHaveBeenCalledWith(
      "workspace/checkpoints/old-task.md",
    );
  });
});

describe("clearCheckpoint", () => {
  it("deletes checkpoint file", () => {
    clearCheckpoint("task-abc");
    expect(mockDeleteFile).toHaveBeenCalledWith(
      "workspace/checkpoints/task-abc.md",
    );
  });
});
