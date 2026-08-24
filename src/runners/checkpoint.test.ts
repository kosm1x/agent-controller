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

describe("Phase 4 R1 W3 — orphan checkpoints never shadow runner checkpoints", () => {
  const mkContent = (taskId: string, exitReason: string) =>
    [
      `# Checkpoint: ${taskId}`,
      "",
      `**Task ID:** ${taskId}`,
      `**Exit reason:** ${exitReason} (round 10/35)`,
      `**Created:** ${new Date().toISOString()}`,
      "",
      "## User's Original Request",
      "Termina el reporte",
      "",
      "## What Was Done",
      "Tools called: file_read",
      "",
      "## What Was NOT Completed",
      "…",
      "",
      "## Last Response (truncated)",
      "parcial",
      "",
      "## Scope Groups",
      "coding",
    ].join("\n");

  const entry = (path: string, updatedAt: string, size = 100) => ({
    path,
    title: path,
    tags: ["checkpoint"],
    qualifier: "workspace",
    priority: 0,
    size,
    updated_at: updatedAt,
  });

  it("prefers the newest NON-orphan checkpoint even when an orphan is newer", () => {
    const older = new Date(Date.now() - 5 * 60_000).toISOString();
    const newer = new Date().toISOString();
    mockListFiles.mockReturnValue([
      entry("workspace/checkpoints/task-real.md", older),
      entry("workspace/checkpoints/task-orphan.md", newer),
    ]);
    mockGetFile.mockImplementation((path: string) =>
      path.includes("orphan")
        ? { content: mkContent("task-orphan", "orphaned_restart") }
        : { content: mkContent("task-real", "max_rounds") },
    );

    const cp = findRecentCheckpoint();
    expect(cp).not.toBeNull();
    expect(cp!.taskId).toBe("task-real");
    expect(cp!.exitReason).toBe("max_rounds");
  });

  it("falls back to the orphan checkpoint when it is the only one", () => {
    mockListFiles.mockReturnValue([
      entry("workspace/checkpoints/task-orphan.md", new Date().toISOString()),
    ]);
    mockGetFile.mockReturnValue({
      content: mkContent("task-orphan", "orphaned_restart"),
    });
    const cp = findRecentCheckpoint();
    expect(cp).not.toBeNull();
    expect(cp!.exitReason).toBe("orphaned_restart");
  });
});

describe("R3 audit W3 — thread-scoped checkpoints", () => {
  const mk = (taskId: string, threadLine: string | null) =>
    [
      `# Checkpoint: ${taskId}`,
      "",
      `**Task ID:** ${taskId}`,
      ...(threadLine ? [threadLine] : []),
      `**Exit reason:** max_rounds (round 10/35)`,
      `**Created:** ${new Date().toISOString()}`,
      "",
      "## User's Original Request",
      "Termina",
      "",
      "## What Was Done",
      "Tools called: file_read",
      "",
      "## What Was NOT Completed",
      "…",
      "",
      "## Last Response (truncated)",
      "parcial",
      "",
      "## Scope Groups",
      "",
    ].join("\n");

  const entry = (path: string) => ({
    path,
    title: path,
    tags: ["checkpoint"],
    qualifier: "workspace",
    priority: 0,
    size: 100,
    updated_at: new Date().toISOString(),
  });

  it("a checkpoint stamped for another thread is invisible", () => {
    mockListFiles.mockReturnValue([entry("workspace/checkpoints/t-a.md")]);
    mockGetFile.mockReturnValue({
      content: mk("t-a", "**Thread:** whatsapp:grupo@g.us:sender-b"),
    });
    expect(findRecentCheckpoint("whatsapp")).toBeNull();
    expect(
      findRecentCheckpoint("whatsapp:grupo@g.us:sender-b"),
    ).not.toBeNull();
  });

  it("a channel-level stamp matches every thread on that channel", () => {
    mockListFiles.mockReturnValue([entry("workspace/checkpoints/t-c.md")]);
    mockGetFile.mockReturnValue({
      content: mk("t-c", "**Thread:** email:comunidades"),
    });
    expect(
      findRecentCheckpoint("email:comunidades:alice@x.com"),
    ).not.toBeNull();
    expect(findRecentCheckpoint("telegram")).toBeNull();
    // R4 info: the ":" separator is load-bearing — a sibling-prefixed
    // channel must NOT match ("email" stamp vs "email2:…" thread).
    mockGetFile.mockReturnValue({
      content: mk("t-c", "**Thread:** email"),
    });
    expect(findRecentCheckpoint("email2:bob@x.com")).toBeNull();
    expect(findRecentCheckpoint("email:bob@x.com")).not.toBeNull();
  });

  it("an unstamped checkpoint matches any thread (legacy/runner writers)", () => {
    mockListFiles.mockReturnValue([entry("workspace/checkpoints/t-u.md")]);
    mockGetFile.mockReturnValue({ content: mk("t-u", null) });
    expect(findRecentCheckpoint("whatsapp")).not.toBeNull();
    expect(findRecentCheckpoint()).not.toBeNull();
  });

  it("writeCheckpoint emits and parseCheckpoint round-trips the thread stamp", () => {
    writeCheckpoint({
      taskId: "t-rt",
      title: "T",
      userMessage: "m",
      toolsCalled: [],
      scopeGroups: [],
      exitReason: "orphaned_restart",
      roundsCompleted: 0,
      maxRounds: 0,
      responseText: "x",
      threadKey: "telegram",
    });
    const content = mockUpsertFile.mock.calls[0][2] as string;
    expect(content).toContain("**Thread:** telegram");
  });
});
