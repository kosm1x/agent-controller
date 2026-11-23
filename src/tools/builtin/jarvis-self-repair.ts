/**
 * Jarvis self-repair tools — diagnose errors and run tests.
 *
 * v6.0 S2: Jarvis can identify bugs in his own code and fix them
 * via the jarvis_dev branch+PR workflow.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { toMexTime } from "../../lib/timezone.js";
import { execGroupKill } from "./shell.js";
import { buildChildEnv } from "../../mcp/env-deny.js";
import { SELF_IMPROVEMENT_ALLOWED } from "./write-boundary.js";
import { MC_CONTAINER_ROOT, MC_WORKTREE_ROOT } from "./immutable-core.js";
import {
  relatedScopeSummary,
  relatedTestCommand,
  resolveTestScope,
} from "./changed-tests.js";

const MC_DIR = "/root/claude/mission-control";
// The agent's edits live only in its worktree (writes to the primary checkout
// are refused), so the self-test runs there and nowhere else.
const WORKTREE_DIR = MC_WORKTREE_ROOT.replace(/\/$/, "");

// Async on purpose (2026-10-26): execFileSync blocked the event loop for the
// child's whole run — a slow journalctl read over 24 h of logs crosses the 5 s
// MCEventLoopBlock alert and freezes every other task. Promisified children
// keep stdin open; it is closed right after spawn so a child that waits on
// input fails fast instead of hanging to the timeout.
const execFileAsync = promisify(execFile);

/**
 * One full-suite run at a time. These tools ran the suite with execFileSync,
 * which blocked the event loop and so could never overlap; now that they are
 * async, two concurrent tasks could each start the full suite, which OOMs
 * this box. Returns null (fn not run) when a run is already in flight.
 * Shared by jarvis_test_run and jarvis_dev's test gate (ruling 4:
 * related tests only now, but still one run at a time).
 */
let suiteRunInFlight = false;
export const SUITE_RUN_BUSY =
  "a test run is already in progress — retry when it finishes";
export async function withSuiteRunLock<T>(
  fn: () => Promise<T>,
): Promise<T | null> {
  if (suiteRunInFlight) return null;
  suiteRunInFlight = true;
  try {
    return await fn();
  } finally {
    suiteRunInFlight = false;
  }
}

// The path list quoted in the repair instructions (defined in write-boundary.ts).
const ALLOWED_PATHS = SELF_IMPROVEMENT_ALLOWED;

/** The branch checked out in `cwd`: "" when detached, null when git fails. */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const p = execFileAsync("git", ["branch", "--show-current"], {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
    });
    p.child.stdin?.end();
    return (await p).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Why the worktree cannot be tested, checked in this order: the folder, its
 * `.git` (a linked worktree has a `.git` file), its node_modules link (without
 * it npx finds no local tsc/vitest). Null when all three are present.
 */
