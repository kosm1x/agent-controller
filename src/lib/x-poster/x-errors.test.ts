import { describe, it, expect } from "vitest";
import { classifyXError, describeXError } from "./x-errors.js";

/** A minimal X GraphQL/REST error body for a given code+message. */
const body = (code: number, message: string) =>
  JSON.stringify({ errors: [{ code, message }] });

describe("classifyXError — known codes map to stable labels", () => {
  it("88 → rate_limited", () => {
    const i = classifyXError(429, body(88, "Rate limit exceeded"));
    expect(i.label).toBe("rate_limited");
    expect(i.code).toBe(88);
    expect(i.authExpired).toBe(false);
  });

  it("185 → daily_limit (the REAL daily-limit code — not 344)", () => {
    const i = classifyXError(
      403,
      body(185, "User is over daily status update limit"),
    );
    expect(i.label).toBe("daily_limit");
    expect(i.code).toBe(185);
  });

  it("186 → too_long", () => {
    expect(
      classifyXError(403, body(186, "Tweet needs to be shorter")).label,
    ).toBe("too_long");
  });

  it("187 → duplicate (a 403/duplicate is NOT auth-expiry)", () => {
    const i = classifyXError(403, body(187, "Status is a duplicate."));
    expect(i.label).toBe("duplicate");
    expect(i.authExpired).toBe(false);
  });

  it("261 → write_restricted", () => {
    expect(
      classifyXError(403, body(261, "Application cannot perform write actions"))
        .label,
    ).toBe("write_restricted");
  });

  it("64/326 → account_locked, and NOT treated as cookie-expiry even on 403", () => {
    const suspended = classifyXError(
      403,
      body(64, "Your account is suspended"),
    );
    expect(suspended.label).toBe("account_locked");
    expect(suspended.authExpired).toBe(false); // suspension ≠ rotate cookies
    expect(classifyXError(403, body(326, "temporarily locked")).label).toBe(
      "account_locked",
    );
  });

  it("32/89 → auth_expired regardless of status", () => {
    expect(
      classifyXError(200, body(89, "Invalid or expired token")).authExpired,
    ).toBe(true);
    expect(
      classifyXError(400, body(32, "Could not authenticate you")).label,
    ).toBe("auth_expired");
  });
});

describe("classifyXError — status fallbacks when no code", () => {
  it("bare 401/403 → auth_expired (the canonical cookie-expiry signal)", () => {
    expect(classifyXError(401, "").authExpired).toBe(true);
    expect(classifyXError(403, "Forbidden").label).toBe("auth_expired");
  });

  it("429 with no parseable code → rate_limited", () => {
    expect(classifyXError(429, "Too Many Requests").label).toBe("rate_limited");
  });

  it("5xx → server_error", () => {
    expect(classifyXError(503, "upstream").label).toBe("server_error");
  });

  it("an UNKNOWN code (e.g. 344) surfaces verbatim, never invents a meaning", () => {
    // The 2026-06-23 confabulation: 344 was reported as "daily limit". It must
    // come back as code 344 / unknown with X's real message, not a guess.
    const i = classifyXError(400, body(344, "Some X-specific condition"));
    expect(i.code).toBe(344);
    expect(i.label).toBe("unknown");
    expect(i.message).toBe("Some X-specific condition");
    expect(i.authExpired).toBe(false);
  });
});

describe("classifyXError — robust parsing", () => {
  it("reads a GraphQL extensions.code shape", () => {
    const raw = JSON.stringify({
      errors: [{ message: "dup", extensions: { code: 187 } }],
    });
    expect(classifyXError(403, raw).label).toBe("duplicate");
  });

  it("falls back to a regex when the body is not clean JSON", () => {
    expect(classifyXError(403, 'garbage "code": 187 trailing').code).toBe(187);
  });

  it("tolerates an empty / non-JSON body without throwing", () => {
    expect(classifyXError(400, "").label).toBe("unknown");
    expect(classifyXError(400, "<html>500</html>").code).toBeUndefined();
  });

  it('regex fallback grabs the FIRST "code":N on a non-JSON body (documented best-effort)', () => {
    // W1: the last-resort regex is unscoped — locked here so a future change to
    // make it stricter is deliberate. X returns clean JSON in practice, so this
    // path is near-never reached.
    expect(classifyXError(400, 'noise "code": 187 then "code": 88').code).toBe(
      187,
    );
  });
});

describe("describeXError", () => {
  it("renders a one-line, secret-free summary with code + label + message", () => {
    const i = classifyXError(403, body(187, "Status is a duplicate."));
    expect(describeXError(i)).toBe(
      "403 code 187 (duplicate) — Status is a duplicate.",
    );
  });

  it("omits code when absent", () => {
    expect(describeXError(classifyXError(401, ""))).toBe("401 (auth_expired)");
  });

  it("caps an over-long X message (W2 — bounded model-facing error)", () => {
    const long = "x".repeat(500);
    const out = describeXError(classifyXError(400, body(999, long)));
    expect(out.length).toBeLessThan(300); // status+code+label+240-char message
    expect(out).toContain("x".repeat(240));
    expect(out).not.toContain("x".repeat(241));
  });
});
