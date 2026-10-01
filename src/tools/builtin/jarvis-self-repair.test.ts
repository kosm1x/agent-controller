import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { execGroupKill, execFileSync } = vi.hoisted(() => ({
  execGroupKill: vi.fn(),
  execFileSync: vi.fn(() => "jarvis/fix/x\n"),
}));
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFileSync }));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import {
  jarvisTestRunTool,
  withSuiteRunLock,
  SUITE_RUN_BUSY,
} from "./jarvis-self-repair.js";

const MC_DIR = "/root/claude/mission-control";
const ok = (stdout = "") => Promise.resolve({ stdout, stderr: "" });
const fail = (fields: Record<string, unknown>) =>
  Promise.reject(Object.assign(new Error("exit 1"), fields));

beforeEach(() => {
  execGroupKill.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("jarvis_test_run — group-kill runner, same output shape", () => {
  it("pass path: typecheck then the suite, both via execGroupKill in MC_DIR", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() =>
        ok("Test Files  3 passed (3)\nTests  42 passed (42)"),
      );
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain("✅ Typecheck: PASS");
    expect(out).toContain("✅ Tests: 42 passed (3 files)");
    expect(execGroupKill).toHaveBeenNthCalledWith(1, "npx tsc --noEmit", {
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
  });

  it("reject path: typecheck stderr and the failed/passed counts are reported", async () => {
    execGroupKill
      .mockImplementationOnce(() => fail({ stderr: "TS2304: cannot find x" }))
      .mockImplementationOnce(() =>
        fail({ stdout: "Tests  2 failed | 40 passed (42)" }),
      );
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain("❌ Typecheck: FAIL\nTS2304: cannot find x");
    expect(out).toContain("❌ Tests: 2 failed, 40 passed");
  });

  it("typecheck_only runs tsc alone", async () => {
    execGroupKill.mockImplementationOnce(() => ok());
    const out = await jarvisTestRunTool.execute({ typecheck_only: true });
    expect(out).toContain("✅ Typecheck: PASS");
    expect(execGroupKill).toHaveBeenCalledTimes(1);
  });
});

describe("withSuiteRunLock — one full-suite run at a time (W4)", () => {
  it("refuses a second run while the first is pending; releases on resolve", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await Promise.resolve();
    expect(await jarvisTestRunTool.execute({})).toBe(
      `❌ Tests: ${SUITE_RUN_BUSY}`,
    );
    release({ stdout: "", stderr: "" });
    expect(await first).toContain("✅ Typecheck: PASS");

    execGroupKill.mockImplementation(() => ok());
    expect(await jarvisTestRunTool.execute({ typecheck_only: true })).toContain(
      "✅ Typecheck: PASS",
    );
  });

  it("releases when the tool's runner rejects", async () => {
    let reject!: (e: unknown) => void;
    execGroupKill.mockImplementation(() => new Promise((_, r) => (reject = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await Promise.resolve();
    expect(await jarvisTestRunTool.execute({})).toBe(
      `❌ Tests: ${SUITE_RUN_BUSY}`,
    );
    reject(Object.assign(new Error("timed out"), { killed: true, stderr: "" }));
    expect(await first).toContain("❌ Typecheck: FAIL");
    execGroupKill.mockImplementation(() => ok());
    expect(await jarvisTestRunTool.execute({ typecheck_only: true })).toContain(
      "✅ Typecheck: PASS",
    );
  });

  it("releases when the wrapped function itself throws", async () => {
    await expect(
      withSuiteRunLock(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await withSuiteRunLock(async () => "ran")).toBe("ran");
  });
});
