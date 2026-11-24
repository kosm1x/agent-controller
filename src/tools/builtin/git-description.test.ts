import { describe, it, expect, vi, beforeEach } from "vitest";

// This file only reads the tools' strings and calls no handler, no execute and
// no guard function. For the whole file every function export of "fs",
// "node:fs", "fs/promises", "node:fs/promises", "child_process" and
// "node:child_process" is replaced by a stub that throws; other exports stay
// real, "default" points to the stub object, and the "promises" property of
// both fs specifiers points to the stubbed promises module. The global fetch is
// a stub that throws, set before the imports and again before each test.
// Packages loaded from node_modules without transformation keep the real
// built-in modules.
const stubbed = vi.hoisted(() => (label: string, real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`${label} ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs/promises", async (importOriginal) =>
  stubbed("fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  stubbed("node:fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs", async (importOriginal) => {
  const out = stubbed("fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("fs/promises");
  return out;
});
vi.mock("node:fs", async (importOriginal) => {
  const out = stubbed("node:fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("node:fs/promises");
  return out;
});
vi.mock("child_process", async (importOriginal) =>
  stubbed("child_process", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
  stubbed("node:child_process", await importOriginal<Record<string, unknown>>()),
);
const fetchStub = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("fetch is a stub in this file");
  }),
);
vi.hoisted(() => vi.stubGlobal("fetch", fetchStub));
beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
});

import * as fs from "fs";
import * as nodeFs from "node:fs";
import * as fsPromises from "fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import {
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPushTool,
  ghRepoCreateTool,
  ghCreatePrTool,
} from "./git.js";

const GIT_STATUS = `Show git working tree status (modified, staged, untracked files).

USE WHEN:
- Before committing, to see what changed
- To check if there are uncommitted changes
- After making code changes, to verify what was modified

DO NOT USE WHEN:
- You want the changed lines themselves: this tool shows the branch and which files changed, not their lines — use git_diff when it is among your tools (it leaves out untracked files).
- You want the commit history, or whether the branch is behind its remote: this tool runs no log and no fetch.
- The folder is outside /root/claude/ and /tmp/, or is the primary mission-control checkout: this tool refuses it; in the agent's own mission-control worktree it runs only on a jarvis/feat/..., jarvis/fix/... or jarvis/refactor/... branch.

Returns short-format status (M=modified, A=added, D=deleted, ??=untracked).`;

const GIT_DIFF = `Show git diff of current changes.

USE WHEN:
- To review what changed before committing
- To understand the scope of modifications

DO NOT USE WHEN:
- You want to compare two commits or branches: this tool takes no commit or branch; it compares the working tree with the index, or with staged=true the index with the last commit.
- You want files that were never added: an untracked file does not appear in this diff.
- You want a large change in one piece: the output stops at 5000 characters — pass file to see one path at a time.

Returns unified diff. Use staged=true to see staged changes.`;

const GIT_PUSH = `Push commits to GitHub remote.

USE WHEN:
- After committing changes that should be shared
- After creating a PR branch

Verifies GitHub auth before pushing. Pushes current branch to origin.
If the repo has NO \`origin\` yet: for a NEW project run gh_repo_create with \`cwd\` first
(it creates the GitHub repo AND wires origin); for a repo that already exists on GitHub
pass \`remote\`.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- Your changes are not committed yet: this tool does not commit them and pushes only commits — use git_commit first.
- You want another branch, another remote or a forced push: this tool pushes the checked-out branch to origin, without force; it renames a local master branch to main and may first rebase onto origin's copy of the branch.
- The branch is main of mission-control, or a mission-control branch changes protected files: where the guard recognises the repository, this tool refuses and pushes nothing.
- You want a pull request: this tool opens none — use gh_create_pr.

AFTER PUSH: Report the branch name and the tool's result.`;

const GH_REPO_CREATE = `Create a new GitHub repository, by default under the agent's own GitHub account.
MUST be called before git_push if the remote repo doesn't exist yet.

USE WHEN:
- Starting a new project that needs a GitHub repo
- Before first git_push on a new codebase
- User asks to "create a repo" or "push to a new repo"

ALWAYS pass \`cwd\` (the local project directory, after git init): the tool then
creates the repo AND configures it as remote \`origin\` there.
Without \`cwd\` only the GitHub repo is created and the local repo has no
remote — wire it afterwards with git_push(remote=<url>).
A bare name creates the repo under the agent's own GitHub account; owner/name creates it under that owner only if the agent's account has access there. Does NOT push code — use git_push after.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- The repository already exists on GitHub: this tool only creates new repositories — to link a local repo that has no origin to it, use git_push with remote set to that repository's GitHub HTTPS URL.
- cwd names a local repo that already has an origin: this tool refuses it and creates nothing.
- The repository must stay private: this tool creates a public repository unless private is true.`;

const GH_CREATE_PR = `Create a GitHub pull request from the branch checked out in \`cwd\`.

USE WHEN:
- After pushing a feature branch (git_push)
- To request review of changes before merging to main

ALWAYS pass \`cwd\` — the repo (or worktree) where you committed. Without it
the tool uses a fixed default directory, which may be another repo. The head branch is read from \`cwd\` automatically.

DO NOT USE WHEN:
- The branch is not on GitHub yet: this tool pushes nothing — push it first; use git_push when it is among your tools.
- You want to merge, update, list or comment on a pull request: this tool only opens a new one.
- The checked-out branch is the base branch: this tool refuses and opens nothing.

Returns the PR URL on success.`;

describe("git tools — description text", () => {
  it("every function export of the six module specifiers is a mock, and fetch is the stub (checked without calling one)", () => {
    expect(fs.promises).toBe(fsPromises);
    expect(nodeFs.promises).toBe(nodeFsPromises);
    const mods: Record<string, object> = {
      fs,
      "node:fs": nodeFs,
      "fs/promises": fsPromises,
      "node:fs/promises": nodeFsPromises,
      "fs.promises": fs.promises,
      "node:fs.promises": nodeFs.promises,
      child_process: childProcess,
      "node:child_process": nodeChildProcess,
    };
    for (const [label, mod] of Object.entries(mods)) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length, label).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), `${label} ${name}`).toBe(true);
    }
    expect(globalThis.fetch).toBe(fetchStub);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
  });

  it("git_status — the whole description", () => {
    expect(gitStatusTool.definition.function.description).toBe(GIT_STATUS);
  });

  it("git_diff — the whole description", () => {
    expect(gitDiffTool.definition.function.description).toBe(GIT_DIFF);
  });

  it("git_push — the whole description", () => {
    expect(gitPushTool.definition.function.description).toBe(GIT_PUSH);
  });

  it("gh_repo_create — the whole description", () => {
    expect(ghRepoCreateTool.definition.function.description).toBe(GH_REPO_CREATE);
  });

  it("gh_create_pr — the whole description", () => {
    expect(ghCreatePrTool.definition.function.description).toBe(GH_CREATE_PR);
  });

  it("git_status — the cwd parameter text", () => {
    const props = (gitStatusTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }).properties;
    expect(props.cwd.description).toBe(
      "Project directory (default: the agent's default project folder). Set to the repo you're working on.",
    );
  });

  it("git_diff — the cwd parameter text", () => {
    const props = (gitDiffTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }).properties;
    expect(props.cwd.description).toBe(
      "Project directory (default: the agent's default project folder)",
    );
  });

  it("git_push — the cwd parameter text", () => {
    const props = (gitPushTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }).properties;
    expect(props.cwd.description).toBe(
      "Project directory (default: the agent's default project folder). MUST match the repo you committed to.",
    );
  });

  it("git_commit — the cwd parameter text", () => {
    const props = (gitCommitTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }).properties;
    expect(props.cwd.description).toBe(
      "Project directory (default: the agent's default project folder). MUST match the repo you wrote files to.",
    );
  });

  it("gh_repo_create — the name parameter text", () => {
    const props = (ghRepoCreateTool.definition.function.parameters as {
      properties: Record<string, { description: string }>;
    }).properties;
    expect(props.name.description).toBe(
      "Repository name (e.g. 'my-project'), created under the agent's own GitHub account. 'owner/name' creates it under that owner only if the agent's account has access there.",
    );
  });
});
