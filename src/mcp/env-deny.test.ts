import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildChildEnv, CHILD_ENV_BASE } from "./env-deny.js";

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

  it("keys are a subset of the base plus the extra keys", () => {
    const env = buildChildEnv({ GH_TOKEN: "t" });
    const allowed = new Set([...CHILD_ENV_BASE, "GH_TOKEN"]);
    for (const k of Object.keys(env)) expect(allowed.has(k)).toBe(true);
    expect(env.GH_TOKEN).toBe("t");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("a name set in process.env outside the base is absent", () => {
    const env = buildChildEnv();
    expect(env).not.toHaveProperty("CANARY_API_KEY");
    expect(env).not.toHaveProperty("SOME_UNRELATED_SETTING");
    expect(JSON.stringify(env)).not.toContain("canary-value");
  });
});
