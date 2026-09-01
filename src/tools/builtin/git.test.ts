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
  ghRepoCreateTool,
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

    // ── no-origin path (trustr dead-end, task 8953, 2026-09-01) ──
    // shell_exec denies `git remote add` and the old error here said "use
    // shell_exec to add one" — a circular dead-end that left a brand-new repo
    // un-pushable. `remote` is the sanctioned way to link an existing GitHub repo.

    it("wires origin from `remote` when the repo has none, only after confirming the GitHub repo exists, then pushes", async () => {
      mockExecSync.mockClear();
      mockExecFileSync.mockClear();
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockReturnValueOnce('{"name":"trustr"}') // gh repo view EurekaMD-net/trustr
        .mockReturnValueOnce("master") // git branch --show-current (fresh git init)
        .mockReturnValueOnce(""); // git branch -M main
      mockExecFileSync
        .mockReturnValueOnce("") // git remote add origin <url> (runArgs)
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("") // git branch -r — empty remote, nothing to rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch
        .mockReturnValueOnce("* [new branch]      main -> main"); // git push -u origin main
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/EurekaMD-net/trustr.git",
      });
      expect(result).toContain("main -> main");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("gh repo view EurekaMD-net/trustr"),
        expect.anything(),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        [
          "remote",
          "add",
          "origin",
          "https://github.com/EurekaMD-net/trustr.git",
        ],
        expect.objectContaining({
          cwd: expect.stringContaining("/root/claude/trustr"),
        }),
      );
      // Existence check precedes the write — never a dangling origin.
      const viewIdx = mockExecSync.mock.calls.findIndex((c) =>
        String(c[0]).includes("gh repo view"),
      );
      const addIdx = mockExecFileSync.mock.calls.findIndex(
        (c) => Array.isArray(c[1]) && c[1][0] === "remote",
      );
      expect(viewIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThanOrEqual(0);
      expect(mockExecSync.mock.invocationCallOrder[viewIdx]).toBeLessThan(
        mockExecFileSync.mock.invocationCallOrder[addIdx],
      );
    });

    it("refuses a credential-bearing or non-GitHub `remote` and writes nothing", async () => {
      mockExecFileSync.mockClear();
      for (const bad of [
        "https://TU_TOKEN@github.com/EurekaMD-net/trustr.git",
        "https://gitlab.com/EurekaMD-net/trustr.git",
        "git@github.com:EurekaMD-net/trustr.git",
        "https://github.com/EurekaMD-net/trustr.git; rm -rf /",
      ]) {
        mockExecSync
          .mockReturnValueOnce("✓ Logged in") // gh auth status
          .mockImplementationOnce(() => {
            throw new Error("error: No such remote 'origin'");
          }); // git remote get-url → none
        const result = await gitPushTool.execute({
          cwd: "/root/claude/trustr",
          remote: bad,
        });
        expect(JSON.parse(result).error).toContain("plain GitHub HTTPS URL");
      }
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("with no origin and no `remote`, the error names gh_repo_create / git_push — never shell_exec", async () => {
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }); // git remote get-url → none
      const result = await gitPushTool.execute({ cwd: "/root/claude/trustr" });
      const { error } = JSON.parse(result);
      expect(error).toContain("gh_repo_create");
      expect(error).toContain("remote=");
      expect(error).not.toContain("shell_exec");
    });

    it("ignores `remote` when origin already exists (never rewrites a configured remote)", async () => {
      mockExecFileSync.mockClear();
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("origin/main") // git branch -r
        .mockReturnValueOnce("") // git status --porcelain
        .mockReturnValueOnce("") // git rebase
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push
      const result = await gitPushTool.execute({
        remote: "https://github.com/EurekaMD-net/other.git",
      });
      expect(result).toContain("ba2005e");
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("does NOT add origin when the GitHub repo does not exist (qa #5: never a dangling origin)", async () => {
      mockExecFileSync.mockClear();
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockImplementationOnce(() => {
          throw new Error("GraphQL: Could not resolve to a Repository");
        }); // gh repo view → absent
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/EurekaMD-net/ghost.git",
      });
      const { error } = JSON.parse(result);
      expect(error).toContain("EurekaMD-net/ghost does not exist on GitHub");
      expect(error).toContain("gh_repo_create");
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("accepts dotted repo names in `remote` and checks the FULL name on GitHub (qa #2)", async () => {
      mockExecSync.mockClear();
      mockExecSync
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockReturnValueOnce('{"name":"trustr.io"}') // gh repo view EurekaMD-net/trustr.io
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFileSync
        .mockReturnValueOnce("") // git remote add origin
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r — empty
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main") // isJarvisBranch → getCurrentBranch
        .mockReturnValueOnce("* [new branch]      main -> main"); // git push
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/EurekaMD-net/trustr.io.git",
      });
      expect(result).toContain("main -> main");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("gh repo view EurekaMD-net/trustr.io --json"),
        expect.anything(),
      );
    });

    it("a blocked cwd surfaces the path-guard reason, not a bogus 'no origin' (qa #3)", async () => {
      mockExecSync.mockClear();
      const result = await gitPushTool.execute({
        cwd: "/root/claude/mission-control",
        remote: "https://github.com/EurekaMD-net/x.git",
      });
      expect(JSON.parse(result).error).toContain(
        "primary mission-control checkout",
      );
      expect(mockExecSync).not.toHaveBeenCalled(); // guard fired before auth / network
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

  describe("gh_repo_create", () => {
    // trustr dead-end (task 8953, 2026-09-01): the tool created the GitHub repo
    // but never linked the local checkout, and no other tool could add the remote.

    it("with cwd, creates the repo AND wires it as origin via gh --source/--remote", async () => {
      mockExecFileSync.mockClear();
      mockExecFileSync
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // pre-flight: git remote get-url origin → none (the case this exists for)
        .mockReturnValue("https://github.com/EurekaMD-net/trustr"); // gh repo create
      const result = await ghRepoCreateTool.execute({
        name: "trustr",
        private: true,
        description: "Identidad portable del vendedor",
        cwd: "/root/claude/trustr",
      });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining([
          "repo",
          "create",
          "EurekaMD-net/trustr",
          "--private",
          "--source",
          expect.stringContaining("/root/claude/trustr"),
          "--remote",
          "origin",
        ]),
        expect.anything(),
      );
      expect(result).toContain("https://github.com/EurekaMD-net/trustr");
      expect(result).toContain("origin");
      expect(result).toContain("git_push");
    });

    it("without cwd, creates the GitHub repo only (no --source) and says so", async () => {
      mockExecFileSync.mockClear();
      mockExecFileSync.mockReturnValue(
        "https://github.com/EurekaMD-net/trustr",
      );
      const result = await ghRepoCreateTool.execute({ name: "trustr" });
      const ghArgs = mockExecFileSync.mock.calls[0]?.[1] as string[];
      expect(ghArgs).toContain("--public");
      expect(ghArgs).not.toContain("--source");
      expect(ghArgs).not.toContain("--remote");
      expect(result).not.toContain("Remote 'origin' configured");
    });

    it("refuses a cwd outside the allowed project domain before calling gh", async () => {
      mockExecFileSync.mockClear();
      const result = await ghRepoCreateTool.execute({
        name: "trustr",
        cwd: "/root/claude-backups/trustr",
      });
      expect(JSON.parse(result).error).toContain("allowed project path");
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it("refuses a cwd that already has an origin WITHOUT calling gh (qa #1: gh creates the repo before checking the local remote)", async () => {
      mockExecFileSync.mockClear();
      mockExecFileSync.mockReturnValueOnce(
        "https://github.com/EurekaMD-net/old.git\n",
      ); // pre-flight → origin exists
      const result = await ghRepoCreateTool.execute({
        name: "trustr",
        cwd: "/root/claude/trustr",
      });
      const { error } = JSON.parse(result);
      expect(error).toContain(
        "already has origin=https://github.com/EurekaMD-net/old.git",
      );
      expect(error).toContain("git_push");
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        "gh",
        expect.anything(),
        expect.anything(),
      );
    });

    it("refuses the primary mission-control checkout as cwd before calling gh (qa #4)", async () => {
      mockExecFileSync.mockClear();
      const result = await ghRepoCreateTool.execute({
        name: "x",
        cwd: "/root/claude/mission-control",
      });
      expect(JSON.parse(result).error).toContain(
        "primary mission-control checkout",
      );
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe("gh_create_pr", () => {
    it("requires title and body", async () => {
      const r1 = await ghCreatePrTool.execute({ body: "desc" });
      expect(r1).toContain("title is required");

      const r2 = await ghCreatePrTool.execute({ title: "feat" });
      expect(r2).toContain("body is required");
    });

    it("reads the head branch from cwd and passes --head + cwd to gh (task adcda0f2 fix)", async () => {
      mockExecFileSync
        .mockReturnValueOnce("feature-x\n") // getCurrentBranch(workDir)
        .mockReturnValueOnce("feature-x\n") // isJarvisBranch → getCurrentBranch
        .mockReturnValueOnce(
          "https://github.com/kosm1x/agent-controller/pull/42",
        ); // gh pr create
      const result = await ghCreatePrTool.execute({
        title: "Add feature",
        body: "## Summary\nNew feature",
        cwd: "/root/claude/myrepo",
      });
      expect(result).toContain("pull/42");

      const ghCall = mockExecFileSync.mock.calls.at(-1)!;
      expect(ghCall[0]).toBe("gh");
      const argv = ghCall[1] as string[];
      expect(argv).toContain("--head");
      expect(argv[argv.indexOf("--head") + 1]).toBe("feature-x");
      const opts = ghCall[2] as { cwd: string };
      expect(opts.cwd).toBe("/root/claude/myrepo");
    });

    it("refuses when cwd is on the base branch — the pre-fix wrong-checkout failure mode", async () => {
      mockExecFileSync.mockReturnValue("main\n"); // getCurrentBranch(workDir)
      const result = await ghCreatePrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      });
      const parsed = JSON.parse(result) as { error: string };
      expect(parsed.error).toContain('is on "main"');
      expect(parsed.error).toContain("feature branch");
      // gh itself must never have been invoked
      const ghCalls = mockExecFileSync.mock.calls.filter((c) => c[0] === "gh");
      expect(ghCalls).toHaveLength(0);
    });
  });
});
