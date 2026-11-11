/**
 * V8.4 landing probe: claims are extracted conservatively (no bare "#2", no
 * UUID-shaped "commits"), verified against the REMOTE, and a report with no
 * claim is unverified — never met.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only defaultLandingExec spawns; every other test injects its own exec.
const childMock = vi.hoisted(() => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, out: string) => void) =>
      cb(null, ""),
  ),
}));
vi.mock("node:child_process", () => ({ execFile: childMock.execFile }));

import {
  defaultLandingExec,
  extractLandingClaims,
  probeLanding,
  type LandingExec,
} from "./landing.js";

describe("extractLandingClaims", () => {
  it("finds remote heads named verbatim, branch/rama phrases, explicit PRs, and commit-word SHAs", () => {
    const text = [
      "Implementé el fix en la rama feat/ledger-wall y abrí el PR #31.",
      "Also pushed to fix/status-source (see https://github.com/x/y/pull/32).",
      "commit 9a41878c lands the change; task adcda0f2-1234-5678-9abc-def012345678 was the trigger.",
      "Step #2 of 3 done. Version 1.2.3.",
    ].join("\n");
    const claims = extractLandingClaims(text, [
      "main",
      "feat/ledger-wall",
      "unrelated",
    ]);
    expect(claims.branches.sort()).toEqual([
      "feat/ledger-wall",
      "fix/status-source",
    ]);
    expect(claims.prs.sort()).toEqual([31, 32]);
    expect(claims.shas).toEqual(["9a41878c"]);
  });

  it("ignores main/master, bare '#N', and hex that is not introduced by a commit word", () => {
    const claims = extractLandingClaims(
      "Merged to main. Item #4 and #12 fixed. Hash deadbeef1 appears in a log line.",
      ["main"],
    );
    expect(claims.branches).toEqual([]);
    expect(claims.prs).toEqual([]);
    expect(claims.shas).toEqual([]);
  });
});

function makeExec(opts: {
  heads?: string[];
  prs?: Record<number, string>;
  remoteShas?: string[];
  lsRemoteFails?: boolean;
}): { exec: LandingExec; calls: string[] } {
  const calls: string[] = [];
  const exec: LandingExec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "ls-remote") {
      if (opts.lsRemoteFails) return { stdout: "", exitCode: 128 };
      return {
        stdout: (opts.heads ?? [])
          .map((h, i) => `${i}abc\trefs/heads/${h}`)
          .join("\n"),
        exitCode: 0,
      };
    }
    if (cmd === "gh" && args[0] === "pr") {
      const n = Number(args[2]);
      const state = opts.prs?.[n];
      return state
        ? {
            stdout: JSON.stringify({ number: n, state, headRefName: "x" }),
            exitCode: 0,
          }
        : { stdout: "", exitCode: 1 };
    }
    if (cmd === "git" && args[0] === "fetch")
      return { stdout: "", exitCode: 0 };
    if (cmd === "git" && args[0] === "branch") {
      const sha = args[3] ?? "";
      return (opts.remoteShas ?? []).includes(sha)
        ? { stdout: "  origin/feat/x\n", exitCode: 0 }
        : { stdout: "", exitCode: 129 };
    }
    return { stdout: "", exitCode: 1 };
  };
  return { exec, calls };
}

describe("probeLanding", () => {
  it("landed=true when a claimed branch exists on origin", async () => {
    const { exec } = makeExec({ heads: ["main", "feat/ledger"] });
    const p = await probeLanding({ text: "Pushed branch feat/ledger.", exec });
    expect(p.landed).toBe(true);
    expect(p.evidence).toContain("branch feat/ledger on origin");
  });

  it("landed=false when the report claims a branch/PR/commit that is not on origin", async () => {
    const { exec } = makeExec({ heads: ["main"], prs: {} });
    const p = await probeLanding({
      text: "Opened PR #99 from branch feat/ghost, commit 1a2b3c4d.",
      exec,
    });
    expect(p.landed).toBe(false);
    expect(p.evidence).toMatch(/claimed but NOT on origin/);
    expect(p.evidence).toContain("branch feat/ghost");
    expect(p.evidence).toContain("PR #99");
    expect(p.evidence).toContain("commit 1a2b3c4d");
  });

  it("a PR that exists verifies; commit claims are checked against REMOTE refs after a fetch", async () => {
    const { exec, calls } = makeExec({
      heads: ["main"],
      prs: { 31: "OPEN" },
      remoteShas: ["9a41878c"],
    });
    const p = await probeLanding({
      text: "PR #31 open; commit 9a41878c pushed.",
      exec,
    });
    expect(p.landed).toBe(true);
    expect(p.evidence).toContain("PR #31 OPEN");
    expect(p.evidence).toContain("commit 9a41878c on origin");
    expect(calls).toContain("git fetch --quiet origin");
    expect(
      calls.some((c) => c.startsWith("git branch -r --contains 9a41878c")),
    ).toBe(true);
  });

  it("landed=null (unverified) when the report makes no claim, or the remote is unreachable", async () => {
    const { exec } = makeExec({ heads: ["main"] });
    expect(
      (await probeLanding({ text: "Todo listo.", exec })).landed,
    ).toBeNull();
    const down = makeExec({ lsRemoteFails: true });
    const p = await probeLanding({
      text: "Pushed branch feat/x",
      exec: down.exec,
    });
    expect(p.landed).toBeNull();
    expect(p.evidence).toMatch(/remote unreachable/);
  });
});

describe("qa I4 fold — landed only when EVERY claim verifies", () => {
  it("an existing branch mentioned next to an unpushed commit reads as NOT landed", async () => {
    const { exec } = makeExec({ heads: ["main", "feat/ledger"], remoteShas: [] });
    const p = await probeLanding({
      text: "Work is on branch feat/ledger; commit 9a41878c has the fix.",
      exec,
    });
    expect(p.landed).toBe(false);
    expect(p.evidence).toContain("claimed but NOT on origin: commit 9a41878c");
    expect(p.evidence).toContain("verified: branch feat/ledger on origin");
  });
});

// The probe's reads of GitHub run under the agent's own account; nothing
// falls back to a login stored on the host.
describe("defaultLandingExec — GitHub reads run as the agent", () => {
  const envOf = (c: unknown[]) =>
    (c[2] as { env: Record<string, string> }).env;
  afterEach(() => {
    vi.unstubAllEnvs();
    childMock.execFile.mockClear();
  });

  it("gh, ls-remote and fetch get the agent's token; a local read does not; neither gets the service env", async () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "canary-gh-token");
    vi.stubEnv("CANARY_API_KEY", "canary-value-1");
    await defaultLandingExec("gh", ["pr", "view", "31"], { timeoutMs: 1000 });
    await defaultLandingExec("git", ["ls-remote", "--heads", "origin"], {
      timeoutMs: 1000,
    });
    await defaultLandingExec("git", ["fetch", "--quiet", "origin"], {
      timeoutMs: 1000,
    });
    await defaultLandingExec("git", ["branch", "-r", "--contains", "abc"], {
      timeoutMs: 1000,
    });
    const calls = childMock.execFile.mock.calls as unknown[][];
    expect(calls).toHaveLength(4);
    for (const c of calls.slice(0, 3)) {
      expect(envOf(c).GH_TOKEN).toBe("canary-gh-token");
      expect(envOf(c).GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(envOf(c).GIT_CONFIG_VALUE_0).toBe("");
    }
    expect(envOf(calls[3])).not.toHaveProperty("GH_TOKEN");
    for (const c of calls) {
      expect(envOf(c).GH_CONFIG_DIR).toMatch(/mc-gh-config-/);
      expect(envOf(c).GIT_TERMINAL_PROMPT).toBe("0");
      expect(envOf(c)).not.toHaveProperty("CANARY_API_KEY");
      expect(envOf(c)).not.toHaveProperty("JARVIS_GH_TOKEN");
    }
  });

  it("without the agent's token a GitHub read is not spawned and answers as unreachable, so the claim stays unverified", async () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    expect(
      await defaultLandingExec("git", ["ls-remote", "--heads", "origin"], {
        timeoutMs: 1000,
      }),
    ).toEqual({ stdout: "", exitCode: 1 });
    expect(childMock.execFile).not.toHaveBeenCalled();
    const p = await probeLanding({
      text: "Pushed branch feat/x",
      exec: defaultLandingExec,
    });
    expect(p.landed).toBeNull();
    expect(childMock.execFile).not.toHaveBeenCalled();
  });
  // The env carries an empty gh config directory created on first use; when
  // it cannot be created the read answers like an unreachable remote.
  it("an env that cannot be built resolves as unreachable (no child, landing unverified), for GitHub and local reads", async () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "canary-gh-token");
    vi.resetModules();
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        mkdtempSync: (prefix: string, ...rest: unknown[]) => {
          if (String(prefix).includes("mc-gh-config-")) throw new Error("EACCES: mkdtemp refused (test)");
          return (actual.mkdtempSync as (...a: unknown[]) => string)(prefix, ...rest);
        },
      };
    });
    try {
      const fresh = await import("./landing.js");
      for (const [cmd, args] of [
        ["git", ["ls-remote", "--heads", "origin"]],
        ["git", ["branch", "-r", "--contains", "abc"]],
      ] as const) {
        expect(await fresh.defaultLandingExec(cmd, [...args], { timeoutMs: 1000 })).toEqual({
          stdout: "",
          exitCode: 1,
        });
      }
      const p = await fresh.probeLanding({ text: "Pushed branch feat/x", exec: fresh.defaultLandingExec });
      expect(p.landed).toBeNull();
      expect(childMock.execFile).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("fs");
      vi.resetModules();
    }
  });
});
