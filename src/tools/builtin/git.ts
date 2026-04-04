/**
 * Git/GitHub tools — enables Jarvis to commit, push, and create PRs.
 *
 * All operations run in the project root (/root/claude/mission-control).
 * Uses execSync with timeouts. Refuses to stage sensitive files.
 */

import { execSync } from "child_process";
import type { Tool } from "../types.js";

const PROJECT_ROOT = "/root/claude/mission-control";
const EXEC_OPTS = {
  cwd: PROJECT_ROOT,
  encoding: "utf-8" as const,
  timeout: 30_000,
};
const SENSITIVE_PATTERNS = [
  ".env",
  "credentials",
  "secret",
  ".key",
  ".pem",
  "token",
];

function run(cmd: string, timeout = 30_000): string {
  return execSync(cmd, { ...EXEC_OPTS, timeout }).trim();
}

export const gitStatusTool: Tool = {
  name: "git_status",
  definition: {
    type: "function",
    function: {
      name: "git_status",
      description: `Show git working tree status (modified, staged, untracked files).

USE WHEN:
- Before committing, to see what changed
- To check if there are uncommitted changes
- After making code changes, to verify what was modified

Returns short-format status (M=modified, A=added, D=deleted, ??=untracked).`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    try {
      const status = run("git status --short");
      const branch = run("git branch --show-current");
      if (!status) return `On branch ${branch}. Working tree clean.`;
      return `Branch: ${branch}\n\n${status}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  definition: {
    type: "function",
    function: {
      name: "git_diff",
      description: `Show git diff of current changes.

USE WHEN:
- To review what changed before committing
- To understand the scope of modifications

Returns unified diff. Use staged=true to see staged changes.`,
      parameters: {
        type: "object",
        properties: {
          staged: {
            type: "boolean",
            description:
              "Show staged changes only (default: false, shows unstaged)",
          },
          file: {
            type: "string",
            description: "Limit diff to a specific file path (optional)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const staged = args.staged ? "--cached" : "";
      const file = args.file ? `-- ${args.file}` : "";
      const diff = run(`git diff ${staged} ${file}`.trim(), 15_000);
      if (!diff) return "No changes.";
      return diff.length > 5000
        ? diff.slice(0, 5000) + "\n... (truncated)"
        : diff;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const gitCommitTool: Tool = {
  name: "git_commit",
  definition: {
    type: "function",
    function: {
      name: "git_commit",
      description: `Stage files and create a git commit.

USE WHEN:
- After making and verifying code changes (typecheck + tests pass)
- To save work before moving to the next task

DO NOT USE WHEN:
- Tests are failing (fix first, then commit)
- Changes include .env or credential files (will be blocked)

Always write a descriptive commit message that explains WHY, not just WHAT.`,
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description:
              'File paths to stage (relative to project root). Use ["."] to stage all.',
          },
          message: {
            type: "string",
            description:
              "Commit message. Be descriptive — explain the purpose of the change.",
          },
        },
        required: ["files", "message"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const files = args.files as string[];
      const message = args.message as string;

      if (!files?.length) return "Error: files array is required.";
      if (!message) return "Error: commit message is required.";

      // Block sensitive files
      for (const f of files) {
        const lower = f.toLowerCase();
        if (SENSITIVE_PATTERNS.some((p) => lower.includes(p))) {
          return `Error: Refused to stage potentially sensitive file: ${f}`;
        }
      }

      // Stage files
      const fileList = files.join(" ");
      run(`git add ${fileList}`);

      // Check there's something to commit
      const staged = run("git diff --cached --stat");
      if (!staged)
        return "Nothing staged to commit. Did you specify the right files?";

      // Commit
      const result = run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
      return result;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const gitPushTool: Tool = {
  name: "git_push",
  definition: {
    type: "function",
    function: {
      name: "git_push",
      description: `Push commits to GitHub remote.

USE WHEN:
- After committing changes that should be shared
- After creating a PR branch

Verifies GitHub auth before pushing. Pushes current branch to origin.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    try {
      // Verify auth
      try {
        run("gh auth status 2>&1");
      } catch {
        return "Error: GitHub auth not configured. Run `gh auth login` first.";
      }

      const branch = run("git branch --show-current");
      const result = run(`git push origin ${branch} 2>&1`, 60_000);
      return result || `Pushed ${branch} to origin.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const ghCreatePrTool: Tool = {
  name: "gh_create_pr",
  definition: {
    type: "function",
    function: {
      name: "gh_create_pr",
      description: `Create a GitHub pull request from the current branch.

USE WHEN:
- After pushing a feature branch
- To request review of changes before merging to main

Returns the PR URL on success.`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "PR title (short, under 72 chars)",
          },
          body: {
            type: "string",
            description:
              "PR description (markdown). Include summary + test plan.",
          },
          base: {
            type: "string",
            description: "Base branch to merge into (default: main)",
          },
        },
        required: ["title", "body"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const title = args.title as string;
      const body = args.body as string;
      const base = (args.base as string) || "main";

      if (!title) return "Error: title is required.";
      if (!body) return "Error: body is required.";

      const result = run(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${base} 2>&1`,
        60_000,
      );
      return result;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};
