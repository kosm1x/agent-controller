import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, statSync } from "fs";
import {
  buildChildEnv,
  CHILD_ENV_BASE,
  gitConfigEnv,
  isDeniedEnvName,
  NO_STORED_LOGIN_NAMES,
} from "./env-deny.js";

describe("buildChildEnv — base allow-list + explicit extras (queue 3h)", () => {
  beforeEach(() => {
    vi.stubEnv("CANARY_API_KEY", "canary-value-1");
    vi.stubEnv("SOME_UNRELATED_SETTING", "canary-value-2");
    vi.stubEnv("LC_ALL", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('omits an unset base name (spawn would pass the string "undefined")', () => {
    expect(buildChildEnv()).not.toHaveProperty("LC_ALL");
  });

  it("an explicit extra wins over the service value", () => {
    expect(buildChildEnv({ PATH: "x" }).PATH).toBe("x");
  });

  it("keys are a subset of the base, the stored-login settings and the extra keys", () => {
    const env = buildChildEnv({ GH_TOKEN: "t" });
    const allowed = new Set([
      ...CHILD_ENV_BASE,
      ...NO_STORED_LOGIN_NAMES,
      "GH_TOKEN",
    ]);
    for (const k of Object.keys(env)) expect(allowed.has(k)).toBe(true);
    expect(env.GH_TOKEN).toBe("t");
    expect(env.PATH).toBe(process.env.PATH);
  });

  // GitHub children run under the agent's own account: children get no stored
  // login by default. Every child env carries the two no-stored-login settings.
  it("every child: gh reads an empty config directory and git's credential helpers are reset", () => {
    vi.stubEnv("GH_CONFIG_DIR", "/elsewhere");
    const env = buildChildEnv();
    expect(env.GH_CONFIG_DIR).not.toBe("/elsewhere");
    expect(readdirSync(env.GH_CONFIG_DIR)).toEqual([]);
    expect(statSync(env.GH_CONFIG_DIR).mode & 0o777).toBe(0o700);
    expect(buildChildEnv().GH_CONFIG_DIR).toBe(env.GH_CONFIG_DIR); // one directory per process
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env).not.toHaveProperty("GH_TOKEN");
    for (const name of NO_STORED_LOGIN_NAMES) expect(env).toHaveProperty(name);
  });

  // The credential-helper reset is entry 0 of every child's git config; an
  // extra carrying its own git config would replace it, so that call throws.
  it("an extra with a GIT_CONFIG_ name throws, naming the names", () => {
    expect(() => buildChildEnv({ GIT_CONFIG_COUNT: "0" })).toThrow(/GIT_CONFIG_COUNT/);
    expect(() =>
      buildChildEnv({ ...gitConfigEnv([["user.name", "agent-bot"]]), LANG: "C" }),
    ).toThrow(/GIT_CONFIG_KEY_0/);
    expect(() => buildChildEnv({ GIT_CONFIG_GLOBAL: "/elsewhere" })).toThrow(/credential-helper reset/);
    expect(buildChildEnv({ GIT_TERMINAL_PROMPT: "0" }).GIT_CONFIG_KEY_0).toBe("credential.helper");
  });

  it("gitConfigEnv numbers its entries from 0", () => {
    expect(gitConfigEnv([["a.b", "1"], ["c.d", ""]])).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "c.d",
      GIT_CONFIG_VALUE_1: "",
    });
  });

  it("a name set in process.env outside the base is absent", () => {
    const env = buildChildEnv();
    expect(env).not.toHaveProperty("CANARY_API_KEY");
    expect(env).not.toHaveProperty("SOME_UNRELATED_SETTING");
    expect(JSON.stringify(env)).not.toContain("canary-value");
  });
});

describe("declared-names deny list — gh and git config names", () => {
  it("gh's names, git's env config and XDG_CONFIG_HOME are not declarable; neighbours are", () => {
    for (const name of ["GH_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG", "XDG_CONFIG_HOME"]) {
      expect(isDeniedEnvName(name), name).toBe(true);
    }
    for (const name of ["GHOST_MODE", "GITHUB_REPO", "XDG_DATA_HOME", "PG_PASSWORD"]) {
      expect(isDeniedEnvName(name), name).toBe(false);
    }
  });
});
