/**
 * The protected-file check at the push and pull-request doors, against REAL
 * throwaway git repositories under the OS temp dir. `upstream` plays the
 * GitHub remote (a local path, so no network and no push is ever needed): its
 * `main` is the default branch, and `work` is a clone with a feature branch.
 * The protected-path matcher is the real IMMUTABLE_FILES / IMMUTABLE_PREFIXES
 * list, so the fixture uses real protected names (src/index.ts, .github/…).
 * The check only uses an origin that names this project's GitHub repository;
 * `idOf` is the test seam that lets the local `upstream` path stand for it.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";

// Pass-through around the check's own async git children: each child's
// argv and options are recorded, then the real execFile runs it.
const childCalls = vi.hoisted(() => [] as Array<{ args: string[]; opts: { env?: Record<string, string> } }>);
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  const { promisify } = await import("util");
  const real = actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>;
  const wrapped = Object.assign((...a: unknown[]) => (actual.execFile as (...x: unknown[]) => unknown)(...a), {
    [promisify.custom]: (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      childCalls.push({ args, opts });
      return real[promisify.custom]!(cmd, args, opts);
    },
  });
  return { ...actual, execFile: wrapped };
});
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MC_GITHUB_SLUG } from "./immutable-core.js";
import { AGENT_CREDENTIAL_HELPER_KEY } from "../../lib/github-authority.js";
import {
  branchProtectedPathsRefusal,
  githubSlugOf,
  isMcCheckoutPath,
  isProjectRepository,
  mcProtectedPathsRefusal,
} from "./protected-push.js";

let root: string;
let upstream: string;
let work: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

const put = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};
const commitAll = (cwd: string, msg: string) => {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", msg]);
};

beforeEach(() => {
  // The check's fetch runs under the agent's own GitHub account.
  vi.stubEnv("JARVIS_GH_TOKEN", "synthetic-token");
  root = mkdtempSync(join(tmpdir(), "protected-push-"));
  upstream = join(root, "upstream");
  work = join(root, "work");
  mkdirSync(upstream);
  git(upstream, ["init", "-q", "-b", "main"]);
  put(upstream, "src/index.ts", "entry\n");
  put(upstream, ".github/workflows/ci.yml", "ci\n");
  put(upstream, "docs/a.md", "doc a\n");
  put(upstream, "lib/b.ts", "b\n");
  commitAll(upstream, "base");
  git(root, ["clone", "-q", upstream, work]);
  git(work, ["checkout", "-q", "-b", "jarvis/feat/x"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** The local upstream stands for the project's GitHub repository; every other URL is read as git expands it. */
const idOf = (url: string): string | null =>
  url === upstream ? MC_GITHUB_SLUG : githubSlugOf(url);
const check = () => branchProtectedPathsRefusal(work, undefined, idOf);

