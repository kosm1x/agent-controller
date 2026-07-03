/**
 * X (Twitter) API error classification.
 *
 * The post path receives X's raw error body but historically returned it only as
 * a transient string to the model — logged nowhere, stored nowhere. With no
 * structured, ground-truth failure, the model was free to INVENT a cause: the
 * 2026-06-23 incident shipped "X daily posting limit reached, AuthorizationError
 * code 344" to the operator when the tweet was 213 chars, the cookies were valid,
 * and it was the account's FIRST post attempt that day — code 344 is not even X's
 * daily-limit code (that's 185). See memory `x-posting-brittle-path`.
 *
 * `classifyXError` extracts X's actual error code + verbatim message and maps the
 * known codes to a stable label, so the tool relays facts the model cannot
 * over-write with a guess. Pure (no network) → fully unit-testable.
 *
 * `classifyNoTweetId` covers the sibling gap: a 2xx CreateTweet response that
 * carried NO tweet id AND no error code — `{"data":{"create_tweet":{"tweet_results":{}}}}`.
 * X accepts (200) but silently withholds the tweet. With no code/message the
 * model again got a void and invented a cause (the 2026-06-29 incident: it told
 * the operator "límite diario de la API X, 17 tweets/día en free tier" — pure
 * fabrication; we use cookie GraphQL, not API v2). That void is now the explicit
 * `silent_withhold` label with an honest, verbatim explanation.
 *
 * Codes: https://developer.x.com/en/support/twitter-api/error-troubleshooting
 */

export type XErrorLabel =
  | "auth_expired"
  | "rate_limited"
  | "daily_limit"
  | "too_long"
  | "duplicate"
  | "flagged_automated"
  | "write_restricted"
  | "account_locked"
  | "server_error"
  | "silent_withhold"
  | "unknown";

export interface XErrorInfo {
  /** HTTP status of the response. */
  readonly status: number;
  /** X's first app-level error code, when the body carried one. */
  readonly code?: number;
  /** X's verbatim error message, when present (X's own text — carries no secrets). */
  readonly message?: string;
  /** Stable label for a known code / status; `unknown` otherwise. */
  readonly label: XErrorLabel;
  /** True specifically for cookie-expiry (drives the refresh-cookies guidance). */
  readonly authExpired: boolean;
}

/** Known X app-level error codes → stable label. */
const CODE_LABELS: Readonly<Record<number, XErrorLabel>> = {
  32: "auth_expired", // Could not authenticate you
  89: "auth_expired", // Invalid or expired token
  88: "rate_limited", // Rate limit exceeded
  185: "daily_limit", // User is over daily status update limit (v1.1)
  344: "daily_limit", // AuthorizationError "daily limit for sending Tweets and
  //                     messages" — the GraphQL CreateTweet send-limit/automation
  //                     throttle (verified live 2026-06-23: a low-trust account's
  //                     automated posts get 344 while manual posts still succeed).
  186: "too_long", // Tweet needs to be a bit shorter
  187: "duplicate", // Status is a duplicate
  226: "flagged_automated", // This request looks like it might be automated
  261: "write_restricted", // Application cannot perform write actions
  64: "account_locked", // Your account is suspended
  326: "account_locked", // Account temporarily locked
};

/** Pull X's first error `{code, message}` from a raw response body, defensively. */
function parseXError(raw: string): { code?: number; message?: string } {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const errs = json?.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      const e = errs[0] as Record<string, any>;
      const code =
        typeof e?.code === "number"
          ? e.code
          : typeof e?.extensions?.code === "number"
            ? e.extensions.code
            : undefined;
      const message = typeof e?.message === "string" ? e.message : undefined;
      return { code, message };
    }
  } catch {
    /* not JSON — fall through to regex */
  }
  const m = raw.match(/"code"\s*:\s*(\d+)/);
  return { code: m ? Number(m[1]) : undefined };
}

/**
 * Classify an X failure from its HTTP status + raw body.
 *
 * A recognized non-auth code wins over a 401/403 status (an account suspension —
 * code 64 — is NOT a cookie-expiry, so it must not trigger the refresh-cookies
 * path). A bare 401/403 with no code remains the canonical cookie-expiry signal.
 */
