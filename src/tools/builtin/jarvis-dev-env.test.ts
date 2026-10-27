/**
 * Queue 3h (audit R1 C1): jarvis_dev's gate children (`systemd-run --scope`
 * execs `npx tsc` / `vitest related` in the jarvis worktree, whose code and
 * tests Jarvis writes) and its `gh pr create` child get the base env
 * allow-list, never the service env. A separate file because jarvis-dev.test.ts
 * drives REAL git and fs; these pins mock child_process and fs file-wide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";

const CACHE_FILE = "/root/claude/mission-control/.git/jarvis-test-cache.json";

const m = vi.hoisted(() => {
  // git answers: a jarvis/* branch with one changed .ts file.
  const git = (args: string[]): string => {
    if (args[0] === "branch") return "jarvis/feat/x\n";
    if (args[0] === "rev-parse") return "abc123\n";
    if (args[0] === "status" && args.includes("-z")) return " M src/x.ts\0";
    if (args[0] === "diff" && args.includes("-z"))
      return args.some((a) => a.endsWith("...HEAD")) ? "src/x.ts\0" : "";
    return "";
  };
  const execFileSync = vi.fn((cmd: string, args: string[]) =>
    cmd === "gh" ? "https://github.com/o/r/pull/9\n" : git(args),
  );
  // run() (git), the porcelain read, `gh pr create` and the systemd-run gate
  // children all go through promisify(execFile) since the 2026-10-26
  // event-loop fix — routed by command. Like the real promisified execFile,
  // the promise carries `.child`; each child's stdin.end is recorded.
  const children: Array<{ argv: string; end: ReturnType<typeof vi.fn> }> = [];
  const execFileAsync = vi.fn((cmd: string, args: string[]) => {
    const end = vi.fn();
    children.push({ argv: `${cmd} ${args.join(" ")}`, end });
    const result = Promise.resolve({
      stdout:
        cmd === "git"
          ? git(args)
          : cmd === "gh"
            ? "https://github.com/o/r/pull/9\n"
            : "Test Files  1 passed (1)\nTests  1 passed (1)",
      stderr: "",
    });
    return Object.assign(result, { child: { stdin: { end } } });
  });
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execFileAsync,
  });
  // false → ensureJarvisWorktree runs `git worktree add` (jarvis-dev.ts:49).
  const fsState = { worktreeExists: true };
  return { execFileSync, execFileAsync, execFile, fsState, children };
});

vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFile: m.execFile,
  execFileSync: m.execFileSync,
}));
// No real fs side effect: the test cache in the primary's .git is neither
// read nor written; the worktree "exists".
vi.mock("fs", async (orig) => {
  const actual = await orig<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) =>
      p === "/root/claude/mission-control-jarvis"
        ? m.fsState.worktreeExists
        : true,
    ),
    symlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      if (p === CACHE_FILE) throw new Error("ENOENT");
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }),
  };
});
vi.mock("../../db/index.js", () => ({ getDatabase: vi.fn() }));

import { jarvisDevTool } from "./jarvis-dev.js";
import { withCwdLock } from "./cwd-lock.js";

const CANARIES: Record<string, string> = {
  CANARY_API_KEY: "canary-value-1",
  FIREWORKS_API_KEY: "canary-value-2",
  TELEGRAM_BOT_TOKEN: "canary-value-3",
  SOME_UNRELATED_SETTING: "canary-value-4",
  JARVIS_GH_TOKEN: "canary-value-5",
};

function expectAllowListEnv(opts: unknown): void {
  const env = (opts as { env?: Record<string, string> }).env;
  expect(env).toBeDefined();
  expect(env).not.toBe(process.env);
  expect(env!.PATH).toBe(process.env.PATH);
  expect(env!.HOME).toBe(process.env.HOME);
  for (const name of Object.keys(CANARIES))
    expect(env).not.toHaveProperty(name);
  // The gh child uses the operator's own gh auth (HOME), never a token.
  expect(env).not.toHaveProperty("GH_TOKEN");
  expect(JSON.stringify(env)).not.toContain("canary-value");
}

const gateCall = (bin: string) =>
  m.execFileAsync.mock.calls.find((c) =>
    ((c as unknown[])[1] as string[]).includes(bin),
  ) as unknown[] | undefined;

beforeEach(() => {
  m.fsState.worktreeExists = true;
  m.execFileSync.mockClear();
  m.execFileAsync.mockClear();
  m.children.length = 0;
  for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("jarvis_dev — child env is an allow-list, never the service env (queue 3h)", () => {
  it("action=test: the systemd-run `npx tsc --noEmit` child", async () => {
    await jarvisDevTool.execute({ action: "test" });
    const call = gateCall("tsc");
    expect(call?.[0]).toBe("systemd-run");
    expectAllowListEnv(call![2]);
  });

  it("action=test: the systemd-run `vitest related` child", async () => {
    await jarvisDevTool.execute({ action: "test" });
    const call = gateCall("vitest");
    expect(call?.[0]).toBe("systemd-run");
    expectAllowListEnv(call![2]);
  });

  it("action=pr: the `gh pr create` child", async () => {
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.pr_url).toBe("https://github.com/o/r/pull/9");
    const gh = m.execFileAsync.mock.calls.find((c) => c[0] === "gh");
    expect(gh).toBeDefined();
    expectAllowListEnv((gh as unknown[])[2]);
  });

  it("action=pr on a fresh worktree: EVERY execFile/execFileSync child gets the allow-list", async () => {
    m.fsState.worktreeExists = false;
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.pr_url).toBe("https://github.com/o/r/pull/9");
    const sync = m.execFileSync.mock.calls as unknown[][];
    const asyncCalls = m.execFileAsync.mock.calls as unknown[][];
    const argv = (c: unknown[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`;
    // Sync: ensureJarvisWorktree's worktree add (one-time bootstrap) and
    // changed-tests.ts's -z listings. Async: run() (branch/rev-parse/status/
    // diff/ls-files/add/commit/push), the porcelain read, gh, the gate.
    expect(
      sync
        .map(argv)
        .some((a) =>
          a.startsWith("git -C /root/claude/mission-control worktree add"),
        ),
    ).toBe(true);
    for (const want of [
      "git branch --show-current",
      "git status --porcelain -z",
      "git commit",
      "git push -u origin",
      "gh pr create",
    ])
      expect(asyncCalls.map(argv).some((a) => a.startsWith(want))).toBe(true);
    const all = [...sync, ...asyncCalls];
    expect(asyncCalls.filter((c) => c[0] === "systemd-run")).toHaveLength(2);
    for (const c of all) {
      const env = (c[2] as { env?: Record<string, string> }).env;
      expect(env, `${c[0]} ${(c[1] as string[]).join(" ")}`).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(JSON.stringify(env)).not.toContain("canary-value");
    }
  });
});

describe("jarvis_dev action=pr — async children (MCEventLoopBlock 2026-10-26)", () => {
  const prArgv = () =>
    (m.execFileAsync.mock.calls as unknown[][]).map(
      (c) => `${c[0]} ${(c[1] as string[]).join(" ")}`,
    );

  it("stages, commits, pushes, then opens the PR — in that order", async () => {
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.pr_url).toBe("https://github.com/o/r/pull/9");
    const argvs = prArgv();
    const at = (prefix: string) => argvs.findIndex((a) => a.startsWith(prefix));
    const order = [
      at("git --literal-pathspecs add -- src/x.ts"),
      at("git commit "),
      at("git push -u origin jarvis/feat/x"),
      at("gh pr create"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("closes stdin on every git/gh child so a stdin read fails fast, not at the timeout", async () => {
    await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" });
    const gitGh = m.children.filter(
      (c) => c.argv.startsWith("git ") || c.argv.startsWith("gh "),
    );
    // run() (branch/rev-parse/status/diff/ls-files/add/commit/push), the
    // porcelain read and gh all covered.
    for (const want of [
      "git branch --show-current",
      "git status --porcelain -z",
      "git push -u origin",
      "gh pr create",
    ])
      expect(gitGh.some((c) => c.argv.startsWith(want))).toBe(true);
    for (const c of gitGh) expect(c.end, c.argv).toHaveBeenCalledTimes(1);
  });

  // Queue 4ao (h): the systemd-run gate children kept stdin open.
  it("closes stdin on both systemd-run gate children (tsc + vitest related)", async () => {
    await jarvisDevTool.execute({ action: "test" });
    const gate = m.children.filter((c) => c.argv.startsWith("systemd-run "));
    expect(gate).toHaveLength(2);
    for (const c of gate) expect(c.end, c.argv).toHaveBeenCalledTimes(1);
  });
});

// Queue 4ao (f)(ii): add→commit→push→PR runs under the worktree's cwd lock,
// the same lock git_* tools take for that cwd.
describe("jarvis_dev action=pr — per-cwd lock on the worktree (4ao f)", () => {
  it("does not stage anything while another call holds the worktree's lock; proceeds after", async () => {
    let release!: () => void;
    const holder = withCwdLock(
      "/root/claude/mission-control-jarvis/",
      () => new Promise<void>((r) => (release = r)),
    );
    const argvs = () =>
      (m.execFileAsync.mock.calls as unknown[][]).map(
        (c) => `${c[0]} ${(c[1] as string[]).join(" ")}`,
      );
    const pr = jarvisDevTool.execute({ action: "pr", title: "t", body: "b" });
    // The gate (outside the lock) runs to completion; staging must wait.
    await vi.waitFor(() =>
      expect(argvs().filter((a) => a.startsWith("systemd-run "))).toHaveLength(
        2,
      ),
    );
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(argvs().some((a) => a.startsWith("git status --porcelain -z"))).toBe(
      false,
    );
    expect(argvs().some((a) => a.startsWith("git --literal-pathspecs add"))).toBe(
      false,
    );
    release();
    await holder;
    expect(JSON.parse(await pr).pr_url).toBe("https://github.com/o/r/pull/9");
    expect(argvs().some((a) => a.startsWith("git push -u origin"))).toBe(true);
  });
});