describe("branchProtectedPathsRefusal — what the branch itself changes, compared with its merge base on origin/main", () => {
  it("refuses a branch that modifies a protected file, naming it", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    const refusal = await check();
    expect(refusal).toContain("src/index.ts");
    expect(refusal).toContain("operator session");
  });

  it("refuses a branch that adds a file under a protected prefix", async () => {
    put(work, ".github/workflows/new.yml", "new\n");
    commitAll(work, "add workflow");
    expect(await check()).toContain(".github/workflows/new.yml");
  });

  it("refuses a branch that deletes a protected file", async () => {
    git(work, ["rm", "-q", "src/index.ts"]);
    git(work, ["commit", "-q", "-m", "delete entry"]);
    expect(await check()).toContain("src/index.ts");
  });

  it("refuses a branch that renames a protected file away (the old name counts)", async () => {
    git(work, ["mv", "src/index.ts", "src/entry.ts"]);
    git(work, ["commit", "-q", "-m", "rename entry"]);
    const refusal = await check();
    expect(refusal).toContain("src/index.ts");
    expect(refusal).not.toContain("src/entry.ts");
  });

  it("refuses a branch that renames an ordinary file onto a protected name (the new name counts)", async () => {
    mkdirSync(join(work, "src/rituals"));
    git(work, ["mv", "docs/a.md", "src/rituals/scheduler.ts"]);
    git(work, ["commit", "-q", "-m", "rename onto protected"]);
    expect(await check()).toContain("src/rituals/scheduler.ts");
  });

  it("allows a branch that touches only ordinary files", async () => {
    put(work, "docs/a.md", "doc a, edited\n");
    put(work, "lib/c.ts", "c\n");
    commitAll(work, "docs + lib");
    expect(await check()).toBeNull();
  });

  it("allows a branch with zero commits ahead of origin/main", async () => {
    expect(await check()).toBeNull();
  });

  it("allows a branch whose protected file changed only on main after the branch was cut", async () => {
    put(work, "docs/a.md", "branch work\n");
    commitAll(work, "branch work");
    put(upstream, "src/index.ts", "operator change on main\n");
    commitAll(upstream, "operator edit");
    expect(await check()).toBeNull();
  });

  it("allows a branch that changed a protected file and reverted it later (the net diff is what merges)", async () => {
    put(work, "src/index.ts", "temporary\n");
    commitAll(work, "temporary edit");
    put(work, "src/index.ts", "entry\n");
    commitAll(work, "revert edit");
    expect(await check()).toBeNull();
  });

  it("does not count uncommitted changes: only the commits on the branch are pushed", async () => {
    put(work, "src/index.ts", "uncommitted\n");
    expect(await check()).toBeNull();
  });

  it("compares with origin/main as the remote has it, not a local ref moved onto the branch", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    git(work, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(await check()).toContain("src/index.ts");
  });

  it("reads the real commits, not replacement objects", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    git(work, ["replace", "HEAD", "origin/main"]);
    expect(await check()).toContain("src/index.ts");
  });

  it("reads paths from the repository root when run in a subdirectory with diff.relative configured", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    git(work, ["config", "diff.relative", "true"]);
    expect(
      await branchProtectedPathsRefusal(join(work, "docs"), undefined, idOf),
    ).toContain("src/index.ts");
  });

  it("lists at most 20 protected paths and counts the rest", async () => {
    for (let i = 0; i < 25; i++) put(work, `.github/f${String(i).padStart(2, "0")}.yml`, "x\n");
    commitAll(work, "many");
    const refusal = (await check())!;
    expect(refusal).toContain(".github/f19.yml");
    expect(refusal).not.toContain(".github/f20.yml");
    expect(refusal).toContain("5 more");
  });
});

