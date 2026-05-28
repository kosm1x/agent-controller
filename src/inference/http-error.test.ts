import { afterEach, describe, expect, it } from "vitest";
import {
  HttpError,
  formatRateLimitLog,
  parseRateLimitHeaders,
  resolveRetryDelay,
  DEFAULT_MAX_RETRY_AFTER_MS,
} from "./http-error.js";

const FIXED_NOW = Date.parse("2026-05-22T23:00:00Z");

function h(entries: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(entries)) headers.set(k, v);
  return headers;
}

describe("parseRateLimitHeaders", () => {
  it("returns empty info when no relevant headers are present", () => {
    const info = parseRateLimitHeaders(
      h({ "content-type": "application/json" }),
    );
    expect(info).toEqual({
      remainingRequests: undefined,
      remainingTokens: undefined,
      limitRequests: undefined,
      limitTokens: undefined,
      resetRequestsMs: undefined,
      resetTokensMs: undefined,
    });
    expect(info.retryAfterMs).toBeUndefined();
  });

  it("parses Retry-After as integer seconds → ms", () => {
    const info = parseRateLimitHeaders(h({ "retry-after": "30" }), FIXED_NOW);
    expect(info.retryAfterMs).toBe(30_000);
  });

  it("parses Retry-After as HTTP-date relative to now", () => {
    // 45s in the future from FIXED_NOW
    const future = new Date(FIXED_NOW + 45_000).toUTCString();
    const info = parseRateLimitHeaders(h({ "retry-after": future }), FIXED_NOW);
    expect(info.retryAfterMs).toBe(45_000);
  });

  it("clamps a past Retry-After date to 0 instead of going negative", () => {
    const past = new Date(FIXED_NOW - 60_000).toUTCString();
    const info = parseRateLimitHeaders(h({ "retry-after": past }), FIXED_NOW);
    expect(info.retryAfterMs).toBe(0);
  });

  it("parses OpenAI-style x-ratelimit-* numeric headers", () => {
    const info = parseRateLimitHeaders(
      h({
        "x-ratelimit-remaining-requests": "12",
        "x-ratelimit-remaining-tokens": "9876",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-limit-tokens": "50000",
      }),
      FIXED_NOW,
    );
    expect(info.remainingRequests).toBe(12);
    expect(info.remainingTokens).toBe(9876);
    expect(info.limitRequests).toBe(100);
    expect(info.limitTokens).toBe(50000);
  });

  it("parses Anthropic-style anthropic-ratelimit-*-remaining/limit headers", () => {
    const info = parseRateLimitHeaders(
      h({
        "anthropic-ratelimit-requests-remaining": "5",
        "anthropic-ratelimit-tokens-remaining": "1234",
        "anthropic-ratelimit-requests-limit": "60",
        "anthropic-ratelimit-tokens-limit": "20000",
      }),
      FIXED_NOW,
    );
    expect(info.remainingRequests).toBe(5);
    expect(info.remainingTokens).toBe(1234);
    expect(info.limitRequests).toBe(60);
    expect(info.limitTokens).toBe(20000);
  });

  it("parses ISO reset timestamps to absolute ms-since-epoch", () => {
    const iso = "2026-05-22T23:01:00Z";
    const info = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": iso }),
      FIXED_NOW,
    );
    expect(info.resetRequestsMs).toBe(Date.parse(iso));
  });

  it('parses "Ns" seconds-until-reset to absolute ms', () => {
    const info = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-tokens": "20s" }),
      FIXED_NOW,
    );
    expect(info.resetTokensMs).toBe(FIXED_NOW + 20_000);
  });

  it("returns undefined for unparseable reset strings without throwing", () => {
    const info = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "1h30m" }),
      FIXED_NOW,
    );
    expect(info.resetRequestsMs).toBeUndefined();
  });

  it("drops non-numeric counts silently (no NaN leakage)", () => {
    const info = parseRateLimitHeaders(
      h({ "x-ratelimit-remaining-requests": "n/a" }),
      FIXED_NOW,
    );
    expect(info.remainingRequests).toBeUndefined();
  });

  it("clamps a negative integer Retry-After to 0 (audit W1)", () => {
    // A buggy upstream sending `Retry-After: -5` must not yield a negative
    // delay that fires setTimeout immediately or wraps in arithmetic.
    const info = parseRateLimitHeaders(h({ "retry-after": "-5" }), FIXED_NOW);
    expect(info.retryAfterMs).toBe(0);
  });

  it("rejects integer-overflow counts that exceed safe-integer range (audit W2)", () => {
    const info = parseRateLimitHeaders(
      h({ "x-ratelimit-remaining-tokens": "999999999999999999" }),
      FIXED_NOW,
    );
    expect(info.remainingTokens).toBeUndefined();
  });
});

describe("HttpError", () => {
  it("preserves status, body snippet, and rateLimit on the instance", () => {
    const rl = { retryAfterMs: 5000, remainingRequests: 0 };
    const err = new HttpError(429, "Rate limited", rl);
    expect(err.status).toBe(429);
    expect(err.bodySnippet).toBe("Rate limited");
    expect(err.rateLimit).toBe(rl);
    expect(err.name).toBe("HttpError");
  });

  it("formats the message compatibly with the legacy /HTTP (\\d+)/ regex", () => {
    const err = new HttpError(503, "service down", {});
    expect(err.message).toBe("HTTP 503: service down");
    const match = err.message.match(/HTTP (\d+)/);
    expect(match?.[1]).toBe("503");
  });

  it("is catchable as both Error and HttpError", () => {
    const err = new HttpError(429, "", {});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
  });
});

