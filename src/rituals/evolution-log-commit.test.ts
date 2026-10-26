import { describe, it, expect, vi, beforeEach } from "vitest";

// commitEvolutionLogIfDirty runs its git children through promisified
// execFile (async since 2026-10-26, MCEventLoopBlock). Hoisted so vi.mock can
// see them.
const { execFileMock, stdinEndMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  stdinEndMock: vi.fn(),
}));

type ChildErr = Error & { stdout?: string; stderr?: string; code?: number };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

/**
 * Callback-style child mock with the real `(…, cb) => cb(err, stdout, stderr)`
 * shape. `execFileMock` records the call (args without the callback) and
 * returns stdout (or a promise of it, to hold the child open until the test
 * releases it) or throws; the result is delivered on setImmediate, like a real
 * child. Real execFile carries util.promisify.custom resolving
 * `{stdout, stderr}` with `.child` on the promise — mirrored here so
 * promisify() sees the same shape.
 */
vi.mock("child_process", () => {
  const fail = (cb: ChildCb, e: unknown) => {
    const err = e as ChildErr;
    setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
  };
  const child = (...args: unknown[]) => {
    const cb = args.pop() as ChildCb;
    try {
      Promise.resolve(execFileMock(...args)).then(
        (out) => setImmediate(() => cb(null, (out as string) ?? "", "")),
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
        { child: { stdin: { end: stdinEndMock } } },
      ),
  });
  return { execFile: child };
});

import { commitEvolutionLogIfDirty } from "./evolution-log-commit.js";

/** Sub-command (first git arg) of each recorded child, in call order. */
const subcommands = () =>
  execFileMock.mock.calls.map((c) => (c[1] as string[])[0]);

describe("commitEvolutionLogIfDirty", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    stdinEndMock.mockReset();
  });

  it("no-ops (no commit) when the log has no uncommitted changes", async () => {
    execFileMock.mockReturnValueOnce("   "); // git status --porcelain → blank
    const res = await commitEvolutionLogIfDirty();
    expect(res).toEqual({ committed: false, reason: "clean" });
    // Only `git status` ran — no commit, no rev-parse.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "status",
      "--porcelain",
      "--",
      "docs/EVOLUTION-LOG.md",
    ]);
  });

  it("commits ONLY docs/EVOLUTION-LOG.md, pathspec-scoped, when dirty", async () => {
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n") // status: dirty
      .mockReturnValueOnce("") // add
      .mockReturnValueOnce("") // commit
      .mockReturnValueOnce("abc1234\n"); // rev-parse --short HEAD

    const res = await commitEvolutionLogIfDirty();
    expect(res).toEqual({
      committed: true,
      reason: "committed",
      hash: "abc1234",
    });
    // Sequence unchanged: status → add → commit → rev-parse.
    expect(subcommands()).toEqual(["status", "add", "commit", "rev-parse"]);

    const commitCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "commit",
    );
    expect(commitCall).toBeDefined();
    const args = commitCall![1] as string[];
    // Pathspec scoping invariant: `-m <msg>` MUST come before `--`; only our one
    // file after `--`; never ["."] (which would sweep a dirty index / secrets).
    const dashDash = args.indexOf("--");
    expect(dashDash).toBeGreaterThan(0);
    expect(args.indexOf("-m")).toBeLessThan(dashDash);
    expect(args.slice(dashDash + 1)).toEqual(["docs/EVOLUTION-LOG.md"]);
    expect(args).not.toContain(".");
    // Mechanical durability commit must not be hostage to the pre-commit hook.
    expect(args).toContain("--no-verify");
    // `git add` is also scoped to the one file (never the whole tree).
    const addCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "add",
    );
    expect(addCall![1]).toEqual(["add", "--", "docs/EVOLUTION-LOG.md"]);
    // Timeouts/encoding unchanged per child.
    expect(execFileMock.mock.calls.map((c) => c[2])).toEqual([
      expect.objectContaining({ timeout: 10_000, encoding: "utf-8" }),
      expect.objectContaining({ timeout: 10_000, encoding: "utf-8" }),
      expect.objectContaining({ timeout: 15_000, encoding: "utf-8" }),
      expect.objectContaining({ timeout: 5_000, encoding: "utf-8" }),
    ]);
  });

  it("propagates a git failure (so the cron records the ritual failure)", async () => {
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n") // dirty
      .mockReturnValueOnce("") // add
      .mockImplementationOnce(() => {
        throw new Error("commit failed");
      }); // commit throws
    await expect(commitEvolutionLogIfDirty()).rejects.toThrow(/commit failed/);
    // No rev-parse after a failed commit.
    expect(subcommands()).toEqual(["status", "add", "commit"]);
  });

  it("propagates a non-zero git exit unchanged (code + stderr intact)", async () => {
    const exitErr = Object.assign(new Error("Command failed: git commit"), {
      code: 1,
      stdout: "",
      stderr: "fatal: unable to auto-detect email address",
    });
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n")
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => {
        throw exitErr;
      });
    const err = await commitEvolutionLogIfDirty().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(exitErr);
    expect(err).toMatchObject({
      code: 1,
      stderr: "fatal: unable to auto-detect email address",
    });
  });

  it("runs git in the mission-control working directory", async () => {
    execFileMock.mockReturnValueOnce(""); // clean
    await commitEvolutionLogIfDirty();
    expect(execFileMock.mock.calls[0][2]).toMatchObject({
      cwd: "/root/claude/mission-control",
    });
  });

  it("yields the event loop: a setImmediate queued before the call runs first", async () => {
    execFileMock.mockReturnValueOnce(""); // clean
    const order: string[] = [];
    setImmediate(() => order.push("tick"));
    await commitEvolutionLogIfDirty();
    order.push("done");
    expect(order).toEqual(["tick", "done"]);
  });

  it("does not settle while `git commit` is still running", async () => {
    let release!: (out: string) => void;
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n")
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r))) // commit held open
      .mockReturnValueOnce("def5678\n");

    let settled = false;
    const p = commitEvolutionLogIfDirty().then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(subcommands()).toContain("commit"));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(subcommands()).toEqual(["status", "add", "commit"]);

    release("");
    await expect(p).resolves.toEqual({
      committed: true,
      reason: "committed",
      hash: "def5678",
    });
  });

  it("does not start `git commit` while `git add` is still running", async () => {
    let release!: (out: string) => void;
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n")
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r))) // add held open
      .mockReturnValueOnce("") // commit
      .mockReturnValueOnce("abc1234\n"); // rev-parse

    let settled = false;
    const p = commitEvolutionLogIfDirty().then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(subcommands()).toContain("add"));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(subcommands()).toEqual(["status", "add"]);
    expect(settled).toBe(false);

    release("");
    await expect(p).resolves.toEqual({
      committed: true,
      reason: "committed",
      hash: "abc1234",
    });
    expect(subcommands()).toEqual(["status", "add", "commit", "rev-parse"]);
  });

  it("closes stdin of every child exactly once", async () => {
    execFileMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("abc1234\n");
    await commitEvolutionLogIfDirty();
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(stdinEndMock).toHaveBeenCalledTimes(4);
  });
});
