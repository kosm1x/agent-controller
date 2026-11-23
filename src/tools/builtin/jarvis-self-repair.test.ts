import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;
type ChildImpl = (
  cmd: string,
  args: string[],
  opts?: unknown,
) => string | Promise<string>;

// execFile (async since 2026-10-26, MCEventLoopBlock): currentBranch and the
// two jarvis_diagnose journalctl reads, and the changed-file lists (ruling 4)
// changed-tests.ts issues — its `git … -z` listings are answered by `gitZ`
// from `changed`, every other child by `childImpl`. execFileSync answers ""
// so a child reverted to it shows up as empty output. `childImpl` returns
// stdout (or a promise of it, to hold the child open) or throws; the result
// is delivered on setImmediate like a real child. Each child records its own
// stdin.end.
const {
  execGroupKill,
  execFileSync,
  execFile,
  childImpl,
  gitZ,
  stdinEnds,
  changed,
} = vi.hoisted(() => {
    const changed = { ahead: "", worktree: "", untracked: "", fail: false };
    const childImpl = vi.fn<ChildImpl>();
    const gitZ = vi.fn((_cmd: string, args: string[]) => {
      if (changed.fail) throw new Error("unknown revision origin/main");
      if (args[0] === "ls-files") return changed.untracked;
      return args.includes("HEAD") ? changed.worktree : changed.ahead;
    });
    const isGitZ = (args: unknown[]) =>
      args[0] === "git" && Array.isArray(args[1]) && args[1].includes("-z");
    const stdinEnds: Array<ReturnType<typeof vi.fn>> = [];
    const execFile = vi.fn((...args: unknown[]) => {
      const cb = args.pop() as ChildCb;
      const fail = (e: unknown) => {
        const err = e as ChildErr;
        setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
      };
      try {
        const impl = isGitZ(args) ? gitZ : childImpl;
        Promise.resolve(impl(...(args as Parameters<ChildImpl>))).then(
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
      gitZ,
      stdinEnds,
      execFile,
      execGroupKill: vi.fn(),
      execFileSync: vi.fn(() => ""),
    };
  });
vi.mock("./shell.js", () => ({ execGroupKill }));
vi.mock("child_process", () => ({ execFile, execFileSync }));
// mkdtempSync: every child env carries an empty GH_CONFIG_DIR (env-deny.ts).
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  mkdtempSync: vi.fn(() => "/tmp/mc-gh-config-test"),
}));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { existsSync } from "fs";
import {
  jarvisDiagnoseTool,
  jarvisTestRunTool,
  withSuiteRunLock,
  SUITE_RUN_BUSY,
} from "./jarvis-self-repair.js";
import { MC_WORKTREE_ROOT } from "./immutable-core.js";

