/**
 * Tests for the MCP secret-redaction helper.
 *
 * NOTE: every fake-secret fixture below is ASSEMBLED FROM FRAGMENTS (e.g.
 * `"sk-" + "proj-..."`). The runtime value is a normal recognizable secret
 * shape — that's what the redactor must catch — but no contiguous secret
 * PREFIX appears in the source text, so pre-commit secret scanners
 * (git-secret-guard) don't flag this test's own inputs as leaked keys.
 */

import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "./redact.js";

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
