/**
 * Queue 3h (audit R1 C1): jarvis_dev's gate children (`systemd-run --scope`
 * execs `npx tsc` / `vitest related` in the jarvis worktree, whose code and
 * tests Jarvis writes) and its `gh pr create` child get the base env
 * allow-list, never the service env; the children that talk to GitHub add
 * only the agent's own token. A separate file because jarvis-dev.test.ts
 * drives REAL git and fs; these pins mock child_process and fs file-wide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";

const CACHE_FILE = "/root/claude/mission-control/.git/jarvis-test-cache.json";

const m = vi.hoisted(() => {
  // git answers: a jarvis/* branch with one changed .ts file. The protected-
  // file check before the push (its git children lead with
  // `-c core.hooksPath=/dev/null`) reads origin, the merge base and
  // `branch.diff`.
  const branch = { diff: "src/x.ts\0" };
  const git = (argv: string[]): string => {
    const args =
      argv[0] === "-c" && argv[1] === "core.hooksPath=/dev/null"
        ? argv.slice(2)
        : argv;
    if (args[0] === "ls-remote" || args[0] === "remote")
      return "https://github.com/kosm1x/agent-controller.git\n";
    if (args[0] === "branch") return "jarvis/feat/x\n";
    if (args[0] === "rev-parse") return "abc123\n";
    if (args[0] === "symbolic-ref") return "refs/heads/jarvis/feat/x\n";
    if (args[0] === "merge-base") return `${"b".repeat(40)}\n`;
    if (args[0] === "diff" && args.includes("--no-relative")) return branch.diff;
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
  // When set, the `git push` child fails with this error.
  const pushFailure: { err: Error | null } = { err: null };
  const execFileAsync = vi.fn((cmd: string, args: string[]) => {
    const end = vi.fn();
    children.push({ argv: `${cmd} ${args.join(" ")}`, end });
    if (cmd === "git" && args[0] === "push" && pushFailure.err) {
      const failed = Promise.reject(pushFailure.err);
      return Object.assign(failed, { child: { stdin: { end } } });
    }
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
  return {
    execFileSync,
    execFileAsync,
    execFile,
    fsState,
    children,
    branch,
    pushFailure,
  };
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
};
/** The agent's own GitHub token (synthetic). */
const AGENT_TOKEN = "canary-gh-token";

/** Every child: the base allow-list, never the service env. */
function expectBaseOnly(env: Record<string, string> | undefined): void {
  expect(env).toBeDefined();
  expect(env).not.toBe(process.env);
  expect(env!.PATH).toBe(process.env.PATH);
  expect(env!.HOME).toBe(process.env.HOME);
  for (const name of Object.keys(CANARIES))
    expect(env).not.toHaveProperty(name);
  expect(env).not.toHaveProperty("JARVIS_GH_TOKEN");
  expect(JSON.stringify(env)).not.toContain("canary-value");
  // Children get no stored login by default.
  expect(env!.GH_CONFIG_DIR).toMatch(/mc-gh-config-/);
  expect(env!.GIT_CONFIG_KEY_0).toBe("credential.helper");
  expect(env!.GIT_CONFIG_VALUE_0).toBe("");
}

/** A local or gate child: the base, and no GitHub token. */
function expectAllowListEnv(opts: unknown): void {
  const env = (opts as { env?: Record<string, string> }).env;
  expectBaseOnly(env);
  expect(env).not.toHaveProperty("GH_TOKEN");
  expect(JSON.stringify(env)).not.toContain(AGENT_TOKEN);
}

