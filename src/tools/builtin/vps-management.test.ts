import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Everything that could build, test or restart is mocked: this suite must
// never deploy.
// `git -z` listings answer the changed-file set (ruling 4); everything else "".
const { execGroupKill, execFileSync, changed } = vi.hoisted(() => {
  const changed = { ahead: "", worktree: "", fail: false };
  return {
    changed,
    execGroupKill: vi.fn(),
    execFileSync: vi.fn((_cmd: string, args: string[]) => {
      if (!args.includes("-z")) return "";
      if (changed.fail) throw new Error("unknown revision origin/main");
      if (args[0] === "ls-files") return "";
      return args.includes("HEAD") ? changed.worktree : changed.ahead;
    }),
  };
});
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFileSync }));
vi.mock("fs", async (orig) => ({
  ...(await orig<typeof import("fs")>()),
  existsSync: vi.fn(() => true),
}));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { vpsDeployTool } from "./vps-management.js";
import { jarvisTestRunTool, SUITE_RUN_BUSY } from "./jarvis-self-repair.js";

const MC_DIR = "/root/claude/mission-control";
const ok = (stdout = "") => Promise.resolve({ stdout, stderr: "" });
const fail = (fields: Record<string, unknown>) =>
  Promise.reject(Object.assign(new Error("exit 1"), fields));
const restartCalls = () =>
  execFileSync.mock.calls.filter((c) => (c as unknown[])[0] === "systemctl");
const NOT_SINCE_DEPLOY =
  'Note: the running build\'s commit is not recorded, so "changed" here is commits ahead of origin/main + uncommitted changes, NOT everything since the last deploy.';

beforeEach(() => {
  execGroupKill.mockReset();
  execFileSync.mockClear();
  Object.assign(changed, { ahead: "src/x.ts\0", worktree: "", fail: false });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("vps_deploy — group-kill runner, same output shape", () => {
  it("pass path: build, the RELATED tests only, then the (mocked) no-block restart (ruling 4)", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() =>
        ok("Test Files  2 passed (2)\nTests  10 passed (10)"),
      );
    const out = await vpsDeployTool.execute({});
    expect(out).toContain("✅ Build: PASS");
    expect(out).toContain("✅ Tests: 10 passed");
    expect(out).toContain(
      "Scope: related tests only: 1 changed source file(s) → 2 test file(s)",
    );
    expect(out).toContain(NOT_SINCE_DEPLOY);
    expect(out).toContain(
      "✅ Build + related tests passed. Initiating restart",
    );
    expect(execGroupKill).toHaveBeenNthCalledWith(1, "npx tsc", {
      cwd: MC_DIR,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(
      2,
      "npx vitest related --run --reporter=dot --passWithNoTests ./src/x.ts",
      {
        cwd: MC_DIR,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
    expect(restartCalls()).toHaveLength(1);
  });

  it("no changed .ts files → build only, says tests were skipped, still restarts", async () => {
    changed.ahead = "";
    execGroupKill.mockImplementation(() => ok());
    const out = await vpsDeployTool.execute({});
    expect(out).toContain(
      "⏭️ tests: skipped (no changed files; the full suite runs in pre-commit/CI)",
    );
    expect(out).toContain(NOT_SINCE_DEPLOY);
    expect(out).toContain(
      "✅ Build passed (tests skipped, see above). Initiating restart",
    );
    expect(out).not.toContain("Build + related tests passed");
    expect(execGroupKill).toHaveBeenCalledTimes(1);
    expect(restartCalls()).toHaveLength(1);
  });

  it("changed set unknown (git error) → aborts before the restart", async () => {
    changed.fail = true;
    execGroupKill.mockImplementation(() => ok());
    const out = await vpsDeployTool.execute({});
    expect(out).toMatch(
      /^❌ Deploy aborted: tests NOT RUN — could not determine changed files/,
    );
    expect(execGroupKill).toHaveBeenCalledTimes(1);
    expect(restartCalls()).toHaveLength(0);
  });

  it("build failure aborts before the suite and the restart", async () => {
    execGroupKill.mockImplementationOnce(() => fail({ stderr: "TS1005" }));
    expect(await vpsDeployTool.execute({})).toBe(
      "❌ Deploy aborted: build failed\nTS1005",
    );
    expect(execGroupKill).toHaveBeenCalledTimes(1);
    expect(restartCalls()).toHaveLength(0);
  });

  it("test failure (or timeout) aborts before the restart", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() =>
        fail({ killed: true, stdout: "Tests  1 failed | 9 passed" }),
      );
    expect(await vpsDeployTool.execute({})).toBe(
      "❌ Deploy aborted: tests failed\nTests  1 failed | 9 passed\nScope: related tests only: 1 changed source file(s) → ? test file(s) (changed = commits ahead of origin/main + uncommitted + untracked); the full suite runs in pre-commit/CI",
    );
    expect(restartCalls()).toHaveLength(0);
  });

  it("is refused while jarvis_test_run holds the suite lock (W4)", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await Promise.resolve();
    expect(await vpsDeployTool.execute({})).toBe(
      `❌ Deploy aborted: ${SUITE_RUN_BUSY}`,
    );
    expect(restartCalls()).toHaveLength(0);
    release({ stdout: "", stderr: "" });
    await first;
  });
});
