/**
 * HTTP error subclass that carries the response status, a body snippet, and
 * the parsed rate-limit headers. Thrown from the inference adapter's fetch
 * sites so the retry/circuit-breaker layer can log structured 429 telemetry
 * (`feedback_prometheus_upstream` April Tier-1 #1).
 *
 * **Log-only at the moment.** The catch block records `retry-after` and
 * `x-ratelimit-*` for visibility but does NOT change retry timing — our
 * exponential backoff is unchanged. Honoring `retry-after` over the exp
 * curve is a separate behavioral change that needs its own justification
 * (server hints can be very long; interactive tasks would feel it).
 */
export interface RateLimitInfo {
  /** `Retry-After` parsed to milliseconds. Seconds-int and HTTP-date both supported. */
  retryAfterMs?: number;
  /** Remaining requests budget (provider-specific header). */
  remainingRequests?: number;
  /** Remaining tokens budget (provider-specific header). */
  remainingTokens?: number;
  /** Limit-requests (provider-specific header). */
  limitRequests?: number;
  /** Limit-tokens (provider-specific header). */
  limitTokens?: number;
  /** Reset timestamp for requests budget, milliseconds since epoch when parseable. */
  resetRequestsMs?: number;
  /** Reset timestamp for tokens budget, milliseconds since epoch when parseable. */
  resetTokensMs?: number;
}

/**
 * Parse the rate-limit-relevant headers from a fetch Response.
 *
 * Handles three header conventions:
 *  - `retry-after` (RFC 7231 — seconds OR HTTP date)
 *  - `x-ratelimit-*` (OpenAI / OpenRouter / Fireworks / Groq)
 *  - `anthropic-ratelimit-*` (Anthropic)
 *
 * Reset headers may arrive as ISO-8601, RFC 1123 date, seconds-until-reset,
 * or unix-seconds. We accept all four. Anything unparseable is dropped.
 */
export function parseRateLimitHeaders(
  headers: Headers,
  now: number = Date.now(),
): RateLimitInfo {
  const info: RateLimitInfo = {};
  const raw = (...names: string[]): string | null => {
    for (const n of names) {
      const v = headers.get(n);
      if (v !== null && v !== "") return v;
    }
    return null;
  };
  const toInt = (v: string | null): number | undefined => {
    if (v === null) return undefined;
    const n = Number.parseInt(v, 10);
    // isSafeInteger rejects NaN, Infinity, and >2^53 values that would silently
    // round on arithmetic — see audit W2. We've never seen rate-limit headers
    // exceed safe-integer range in practice, but parsing should fail-closed.
    return Number.isSafeInteger(n) ? n : undefined;
  };

  const retryAfter = raw("retry-after");
  if (retryAfter !== null) {
    const asSec = Number.parseInt(retryAfter, 10);
    if (Number.isSafeInteger(asSec) && String(asSec) === retryAfter.trim()) {
      // Symmetric clamping with the HTTP-date branch below — a negative
      // `Retry-After: -5` should be treated as "retry immediately", not as
      // -5000ms (audit W1). Currently log-only impact, but pre-empts a
      // setTimeout foot-gun when the deferred behavioral ship lands.
      info.retryAfterMs = Math.max(0, asSec * 1000);
    } else {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        info.retryAfterMs = Math.max(0, dateMs - now);
      }
    }
  }

  info.remainingRequests = toInt(
    raw(
      "x-ratelimit-remaining-requests",
      "anthropic-ratelimit-requests-remaining",
    ),
  );
  info.remainingTokens = toInt(
    raw("x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"),
  );
  info.limitRequests = toInt(
    raw("x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"),
  );
  info.limitTokens = toInt(
    raw("x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"),
  );

  const parseReset = (v: string | null): number | undefined => {
    if (v === null) return undefined;
    // ISO-8601 or RFC 1123 absolute time
    const dateMs = Date.parse(v);
    if (Number.isFinite(dateMs)) return dateMs;
    // Otherwise integer seconds — OpenAI uses "Xs" or just "X" (seconds-until-reset),
    // Anthropic uses ISO date (caught above). "5m30s" / "1h" patterns fall through unparsed.
    const trimmed = v.trim();
    if (/^\d+s?$/.test(trimmed)) {
      const sec = Number.parseInt(trimmed, 10);
      return now + sec * 1000;
    }
    return undefined;
  };
  info.resetRequestsMs = parseReset(
    raw("x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset"),
  );
  info.resetTokensMs = parseReset(
    raw("x-ratelimit-reset-tokens", "anthropic-ratelimit-tokens-reset"),
  );

  return info;
}

/**
 * Error thrown when a provider returns a non-OK HTTP status. Preserves the
 * status code, a body snippet, and parsed rate-limit headers so callers can
 * route on 429/5xx and log structured telemetry. Message format is kept
 * compatible with the previous plain-Error path (`HTTP <status>: <body>`) so
 * existing string-match callers (`adapter.ts:953` `/HTTP (\d+)/`) keep working.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly rateLimit: RateLimitInfo;

  constructor(status: number, bodySnippet: string, rateLimit: RateLimitInfo) {
    super(`HTTP ${status}: ${bodySnippet}`);
    this.name = "HttpError";
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.rateLimit = rateLimit;
  }
}

/**
 * Format a rate-limit hit as a single structured log line. Compact key=value
 * shape so journalctl `| grep rate_limit_hit` parses cleanly. Only emits keys
 * that are present — no `undefined`/`null` noise.
 */
export function formatRateLimitLog(
  provider: string,
  status: number,
  info: RateLimitInfo,
): string {
  const parts: string[] = [
    `[inference] rate_limit_hit`,
    `provider=${provider}`,
    `status=${status}`,
  ];
  if (info.retryAfterMs !== undefined)
    parts.push(`retryAfterMs=${info.retryAfterMs}`);
  if (info.remainingRequests !== undefined)
    parts.push(`remainingReq=${info.remainingRequests}`);
  if (info.remainingTokens !== undefined)
    parts.push(`remainingTok=${info.remainingTokens}`);
  if (info.limitRequests !== undefined)
    parts.push(`limitReq=${info.limitRequests}`);
  if (info.limitTokens !== undefined)
    parts.push(`limitTok=${info.limitTokens}`);
  if (info.resetRequestsMs !== undefined)
    parts.push(`resetReqMs=${info.resetRequestsMs}`);
  if (info.resetTokensMs !== undefined)
    parts.push(`resetTokMs=${info.resetTokensMs}`);
  return parts.join(" ");
}
