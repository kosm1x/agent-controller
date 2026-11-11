/**
 * The one source of GitHub authority for child processes.
 *
 * GitHub children run under the agent's own account; nothing falls back to a
 * login stored on the host. The account comes from the service env:
 * `JARVIS_GH_TOKEN` (required), `JARVIS_GH_USER` and `JARVIS_GH_EMAIL`
 * (optional). Without the token every GitHub operation is refused with
 * GITHUB_UNAVAILABLE and nothing is sent. The account has write access only
 * where the operator granted it, so a refused push elsewhere is the intended
 * result (githubAccessRefusal words it).
 *
 * The token reaches a child only through its env (GH_TOKEN for `gh`, a
 * credential helper that reads GH_TOKEN for `git`), never through an argv, a
 * URL or a log line.
 */
import {
  CREDENTIAL_HELPER_RESET,
  buildChildEnv,
  emptyGhConfigDir,
  gitConfigEnv,
} from "../mcp/env-deny.js";

/**
 * git credential helper that answers from the child's env (GH_TOKEN,
 * JARVIS_GH_USER): only the env NAMES appear in config, never the value.
 * GH_TOKEN is in the env of git and of every child git spawns, so a repo hook
 * the push runs can read it.
 */
export const AGENT_CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "\${JARVIS_GH_USER:-x-access-token}" "$GH_TOKEN"; }; f`;

/** The helper answers for github.com only: the token is never offered to another host. */
export const AGENT_CREDENTIAL_HELPER_KEY = "credential.https://github.com.helper";

export const GITHUB_UNAVAILABLE =
  "GitHub is unavailable: the agent's GitHub token (JARVIS_GH_TOKEN) is not configured, so nothing was sent to GitHub. GitHub operations run only under the agent's own account; the operator can configure the token.";

/** The service-env names that carry the agent's GitHub account (read at call time). */
export const AGENT_GITHUB_ENV_NAMES = [
  "JARVIS_GH_TOKEN",
  "JARVIS_GH_USER",
  "JARVIS_GH_EMAIL",
] as const;

function agentToken(): string | undefined {
  return process.env.JARVIS_GH_TOKEN || undefined;
}

/** True when the agent's GitHub token is configured. */
export function agentGithubConfigured(): boolean {
  return agentToken() !== undefined;
}

/** The agent's commit identity, as author AND committer. */
export function agentCommitIdentity(): { name: string; email: string } {
  return {
    name: process.env.JARVIS_GH_USER || "Jarvis",
    email: process.env.JARVIS_GH_EMAIL || "jarvis@mission-control.local",
  };
}

/** agentCommitIdentity as the env names git reads for author and committer. */
export function agentCommitIdentityEnv(): Record<string, string> {
  const { name, email } = agentCommitIdentity();
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * The env additions that make `gh` and `git` run as the agent: GH_TOKEN, an
 * empty GH_CONFIG_DIR, no terminal prompt, and git config that first resets
 * every configured credential helper and then sets AGENT_CREDENTIAL_HELPER
 * for github.com. Null when the token is not configured.
 */
export function agentGithubEnv(): Record<string, string> | null {
  const token = agentToken();
  if (!token) return null;
  const user = process.env.JARVIS_GH_USER;
  return {
    GH_CONFIG_DIR: emptyGhConfigDir(),
    GH_TOKEN: token,
    ...(user ? { JARVIS_GH_USER: user } : {}),
    GIT_TERMINAL_PROMPT: "0",
    ...gitConfigEnv([
      CREDENTIAL_HELPER_RESET,
      [AGENT_CREDENTIAL_HELPER_KEY, AGENT_CREDENTIAL_HELPER],
    ]),
  };
}

export type GithubAuthority =
  | { env: Record<string, string> }
  | { refusal: string };

/**
 * The full env for a child that talks to GitHub (the base allow-list, the
 * agent's identity and agentGithubEnv), or the refusal when the token is not
 * configured.
 */
export function githubAuthority(): GithubAuthority {
  const github = agentGithubEnv();
  if (!github) return { refusal: GITHUB_UNAVAILABLE };
  // github's git config replaces the base one; its entry 0 is the same
  // helper reset, so the reset always comes first.
  return { env: { ...buildChildEnv(agentCommitIdentityEnv()), ...github } };
}

/** Mask the agent's token in text bound for a result or a log line. */
export function redactAgentToken(text: string): string {
  const token = agentToken();
  return token ? text.split(token).join("***") : text;
}

/** How GitHub (via git or gh) words "this account may not write here". */
const NO_ACCESS_RE =
  /Permission to \S+ denied|requested URL returned error: 403|HTTP 403|remote: Repository not found|Resource not accessible by (?:personal access token|integration)|does not have the correct permissions|must be a collaborator|cannot create a repository/i;

/** A rate-limit answer (GitHub sends it as a 403 too) is not an access answer. */
const RATE_LIMIT_RE = /rate limit/i;

/**
 * True when the program's STDERR says the agent's account may not write the
 * target. Only stderr is read: an error message embeds the argv (a pull
 * request body, a description), which is the caller's text, not GitHub's.
 */
export function githubNoAccess(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return NO_ACCESS_RE.test(stderr) && !RATE_LIMIT_RE.test(stderr);
}

/**
 * One sentence when the program's stderr says the agent's account has no
 * write access to `target`, else null.
 */
export function githubAccessRefusal(
  stderr: string | undefined,
  target: string,
): string | null {
  return githubNoAccess(stderr)
    ? `GitHub refused this: the agent's GitHub account has no write access to ${target}; the operator can invite that account to it.`
    : null;
}

/**
 * Creating a repository under the agent's own account was refused: there is
 * no one to invite, the token itself may lack the permission.
 */
export const OWN_ACCOUNT_CREATE_REFUSAL =
  "GitHub refused this: the agent's token may lack the permission to create repositories under its own account; the operator can check the agent's token.";
