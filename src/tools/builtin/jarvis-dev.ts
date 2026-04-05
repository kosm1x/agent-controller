/**
 * jarvis_dev — Jarvis's self-improvement tool.
 *
 * Enables Jarvis to create branches on his own repo, run tests,
 * and open PRs for human review. NEVER pushes to main.
 */

import { execFileSync } from "child_process";
import type { Tool } from "../types.js";

const MC_DIR = "/root/claude/mission-control";
const JARVIS_BRANCH_RE = /^jarvis\/(feat|fix|refactor)\/.+$/;
const TIMEOUT_MS = 120_000; // 2 min for test suite

function run(args: string[], opts?: { timeout?: number }): string {
  return execFileSync("git", args, {
    cwd: MC_DIR,
    timeout: opts?.timeout ?? 10_000,
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
    run(["pull", "origin", "main"], { timeout: 30_000 });
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
    // Extract summary line
    const summaryMatch = output.match(/Tests\s+(\d+)\s+passed/);
    results.tests = summaryMatch ? `PASS (${summaryMatch[1]} tests)` : "PASS";
  } catch (err) {
    const msg =
      err instanceof Error
        ? ((err as { stdout?: string }).stdout ?? err.message)
        : String(err);
    // Extract failure info
    const failMatch = msg.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
    results.tests = failMatch
      ? `FAIL: ${failMatch[1]} failed, ${failMatch[2]} passed`
      : `FAIL: ${msg.slice(0, 500)}`;
  }

  return JSON.stringify({
    branch,
    ...results,
    ready_for_pr:
      results.typecheck === "PASS" && results.tests.startsWith("PASS"),
  });
}

function actionPr(title: string, body: string): string {
  const branch = currentBranch();
  if (!JARVIS_BRANCH_RE.test(branch)) {
    return JSON.stringify({
      error: `Not on a jarvis/* branch (current: "${branch}"). Create one first.`,
    });
  }

  // Run tests first — gate PR on green
  const testResult = JSON.parse(actionTest());
  if (!testResult.ready_for_pr) {
    return JSON.stringify({
      error: "Tests must pass before opening a PR.",
      typecheck: testResult.typecheck,
      tests: testResult.tests,
    });
  }

  // Stage, commit, push — filter sensitive files
  const SENSITIVE = [".env", "credentials", "secret", ".key", ".pem", "token"];
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
    run(["push", "-u", "origin", branch], { timeout: 30_000 });
  } catch (err) {
    return JSON.stringify({
      error: `Push failed: ${err instanceof Error ? err.message : err}`,
    });
  }

  // Create PR via gh CLI
  try {
    const prBody = `${body}\n\n---\n🤖 Jarvis-authored PR\nBranch: \`${branch}\`\nTests: ${testResult.tests}`;
    const prUrl = execFileSync(
      "gh",
      [
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
        "--label",
        "jarvis-authored",
      ],
      {
        cwd: MC_DIR,
        timeout: 30_000,
        encoding: "utf-8",
      },
    ).trim();

    return JSON.stringify({
      success: true,
      pr_url: prUrl,
      branch,
      tests: testResult.tests,
    });
  } catch (err) {
    // PR creation failed but code is pushed — report the branch
    return JSON.stringify({
      error: `PR creation failed (code is pushed to ${branch}): ${err instanceof Error ? err.message : err}`,
      branch,
      pushed: true,
    });
  }
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
3. jarvis_dev action="test" → runs typecheck + full test suite
4. jarvis_dev action="pr" title="feat: add OilPrice adapter" body="..." → commits, pushes, opens PR
5. User reviews and merges the PR

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
