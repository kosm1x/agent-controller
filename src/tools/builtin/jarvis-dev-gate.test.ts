import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jarvis_dev's test gate under ruling 4: related tests only + the shared
// one-at-a-time lock. Every spawn is mocked — no test runner starts here, no
// git runs, and the real gate cache file is never written.
const { execFile, execFileSync, execGroupKill, writeFileSync, changed, git } =
  vi.hoisted(() => {
    const changed = {
      ahead: "",
      worktree: "",
      fail: false,
      heads: [] as string[],
    };
    const git = (args: string[]): string => {
      if (args[0] === "branch") return "jarvis/fix/x\n";
      if (args[0] === "rev-parse") return changed.heads.shift() ?? "abc123\n";
      if (!args.includes("-z") || args[0] === "status") return "";
      if (changed.fail) throw new Error("unknown revision origin/main");
      if (args[0] === "ls-files") return "";
      return args.includes("HEAD") ? changed.worktree : changed.ahead;
    };
    // The callback mock is what tests drive; the promisify.custom hook wraps
    // it like the real one, returning a promise that carries `.child`.
    const execFileCb = vi.fn();
    const execFile = Object.assign(execFileCb, {
      [Symbol.for("nodejs.util.promisify.custom")]: (
        cmd: string,
        args: string[],
        opts: unknown,
      ) =>
        Object.assign(
          new Promise((resolve, reject) =>
            execFileCb(cmd, args, opts, (err: unknown, out: unknown) =>
              err ? reject(err) : resolve(out),
            ),
          ),
          { child: { stdin: { end: vi.fn() } } },
        ),
    });
    return {
      changed,
      git,
      execGroupKill: vi.fn(),
      execFile,
      writeFileSync: vi.fn(),
      execFileSync: vi.fn((_cmd: string, args: string[]) => git(args)),
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
// Since the 2026-10-26 event-loop fix, run()'s git children also go through
// execFile: git answers from the same table as execFileSync; only the
// systemd-run gate children consume the queued answers.
type Answer = string | Error | ((cb: Cb) => void);
let queued: Answer[] = [];
/** systemd-run answers: tsc first, then the related run. */
const answer = (...outs: Answer[]) => {
  queued.push(...outs);
};
const routeExecFile = (cmd: string, args: string[], _o: unknown, cb: Cb) => {
  if (cmd === "git") {
    let stdout: string;
    try {
      stdout = git(args);
    } catch (err) {
      return cb(err);
    }
    return cb(null, { stdout, stderr: "" });
  }
  const o = queued.shift();
  if (o === undefined) throw new Error(`no queued answer for ${cmd}`);
  if (typeof o === "function") return o(cb);
  return o instanceof Error ? cb(o) : cb(null, { stdout: o, stderr: "" });
};
/** The gate children only (systemd-run), never run()'s git calls. */
const gateCalls = () =>
  execFile.mock.calls.filter((c) => c[0] === "systemd-run");
const test = async () =>
  JSON.parse(await jarvisDevTool.execute({ action: "test" }));

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation(routeExecFile);
  queued = [];
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
    expect(gateCalls()).toHaveLength(2);
    expect(gateCalls()[1][0]).toBe("systemd-run");
    expect(gateCalls()[1][1]).toEqual(
      buildGateScopeArgs(relatedTestArgv(["src/tools/a.ts"])),
    );
    expect(gateCalls()[1][2]).toMatchObject({
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
    expect(gateCalls()).toHaveLength(1);
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
    expect(gateCalls()).toHaveLength(0);
    expect(writeFileSync).not.toHaveBeenCalled();

    release({ stdout: "", stderr: "" });
    await first;
  });

  it("jarvis_test_run and vps_deploy are refused while the jarvis_dev gate runs; released after", async () => {
    let release: Cb | undefined;
    answer((cb) => (release = cb));
    const gate = test();
    // run()'s git calls now resolve over several ticks before the gate takes
    // the lock; wait until the tsc child is actually running (lock held).
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await jarvisTestRunTool.execute({})).toBe(
      `❌ Tests: ${SUITE_RUN_BUSY}`,
    );
    expect(await vpsDeployTool.execute({})).toBe(
      `❌ Deploy aborted: ${SUITE_RUN_BUSY}`,
    );
    answer("Test Files  1 passed (1)\nTests  2 passed (2)");
    release!(null, { stdout: "", stderr: "" });
    expect((await gate).ready_for_pr).toBe(true);

    execGroupKill.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "" }),
    );
    expect(await jarvisTestRunTool.execute({ typecheck_only: true })).toContain(
      "✅ Typecheck: PASS",
    );
  });
});

// Queue 4ao (g): the branch was read BEFORE the suite lock while the cache
// keyed on preState.branch (read inside it). The branch read now happens with
// the lock held, so the report and the cache key describe the same tree.
describe("jarvis_dev action=test — branch read under the suite lock (4ao g)", () => {
  it("the first branch read happens while the suite lock is held", async () => {
    const { withSuiteRunLock } = await import("./jarvis-self-repair.js");
    let probe: Promise<string | null> | undefined;
    execFile.mockImplementation(
      (cmd: string, args: string[], o: unknown, cb: Cb) => {
        // A lock probe at the first branch read: null = lock already held.
        if (!probe && cmd === "git" && args[0] === "branch")
          probe = withSuiteRunLock(async () => "free");
        return routeExecFile(cmd, args, o, cb);
      },
    );
    answer("", "Test Files  1 passed (1)\nTests  2 passed (2)");
    const out = await test();
    expect(await probe).toBeNull();
    expect(out.branch).toBe("jarvis/fix/x");
    expect(out.ready_for_pr).toBe(true);
    expect(JSON.parse(writeFileSync.mock.calls[0][1] as string).branch).toBe(
      out.branch,
    );
  });

  it("a non-jarvis branch read under the lock still refuses before any gate child", async () => {
    execFile.mockImplementation(
      (cmd: string, args: string[], o: unknown, cb: Cb) =>
        cmd === "git" && args[0] === "branch"
          ? cb(null, { stdout: "main\n", stderr: "" })
          : routeExecFile(cmd, args, o, cb),
    );
    const out = await test();
    expect(out.error).toContain('Not on a jarvis/* branch (current: "main")');
    expect(gateCalls()).toHaveLength(0);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

// qa R1 W3: the gate runs outside the worktree's cwd lock, so action=pr
// re-checks under it that HEAD + the dirty hash still match the tested tree.
describe("jarvis_dev action=pr — tree re-checked under the cwd lock (qa R1 W3)", () => {
  const pr = async () =>
    JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
  const staged = () =>
    execFile.mock.calls.some(
      (c) => c[0] === "git" && (c[1] as string[]).includes("add"),
    );

  it("refuses, committing nothing, when HEAD moved after the gate ran", async () => {
    // rev-parse: cache probe, gate pre, gate post, then the in-lock re-check.
    changed.heads = ["abc123\n", "abc123\n", "abc123\n", "def456\n"];
    answer("", "Test Files  1 passed (1)\nTests  2 passed (2)");
    const out = await pr();
    expect(out.error).toMatch(/^Working tree changed since the tests ran/);
    expect(staged()).toBe(false);
    expect(
      execFile.mock.calls.some(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "commit",
      ),
    ).toBe(false);
  });

  it("control: an unchanged tree passes the re-check and reaches staging", async () => {
    changed.heads = [];
    answer("", "Test Files  1 passed (1)\nTests  2 passed (2)");
    const out = await pr();
    // The gate mock reports a clean porcelain, so staging finds nothing.
    expect(out.error).toBe("Nothing to commit (or only sensitive files changed).");
  });
});
