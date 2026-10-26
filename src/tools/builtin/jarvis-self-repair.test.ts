import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;
type ChildImpl = (
  cmd: string,
  args: string[],
  opts?: unknown,
) => string | Promise<string>;

// `git` answers on execFileSync: the changed-file lists (ruling 4), keyed on
// the -z listings changed-tests.ts issues. Everything else returns "" so a
// child reverted to execFileSync shows up as empty output.
// execFile (async since 2026-10-26, MCEventLoopBlock): currentBranch and the
// two jarvis_diagnose journalctl reads. `childImpl` returns stdout (or a
// promise of it, to hold the child open) or throws; the result is delivered
// on setImmediate like a real child. Each child records its own stdin.end.
const { execGroupKill, execFileSync, execFile, childImpl, stdinEnds, changed } =
  vi.hoisted(() => {
    const changed = { ahead: "", worktree: "", untracked: "", fail: false };
    const childImpl = vi.fn<ChildImpl>();
    const stdinEnds: Array<ReturnType<typeof vi.fn>> = [];
    const execFile = vi.fn((...args: unknown[]) => {
      const cb = args.pop() as ChildCb;
      const fail = (e: unknown) => {
        const err = e as ChildErr;
        setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
      };
      try {
        Promise.resolve(childImpl(...(args as Parameters<ChildImpl>))).then(
          (out) => setImmediate(() => cb(null, out, "")),
          fail,
        );
      } catch (e) {
        fail(e);
      }
    });
    Object.defineProperty(
      execFile,
      Symbol.for("nodejs.util.promisify.custom"),
      {
        value: (...args: unknown[]) => {
          const end = vi.fn();
          stdinEnds.push(end);
          return Object.assign(
            new Promise((res, rej) =>
              execFile(...args, ((err, stdout, stderr) =>
                err ? rej(err) : res({ stdout, stderr })) as ChildCb),
            ),
            { child: { stdin: { end } } },
          );
        },
      },
    );
    return {
      changed,
      childImpl,
      stdinEnds,
      execFile,
      execGroupKill: vi.fn(),
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd !== "git" || !args.includes("-z")) return "";
        if (changed.fail) throw new Error("unknown revision origin/main");
        if (args[0] === "ls-files") return changed.untracked;
        return args.includes("HEAD") ? changed.worktree : changed.ahead;
      }),
    };
  });
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFile, execFileSync }));
vi.mock("fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import {
  jarvisDiagnoseTool,
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

const ERROR_LOG =
  "Oct 26 10:00:00 host mission-control[123]: [router] ERROR boom";
const GUARD_LOG =
  "Oct 26 10:00:01 host mission-control[123]: hallucination guard fired";
const defaultChild: ChildImpl = (cmd) =>
  cmd === "git" ? "jarvis/fix/x\n" : `${ERROR_LOG}\n${GUARD_LOG}\n`;

beforeEach(() => {
  execGroupKill.mockReset();
  execFile.mockClear();
  execFileSync.mockClear();
  childImpl.mockReset();
  childImpl.mockImplementation(defaultChild);
  stdinEnds.length = 0;
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
      env: expect.any(Object),
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(2, RELATED_CMD, {
      cwd: MC_DIR,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: expect.any(Object),
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

// Queue 3h: the tsc / vitest children run task-writable code (a test file can
// read its env), so they get the base allow-list, never the service env.
describe("jarvis_test_run — child env is an allow-list, never the service env (queue 3h)", () => {
  const CANARIES: Record<string, string> = {
    CANARY_API_KEY: "canary-value-1",
    FIREWORKS_API_KEY: "canary-value-2",
    TELEGRAM_BOT_TOKEN: "canary-value-3",
    SOME_UNRELATED_SETTING: "canary-value-4",
  };
  beforeEach(() => {
    for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("tsc --noEmit and vitest related get PATH/HOME and none of the canaries", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() => ok("Tests  1 passed (1)"));
    await jarvisTestRunTool.execute({});
    expect(execGroupKill).toHaveBeenCalledTimes(2);
    for (const call of execGroupKill.mock.calls) {
      const opts = (call as unknown[])[1] as { env: Record<string, string> };
      expect(opts.env).not.toBe(process.env);
      expect(opts.env.PATH).toBe(process.env.PATH);
      expect(opts.env.HOME).toBe(process.env.HOME);
      for (const name of Object.keys(CANARIES))
        expect(opts.env).not.toHaveProperty(name);
      expect(JSON.stringify(opts.env)).not.toContain("canary-value");
    }
  });
});

describe("withSuiteRunLock — one full-suite run at a time (W4)", () => {
  it("refuses a second run while the first is pending; releases on resolve", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    // The lock is taken synchronously on entry, before the async branch read:
    // no tick in between, and a direct caller already sees it busy (null).
    expect(await withSuiteRunLock(async () => "x")).toBeNull();
    await Promise.resolve();
    expect(await jarvisTestRunTool.execute({})).toBe(
      `❌ Tests: ${SUITE_RUN_BUSY}`,
    );
    // The branch read is async now: tsc starts a few ticks after the lock.
    await vi.waitFor(() => expect(release).toBeDefined());
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
    // The branch read is async now: tsc starts a few ticks after the lock.
    await vi.waitFor(() => expect(reject).toBeDefined());
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

// Queue 4ao sweep (MCEventLoopBlock, 2026-10-26): the branch read and both
// journalctl reads run as async children, never execFileSync on the loop.
describe("jarvis_diagnose — async children, same output", () => {
  const journalCalls = () =>
    execFile.mock.calls.filter((c) => c[0] === "journalctl");
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const STATIC_TAIL = [
    "\n**Modifiable files:** src/tools/, src/intel/, src/messaging/scope.ts, src/messaging/prompt-sections.ts, src/video/",
  ];

  it("reports error logs, guard triggers and the branch; args/options unchanged", async () => {
    const out = await jarvisDiagnoseTool.execute({ hours: 3 });
    expect(out).toContain(
      "\n**Error logs:**\n  [router] ERROR boom\n  hallucination guard fired",
    );
    expect(out).toContain("\n**Guard triggers:**\n  hallucination guard fired");
    expect(out).toContain("**Current branch:** jarvis/fix/x");
    expect(journalCalls()).toHaveLength(2);
    for (const c of journalCalls())
      expect(c.slice(1, 3)).toEqual([
        ["-u", "mission-control", "--since", "3 hours ago", "--no-pager"],
        { encoding: "utf-8", timeout: 10_000 },
      ]);
    const git = execFile.mock.calls.filter((c) => c[0] === "git");
    expect(git).toHaveLength(1);
    expect(git[0].slice(1, 3)).toEqual([
      ["branch", "--show-current"],
      { cwd: MC_DIR, timeout: 5000, encoding: "utf-8" },
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("yields the event loop: a queued setImmediate runs before it settles", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("tick"));
    await jarvisDiagnoseTool.execute({}).then(() => order.push("done"));
    expect(order).toEqual(["tick", "done"]);
  });

  it("journalctl timeout (killed, SIGTERM) → the exact fallback text, no command line leaked", async () => {
    childImpl.mockImplementation((cmd, args, opts) => {
      if (cmd === "git") return defaultChild(cmd, args, opts);
      throw Object.assign(
        new Error("Command failed: journalctl -u mission-control"),
        { killed: true, code: null, signal: "SIGTERM", stdout: "", stderr: "" },
      );
    });
    expect(await jarvisDiagnoseTool.execute({})).toBe(
      [
        "🔍 **Diagnosis** (last 1h)",
        "\n**Error logs:** Could not read journalctl",
        "\n**Failed tasks:** Could not query DB",
        ...STATIC_TAIL,
        "**Current branch:** jarvis/fix/x",
        "**Next step:** Use code_search to find the relevant code, then jarvis_dev to create a fix branch.",
      ].join("\n"),
    );
  });

  it("closes stdin on every child it spawns", async () => {
    await jarvisDiagnoseTool.execute({});
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(stdinEnds).toHaveLength(3);
    for (const end of stdinEnds) expect(end).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, "error-log"],
    [1, "guard-log"],
  ])("holds open until journalctl read #%i (%s) is released", async (held) => {
    let release!: (out: string) => void;
    let n = 0;
    childImpl.mockImplementation((cmd, args, opts) => {
      if (cmd === "journalctl" && n++ === held)
        return new Promise<string>((r) => (release = r));
      return defaultChild(cmd, args, opts);
    });
    let settled = false;
    const run = jarvisDiagnoseTool.execute({}).then((o) => {
      settled = true;
      return o;
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    for (let i = 0; i < 5; i++) await tick();
    expect(settled).toBe(false);
    release(`${ERROR_LOG}\n${GUARD_LOG}\n`);
    const out = await run;
    expect(out).toContain("  [router] ERROR boom");
    expect(out).toContain("\n**Guard triggers:**\n  hallucination guard fired");
  });

  it("a failing `git branch` falls back to HEAD", async () => {
    childImpl.mockImplementation((cmd, args, opts) => {
      if (cmd === "git") throw new Error("not a git repository");
      return defaultChild(cmd, args, opts);
    });
    expect(await jarvisDiagnoseTool.execute({})).toContain(
      "**Current branch:** HEAD",
    );
  });
});
