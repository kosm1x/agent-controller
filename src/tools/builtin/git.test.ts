/**
 * Git tool tests — verify arg validation and sensitive file blocking.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// run() → exec, runArgs()/jarvis gh PR → execFile (async since 2026-10-26,
// MCEventLoopBlock); getCurrentBranch stays on execFileSync.
const mockExec = vi.fn().mockReturnValue("");
const mockExecFile = vi.fn().mockReturnValue("");
const mockExecFileSync = vi.fn().mockReturnValue("");
// stdin.end() of every async child (W3: a prompting child must fail fast).
const mockStdinEnd = vi.fn();

type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

/**
 * Callback-style child mock with the real `(…, cb) => cb(err, stdout, stderr)`
 * shape. `impl` records the call (args without the callback) and returns
 * stdout (or a promise of it, to hold the child open until the test releases
 * it) or throws; the result is delivered on setImmediate, like a real child.
 * Real exec/execFile carry util.promisify.custom resolving `{stdout, stderr}`
 * with `.child` on the promise — mirrored here so promisify() sees the same
 * shape.
 */
function asyncChild(impl: (...args: unknown[]) => string | Promise<string>) {
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  const child = (...args: unknown[]) => {
    const cb = args.pop() as ChildCb;
    try {
      Promise.resolve(impl(...args)).then(
        (out) => setImmediate(() => cb(null, out, "")),
        (e) => fail(cb, e),
      );
    } catch (e) {
      fail(cb, e);
    }
  };
  Object.defineProperty(child, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) =>
      Object.assign(
        new Promise((res, rej) =>
          child(...args, ((err, stdout, stderr) =>
            err ? rej(err) : res({ stdout, stderr })) as ChildCb),
        ),
        { child: { stdin: { end: mockStdinEnd } } },
      ),
  });
  return child;
}

