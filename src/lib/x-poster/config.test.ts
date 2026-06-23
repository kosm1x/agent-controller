import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listXAccounts,
  getAccountCreds,
  getDefaultAccount,
  resolveAccount,
  normalizeHandle,
  isCookieConfigured,
  anyXAccountConfigured,
  getProbeUrl,
} from "./config.js";

const X_KEYS = Object.keys(process.env).filter((k) => k.startsWith("X_"));
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of X_KEYS) saved[k] = process.env[k];
  // Clear any ambient X_* so the host env can't leak into assertions.
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v;
});

describe("normalizeHandle", () => {
  it("lowercases and strips a leading @", () => {
    expect(normalizeHandle("@LookIn4ward")).toBe("lookin4ward");
    expect(normalizeHandle("  MexicoNecesario ")).toBe("mexiconecesario");
  });
});

describe("listXAccounts", () => {
  it("discovers per-handle auth_token pairs (case-insensitive handle)", () => {
    process.env.X_AUTH_TOKEN__lookin4ward = "a";
    process.env.X_CT0__lookin4ward = "b";
    process.env.X_AUTH_TOKEN__mexiconecesario = "c";
    process.env.X_CT0__mexiconecesario = "d";
    expect(listXAccounts()).toEqual(["lookin4ward", "mexiconecesario"]);
  });

  it("ignores a handle whose auth_token is empty", () => {
    process.env.X_AUTH_TOKEN__ghost = "   ";
    expect(listXAccounts()).toEqual([]);
  });

  it("maps a bare X_AUTH_TOKEN to the default account", () => {
    process.env.X_AUTH_TOKEN = "a";
    process.env.X_CT0 = "b";
    process.env.X_DEFAULT_ACCOUNT = "lookin4ward";
    expect(listXAccounts()).toEqual(["lookin4ward"]);
  });

  it("a bare pair with NO X_DEFAULT_ACCOUNT is the synthetic 'default' account (not invisible)", () => {
    // W1 guard: this is the exact migration state (bare pair, no default) — it
    // must NOT silently read as "not configured" (the original-incident class).
    process.env.X_AUTH_TOKEN = "a";
    process.env.X_CT0 = "b";
    expect(listXAccounts()).toEqual(["default"]);
    expect(getDefaultAccount()).toBe("default");
    expect(anyXAccountConfigured()).toBe(true);
    expect(isCookieConfigured(getAccountCreds("default"))).toBe(true);
  });
});

describe("getDefaultAccount / resolveAccount", () => {
  it("uses X_DEFAULT_ACCOUNT when set", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    process.env.X_AUTH_TOKEN__b = "1";
    process.env.X_DEFAULT_ACCOUNT = "@B";
    expect(getDefaultAccount()).toBe("b");
    expect(resolveAccount()).toBe("b");
    expect(resolveAccount("a")).toBe("a"); // explicit wins
  });

  it("falls back to the sole account when no default is set", () => {
    process.env.X_AUTH_TOKEN__only = "1";
    expect(getDefaultAccount()).toBe("only");
  });

  it("is undefined when multiple accounts and no explicit default", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    process.env.X_AUTH_TOKEN__b = "1";
    expect(getDefaultAccount()).toBeUndefined();
    expect(resolveAccount()).toBeUndefined();
  });
});

describe("resolveAccount fuzzy match (iooking/looking l↔I typo class)", () => {
  beforeEach(() => {
    process.env.X_AUTH_TOKEN__iooking4ward = "a";
    process.env.X_CT0__iooking4ward = "b";
    process.env.X_AUTH_TOKEN__mexiconecesario = "c";
    process.env.X_CT0__mexiconecesario = "d";
  });

  it("maps a near-miss handle to the unique configured account", () => {
    expect(resolveAccount("looking4ward")).toBe("iooking4ward"); // l→i (dist 1)
    expect(resolveAccount("lookin4ward")).toBe("iooking4ward"); // l→i + missing g (dist 2)
    expect(resolveAccount("@Looking4ward")).toBe("iooking4ward"); // cased + @
    expect(resolveAccount("mexiconecesari")).toBe("mexiconecesario"); // dist 1
  });

  it("never overrides an EXACT configured handle", () => {
    expect(resolveAccount("iooking4ward")).toBe("iooking4ward");
    expect(resolveAccount("@MexicoNecesario")).toBe("mexiconecesario");
  });

  it("returns the input unchanged when too far / too short / ambiguous (lets noAccountError fire)", () => {
    expect(resolveAccount("garbage")).toBe("garbage"); // distance > 2 from both
    expect(resolveAccount("x")).toBe("x"); // length < 5 → no fuzzy attempt
  });

  it("does not fuzzy-bind when two configured accounts are equally near (ambiguous)", () => {
    // Wipe and seed two handles within dist 2 of the probe → must NOT pick one.
    for (const k of Object.keys(process.env))
      if (k.startsWith("X_")) delete process.env[k];
    process.env.X_AUTH_TOKEN__bcdef = "1";
    process.env.X_AUTH_TOKEN__abcde = "1";
    expect(resolveAccount("abcdef")).toBe("abcdef"); // dist 1 to both → ambiguous → unchanged
  });
});

describe("getProbeUrl", () => {
  it("defaults to the badge_count endpoint (v1.1 verify_credentials was retired by X)", () => {
    expect(getProbeUrl()).toContain("/2/badge_count/badge_count.json");
  });
  it("is overridable via X_PROBE_URL (survives X's next API move without a code change)", () => {
    process.env.X_PROBE_URL = "https://example.test/probe";
    expect(getProbeUrl()).toBe("https://example.test/probe");
  });
});

describe("getAccountCreds", () => {
  it("resolves a handle's tokens", () => {
    process.env.X_AUTH_TOKEN__lookin4ward = "tok";
    process.env.X_CT0__lookin4ward = "csrf";
    const creds = getAccountCreds("lookin4ward");
    expect(creds).toMatchObject({
      handle: "lookin4ward",
      authToken: "tok",
      ct0: "csrf",
    });
    expect(isCookieConfigured(creds)).toBe(true);
  });

  it("uses the bare-var fallback only for the default account", () => {
    process.env.X_AUTH_TOKEN = "tok";
    process.env.X_CT0 = "csrf";
    process.env.X_DEFAULT_ACCOUNT = "lookin4ward";
    expect(getAccountCreds("lookin4ward")).toMatchObject({
      authToken: "tok",
      ct0: "csrf",
    });
    expect(getAccountCreds("mexiconecesario")).toBeNull(); // bare does NOT leak to non-default
  });

  it("returns null for an unconfigured handle", () => {
    process.env.X_AUTH_TOKEN__a = "1";
    expect(getAccountCreds("nope")).toBeNull();
  });

  it("anyXAccountConfigured reflects presence", () => {
    expect(anyXAccountConfigured()).toBe(false);
    process.env.X_AUTH_TOKEN__a = "1";
    expect(anyXAccountConfigured()).toBe(true);
  });
});