const MC_DIR = "/root/claude/mission-control";
// The self-test's folder. Every existence check is answered by the fs mock
// above; no test looks at the real folder.
const WT = MC_WORKTREE_ROOT.replace(/\/$/, "");
const BUSY = JSON.stringify({ error: `Tests: ${SUITE_RUN_BUSY}` });
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
  gitZ.mockClear();
  childImpl.mockReset();
  childImpl.mockImplementation(defaultChild);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockImplementation(() => true);
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
  it("pass path: typecheck then the RELATED tests only, both via execGroupKill in the worktree (ruling 4)", async () => {
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
      cwd: WT,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: expect.any(Object),
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(2, RELATED_CMD, {
      cwd: WT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: expect.any(Object),
    });
    // The changed set is computed in the cwd the tool runs in, by three
    // async git children (none on execFileSync).
    expect(gitZ).toHaveBeenCalledTimes(3);
    for (const c of gitZ.mock.calls)
      expect((c as unknown[])[2]).toMatchObject({
        cwd: WT,
        timeout: 30_000,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      });
    // The branch shown in the header is read in the worktree too.
    const branchReads = execFile.mock.calls.filter(
      (c) => c[0] === "git" && (c[1] as string[])[0] === "branch",
    );
    expect(branchReads).toHaveLength(1);
    expect(branchReads[0].slice(1, 3)).toEqual([
      ["branch", "--show-current"],
      { cwd: WT, timeout: 5000, encoding: "utf-8" },
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
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
    expect(await jarvisTestRunTool.execute({})).toBe(BUSY);
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
    expect(await jarvisTestRunTool.execute({})).toBe(BUSY);
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

// The self-test runs only in the worktree. A missing folder, `.git` or
// node_modules link is a JSON error result, checked before the lock, with
// nothing started.
describe("jarvis_test_run — refuses when the worktree cannot be tested", () => {
  const T1 = `jarvis_test_run did not run: there is no mission-control worktree at ${WT}, and this tool tests only that worktree. jarvis_dev tries to create the worktree whenever one of its actions runs (action="branch" is the one that also creates a jarvis/* branch). If jarvis_dev answers with a worktree bootstrap error, do not retry: report that error.`;
  const T2 = `jarvis_test_run did not run: ${WT} exists but is not a git checkout (no .git). jarvis_dev does not repair this: it creates the worktree only when the folder is absent. Try jarvis_test_run once more; if the answer is the same, report it.`;
  const T3 = `jarvis_test_run did not run: the worktree at ${WT} has no usable node_modules link, so the typecheck and the tests cannot start. jarvis_dev recreates a missing link whenever one of its actions runs; then run jarvis_test_run again. If jarvis_dev answers with a worktree bootstrap error, do not retry: report that error.`;
  const missing = (...paths: string[]) =>
    vi.mocked(existsSync).mockImplementation((p) => !paths.includes(String(p)));
  const expectNothingStarted = () => {
    expect(execFile).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execGroupKill).not.toHaveBeenCalled();
  };

  it.each([
    ["the folder", [WT, `${WT}/.git`, `${WT}/node_modules`], T1],
    ["the .git", [`${WT}/.git`, `${WT}/node_modules`], T2],
    ["the node_modules link", [`${WT}/node_modules`], T3],
  ])("missing %s → its exact error, nothing started", async (_, gone, text) => {
    missing(...gone);
    const out = await jarvisTestRunTool.execute({});
    expect(out).toBe(JSON.stringify({ error: text }));
    expect(Object.keys(JSON.parse(out))).toEqual(["error"]);
    expectNothingStarted();
  });

  it("checks the folder, then .git, then node_modules, and stops at the first missing", async () => {
    missing(`${WT}/.git`);
    await jarvisTestRunTool.execute({});
    expect(vi.mocked(existsSync).mock.calls.map((c) => c[0])).toEqual([
      WT,
      `${WT}/.git`,
    ]);
    vi.mocked(existsSync).mockClear();
    missing(`${WT}/node_modules`);
    await jarvisTestRunTool.execute({});
    expect(vi.mocked(existsSync).mock.calls.map((c) => c[0])).toEqual([
      WT,
      `${WT}/.git`,
      `${WT}/node_modules`,
    ]);
  });

  it("a refusal is returned even while another run holds the lock", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await vi.waitFor(() => expect(release).toBeDefined());
    missing(WT);
    const out = await jarvisTestRunTool.execute({});
    // Release before asserting, so a failure here cannot leave the lock held
    // for the cases after it.
    release({ stdout: "", stderr: "" });
    await first;
    expect(out).toBe(JSON.stringify({ error: T1 }));
  });
});

describe("jarvis_test_run — header branch and the Next line", () => {
  const NEXT =
    '\n**Next:** once typecheck and tests pass on a branch made by jarvis_dev action="branch", open the PR with jarvis_dev action="pr". If the branch shown above is not one of those, create one first with jarvis_dev action="branch" (it refuses while the worktree holds uncommitted edits).';
  const branchAnswers = (answer: () => string) =>
    childImpl.mockImplementation((cmd, args, opts) =>
      cmd === "git" && args[0] === "branch"
        ? answer()
        : defaultChild(cmd, args, opts),
    );

  it.each([
    ["a branch name", "jarvis/fix/x", () => "jarvis/fix/x\n"],
    ["main", "main", () => "main\n"],
    ["a detached HEAD (empty answer)", "detached (no branch)", () => "\n"],
    [
      "a git error",
      "unknown (git failed)",
      () => {
        throw new Error("not a git repository");
      },
    ],
  ])("%s → header shows %s, and the run still goes ahead", async (_, shown, answer) => {
    branchAnswers(answer);
    execGroupKill.mockImplementation(() => ok("Tests  1 passed (1)"));
    const out = await jarvisTestRunTool.execute({});
    expect(out.split("\n")[0]).toBe(`🧪 **Test Run** (branch: ${shown})`);
    expect(execGroupKill).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["main", "main\n"],
    ["a jarvis/* branch", "jarvis/fix/x\n"],
    ["a hand-made branch", "my-branch\n"],
    ["a detached HEAD", "\n"],
  ])("full run on %s ends with the one fixed Next line", async (_, name) => {
    branchAnswers(() => name);
    execGroupKill.mockImplementation(() => ok("Tests  1 passed (1)"));
    const out = await jarvisTestRunTool.execute({});
    expect(out.endsWith(NEXT)).toBe(true);
    expect(out.split("**Next:**")).toHaveLength(2);
  });

  it("typecheck_only shows no Next line", async () => {
    execGroupKill.mockImplementation(() => ok());
    const out = await jarvisTestRunTool.execute({ typecheck_only: true });
    expect(out).not.toContain("**Next:**");
  });
});

describe("jarvis_test_run — description", () => {
  it("names the worktree and when the tool refuses; the property text is unchanged", () => {
    const fn = jarvisTestRunTool.definition.function;
    expect(fn.description).toBe(`Run typecheck and the tests related to your changed files (not the full suite) in your mission-control worktree (${WT}), where jarvis_dev action="branch" puts your jarvis/* branch. Use BEFORE opening a PR to verify your fix.

DO NOT USE WHEN:
- The code under test is another repo → run its own test command via shell_exec.
- You only want to know whether the service is healthy → use jarvis_diagnose.
- There is no worktree at that path (none created yet, or your edits are in /workspace inside a sandbox container) → this tool refuses; it tests only that worktree.

USE WHEN:
- After making code changes via file_edit in your worktree on a jarvis/* branch
- Before calling jarvis_dev action="pr"

Returns: typecheck result + test count + any failures.

IMPORTANT: jarvis_dev action="pr" already gates on tests. This tool is for checking BEFORE you're ready to PR — to iterate on your fix.`);
    expect(
      (fn.parameters as { properties: Record<string, { description: string }> })
        .properties.typecheck_only.description,
    ).toBe("If true, only run typecheck (faster). Default: false (runs both).");
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

  it("an empty `git branch` answer (detached) shows an empty branch, not HEAD", async () => {
    childImpl.mockImplementation((cmd, args, opts) =>
      cmd === "git" ? "\n" : defaultChild(cmd, args, opts),
    );
    const lines = (await jarvisDiagnoseTool.execute({})).split("\n");
    expect(lines.filter((l) => l.startsWith("**Current branch:**"))).toEqual([
      "**Current branch:** ",
    ]);
  });
});