/** A child that talks to GitHub: the base plus the agent's own token. */
function expectAgentEnv(opts: unknown): void {
  const env = (opts as { env?: Record<string, string> }).env;
  expectBaseOnly(env);
  expect(env!.GH_TOKEN).toBe(AGENT_TOKEN);
  expect(env!.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
}

/** git/gh children that talk to GitHub (the protected-file check's fetch included). */
const isGithubChild = (c: unknown[]): boolean => {
  const argv = c[1] as string[];
  const verb = argv[0] === "-c" ? argv[2] : argv[0];
  return c[0] === "gh" || (c[0] === "git" && ["fetch", "push"].includes(verb));
};

const gateCall = (bin: string) =>
  m.execFileAsync.mock.calls.find((c) =>
    ((c as unknown[])[1] as string[]).includes(bin),
  ) as unknown[] | undefined;

beforeEach(() => {
  m.fsState.worktreeExists = true;
  m.branch.diff = "src/x.ts\0";
  m.execFileSync.mockClear();
  m.execFileAsync.mockClear();
  m.children.length = 0;
  for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
  vi.stubEnv("JARVIS_GH_TOKEN", AGENT_TOKEN);
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

  // GitHub children run under the agent's own account; nothing falls back to
  // a login stored on the host.
  it("action=pr: the `gh pr create` child gets the base plus the agent's own token", async () => {
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.pr_url).toBe("https://github.com/o/r/pull/9");
    const gh = m.execFileAsync.mock.calls.find((c) => c[0] === "gh");
    expect(gh).toBeDefined();
    expectAgentEnv((gh as unknown[])[2]);
  });

  it("action=pr: the push and the check's fetch run as the agent; the commit names the agent as author and committer, with no token", async () => {
    vi.stubEnv("JARVIS_GH_USER", "agent-bot");
    vi.stubEnv("JARVIS_GH_EMAIL", "agent@example.invalid");
    await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" });
    const calls = m.execFileAsync.mock.calls as unknown[][];
    const find = (pred: (argv: string[]) => boolean) =>
      calls.find((c) => c[0] === "git" && pred(c[1] as string[]));
    expectAgentEnv(find((a) => a[0] === "push")![2]);
    expectAgentEnv(find((a) => a[0] === "-c" && a[2] === "fetch")![2]);
    const commit = find((a) => a[0] === "commit")!;
    expectAllowListEnv(commit[2]);
    expect((commit[2] as { env: Record<string, string> }).env).toMatchObject({
      GIT_AUTHOR_NAME: "agent-bot",
      GIT_AUTHOR_EMAIL: "agent@example.invalid",
      GIT_COMMITTER_NAME: "agent-bot",
      GIT_COMMITTER_EMAIL: "agent@example.invalid",
    });
  });

  it("action=pr without the agent's token: one clear refusal, nothing committed, pushed or opened", async () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.error).toContain("JARVIS_GH_TOKEN");
    expect(out.error).toContain("Nothing was committed.");
    const argvs = (m.execFileAsync.mock.calls as unknown[][]).map(
      (c) => `${c[0]} ${(c[1] as string[]).join(" ")}`,
    );
    for (const verb of ["git --literal-pathspecs add", "git commit", "git push", "gh "])
      expect(argvs.some((a) => a.startsWith(verb)), verb).toBe(false);
  });

  it("action=pr: a push GitHub refuses for lack of write access returns one sentence naming the operator's invitation", async () => {
    m.pushFailure.err = Object.assign(
      new Error("Command failed: git push -u origin jarvis/feat/x"),
      { stderr: "remote: Permission to o/r.git denied to agent-bot." },
    );
    try {
      const out = JSON.parse(
        await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
      );
      expect(out.error).toBe(
        "GitHub refused this: the agent's GitHub account has no write access to the mission-control repository; the operator can invite that account to it.",
      );
      expect(
        m.execFileAsync.mock.calls.some((c) => c[0] === "gh"),
      ).toBe(false);
    } finally {
      m.pushFailure.err = null;
    }
  });

  it("action=pr: a push failure that echoes the agent's token keeps it out of the result and the journal line", async () => {
    m.pushFailure.err = Object.assign(
      new Error(`Command failed: git push -u origin jarvis/feat/x\nfatal: bad answer ${AGENT_TOKEN}`),
      { stderr: `fatal: bad answer ${AGENT_TOKEN}` },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" });
      expect(result).not.toContain(AGENT_TOKEN);
      expect(JSON.parse(result).error).toBe(
        "Push failed: Command failed: git push -u origin jarvis/feat/x\nfatal: bad answer ***",
      );
      const lines = log.mock.calls.map((c) => c.map(String).join(" "));
      const failed = lines.filter((l) => l.includes("PUSH FAILED"));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain("fatal: bad answer ***");
      expect(lines.join("\n")).not.toContain(AGENT_TOKEN);
    } finally {
      log.mockRestore();
      m.pushFailure.err = null;
    }
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
      // Only a child that talks to GitHub carries the agent's token.
      if (isGithubChild(c)) expectAgentEnv(c[2]);
      else expectAllowListEnv(c[2]);
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

// The protected-file list holds at the push: action=pr checks what the
// committed branch changes against origin/main before anything is sent.
describe("jarvis_dev action=pr — protected files are checked again before the push", () => {
  const argvs = () =>
    (m.execFileAsync.mock.calls as unknown[][]).map(
      (c) => `${c[0]} ${(c[1] as string[]).join(" ")}`,
    );

  it("a branch that changes a protected file is refused after the commit: nothing is pushed, no pull request", async () => {
    m.branch.diff = "src/x.ts\0src/tools/builtin/jarvis-dev.ts\0";
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.error).toContain("src/tools/builtin/jarvis-dev.ts");
    expect(out.error).not.toContain("src/x.ts");
    expect(argvs().some((a) => a.startsWith("git commit "))).toBe(true);
    expect(argvs().some((a) => a.startsWith("git push"))).toBe(false);
    expect(argvs().some((a) => a.startsWith("gh "))).toBe(false);
  });

  it("a branch of ordinary files is checked, then pushed", async () => {
    const out = JSON.parse(
      await jarvisDevTool.execute({ action: "pr", title: "t", body: "b" }),
    );
    expect(out.pr_url).toBe("https://github.com/o/r/pull/9");
    const at = (prefix: string) => argvs().findIndex((a) => a.startsWith(prefix));
    const mergeBase = at("git -c core.hooksPath=/dev/null merge-base");
    expect(mergeBase).toBeGreaterThan(at("git commit "));
    expect(mergeBase).toBeLessThan(at("git push -u origin"));
  });
});
