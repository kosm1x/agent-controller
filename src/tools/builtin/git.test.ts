/**
 * Git tool tests — verify arg validation and sensitive file blocking.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// run() → exec, runArgs()/jarvis gh PR → execFile (async since 2026-10-26,
// MCEventLoopBlock); getCurrentBranch stays on execFileSync.
const mockExec = vi.fn().mockReturnValue("");
const mockExecFile = vi.fn().mockReturnValue("");
const mockExecFileSync = vi.fn().mockReturnValue("");
// The protected-file check's own git children (protected-push.ts) are told
// apart by their leading `-c core.hooksPath=/dev/null` and answered here, so
// the tools' own once-queues on mockExecFile stay in order. Default "": a
// repository with no remotes, i.e. not this project.
const mockCheckGit = vi.fn().mockReturnValue("");
const isCheckGit = (args: unknown[]) =>
  args[0] === "git" &&
  (args[1] as string[])[0] === "-c" &&
  (args[1] as string[])[1] === "core.hooksPath=/dev/null";
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
  execFile: asyncChild((...args: unknown[]) =>
    isCheckGit(args) ? mockCheckGit(...args) : mockExecFile(...args),
  ),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Only for the cross-module lock test (jarvis_dev action=status): its
// worktree bootstrap must neither spawn nor symlink; jarvis-self-repair's db
// and shell imports are inert here. Every other fs call is the real one.
vi.mock("fs", async (orig) => {
  const actual = await orig<typeof import("fs")>();
  const wt = "/root/claude/mission-control-jarvis";
  return {
    ...actual,
    existsSync: (p: string) =>
      p === wt || p === `${wt}/node_modules` ? true : actual.existsSync(p),
    symlinkSync: () => {
      throw new Error("test: symlinkSync is not allowed");
    },
  };
});
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));
vi.mock("./shell.js", () => ({ execGroupKill: vi.fn() }));
// Passthrough spy on the per-cwd lock (qa R2 W1): a call means the caller has
// resolved its key and is queued — a deterministic signal, no timers. One
// spy across module registries (tests that resetModules re-run the factory,
// which points it at the newest real lock). The delegate is the spy's
// creation-time implementation, so afterEach's restoreAllMocks keeps it.
const lock = vi.hoisted(() => {
  const real: { fn?: (cwd: string, fn: () => Promise<unknown>) => unknown } =
    {};
  return {
    real,
    spy: vi.fn((cwd: string, fn: () => Promise<unknown>) => real.fn!(cwd, fn)),
  };
});
const lockSpy = lock.spy;
vi.mock("./cwd-lock.js", async (orig) => {
  const actual = await orig<typeof import("./cwd-lock.js")>();
  lock.real.fn = actual.withCwdLock;
  return { ...actual, withCwdLock: lock.spy };
});

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
  // GitHub children run under the agent's own account: its token is
  // configured unless a test says otherwise.
  beforeEach(() => {
    vi.stubEnv("JARVIS_GH_TOKEN", "test-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mockExec.mockReturnValue("");
    mockExecFile.mockReturnValue("");
    mockExecFileSync.mockReturnValue("");
    mockCheckGit.mockReset().mockReturnValue("");
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
      mockExecFileSync.mockReturnValueOnce("main"); // getCurrentBranch (execFileSync)
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
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("[jarvis/feat/jme-phase0 def5678] test"); // git commit
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/jme-phase0"); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      const result = await gitCommitTool.execute({
        files: ["src/foo.ts"],
        message: "test commit",
      });
      expect(result).toContain("def5678");
      const commitCall = mockExecFile.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      );
      expect(commitCall![1]).toContain("--no-verify");
    });

    // Agent commits name the agent as author AND committer, on every branch,
    // whether or not its GitHub token is configured; a commit is local and
    // carries no token.
    it.each([
      ["main", "test-token"],
      ["jarvis/feat/jme-phase0", "test-token"],
      ["main", ""],
    ])("the commit child on %s (token %j) carries the agent identity as author and committer, no token", async (branch, token) => {
      vi.stubEnv("JARVIS_GH_TOKEN", token);
      vi.stubEnv("JARVIS_GH_USER", "agent-bot");
      vi.stubEnv("JARVIS_GH_EMAIL", "agent@example.invalid");
      mockExecFile
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("[x aaa9999] test"); // git commit
      mockExecFileSync.mockReturnValueOnce(branch); // getCurrentBranch
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      expect(
        await gitCommitTool.execute({ files: ["src/foo.ts"], message: "m" }),
      ).toContain("aaa9999");
      const commitCall = mockExecFile.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
      )!;
      expect(commitCall[1]).not.toContain("--author");
      const env = (commitCall[2] as { env: Record<string, string> }).env;
      expect(env).toMatchObject({
        GIT_AUTHOR_NAME: "agent-bot",
        GIT_AUTHOR_EMAIL: "agent@example.invalid",
        GIT_COMMITTER_NAME: "agent-bot",
        GIT_COMMITTER_EMAIL: "agent@example.invalid",
      });
      expect(env).not.toHaveProperty("GH_TOKEN");
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
      const result = await gitPushTool.execute({});
      expect(result).toBe("Already up-to-date — no new commits to push.");
    });

    // A failed token check is a rejected token OR an unreachable GitHub; the
    // result says so and carries gh's first output line, token masked.
    it("a failed token check: could not verify (rejected, or GitHub unreachable), plus gh's first line, token masked", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "ghp_canaryToken123");
      mockExec.mockImplementation(() => {
        throw Object.assign(new Error("Command failed: gh auth status 2>&1"), {
          stdout: "HTTP 401: Bad credentials for ghp_canaryToken123\n  - The token in GH_TOKEN is invalid.",
          stderr: "",
        });
      });
      const { error } = JSON.parse(await gitPushTool.execute({}));
      expect(error).toBe(
        "Could not verify the agent's token with GitHub (rejected, or GitHub unreachable), so nothing was pushed; the operator can check the agent's token. gh said: HTTP 401: Bad credentials for ***",
      );
      expect(error).not.toContain("gh auth login");
    });

    // gh opens its status output with a bare host line; the reason follows.
    it("a token check that cannot reach GitHub: same sentence, and the reason line after gh's host line is reported", async () => {
      mockExec.mockImplementation(() => {
        throw Object.assign(new Error("Command failed: gh auth status 2>&1"), {
          stdout: "github.com\n  X error connecting to api.github.com\n  - check your internet connection",
          stderr: "",
        });
      });
      const { error } = JSON.parse(await gitPushTool.execute({}));
      expect(error).toContain("Could not verify the agent's token with GitHub (rejected, or GitHub unreachable)");
      expect(error).toMatch(/gh said: X error connecting to api\.github\.com$/);
      expect(mockExecFile).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]), expect.anything());
    });

    // GitHub children run under the agent's own account; nothing falls back
    // to a login stored on the host. Without the agent's token nothing is
    // spawned at all.
    it("without the agent's token: one clear refusal and no child process", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "");
      mockExec.mockClear();
      mockExecFile.mockClear();
      const { error } = JSON.parse(await gitPushTool.execute({}));
      expect(error).toContain("JARVIS_GH_TOKEN");
      expect(error).toContain("nothing was sent to GitHub");
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("every GitHub child of the push (auth check, repo check, fetch, push) runs as the agent, on any branch", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "ghp_canaryToken123");
      mockExec.mockClear();
      mockExecFile.mockClear();
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/some-org/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r — empty
        .mockReturnValueOnce("") // git status --short
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main"); // git push
      expect(await gitPushTool.execute({})).toContain("ba2005e");
      const envOf = (o: unknown) => (o as { env: Record<string, string> }).env;
      const github = [
        ...mockExec.mock.calls
          .filter((c) => /^gh /.test(String(c[0])))
          .map((c) => envOf(c[1])),
        ...mockExecFile.mock.calls
          .filter((c) => ["fetch", "push"].includes((c[1] as string[])[0]))
          .map((c) => envOf(c[2])),
      ];
      expect(github).toHaveLength(4);
      for (const env of github) {
        expect(env.GH_TOKEN).toBe("ghp_canaryToken123");
        expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
        expect(env.GIT_CONFIG_VALUE_0).toBe("");
        expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env).not.toHaveProperty("JARVIS_GH_TOKEN");
      }
      // The push is the plain named-remote push; the token is in no argv.
      const push = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])[0] === "push",
      )!;
      expect(push[1]).toEqual(["push", "-u", "origin", "main"]);
      const argvs = JSON.stringify([
        ...mockExec.mock.calls.map((c) => c[0]),
        ...mockExecFile.mock.calls.map((c) => c[1]),
      ]);
      expect(argvs).not.toContain("ghp_canaryToken123");
      // Local children carry no token.
      const local = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])[0] === "status",
      )!;
      expect(envOf(local[2])).not.toHaveProperty("GH_TOKEN");
    });

    it("a push GitHub refuses for lack of write access: one sentence naming the operator's invitation, no other route", async () => {
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/someone/elsewhere.git") // git remote get-url
        .mockReturnValueOnce('{"name":"elsewhere"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockReturnValueOnce("") // git fetch origin
        .mockReturnValueOnce("") // git branch -r — empty
        .mockReturnValueOnce("") // git status --short
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("Command failed: git push -u origin main"), {
            stderr:
              "remote: Permission to someone/elsewhere.git denied to agent-bot.\nfatal: unable to access 'https://github.com/someone/elsewhere.git/': The requested URL returned error: 403",
          });
        }); // git push
      const { error } = JSON.parse(await gitPushTool.execute({}));
      expect(error).toBe(
        "GitHub refused this: the agent's GitHub account has no write access to someone/elsewhere; the operator can invite that account to it.",
      );
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
      // Leads with the access sentence; creating a repository is not offered.
      expect(error).toMatch(
        /^The agent's GitHub account has no access to \S+\/ghost \(the operator can invite the account to it\)/,
      );
      expect(error).not.toContain("gh_repo_create");
      expect(error).not.toMatch(/creat/i);
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
        .mockReturnValue("https://github.com/agent-bot/trustr"); // gh repo create
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
          "trustr",
          "--private",
          "--source",
          expect.stringContaining("/root/claude/trustr"),
          "--remote",
          "origin",
        ]),
        expect.anything(),
      );
      expect(result).toContain("https://github.com/agent-bot/trustr");
      expect(result).toContain("origin");
      expect(result).toContain("git_push");
    });

    it("without cwd, creates the GitHub repo only (no --source) and says so", async () => {
      mockExecFile.mockClear();
      mockExecFile.mockReturnValue(
        "https://github.com/agent-bot/trustr",
      );
      const result = await ghRepoCreateTool.execute({ name: "trustr" });
      const ghArgs = mockExecFile.mock.calls[0]?.[1] as string[];
      expect(ghArgs).toContain("--public");
      expect(ghArgs).not.toContain("--source");
      expect(ghArgs).not.toContain("--remote");
      expect(result).not.toContain("Remote 'origin' configured");
    });

    // A name without an owner goes to the agent's own account; the result
    // says where the repository was created.
    it("a name without an owner: gh gets the bare name, runs as the agent, and the result names the agent's account", async () => {
      vi.stubEnv("JARVIS_GH_USER", "agent-bot");
      mockExecFile.mockClear();
      mockExecFile.mockReturnValue("https://github.com/agent-bot/r");
      const result = await ghRepoCreateTool.execute({ name: "r" });
      const gh = mockExecFile.mock.calls.find((c) => c[0] === "gh")!;
      expect((gh[1] as string[]).slice(0, 3)).toEqual(["repo", "create", "r"]);
      expect((gh[2] as { env: Record<string, string> }).env.GH_TOKEN).toBe(
        "test-token",
      );
      expect(result).toContain(
        "The repository was created under the agent's own GitHub account (agent-bot).",
      );
    });

    it("an explicit owner/name is passed through and the result names that owner", async () => {
      mockExecFile.mockClear();
      mockExecFile.mockReturnValue("https://github.com/some-org/r");
      const result = await ghRepoCreateTool.execute({ name: "some-org/r" });
      const gh = mockExecFile.mock.calls.find((c) => c[0] === "gh")!;
      expect((gh[1] as string[])[2]).toBe("some-org/r");
      expect(result).toContain("The repository was created under some-org.");
    });

    // An explicit owner that is the agent's own account (any case) is the
    // agent's own account: same result sentence, same refusal wording.
    it("an owner equal to the agent's own account: the result names the agent's own account", async () => {
      vi.stubEnv("JARVIS_GH_USER", "agent-bot");
      mockExecFile.mockClear();
      mockExecFile.mockReturnValue("https://github.com/agent-bot/r");
      const result = await ghRepoCreateTool.execute({ name: "Agent-Bot/r" });
      expect(result).toContain(
        "The repository was created under the agent's own GitHub account (agent-bot).",
      );
      expect(result).not.toContain("created under Agent-Bot");
    });

    it("an owner equal to the agent's own account: a refusal says the token may lack the permission, never an invitation", async () => {
      vi.stubEnv("JARVIS_GH_USER", "agent-bot");
      mockExecFile.mockClear();
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: gh repo create AGENT-BOT/r"), {
          stderr: "GraphQL: Resource not accessible by personal access token (createRepository)",
        });
      });
      const { error } = JSON.parse(await ghRepoCreateTool.execute({ name: "AGENT-BOT/r" }));
      expect(error).toBe(
        "GitHub refused this: the agent's token may lack the permission to create repositories under its own account; the operator can check the agent's token.",
      );
    });

    it("an owner the agent's account cannot create under: one sentence naming the operator's invitation", async () => {
      mockExecFile.mockClear();
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: gh repo create some-org/r"), {
          stderr: "GraphQL: agent-bot cannot create a repository for some-org. (createRepository)",
        });
      });
      const { error } = JSON.parse(
        await ghRepoCreateTool.execute({ name: "some-org/r" }),
      );
      expect(error).toBe(
        "GitHub refused this: the agent's GitHub account has no write access to some-org; the operator can invite that account to it.",
      );
    });

    // Under the agent's own account nobody can be invited: the refusal says
    // the token may lack the permission to create repositories.
    it("a refusal under the agent's own account: the token may lack the permission, never an invitation", async () => {
      mockExecFile.mockClear();
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: gh repo create r"), {
          stderr: "GraphQL: Resource not accessible by personal access token (createRepository)",
        });
      });
      const { error } = JSON.parse(await ghRepoCreateTool.execute({ name: "r" }));
      expect(error).toBe(
        "GitHub refused this: the agent's token may lack the permission to create repositories under its own account; the operator can check the agent's token.",
      );
      expect(error).not.toContain("invite");
    });

    it("a non-access failure that echoes the agent's token: the error is returned with the token masked", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "canary-gh-token");
      mockExecFile.mockClear();
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(
          new Error("Command failed: gh repo create r\nunexpected answer for canary-gh-token"),
          { stderr: "unexpected answer for canary-gh-token" },
        );
      });
      const result = await ghRepoCreateTool.execute({ name: "r" });
      expect(result).not.toContain("canary-gh-token");
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: gh repo create r\nunexpected answer for ***",
      });
    });

    it("without the agent's token: refused before gh runs", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "");
      mockExecFile.mockClear();
      const { error } = JSON.parse(await ghRepoCreateTool.execute({ name: "r" }));
      expect(error).toContain("JARVIS_GH_TOKEN");
      expect(mockExecFile.mock.calls.some((c) => c[0] === "gh")).toBe(false);
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

  // Every child gets the base allow-list, never the service env. Local
  // children carry no GitHub token; GitHub children add only the agent's
  // own token (as GH_TOKEN) to that base; children get no stored login by
  // default (empty GH_CONFIG_DIR, credential helpers reset).
  describe("child env is the base allow-list, never the service env (queue 3h)", () => {
    const CANARIES: Record<string, string> = {
      CANARY_API_KEY: "canary-value-1",
      FIREWORKS_API_KEY: "canary-value-2",
      TELEGRAM_BOT_TOKEN: "canary-value-3",
      SOME_UNRELATED_SETTING: "canary-value-4",
    };
    beforeEach(() => {
      for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
      vi.stubEnv("JARVIS_GH_TOKEN", "canary-gh-token");
      mockExec.mockClear();
      mockExecFileSync.mockClear();
      mockExecFile.mockClear();
    });
    const expectAllowListed = (env: Record<string, string> | undefined) => {
      expect(env).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(env!.PATH).toBe(process.env.PATH);
      expect(env!.HOME).toBe(process.env.HOME);
      expect(env!.GH_CONFIG_DIR).toMatch(/mc-gh-config-/);
      expect(env!.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(env!.GIT_CONFIG_VALUE_0).toBe("");
      expect(env).not.toHaveProperty("JARVIS_GH_TOKEN");
      for (const name of Object.keys(CANARIES))
        expect(env).not.toHaveProperty(name);
      expect(JSON.stringify(env)).not.toContain("canary-value");
    };
    /** A local child: the base, no token. */
    const expectBaseEnv = (opts: unknown) => {
      const env = (opts as { env?: Record<string, string> }).env;
      expectAllowListed(env);
      expect(env).not.toHaveProperty("GH_TOKEN");
      expect(JSON.stringify(env)).not.toContain("canary-gh-token");
    };
    /** A GitHub child: the base plus the agent's token as GH_TOKEN only. */
    const expectAgentEnv = (opts: unknown) => {
      const env = (opts as { env?: Record<string, string> }).env;
      expectAllowListed(env);
      expect(env!.GH_TOKEN).toBe("canary-gh-token");
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

    it("git_push on a non-jarvis branch: `gh repo view` (run) and `git push` (runArgs) get the agent's token, `git remote add` does not", async () => {
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
      const result = await gitPushTool.execute({
        cwd: "/root/claude/trustr",
        remote: "https://github.com/o/r.git",
      });
      expect(result).toContain("main -> main");
      const view = mockExec.mock.calls.find((c) =>
        String(c[0]).startsWith("gh repo view"),
      );
      expect(view).toBeDefined();
      expectAgentEnv(view![1]);
      const push = mockExecFile.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "push",
      );
      expect(push).toBeDefined();
      expectAgentEnv(push![2]);
      const add = mockExecFile.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "remote",
      );
      expectBaseEnv(add![2]);
    });

    it("getCurrentBranch: the `git branch --show-current` child", () => {
      mockExecFileSync.mockReturnValueOnce("main\n");
      expect(getCurrentBranch("/root/claude/myrepo")).toBe("main");
      const call = mockExecFileSync.mock.calls.at(-1)!;
      expect(call[1]).toEqual(["branch", "--show-current"]);
      expectBaseEnv(call[2]);
    });

    it("gh_repo_create: the runArgs gh child gets the agent's token", async () => {
      mockExecFile.mockReturnValue("https://github.com/o/r");
      await ghRepoCreateTool.execute({ name: "r" });
      const gh = mockExecFile.mock.calls.find((c) => c[0] === "gh");
      expect(gh).toBeDefined();
      expectAgentEnv(gh![2]);
    });

    it("gh_create_pr on any branch: the gh child gets the agent's token", async () => {
      for (const branch of ["feature-x", "jarvis/feat/x"]) {
        mockExecFile.mockClear();
        mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/7");
        mockExecFileSync.mockReturnValueOnce(`${branch}\n`);
        expect(
          await ghCreatePrTool.execute({
            title: "t",
            body: "b",
            cwd: "/root/claude/myrepo",
          }),
        ).toContain("pull/7");
        const gh = mockExecFile.mock.calls.find((c) => c[0] === "gh")!;
        expectAgentEnv(gh[2]);
      }
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

    it("without the agent's token: refused before gh runs", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "");
      mockExecFile.mockClear();
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // getCurrentBranch(workDir)
      const { error } = JSON.parse(
        await ghCreatePrTool.execute({
          title: "t",
          body: "b",
          cwd: "/root/claude/myrepo",
        }),
      );
      expect(error).toContain("JARVIS_GH_TOKEN");
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    // The access answer is read from gh's stderr only: the error message
    // embeds the argv, so a body that mentions "403" is the caller's text.
    it("a pull-request body that mentions 403 does not turn a failure into a no-access refusal", async () => {
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(
          new Error("Command failed: gh pr create --title t --body fixes the HTTP 403 on login"),
          { stderr: "pull request create failed: GraphQL: Head sha can't be blank (createPullRequest)" },
        );
      });
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // getCurrentBranch(workDir)
      const { error } = JSON.parse(
        await ghCreatePrTool.execute({
          title: "t",
          body: "fixes the HTTP 403 on login",
          cwd: "/root/claude/myrepo",
        }),
      );
      expect(error).not.toContain("no write access");
      expect(error).toContain("Command failed: gh pr create");
    });

    it("a rate-limit answer (a 403 too) is not a no-access refusal", async () => {
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: gh pr create"), {
          stderr: "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)",
        });
      });
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // getCurrentBranch(workDir)
      const { error } = JSON.parse(
        await ghCreatePrTool.execute({ title: "t", body: "b", cwd: "/root/claude/myrepo" }),
      );
      expect(error).not.toContain("no write access");
      expect(error).toBe("Command failed: gh pr create");
    });

    it("a pull request GitHub refuses for lack of access: one sentence naming the operator's invitation", async () => {
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: gh pr create"), {
          stderr:
            "pull request create failed: GraphQL: Resource not accessible by personal access token (createPullRequest)",
        });
      });
      mockExecFileSync.mockReturnValueOnce("feature-x\n"); // getCurrentBranch(workDir)
      const { error } = JSON.parse(
        await ghCreatePrTool.execute({
          title: "t",
          body: "b",
          cwd: "/root/claude/myrepo",
        }),
      );
      expect(error).toBe(
        "GitHub refused this: the agent's GitHub account has no write access to the repository in /root/claude/myrepo; the operator can invite that account to it.",
      );
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
      const { order, result } = await yieldsToEventLoop(() =>
        gitPushTool.execute({}),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("ba2005e");
    });

    it("gh_repo_create yields before settling", async () => {
      mockExecFile.mockReturnValueOnce("https://github.com/agent-bot/r");
      const { order, result } = await yieldsToEventLoop(() =>
        ghRepoCreateTool.execute({ name: "r" }),
      );
      expect(order).toEqual(["tick", "done"]);
      expect(result).toContain("agent-bot/r");
    });

    it("gh_create_pr (runArgs, the agent's token) yields before settling", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "tok");
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x\n"); // getCurrentBranch(workDir)
      mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/2");
      const { order, result } = await yieldsToEventLoop(() =>
        ghCreatePrTool.execute({
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
    // the command line instead (the token is in no command line; redaction
    // is tested below).
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

    // The agent's token reaches git only through the child env and the
    // github.com credential helper (src/lib/github-authority.ts), never an
    // argv or a URL, so `ps` and an async error's command line cannot carry
    // it; redaction is defence in depth. The real-git check of the helper
    // lives in github-authority.test.ts.
    describe("the agent's token never enters a command line (4ao e)", () => {
      const TOKEN = "ghp_canaryToken123";
      const pushSetup = (branch = "jarvis/feat/x") => {
        vi.stubEnv("JARVIS_GH_TOKEN", TOKEN);
        vi.stubEnv("JARVIS_GH_USER", "PiotrCoderDroid");
        mockExec
          .mockReturnValueOnce("✓ Logged in") // gh auth status
          .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
          .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
          .mockReturnValueOnce(branch); // git branch --show-current
        mockExecFile.mockClear();
      };
      const pushCall = () =>
        mockExecFile.mock.calls.find(
          (c) => c[0] === "git" && (c[1] as string[]).includes("push"),
        )!;

      it("pushes to the named remote; the token is only in the child env, the helper only names it", async () => {
        pushSetup();
        mockStdinEnd.mockClear();
        mockExecFile
          .mockReturnValueOnce("") // git fetch origin
          .mockReturnValueOnce("") // git branch -r
          .mockReturnValueOnce("") // git status --short
          .mockReturnValueOnce("abc..def jarvis/feat/x -> jarvis/feat/x"); // git push
        const result = await gitPushTool.execute({});
        expect(result).toContain("-> jarvis/feat/x");
        const [cmd, argv, opts] = pushCall() as [
          string,
          string[],
          { env: Record<string, string> },
        ];
        expect(cmd).toBe("git");
        expect(argv).toEqual(["push", "-u", "origin", "jarvis/feat/x"]);
        // No argv word carries the token or a user:secret@ URL.
        expect(JSON.stringify(argv)).not.toContain(TOKEN);
        expect(argv.some((a) => /:\/\/[^/]*@/.test(a))).toBe(false);
        // The helper names the env vars; the values live only in the env.
        expect(opts.env.GIT_CONFIG_VALUE_1).toContain('"$GH_TOKEN"');
        expect(opts.env.GIT_CONFIG_VALUE_1).not.toContain(TOKEN);
        expect(opts.env.GH_TOKEN).toBe(TOKEN);
        expect(opts.env.JARVIS_GH_USER).toBe("PiotrCoderDroid");
        expect(opts.env).not.toHaveProperty("JARVIS_GH_TOKEN");
        expect(opts.env).not.toBe(process.env);
        // Every child, the push included, had stdin closed.
        expect(mockStdinEnd).toHaveBeenCalledTimes(
          mockExec.mock.calls.length +
            mockExecFile.mock.calls.length +
            mockCheckGit.mock.calls.length,
        );
      });

      it("a timed-out push returns the token-free command line; a token echoed in stderr is still masked", async () => {
        pushSetup();
        mockExecFile
          .mockReturnValueOnce("") // git fetch origin
          .mockReturnValueOnce("") // git branch -r
          .mockReturnValueOnce("") // git status --short
          .mockImplementationOnce((file: unknown, args: unknown) => {
            // Node's async error: "Command failed: <file> <args…>".
            throw Object.assign(
              new Error(
                `Command failed: ${file} ${(args as string[]).join(" ")}\nremote: bad credentials ${TOKEN}`,
              ),
              { killed: true, code: null, signal: "SIGTERM", stdout: "", stderr: "" },
            );
          }); // git push → timed out
        const result = await gitPushTool.execute({});
        expect(result).not.toContain(TOKEN);
        expect(result).not.toContain("PiotrCoderDroid:");
        const { error } = JSON.parse(result) as { error: string };
        expect(error).toContain("push -u origin jarvis/feat/x");
        expect(error).toContain("remote: bad credentials ***");
      });
    });

    it("a failed gh PR never returns the agent's token (W1)", async () => {
      vi.stubEnv("JARVIS_GH_TOKEN", "ghp_canaryToken123");
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x\n"); // getCurrentBranch(workDir)
      mockExecFile.mockImplementationOnce(() => {
        throw Object.assign(
          new Error(
            "Command failed: gh pr create\nHTTP 401: bad token ghp_canaryToken123",
          ),
          { code: 1, stdout: "", stderr: "HTTP 401: bad token ghp_canaryToken123" },
        );
      });
      const result = await ghCreatePrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      });
      expect(result).not.toContain("ghp_canaryToken123");
      expect(JSON.parse(result)).toEqual({
        error: "Command failed: gh pr create\nHTTP 401: bad token ***",
      });
    });

    it("closes stdin of every run() and runArgs() child, the gh ones included, so a prompt fails fast (W3)", async () => {
      mockStdinEnd.mockClear();
      mockExec.mockReturnValueOnce("").mockReturnValueOnce("main");
      await gitStatusTool.execute({}); // 2 × run()
      expect(mockStdinEnd).toHaveBeenCalledTimes(2);

      mockStdinEnd.mockClear();
      mockExecFile.mockReturnValueOnce("diff --git a/x b/x");
      await gitDiffTool.execute({}); // 1 × runArgs()
      expect(mockStdinEnd).toHaveBeenCalledTimes(1);

      mockStdinEnd.mockClear();
      mockCheckGit.mockClear();
      mockExecFileSync.mockReturnValueOnce("jarvis/feat/x\n"); // getCurrentBranch(workDir)
      mockExecFile.mockReturnValueOnce("https://github.com/o/r/pull/3");
      await ghCreatePrTool.execute({
        title: "t",
        body: "b",
        cwd: "/root/claude/myrepo",
      }); // 1 × runArgs("gh"), plus the protected-file check's scope read
      expect(mockStdinEnd).toHaveBeenCalledTimes(
        1 + mockCheckGit.mock.calls.length,
      );
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
        let settled = false;
        const p = gitPushTool.execute({}).then((r) => {
          settled = true;
          return r;
        });
        // The lock key walk is real async fs: wait for the fetch to spawn.
        await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(1));
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
        await vi.waitFor(() =>
          expect(mockExecFile.mock.calls.at(-1)?.[1]).toEqual([
            "rebase",
            "--abort",
          ]),
        );
        await flush();
        expect(settled).toBe(false);
        expect(mockExecFile.mock.calls.at(-1)![1]).toEqual(["rebase", "--abort"]);
        abort.release("");
        expect(await p).toContain("manual reconcile");
      });
    });
  });

  // Queue 4ao (f)(ii): async children made multi-step sequences interleavable
  // on one worktree. Each git tool's execute now runs under a per-cwd lock.
  describe("per-cwd lock around each git tool's execute (4ao f)", () => {
    const flush = async (n = 20) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    };
    // The key walk is real async fs: positive checks wait for the spawn, and
    // a negative check first waits until the second caller is IN the lock
    // (its lockSpy call), then flushes, then asserts (qa R2 W1).
    const queued = async (n: number) =>
      vi.waitFor(() => expect(lockSpy).toHaveBeenCalledTimes(n));
    beforeEach(() => {
      lockSpy.mockClear();
    });
    const held = () => {
      let release!: (out: string) => void;
      const promise = new Promise<string>((r) => (release = r));
      return { promise, release };
    };

    it("a second tool call on the SAME cwd spawns nothing until the first settles", async () => {
      mockExec.mockClear();
      mockExecFile.mockClear();
      const fetch = held();
      mockExec
        .mockReturnValueOnce("✓ Logged in") // gh auth status
        .mockReturnValueOnce("https://github.com/EurekaMD-net/cuatro-flor.git") // git remote get-url
        .mockReturnValueOnce('{"name":"cuatro-flor"}') // gh repo view
        .mockReturnValueOnce("main"); // git branch --show-current
      mockExecFile
        .mockImplementationOnce(() => fetch.promise) // push: git fetch origin — held
        .mockReturnValueOnce("") // push: git branch -r
        .mockReturnValueOnce("") // push: git status --short
        .mockReturnValueOnce("5b0cc1a..ba2005e main -> main") // push: git push
        .mockReturnValueOnce("") // commit: git add
        .mockReturnValueOnce("[main abc1234] c"); // commit: git commit
      mockExecFileSync.mockReturnValueOnce("main"); // commit: getCurrentBranch
      const push = gitPushTool.execute({ cwd: "/root/claude/cuatro-flor" });
      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(1)); // the held fetch
      const commit = gitCommitTool.execute({
        files: ["a.ts"],
        message: "c",
        cwd: "/root/claude/cuatro-flor/", // same cwd, trailing slash
      });
      await queued(2);
      expect(lockSpy.mock.calls[1][0]).toBe(lockSpy.mock.calls[0][0]);
      await flush();
      // The commit has not staged anything while the push sequence is open.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const execBefore = mockExec.mock.calls.length;
      mockExec.mockReturnValueOnce("1 file changed"); // commit: git diff --cached --stat
      fetch.release("");
      expect(await push).toContain("ba2005e");
      expect(await commit).toContain("abc1234");
      const argv = mockExecFile.mock.calls.map((c) => (c[1] as string[])[0]);
      expect(argv).toEqual(["fetch", "branch", "status", "push", "add", "commit"]);
      expect(mockExec.mock.calls.length).toBe(execBefore + 1);
    });

    it("a call on a DIFFERENT cwd runs while the first is held", async () => {
      mockExecFile.mockClear();
      const diff = held();
      mockExecFile
        .mockImplementationOnce(() => diff.promise) // git diff in repo A — held
        .mockReturnValueOnce("diff --git a/b b/b\n+b"); // git diff in repo B
      const a = gitDiffTool.execute({ cwd: "/root/claude/cuatro-flor" });
      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(1));
      const b = await gitDiffTool.execute({ cwd: "/root/claude/trustr" });
      expect(b).toContain("+b");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      diff.release("diff --git a/a b/a\n+a");
      expect(await a).toContain("+a");
    });

    it("a subdirectory cwd and its repository root share one lock (qa R1 W2)", async () => {
      const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import(
        "fs"
      );
      const { tmpdir } = await import("os");
      const repo = mkdtempSync(`${tmpdir()}/lock-repo-`);
      mkdirSync(`${repo}/.git`);
      mkdirSync(`${repo}/src/deep`, { recursive: true });
      try {
        for (const m of [mockExec, mockExecFile, mockExecFileSync])
          m.mockReset().mockReturnValue("");
        const diff = held();
        mockExecFile
          .mockImplementationOnce(() => diff.promise) // git diff at the root — held
          .mockReturnValueOnce("") // git add (from src/deep)
          .mockReturnValueOnce("[main abc1234] c"); // git commit
        mockExecFileSync.mockReturnValueOnce("main"); // commit: getCurrentBranch
        const a = gitDiffTool.execute({ cwd: repo });
        await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(1));
        const b = gitCommitTool.execute({
          files: ["a.ts"],
          message: "c",
          cwd: `${repo}/src/deep`,
        });
        await queued(2);
        // Both callers keyed on the repository root — no timing involved.
        expect(lockSpy.mock.calls[0][0]).toBe(realpathSync(repo));
        expect(lockSpy.mock.calls[1][0]).toBe(realpathSync(repo));
        await flush();
        expect(mockExecFile).toHaveBeenCalledTimes(1); // no `git add` yet
        mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
        diff.release("diff --git a/a b/a\n+a");
        expect(await a).toContain("+a");
        expect(await b).toContain("abc1234");
        expect(
          mockExecFile.mock.calls.map((c) => (c[1] as string[])[0]),
        ).toEqual(["diff", "add", "commit"]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("git_commit on the jarvis worktree waits behind jarvis_dev action=status (shared key, qa R1 R2)", async () => {
      // Both from the CURRENT module registry (earlier tests resetModules), so
      // they share one cwd-lock instance, as in production.
      const { jarvisDevTool } = await import("./jarvis-dev.js");
      const { gitCommitTool: commitTool } = await import("./git.js");
      // Reset, not clear: drop once-values an earlier test left queued.
      for (const m of [mockExec, mockExecFile, mockExecFileSync])
        m.mockReset().mockReturnValue("");
      // resolveWorkDir's branch guard on the worktree + git_commit's own read.
      mockExecFileSync.mockReturnValue("jarvis/feat/x");
      const branchRead = held();
      mockExecFile
        .mockImplementationOnce(() => branchRead.promise) // status: git branch --show-current — held
        .mockReturnValueOnce("") // status: git status --porcelain
        .mockReturnValueOnce("") // status: git diff --stat
        .mockReturnValueOnce("") // commit: git add
        .mockReturnValueOnce("[jarvis/feat/x abc1234] c"); // commit: git commit
      const status = jarvisDevTool.execute({ action: "status" });
      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalledTimes(1));
      const commit = commitTool.execute({
        files: ["a.ts"],
        message: "c",
        cwd: "/root/claude/mission-control-jarvis",
      });
      await queued(2);
      // jarvis_dev (MC_DIR) and git_commit (repo root) share one key.
      expect(lockSpy.mock.calls.map((c) => c[0])).toEqual([
        "/root/claude/mission-control-jarvis",
        "/root/claude/mission-control-jarvis",
      ]);
      await flush();
      expect(mockExecFile).toHaveBeenCalledTimes(1); // commit staged nothing
      expect(mockExec).not.toHaveBeenCalled();
      mockExec.mockReturnValueOnce("1 file changed"); // git diff --cached --stat
      branchRead.release("jarvis/feat/x");
      expect(JSON.parse(await status).branch).toBe("jarvis/feat/x");
      expect(await commit).toContain("abc1234");
      expect(
        mockExecFile.mock.calls.map((c) => (c[1] as string[])[0]),
      ).toEqual(["branch", "status", "diff", "add", "commit"]);
    });

    it("a failed call releases the cwd for the next one", async () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error("Command failed: git status --short\n");
      });
      const first = await gitStatusTool.execute({
        cwd: "/root/claude/cuatro-flor",
      });
      expect(JSON.parse(first).error).toContain("git status");
      mockExec.mockReturnValueOnce("").mockReturnValueOnce("main");
      expect(
        await gitStatusTool.execute({ cwd: "/root/claude/cuatro-flor" }),
      ).toContain("clean");
    });
  });

  // The protected-file list holds at the push and at the pull request too:
  // a branch of this project (a checkout root, or any clone whose remotes name
  // the project) that changes a protected path is refused there and nothing
  // is sent. Other repositories are not checked.
  describe("protected files are checked again at the push and the pull request", () => {
    const WT = "/root/claude/mission-control-jarvis";
    const CLONE = "/root/claude/some-clone";
    const BASE = "b".repeat(40);
    const PROJECT_URL = "https://github.com/kosm1x/agent-controller.git";
    const sent = (verb: string) =>
      mockExecFile.mock.calls.some(
        (c) => c[0] === "git" && (c[1] as string[]).includes(verb),
      );
    const ghCalled = () => mockExecFile.mock.calls.some((c) => c[0] === "gh");
    /** The check's git subcommands, in order (after `-c core.hooksPath=/dev/null`). */
    const checkVerbs = () =>
      mockCheckGit.mock.calls.map((c) => (c[1] as string[])[2]);
    /**
     * Answers for a branch on `branch`: the tools' own git/gh children, and the
     * check's (remotes all `remoteUrl`, merge base `mergeBase`, changed paths
     * `diff`). `listingFails` makes the path listing fail after the merge base.
     */
    const answer = (
      diff: string,
      opts: {
        branch?: string;
        remoteUrl?: string;
        mergeBase?: string | Error;
        listingFails?: boolean;
        remoteNames?: string;
        urlReadFails?: boolean;
        fetchError?: Error;
      } = {},
    ) => {
      const branch = opts.branch ?? "jarvis/feat/x";
      const remoteUrl = opts.remoteUrl ?? PROJECT_URL;
      for (const m of [mockExec, mockExecFile, mockExecFileSync, mockCheckGit])
        m.mockReset().mockReturnValue("");
      mockExecFileSync.mockReturnValue(`${branch}\n`);
      mockExec.mockImplementation((cmd: unknown) => {
        const c = String(cmd);
        if (c.startsWith("gh auth status")) return "✓ Logged in";
        if (c.startsWith("git remote get-url")) return remoteUrl;
        if (c.startsWith("gh repo view")) return '{"name":"agent-controller"}';
        if (c.startsWith("git branch --show-current")) return branch;
        return "";
      });
      mockExecFile.mockImplementation((cmd: unknown, args: unknown) => {
        const a = args as string[];
        if (cmd === "gh") return "https://github.com/kosm1x/agent-controller/pull/5";
        if (a[0] === "push") return `abc..def ${branch} -> ${branch}`;
        return "";
      });
      mockCheckGit.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]).slice(2);
        if (a[0] === "rev-parse") return ".git\n";
        if (a[0] === "remote" && a.length === 1)
          return opts.remoteNames ?? "origin\n";
        if (opts.urlReadFails && (a[0] === "ls-remote" || a[0] === "remote"))
          throw new Error("error: could not read the remote");
        if (a[0] === "ls-remote") return `${remoteUrl}\n`;
        if (a[0] === "fetch" && opts.fetchError) throw opts.fetchError;
        if (a[0] === "remote") return `${remoteUrl}\n`;
        if (a[0] === "symbolic-ref") return `refs/heads/${branch}\n`;
        if (a[0] === "merge-base") {
          const mb = opts.mergeBase ?? `${BASE}\n`;
          if (mb instanceof Error) throw mb;
          return mb;
        }
        if (a[0] === "diff") {
          if (opts.listingFails)
            throw new Error("fatal: bad object " + BASE);
          return diff;
        }
        return "";
      });
    };

    it("git_push in the jarvis worktree: a branch that changes protected files is refused and nothing is pushed", async () => {
      answer("src/index.ts\0.github/workflows/ci.yml\0docs/a.md\0");
      const out = JSON.parse(await gitPushTool.execute({ cwd: WT }));
      expect(out.error).toContain("src/index.ts");
      expect(out.error).toContain(".github/workflows/ci.yml");
      expect(out.error).not.toContain("docs/a.md");
      expect(out.error).toContain("operator session");
      expect(sent("push")).toBe(false);
    });

    it("git_push in the jarvis worktree: a branch of ordinary files is pushed after the check", async () => {
      answer("docs/a.md\0");
      expect(await gitPushTool.execute({ cwd: WT })).toContain(
        "-> jarvis/feat/x",
      );
      expect(checkVerbs()).toContain("merge-base");
      expect(checkVerbs()).toContain("diff");
    });

    it("git_push in the jarvis worktree: when the merge base cannot be computed the push is refused", async () => {
      answer("", {
        mergeBase: new Error("fatal: Not a valid object name refs/remotes/origin/main"),
      });
      const out = JSON.parse(await gitPushTool.execute({ cwd: WT }));
      expect(out.error).toContain("could not run");
      expect(sent("push")).toBe(false);
    });

    it("git_push: a merge base that is not a commit id is refused as unverifiable", async () => {
      answer("", { mergeBase: "not-a-commit-id\n" });
      const out = JSON.parse(await gitPushTool.execute({ cwd: WT }));
      expect(out.error).toContain("could not run");
      expect(sent("push")).toBe(false);
    });

    it("git_push: a path listing that fails after the merge base is refused as unverifiable", async () => {
      answer("", { listingFails: true });
      const out = JSON.parse(await gitPushTool.execute({ cwd: WT }));
      expect(out.error).toContain("could not run");
      expect(sent("push")).toBe(false);
    });

    it("git_push in another repository: the check is not applied", async () => {
      answer("src/index.ts\0", {
        remoteUrl: "https://github.com/EurekaMD-net/cuatro-flor.git",
      });
      expect(
        await gitPushTool.execute({ cwd: "/root/claude/cuatro-flor" }),
      ).toContain("-> jarvis/feat/x");
      expect(checkVerbs()).not.toContain("merge-base");
    });

    it("git_push from a clone of this project outside the checkout roots: a protected change is refused", async () => {
      answer("src/index.ts\0");
      const out = JSON.parse(await gitPushTool.execute({ cwd: CLONE }));
      expect(out.error).toContain("src/index.ts");
      expect(sent("push")).toBe(false);
    });

    it("git_push from a clone of this project outside the checkout roots: the default branch is refused", async () => {
      answer("", { branch: "main" });
      const out = JSON.parse(await gitPushTool.execute({ cwd: CLONE }));
      expect(out.error).toContain("Pushing to main on mission-control is blocked");
      expect(sent("push")).toBe(false);
    });

    it("git_push of another project's default branch: unchanged, it is pushed", async () => {
      answer("", {
        branch: "main",
        remoteUrl: "https://github.com/EurekaMD-net/cuatro-flor.git",
      });
      expect(
        await gitPushTool.execute({ cwd: "/root/claude/cuatro-flor" }),
      ).toContain("-> main");
    });

    it("git_push of the default branch when the remotes cannot be read: refused", async () => {
      answer("", { branch: "main" });
      mockCheckGit.mockImplementation((_cmd: unknown, args: unknown) => {
        if ((args as string[])[2] === "remote")
          throw new Error("error: could not lock config file .git/config");
        return "";
      });
      const out = JSON.parse(await gitPushTool.execute({ cwd: CLONE }));
      expect(out.error).toContain("could not verify");
      expect(sent("push")).toBe(false);
    });

    it("git_push from a clone whose remote URL cannot be read: refused as unverifiable", async () => {
      answer("docs/a.md\0", { urlReadFails: true });
      const out = JSON.parse(await gitPushTool.execute({ cwd: CLONE }));
      expect(out.error).toContain("could not verify");
      expect(sent("push")).toBe(false);
    });

    it("git_push from a clone with a remote named like an option: refused as unverifiable", async () => {
      answer("docs/a.md\0", { remoteNames: "-x\n" });
      const out = JSON.parse(await gitPushTool.execute({ cwd: CLONE }));
      expect(out.error).toContain("could not verify");
      expect(sent("push")).toBe(false);
    });

    it("the check's git children run without prompts, replacement objects or grafts, and its fetch updates only the refs it names", async () => {
      answer("docs/a.md\0");
      await gitPushTool.execute({ cwd: WT });
      expect(mockCheckGit.mock.calls.length).toBeGreaterThan(0);
      for (const c of mockCheckGit.mock.calls) {
        const env = (c[2] as { env: Record<string, string> }).env;
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
        expect(env.GIT_GRAFT_FILE).toBe("/dev/null");
      }
      const fetch = mockCheckGit.mock.calls.find(
        (c) => (c[1] as string[])[2] === "fetch",
      )![1] as string[];
      expect(fetch).toContain("--refmap=");
    });

    it("a check that could not run names the failing step only, never git's error text", async () => {
      answer("docs/a.md\0", {
        fetchError: new Error(
          "fatal: unable to access 'https://x-access-token:abc@github.com/kosm1x/agent-controller.git/': Could not resolve host",
        ),
      });
      const out = JSON.parse(await gitPushTool.execute({ cwd: WT }));
      expect(out.error).toContain("could not run");
      expect(out.error).toContain("origin reachable");
      expect(out.error).not.toContain("://");
      expect(out.error).not.toContain("x-access-token");
      expect(sent("push")).toBe(false);
    });

    it("gh_create_pr in the jarvis worktree: a remote branch that changes protected files gets no pull request", async () => {
      answer("src/tools/builtin/git.ts\0");
      const out = JSON.parse(
        await ghCreatePrTool.execute({ title: "t", body: "b", cwd: WT }),
      );
      expect(out.error).toContain("src/tools/builtin/git.ts");
      expect(ghCalled()).toBe(false);
      // The pull request is built on the branch as origin has it.
      const fetch = mockCheckGit.mock.calls.find(
        (c) => (c[1] as string[])[2] === "fetch",
      )![1] as string[];
      expect(fetch).toContain(
        "+refs/heads/jarvis/feat/x:refs/remotes/origin/jarvis/feat/x",
      );
    });

    it("gh_create_pr in the jarvis worktree: a remote branch of ordinary files gets its pull request", async () => {
      answer("docs/a.md\0");
      expect(
        await ghCreatePrTool.execute({ title: "t", body: "b", cwd: WT }),
      ).toContain("pull/5");
      expect(checkVerbs()).toContain("merge-base");
    });

    it("gh_create_pr in another repository: the check is not applied", async () => {
      answer("src/index.ts\0", {
        remoteUrl: "https://github.com/EurekaMD-net/myrepo.git",
      });
      expect(
        await ghCreatePrTool.execute({
          title: "t",
          body: "b",
          cwd: "/root/claude/myrepo",
        }),
      ).toContain("pull/5");
      expect(checkVerbs()).not.toContain("merge-base");
    });
  });
});
