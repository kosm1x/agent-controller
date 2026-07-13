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
    vi.unstubAllEnvs();
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
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch (execFileSync)
        .mockReturnValueOnce("[main abc1234] test commit"); // git commit (execFileSync)
      mockExecSync.mockReturnValueOnce("1 file changed"); // git diff --cached --stat (execSync)
      const result = await gitCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("abc1234");
      const commitCall = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).not.toContain("--no-verify");
    });

    it("commits with --no-verify on jarvis/* branches (hook runs the full suite; tool timeout is 30s)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "test-token");
      vi.resetModules();
      const { gitCommitTool: freshCommitTool } = await import("./git.js");
      mockExecFileSync
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("jarvis/feat/jme-phase0") // getCurrentBranch
        .mockReturnValueOnce("[jarvis/feat/jme-phase0 def5678] test"); // git commit
      mockExecSync.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await freshCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("def5678");
      const commitCall = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).toContain("--no-verify");
      expect(commitCall![1]).toContain("--author");
    });

    it("still uses --no-verify on jarvis/* branches without JARVIS_GH_TOKEN (no --author)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "");
      vi.resetModules();
      const { gitCommitTool: freshCommitTool } = await import("./git.js");
      mockExecFileSync
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("jarvis/feat/jme-phase0") // getCurrentBranch
        .mockReturnValueOnce("[jarvis/feat/jme-phase0 aaa9999] test"); // git commit
      mockExecSync.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await freshCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("aaa9999");
      const commitCall = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).toContain("--no-verify");
      expect(commitCall![1]).not.toContain("--author");
    });
  });

  describe("git_push", () => {
    it("pushes successfully with new commits", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce("") // git status --porcelain — clean (runArgs)
        .mockReturnValueOnce("") // git rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch (execFileSync)
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push (runArgs)
      const result = await gitPushTool.execute({});
      expect(result).toContain("ba2005e");
    });

    it("blocks with an actionable error when the tree is dirty + remote exists", async () => {
      // Regression (williams-entry-radar, 2026-06-20): a dirty tree makes the
      // pre-push rebase abort. The tool must surface that BEFORE pushing into a
      // guaranteed rejection — not swallow it as "empty repo".
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce(" M signals.md\n?? results/x.csv"); // git status --porcelain → DIRTY
      const result = await gitPushTool.execute({});
      expect(result).toContain("uncommitted");
      expect(result).toContain("git_commit");
      expect(result).toContain("signals.md");
      expect(result).not.toContain("-> main"); // never reached the push
    });

    it("reports a manual-reconcile error when the auto-rebase conflicts", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce("") // git status --porcelain — clean (runArgs)
        .mockImplementationOnce(() => {
          throw new Error("CONFLICT (content): Merge conflict in signals.md");
        }) // git rebase (runArgs) → conflict
        .mockReturnValueOnce(""); // git rebase --abort (runArgs)
      const result = await gitPushTool.execute({});
      expect(result).toContain("diverged");
      expect(result).toContain("manual reconcile");
      expect(result).not.toContain("-> main"); // never reached the push
    });

    it("returns clean message when up-to-date with clean tree", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce("") // git status --porcelain — clean (runArgs)
        .mockReturnValueOnce("") // git rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch (execFileSync)
        .mockReturnValueOnce("Everything up-to-date"); // git push (runArgs)
      const result = await gitPushTool.execute({});
      expect(result).toBe("Already up-to-date — no new commits to push.");
    });

    it("returns error when auth fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not logged in");
      });
      const result = await gitPushTool.execute({});
      expect(JSON.parse(result).error).toContain("GitHub auth not configured");
    });

    it("returns error on detached HEAD", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce(""); // git branch --show-current (detached)
      const result = await gitPushTool.execute({});
      expect(result).toContain("detached HEAD");
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

    it("accepts a top-level project repo (regression: old enumerated allowlist blocked these)", async () => {
      mockExecSync
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/eurekams-intelligence-ui",
      });
      expect(result).toContain("clean");
    });

    it("rejects a similar-prefix path outside the git domain", async () => {
      // The /root/claude/ prefix carries a trailing slash so a sibling like
      // /root/claude-backups does NOT match — prefix-confusion protection.
      const result = await gitStatusTool.execute({
        cwd: "/root/claude-backups/sprint-1",
      });
      expect(result).toContain("must be under an allowed project path");
    });

    it("blocks git operations on operator config paths under /root/claude/", async () => {
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/.claude",
      });
      expect(result).toMatch(/operator config|blocked/i);
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
