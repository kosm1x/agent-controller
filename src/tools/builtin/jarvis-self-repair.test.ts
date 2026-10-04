import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `git` answers: the branch, then the changed-file lists (ruling 4), keyed
// on the -z listings changed-tests.ts issues.
const { execGroupKill, execFileSync, changed } = vi.hoisted(() => {
  const changed = { ahead: "", worktree: "", untracked: "", fail: false };
  return {
    changed,
    execGroupKill: vi.fn(),
    execFileSync: vi.fn((_cmd: string, args: string[]) => {
      if (!args.includes("-z")) return "jarvis/fix/x\n";
      if (changed.fail) throw new Error("unknown revision origin/main");
      if (args[0] === "ls-files") return changed.untracked;
      return args.includes("HEAD") ? changed.worktree : changed.ahead;
    }),
  };
});
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFileSync }));
vi.mock("fs", () => ({ existsSync: vi.fn(() => true) }));
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
const RELATED_CMD =
  "npx vitest related --run --reporter=dot --passWithNoTests ./src/tools/a.ts ./src/tools/b.ts";

beforeEach(() => {
  execGroupKill.mockReset();
  Object.assign(changed, {
    ahead: "src/tools/a.ts\0",
    worktree: "src/tools/b.ts\0docs/n.md\0",
    untracked: "",
    fail: false,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("jarvis_test_run — group-kill runner, same output shape", () => {
  it("pass path: typecheck then the RELATED tests only, both via execGroupKill in MC_DIR (ruling 4)", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() =>
        ok("Test Files  3 passed (3)\nTests  42 passed (42)"),
      );
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain("✅ Typecheck: PASS");
    expect(out).toContain("✅ Tests: 42 passed (3 files)");
    expect(out).toContain(
      "Scope: related tests only: 2 changed source file(s) → 3 test file(s)",
    );
    expect(execGroupKill).toHaveBeenNthCalledWith(1, "npx tsc --noEmit", {
      cwd: MC_DIR,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(2, RELATED_CMD, {
      cwd: MC_DIR,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    // The changed set is computed in the cwd the tool runs in.
    for (const c of execFileSync.mock.calls.filter((c) =>
      (c[1] as string[]).includes("-z"),
    ))
      expect((c as unknown[])[2]).toMatchObject({
        cwd: MC_DIR,
        // git's stderr is captured, never written to the service journal.
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    // No "Test Files" summary in the output → the file count is unknown.
    expect(out).toContain(
      "Scope: related tests only: 2 changed source file(s) → ? test file(s)",
    );
  });

  it("no changed .ts files → typecheck only, with the explicit skipped line", async () => {
    Object.assign(changed, { ahead: "", worktree: "README.md\0" });
    execGroupKill.mockImplementation(() => ok());
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain("✅ Typecheck: PASS");
    expect(out).toContain(
      "tests: skipped (1 changed file(s), none a .ts file vitest can scope — typecheck only; the full suite runs in pre-commit/CI)",
    );
    expect(execGroupKill).toHaveBeenCalledTimes(1);
  });

  it("over the 60-file cap → typecheck only, never the whole suite", async () => {
    changed.untracked = Array.from(
      { length: 61 },
      (_, i) => `src/m${i}.ts\0`,
    ).join("");
    execGroupKill.mockImplementation(() => ok());
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain("63 changed source files exceed the 60-file cap");
    expect(execGroupKill).toHaveBeenCalledTimes(1);
  });

  it("changed set unknown (git error) → tests NOT RUN, reported as a failure", async () => {
    changed.fail = true;
    execGroupKill.mockImplementation(() => ok());
    const out = await jarvisTestRunTool.execute({});
    expect(out).toContain(
      "❌ Tests: NOT RUN — could not determine changed files",
    );
    expect(execGroupKill).toHaveBeenCalledTimes(1);
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