vi.mock("child_process", () => ({
  exec: asyncChild((...args: unknown[]) => mockExec(...args)),
  execFile: asyncChild((...args: unknown[]) => mockExecFile(...args)),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  ghRepoCreateTool,
  ghCreatePrTool,
  getCurrentBranch,
} from "./git.js";

describe("git tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mockExec.mockReturnValue("");
    mockExecFile.mockReturnValue("");
    mockExecFileSync.mockReturnValue("");
  });

  describe("git_status", () => {
    it("returns clean status when no changes", async () => {
      mockExec
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({});
      expect(result).toContain("clean");
    });

    it("returns file list when changes exist", async () => {
      mockExec
        .mockReturnValueOnce(" M src/foo.ts\n?? src/bar.ts") // status
        .mockReturnValueOnce("main"); // branch — won't be called since status is truthy
      const result = await gitStatusTool.execute({});
      expect(result).toContain("src/foo.ts");
    });
  });

  describe("git_diff", () => {
    it("returns diff output", async () => {
      mockExecFile.mockReturnValue("diff --git a/foo.ts\n+new line");
      const result = await gitDiffTool.execute({});
      expect(result).toContain("+new line");
    });

    it("truncates long diffs", async () => {
      mockExecFile.mockReturnValue("x".repeat(6000));
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
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("blocks credentials files", async () => {
      const result = await gitCommitTool.execute({
        files: ["config/credentials.json"],
        message: "add creds",
      });
      expect(result).toContain("sensitive");
    });

    it("stages and commits when valid", async () => {
      mockExecFile
        .mockReturnValueOnce("") // git add (execFile)
        .mockReturnValueOnce("[main abc1234] test commit"); // git commit (execFile)
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch (execFileSync)
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat (exec)
      const result = await gitCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("abc1234");
      const commitCall = mockExecFile.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).not.toContain("--no-verify");
    });

    it("commits with --no-verify on jarvis/* branches (hook runs the full suite; tool timeout is 30s)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "test-token");
      vi.resetModules();
      const { gitCommitTool: freshCommitTool } = await import("./git.js");
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("[jarvis/feat/jme-phase0 def5678] test"); // git commit
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/jme-phase0"); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await freshCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("def5678");
      const commitCall = mockExecFile.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).toContain("--no-verify");
      expect(commitCall![1]).toContain("--author");
    });

    it("still uses --no-verify on jarvis/* branches without JARVIS_GH_TOKEN (no --author)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "");
      vi.resetModules();
      const { gitCommitTool: freshCommitTool } = await import("./git.js");
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("[jarvis/feat/jme-phase0 aaa9999] test"); // git commit
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/jme-phase0"); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await freshCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("aaa9999");
      const commitCall = mockExecFile.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).toContain("--no-verify");
      expect(commitCall![1]).not.toContain("--author");
    });
  });

  describe("git_push", () => {
    it("pushes successfully with new commits", async () => {
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce("") // git status --porcelain — clean (runArgs)
        .mockReturnValueOnce("") // git rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push (runArgs)
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch (execFileSync)
      const result = await gitPushTool.execute({});
      expect(result).toContain("ba2005e");
    });

    it("blocks with an actionable error when the tree is dirty + remote exists", async () => {
      // Regression (williams-entry-radar, 2026-06-20): a dirty tree makes the
      // pre-push rebase abort. The tool must surface that BEFORE pushing into a
      // guaranteed rejection — not swallow it as "empty repo".
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
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
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
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
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("origin/main") // git branch -r (runArgs)
        .mockReturnValueOnce("") // git status --porcelain — clean (runArgs)
        .mockReturnValueOnce("") // git rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("Everything up-to-date"); // git push (runArgs)
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch (execFileSync)
      const result = await gitPushTool.execute({});
      expect(result).toBe("Already up-to-date — no new commits to push.");
    });

    it("returns error when auth fails", async () => {
      mockExec.mockImplementation(() => {
        throw new Error("not logged in");
      });
      const result = await gitPushTool.execute({});
      expect(JSON.parse(result).error).toContain("GitHub auth not configured");
    });

    it("returns error on detached HEAD", async () => {
      mockExec
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
      mockExec.mockClear();
      mockExecFile.mockClear();
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockReturnValueOnce('{"name":"trustr"}') // gh repo view EurekaMD-net/trustr
        .mockReturnValueOnce("master") // git branch --show-current (fresh git init)
        .mockReturnValueOnce(""); // git branch -M main
      mockExecFile
        .mockReturnValueOnce("") // git remote add origin <url> (runArgs)
        .mockReturnValueOnce("") // git fetch origin (runArgs)
        .mockReturnValueOnce("") // git branch -r — empty remote, nothing to rebase (runArgs)
        .mockReturnValueOnce("") // git status --short (runArgs)
        .mockReturnValueOnce("* [new branch]      main -> main"); // git push -u origin main
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/EurekaMD-net/trustr.git",
      });
      expect(result).toContain("main -> main");
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("gh repo view EurekaMD-net/trustr"),
        expect.anything(),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
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
      const viewIdx = mockExec.mock.calls.findIndex((c) =>
        String(c[0]).includes("gh repo view"),
      );
      const addIdx = mockExecFile.mock.calls.findIndex(
        (c) => Array.isArray(c[1]) && c[1][0] === "remote",
      );
      expect(viewIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThanOrEqual(0);
      expect(mockExec.mock.invocationCallOrder[viewIdx]).toBeLessThan(
        mockExecFile.mock.invocationCallOrder[addIdx],
      );
    });

    it("refuses a credential-bearing or non-GitHub `remote` and writes nothing", async () => {
      mockExecFile.mockClear();
      for (const bad of [
        "https://TU_TOKEN@github.com/EurekaMD-net/trustr.git",
        "https://gitlab.com/EurekaMD-net/trustr.git",
        "git@github.com:EurekaMD-net/trustr.git",
        "https://github.com/EurekaMD-net/trustr.git; rm -rf /",
      ]) {
        mockExec
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
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("with no origin and no `remote`, the error names gh_repo_create / git_push — never shell_exec", async () => {
      mockExec
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
      mockExecFile.mockClear();
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("origin/main") // git branch -r
        .mockReturnValueOnce("") // git status --porcelain
        .mockReturnValueOnce("") // git rebase
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const result = await gitPushTool.execute({
        remote: "https://github.com/EurekaMD-net/other.git",
      });
      expect(result).toContain("ba2005e");
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("does NOT add origin when the GitHub repo does not exist (qa #5: never a dangling origin)", async () => {
      mockExecFile.mockClear();
      mockExec
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
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["remote"]),
        expect.anything(),
      );
    });

    it("accepts dotted repo names in `remote` and checks the FULL name on GitHub (qa #2)", async () => {
      mockExec.mockClear();
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockReturnValueOnce('{"name":"trustr.io"}') // gh repo view EurekaMD-net/trustr.io
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git remote add origin
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r — empty
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("* [new branch]      main -> main"); // git push
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/EurekaMD-net/trustr.io.git",
      });
      expect(result).toContain("main -> main");
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("gh repo view EurekaMD-net/trustr.io --json"),
        expect.anything(),
      );
    });

    it("a blocked cwd surfaces the path-guard reason, not a bogus 'no origin' (qa #3)", async () => {
      mockExec.mockClear();
      const result = await gitPushTool.execute({
        cwd: "/root/claude/mission-control",
        remote: "https://github.com/EurekaMD-net/x.git",
      });
      expect(JSON.parse(result).error).toContain(
        "primary mission-control checkout",
      );
      expect(mockExec).not.toHaveBeenCalled(); // guard fired before auth / network
    });
  });

  describe("resolveWorkDir path validation", () => {
    it("accepts exact allowed path without trailing slash", async () => {
      mockExec
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor",
      });
      expect(result).toContain("clean");
    });

    it("accepts subdirectory of allowed path", async () => {
      mockExec
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main"); // git branch
      const result = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor/src",
      });
      expect(result).toContain("clean");
    });

    it("accepts a top-level project repo (regression: old enumerated allowlist blocked these)", async () => {
      mockExec
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
      mockExecFile.mockClear();
      mockExecFile
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
      expect(mockExecFile).toHaveBeenCalledWith(
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
      mockExecFile.mockClear();
      mockExecFile.mockReturnValue(
        "https://github.com/EurekaMD-net/trustr",
      );
      const result = await ghRepoCreateTool.execute({ name: "trustr" });
      const ghArgs = mockExecFile.mock.calls[0]?.[1] as string[];
      expect(ghArgs).toContain("--public");
      expect(ghArgs).not.toContain("--source");
      expect(ghArgs).not.toContain("--remote");
      expect(result).not.toContain("Remote 'origin' configured");
    });

    it("refuses a cwd outside the allowed project domain before calling gh", async () => {
      mockExecFile.mockClear();
      const result = await ghRepoCreateTool.execute({
        name: "trustr",
        cwd: "/root/claude-backups/trustr",
      });
      expect(JSON.parse(result).error).toContain("allowed project path");
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it("refuses a cwd that already has an origin WITHOUT calling gh (qa #1: gh creates the repo before checking the local remote)", async () => {
      mockExecFile.mockClear();
      mockExecFile.mockReturnValueOnce(
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
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "gh",
        expect.anything(),
        expect.anything(),
      );
    });

    it("refuses the primary mission-control checkout as cwd before calling gh (qa #4)", async () => {
      mockExecFile.mockClear();
      const result = await ghRepoCreateTool.execute({
        name: "x",
        cwd: "/root/claude/mission-control",
      });
      expect(JSON.parse(result).error).toContain(
        "primary mission-control checkout",
      );
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe("child env is the base allow-list, never the service env (queue 3h)", () => {
    const CANARIES: Record<string, string> = {
      CANARY_API_KEY: "canary-value-1",
      FIREWORKS_API_KEY: "canary-value-2",
      TELEGRAM_BOT_TOKEN: "canary-value-3",
      SOME_UNRELATED_SETTING: "canary-value-4",
    };
    beforeEach(() => {
      for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
      mockExec.mockClear();
      mockExecFileSync.mockClear();
      mockExecFile.mockClear();
    });
    const expectBaseEnv = (opts: unknown) => {
      const env = (opts as { env?: Record<string, string> }).env;
      expect(env).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(env!.PATH).toBe(process.env.PATH);
      expect(env!.HOME).toBe(process.env.HOME);
      expect(env).not.toHaveProperty("GH_TOKEN");
      for (const name of Object.keys(CANARIES))
        expect(env).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toContain("canary-value");
    };

    it("git_status: the exec run() children", async () => {
      mockExec.mockReturnValueOnce("").mockReturnValueOnce("main");
      await gitStatusTool.execute({});
      expect(mockExec).toHaveBeenCalledTimes(2);
      for (const c of mockExec.mock.calls) expectBaseEnv(c[1]);
    });

    it("git_diff: the execFile runArgs() child", async () => {
      mockExecFile.mockReturnValue("diff --git a/x b/x");
      await gitDiffTool.execute({});
      const call = mockExecFile.mock.calls.find((c) => c[0] === "git");
      expect(call).toBeDefined();
      expectBaseEnv(call![2]);
    });

    it("git_push on a non-jarvis branch: `gh repo view` (run) and `git push` (runArgs), no GH_TOKEN", async () => {
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockImplementationOnce(() => {
          throw new Error("error: No such remote 'origin'");
        }) // git remote get-url → none
        .mockReturnValueOnce('{"name":"r"}') // gh repo view o/r
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git remote add origin
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("main -> main"); // git push
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/o/r.git",
      });
      expect(result).toContain("main -> main");
      const view = mockExec.mock.calls.find((c) =>
        String(c[0]).startsWith("gh repo view"),
      );
      expect(view).toBeDefined();
      expectBaseEnv(view![1]);
      const push = mockExecFile.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "push",
      );
      expect(push).toBeDefined();
      expectBaseEnv(push![2]);
    });

    it("getCurrentBranch: the `git branch --show-current` child", () => {
      mockExecFileSync.mockReturnValueOnce("main\n");
      expect(getCurrentBranch("/root/claude/myrepo")).toBe("main");
      const call = mockExecFileSync.mock.calls.at(-1)!;
      expect(call[1]).toEqual(["branch", "--show-current"]);
      expectBaseEnv(call[2]);
    });

    it("gh_repo_create: the runArgs gh child, no GH_TOKEN", async () => {
      mockExecFile.mockReturnValue("https://github.com/o/r");
      await ghRepoCreateTool.execute({ name: "r" });
      const gh = mockExecFile.mock.calls.find((c) => c[0] === "gh");
      expect(gh).toBeDefined();
      expectBaseEnv(gh![2]);
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
      mockExecFile
        .mockReturnValueOnce(
          "https://github.com/kosm1x/agent-controller/pull/42",
        ); // gh pr create
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // getCurrentBranch(workDir)
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // isJarvisBranch → getCurrentBranch
      const result = await ghCreatePrTool.execute({
        title: "Add feature",
        body: "## Summary\nNew feature",
        cwd: "/root/claude/myrepo",
      });
      expect(result).toContain("pull/42");

      const ghCall = mockExecFile.mock.calls.at(-1)!;
      expect(ghCall[0]).toBe("gh");
      const argv = ghCall[1] as string[];
      expect(argv).toContain("--head");
      expect(argv[argv.indexOf("--head") + 1]).toBe("feature-x");
      const opts = ghCall[2] as { cwd: string };
      expect(opts.cwd).toBe("/root/claude/myrepo");
    });

    it("jarvis/* PR: the gh child gets the base + GH_TOKEN only, never the service env (queue 3h)", async () => {
      const canaries: Record<string, string> = {
        CANARY_API_KEY: "canary-value-1",
        FIREWORKS_API_KEY: "canary-value-2",
        TELEGRAM_BOT_TOKEN: "canary-value-3",
        SOME_UNRELATED_SETTING: "canary-value-4",
      };
      for (const [k, v] of Object.entries(canaries)) vi.stubEnv(k, v);
      vi.stubEnv("JARVIS_GH_TOKEN", "canary-gh-token");
      vi.resetModules();
      const { ghCreatePrTool: freshPrTool } = await import("./git.js");
      mockExecFile
        .mockReturnValueOnce("https://github.com/o/r/pull/7"); // gh pr create
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x\n"); // getCurrentBranch(workDir)
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x\n"); // isJarvisBranch → getCurrentBranch
      const result = await freshPrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      });
      expect(result).toContain("pull/7");
      const ghCall = mockExecFile.mock.calls.at(-1)!;
      expect(ghCall[0]).toBe("gh");
      const env = (ghCall[2] as { env: Record<string, string> }).env;
      expect(env).not.toBe(process.env);
      expect(env.GH_TOKEN).toBe("canary-gh-token");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env).not.toHaveProperty("JARVIS_GH_TOKEN");
      for (const name of Object.keys(canaries))
        expect(env).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toContain("canary-value");
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
      const ghCalls = mockExecFile.mock.calls.filter((c) => c[0] === "gh");
      expect(ghCalls).toHaveLength(0);
    });
  });

  // 2026-10-26: execFileSync/execSync held the event loop for the child's whole
  // run (MCEventLoopBlock > 5 s). The mocked children call back on
  // setImmediate, so an immediate queued BEFORE execute() fires before execute
  // settles only if execute really yielded to the event loop. A helper swapped
  // back to a sync call settles in microtasks and puts "done" first.
  describe("children run async — the event loop is never held (MCEventLoopBlock)", () => {
    const yieldsToEventLoop = async (call: () => Promise<string>) => {
      const order: string[] = [];
      setImmediate(() => order.push("tick"));
      const result = await call();
      order.push("done");
      return { order, result };
    };

    it("git_status (run → exec) yields before settling", async () => {
      mockExec.mockReturnValueOnce("").mockReturnValueOnce("main");
      const { order, result } = await yieldsToEventLoop(() =>
        gitStatusTool.execute({}),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("clean");
    });

    it("git_diff (runArgs → execFile) yields before settling", async () => {
      mockExecFile.mockReturnValueOnce("diff --git a/x b/x\n+y");
      const { order, result } = await yieldsToEventLoop(() =>
        gitDiffTool.execute({}),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("+y");
    });

    it("git_commit yields before settling", async () => {
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("[main abc1234] c"); // git commit
      mockExecFileSync.mockReturnValueOnce("main"); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const { order, result } = await yieldsToEventLoop(() =>
        gitCommitTool.execute({ files: ["a.ts"], message: "c" }),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("abc1234");
    });

    it("git_push yields before settling", async () => {
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r — nothing to rebase
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const { order, result } = await yieldsToEventLoop(() =>
        gitPushTool.execute({}),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("ba2005e");
    });

    it("gh_repo_create yields before settling", async () => {
      mockExecFile.mockReturnValueOnce("https://github.com/EurekaMD-net/r");
      const { order, result } = await yieldsToEventLoop(() =>
        ghRepoCreateTool.execute({ name: "r" }),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("EurekaMD-net/r");
    });

    it("gh_create_pr (non-jarvis, runArgs) yields before settling", async () => {
      mockExecFileSync
        .mockReturnValueOnce("feature-x\n") // getCurrentBranch(workDir)
        .mockReturnValueOnce("feature-x\n"); // isJarvisBranch → getCurrentBranch
      mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/1");
      const { order, result } = await yieldsToEventLoop(() =>
        ghCreatePrTool.execute({
          title: "t",
          body: "b",
          cwd: "/root/claude/myrepo",
        }),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("pull/1");
    });

    it("gh_create_pr (jarvis/* GH_TOKEN child) yields before settling", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "tok");
      vi.resetModules();
      const { ghCreatePrTool: freshPrTool } = await import("./git.js");
      mockExecFileSync
        .mockReturnValueOnce("jarvis/feat/x\n") // getCurrentBranch(workDir)
        .mockReturnValueOnce("jarvis/feat/x\n"); // isJarvisBranch → getCurrentBranch
      mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/2");
      const { order, result } = await yieldsToEventLoop(() =>
        freshPrTool.execute({
          title: "t",
          body: "b",
          cwd: "/root/claude/myrepo",
        }),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("pull/2");
      const ghCall = mockExecFile.mock.calls.at(-1)!;
      expect(ghCall[0]).toBe("gh");
      expect((ghCall[2] as { env: Record<string, string> }).env.GH_TOKEN).toBe(
        "tok",
      );
    });

    // Was "spawnSync git ETIMEDOUT" under execFileSync; the async child reports
    // the command line instead (token path redacted — see the W1 test below).
    it('a timed-out push (killed, code null) returns {error: "Command failed: <cmd>\\n"}', async () => {
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      const timeout = Object.assign(
        new Error("Command failed: git push -u origin main\n"),
        { killed: true, code: null, signal: "SIGTERM", stdout: "", stderr: "" },
      );
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r
        .mockReturnValueOnce("") // git status --short
        .mockImplementationOnce(() => {
          throw timeout;
        }); // git push → timed out
      mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
      const result = await gitPushTool.execute({});
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: git push -u origin main\n",
      });
    });

    it("a timed-out run() child (git_status via exec) returns the {error} JSON", async () => {
      mockExec.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: git status --short\n"), {
          killed: true,
          code: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        });
      });
      const result = await gitStatusTool.execute({});
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: git status --short\n",
      });
    });

    it("a non-zero exit (code 1, fatal stderr) reaches the caller unchanged", async () => {
      const msg =
        "Command failed: git commit -m c\nfatal: unable to auto-detect email address";
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockImplementationOnce(() => {
          throw Object.assign(new Error(msg), {
            killed: false,
            code: 1,
            signal: null,
            stdout: "",
            stderr: "fatal: unable to auto-detect email address",
          });
        }); // git commit → exit 1
      mockExecFileSync.mockReturnValueOnce("main"); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await gitCommitTool.execute({
        files: ["a.ts"],
        message: "c",
      });
      expect(JSON.parse(result)).toEqual({ error: msg });
    });

    it("a timed-out jarvis token push never returns the token or the user:token URL (W1)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "ghp_canaryToken123");
      vi.stubEnv("JARVIS_GH_USER", "PiotrCoderDroid");
      vi.resetModules();
      const { gitPushTool: freshPushTool } = await import("./git.js");
      const tokenUrl =
        "https://PiotrCoderDroid:ghp_canaryToken123@github.com/EurekaMD-net/cuatro-flor.git";
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("jarvis/feat/x") // git branch --show-current
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git"); // remote get-url (token path)
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r
        .mockReturnValueOnce("") // git status --short
        .mockImplementationOnce(() => {
          throw Object.assign(
            new Error(`Command failed: git push ${tokenUrl} jarvis/feat/x\n`),
            {
              killed: true,
              code: null,
              signal: "SIGTERM",
              stdout: "",
              stderr: "",
            },
          );
        }); // git push <tokenUrl> → timed out
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x"); // isJarvisBranch → getCurrentBranch
      const result = await freshPushTool.execute({});
      expect(result).not.toContain("ghp_canaryToken123");
      expect(result).not.toContain("PiotrCoderDroid:");
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: git push *** jarvis/feat/x\n",
      });
    });

    it("a failed jarvis gh PR never returns the GH token (W1)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "ghp_canaryToken123");
      vi.resetModules();
      const { ghCreatePrTool: freshPrTool } = await import("./git.js");
      mockExecFileSync
        .mockReturnValueOnce("jarvis/feat/x\n") // getCurrentBranch(workDir)
        .mockReturnValueOnce("jarvis/feat/x\n"); // isJarvisBranch → getCurrentBranch
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(
          new Error(
            "Command failed: gh pr create\nHTTP 401: bad token ghp_canaryToken123",
          ),
          { code: 1, stdout: "", stderr: "HTTP 401: bad token ghp_canaryToken123" },
        );
      });
      const result = await freshPrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      });
      expect(result).not.toContain("ghp_canaryToken123");
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: gh pr create\nHTTP 401: bad token ***",
      });
    });

    it("closes stdin of every run(), runArgs() and jarvis gh child so a prompt fails fast (W3)", async () => {
      mockStdinEnd.mockClear();
      mockExec.mockReturnValueOnce("").mockReturnValueOnce("main");
      await gitStatusTool.execute({}); // 2 × run()
      expect(mockStdinEnd).toHaveBeenCalledTimes(2);

      mockStdinEnd.mockClear();
      mockExecFile.mockReturnValueOnce("diff --git a/x b/x");
      await gitDiffTool.execute({}); // 1 × runArgs()
      expect(mockStdinEnd).toHaveBeenCalledTimes(1);

      vi.stubEnv("JARVIS_GH_TOKEN", "tok");
      vi.resetModules();
      const { ghCreatePrTool: freshPrTool } = await import("./git.js");
      mockStdinEnd.mockClear();
      mockExecFileSync
        .mockReturnValueOnce("jarvis/feat/x\n") // getCurrentBranch(workDir)
        .mockReturnValueOnce("jarvis/feat/x\n"); // isJarvisBranch → getCurrentBranch
      mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/3");
      await freshPrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      }); // 1 × direct execFileAsync("gh")
      expect(mockStdinEnd).toHaveBeenCalledTimes(1);
    });

    describe("awaited steps hold git_push until the child completes (W5)", () => {
      const flush = async (n = 20) => {
        for (let i = 0; i < n; i++)
          await new Promise((r) => setImmediate(r));
      };
      const held = () => {
        let release!: (out: string) => void;
        const promise = new Promise<string>((r) => (release = r));
        return { promise, release };
      };
      const authAndBranch = () =>
        mockExec
          .mockReturnValueOnce("✓ Logged in") // gh auth status
          .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
          .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
          .mockReturnValueOnce("main"); // git branch --show-current

      it("does not settle until `git fetch origin` completes (M2)", async () => {
        authAndBranch();
        const fetch = held();
        mockExecFile.mockClear();
        mockExecFile
          .mockImplementationOnce(() => fetch.promise) // git fetch origin — held open
          .mockReturnValueOnce("") // git branch -r
          .mockReturnValueOnce("") // git status --short
          .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push
        mockExecFileSync.mockReturnValueOnce("main"); // isJarvisBranch → getCurrentBranch
        let settled = false;
        const p = gitPushTool.execute({}).then((r) => {
          settled = true;
          return r;
        });
        await flush();
        expect(settled).toBe(false);
        expect(mockExecFile).toHaveBeenCalledTimes(1); // nothing past the fetch
        fetch.release("");
        expect(await p).toContain("ba2005e");
      });

      it("after a failed rebase, does not settle until `rebase --abort` completes (M1)", async () => {
        authAndBranch();
        const abort = held();
        mockExecFile.mockClear();
        mockExecFile
          .mockReturnValueOnce("") // git fetch origin
          .mockReturnValueOnce("origin/main") // git branch -r
          .mockReturnValueOnce("") // git status --porcelain — clean
          .mockImplementationOnce(() => {
            throw new Error("CONFLICT (content): Merge conflict in a.md");
          }) // git rebase → conflict
          .mockImplementationOnce(() => abort.promise); // git rebase --abort — held open
        let settled = false;
        const p = gitPushTool.execute({}).then((r) => {
          settled = true;
          return r;
        });
        await flush();
        expect(settled).toBe(false);
        expect(mockExecFile.mock.calls.at(-1)![1]).toEqual(["rebase", "--abort"]);
        abort.release("");
        expect(await p).toContain("manual reconcile");
      });
    });
  });
});
