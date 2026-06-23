/**
 * X (Twitter) posting — backend-router types.
 *
 * Jarvis historically had NO native X tool: every tweet was an ad-hoc Playwright
 * script with hardcoded `auth_token`/`ct0` cookies via shell_exec, breaking ~every
 * 30 days when cookies expired (see memory `x-posting-brittle-path`). This module
 * centralizes that brittleness behind ONE router with multiple backends and a
 * health probe, so cookie expiry is detected PROACTIVELY instead of mid-thread.
 *
 * Pattern borrowed from the Agent-Reach `doctor` design (primary+fallback backend
 * per external dependency + a probe), adopted as a pattern — not the repo.
 */

/** Result of a non-mutating auth/health check (does NOT post anything). */
export interface ProbeResult {
  /** Backend identity (`cookie` | `api`). */
  readonly backend: string;
  /** True if the backend is currently authenticated and able to post. */
  readonly ok: boolean;
  /** Human-readable detail (e.g. "200 verify_credentials", "401 expired"). */
  readonly detail: string;
  /** True specifically when auth is expired/invalid (the recurring failure). */
  readonly authExpired: boolean;
}

/** Result of a post attempt. */
export interface PostResult {
  readonly backend: string;
  readonly ok: boolean;
  /** Posted tweet id when `ok`. */
  readonly tweetId?: string;
  /** Error detail when not `ok`. */
  readonly error?: string;
  /** True when the failure was auth-expiry (drives the refresh-cookies guidance). */
  readonly authExpired?: boolean;
}

/** A single way of posting to / probing X. Ordered behind the router. */
export interface XBackend {
  /** Stable identity, e.g. `cookie` or `api`. */
  readonly name: string;
  /** True when the backend has the credentials it needs (else router skips it). */
  isConfigured(): boolean;
  /** Auth/health check WITHOUT composing a tweet. */
  probe(): Promise<ProbeResult>;
  /** Post a tweet; `replyToId` threads it under an existing tweet. */
  post(text: string, replyToId?: string): Promise<PostResult>;
}

/** Aggregate outcome of probing every configured backend. */
export interface RouterProbe {
  /** Healthy when at least one configured backend probed `ok`. */
  readonly healthy: boolean;
  /** True when NO backend is configured at all. */
  readonly unconfigured: boolean;
  readonly results: readonly ProbeResult[];
}

/** Aggregate outcome of a routed post (after trying backends in order). */
export interface RouterPost {
  readonly ok: boolean;
  readonly backend?: string;
  readonly tweetId?: string;
  /** True when every configured backend failed with auth-expiry. */
  readonly allAuthExpired: boolean;
  /** True when no backend was configured. */
  readonly unconfigured: boolean;
  readonly attempts: readonly PostResult[];
}
