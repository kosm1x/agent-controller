/**
 * Git/GitHub tools — enables Jarvis to commit, push, and create PRs.
 *
 * All operations run in the project root (/root/claude/cuatro-flor by default).
 * Uses execSync with timeouts. Refuses to stage sensitive files.
 */

import { execFileSync, execSync } from "child_process";
import { resolve } from "path";
import type { Tool } from "../types.js";

// Jarvis's git domain — EurekaMD org projects. NOT mission-control (its own source).
const DEFAULT_CWD = "/root/claude/cuatro-flor";
const GITHUB_ORG = "EurekaMD-net";
const ALLOWED_CWD_PREFIXES = [
  "/root/claude/cuatro-flor/",
  "/root/claude/projects/",
  "/tmp/",
];
const DENIED_CWD = ["/root/claude/mission-control/"];
const SENSITIVE_PATTERNS = [
  ".env",
  "credentials",
  "secret",
  ".key",
  ".pem",
  "token",
];

function resolveWorkDir(cwd?: string): string {
  if (!cwd) return DEFAULT_CWD;
  const resolved = resolve(cwd);
  // Append slash for prefix matching — "cuatro-flor" must match "cuatro-flor/" but not "cuatro-flor-other/"
  const withSlash = resolved.endsWith("/") ? resolved : resolved + "/";
  // Deny list first — mission-control is protected
  for (const deny of DENIED_CWD) {
    if (withSlash.startsWith(deny)) {
      throw new Error(
        `Git operations blocked on ${deny} — Jarvis cannot modify its own source code. Use a project directory.`,
      );
    }
  }
  if (!ALLOWED_CWD_PREFIXES.some((p) => withSlash.startsWith(p))) {
    throw new Error(
      `Working directory must be under an allowed project path. Got: ${resolved}. Allowed: ${ALLOWED_CWD_PREFIXES.join(", ")}`,
    );
  }
  return resolved;
}

