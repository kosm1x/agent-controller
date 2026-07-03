import { describe, it, expect } from "vitest";
import {
  classifyXError,
  classifyNoTweetId,
  describeXError,
} from "./x-errors.js";

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

  it("344 → daily_limit (X's GraphQL CreateTweet send-limit; verified live 2026-06-23)", () => {
    // Ground truth captured from a live @iooking4ward post:
    // {code:344, name:"AuthorizationError", kind:"Permissions",
    //  message:"...you have reached your daily limit for sending Tweets..."}
    const i = classifyXError(
      200,
      body(
        344,
        "Authorization: You have reached your daily limit for sending Tweets and messages. Please try again later. (344)",
      ),
    );
    expect(i.code).toBe(344);
    expect(i.label).toBe("daily_limit");
    expect(i.authExpired).toBe(false);
    expect(i.message).toContain("daily limit");
  });

  it("a genuinely unknown code surfaces VERBATIM, never invents a meaning", () => {
    const i = classifyXError(400, body(99999, "Some new X-specific condition"));
    expect(i.code).toBe(99999);
    expect(i.label).toBe("unknown");
    expect(i.message).toBe("Some new X-specific condition");
    expect(i.authExpired).toBe(false);
  });
});

describe("classifyXError — robust parsing", () => {
  it("classifies a GraphQL error returned at HTTP 200 (CreateTweet rejection) from the BODY, not the status", () => {
    // CreateTweet is GraphQL: a rejected tweet comes back as HTTP 200 with an
    // errors[] body (the @iooking4ward block, 2026-06-23). Status is 200 but the
    // code/message in the body must still drive the label.
    const flagged = JSON.stringify({
      errors: [
        {
          code: 226,
          message: "This request looks like it might be automated.",
        },
      ],
    });
    const i = classifyXError(200, flagged);
    expect(i.code).toBe(226);
    expect(i.label).toBe("flagged_automated");
    expect(i.message).toContain("automated");
  });

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

describe("classifyNoTweetId — 2xx accepted but no tweet returned", () => {
  // The EXACT body X returned for @mexiconecesario on 2026-06-29 (silent withhold).
  const EMPTY = '{"data":{"create_tweet":{"tweet_results":{}}}}';

  it("empty tweet_results + no error code → silent_withhold (NOT unknown)", () => {
    const i = classifyNoTweetId(EMPTY);
    expect(i.label).toBe("silent_withhold");
    expect(i.code).toBeUndefined();
    expect(i.message).toBeUndefined();
    expect(i.authExpired).toBe(false);
  });

  it("a coded GraphQL-200 rejection is NOT masked as silent_withhold (344 still daily_limit)", () => {
    const i = classifyNoTweetId(
      JSON.stringify({
        errors: [{ code: 344, message: "daily limit for sending Tweets" }],
      }),
    );
    expect(i.label).toBe("daily_limit");
    expect(i.code).toBe(344);
  });

  it("a 200-body duplicate (187) still surfaces as duplicate, not silent_withhold", () => {
    expect(
      classifyNoTweetId(
        JSON.stringify({ errors: [{ code: 187, message: "duplicate" }] }),
      ).label,
    ).toBe("duplicate");
  });

  it("empty / garbage body → silent_withhold without throwing", () => {
    expect(classifyNoTweetId("").label).toBe("silent_withhold");
    expect(classifyNoTweetId("<html>").label).toBe("silent_withhold");
  });

  it("carries the response status through (api 201 path)", () => {
    expect(classifyNoTweetId(EMPTY, 201).status).toBe(201);
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

  it("silent_withhold (no X message) gets an honest explanatory hint, not a bare label", () => {
    const out = describeXError(
      classifyNoTweetId('{"data":{"create_tweet":{"tweet_results":{}}}}'),
    );
    expect(out).toMatch(/^200 \(silent_withhold\) —/);
    expect(out).toContain("silently withheld");
    expect(out).toContain("Do NOT retry");
    expect(out).not.toContain("daily limit"); // must not imply a fabricated cause
  });

  it("daily_limit (344) appends the don't-retry hint ALONGSIDE X's verbatim message", () => {
    // The 2026-07-02 @mexiconecesario failure: X sends a real "try again later"
    // message that INVITES a retry. The hint must ride ALONGSIDE X's words (not
    // replace them) so the model gets both the verbatim text and the operational
    // reality — X's daily automation throttle does NOT reset on a same-day resend.
    const out = describeXError(
      classifyXError(
        200,
        body(
          344,
          "Authorization: You have reached your daily limit for sending Tweets and messages. Please try again later. (344)",
        ),
      ),
    );
    expect(out).toContain("code 344");
    expect(out).toContain("daily limit for sending Tweets"); // X's verbatim message kept
    expect(out).toContain("do NOT retry the same day"); // our hint appended too
    expect(out).toContain("X API v2");
    // X's message first, our hint after — supplements, never replaces.
    expect(out.indexOf("daily limit for sending")).toBeLessThan(
      out.indexOf("do NOT retry"),
    );
  });

  it("a hint-less label still renders bare (no spurious suffix)", () => {
    // auth_expired has no hint → unchanged output (regression guard).
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