function worktreeRefusal(): string | null {
  if (!existsSync(WORKTREE_DIR)) {
    return `jarvis_test_run did not run: there is no mission-control worktree at ${WORKTREE_DIR}, and this tool tests only that worktree. jarvis_dev tries to create the worktree whenever one of its actions runs (action="branch" is the one that also creates a jarvis/* branch). If jarvis_dev answers with a worktree bootstrap error, do not retry: report that error.`;
  }
  if (!existsSync(join(WORKTREE_DIR, ".git"))) {
    return `jarvis_test_run did not run: ${WORKTREE_DIR} exists but is not a git checkout (no .git). jarvis_dev does not repair this: it creates the worktree only when the folder is absent. Try jarvis_test_run once more; if the answer is the same, report it.`;
  }
  if (!existsSync(join(WORKTREE_DIR, "node_modules"))) {
    return `jarvis_test_run did not run: the worktree at ${WORKTREE_DIR} has no usable node_modules link, so the typecheck and the tests cannot start. jarvis_dev recreates a missing link whenever one of its actions runs; then run jarvis_test_run again. If jarvis_dev answers with a worktree bootstrap error, do not retry: report that error.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// jarvis_diagnose
// ---------------------------------------------------------------------------

export const jarvisDiagnoseTool: Tool = {
  name: "jarvis_diagnose",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_diagnose",
      description: `Diagnose recent errors in your own system (mission-control).

DO NOT USE WHEN:
- The failing service is NOT mission-control (agentic-crm, caddy, stalwart) → use vps_logs; supabase is a Docker stack → shell_exec with docker logs <container>.
- You already know the cause and need to ship a fix → use jarvis_dev.

USE WHEN:
- User reports a bug in your behavior
- Overnight tuning detects a regression
- You need to understand what's failing before creating a fix branch

Returns: recent error logs + failed task summary + suggested files to investigate.

WORKFLOW:
1. jarvis_diagnose → understand the problem
2. code_search → find the relevant code
3. jarvis_dev action="branch" type="fix" → create fix branch
4. file_edit → make the fix
5. jarvis_test_run → verify the fix
6. jarvis_dev action="pr" → open pull request

SCOPE LIMIT: You can only modify files in: ${ALLOWED_PATHS.join(", ")}.
Core infrastructure (adapter.ts, runners/, db/) stays human-only.`,
      parameters: {
        type: "object",
        properties: {
          hours: {
            type: "number",
            description:
              "How many hours back to look for errors (default: 1, max: 24)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawHours = Number(args.hours) || 1;
    const hours = Math.min(Math.max(rawHours, 1), 24);
    const lines: string[] = [`🔍 **Diagnosis** (last ${hours}h)`];

    // 1. Recent error logs from journalctl
    try {
      const p = execFileAsync(
        "journalctl",
        [
          "-u",
          "mission-control",
          "--since",
          `${hours} hours ago`,
          "--no-pager",
        ],
        // execFile always pipes stdin/stdout/stderr (no `stdio` option),
        // so journalctl stderr is captured as before, never echoed.
        { encoding: "utf-8", timeout: 10_000 },
      );
      p.child.stdin?.end();
      const { stdout: rawLogs } = await p;
      const errorRe = /error|FAIL|halluc|BLOCKED/i;
      const logs = rawLogs
        .split("\n")
        .filter((l) => errorRe.test(l))
        .slice(-20)
        .join("\n")
        .trim();

      if (logs) {
        lines.push("\n**Error logs:**");
        for (const log of logs.split("\n").slice(0, 10)) {
          // Extract just the message part after timestamp
          const msg = log
            .replace(/^.*mission-control\[\d+\]:\s*/, "")
            .slice(0, 150);
          lines.push(`  ${msg}`);
        }
      } else {
        lines.push("\n**Error logs:** None found");
      }
    } catch {
      lines.push("\n**Error logs:** Could not read journalctl");
    }

    // 2. Recent failed tasks
    try {
      const db = getDatabase();
      const failed = db
        .prepare(
          `SELECT task_id, title, error, agent_type, created_at
           FROM tasks
           WHERE status = 'failed'
             AND created_at > datetime('now', ? || ' hours')
           ORDER BY created_at DESC LIMIT 5`,
        )
        .all(`-${hours}`) as Array<{
        task_id: string;
        title: string;
        error: string | null;
        agent_type: string;
        created_at: string;
      }>;

      if (failed.length > 0) {
        lines.push(`\n**Failed tasks (${failed.length}):**`);
        for (const t of failed) {
          lines.push(
            `  ${toMexTime(t.created_at)} — ${t.title.slice(0, 60)} (${t.agent_type})`,
          );
          if (t.error) lines.push(`    Error: ${t.error.slice(0, 100)}`);
        }
      } else {
        lines.push("\n**Failed tasks:** None");
      }
    } catch {
      lines.push("\n**Failed tasks:** Could not query DB");
    }

    // 3. Recent hallucination guard triggers
    try {
      const p = execFileAsync(
        "journalctl",
        [
          "-u",
          "mission-control",
          "--since",
          `${hours} hours ago`,
          "--no-pager",
        ],
        // execFile always pipes stdin/stdout/stderr (no `stdio` option),
        // so journalctl stderr is captured as before, never echoed.
        { encoding: "utf-8", timeout: 10_000 },
      );
      p.child.stdin?.end();
      const { stdout: rawGuardLogs } = await p;
      const guardRe = /hallucin|Guard input|Failed tool/i;
      const logs = rawGuardLogs
        .split("\n")
        .filter((l) => guardRe.test(l))
        .slice(-5)
        .join("\n")
        .trim();

      if (logs) {
        lines.push("\n**Guard triggers:**");
        for (const log of logs.split("\n")) {
          const msg = log
            .replace(/^.*mission-control\[\d+\]:\s*/, "")
            .slice(0, 150);
          lines.push(`  ${msg}`);
        }
      }
    } catch {
      // non-fatal
    }

    // 4. Scope limit reminder
    lines.push(
      `\n**Modifiable files:** ${ALLOWED_PATHS.join(", ")}`,
      `**Current branch:** ${(await currentBranch(MC_DIR)) ?? "HEAD"}`,
      `**Next step:** Use code_search to find the relevant code, then jarvis_dev to create a fix branch.`,
    );

    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// jarvis_test_run
// ---------------------------------------------------------------------------

export const jarvisTestRunTool: Tool = {
  name: "jarvis_test_run",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_test_run",
      description: `Run typecheck and the tests related to your changed files (not the full suite) in your mission-control worktree (${WORKTREE_DIR}), where jarvis_dev action="branch" puts your jarvis/* branch. Use BEFORE opening a PR to verify your fix.

DO NOT USE WHEN:
- The code under test is another repo → run its own test command via shell_exec.
- You only want to know whether the service is healthy → use jarvis_diagnose.
- There is no worktree at that path (none created yet, or your edits are in ${MC_CONTAINER_ROOT.replace(/\/$/, "")} inside a sandbox container) → this tool refuses; it tests only that worktree.

USE WHEN:
- After making code changes via file_edit in your worktree on a jarvis/* branch
- Before calling jarvis_dev action="pr"

Returns: typecheck result + test count + any failures.

IMPORTANT: jarvis_dev action="pr" already gates on tests. This tool is for checking BEFORE you're ready to PR — to iterate on your fix.`,
      parameters: {
        type: "object",
        properties: {
          typecheck_only: {
            type: "boolean",
            description:
              "If true, only run typecheck (faster). Default: false (runs both).",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    // Checked before the lock: a refusal starts nothing and holds nothing.
    const refusal = worktreeRefusal();
    if (refusal) return JSON.stringify({ error: refusal });
    const run = await withSuiteRunLock(async () => {
      const typecheckOnly = (args.typecheck_only as boolean) ?? false;
      const branch = await currentBranch(WORKTREE_DIR);
      const shown =
        branch === null
          ? "unknown (git failed)"
          : branch === ""
            ? "detached (no branch)"
            : branch;
      const lines: string[] = [`🧪 **Test Run** (branch: ${shown})`];

      // Typecheck
      try {
        // Group-kill on timeout, off the event loop (orphaned-worker incident).
        await execGroupKill("npx tsc --noEmit", {
          cwd: WORKTREE_DIR,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          env: buildChildEnv(),
        });
        lines.push("✅ Typecheck: PASS");
      } catch (err) {
        const stderr =
          (err as { stderr?: string }).stderr?.slice(0, 500) ?? "unknown error";
        lines.push(`❌ Typecheck: FAIL\n${stderr}`);
        if (typecheckOnly) return lines.join("\n");
      }

      if (typecheckOnly) return lines.join("\n");

      // Tests related to the changed files only (operator ruling 4).
      const scope = await resolveTestScope(WORKTREE_DIR);
      if (scope.kind === "skip") {
        lines.push(`⏭️ tests: skipped (${scope.reason})`);
      } else if (scope.kind === "error") {
        lines.push(`❌ Tests: NOT RUN — ${scope.reason}`);
      } else {
        try {
          const { stdout: output } = await execGroupKill(
            relatedTestCommand(scope.files),
            {
              cwd: WORKTREE_DIR,
              timeout: 120_000,
              maxBuffer: 1024 * 1024,
              env: buildChildEnv(),
            },
          );
          const summary = output.match(/Tests\s+(\d+)\s+passed/);
          const files = output.match(/Test Files\s+(\d+)\s+passed/);
          lines.push(
            `✅ Tests: ${summary?.[1] ?? "?"} passed (${files?.[1] ?? "?"} files)`,
            `Scope: ${relatedScopeSummary(scope, output)}`,
          );
        } catch (err) {
          const full = (err as { stdout?: string }).stdout;
          const stdout = full?.slice(-500) ?? "unknown error";
          const failMatch = stdout.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
          if (failMatch) {
            lines.push(
              `❌ Tests: ${failMatch[1]} failed, ${failMatch[2]} passed`,
            );
          } else {
            lines.push(`❌ Tests: FAIL\n${stdout.slice(0, 300)}`);
          }
          lines.push(`Scope: ${relatedScopeSummary(scope, full)}`);
        }
      }

      lines.push(
        `\n**Next:** once typecheck and tests pass on a branch made by jarvis_dev action="branch", open the PR with jarvis_dev action="pr". If the branch shown above is not one of those, create one first with jarvis_dev action="branch" (it refuses while the worktree holds uncommitted edits).`,
      );

      return lines.join("\n");
    });
    return run ?? JSON.stringify({ error: `Tests: ${SUITE_RUN_BUSY}` });
  },
};
