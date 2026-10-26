import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Everything that could build, test or restart is mocked: this suite must
// never deploy.
// `git -z` listings (changed-tests, still execFileSync) answer the
// changed-file set (ruling 4); everything else "". The vps tools' own children
// run through async execFile (2026-10-26, MCEventLoopBlock): `childImpl`
// answers them by command, delivered on setImmediate like a real child.
type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

const { execGroupKill, execFileSync, execFile, childImpl, stdinEnds, changed } =
  vi.hoisted(() => {
    const changed = { ahead: "", worktree: "", fail: false };
    // One stdin.end() mock per spawned child, in spawn order.
    const stdinEnds: Array<ReturnType<typeof vi.fn>> = [];
    // (cmd, args?, opts) without the callback → stdout, a promise of it (to
    // hold the child open until the test releases it), or a throw.
    const childImpl = vi.fn(
      (..._args: unknown[]): string | Promise<string> => "",
    );
    const execFile = (...args: unknown[]) => {
      const cb = args.pop() as ChildCb;
      const fail = (e: unknown) => {
        const err = e as ChildErr;
        setImmediate(() => cb(err, err.stdout ?? "", err.stderr ?? ""));
      };
      try {
        Promise.resolve(childImpl(...args)).then(
          (out) => setImmediate(() => cb(null, out, "")),
          fail,
        );
      } catch (e) {
        fail(e);
      }
    };
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
      stdinEnds,
      childImpl,
      execFile,
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
vi.mock("child_process", () => ({ execFileSync, execFile }));
vi.mock("fs", async (orig) => ({
  ...(await orig<typeof import("fs")>()),
  existsSync: vi.fn(() => true),
}));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { vpsDeployTool, vpsLogsTool, vpsStatusTool } from "./vps-management.js";
import { jarvisTestRunTool, SUITE_RUN_BUSY } from "./jarvis-self-repair.js";

const MC_DIR = "/root/claude/mission-control";
const ok = (stdout = "") => Promise.resolve({ stdout, stderr: "" });
const fail = (fields: Record<string, unknown>) =>
  Promise.reject(Object.assign(new Error("exit 1"), fields));
const restartCalls = () =>
  childImpl.mock.calls.filter(
    (c) =>
      (c as unknown[])[0] === "systemctl" &&
      ((c as unknown[])[1] as string[])[0] === "restart",
  );
const NOT_SINCE_DEPLOY =
  'Note: the running build\'s commit is not recorded, so "changed" here is commits ahead of origin/main + uncommitted changes, NOT everything since the last deploy.';

/** Healthy box: one canned stdout per vps_status / vps_logs child. */
const STATUS_OUT: Record<string, string> = {
  uptime: " 10:00:00 up 3 days,  1 user,  load average: 0.42, 0.30, 0.20\n",
  free: "               total        used        free\nMem:             16G        8.1G        2.0G\nSwap:            4G          0B          4G\n",
  df: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       193G  103G   91G  54% /\n",
  systemctl: "active\n",
  docker: "supabase-db\tUp 2 hours (healthy)\ncrm-hindsight\tUp 3 days\n",
  curl: "200",
  journalctl:
    "Oct 26 20:00:01 vps node[123]: boot ok\nOct 26 20:00:02 vps node[123]: ERROR db locked\nOct 26 20:00:03 vps node[123]: ready\n",
};
const byCommand = (...args: unknown[]) => STATUS_OUT[args[0] as string] ?? "";
const STATUS_EXPECTED = [
  "🖥️ **VPS Status**",
  "Load: 0.42",
  "Memory: 8.1G used / 16G total",
  "Disk: 103G used / 193G (54%)",
  "✅ mission-control: active",
  "\n**Docker:**",
  "  supabase-db: Up 2 hours (healthy)",
  "  crm-hindsight: Up 3 days",
  "\nHealth endpoint: ✅ 200 OK",
].join("\n");

/** Order of a setImmediate tick queued before execute() vs its settle. */
async function settleOrder(run: () => Promise<unknown>): Promise<string[]> {
  const order: string[] = [];
  setImmediate(() => order.push("tick"));
  await run();
  order.push("done");
  return order;
}

beforeEach(() => {
  execGroupKill.mockReset();
  execFileSync.mockClear();
  childImpl.mockReset();
  childImpl.mockImplementation(byCommand);
  stdinEnds.length = 0;
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
      env: expect.any(Object),
    });
    expect(execGroupKill).toHaveBeenNthCalledWith(
      2,
      "npx vitest related --run --reporter=dot --passWithNoTests ./src/x.ts",
      {
        cwd: MC_DIR,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: expect.any(Object),
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
    // jarvis_test_run may spawn an async child (git branch) before tsc.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release({ stdout: "", stderr: "" });
    await first;
  });
});