export function classifyXError(status: number, raw: string): XErrorInfo {
  const { code, message } = parseXError(raw);
  const mapped = code !== undefined ? CODE_LABELS[code] : undefined;
  let label: XErrorLabel = mapped ?? "unknown";
  let authExpired = label === "auth_expired";
  if (label === "unknown") {
    if (status === 401 || status === 403) {
      label = "auth_expired";
      authExpired = true;
    } else if (status === 429) {
      label = "rate_limited";
    } else if (status >= 500) {
      label = "server_error";
    }
  }
  return { status, code, message, label, authExpired };
}

/**
 * Classify a 2xx CreateTweet/REST response that returned NO tweet id. Two shapes:
 *  - an `errors[]` / `"code":N` body (a GraphQL rejection delivered at HTTP 200,
 *    e.g. code 344 daily_limit or 187 duplicate) → the normal coded classification.
 *  - `{"data":{"create_tweet":{"tweet_results":{}}}}` — accepted (2xx) but X
 *    returned an EMPTY result with NO code/message: a SILENT withhold (soft
 *    anti-automation throttle or duplicate). X tells us nothing, so map it to the
 *    explicit `silent_withhold` label instead of leaving an `unknown` void the
 *    model fills with a guess.
 */
export function classifyNoTweetId(raw: string, status = 200): XErrorInfo {
  const coded = classifyXError(status, raw);
  if (coded.code !== undefined || coded.message !== undefined) return coded;
  return { status, label: "silent_withhold", authExpired: false };
}

/**
 * Secret-free operational guidance keyed by label. Two uses, both consumed by
 * `describeXError`:
 *  - labels X conveys WITHOUT a message of its own (`silent_withhold`) — so the
 *    model never gets a bare label it can dress up with a guessed cause; and
 *  - labels whose X message is MISLEADING (`daily_limit`'s "try again later"
 *    actually means "not until X's daily clock resets") — the hint supplements
 *    X's verbatim text with the operational reality so the model doesn't act on
 *    the misleading surface reading.
 *
 * Entries are appended by `describeXError` UN-capped (unlike X's message, which is
 * sliced to 240) — so every hint MUST stay a static, secret-free, short literal.
 */
const LABEL_HINTS: Partial<Record<XErrorLabel, string>> = {
  // Written for the LIVE code 344 (GraphQL CreateTweet automation throttle). Code
  // 185 (legacy v1.1) also maps to `daily_limit` but is unreachable here (cookie
  // backend = GraphQL, api backend = v2), so the automation-specific / API-v2
  // framing targets 344; revisit if a v1.1 call path (185) is ever added.
  daily_limit:
    "This is X's automated-post daily send throttle: manual posts from the app " +
    "still succeed, but automated posts get throttled. X says 'try again later', " +
    "but the limit resets on X's own daily clock — do NOT retry the same day " +
    "(each automated retry deepens the flag). The durable fix is account trust/age " +
    "or moving writes to X API v2, not a resend.",
  silent_withhold:
    "X accepted the request (HTTP 2xx) but returned no tweet and no error code — " +
    "the post was silently withheld. Most likely a soft anti-automation/velocity " +
    "throttle or a duplicate of a recent tweet. NOT an auth, rate-limit, or daily-" +
    "limit error. Do NOT retry (retrying deepens the flag); wait for the account to " +
    "cool down, or move writes to X API v2. This is not a fabricated cause.",
};

/** One-line, secret-free human summary, e.g. `403 code 187 (duplicate) — Status is a duplicate.` */
export function describeXError(info: XErrorInfo): string {
  const parts = [`${info.status}`];
  if (info.code !== undefined) parts.push(`code ${info.code}`);
  parts.push(`(${info.label})`);
  if (info.message) parts.push(`— ${info.message.slice(0, 240)}`);
  // Append our operational guidance IN ADDITION to X's message — for labels
  // where X sends no message (silent_withhold) OR where its message is
  // misleading (daily_limit's "try again later" ⇒ retries deepen the throttle).
  // Supplements, never replaces, so the model gets both X's words and the reality.
  if (LABEL_HINTS[info.label]) parts.push(`— ${LABEL_HINTS[info.label]}`);
  return parts.join(" ");
}
