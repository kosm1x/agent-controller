import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

// Mock other scheduler deps to prevent side effects
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn().mockReturnValue({ stop: vi.fn() }) },
}));
vi.mock("../db/index.js", () => ({
  getDatabase: () => ({ prepare: vi.fn().mockReturnValue({ get: vi.fn() }) }),
}));
vi.mock("../dispatch/dispatcher.js", () => ({
  submitTask: vi.fn(),
}));
vi.mock("../config.js", () => ({
  getConfig: () => ({ tuningEnabled: false }),
}));

import { createPreCycleTag, pruneOldTags } from "./scheduler.js";

describe("SG5: Pre-cycle git tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createPreCycleTag", () => {
    it("creates tag with correct name format", () => {
      const date = new Date().toISOString().slice(0, 10);
      // First call: tag -l (check existing) returns empty
      // Second call: tag -a (create)
      mockExecFileSync
        .mockReturnValueOnce("") // tag -l
        .mockReturnValueOnce("") // tag -a
        .mockReturnValueOnce(""); // pruneOldTags tag -l

      createPreCycleTag();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-l", `pre-auto-${date}`],
        expect.objectContaining({ cwd: "/root/claude/mission-control" }),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        [
          "tag",
          "-a",
          `pre-auto-${date}`,
          "-m",
          "Pre-autonomous-improvement snapshot",
        ],
        expect.objectContaining({ cwd: "/root/claude/mission-control" }),
      );
    });

    it("skips if tag already exists for today", () => {
      const date = new Date().toISOString().slice(0, 10);
      mockExecFileSync.mockReturnValueOnce(`pre-auto-${date}`);

      createPreCycleTag();

      // Should only call tag -l, not tag -a
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("does not throw on git failure", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("git not found");
      });

      expect(() => createPreCycleTag()).not.toThrow();
    });
  });

  describe("pruneOldTags", () => {
    it("keeps all tags when 10 or fewer exist", () => {
      mockExecFileSync.mockReturnValueOnce(
        "pre-auto-2026-04-01\npre-auto-2026-04-02\npre-auto-2026-04-03",
      );

      pruneOldTags();

      // Only the list call, no deletes
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("deletes old tags beyond the 10 newest when older than 30 days", () => {
      // Generate 12 tags — 10 recent + 2 old
      const tags: string[] = [];
      for (let i = 0; i < 10; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        tags.push(`pre-auto-${d.toISOString().slice(0, 10)}`);
      }
      // Add 2 old tags (> 30 days)
      const old1 = new Date();
      old1.setDate(old1.getDate() - 40);
      const old2 = new Date();
      old2.setDate(old2.getDate() - 50);
      tags.push(`pre-auto-${old1.toISOString().slice(0, 10)}`);
      tags.push(`pre-auto-${old2.toISOString().slice(0, 10)}`);

      mockExecFileSync.mockReturnValueOnce(tags.join("\n"));

      pruneOldTags();

      // 1 list + 2 deletes
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-d", `pre-auto-${old1.toISOString().slice(0, 10)}`],
        expect.any(Object),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["tag", "-d", `pre-auto-${old2.toISOString().slice(0, 10)}`],
        expect.any(Object),
      );
    });

    it("does not delete tags beyond 10 that are within 30 days", () => {
      const tags: string[] = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        tags.push(`pre-auto-${d.toISOString().slice(0, 10)}`);
      }

      mockExecFileSync.mockReturnValueOnce(tags.join("\n"));

      pruneOldTags();

      // Only list call — tags beyond 10 are within 30 days so not deleted
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("does not throw on failure", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      expect(() => pruneOldTags()).not.toThrow();
    });
  });
});
