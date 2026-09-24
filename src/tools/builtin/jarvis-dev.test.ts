import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  actionBranch,
  buildGateScopeArgs,
  changedPathsFromPorcelainZ,
  PR_STATUS_ARGS,
  prAddArgs,
  computeDirtyHash,
  describeTestRunFailure,
  detectRunMutation,
  execFailureText,
  GATE_SCOPE_PROPERTIES,
  isCacheFresh,
  TEST_CACHE_TTL_MS,
  type TestCacheEntry,
  type WorkingTreeState,
} from "./jarvis-dev.js";

const baseCache: TestCacheEntry = {
  branch: "jarvis/feat/example",
  head_sha: "abc123",
  dirty_hash: "deadbeef",
  tested_at_ms: 1_000_000,
  typecheck: "PASS",
  tests: "PASS (3734 tests)",
  ready_for_pr: true,
};

const baseState: WorkingTreeState = {
  branch: "jarvis/feat/example",
  head_sha: "abc123",
  dirty_hash: "deadbeef",
  now_ms: baseCache.tested_at_ms + 60_000, // 1 minute later
};

describe("jarvis_dev test cache freshness", () => {
  it("returns true when branch, head, dirty hash, and ready_for_pr all match and within TTL", () => {
    expect(isCacheFresh(baseCache, baseState)).toBe(true);
  });

  it("returns false for null cache", () => {
    expect(isCacheFresh(null, baseState)).toBe(false);
  });

  it("returns false when cache records a failing run", () => {
    expect(isCacheFresh({ ...baseCache, ready_for_pr: false }, baseState)).toBe(
      false,
    );
  });

  it("returns false when branch has changed since the cache was written", () => {
    expect(
      isCacheFresh(baseCache, { ...baseState, branch: "jarvis/feat/other" }),
    ).toBe(false);
  });

  it("returns false when HEAD has advanced (new commit) since the cache was written", () => {
    expect(isCacheFresh(baseCache, { ...baseState, head_sha: "abc124" })).toBe(
      false,
    );
  });

  it("returns false when the working tree has changed (edit after test pass)", () => {
    expect(
      isCacheFresh(baseCache, { ...baseState, dirty_hash: "cafef00d" }),
    ).toBe(false);
  });

  it("returns false when the cache is older than the TTL", () => {
    const stale: WorkingTreeState = {
      ...baseState,
      now_ms: baseCache.tested_at_ms + TEST_CACHE_TTL_MS + 1,
    };
    expect(isCacheFresh(baseCache, stale)).toBe(false);
  });

  it("returns true at exactly the TTL boundary (inclusive)", () => {
    const edge: WorkingTreeState = {
      ...baseState,
      now_ms: baseCache.tested_at_ms + TEST_CACHE_TTL_MS,
    };
    expect(isCacheFresh(baseCache, edge)).toBe(true);
  });
});

describe("jarvis_dev mutation detection (C1)", () => {
  const stateA = { branch: "jarvis/feat/x", head_sha: "abc", dirty_hash: "h1" };
  const stateB = { branch: "jarvis/feat/x", head_sha: "abc", dirty_hash: "h2" };

  it("returns false when pre and post match", () => {
    expect(detectRunMutation(stateA, { ...stateA })).toBe(false);
  });

  it("returns true when the dirty_hash changed during the test run", () => {
    expect(detectRunMutation(stateA, stateB)).toBe(true);
  });

  it("returns true when HEAD advanced during the test run", () => {
    expect(detectRunMutation(stateA, { ...stateA, head_sha: "abd" })).toBe(
      true,
    );
  });

  it("returns true when branch changed during the test run", () => {
    expect(detectRunMutation(stateA, { ...stateA, branch: "main" })).toBe(true);
  });

  it("returns true (safe default) when the pre-snapshot is null", () => {
    expect(detectRunMutation(null, stateA)).toBe(true);
  });

  it("returns true (safe default) when the post-snapshot is null", () => {
    expect(detectRunMutation(stateA, null)).toBe(true);
  });
});

