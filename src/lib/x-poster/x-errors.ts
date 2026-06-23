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
  185: "daily_limit", // User is over daily status update limit
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

/** One-line, secret-free human summary, e.g. `403 code 187 (duplicate) — Status is a duplicate.` */
export function describeXError(info: XErrorInfo): string {
  const parts = [`${info.status}`];
  if (info.code !== undefined) parts.push(`code ${info.code}`);
  parts.push(`(${info.label})`);
  if (info.message) parts.push(`— ${info.message.slice(0, 240)}`);
  return parts.join(" ");
}
