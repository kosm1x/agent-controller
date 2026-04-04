/**
 * Git tool tests — verify arg validation and sensitive file blocking.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const mockExecSync = vi.fn().mockReturnValue("");
const mockExecFileSync = vi.fn().mockReturnValue("");
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  ghCreatePrTool,
} from "./git.js";

describe("git tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockExecSync.mockReturnValue("");
    mockExecFileSync.mockReturnValue("");
  });

  describe("git_status", () => {
    it("returns clean status when no changes", async () => {
      mockExecSync
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({});
      expect(result).toContain("clean");
    });

    it("returns file list when changes exist", async () => {
      mockExecSync
        .mockReturnValueOnce(" M src/foo.ts\n?? src/bar.ts") // status
        .mockReturnValueOnce("main"); // branch — won't be called since status is truthy
      const result = await gitStatusTool.execute({});
      expect(result).toContain("src/foo.ts");
    });
  });

  describe("git_diff", () => {
    it("returns diff output", async () => {
      mockExecFileSync.mockReturnValue("diff --git a/foo.ts\n+new line");
      const result = await gitDiffTool.execute({});
      expect(result).toContain("+new line");
    });

    it("truncates long diffs", async () => {
      mockExecFileSync.mockReturnValue("x".repeat(6000));
      const result = await gitDiffTool.execute({});
      expect(result).toContain("truncated");
      expect(result.length).toBeLessThan(5200);
    });
  });

  describe("git_commit", () => {
    it("requires files and message", async () => {
      const r1 = await gitCommitTool.execute({ message: "test" });
      expect(r1).toContain("files array is required");

      const r2 = await gitCommitTool.execute({ files: ["foo.ts"] });
      expect(r2).toContain("commit message is required");
    });

    it("blocks sensitive files", async () => {
      const result = await gitCommitTool.execute({
        files: [".env.production"],
        message: "add env",
      });
      expect(result).toContain("sensitive");
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("blocks credentials files", async () => {
      const result = await gitCommitTool.execute({
        files: ["config/credentials.json"],
        message: "add creds",
      });
      expect(result).toContain("sensitive");
    });

    it("stages and commits when valid", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // git add (execFileSync)
        .mockReturnValueOnce("[main abc1234] test commit"); // git commit (execFileSync)
      mockExecSync.mockReturnValueOnce("1 file changed"); // git diff --cached --stat (execSync)
      const result = await gitCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("abc1234");
    });
  });

  describe("git_push", () => {
    it("checks auth before pushing", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("main") // git branch
        .mockReturnValueOnce("Everything up-to-date"); // git push
      const result = await gitPushTool.execute({});
      expect(result).toContain("up-to-date");
    });

    it("returns error when auth fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not logged in");
      });
      const result = await gitPushTool.execute({});
      expect(result).toContain("Error");
    });
  });

  describe("resolveWorkDir path validation", () => {
    it("accepts exact allowed path without trailing slash", async () => {
      mockExecSync
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor",
      });
      expect(result).toContain("clean");
    });

    it("accepts subdirectory of allowed path", async () => {
      mockExecSync
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor/src",
      });
      expect(result).toContain("clean");
    });

    it("rejects similar-prefix path outside allowed list", async () => {
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor-other",
      });
      expect(result).toContain("must be under an allowed project path");
    });

    it("blocks mission-control exact path", async () => {
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/mission-control",
      });
      expect(result).toContain("blocked");
    });

    it("blocks mission-control subdirectory", async () => {
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/mission-control/src",
      });
      expect(result).toContain("blocked");
    });
  });

  describe("gh_create_pr", () => {
    it("requires title and body", async () => {
      const r1 = await ghCreatePrTool.execute({ body: "desc" });
      expect(r1).toContain("title is required");

      const r2 = await ghCreatePrTool.execute({ title: "feat" });
      expect(r2).toContain("body is required");
    });

    it("creates PR with correct args", async () => {
      mockExecFileSync.mockReturnValue(
        "https://github.com/kosm1x/agent-controller/pull/42",
      );
      const result = await ghCreatePrTool.execute({
        title: "Add feature",
        body: "## Summary\nNew feature",
      });
      expect(result).toContain("pull/42");
    });
  });
});