describe("jarvis_dev dirty hash — untracked content (M1)", () => {
  const base = {
    porcelain: "?? src/foo.ts\n",
    diffUnstaged: "",
    diffStaged: "",
  };

  it("produces different hashes when untracked file content differs", () => {
    const h1 = computeDirtyHash({
      ...base,
      untracked: [
        { path: "src/foo.ts", bytes: Buffer.from("export const x = 1;") },
      ],
    });
    const h2 = computeDirtyHash({
      ...base,
      untracked: [
        { path: "src/foo.ts", bytes: Buffer.from("export const x = 2;") },
      ],
    });
    expect(h1).not.toEqual(h2);
  });

  it("produces the same hash when untracked content is unchanged", () => {
    const bytes = Buffer.from("same content");
    const h1 = computeDirtyHash({
      ...base,
      untracked: [{ path: "src/foo.ts", bytes }],
    });
    const h2 = computeDirtyHash({
      ...base,
      untracked: [{ path: "src/foo.ts", bytes: Buffer.from("same content") }],
    });
    expect(h1).toEqual(h2);
  });

  it("is order-insensitive over the untracked list", () => {
    const a = { path: "src/a.ts", bytes: Buffer.from("A") };
    const b = { path: "src/b.ts", bytes: Buffer.from("B") };
    const h1 = computeDirtyHash({ ...base, untracked: [a, b] });
    const h2 = computeDirtyHash({ ...base, untracked: [b, a] });
    expect(h1).toEqual(h2);
  });

  it("distinguishes two files with swapped contents from two files with original contents", () => {
    // Regression guard: a naive concat-without-separator hash could
    // collide when bytes from one file bleed into the next.
    const h1 = computeDirtyHash({
      ...base,
      untracked: [
        { path: "src/a.ts", bytes: Buffer.from("foo") },
        { path: "src/b.ts", bytes: Buffer.from("bar") },
      ],
    });
    const h2 = computeDirtyHash({
      ...base,
      untracked: [
        { path: "src/a.ts", bytes: Buffer.from("foobar") },
        { path: "src/b.ts", bytes: Buffer.from("") },
      ],
    });
    expect(h1).not.toEqual(h2);
  });
});

describe("jarvis_dev gate scope containment (OOM outage 2026-08-02)", () => {
  it("wraps the child in a transient scope inside the capped shared slice", () => {
    const cmd = ["npx", "vitest", "run", "--reporter=dot"];
    const args = buildGateScopeArgs(cmd);
    // --scope = the child leaves mission-control.service's cgroup, so an OOM
    // kill can only take the test run, never the host service.
    expect(args[0]).toBe("--scope");
    expect(args).toContain("--collect");
    // The memory cap lives on the SLICE (shared across concurrent gate runs —
    // per-scope caps would stack), so membership is the load-bearing arg.
    expect(args).toContain("--slice=jarvis-gate");
    // RuntimeMaxSec is the cgroup-wide deadline — the fix for orphaned fork
    // workers that Node's single-process SIGTERM timeout leaves behind.
    expect(args.join(" ")).toMatch(/--property RuntimeMaxSec=\d+/);
    // The command survives verbatim after the `--` separator.
    expect(args.slice(args.indexOf("--") + 1)).toEqual(cmd);
  });

  it("every scope property is a well-formed systemd Key=Value", () => {
    expect(GATE_SCOPE_PROPERTIES.length).toBeGreaterThanOrEqual(1);
    for (const p of GATE_SCOPE_PROPERTIES) {
      expect(p).toMatch(/^[A-Za-z]+=\S+$/);
    }
  });
});

describe("jarvis_dev failure classification (audit C1/C2/W4 2026-08-02)", () => {
  it("classifies a scope kill (RuntimeMaxSec / cgroup-OOM) as TIMEOUT/KILLED, not parsed failures", () => {
    // systemd-run --scope execs the command, so kills arrive as plain
    // signals — partial stdout must not be parsed as a failure count.
    const out = describeTestRunFailure({
      signal: "SIGKILL",
      code: null,
      stdout: "Tests  3 failed | 100 passed", // partial, untrustworthy
    });
    expect(out).toMatch(/^TIMEOUT\/KILLED/);
    expect(out).not.toContain("3 failed");
  });

  it("classifies a maxBuffer breach as KILLED with the buffer size", () => {
    expect(
      describeTestRunFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    ).toMatch(/^KILLED: vitest output exceeded maxBuffer \(32 MiB\)/);
  });

  it("extracts the failure count from stdout AND failing names from stderr", () => {
    // vitest prints the summary on stdout but the Failed Tests block on
    // STDERR — the old stdout-only read lost every failing test name.
    const out = describeTestRunFailure({
      code: 1,
      stdout: "Tests  2 failed | 6975 passed (6977)",
      stderr:
        " FAIL  src/a.test.ts > does the thing\n FAIL  src/b.test.ts > other\n",
    });
    expect(out).toContain("FAIL: 2 failed, 6975 passed");
    expect(out).toContain("src/a.test.ts > does the thing");
  });

  it("surfaces systemd-run's own stderr-only failures instead of `FAIL: ` with no text", () => {
    // execFile attaches stdout as "" (never undefined), so a ??-chain on
    // stdout swallowed stderr-only errors into an empty message.
    const out = describeTestRunFailure({
      code: 1,
      stdout: "",
      stderr: "Unknown assignment: NotARealProp=1\n",
    });
    expect(out).toContain("Unknown assignment");
  });

  it("falls back to err.message when both streams are empty (e.g. ENOENT)", () => {
    const out = describeTestRunFailure({
      code: "ENOENT",
      stdout: "",
      stderr: "",
      message: "spawn systemd-run ENOENT",
    });
    expect(out).toContain("spawn systemd-run ENOENT");
  });

  it("execFailureText combines both streams — tsc diagnostics live on stdout", () => {
    expect(
      execFailureText({ stdout: "src/x.ts(1,1): error TS2322", stderr: "" }),
    ).toContain("TS2322");
    expect(execFailureText({ stdout: "", stderr: "", message: "boom" })).toBe(
      "boom",
    );
  });
});