describe("branchProtectedPathsRefusal — fails closed when the comparison cannot be computed", () => {
  it("refuses when there is no origin to compare with", async () => {
    git(work, ["remote", "remove", "origin"]);
    const refusal = await check();
    expect(refusal).toContain("could not run");
  });

  it("refuses when origin has no main branch", async () => {
    git(upstream, ["branch", "-q", "-m", "main", "trunk"]);
    expect(await check()).toContain("could not run");
  });

  it("refuses on a detached HEAD", async () => {
    git(work, ["checkout", "-q", "--detach"]);
    expect(await check()).toContain("could not run");
  });

  it("refuses a branch with no common ancestor with origin/main", async () => {
    git(work, ["checkout", "-q", "--orphan", "jarvis/feat/orphan"]);
    commitAll(work, "unrelated root");
    expect(await check()).toContain("could not run");
  });

  // The fetch talks to GitHub under the agent's own account; nothing falls
  // back to a login stored on the host, so without the agent's token the
  // check cannot run and nothing is sent.
  it("the fetch child runs under the agent's account: its token, git's helpers reset then the github.com helper, and the check's own settings", async () => {
    childCalls.length = 0;
    await check();
    const fetch = childCalls.find((c) => c.args.includes("fetch"));
    expect(fetch).toBeDefined();
    const env = fetch!.opts.env!;
    expect(env.GH_TOKEN).toBe("synthetic-token");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe(AGENT_CREDENTIAL_HELPER_KEY);
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(env.GIT_GRAFT_FILE).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("refuses when the agent's GitHub token is not configured (the fetch runs under the agent's account only)", async () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    const refusal = await check();
    expect(refusal).toContain("could not run");
    expect(refusal).toContain("fetching origin failed");
  });
});

describe("branchProtectedPathsRefusal — pull request mode reads the branch as origin has it", () => {
  it("refuses a pull request whose remote branch changes a protected file, even when the local branch does not", async () => {
    git(upstream, ["checkout", "-q", "-b", "jarvis/feat/x"]);
    put(upstream, "src/index.ts", "changed on the remote branch\n");
    commitAll(upstream, "remote edit");
    git(upstream, ["checkout", "-q", "main"]);
    expect(await check()).toBeNull();
    expect(await branchProtectedPathsRefusal(work, "jarvis/feat/x", idOf)).toContain(
      "src/index.ts",
    );
  });

  it("allows a pull request whose remote branch touches only ordinary files", async () => {
    git(upstream, ["checkout", "-q", "-b", "jarvis/feat/x"]);
    put(upstream, "docs/a.md", "remote docs\n");
    commitAll(upstream, "remote docs");
    git(upstream, ["checkout", "-q", "main"]);
    expect(await branchProtectedPathsRefusal(work, "jarvis/feat/x", idOf)).toBeNull();
  });

  it("refuses when the remote branch does not exist", async () => {
    expect(
      await branchProtectedPathsRefusal(work, "jarvis/feat/missing", idOf),
    ).toContain("could not run");
  });
});

describe("mcProtectedPathsRefusal — applies to mission-control checkouts only", () => {
  it("does not apply to a repository outside the mission-control checkout roots", async () => {
    // This branch changes a protected name and has no origin: if the check
    // ran it would refuse, so null proves it was not applied.
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    git(work, ["remote", "remove", "origin"]);
    expect(await mcProtectedPathsRefusal(work)).toBeNull();
  });
});

describe("githubSlugOf — the project identity of a remote URL", () => {
  const ours: string[] = [
    "https://github.com/kosm1x/agent-controller",
    "https://github.com/kosm1x/agent-controller.git",
    "https://github.com/kosm1x/agent-controller/",
    "https://github.com/kosm1x/agent-controller.git/",
    "https://GitHub.com/Kosm1x/Agent-Controller.git",
    "https://x-access-token:abc123@github.com/kosm1x/agent-controller.git",
    "https://someone@github.com/kosm1x/agent-controller",
    "http://github.com/kosm1x/agent-controller.git",
    "ssh://git@github.com/kosm1x/agent-controller.git",
    "ssh://git@github.com:22/kosm1x/agent-controller",
    "git://github.com/kosm1x/agent-controller.git",
    "git@github.com:kosm1x/agent-controller.git",
    "git@github.com:kosm1x/agent-controller",
    "github.com:kosm1x/agent-controller.git",
  ];
  for (const url of ours) {
    it(`names the project: ${url}`, () => {
      expect(githubSlugOf(url)).toBe(MC_GITHUB_SLUG);
    });
  }

  const lookAlikes: string[] = [
    "https://github.com/someone-else/agent-controller.git",
    "https://github.com/kosm1x/agent-controller-fork.git",
    "https://github.com/kosm1x/my-agent-controller.git",
    "https://github.com/kosm1x/agent-controller/extra",
    "https://gitlab.com/kosm1x/agent-controller.git",
    "https://github.com.evil.example/kosm1x/agent-controller.git",
    "https://evil.example/github.com/kosm1x/agent-controller.git",
    "https://github.com@evil.example/kosm1x/agent-controller.git",
    "git@evil.example:kosm1x/agent-controller.git",
    "/srv/mirror/github.com/kosm1x/agent-controller.git",
    "file:///srv/github.com/kosm1x/agent-controller.git",
    "kosm1x/agent-controller",
    "",
  ];
  for (const url of lookAlikes) {
    it(`does not name the project: ${url || "(empty)"}`, () => {
      expect(githubSlugOf(url)).not.toBe(MC_GITHUB_SLUG);
    });
  }

  // Plain alternates of the same address: a clone reached by any of them is
  // still this project, so the scope decision does not miss it.
  const alternates: string[] = [
    "https://github.com//kosm1x/agent-controller.git",
    "https://github.com/kosm1x/agent%2Dcontroller.git",
    "https://github.com/kosm1x/./agent-controller.git",
    "https://github.com/kosm1x/agent-controller/.git",
    "git@github.com:/kosm1x/agent-controller.git",
    "https://github.com./kosm1x/agent-controller.git",
    "https://www.github.com/kosm1x/agent-controller.git",
    "ssh://git@ssh.github.com:443/kosm1x/agent-controller.git",
  ];
  for (const url of alternates) {
    it(`names the project (plain alternate): ${url}`, () => {
      expect(githubSlugOf(url)).toBe(MC_GITHUB_SLUG);
    });
  }

  // Only a URL in plain form is read at all: these characters can end the
  // host part for the HTTP client, so the host git contacts would not be the
  // one this function reads.
  const notPlain: string[] = [
    "https://other.example#@github.com/kosm1x/agent-controller.git",
    "https://other.example?@github.com/kosm1x/agent-controller.git",
    "https://127.0.0.1:8000#@github.com/kosm1x/agent-controller.git",
    "https://other.example\\@github.com/kosm1x/agent-controller.git",
    "https://other.example @github.com/kosm1x/agent-controller.git",
    "https://other.example\t@github.com/kosm1x/agent-controller.git",
    "https://other.example@x@github.com/kosm1x/agent-controller.git",
    "https://github.com/../agent-controller.git",
    "https://github.com/kosm1x/../kosm1x/agent-controller.git",
    "https://github.com/kosm1x%2Fagent-controller.git",
    "https://github.com/kosm1x/agent-controller%00.git",
    "https://github.com/kosm1x/agent-controller%zz.git",
    "https://github.com.other.example/kosm1x/agent-controller.git",
    "https://xgithub.com/kosm1x/agent-controller.git",
    "https://github.com@other.example/kosm1x/agent-controller.git",
  ];
  for (const url of notPlain) {
    it(`is not recognised: ${JSON.stringify(url)}`, () => {
      expect(githubSlugOf(url)).toBeNull();
    });
  }
});

describe("isMcCheckoutPath — the checkout roots by path", () => {
  for (const r of [
    "/root/claude/mission-control",
    "/root/claude/mission-control-jarvis",
    "/workspace",
  ]) {
    it(`${r}, with and without its trailing slash and a subdirectory, is a checkout`, () => {
      expect(isMcCheckoutPath(r)).toBe(true);
      expect(isMcCheckoutPath(`${r}/`)).toBe(true);
      expect(isMcCheckoutPath(`${r}/src/tools`)).toBe(true);
    });
  }
  it("a sibling that only shares the prefix is not a checkout", () => {
    expect(isMcCheckoutPath("/root/claude/mission-control-foo")).toBe(false);
    expect(isMcCheckoutPath("/root/claude/mission-control-jarvis-old/src")).toBe(false);
    expect(isMcCheckoutPath("/workspaces/x")).toBe(false);
  });
});

describe("the remote is pinned: origin must name the project for both fetch and push", () => {
  it("refuses with the default identity when origin is not the project's GitHub repository", async () => {
    put(work, "docs/a.md", "ordinary\n");
    commitAll(work, "docs");
    const refusal = await branchProtectedPathsRefusal(work);
    expect(refusal).toContain("does not point at the project repository");
    expect(refusal).toContain("operator");
  });

  it("refuses when the push URL differs from the fetch URL", async () => {
    git(work, ["remote", "set-url", "--push", "origin", join(root, "elsewhere")]);
    expect(await check()).toContain("does not point at the project repository");
  });

  it("refuses when a rewrite rule changes only the fetch side", async () => {
    const fake = join(root, "fake");
    git(root, ["clone", "-q", "--bare", upstream, fake]);
    git(work, ["config", `url.${fake}.insteadOf`, upstream]);
    git(work, ["config", `url.${upstream}.pushInsteadOf`, upstream]);
    expect(await check()).toContain("does not point at the project repository");
  });

  it("refuses when fetch and push agree but name another repository", async () => {
    const fork = join(root, "fork");
    git(root, ["clone", "-q", "--bare", upstream, fork]);
    git(work, ["remote", "set-url", "origin", fork]);
    const forkId = (url: string) =>
      url === fork ? "kosm1x/agent-controller-fork" : idOf(url);
    expect(await branchProtectedPathsRefusal(work, undefined, forkId)).toContain(
      "does not point at the project repository",
    );
  });
});

describe("the check's own git calls ignore the checkout's hooks and grafts", () => {
  it("a graft that would make the merge base equal the tip does not hide the branch's changes", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    const main = git(work, ["rev-parse", "origin/main"]);
    const tip = git(work, ["rev-parse", "HEAD"]);
    writeFileSync(join(work, ".git/info/grafts"), `${main} ${tip}\n`);
    expect(await check()).toContain("src/index.ts");
  });

  it("a hook in the checkout's hooks path does not run: the result is unchanged and the marker is absent", async () => {
    const hooks = join(root, "hooks");
    const marker = join(root, "marker");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "reference-transaction"),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      { mode: 0o755 },
    );
    put(upstream, "lib/b.ts", "main moved\n");
    commitAll(upstream, "main moved");
    put(work, "docs/a.md", "ordinary\n");
    commitAll(work, "docs");
    // Set last: the hook would also refuse the fixture's own commits.
    git(work, ["config", "core.hooksPath", hooks]);
    expect(await check()).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});

