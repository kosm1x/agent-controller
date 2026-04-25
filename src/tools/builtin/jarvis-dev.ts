/**
 * jarvis_dev — Jarvis's self-improvement tool.
 *
 * Enables Jarvis to create branches on his own repo, run tests,
 * and open PRs for human review. NEVER pushes to main.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Tool } from "../types.js";

const MC_DIR = "/root/claude/mission-control";
const JARVIS_BRANCH_RE = /^jarvis\/(feat|fix|refactor)\/.+$/;
// Full suite runs ~105s on an idle VPS. 120s left <15% headroom, so any
// concurrent inference/swap pressure pushed it over and ETIMEDOUT was then
// misparsed as "tests failed" by the catch-branch regex. 300s is 3x headroom.
const TIMEOUT_MS = 300_000;
// Git ops (status/add/commit/push) can take longer than 10s on a loaded box.
// `push` in particular hits the network and does pre-commit hooks.
const GIT_TIMEOUT_MS = 60_000;

// action=test caches its result so action=pr can skip re-running the full
// suite when nothing has changed since. Tests take 136s+ and that alone can
// exceed the caller's per-query budget.
const TEST_CACHE_FILE = join(MC_DIR, ".git", "jarvis-test-cache.json");
export const TEST_CACHE_TTL_MS = 15 * 60 * 1000;

export interface TestCacheEntry {
  branch: string;
  head_sha: string;
  dirty_hash: string;
  tested_at_ms: number;
  typecheck: string;
  tests: string;
  ready_for_pr: boolean;
}

export interface WorkingTreeState {
  branch: string;
  head_sha: string;
  dirty_hash: string;
  now_ms: number;
}

function run(args: string[], opts?: { timeout?: number }): string {
  return execFileSync("git", args, {
    cwd: MC_DIR,
    timeout: opts?.timeout ?? GIT_TIMEOUT_MS,
    encoding: "utf-8",
  }).trim();
}

function currentBranch(): string {
  try {
    return run(["branch", "--show-current"]);
  } catch {
    return "HEAD";
  }
}

/**
 * Pure hash over the inputs that describe a working tree's state.
 * `git diff` does NOT include untracked-file content, so we hash untracked
 * files separately — otherwise an untracked file edited in-place would be
 * invisible to the cache key. Exported for unit testing.
 */
export function computeDirtyHash(inputs: {
  porcelain: string;
  diffUnstaged: string;
  diffStaged: string;
  untracked: Array<{ path: string; bytes: Buffer }>;
}): string {
  const hasher = createHash("sha256");
  hasher.update(inputs.porcelain);
  hasher.update("\0");
  hasher.update(inputs.diffUnstaged);
  hasher.update("\0");
  hasher.update(inputs.diffStaged);
  hasher.update("\0");
  // Sort by path so directory-listing order doesn't perturb the hash.
  const sorted = [...inputs.untracked].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const { path, bytes } of sorted) {
    hasher.update(path);
    hasher.update("\0");
    hasher.update(bytes);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 16);
}

