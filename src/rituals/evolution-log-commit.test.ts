import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock for child_process.execFileSync — hoisted so vi.mock can see it.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));

import { commitEvolutionLogIfDirty } from "./evolution-log-commit.js";

describe("commitEvolutionLogIfDirty", () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it("no-ops (no commit) when the log has no uncommitted changes", () => {
    execFileSyncMock.mockReturnValueOnce("   "); // git status --porcelain → blank
    const res = commitEvolutionLogIfDirty();
    expect(res).toEqual({ committed: false, reason: "clean" });
    // Only `git status` ran — no commit, no rev-parse.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][1]).toEqual([
      "status",
      "--porcelain",
      "--",
      "docs/EVOLUTION-LOG.md",
    ]);
  });

  it("commits ONLY docs/EVOLUTION-LOG.md, pathspec-scoped, when dirty", () => {
    execFileSyncMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n") // status: dirty
      .mockReturnValueOnce("") // add
      .mockReturnValueOnce("") // commit
      .mockReturnValueOnce("abc1234\n"); // rev-parse --short HEAD

    const res = commitEvolutionLogIfDirty();
    expect(res).toEqual({
      committed: true,
      reason: "committed",
      hash: "abc1234",
    });

    const commitCall = execFileSyncMock.mock.calls.find(
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
    const addCall = execFileSyncMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "add",
    );
    expect(addCall![1]).toEqual(["add", "--", "docs/EVOLUTION-LOG.md"]);
  });

  it("propagates a git failure (so the cron records the ritual failure)", () => {
    execFileSyncMock
      .mockReturnValueOnce(" M docs/EVOLUTION-LOG.md\n") // dirty
      .mockReturnValueOnce("") // add
      .mockImplementationOnce(() => {
        throw new Error("commit failed");
      }); // commit throws
    expect(() => commitEvolutionLogIfDirty()).toThrow(/commit failed/);
  });

  it("runs git in the mission-control working directory", () => {
    execFileSyncMock.mockReturnValueOnce(""); // clean
    commitEvolutionLogIfDirty();
    expect(execFileSyncMock.mock.calls[0][2]).toMatchObject({
      cwd: "/root/claude/mission-control",
    });
  });
});
