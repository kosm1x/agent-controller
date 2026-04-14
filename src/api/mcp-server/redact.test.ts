/**
 * Tests for the MCP secret-redaction helper.
 */

import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts Authorization: Bearer headers", () => {
    expect(
      redactSecrets("Authorization: Bearer sk-abcdefghijklmnop1234567890ABCD"),
    ).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts Authorization: Basic headers", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [REDACTED]",
    );
  });

  it("redacts sk- prefixed API keys", () => {
    const input = "My key is sk-proj-abcdefghijklmnop1234567890ABCD in logs";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-proj-abcdefghijklmnop1234567890ABCD");
    expect(out).toContain("[REDACTED_KEY]");
  });

  it("redacts ghp_ / gho_ / glpat- tokens", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstu")).toContain(
      "[REDACTED_KEY]",
    );
    expect(redactSecrets("gho_0123456789abcdefghijk")).toContain(
      "[REDACTED_KEY]",
    );
    expect(redactSecrets("glpat-abcdefghijklmnop")).toContain("[REDACTED_KEY]");
  });

  it("redacts jrvs_ bearer tokens", () => {
    const token = "jrvs_" + "a".repeat(64);
    expect(redactSecrets(`the token is ${token}`)).not.toContain(token);
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

  it("passes null/undefined through as empty string", () => {
    expect(redactSecrets(null)).toBe("");
    expect(redactSecrets(undefined)).toBe("");
  });
});

describe("redactDeep", () => {
  it("walks nested objects and redacts string values", () => {
    const input = {
      nested: {
        token: "jrvs_" + "a".repeat(64),
        safe: "nothing here",
      },
      list: [
        "Authorization: Bearer sk-abcdefghijklmnop1234567890ABCD",
        "regular string",
      ],
    };
    const out = redactDeep(input) as typeof input;
    expect(out.nested.token).not.toContain("jrvs_aaaa");
    expect(out.nested.safe).toBe("nothing here");
    expect(out.list[0]).toContain("[REDACTED]");
    expect(out.list[1]).toBe("regular string");
  });

  it("preserves non-string primitives", () => {
    const input = { num: 42, flag: true, maybe: null };
    expect(redactDeep(input)).toEqual({ num: 42, flag: true, maybe: null });
  });

  it("handles arrays of strings", () => {
    const input = ["ghp_abcdefghijklmnopqrstu", "safe"];
    const out = redactDeep(input) as string[];
    expect(out[0]).toContain("[REDACTED_KEY]");
    expect(out[1]).toBe("safe");
  });
});
