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
  const execFileAsync = vi.fn(async () => ({
    stdout: "Test Files  1 passed (1)\nTests  1 passed (1)",
    stderr: "",
  }));
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execFileAsync,
  });
  // false → ensureJarvisWorktree runs `git worktree add` (jarvis-dev.ts:49).
  const fsState = { worktreeExists: true };
  return { execFileSync, execFileAsync, execFile, fsState };
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
    const gh = m.execFileSync.mock.calls.find((c) => c[0] === "gh");
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
    const argvs = sync.map((c) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    // :49 worktree add, :208 run() (branch/rev-parse/status/diff/ls-files/
    // add/commit/push), :692 porcelain, changed-tests.ts:48 -z listings, gh.
    for (const want of [
      "git -C /root/claude/mission-control worktree add",
      "git branch --show-current",
      "git status --porcelain -z",
      "git commit",
      "git push -u origin",
      "gh pr create",
    ])
      expect(argvs.some((a) => a.startsWith(want))).toBe(true);
    const all = [...sync, ...(m.execFileAsync.mock.calls as unknown[][])];
    expect(m.execFileAsync).toHaveBeenCalledTimes(2);
    for (const c of all) {
      const env = (c[2] as { env?: Record<string, string> }).env;
      expect(env, `${c[0]} ${(c[1] as string[]).join(" ")}`).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(JSON.stringify(env)).not.toContain("canary-value");
    }
  });
});