function readUntrackedContents(): Array<{ path: string; bytes: Buffer }> {
  const list = run(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  const out: Array<{ path: string; bytes: Buffer }> = [];
  for (const path of list) {
    try {
      out.push({ path, bytes: readFileSync(join(MC_DIR, path)) });
    } catch {
      // File may have vanished between `ls-files` and read — include the
      // path with empty bytes so absence is still part of the signature.
      out.push({ path, bytes: Buffer.alloc(0) });
    }
  }
  return out;
}

function computeWorkingTreeState(): Omit<WorkingTreeState, "now_ms"> | null {
  try {
    const branch = currentBranch();
    const head_sha = run(["rev-parse", "HEAD"]);
    const porcelain = run(["status", "--porcelain"]);
    const diffUnstaged = run(["diff"]);
    const diffStaged = run(["diff", "--staged"]);
    const untracked = readUntrackedContents();
    const dirty_hash = computeDirtyHash({
      porcelain,
      diffUnstaged,
      diffStaged,
      untracked,
    });
    return { branch, head_sha, dirty_hash };
  } catch {
    return null;
  }
}

/**
 * Pure check: did the working tree change between two snapshots taken
 * around the test run? If so, tests ran on code different from what
 * ended up on disk and the result must not be trusted. Null snapshots
 * mean we couldn't measure — treat as mutated, the safe default.
 * Exported for unit testing.
 */
export function detectRunMutation(
  pre: Omit<WorkingTreeState, "now_ms"> | null,
  post: Omit<WorkingTreeState, "now_ms"> | null,
): boolean {
  if (!pre || !post) return true;
  if (pre.branch !== post.branch) return true;
  if (pre.head_sha !== post.head_sha) return true;
  if (pre.dirty_hash !== post.dirty_hash) return true;
  return false;
}

function readTestCache(): TestCacheEntry | null {
  try {
    return JSON.parse(readFileSync(TEST_CACHE_FILE, "utf-8")) as TestCacheEntry;
  } catch {
    return null;
  }
}

function writeTestCache(entry: TestCacheEntry): void {
  try {
    writeFileSync(TEST_CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch {
    // Best-effort cache write; never fail the action because of cache IO.
  }
}

/**
 * Pure check: is this cache entry still trustworthy for the current state?
 * Exported for unit testing — real callers go through getFreshPassingCache.
 */
export function isCacheFresh(
  cache: TestCacheEntry | null,
  state: WorkingTreeState,
): boolean {
  if (!cache) return false;
  if (!cache.ready_for_pr) return false;
  if (cache.branch !== state.branch) return false;
  if (state.now_ms - cache.tested_at_ms > TEST_CACHE_TTL_MS) return false;
  if (cache.head_sha !== state.head_sha) return false;
  if (cache.dirty_hash !== state.dirty_hash) return false;
  return true;
}

function getFreshPassingCache(branch: string): TestCacheEntry | null {
  const wt = computeWorkingTreeState();
  if (!wt || wt.branch !== branch) return null;
  const cache = readTestCache();
  return isCacheFresh(cache, { ...wt, now_ms: Date.now() }) ? cache : null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function actionBranch(type: string, slug: string): string {
  const branchName = `jarvis/${type}/${slug}`;
  if (!["feat", "fix", "refactor"].includes(type)) {
    return JSON.stringify({
      error: `Invalid type "${type}". Use: feat, fix, refactor`,
    });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return JSON.stringify({
      error: `Invalid slug "${slug}". Use lowercase alphanumeric + hyphens.`,
    });
  }

  // Ensure we're on main and up to date
  try {
    run(["checkout", "main"]);
    run(["pull", "origin", "main"]);
  } catch {
    // pull may fail if no remote — continue anyway
  }

  // Create and switch to branch
  try {
    run(["checkout", "-b", branchName]);
  } catch (err) {
    // Branch may already exist
    try {
      run(["checkout", branchName]);
    } catch {
      return JSON.stringify({
        error: `Failed to create branch: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  return JSON.stringify({
    success: true,
    branch: branchName,
    cwd: MC_DIR,
    next_steps: [
      "Use file_edit/file_write to make changes in /root/claude/mission-control/",
      "Use shell_exec to run builds/tests in /root/claude/mission-control/",
      'When done: jarvis_dev action="test" to verify',
      'Then: jarvis_dev action="pr" to open a pull request',
    ],
  });
}

function actionTest(): string {
  const branch = currentBranch();
  if (!JARVIS_BRANCH_RE.test(branch)) {
    return JSON.stringify({
      error: `Not on a jarvis/* branch (current: "${branch}"). Create one first with action="branch".`,
    });
  }

  const results: { typecheck: string; tests: string } = {
    typecheck: "pending",
    tests: "pending",
  };

  // Snapshot the working tree BEFORE tests run so we can detect any
  // concurrent mutation (another turn's file_write, a background process,
  // etc.) and refuse to cache a result bound to code that's no longer
  // on disk.
  const preState = computeWorkingTreeState();

  // Typecheck
  try {
    execFileSync("npx", ["tsc", "--noEmit"], {
      cwd: MC_DIR,
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
    });
    results.typecheck = "PASS";
  } catch (err) {
    const msg =
      err instanceof Error
        ? ((err as { stderr?: string }).stderr ?? err.message)
        : String(err);
    results.typecheck = `FAIL: ${msg.slice(0, 500)}`;
  }

  // Tests
  try {
    const output = execFileSync("npx", ["vitest", "run", "--reporter=dot"], {
      cwd: MC_DIR,
      timeout: TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const summaryMatch = output.match(/Tests\s+(\d+)\s+passed/);
    results.tests = summaryMatch ? `PASS (${summaryMatch[1]} tests)` : "PASS";
  } catch (err) {
    // Distinguish timeout (ETIMEDOUT or signal=SIGTERM) from test-failure.
    // A timed-out vitest has partial stdout that can match the "N failed" regex
    // even when the ONLY failure was the kill signal — don't trust that as a
    // real failure count.
    const e = err as {
      code?: string;
      signal?: string;
      stdout?: string;
      message?: string;
    };
    // ETIMEDOUT + SIGTERM = Node's own timeout. SIGKILL = external kill
    // (OOM-killer, resource cap) — also a "killed before finishing" signal,
    // so report it as timeout rather than parsing partial stdout as failures.
    const timedOut =
      e.code === "ETIMEDOUT" ||
      e.signal === "SIGTERM" ||
      e.signal === "SIGKILL";
    if (timedOut) {
      results.tests = `TIMEOUT: vitest exceeded ${TIMEOUT_MS / 1000}s. Re-run locally; if the suite passes in isolation, the gate was killed by load.`;
    } else {
      const msg = e.stdout ?? e.message ?? String(err);
      const summaryMatch = msg.match(
        /Tests\s+(\d+)\s+failed(?:\s+\|\s+(\d+)\s+passed)?/,
      );
      results.tests = summaryMatch
        ? `FAIL: ${summaryMatch[1]} failed, ${summaryMatch[2] ?? "?"} passed`
        : `FAIL: ${msg.slice(0, 500)}`;
    }
  }

  // Re-snapshot AFTER tests ran. If the working tree changed during the
  // suite, `tests: PASS` describes code that is no longer on disk — we
  // must not cache a green result for a state that wasn't actually tested.
  const postState = computeWorkingTreeState();
  const mutatedDuringRun = detectRunMutation(preState, postState);
  if (mutatedDuringRun && results.tests.startsWith("PASS")) {
    results.tests =
      "STALE: working tree changed during test run — tested code differs from current disk state. Re-run action=test.";
  }

  const ready_for_pr =
    !mutatedDuringRun &&
    results.typecheck === "PASS" &&
    results.tests.startsWith("PASS");

  // Cache the result so action=pr can skip re-running the suite if nothing
  // has changed. Both pass and fail are cached; only passing entries are
  // honored by getFreshPassingCache. Key the cache on `preState` — the
  // state the tests actually ran on — so cache lookup at action=pr time
  // matches only if the tree is still what was tested.
  if (preState) {
    writeTestCache({
      branch: preState.branch,
      head_sha: preState.head_sha,
      dirty_hash: preState.dirty_hash,
      tested_at_ms: Date.now(),
      typecheck: results.typecheck,
      tests: results.tests,
      ready_for_pr,
    });
  }

  return JSON.stringify({ branch, ...results, ready_for_pr });
}

function actionPr(title: string, body: string): string {
  const branch = currentBranch();
  if (!JARVIS_BRANCH_RE.test(branch)) {
    return JSON.stringify({
      error: `Not on a jarvis/* branch (current: "${branch}"). Create one first.`,
    });
  }

  // Trust a fresh green action=test cache if branch + HEAD + working tree
  // all match, so action=pr doesn't burn 136s of the caller's budget on a
  // suite that was just run. Cache-miss path runs tests inline as before.
  const cached = getFreshPassingCache(branch);
  const testResult: {
    typecheck: string;
    tests: string;
    ready_for_pr: boolean;
  } = cached
    ? {
        typecheck: cached.typecheck,
        tests: `${cached.tests} (cached ${Math.round((Date.now() - cached.tested_at_ms) / 1000)}s ago)`,
        ready_for_pr: true,
      }
    : JSON.parse(actionTest());
  if (!testResult.ready_for_pr) {
    return JSON.stringify({
      error: "Tests must pass before opening a PR.",
      typecheck: testResult.typecheck,
      tests: testResult.tests,
    });
  }

  // Stage, commit, push — filter sensitive files
  // Sec8 round-1 fix: widened filter covers private-key filenames (id_rsa,
  // id_ed25519), auth dotfiles (.npmrc, .netrc, .gitconfig, .git-credentials,
  // .pgpass), cloud-credential convention files (.aws/credentials is already
  // caught by "credentials"), and PEM/PKCS key extensions.
  const SENSITIVE = [
    ".env",
    "credentials",
    "secret",
    ".key",
    ".pem",
    ".p12",
    ".pfx",
    ".crt",
    "token",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".gitconfig",
    ".git-credentials",
  ];
  try {
    // Get changed files, exclude sensitive ones
    const changed = run(["status", "--porcelain"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter((f) => !SENSITIVE.some((s) => f.toLowerCase().includes(s)));
    if (changed.length === 0) {
      return JSON.stringify({
        error: "Nothing to commit (or only sensitive files changed).",
      });
    }
    run(["add", ...changed]);
    run(["commit", "-m", title]);
  } catch (err) {
    return JSON.stringify({
      error: `Commit failed: ${err instanceof Error ? err.message : err}`,
    });
  }

  try {
    run(["push", "-u", "origin", branch]);
  } catch (err) {
    return JSON.stringify({
      error: `Push failed: ${err instanceof Error ? err.message : err}`,
    });
  }

  // Create PR via gh CLI. Try with --label first; if the label doesn't
  // exist yet, retry without it so a missing repo label never blocks a
  // code-ready PR. (Run `gh label create jarvis-authored` once per repo.)
  const prBody = `${body}\n\n---\n🤖 Jarvis-authored PR\nBranch: \`${branch}\`\nTests: ${testResult.tests}`;
  const baseArgs = [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    prBody,
  ];
  const createPr = (args: string[]): string =>
    execFileSync("gh", args, {
      cwd: MC_DIR,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf-8",
    }).trim();

  let prUrl: string;
  let labelApplied = true;
  try {
    prUrl = createPr([...baseArgs, "--label", "jarvis-authored"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const labelMissing = /not found|could not add label/i.test(msg);
    if (!labelMissing) {
      return JSON.stringify({
        error: `PR creation failed (code is pushed to ${branch}): ${msg}`,
        branch,
        pushed: true,
      });
    }
    try {
      prUrl = createPr(baseArgs);
      labelApplied = false;
    } catch (err2) {
      return JSON.stringify({
        error: `PR creation failed (code is pushed to ${branch}): ${err2 instanceof Error ? err2.message : err2}`,
        branch,
        pushed: true,
      });
    }
  }

  return JSON.stringify({
    success: true,
    pr_url: prUrl,
    branch,
    tests: testResult.tests,
    ...(labelApplied
      ? {}
      : {
          label_warning:
            "jarvis-authored label not found in repo; PR opened without label. Run: gh label create jarvis-authored",
        }),
  });
}

function actionStatus(): string {
  const branch = currentBranch();
  let status = "";
  let diff = "";
  try {
    status = run(["status", "--porcelain"]);
    diff = run(["diff", "--stat"]);
  } catch {
    // ignore
  }

  return JSON.stringify({
    branch,
    is_jarvis_branch: JARVIS_BRANCH_RE.test(branch),
    uncommitted_changes: status.split("\n").filter(Boolean).length,
    diff_summary: diff.slice(0, 500),
    cwd: MC_DIR,
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const jarvisDevTool: Tool = {
  name: "jarvis_dev",
  requiresConfirmation: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_dev",
      description: `Jarvis's self-improvement tool — create branches, run tests, and open PRs on your own codebase (mission-control).

USE WHEN:
- User asks you to fix a bug in your own code ("fix your scope regex", "add a new adapter")
- User asks you to write a new tool or feature for yourself
- Overnight tuning identifies a regression you should fix
- You need to modify your own tool descriptions, scope patterns, or adapters

WORKFLOW:
1. jarvis_dev action="branch" type="feat" slug="oilprice-adapter" → creates jarvis/feat/oilprice-adapter
2. Use file_edit/file_write on /root/claude/mission-control/src/... to make changes
3. jarvis_dev action="test" → runs typecheck + full test suite (~136s)
4. jarvis_dev action="pr" title="feat: add OilPrice adapter" body="..." → commits, pushes, opens PR
5. User reviews and merges the PR

PERFORMANCE TIP:
action="pr" trusts a recent green action="test" result if branch + HEAD + working tree still match (15-min TTL). Run action="test" in its own turn first so action="pr" can skip the suite and fit within the per-query budget.

SAFETY:
- You can ONLY work on jarvis/* branches, NEVER on main
- Tests MUST pass before a PR can be opened
- User must merge the PR — you cannot self-merge
- Only file_edit/file_write/shell_exec work on mission-control while on a jarvis/* branch

AFTER USING: Report the branch name, action taken, and next step.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["branch", "test", "pr", "status"],
            description:
              '"branch" to create a new branch, "test" to run typecheck+tests, "pr" to open a pull request, "status" to check current state',
          },
          type: {
            type: "string",
            enum: ["feat", "fix", "refactor"],
            description:
              'Branch type (required for action="branch"): feat, fix, or refactor',
          },
          slug: {
            type: "string",
            description:
              'Branch slug (required for action="branch"): lowercase-with-hyphens, e.g. "oilprice-adapter"',
          },
          title: {
            type: "string",
            description:
              'PR title (required for action="pr"): e.g. "feat: add OilPrice intel adapter"',
          },
          body: {
            type: "string",
            description:
              'PR body/description (required for action="pr"): what changed and why',
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    switch (action) {
      case "branch":
        return actionBranch(
          (args.type as string) ?? "",
          (args.slug as string) ?? "",
        );
      case "test":
        return actionTest();
      case "pr":
        return actionPr(
          (args.title as string) ?? "Jarvis improvement",
          (args.body as string) ?? "",
        );
      case "status":
        return actionStatus();
      default:
        return JSON.stringify({
          error: `Unknown action "${action}". Use: branch, test, pr, status`,
        });
    }
  },
};
