import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jarvis_dev's test gate under ruling 4: related tests only + the shared
// one-at-a-time lock. Every spawn is mocked — no test runner starts here, no
// git runs, and the real gate cache file is never written.
const { execFile, execFileSync, execGroupKill, writeFileSync, changed } =
  vi.hoisted(() => {
    const changed = {
      ahead: "",
      worktree: "",
      fail: false,
      heads: [] as string[],
    };
    return {
      changed,
      execGroupKill: vi.fn(),
      execFile: vi.fn(),
      writeFileSync: vi.fn(),
      execFileSync: vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "branch") return "jarvis/fix/x\n";
        if (args[0] === "rev-parse") return changed.heads.shift() ?? "abc123\n";
        if (!args.includes("-z") || args[0] === "status") return "";
        if (changed.fail) throw new Error("unknown revision origin/main");
        if (args[0] === "ls-files") return "";
        return args.includes("HEAD") ? changed.worktree : changed.ahead;
      }),
    };
  });
vi.mock("child_process", () => ({ execFile, execFileSync }));
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  symlinkSync: vi.fn(),
  writeFileSync,
}));
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { buildGateScopeArgs, jarvisDevTool } from "./jarvis-dev.js";
import { relatedTestArgv } from "./changed-tests.js";
import { jarvisTestRunTool, SUITE_RUN_BUSY } from "./jarvis-self-repair.js";
import { vpsDeployTool } from "./vps-management.js";

type Cb = (err: unknown, out?: { stdout: string; stderr: string }) => void;
/** execFile answers: tsc first, then the related run. */
const answer = (...outs: Array<string | Error>) => {
  for (const o of outs)
    execFile.mockImplementationOnce(
      (_f: string, _a: string[], _o: unknown, cb: Cb) =>
        o instanceof Error ? cb(o) : cb(null, { stdout: o, stderr: "" }),
    );
};
const test = async () =>
  JSON.parse(await jarvisDevTool.execute({ action: "test" }));

beforeEach(() => {
  execFile.mockReset();
  execGroupKill.mockReset();
  writeFileSync.mockClear();
  Object.assign(changed, {
    ahead: "src/tools/a.ts\0",
    worktree: "",
    fail: false,
    heads: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("jarvis_dev test gate — related tests only (ruling 4)", () => {
  it("runs vitest's related mode on the changed files inside the gate scope, in the worktree", async () => {
    answer("", "Test Files  3 passed (3)\nTests  12 passed (12)");
    const out = await test();
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1][0]).toBe("systemd-run");
    expect(execFile.mock.calls[1][1]).toEqual(
      buildGateScopeArgs(relatedTestArgv(["src/tools/a.ts"])),
    );
    expect(execFile.mock.calls[1][2]).toMatchObject({
      cwd: "/root/claude/mission-control-jarvis",
      timeout: 330_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(out.tests).toBe(
      "PASS (12 tests; related tests only: 1 changed source file(s) → 3 test file(s) (changed = commits ahead of origin/main + uncommitted + untracked); the full suite runs in CI)",
    );
    expect(out.ready_for_pr).toBe(true);
    // The cached result carries the scope, so a cached action=pr shows it too.
    expect(JSON.parse(writeFileSync.mock.calls[0][1] as string).tests).toBe(
      out.tests,
    );
  });

  it("no changed .ts files → typecheck only, SKIPPED with the reason, PR still allowed", async () => {
    changed.ahead = "docs/x.md\0";
    answer("");
    const out = await test();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(out.tests).toBe(
      "SKIPPED (1 changed file(s), none a .ts file vitest can scope — typecheck only; the full suite runs in CI)",
    );
    expect(out.ready_for_pr).toBe(true);
  });

  it("a SKIPPED result is relabelled STALE when the tree moved during the run (audit A2)", async () => {
    changed.ahead = "";
    changed.heads = ["abc123\n", "def456\n"];
    answer("");
    const out = await test();
    expect(out.tests).toMatch(/^STALE: working tree changed during test run/);
    expect(out.ready_for_pr).toBe(false);
  });

  it("a skipped run does not hide a typecheck failure", async () => {
    changed.ahead = "";
    answer(Object.assign(new Error("exit 2"), { stdout: "error TS2322" }));
    const out = await test();
    expect(out.typecheck).toMatch(/^FAIL: .*TS2322/);
    expect(out.ready_for_pr).toBe(false);
  });

  it("changed set unknown (git error) → FAIL, not ready", async () => {
    changed.fail = true;
    answer("");
    const out = await test();
    expect(out.tests).toMatch(/^FAIL: could not determine changed files/);
    expect(out.ready_for_pr).toBe(false);
  });

  it("a failing related run keeps the classification and names the scope", async () => {
    answer(
      "",
      Object.assign(new Error("exit 1"), {
        code: 1,
        stdout: "Tests  1 failed | 4 passed (5)",
        stderr: " FAIL  src/tools/a.test.ts > x\n",
      }),
    );
    const out = await test();
    expect(out.tests).toMatch(
      /^FAIL: 1 failed, 4 passed — failing: src\/tools\/a\.test\.ts > x \[related tests only: 1 changed source file\(s\)/,
    );
    expect(out.ready_for_pr).toBe(false);
  });
});

describe("jarvis_dev test gate — shares the one-at-a-time lock (ruling 4)", () => {
  it("action=test and action=pr are refused while jarvis_test_run holds the lock", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await Promise.resolve();

    const t = await test();
    expect(t).toMatchObject({
      tests: `FAIL: ${SUITE_RUN_BUSY}`,
      ready_for_pr: false,
    });
    const pr = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(pr).toMatchObject({
      error: "Tests must pass before opening a PR.",
      tests: `FAIL: ${SUITE_RUN_BUSY}`,
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();

    release({ stdout: "", stderr: "" });
    await first;
  });

  it("jarvis_test_run and vps_deploy are refused while the jarvis_dev gate runs; released after", async () => {
    let release!: Cb;
    execFile.mockImplementationOnce(
      (_f: string, _a: string[], _o: unknown, cb: Cb) => (release = cb),
    );
    const gate = test();
    await Promise.resolve();
    expect(await jarvisTestRunTool.execute({})).toBe(
      `❌ Tests: ${SUITE_RUN_BUSY}`,
    );
    expect(await vpsDeployTool.execute({})).toBe(
      `❌ Deploy aborted: ${SUITE_RUN_BUSY}`,
    );
    answer("Test Files  1 passed (1)\nTests  2 passed (2)");
    release(null, { stdout: "", stderr: "" });
    expect((await gate).ready_for_pr).toBe(true);

    execGroupKill.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );
    expect(await jarvisTestRunTool.execute({ typecheck_only: true })).toContain(
      "✅ Typecheck: PASS",
    );
  });
});
