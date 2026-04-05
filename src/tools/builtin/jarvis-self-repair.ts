/**
 * Jarvis self-repair tools — diagnose errors and run tests.
 *
 * v6.0 S2: Jarvis can identify bugs in his own code and fix them
 * via the jarvis_dev branch+PR workflow.
 */

import { execFileSync } from "child_process";
import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";

const MC_DIR = "/root/claude/mission-control";

// Files Jarvis is allowed to modify (S2 scope limit)
const ALLOWED_PATHS = [
  "src/tools/",
  "src/intel/",
  "src/messaging/scope.ts",
  "src/messaging/prompt-sections.ts",
  "src/messaging/prompt-enhancer.ts",
  "src/video/",
];

function currentBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: MC_DIR,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "HEAD";
  }
}

// ---------------------------------------------------------------------------
// jarvis_diagnose
// ---------------------------------------------------------------------------

export const jarvisDiagnoseTool: Tool = {
  name: "jarvis_diagnose",
  definition: {
    type: "function",
    function: {
      name: "jarvis_diagnose",
      description: `Diagnose recent errors in your own system (mission-control).

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
      const rawLogs = execFileSync(
        "journalctl",
        [
          "-u",
          "mission-control",
          "--since",
          `${hours} hours ago`,
          "--no-pager",
        ],
        { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
      );
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
            `  ${t.created_at} — ${t.title.slice(0, 60)} (${t.agent_type})`,
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
      const rawGuardLogs = execFileSync(
        "journalctl",
        [
          "-u",
          "mission-control",
          "--since",
          `${hours} hours ago`,
          "--no-pager",
        ],
        { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
      );
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
      `**Current branch:** ${currentBranch()}`,
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
  definition: {
    type: "function",
    function: {
      name: "jarvis_test_run",
      description: `Run typecheck and test suite on mission-control. Use BEFORE opening a PR to verify your fix.

USE WHEN:
- After making code changes via file_edit on a jarvis/* branch
- Before calling jarvis_dev action="pr"
- To check if the codebase is currently healthy

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
    const typecheckOnly = (args.typecheck_only as boolean) ?? false;
    const branch = currentBranch();
    const lines: string[] = [`🧪 **Test Run** (branch: ${branch})`];

    // Typecheck
    try {
      execFileSync("npx", ["tsc", "--noEmit"], {
        cwd: MC_DIR,
        timeout: 60_000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      lines.push("✅ Typecheck: PASS");
    } catch (err) {
      const stderr =
        (err as { stderr?: string }).stderr?.slice(0, 500) ?? "unknown error";
      lines.push(`❌ Typecheck: FAIL\n${stderr}`);
      if (typecheckOnly) return lines.join("\n");
    }

    if (typecheckOnly) return lines.join("\n");

    // Test suite
    try {
      const output = execFileSync("npx", ["vitest", "run", "--reporter=dot"], {
        cwd: MC_DIR,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      const summary = output.match(/Tests\s+(\d+)\s+passed/);
      const files = output.match(/Test Files\s+(\d+)\s+passed/);
      lines.push(
        `✅ Tests: ${summary?.[1] ?? "?"} passed (${files?.[1] ?? "?"} files)`,
      );
    } catch (err) {
      const stdout =
        (err as { stdout?: string }).stdout?.slice(-500) ?? "unknown error";
      const failMatch = stdout.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
      if (failMatch) {
        lines.push(`❌ Tests: ${failMatch[1]} failed, ${failMatch[2]} passed`);
      } else {
        lines.push(`❌ Tests: FAIL\n${stdout.slice(0, 300)}`);
      }
    }

    lines.push(
      `\n**Next:** ${branch === "main" ? "Create a jarvis/* branch first with jarvis_dev." : "If tests pass, open a PR with jarvis_dev action=pr."}`,
    );

    return lines.join("\n");
  },
};
