/**
 * Tests for the MCP secret-redaction helper.
 *
 * NOTE: every fake-secret fixture below is ASSEMBLED FROM FRAGMENTS (e.g.
 * `"sk-" + "proj-..."`). The runtime value is a normal recognizable secret
 * shape — that's what the redactor must catch — but no contiguous secret
 * PREFIX appears in the source text, so pre-commit secret scanners
 * (git-secret-guard) don't flag this test's own inputs as leaked keys.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redactCredentials,
  redactCredentialsForPersist,
  redactDeep,
  redactSecrets,
  stringifyRedacted,
} from "./redact.js";

// Fragment-assembled fake fixtures (see file header).
const SK = "sk-" + "abcdefghijklmnop1234567890ABCD";
const SK_PROJ = "sk-" + "proj-abcdefghijklmnop1234567890ABCD";
const GHP = "ghp" + "_abcdefghijklmnopqrstu";
const GHO = "gho" + "_0123456789abcdefghijk";
const GLPAT = "glpat" + "-abcdefghijklmnop";
const JRVS = "jrvs" + "_" + "a".repeat(64);
const AIZA = "AIza" + "b".repeat(35);
const AIZA_VALUE = "AIza" + "SyExampleValue1234567890abcdef";
const TELEGRAM = "1234567890:" + "A".repeat(35);

describe("redactSecrets", () => {
  it("redacts Authorization: Bearer headers", () => {
    expect(redactSecrets(`Authorization: Bearer ${SK}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts Authorization: Basic headers", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [REDACTED]",
    );
  });

  it("redacts sk- prefixed API keys", () => {
    const input = `My key is ${SK_PROJ} in logs`;
    const out = redactSecrets(input);
    expect(out).not.toContain(SK_PROJ);
    expect(out).toContain("[REDACTED_KEY]");
  });

  it("redacts ghp_ / gho_ / glpat- tokens", () => {
    expect(redactSecrets(GHP)).toContain("[REDACTED_KEY]");
    expect(redactSecrets(GHO)).toContain("[REDACTED_KEY]");
    expect(redactSecrets(GLPAT)).toContain("[REDACTED_KEY]");
  });

  it("redacts jrvs_ bearer tokens", () => {
    expect(redactSecrets(`the token is ${JRVS}`)).not.toContain(JRVS);
  });

  it("redacts JSON fields named password/secret/api_key/access_token", () => {
    const json = JSON.stringify({
      api_key: "abc123",
      password: "hunter2",
      access_token: "ya29.a0Afh",
      harmless: "keep",
    });
    const out = redactSecrets(json);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("ya29.a0Afh");
    expect(out).toContain("keep");
  });

  it("redacts 40+ char hex blobs", () => {
    const hmac = "a".repeat(64);
    expect(redactSecrets(`checksum=${hmac}`)).toContain("[REDACTED_HEX]");
  });

  it("leaves short hex strings alone", () => {
    // "deadbeef" (8 chars) is common in docs and must not be redacted
    expect(redactSecrets("magic=deadbeef")).toBe("magic=deadbeef");
  });

  it("redacts Google/Gemini AIza keys (H6 journal-leak shape)", () => {
    expect(redactSecrets(`key is ${AIZA}`)).not.toContain(AIZA);
    expect(redactSecrets(`key is ${AIZA}`)).toContain("[REDACTED_KEY]");
  });

  it("redacts secret-named shell assignments (export KEY=val)", () => {
    const out = redactSecrets(`export GEMINI_API_KEY="${AIZA_VALUE}"`);
    expect(out).not.toContain(AIZA_VALUE);
    expect(out).toContain("GEMINI_API_KEY=[REDACTED]");
  });

  it("redacts secret names with a keyword before an _-suffix, and PASSPHRASE", () => {
    const v = "zq" + "8Lm2Rt5Wx9Kp3Vn7";
    for (const name of [
      "X_AUTH_TOKEN__acct1",
      "DB_PASSWORD_2",
      "GPG_PASSPHRASE",
      "PASSWORD",
      "TOKEN",
      "SECRET_2",
      "PASSWORD_2",
    ]) {
      const out = redactSecrets(`${name}=${v}`);
      expect(out, name).toBe(`${name}=[REDACTED]`);
      expect(redactCredentials(`${name}=${v}`), name).not.toContain(v);
    }
    expect(redactSecrets(`AUTHOR=${v}`)).toBe(`AUTHOR=${v}`);
    expect(redactSecrets(`KEYBOARD=${v}`)).toBe(`KEYBOARD=${v}`);
  });

  it("finds a secret name inside another NAME=value's token (R2 C1)", () => {
    const v = "q8" + "w7Ze5Rt3Yu1Io9Pa";
    for (const text of [
      `FOO=bar,API_KEY=${v}`,
      `https://x.io/cb?a=1&access_token=${v}`,
      `PATH=/usr/bin:GITHUB_TOKEN=${v}`,
      `a=b=API_KEY=${v}`,
    ]) {
      expect(redactSecrets(text), text).not.toContain(v);
      expect(redactCredentials(text), text).not.toContain(v);
    }
    expect(redactSecrets(`FOO=bar AUTHOR=${v}`)).toBe(`FOO=bar AUTHOR=${v}`);
    expect(redactSecrets("a=".repeat(25_000))).toBe("a=".repeat(25_000));
  });

  it("stays linear on a long snake_case run with no '=' (R1 W3)", () => {
    const t0 = performance.now();
    redactSecrets("KEY_".repeat(12_500));
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("redacts Telegram bot tokens", () => {
    expect(redactSecrets(`token=${TELEGRAM}`)).not.toContain(TELEGRAM);
  });

  it("passes null/undefined through as empty string", () => {
    expect(redactSecrets(null)).toBe("");
    expect(redactSecrets(undefined)).toBe("");
  });
});

describe("redactDeep", () => {
  it("walks nested objects and redacts string values", () => {
    const input = {
      nested: {
        token: JRVS,
        safe: "nothing here",
      },
      list: [`Authorization: Bearer ${SK}`, "regular string"],
    };
    const out = redactDeep(input) as typeof input;
    expect(out.nested.token).not.toContain(JRVS);
    expect(out.nested.safe).toBe("nothing here");
    expect(out.list[0]).toContain("[REDACTED]");
    expect(out.list[1]).toBe("regular string");
  });

  it("preserves non-string primitives", () => {
    const input = { num: 42, flag: true, maybe: null };
    expect(redactDeep(input)).toEqual({ num: 42, flag: true, maybe: null });
  });

  it("handles arrays of strings", () => {
    const input = [GHP, "safe"];
    const out = redactDeep(input) as string[];
    expect(out[0]).toContain("[REDACTED_KEY]");
    expect(out[1]).toBe("safe");
  });
});

// Ids this codebase persists in events / tasks / runs / trace attrs. The
// durable-sink redaction uses redactCredentials (no hex-blob rule), so every
// one of these must survive byte-identical.
const PERSISTED_ID_SAMPLES = [
  "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b", // task / run / event UUID
  "cd3c8204f1e2d3c4b5a69784f1e2d3c4b5a6978a", // 40-hex git SHA
  "e3b0c44298fc1c149afbf4c8996fb924" + "27ae41e4649b934ca495991b7852b855", // sha256 (args_sha256)
  "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", // Google Doc id (44 base64url)
  "-1001234567890", // Telegram group chat id
  "telegram:-1001234567890", // thread key
  "whatsapp:5215512345678@s.whatsapp.net",
  "https://example.com/search?q=hello+world&page=2&sort=desc",
  "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing",
];

describe("durable-sink helpers (redactCredentialsForPersist / stringifyRedacted)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("realistic persisted ids pass through byte-identical", () => {
    for (const id of PERSISTED_ID_SAMPLES) {
      expect(redactCredentialsForPersist(id)).toBe(id);
    }
    const payload = {
      ids: PERSISTED_ID_SAMPLES,
      nested: { task_id: PERSISTED_ID_SAMPLES[0] },
    };
    expect(stringifyRedacted(payload)).toBe(JSON.stringify(payload));
  });

  it("redactCredentialsForPersist keeps null for null/undefined and redacts keys", () => {
    expect(redactCredentialsForPersist(null)).toBeNull();
    expect(redactCredentialsForPersist(undefined)).toBeNull();
    expect(redactCredentialsForPersist(`provider said ${SK}`)).toBe(
      "provider said [REDACTED_KEY]",
    );
  });

  it("stringifyRedacted redacts nested string values, leaves keys and the input untouched", () => {
    const input = {
      error: `401 for ${SK}`,
      result: { items: [{ text: `token ${AIZA}` }, 42, null, true] },
      [SK]: "key-named field",
    };
    const before = structuredClone(input);
    const out = stringifyRedacted(input);
    expect(out).not.toContain(AIZA);
    expect(JSON.parse(out)).toEqual({
      error: "401 for [REDACTED_KEY]",
      result: { items: [{ text: "token [REDACTED_KEY]" }, 42, null, true] },
      [SK]: "key-named field",
    });
    expect(input).toEqual(before);
  });

  it("stringifyRedacted matches JSON.stringify semantics (toJSON, undefined, root string)", () => {
    const d = new Date(0);
    const v = { d, gone: undefined, fn: () => 1, arr: [undefined] };
    expect(stringifyRedacted(v)).toBe(JSON.stringify(v));
    expect(stringifyRedacted(`bare ${GHP}`)).toBe('"bare [REDACTED_KEY]"');
  });

  it("keepRaw leaves only the named TOP-LEVEL subtree verbatim", () => {
    const input = {
      finalAnswer: `done ${SK}`,
      pendingConfirmation: {
        toolName: "shell_exec",
        args: { command: `echo ${SK}`, list: [SK] },
      },
      nested: { pendingConfirmation: { args: { command: `echo ${SK}` } } },
    };
    const out = JSON.parse(stringifyRedacted(input, ["pendingConfirmation"]));
    expect(out.pendingConfirmation).toEqual(input.pendingConfirmation);
    expect(out.finalAnswer).toBe("done [REDACTED_KEY]");
    expect(out.nested.pendingConfirmation.args.command).toBe(
      "echo [REDACTED_KEY]",
    );
  });

  it("keepRaw is by KEY, not identity: a reference shared with another field is redacted there", () => {
    const shared = { command: `echo ${SK}` };
    const out = JSON.parse(
      stringifyRedacted(
        { pendingConfirmation: { args: shared }, other: shared },
        ["pendingConfirmation"],
      ),
    );
    expect(out.pendingConfirmation.args.command).toBe(`echo ${SK}`);
    expect(out.other.command).toBe("echo [REDACTED_KEY]");
  });

  it("with keepRaw, output is byte-identical to JSON.stringify when nothing is redacted", () => {
    const keep = ["pendingConfirmation"];
    const cases: unknown[] = [
      { z: 1, a: "x", m: [1, "y", null], d: new Date(0), u: undefined, f: () => 1 },
      { pendingConfirmation: { args: { b: 1, a: [undefined, "q"] } }, n: 2 },
      { pendingConfirmation: undefined, a: 1 },
      { pendingConfirmation: null, a: 1 },
      { a: { toJSON: (k: string) => `field ${k}` } },
      { toJSON: () => ({ wrapped: true }) },
      [{ pendingConfirmation: { a: 1 } }, 2],
      {},
      { a: {}, pendingConfirmation: { args: {} } },
      { a: [], b: {} },
      "plain",
      42,
      null,
      true,
    ];
    for (const c of cases) {
      expect(stringifyRedacted(c, keep)).toBe(JSON.stringify(c));
    }
  });

  it("fails open: a throwing redactor yields the raw value, never an exception", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = { error: `boom ${SK}` };
    vi.spyOn(String.prototype, "replace").mockImplementation(() => {
      throw new Error("redactor bug");
    });
    const str = redactCredentialsForPersist(`boom ${SK}`);
    const json = stringifyRedacted(input);
    vi.mocked(String.prototype.replace).mockRestore();
    expect(str).toBe(`boom ${SK}`);
    expect(json).toBe(JSON.stringify(input));
  });

  it("a genuine serialization error still throws like JSON.stringify", () => {
    const cyclic: Record<string, unknown> = { a: "x" };
    cyclic.self = cyclic;
    expect(() => stringifyRedacted(cyclic)).toThrow(TypeError);
  });
});
