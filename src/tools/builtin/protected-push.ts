/**
 * Protected files, checked again at the push and the pull request.
 *
 * The file tools refuse a write to a protected path (IMMUTABLE_FILES /
 * IMMUTABLE_PREFIXES in immutable-core.ts) when the file is written. The push
 * tools (git_push, jarvis_dev action=pr) and the pull-request tool
 * (gh_create_pr) check the branch here as well, on the result: the paths the
 * branch itself changes compared with its merge base on the default branch,
 * however those changes were made. The shell gate refuses pushes on its side.
 * Protected files are changed in an operator session for now (operator ruling
 * 2026-11-10).
 *
 * The check applies to this project wherever it is cloned: inside a checkout
 * root, or in any repository whose remotes name this project's GitHub
 * repository. Inside the check, origin must point at that repository for both
 * fetch and push, so the comparison and the push read the same place.
 */

import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import { errMsg } from "../../lib/err-msg.js";
import { buildChildEnv } from "../../mcp/env-deny.js";
import { githubAuthority } from "../../lib/github-authority.js";
import {
  isImmutableCorePath,
  MC_CHECKOUT_ROOTS,
  MC_GITHUB_SLUG,
  MC_WORKTREE_ROOT,
} from "./immutable-core.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
/** The default branch as origin has it; fully qualified so a local branch or tag named `origin/main` cannot stand in. */
const DEFAULT_BRANCH_REF = "refs/remotes/origin/main";
const LISTED_PATHS_CAP = 20;

/** Maps a remote URL to the `owner/repo` it names on github.com, or null. */
type IdentityOf = (url: string) => string | null;

/** Host names that are github.com itself (compared lower case, one trailing dot dropped). */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/**
 * The `owner/repo` (lower case) a remote URL names on github.com, or null for
 * any other host or shape. Accepts the https/http, ssh://, git:// and
 * `[user@]github.com:owner/repo` forms, with or without a user or token part,
 * a port, a trailing `.git` or a trailing slash, and plain alternates of the
 * same address (see the steps below). Only a URL in plain form is read: `?`,
 * `#`, a backslash, whitespace, a control character or a second `@` can end
 * the host part for the client, which would then contact another host.
 */