/** Safe exec: uses execFileSync with array args to prevent shell injection. */
function runArgs(
  cmd: string,
  args: string[],
  timeout = 30_000,
  cwd?: string,
): string {
  return execFileSync(cmd, args, {
    cwd: resolveWorkDir(cwd),
    encoding: "utf-8" as const,
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Shell exec for simple commands with no user input (safe). */
function run(cmd: string, timeout = 30_000, cwd?: string): string {
  return execSync(cmd, {
    cwd: resolveWorkDir(cwd),
    encoding: "utf-8" as const,
    timeout,
  }).trim();
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
      parameters: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description:
              "Project directory (default: /root/claude/cuatro-flor). Set to the repo you're working on.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const cwd = args.cwd as string | undefined;
      const status = run("git status --short", 30_000, cwd);
      const branch = run("git branch --show-current", 30_000, cwd);
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
          cwd: {
            type: "string",
            description:
              "Project directory (default: /root/claude/cuatro-flor)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const cwd = args.cwd as string | undefined;
      const diffArgs = ["diff"];
      if (args.staged) diffArgs.push("--cached");
      if (args.file) diffArgs.push("--", args.file as string);
      const diff = runArgs("git", diffArgs, 15_000, cwd);
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

Always write a descriptive commit message that explains WHY, not just WHAT.
CRITICAL: cwd MUST be set to the project directory you wrote files to. Do NOT omit it.`,
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
          cwd: {
            type: "string",
            description:
              "Project directory (default: /root/claude/cuatro-flor). MUST match the repo you wrote files to.",
          },
        },
        required: ["files", "message", "cwd"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const files = args.files as string[];
      const message = args.message as string;
      const cwd = args.cwd as string | undefined;

      if (!files?.length) return "Error: files array is required.";
      if (!message) return "Error: commit message is required.";

      // Block sensitive files
      for (const f of files) {
        const lower = f.toLowerCase();
        if (SENSITIVE_PATTERNS.some((p) => lower.includes(p))) {
          return `Error: Refused to stage potentially sensitive file: ${f}`;
        }
      }

      // Stage files (execFileSync — no shell injection from file paths)
      runArgs("git", ["add", ...files], 30_000, cwd);

      // Check there's something to commit
      const staged = run("git diff --cached --stat", 30_000, cwd);
      if (!staged)
        return "Nothing staged to commit. Did you specify the right files?";

      // Commit (execFileSync — message as arg, no shell injection)
      const result = runArgs("git", ["commit", "-m", message], 30_000, cwd);
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
      parameters: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description:
              "Project directory (default: /root/claude/cuatro-flor). MUST match the repo you committed to.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const cwd = args.cwd as string | undefined;

      // Verify auth
      try {
        run("gh auth status 2>&1");
      } catch {
        return "Error: GitHub auth not configured. Run `gh auth login` first.";
      }

      // Verify remote exists
      try {
        const remote = run("git remote get-url origin 2>&1", 30_000, cwd);
        if (remote.includes("github.com")) {
          const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
          if (match) {
            try {
              run(`gh repo view ${match[1]} --json name 2>&1`);
            } catch {
              return `Error: Remote repository ${match[1]} does not exist on GitHub. Create it first with gh_repo_create.`;
            }
          }
        }
      } catch {
        return "Error: No remote 'origin' configured. Use shell_exec to add one.";
      }

      // Ensure branch is named 'main' (git init defaults to 'master')
      let branch = run("git branch --show-current", 30_000, cwd);
      if (!branch) {
        return "Error: detached HEAD state. Checkout a branch before pushing.";
      }
      if (branch === "master") {
        run("git branch -M main", 30_000, cwd);
        branch = "main";
      }

      // Fetch + rebase to avoid push rejection from diverged remote
      try {
        run("git fetch origin 2>&1", 15_000, cwd);
        const remoteBranches = run("git branch -r 2>&1", 30_000, cwd);
        if (remoteBranches.includes(`origin/${branch}`)) {
          run(`git rebase origin/${branch} 2>&1`, 30_000, cwd);
        }
      } catch {
        // First push to empty repo — no remote branch yet, safe to proceed
      }

      // Check for uncommitted changes — warn before the LLM claims success
      const status = run("git status --short", 30_000, cwd);
      const pushResult = run(`git push -u origin ${branch} 2>&1`, 60_000, cwd);

      // "Everything up-to-date" means nothing was pushed — distinguish from actual push
      if (pushResult.includes("Everything up-to-date")) {
        if (status) {
          return `WARNING: Nothing was pushed — there are uncommitted changes in the working directory. You must run git_commit first to stage and commit these changes before they can be pushed.\n\nUncommitted changes:\n${status}`;
        }
        return "Already up-to-date — no new commits to push.";
      }

      return pushResult || `Pushed ${branch} to origin.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const ghRepoCreateTool: Tool = {
  name: "gh_repo_create",
  definition: {
    type: "function",
    function: {
      name: "gh_repo_create",
      description: `Create a new GitHub repository under the EurekaMD-net organization.
MUST be called before git_push if the remote repo doesn't exist yet.

USE WHEN:
- Starting a new project that needs a GitHub repo
- Before first git_push on a new codebase
- User asks to "create a repo" or "push to a new repo"

Creates the repo under EurekaMD-net org by default. Does NOT push code — use git_push after.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Repository name (e.g. 'my-project'). Created under EurekaMD-net org by default.",
          },
          description: {
            type: "string",
            description: "Short repo description (optional).",
          },
          private: {
            type: "boolean",
            description: "Create as private repo (default: false = public).",
          },
        },
        required: ["name"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const rawName = args.name as string;
      if (!rawName) return "Error: name is required.";

      // Default to EurekaMD-net org if no org prefix given
      const name = rawName.includes("/") ? rawName : `${GITHUB_ORG}/${rawName}`;

      const ghArgs = ["repo", "create", name];
      ghArgs.push(args.private ? "--private" : "--public");
      if (args.description)
        ghArgs.push("--description", args.description as string);
      ghArgs.push("--confirm");

      const result = runArgs("gh", ghArgs, 30_000);
      return result || `Created repository ${name}.`;
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

      const result = runArgs(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--base", base],
        60_000,
      );
      return result;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
};
