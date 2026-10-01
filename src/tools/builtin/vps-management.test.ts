import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Everything that could build, test or restart is mocked: this suite must
// never deploy.
const { execGroupKill, execFileSync } = vi.hoisted(() => ({
  execGroupKill: vi.fn(),
  execFileSync: vi.fn(() => ""),
}));
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFileSync }));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { vpsDeployTool } from "./vps-management.js";
import { jarvisTestRunTool, SUITE_RUN_BUSY } from "./jarvis-self-repair.js";

const MC_DIR = "/root/claude/mission-control";
const ok = (stdout = "") => Promise.resolve({ stdout, stderr: "" });
const fail = (fields: Record<string, unknown>) =>
  Promise.reject(Object.assign(new Error("exit 1"), fields));
const restartCalls = () =>
  execFileSync.mock.calls.filter((c) => (c as unknown[])[0] === "systemctl");

beforeEach(() => {
  execGroupKill.mockReset();
  execFileSync.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("vps_deploy — group-kill runner, same output shape", () => {
  it("pass path: build, suite, then the (mocked) no-block restart", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() => ok("Tests  10 passed (10)"));
    const out = await vpsDeployTool.execute({});
    expect(out).toContain("✅ Build: PASS");
    expect(out).toContain("✅ Tests: 10 passed");
    expect(out).toContain("Initiating restart");
    expect(execGroupKill).toHaveBeenNthCalledWith(1, "npx tsc", {
      cwd: MC_DIR,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(
      2,
      "npx vitest run --reporter=dot",
      {
        cwd: MC_DIR,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
    expect(restartCalls()).toHaveLength(1);
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
      "❌ Deploy aborted: tests failed\nTests  1 failed | 9 passed",
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
