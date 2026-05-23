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
  pruneExpiredCheckpoints,
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

describe("pruneExpiredCheckpoints", () => {
  it("returns 0 when no checkpoints exist", () => {
    mockListFiles.mockReturnValueOnce([]);
    expect(pruneExpiredCheckpoints()).toBe(0);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("deletes expired checkpoints and leaves fresh ones alone", () => {
    const now = Date.now();
    // jarvis_files stores SQLite-style local datetimes (no trailing Z); the
    // production listFiles emits the same. Test fixtures should match.
    const isoLocal = (ms: number) =>
      new Date(ms)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
    mockListFiles.mockReturnValueOnce([
      {
        path: "workspace/checkpoints/fresh.md",
        title: "fresh",
        tags: [],
        qualifier: "workspace",
        priority: 0,
        size: 100,
        updated_at: isoLocal(now - 5 * 60_000), // 5 min ago — fresh
      },
      {
        path: "workspace/checkpoints/stale.md",
        title: "stale",
        tags: [],
        qualifier: "workspace",
        priority: 0,
        size: 100,
        updated_at: isoLocal(now - 60 * 60_000), // 1 h ago — stale (>30 min)
      },
    ]);

    const deleted = pruneExpiredCheckpoints();
    expect(deleted).toBe(1);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(
      "workspace/checkpoints/stale.md",
    );
  });

  it("counts only successful deletes when one delete throws", () => {
    const stale = (path: string) => ({
      path,
      title: path,
      tags: [],
      qualifier: "workspace",
      priority: 0,
      size: 100,
      updated_at: new Date(Date.now() - 60 * 60_000)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, ""),
    });
    mockListFiles.mockReturnValueOnce([
      stale("workspace/checkpoints/ok.md"),
      stale("workspace/checkpoints/boom.md"),
    ]);
    mockDeleteFile.mockImplementationOnce(() => true); // ok
    mockDeleteFile.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const deleted = pruneExpiredCheckpoints();
    expect(deleted).toBe(1);
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
  });

  it("survives a listFiles throw and returns 0", () => {
    mockListFiles.mockImplementationOnce(() => {
      throw new Error("db lock");
    });
    expect(pruneExpiredCheckpoints()).toBe(0);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("honours a custom TTL override", () => {
    const now = Date.now();
    const isoLocal = (ms: number) =>
      new Date(ms)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
    mockListFiles.mockReturnValueOnce([
      {
        path: "workspace/checkpoints/recent.md",
        title: "recent",
        tags: [],
        qualifier: "workspace",
        priority: 0,
        size: 100,
        updated_at: isoLocal(now - 2 * 60_000), // 2 min ago
      },
    ]);
    // Sub-second TTL — even the 2-min-old row is past it
    expect(pruneExpiredCheckpoints(1000)).toBe(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(
      "workspace/checkpoints/recent.md",
    );
  });
});
