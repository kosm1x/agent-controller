import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  AGENT_CREDENTIAL_HELPER,
  GITHUB_UNAVAILABLE,
  agentCommitIdentityEnv,
  agentGithubEnv,
  githubAccessRefusal,
  githubAuthority,
  redactAgentToken,
} from "./github-authority.js";
import { buildChildEnv } from "../mcp/env-deny.js";

const TOKEN = "ghp_canaryToken123";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("githubAuthority — GitHub children run under the agent's own account", () => {
  it("without the agent's token: a refusal, no env", () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    expect(githubAuthority()).toEqual({ refusal: GITHUB_UNAVAILABLE });
    expect(agentGithubEnv()).toBeNull();
  });

  it("with the token: base allow-list + GH_TOKEN + an empty GH_CONFIG_DIR + helper reset, then the env helper for github.com", () => {
    vi.stubEnv("JARVIS_GH_TOKEN", TOKEN);
    vi.stubEnv("JARVIS_GH_USER", "agent-bot");
    vi.stubEnv("CANARY_API_KEY", "canary-value-1");
    const auth = githubAuthority();
    if (!("env" in auth)) throw new Error("expected an env");
    const env = auth.env;
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(env.JARVIS_GH_USER).toBe("agent-bot");
    expect(env).not.toHaveProperty("JARVIS_GH_TOKEN");
    expect(env).not.toHaveProperty("CANARY_API_KEY");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(readdirSync(env.GH_CONFIG_DIR)).toEqual([]);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual([
      "credential.helper",
      "",
    ]);
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual([
      "credential.https://github.com.helper",
      AGENT_CREDENTIAL_HELPER,
    ]);
    // Only the env NAMES are in the config, never the value.
    expect(AGENT_CREDENTIAL_HELPER).toContain('"$GH_TOKEN"');
    expect(JSON.stringify(Object.entries(env).filter(([k]) => k !== "GH_TOKEN"))).not.toContain(TOKEN);
    // Commits made by a GitHub child carry the agent identity.
    expect(env.GIT_AUTHOR_NAME).toBe("agent-bot");
    expect(env.GIT_COMMITTER_NAME).toBe("agent-bot");
  });

  it("the commit identity is the agent's, as author AND committer, token or not", () => {
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    vi.stubEnv("JARVIS_GH_USER", "agent-bot");
    vi.stubEnv("JARVIS_GH_EMAIL", "agent@example.invalid");
    expect(agentCommitIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: "agent-bot",
      GIT_AUTHOR_EMAIL: "agent@example.invalid",
      GIT_COMMITTER_NAME: "agent-bot",
      GIT_COMMITTER_EMAIL: "agent@example.invalid",
    });
  });

  it("redactAgentToken masks the token; without one the text is unchanged", () => {
    vi.stubEnv("JARVIS_GH_TOKEN", TOKEN);
    expect(redactAgentToken(`bad credentials ${TOKEN}`)).toBe("bad credentials ***");
    vi.stubEnv("JARVIS_GH_TOKEN", "");
    expect(redactAgentToken(`x ${TOKEN}`)).toBe(`x ${TOKEN}`);
  });

  it.each([
    "remote: Permission to o/r.git denied to agent-bot.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    "pull request create failed: GraphQL: Resource not accessible by personal access token (createPullRequest)",
    "GraphQL: agent-bot does not have the correct permissions to execute `CreatePullRequest`",
    "HTTP 403: Must have admin rights to Repository.",
  ])("a no-access GitHub error becomes one sentence naming the operator's invitation: %s", (err) => {
    const r = githubAccessRefusal(err, "o/r");
    expect(r).toBe(
      "GitHub refused this: the agent's GitHub account has no write access to o/r; the operator can invite that account to it.",
    );
  });

  it("any other error is not reworded", () => {
    expect(githubAccessRefusal("! [rejected] main -> main (non-fast-forward)", "o/r")).toBeNull();
    expect(githubAccessRefusal("fatal: unable to access: Could not resolve host", "o/r")).toBeNull();
  });

  // A rate-limit answer comes as a 403 too; it says nothing about access.
  it.each([
    "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)",
    "error: You have exceeded a secondary rate limit. HTTP 403",
    "remote: The requested URL returned error: 403 — rate limit",
  ])("a rate-limit answer is not a no-access refusal: %s", (err) => {
    expect(githubAccessRefusal(err, "o/r")).toBeNull();
  });

  it("only the program's stderr is read: no stderr, no refusal", () => {
    expect(githubAccessRefusal(undefined, "o/r")).toBeNull();
    expect(githubAccessRefusal("", "o/r")).toBeNull();
  });
});

// Real git, no network: `git credential fill` asks the configured helpers
// exactly as a push would, against a synthetic HOME that has its own helper.
describe("real git: the env config answers as the agent and no other helper is asked", () => {
  const fill = (env: Record<string, string>, home: string, host = "github.com") =>
    execFileSync("git", ["credential", "fill"], {
      cwd: home,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
      input: `protocol=https\nhost=${host}\npath=o/r.git\n\n`,
      env: { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    });

  it("the agent env wins over a configured helper; the base env leaves no helper at all", () => {
    const home = mkdtempSync(`${tmpdir()}/git-cred-`);
    try {
      // A competing helper for github.com in the user's global config.
      writeFileSync(
        `${home}/.gitconfig`,
        '[credential "https://github.com"]\n\thelper = "!f() { echo username=other; echo password=WRONG; }; f"\n[credential]\n\thelper = "!f() { echo username=other; echo password=WRONG; }; f"\n',
      );
      vi.stubEnv("JARVIS_GH_TOKEN", "synthetic-token");
      vi.stubEnv("JARVIS_GH_USER", "agent-bot");
      const auth = githubAuthority();
      if (!("env" in auth)) throw new Error("expected an env");
      const out = fill(auth.env, home);
      expect(out).toContain("username=agent-bot\n");
      expect(out).toContain("password=synthetic-token\n");
      expect(out).not.toContain("WRONG");

      // Another host gets nothing from the agent helper (and no other helper
      // answers): git has no credential, and with no prompt it fails.
      expect(() => fill(auth.env, home, "example.com")).toThrow();

      // The base env of every child: the reset alone, so no helper answers.
      expect(() => fill(buildChildEnv({ GIT_TERMINAL_PROMPT: "0" }), home)).toThrow();

      // Control: without the env config, the configured helper answers.
      expect(
        fill({ PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" }, home),
      ).toContain("password=WRONG");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