describe("jarvis_dev action=branch — base is fresh origin/main (PRs #33/#37, 2026-09-24)", () => {
  // Real repos reproduce the production shape: a linked worktree whose `main`
  // is held by the primary checkout, HEAD left on an older jarvis/* branch,
  // and origin/main ahead of the local main.
  let root: string;
  let wt: string;
  // The pre-commit hook runs this suite with GIT_DIR/GIT_INDEX_FILE exported
  // for the commit being made: inherited, they redirect every fixture call
  // (config, commit) into the REAL repo. Strip them so git goes by cwd.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  const inWt = (args: string[]) => git(wt, args);
  const commit = (cwd: string, file: string, msg: string) => {
    writeFileSync(join(cwd, file), msg);
    git(cwd, ["add", file]);
    git(cwd, ["commit", "-q", "-m", msg]);
    return git(cwd, ["rev-parse", "HEAD"]);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jarvis-dev-branch-"));
    const origin = join(root, "origin.git");
    const primary = join(root, "primary");
    const pusher = join(root, "pusher");
    wt = join(root, "wt");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    for (const dir of [primary, pusher]) {
      git(root, ["clone", "-q", origin, dir]);
      git(dir, ["config", "user.email", "t@t"]);
      git(dir, ["config", "user.name", "t"]);
    }
    git(primary, ["checkout", "-q", "-b", "main"]);
    commit(primary, "a.txt", "A");
    git(primary, ["push", "-q", "origin", "main"]);
    git(primary, ["worktree", "add", "-q", "--detach", wt]);
    inWt(["checkout", "-q", "-b", "jarvis/fix/old"]);
    commit(wt, "stale.txt", "STALE");
    git(pusher, ["pull", "-q", "origin", "main"]);
    commit(pusher, "b.txt", "B");
    git(pusher, ["push", "-q", "origin", "main"]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("cuts a new branch from fresh origin/main, not from the stale HEAD", () => {
    const out = JSON.parse(actionBranch("fix", "new-thing", inWt));
    expect(out).toMatchObject({ success: true, base: "origin/main" });
    expect(inWt(["branch", "--show-current"])).toBe("jarvis/fix/new-thing");
    expect(inWt(["rev-parse", "HEAD"])).toBe(
      inWt(["rev-parse", "origin/main"]),
    );
    expect(inWt(["log", "--format=%s"]).split("\n")).toEqual(["B", "A"]);
    // No upstream: the branch must never track origin/main.
    expect(() => inWt(["rev-parse", "--abbrev-ref", "@{u}"])).toThrow();
  });

  it("returns an error and creates nothing when the fetch fails", () => {
    inWt(["remote", "set-url", "origin", join(root, "missing.git")]);
    const out = JSON.parse(actionBranch("fix", "new-thing", inWt));
    expect(out.error).toMatch(/fetch origin main failed/);
    expect(inWt(["branch", "--list", "jarvis/fix/new-thing"])).toBe("");
    expect(inWt(["branch", "--show-current"])).toBe("jarvis/fix/old");
  });

  it("refuses when leftover changes would ride into the new branch", () => {
    writeFileSync(join(wt, "leftover.txt"), "x");
    const out = JSON.parse(actionBranch("feat", "next", inWt));
    expect(out.error).toMatch(/Uncommitted changes/);
    expect(out.changed).toEqual(["?? leftover.txt"]);
    expect(inWt(["branch", "--list", "jarvis/feat/next"])).toBe("");
  });

  it("resumes an existing branch as-is and lists the commits its PR would ship", () => {
    inWt(["checkout", "-q", "--detach"]);
    const out = JSON.parse(actionBranch("fix", "old", inWt));
    expect(out).toMatchObject({
      success: true,
      base: "existing branch (resumed)",
    });
    expect(inWt(["branch", "--show-current"])).toBe("jarvis/fix/old");
    expect(out.commits_not_on_origin_main).toHaveLength(1);
    expect(out.commits_not_on_origin_main[0]).toMatch(/^[0-9a-f]+ STALE$/);
  });

  it("a fresh branch carries no resume listing", () => {
    const out = JSON.parse(actionBranch("fix", "new-thing", inWt));
    expect(out).not.toHaveProperty("commits_not_on_origin_main");
  });

  it("points next_steps at the worktree, not the primary checkout", () => {
    const out = JSON.parse(actionBranch("fix", "new-thing", inWt));
    expect(out.next_steps.join(" ")).toContain(
      "/root/claude/mission-control-jarvis/",
    );
    expect(out.next_steps.join(" ")).not.toMatch(/mission-control\//);
  });
}, 20_000);

describe("jarvis_dev action=pr — staged paths from porcelain -z", () => {
  let repo: string;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf-8",
      stdio: "pipe",
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "jarvis-dev-pr-"));
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    for (const f of ["a.ts", "gone.ts", "old name.ts"])
      writeFileSync(join(repo, f), f);
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("keeps the first path whole when it is an unstaged modification (was 'rc/x.ts')", () => {
    writeFileSync(join(repo, "a.ts"), "changed");
    const out = git(PR_STATUS_ARGS);
    expect(out.startsWith(" M ")).toBe(true);
    expect(changedPathsFromPorcelainZ(out)).toEqual(["a.ts"]);
  });

  it("handles deletes, spaces, untracked files and a staged rename, and git add accepts every path", () => {
    writeFileSync(join(repo, "a.ts"), "changed");
    rmSync(join(repo, "gone.ts"));
    git(["mv", "old name.ts", "new name.ts"]);
    writeFileSync(join(repo, "fresh file.ts"), "n");
    const paths = changedPathsFromPorcelainZ(git(PR_STATUS_ARGS));
    expect([...paths].sort()).toEqual(
      ["a.ts", "fresh file.ts", "gone.ts", "new name.ts"].sort(),
    );
    git(prAddArgs(paths));
    expect(git(["status", "--porcelain"])).not.toMatch(/^.[MD?]/m);
  });

  it("stages BOTH sides of a WORKTREE rename (intent-to-add, Y = R): the new file and the deletion", () => {
    execFileSync("mv", [join(repo, "a.ts"), join(repo, "a2.ts")]);
    git(["add", "-N", "a2.ts"]);
    const out = git(PR_STATUS_ARGS);
    expect(out.startsWith(" R ")).toBe(true);
    const paths = changedPathsFromPorcelainZ(out);
    expect([...paths].sort()).toEqual(["a.ts", "a2.ts"]);
    git(prAddArgs(paths));
    expect(git(["status", "--porcelain"])).not.toMatch(/^.[MD?]/m);
    expect(git(["ls-files"])).not.toMatch(/^a\.ts$/m);
  });

  it("lists each file inside a new directory, so the SENSITIVE filter can see nested secrets", () => {
    mkdirSync(join(repo, "newdir"));
    writeFileSync(join(repo, "newdir", ".env"), "K=v");
    writeFileSync(join(repo, "newdir", "x.ts"), "x");
    expect(changedPathsFromPorcelainZ(git(PR_STATUS_ARGS)).sort()).toEqual([
      "newdir/.env",
      "newdir/x.ts",
    ]);
  });

  it("stages option-like and glob-like names literally, and nothing else", () => {
    for (const f of ["-dash.ts", "st*r.ts", "stXr.ts"])
      writeFileSync(join(repo, f), f);
    git(prAddArgs(["-dash.ts", "st*r.ts"]));
    expect(
      git(["diff", "--cached", "--name-only"]).trim().split("\n").sort(),
    ).toEqual(["-dash.ts", "st*r.ts"]);
  });

  it("returns nothing for a clean tree", () => {
    expect(changedPathsFromPorcelainZ(git(PR_STATUS_ARGS))).toEqual([]);
  });
}, 20_000);
