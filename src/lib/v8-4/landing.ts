/**
 * V8.4 — work-landing probe for sandboxed coding tasks.
 *
 * The nanoclaw worker edits a clone INSIDE the container and pushes to
 * origin; the host tree never changes. Twice (07-17, 08-02) a worker "fixed"
 * a bug in the container, the reflector scored the run completed, and
 * nothing had landed anywhere (`feedback_turn_exhaustion_unwinnable_endgame`).
 * This probe runs on the HOST at task end and asks the only witness that
 * matters — the remote — whether the branch / PR / commit the report claims
 * actually exists.
 *
 * Verdict: `true` (≥1 claim verified on origin) · `false` (claims found, none
 * verified) · `null` (no claim in the report — stays UNVERIFIED, never met).
 */
import { execFile } from "node:child_process";

export type LandingExec = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; exitCode: number | null }>;

export const defaultLandingExec: LandingExec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/root",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (err, stdout) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({ stdout: String(stdout ?? ""), exitCode: err ? code : 0 });
      },
    );
  });

export const DEFAULT_LANDING_REPO_DIR = "/root/claude/mission-control";

let execOverride: LandingExec | null = null;
/** @internal test hook — the consumer path has no injection seam for the probe. */
export function _setLandingExecForTests(exec: LandingExec | null): void {
  execOverride = exec;
}
const NON_LANDING_BRANCHES = new Set(["main", "master", "HEAD"]);

export interface LandingClaims {
  branches: string[];
  prs: number[];
  shas: string[];
}

/** Pull branch / PR / commit claims out of a free-text report. */
export function extractLandingClaims(
  text: string,
  remoteHeads: readonly string[],
): LandingClaims {
  const branches = new Set<string>();
  // Any remote head named verbatim in the report (the strongest signal).
  for (const head of remoteHeads) {
    if (NON_LANDING_BRANCHES.has(head)) continue;
    if (text.includes(head)) branches.add(head);
  }
  // Branch-like tokens the report says it pushed / created (may NOT exist).
  const branchRe =
    /(?:\bbranch\b|\brama\b|\bpush(?:ed|é|ado)?\s+(?:to|a)\b|\borigin\/)\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._/-]{2,})/g;
  for (const m of text.matchAll(branchRe)) {
    const name = m[1].replace(/[`'".,;:)]+$/, "");
    if (!NON_LANDING_BRANCHES.has(name)) branches.add(name);
  }
  const prs = new Set<number>();
  // Only EXPLICIT PR references. A bare "#2" is a list item / issue as often
  // as a PR, and old low-numbered PRs exist on origin — a bare match would
  // "verify" a claim the report never made.
  for (const m of text.matchAll(
    /(?:\bPR\b|\bpull request\b|\/pull\/)\s*#?\s*(\d{1,6})\b/gi,
  )) {
    prs.add(Number(m[1]));
  }
  const shas = new Set<string>();
  // Commit claims need the word — task ids are UUIDs whose first block is
  // 8 hex chars, and a bare hex matcher would probe every task id mentioned.
  for (const m of text.matchAll(
    /(?:\bcommits?\b|\bsha\b|\bpushed\b|\bcommit(?:ted|é|eado)\b)[^\n]{0,24}?(?<![A-Za-z0-9])([0-9a-f]{7,40})(?![A-Za-z0-9]|-[0-9a-f])/gi,
  )) {
    const sha = m[1].toLowerCase();
    if (/\d/.test(sha) && /[a-f]/.test(sha)) shas.add(sha);
  }
  return {
    branches: Array.from(branches),
    prs: Array.from(prs),
    shas: Array.from(shas),
  };
}

export interface LandingProbe {
  landed: boolean | null;
  evidence: string;
  claims: LandingClaims;
}

export async function probeLanding(opts: {
  text: string;
  repoDir?: string;
  exec?: LandingExec;
  timeoutMs?: number;
}): Promise<LandingProbe> {
  const exec = opts.exec ?? execOverride ?? defaultLandingExec;
  const cwd = opts.repoDir ?? DEFAULT_LANDING_REPO_DIR;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const heads = await exec("git", ["ls-remote", "--heads", "origin"], {
    cwd,
    timeoutMs,
  });
  if (heads.exitCode !== 0) {
    return {
      landed: null,
      evidence: `ls-remote failed (exit ${heads.exitCode ?? "?"}) — remote unreachable, landing unverified`,
      claims: { branches: [], prs: [], shas: [] },
    };
  }
  const remoteHeads = heads.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[1] ?? "")
    .filter((r) => r.startsWith("refs/heads/"))
    .map((r) => r.slice("refs/heads/".length));
  const claims = extractLandingClaims(opts.text, remoteHeads);
  const verified: string[] = [];
  const missing: string[] = [];

  const headSet = new Set(remoteHeads);
  for (const b of claims.branches) {
    if (headSet.has(b)) verified.push(`branch ${b} on origin`);
    else missing.push(`branch ${b}`);
  }
  for (const pr of claims.prs) {
    const r = await exec(
      "gh",
      ["pr", "view", String(pr), "--json", "number,state,headRefName"],
      { cwd, timeoutMs },
    );
    if (r.exitCode === 0) {
      let state = "";
      try {
        state = String(
          (JSON.parse(r.stdout) as { state?: string }).state ?? "",
        );
      } catch {
        /* evidence stays terse */
      }
      verified.push(`PR #${pr}${state ? ` ${state}` : ""}`);
    } else {
      missing.push(`PR #${pr}`);
    }
  }
  if (claims.shas.length > 0) {
    await exec("git", ["fetch", "--quiet", "origin"], { cwd, timeoutMs });
    for (const sha of claims.shas) {
      // Reachable from a REMOTE ref — a commit that merely exists in the
      // host object store (jarvis_dev worktree, unpushed) has not landed.
      const r = await exec("git", ["branch", "-r", "--contains", sha], {
        cwd,
        timeoutMs,
      });
      if (r.exitCode === 0 && r.stdout.trim())
        verified.push(`commit ${sha.slice(0, 12)} on origin`);
      else missing.push(`commit ${sha.slice(0, 12)}`);
    }
  }

  // Landed only when EVERY claim verifies (qa I4 2026-08-16): a report that
  // names an existing branch while its own commit never landed must not read
  // as met — that is precisely the class this probe exists for.
  if (verified.length > 0 && missing.length === 0) {
    return { landed: true, evidence: verified.slice(0, 4).join("; "), claims };
  }
  if (missing.length > 0) {
    const ok = verified.length > 0 ? `; verified: ${verified.slice(0, 3).join(", ")}` : "";
    return {
      landed: false,
      evidence: `claimed but NOT on origin: ${missing.slice(0, 4).join("; ")}${ok}`,
      claims,
    };
  }
  return {
    landed: null,
    evidence: "no branch/PR/commit claim in the report",
    claims,
  };
}