describe("scope by repository identity: a clone of this project at any path is checked", () => {
  it("a clone outside the checkout roots whose origin names the project is checked: a protected change is refused", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    expect(await isProjectRepository(work, idOf)).toBe(true);
    expect(await mcProtectedPathsRefusal(work, undefined, idOf)).toContain(
      "src/index.ts",
    );
  });

  it("a clone is in scope when only another remote's push URL names the project", async () => {
    git(work, ["remote", "rename", "origin", "mirror"]);
    git(work, ["remote", "add", "other", join(root, "nowhere")]);
    git(work, ["remote", "set-url", "--push", "other", upstream]);
    git(work, ["remote", "remove", "mirror"]);
    expect(await isProjectRepository(work, idOf)).toBe(true);
  });

  it("a repository of another project is not checked", async () => {
    put(work, "src/index.ts", "changed\n");
    commitAll(work, "edit entry");
    const otherId = (url: string) => (url === upstream ? "eurekamd-net/other" : githubSlugOf(url));
    expect(await isProjectRepository(work, otherId)).toBe(false);
    expect(await mcProtectedPathsRefusal(work, undefined, otherId)).toBeNull();
  });

  it("a remote whose name starts with a dash cannot be read safely: the scope read refuses", async () => {
    git(work, ["config", "remote.-x.url", upstream]);
    await expect(isProjectRepository(work, idOf)).rejects.toThrow();
    expect(await mcProtectedPathsRefusal(work, undefined, idOf)).toContain(
      "could not verify",
    );
  });

  it("a directory that is not a git repository is not in scope", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await isProjectRepository(plain, idOf)).toBe(false);
    expect(await mcProtectedPathsRefusal(plain, undefined, idOf)).toBeNull();
  });
});