export function githubSlugOf(url: string): string | null {
  if (/[?#\\\s\x00-\x1f\x7f]/.test(url) || url.split("@").length > 2) {
    return null;
  }
  const m =
    url.match(
      /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/?#\\]*@)?([^/:@?#\\]+)(?::\d+)?(\/.*)$/i,
    ) ?? url.match(/^(?:[^@/:?#\\]+@)?([^/:@?#\\]+):(.*)$/);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  if (!GITHUB_HOSTS.has(host)) return null;
  // Percent-decode once; an escape that decodes to a separator is not plain.
  if (/%(?:2f|3f|23|5c|25)/i.test(m[2])) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  path = path.replace(/\/{2,}/g, "/").replace(/^\//, "");
  const segments = path.split("/").filter((seg) => seg !== ".");
  if (segments.includes("..")) return null;
  path = segments
    .join("/")
    .replace(/\/$/, "")
    .replace(/\/?\.git$/i, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)
    ? path.toLowerCase()
    : null;
}

/**
 * One git step of the check. A failure throws with the step's name only: git's
 * own error text can carry a remote URL, so it is not passed on.
 */
async function git(
  repoDir: string,
  step: string,
  args: string[],
): Promise<string> {
  // The checkout's own hooks, grafts and replacement objects play no part in
  // the check: it reads the commits the push sends, as they are.
  const checkEnv = {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  // The fetch talks to GitHub, so it runs under the agent's own account like
  // the push it guards; without the agent's token it fails closed (the check
  // could not run, so nothing is sent). The other steps are local reads.
  let env: Record<string, string>;
  if (args[0] === "fetch") {
    const github = githubAuthority();
    if ("refusal" in github) throw new Error(`${step} failed`);
    env = { ...github.env, ...checkEnv };
  } else {
    env = buildChildEnv(checkEnv);
  }
  const p = execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  p.child.stdin?.end();
  try {
    return (await p).stdout;
  } catch {
    throw new Error(`${step} failed`);
  }
}

/** Every URL a remote fetches from or pushes to, as git expands them (`insteadOf` / `pushInsteadOf`). */
async function remoteUrls(repoDir: string, name: string): Promise<string[]> {
  if (name.startsWith("-")) throw new Error("a remote name starts with '-'");
  const fetchUrl = await git(repoDir, "reading a remote's fetch URL", [
    "ls-remote",
    "--get-url",
    name,
  ]);
  const pushUrls = await git(repoDir, "reading a remote's push URLs", [
    "remote",
    "get-url",
    "--push",
    "--all",
    name,
  ]);
  return [fetchUrl, ...pushUrls.split("\n")]
    .map((u) => u.trim())
    .filter(Boolean);
}

/**
 * Paths the branch adds, modifies or deletes compared with its merge base on
 * origin/main: the push mode reads the local branch (HEAD, what the push
 * sends), the pull-request mode reads `prBranch` as origin has it (what the
 * pull request carries). origin/main is fetched first, so the comparison uses
 * the remote's default branch, not a local ref. Rename detection is off, so a
 * rename lists both the old and the new name. Throws when any step fails.
 */
async function pathsChangedByBranch(
  repoDir: string,
  prBranch?: string,
): Promise<string[]> {
  const tip = prBranch ? `refs/remotes/origin/${prBranch}` : "HEAD";
  if (!prBranch) {
    await git(repoDir, "reading the branch checked out", [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
  }
  const refspecs = [`+refs/heads/main:${DEFAULT_BRANCH_REF}`];
  if (prBranch) refspecs.push(`+refs/heads/${prBranch}:${tip}`);
  // --refmap=: only the refspecs given here are updated.
  await git(repoDir, "fetching origin", [
    "fetch",
    "--quiet",
    "--no-tags",
    "--refmap=",
    "origin",
    ...refspecs,
  ]);
  const base = (
    await git(repoDir, "finding the merge base with origin/main", [
      "merge-base",
      DEFAULT_BRANCH_REF,
      tip,
    ])
  ).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base)) {
    throw new Error("finding the merge base with origin/main failed");
  }
  // --no-relative: paths from the repository root even when `diff.relative`
  // is configured; --ignore-submodules=none: a gitlink is a changed path too.
  const out = await git(repoDir, "listing the paths the branch changes", [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-relative",
    "--ignore-submodules=none",
    "--no-color",
    base,
    tip,
    "--",
  ]);
  return out.split("\0").filter(Boolean);
}

/**
 * The refusal text when the branch in `repoDir` changes a protected path
 * (or when that cannot be determined — the check fails closed), else null.
 * `prBranch` switches to the pull-request mode (see pathsChangedByBranch).
 * The paths are matched with the one protected-path matcher: they are
 * relative to the checkout root, and the lists hold in every checkout root.
 * Before anything is fetched, origin's fetch and push URLs must each name
 * this project's GitHub repository. `idOf` is a test seam only.
 */
export async function branchProtectedPathsRefusal(
  repoDir: string,
  prBranch?: string,
  idOf: IdentityOf = githubSlugOf,
): Promise<string | null> {
  const refused = prBranch
    ? "No pull request was opened"
    : "Nothing was pushed";
  let changed: string[];
  try {
    const urls = await remoteUrls(repoDir, "origin");
    if (urls.length < 2 || urls.some((u) => idOf(u) !== MC_GITHUB_SLUG)) {
      return (
        `${refused}: the remote of this checkout does not point at the project repository ` +
        `(${MC_GITHUB_SLUG} on GitHub) for both fetch and push. The operator must look at it.`
      );
    }
    changed = await pathsChangedByBranch(repoDir, prBranch);
  } catch (err) {
    return (
      `${refused}: the protected-file check could not run (${errMsg(err)}). ` +
      `It compares the branch with its merge base on origin/main, so it needs a branch checked out, ` +
      `origin reachable with its main branch present, and a common ancestor with origin/main.`
    );
  }
  const hits = changed.filter(
    (p) => isImmutableCorePath(join(MC_WORKTREE_ROOT, p)).immutable,
  );
  if (hits.length === 0) return null;
  const listed = hits.slice(0, LISTED_PATHS_CAP).join(", ");
  const more =
    hits.length > LISTED_PATHS_CAP
      ? ` (and ${hits.length - LISTED_PATHS_CAP} more)`
      : "";
  return (
    `${refused}: this branch changes protected mission-control files: ${listed}${more}. ` +
    `Protected files are changed in an operator session for now (operator ruling 2026-11-10). ` +
    `Take those files out of the branch (restore each to its origin/main version, or remove it ` +
    `if the branch added it, and commit), or hand the change to the operator.`
  );
}

/** True when `absPath` is inside a mission-control checkout (the same roots the write boundary uses). */
export function isMcCheckoutPath(absPath: string): boolean {
  const withSlash = absPath.endsWith("/") ? absPath : `${absPath}/`;
  return MC_CHECKOUT_ROOTS.some((root) => withSlash.startsWith(root));
}

/**
 * True when any remote of the repository at `dir` fetches from or pushes to
 * this project's GitHub repository; false when it names none, or when `dir`
 * is not a git repository. Throws when the remotes cannot be read.
 */
export async function isProjectRepository(
  dir: string,
  idOf: IdentityOf = githubSlugOf,
): Promise<boolean> {
  try {
    await git(dir, "finding the repository", ["rev-parse", "--git-dir"]);
  } catch {
    return false;
  }
  const names = (await git(dir, "listing the remotes", ["remote"]))
    .split("\n")
    .filter(Boolean);
  for (const name of names) {
    const urls = await remoteUrls(dir, name);
    if (urls.some((u) => idOf(u) === MC_GITHUB_SLUG)) return true;
  }
  return false;
}

/**
 * True when `dir` (a resolved path) holds this project: a checkout root by
 * path, or a repository whose remotes name it. Throws when that cannot be read.
 */
export async function isMcRepository(
  dir: string,
  idOf: IdentityOf = githubSlugOf,
): Promise<boolean> {
  return isMcCheckoutPath(dir) || isProjectRepository(dir, idOf);
}

/**
 * The check for one door: applied when `dir` holds this project (see
 * isMcRepository), otherwise null — other repositories are not checked. When
 * the remotes cannot be read the door is refused.
 */
export async function mcProtectedPathsRefusal(
  dir: string,
  prBranch?: string,
  idOf: IdentityOf = githubSlugOf,
): Promise<string | null> {
  let ours: boolean;
  try {
    ours = await isMcRepository(dir, idOf);
  } catch (err) {
    return (
      `${prBranch ? "No pull request was opened" : "Nothing was pushed"}: could not verify ` +
      `whether this repository is mission-control (${errMsg(err)}).`
    );
  }
  return ours ? branchProtectedPathsRefusal(dir, prBranch, idOf) : null;
}
