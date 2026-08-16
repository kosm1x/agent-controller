/**
 * V8.4 landing probe: claims are extracted conservatively (no bare "#2", no
 * UUID-shaped "commits"), verified against the REMOTE, and a report with no
 * claim is unverified — never met.
 */
import { describe, expect, it } from "vitest";
import {
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
