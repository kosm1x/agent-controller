import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every child seam is mocked: this suite never builds, tests or restarts.
// `git -z` listings (changed-tests, still execFileSync, reached through
// jarvis_test_run) answer the changed-file set (ruling 4); everything else "".
// The vps tools' own children run through async execFile (2026-10-26,
// MCEventLoopBlock): `childImpl` answers them by command, delivered on
// setImmediate like a real child.
type ChildErr = Error & { stdout?: string; stderr?: string };
type ChildCb = (err: ChildErr | null, stdout: string, stderr: string) => void;

const {
  execGroupKill,
  execFileSync,
  execFile,
  otherChildren,
  childImpl,
  stdinEnds,
  changed,
} = vi.hoisted(() => {
    const changed = { ahead: "", worktree: "", fail: false };
    // The remaining child_process entry points: any call is a spawned child.
    const otherChildren = {
      spawn: vi.fn(),
      spawnSync: vi.fn(),
      exec: vi.fn(),
      execSync: vi.fn(),
      fork: vi.fn(),
    };
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
      otherChildren,
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
// Both specifiers, same mocks: a child through either one is counted.
vi.mock("child_process", () => ({ execFileSync, execFile, ...otherChildren }));
vi.mock("node:child_process", () => ({
  execFileSync,
  execFile,
  ...otherChildren,
}));
vi.mock("fs", async (orig) => ({
  ...(await orig<typeof import("fs")>()),
  existsSync: vi.fn(() => true),
}));
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { vpsDeployTool, vpsLogsTool, vpsStatusTool } from "./vps-management.js";
import { jarvisTestRunTool, SUITE_RUN_BUSY } from "./jarvis-self-repair.js";
import * as nodeChildProcess from "node:child_process";

const OPERATOR_LINE = "cd /root/claude/mission-control && ./scripts/deploy.sh";
// The model-visible description is frozen here: a description change goes
// through the eval gate in its own batch, never as a side effect.
const DEPLOY_DESCRIPTION = `Build and deploy mission-control. Gates on the tests related to changed files (not the full suite) — will NOT restart if they fail.

USE WHEN:
- After merging a Jarvis PR (jarvis_dev workflow)
- User says "haz deploy", "deploy", "restart Jarvis"

WORKFLOW:
1. Runs npx tsc (build)
2. Runs the tests related to changed .ts files (none changed → skipped)
3. If tests pass: systemctl restart mission-control
4. Waits 5s, checks health endpoint
5. Reports success or rollback instructions

CRITICAL: This restarts the service. All running tasks will be orphaned (shutdown hook marks them failed).`;

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
  for (const fn of Object.values(otherChildren)) fn.mockClear();
  stdinEnds.length = 0;
  Object.assign(changed, { ahead: "src/x.ts\0", worktree: "", fail: false });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Deploying is the operator's: deploy.sh carries the checks the deploy needs
// (clean tree, lockfile match, no running tasks, pre-migration snapshot,
// post-deploy health and channels). The tool only hands over the line.
describe("vps_deploy — hands the deploy to the operator, spawns nothing", () => {
  it("returns an {error} refusal that names the operator and the deploy line", async () => {
    const out = await vpsDeployTool.execute({});
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/lo hace solo el operador/);
    expect(parsed.error).toMatch(/no compila, no corre tests ni reinicia/);
    expect((parsed.error as string).endsWith(`: ${OPERATOR_LINE}`)).toBe(true);
    // The confirmation flow adds `confirmed: true` to the call: same refusal.
    expect(await vpsDeployTool.execute({ confirmed: true })).toBe(out);
  });

  it("no build, no test run, no restart: no child of any kind", async () => {
    for (const fn of Object.values(otherChildren))
      expect(vi.isMockFunction(fn)).toBe(true);
    // The `node:` specifier resolves to the same mocks.
    expect(nodeChildProcess.spawn).toBe(otherChildren.spawn);
    expect(nodeChildProcess.execFile).toBe(execFile);
    await vpsDeployTool.execute({});
    await vpsDeployTool.execute({ confirmed: true });
    // A child deferred to a timer or an immediate is counted too.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
    expect(execGroupKill).not.toHaveBeenCalled();
    expect(childImpl).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    for (const fn of Object.values(otherChildren))
      expect(fn).not.toHaveBeenCalled();
    expect(stdinEnds).toHaveLength(0);
  });

  it("the refusal does not depend on the suite lock (held by jarvis_test_run)", async () => {
    let release!: (v: { stdout: string; stderr: string }) => void;
    execGroupKill.mockImplementation(() => new Promise((r) => (release = r)));
    const first = jarvisTestRunTool.execute({ typecheck_only: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const out = await vpsDeployTool.execute({});
    expect(out).not.toContain(SUITE_RUN_BUSY);
    expect(JSON.parse(out).error).toContain(OPERATOR_LINE);
    expect(execGroupKill).toHaveBeenCalledTimes(1); // jarvis_test_run's tsc only
    release({ stdout: "", stderr: "" });
    await first;
  });

  it("stays the same tool to the model: name, hints, schema, description", () => {
    expect(vpsDeployTool.name).toBe("vps_deploy");
    expect(vpsDeployTool.definition.function.name).toBe("vps_deploy");
    expect(vpsDeployTool.definition.function.description).toBe(
      DEPLOY_DESCRIPTION,
    );
    expect(vpsDeployTool.definition.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(vpsDeployTool).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      requiresConfirmation: true,
      deferred: true,
    });
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