// Queue 3h: the tsc / vitest children run task-writable code (a test file can
// read its env), so they get the base allow-list, never the service env.
describe("vps_deploy — child env is an allow-list, never the service env (queue 3h)", () => {
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

  it("tsc and vitest related get PATH/HOME and none of the canaries", async () => {
    execGroupKill
      .mockImplementationOnce(() => ok())
      .mockImplementationOnce(() => ok("Tests  1 passed (1)"));
    await vpsDeployTool.execute({});
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

describe("vps_deploy — self-restart runs async, same semantics", () => {
  it("restart is a no-block systemctl child with the same timeout, stdin closed", async () => {
    execGroupKill.mockImplementation(() => ok());
    changed.ahead = "";
    const out = await vpsDeployTool.execute({});
    expect(restartCalls()).toEqual([
      [
        "systemctl",
        ["restart", "--no-block", "mission-control"],
        { timeout: 5_000 },
      ],
    ]);
    expect(out).not.toContain("❌ systemctl restart failed");
    expect(stdinEnds).toHaveLength(1);
    expect(stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("a failing restart child keeps the same error line", async () => {
    execGroupKill.mockImplementation(() => ok());
    changed.ahead = "";
    childImpl.mockImplementation(() => {
      throw Object.assign(new Error("Command failed: systemctl restart"), {
        code: 1,
      });
    });
    const out = await vpsDeployTool.execute({});
    expect(out.split("\n").at(-1)).toBe("❌ systemctl restart failed");
  });
});

describe("vps_status — children run async off the event loop (MCEventLoopBlock)", () => {
  it("healthy box → same dashboard text, same commands and options", async () => {
    expect(await vpsStatusTool.execute({})).toBe(STATUS_EXPECTED);
    const opts = { encoding: "utf-8", timeout: 5000 };
    expect(childImpl.mock.calls).toEqual([
      ["uptime", opts],
      ["free", ["-h", "--si"], opts],
      ["df", ["-h", "/"], opts],
      ["systemctl", ["is-active", "mission-control"], opts],
      [
        "docker",
        ["ps", "--format", "{{.Names}}\t{{.Status}}", "--no-trunc"],
        opts,
      ],
      [
        "curl",
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://localhost:8080/health",
        ],
        opts,
      ],
    ]);
  });

  it("every child fails → header plus the `inactive` fallback, nothing else", async () => {
    childImpl.mockImplementation(() => {
      throw Object.assign(new Error("Command failed"), { code: 3 });
    });
    expect(await vpsStatusTool.execute({})).toBe(
      "🖥️ **VPS Status**\n❌ mission-control: inactive",
    );
  });

  it("does not settle before a tick queued ahead of it (RED under execFileSync)", async () => {
    expect(await settleOrder(() => vpsStatusTool.execute({}))).toEqual([
      "tick",
      "done",
    ]);
  });

  it("closes stdin on every child it spawns", async () => {
    await vpsStatusTool.execute({});
    expect(stdinEnds).toHaveLength(6);
    for (const end of stdinEnds) expect(end).toHaveBeenCalledTimes(1);
  });

  it("waits for a held-open `docker ps` and reports what it returns", async () => {
    let release!: (out: string) => void;
    childImpl.mockImplementation((...args: unknown[]) =>
      args[0] === "docker"
        ? new Promise<string>((r) => (release = r))
        : byCommand(...args),
    );
    let settled = false;
    const run = vpsStatusTool.execute({}).then((out) => {
      settled = true;
      return out;
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(release).toBeTypeOf("function");
    expect(settled).toBe(false);
    release(STATUS_OUT.docker);
    expect(await run).toBe(STATUS_EXPECTED);
  });
});

describe("vps_logs — journalctl runs async, same output shape", () => {
  it("filters, trims timestamps, same journalctl args and options", async () => {
    expect(await vpsLogsTool.execute({ lines: 5, filter: "error" })).toBe(
      '📋 **mission-control** (1 lines, filter: "error")\n\nERROR db locked',
    );
    expect(childImpl.mock.calls).toEqual([
      [
        "journalctl",
        ["-u", "mission-control", "--no-pager", "-n", "15"],
        { encoding: "utf-8", timeout: 10_000 },
      ],
    ]);
    expect(stdinEnds).toHaveLength(1);
    expect(stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("does not settle before a tick queued ahead of it (RED under execFileSync)", async () => {
    expect(await settleOrder(() => vpsLogsTool.execute({}))).toEqual([
      "tick",
      "done",
    ]);
  });

  it("journalctl timeout (killed, SIGTERM) → the same could-not-read text", async () => {
    childImpl.mockImplementation(() => {
      throw Object.assign(
        new Error("Command failed: journalctl -u mission-control"),
        {
          killed: true,
          code: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        },
      );
    });
    expect(await vpsLogsTool.execute({ service: "mission-control" })).toBe(
      "❌ Could not read logs for mission-control.",
    );
  });

  it("invalid service name never spawns a child", async () => {
    expect(await vpsLogsTool.execute({ service: "x; rm -rf /" })).toBe(
      "❌ Invalid service name.",
    );
    expect(childImpl).not.toHaveBeenCalled();
  });
});