describe("formatRateLimitLog", () => {
  it("emits only the keys that are present (no undefined noise)", () => {
    const line = formatRateLimitLog("anthropic", 429, {
      retryAfterMs: 5000,
      remainingRequests: 0,
    });
    expect(line).toBe(
      "[inference] rate_limit_hit provider=anthropic status=429 retryAfterMs=5000 remainingReq=0",
    );
  });

  it("includes all parsed fields when they exist", () => {
    const line = formatRateLimitLog("fireworks", 429, {
      retryAfterMs: 1000,
      remainingRequests: 1,
      remainingTokens: 200,
      limitRequests: 60,
      limitTokens: 8000,
      resetRequestsMs: 1_700_000_000_000,
      resetTokensMs: 1_700_000_001_000,
    });
    expect(line).toContain("provider=fireworks");
    expect(line).toContain("status=429");
    expect(line).toContain("retryAfterMs=1000");
    expect(line).toContain("remainingReq=1");
    expect(line).toContain("remainingTok=200");
    expect(line).toContain("limitReq=60");
    expect(line).toContain("limitTok=8000");
    expect(line).toContain("resetReqMs=1700000000000");
    expect(line).toContain("resetTokMs=1700000001000");
  });

  it("emits the bare prefix when rateLimit info is empty", () => {
    const line = formatRateLimitLog("groq", 429, {});
    expect(line).toBe("[inference] rate_limit_hit provider=groq status=429");
  });

  it("emits remainingReq=0 rather than dropping the key", () => {
    // 0 is the most operationally interesting value — must not be dropped as falsy
    const line = formatRateLimitLog("anthropic", 429, { remainingRequests: 0 });
    expect(line).toContain("remainingReq=0");
  });
});

describe("resolveRetryDelay — honors Retry-After hint over exp-backoff", () => {
  const originalEnv = process.env.MC_RETRY_AFTER_MAX_MS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MC_RETRY_AFTER_MAX_MS;
    else process.env.MC_RETRY_AFTER_MAX_MS = originalEnv;
  });

  it("uses retry-after when present and within cap", () => {
    const r = resolveRetryDelay({ retryAfterMs: 2_000 }, 4_000);
    expect(r).toEqual({ delayMs: 2_000, source: "retry-after" });
  });

  it("uses retry-after even when it is shorter than exp-backoff (server knows better)", () => {
    const r = resolveRetryDelay({ retryAfterMs: 250 }, 8_000);
    expect(r).toEqual({ delayMs: 250, source: "retry-after" });
  });

  it("respects retry-after=0 (server says retry immediately)", () => {
    const r = resolveRetryDelay({ retryAfterMs: 0 }, 4_000);
    expect(r).toEqual({ delayMs: 0, source: "retry-after" });
  });

  it("caps a long retry-after at the default ceiling", () => {
    const r = resolveRetryDelay({ retryAfterMs: 3_600_000 }, 4_000); // 1h
    expect(r).toEqual({
      delayMs: DEFAULT_MAX_RETRY_AFTER_MS,
      source: "retry-after",
    });
  });

  it("falls back to exp-backoff when retry-after is absent", () => {
    const r = resolveRetryDelay({}, 4_000);
    expect(r).toEqual({ delayMs: 4_000, source: "exp-backoff" });
  });

  it("falls back to exp-backoff for other rate-limit info without retryAfterMs", () => {
    const r = resolveRetryDelay(
      { remainingRequests: 0, limitRequests: 100 },
      8_000,
    );
    expect(r).toEqual({ delayMs: 8_000, source: "exp-backoff" });
  });

  it("honors MC_RETRY_AFTER_MAX_MS env override", () => {
    process.env.MC_RETRY_AFTER_MAX_MS = "5000";
    const r = resolveRetryDelay({ retryAfterMs: 60_000 }, 8_000);
    expect(r).toEqual({ delayMs: 5_000, source: "retry-after" });
  });

  it("treats invalid MC_RETRY_AFTER_MAX_MS as the default ceiling", () => {
    process.env.MC_RETRY_AFTER_MAX_MS = "not-a-number";
    const r = resolveRetryDelay({ retryAfterMs: 60_000 }, 8_000);
    expect(r).toEqual({
      delayMs: DEFAULT_MAX_RETRY_AFTER_MS,
      source: "retry-after",
    });
  });

  it("treats negative env override as the default ceiling (defensive)", () => {
    process.env.MC_RETRY_AFTER_MAX_MS = "-1000";
    const r = resolveRetryDelay({ retryAfterMs: 60_000 }, 8_000);
    expect(r).toEqual({
      delayMs: DEFAULT_MAX_RETRY_AFTER_MS,
      source: "retry-after",
    });
  });

  it("clamps a typoed huge env override at ABSOLUTE_MAX_RETRY_AFTER_MS (10min)", () => {
    // Operator typos `MC_RETRY_AFTER_MAX_MS=999999999` (16 minutes 39s).
    // Defensive clamp prevents the env from raising the ceiling above 10min.
    process.env.MC_RETRY_AFTER_MAX_MS = "999999999";
    const r = resolveRetryDelay({ retryAfterMs: 3_600_000_000 }, 8_000);
    expect(r.source).toBe("retry-after");
    expect(r.delayMs).toBe(600_000); // ABSOLUTE_MAX, 10min
  });

  it("ignores a non-finite retry-after (defensive against parser regressions)", () => {
    const r = resolveRetryDelay(
      { retryAfterMs: Number.NaN as unknown as number },
      4_000,
    );
    expect(r).toEqual({ delayMs: 4_000, source: "exp-backoff" });
  });
});
