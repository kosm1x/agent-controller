/**
 * X-poster configuration — multi-account, all read directly from `process.env`
 * (NOT the cached `getConfig()`), mirroring `isV82ProducerEnabled()` so the
 * operator can arm/rotate with an env edit + restart and tests can toggle.
 *
 * Centralizes ALL X brittleness in one place: per-account cookies, the rotating
 * CreateTweet queryId, and the public web bearer — instead of being hardcoded
 * across `/tmp/*.cjs` scripts and `user_facts`.
 *
 * Accounts: discovered from `X_AUTH_TOKEN__<handle>` / `X_CT0__<handle>` pairs
 * (e.g. `X_AUTH_TOKEN__lookin4ward`). `X_DEFAULT_ACCOUNT` names the one used when
 * a tool call omits `account`. For migration ease, a bare `X_AUTH_TOKEN`/`X_CT0`
 * pair (no handle) is treated as the default account's cookies if no explicit
 * `X_AUTH_TOKEN__<default>` is set.
 */

/**
 * Public X web-client bearer token — a well-known PUBLIC constant shipped in
 * x.com's JS bundle (not a secret). Global (same for every account). Override
 * via `X_BEARER` if X rotates it.
 */
const DEFAULT_PUBLIC_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/** Per-account credentials (the only per-account secrets). */
export interface AccountCreds {
  readonly handle: string;
  readonly authToken?: string;
  readonly ct0?: string;
  readonly apiBearer?: string;
}

/** Global (account-independent) X settings. */
export interface XGlobals {
  readonly bearer: string;
  /** GraphQL CreateTweet query id. X rotates it; bump `X_CREATETWEET_QUERY_ID`. */
  readonly createTweetQueryId: string;
}

export function getXGlobals(): XGlobals {
  return {
    bearer: nonEmpty(process.env.X_BEARER) ?? DEFAULT_PUBLIC_BEARER,
    createTweetQueryId:
      nonEmpty(process.env.X_CREATETWEET_QUERY_ID) ?? "a1p9RWpkYKBjWv_I3WzS-A",
  };
}

/**
 * Read-only authenticated endpoint used by `probe()` to detect cookie expiry
 * WITHOUT posting. `badge_count` is what the web client polls — 200 on a live
 * session, 401/403 when cookies expire. X retired the old v1.1 endpoints, so
 * this is env-overridable (`X_PROBE_URL`) to survive the next API move without
 * a code change.
 */
export function getProbeUrl(): string {
  return (
    nonEmpty(process.env.X_PROBE_URL) ??
    "https://x.com/i/api/2/badge_count/badge_count.json?supports_ntab_urt=1"
  );
}

const ACCT_TOKEN_RE = /^X_AUTH_TOKEN__(.+)$/;

/** Synthetic handle for a bare `X_AUTH_TOKEN`/`X_CT0` pair with no `X_DEFAULT_ACCOUNT`. */
const BARE_ACCOUNT = "default";

/** Normalize a handle for matching/labels: lowercase, strip a leading '@'. */
export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "").toLowerCase();
}

/** The default account name (`X_DEFAULT_ACCOUNT`, else the sole discovered one). */
export function getDefaultAccount(): string | undefined {
  const explicit = nonEmpty(process.env.X_DEFAULT_ACCOUNT);
  if (explicit) return normalizeHandle(explicit);
  // A bare X_AUTH_TOKEN with no explicit default → the synthetic "default" account
  // (so a migrating operator's bare pair works + is discoverable, not silently invisible).
  if (nonEmpty(process.env.X_AUTH_TOKEN)) return BARE_ACCOUNT;
  const all = listXAccounts();
  return all.length === 1 ? all[0] : undefined;
}

/** All configured account handles (those with a non-empty auth_token). */
export function listXAccounts(): string[] {
  const handles = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(ACCT_TOKEN_RE);
    if (m && nonEmpty(process.env[key])) handles.add(normalizeHandle(m[1]));
  }
  // Bare X_AUTH_TOKEN maps to the named default account, or the synthetic
  // "default" handle when no X_DEFAULT_ACCOUNT is set (so it's never invisible).
  if (nonEmpty(process.env.X_AUTH_TOKEN)) {
    const def = nonEmpty(process.env.X_DEFAULT_ACCOUNT);
    handles.add(def ? normalizeHandle(def) : BARE_ACCOUNT);
  }
  return [...handles].sort();
}

/** Resolve one account's credentials (handle → tokens), or null if unconfigured. */
export function getAccountCreds(handle: string): AccountCreds | null {
  const h = normalizeHandle(handle);
  // Per-handle env vars take precedence; case-insensitive match on the suffix.
  let authToken: string | undefined;
  let ct0: string | undefined;
  let apiBearer: string | undefined;
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^X_(AUTH_TOKEN|CT0|API_BEARER)__(.+)$/);
    if (!m || normalizeHandle(m[2]) !== h) continue;
    const v = nonEmpty(process.env[key]);
    if (m[1] === "AUTH_TOKEN") authToken = v;
    else if (m[1] === "CT0") ct0 = v;
    else apiBearer = v;
  }
  // Bare-var fallback for the default account.
  if (!authToken && !ct0 && getDefaultAccount() === h) {
    authToken = nonEmpty(process.env.X_AUTH_TOKEN);
    ct0 = nonEmpty(process.env.X_CT0);
    apiBearer = apiBearer ?? nonEmpty(process.env.X_API_BEARER);
  }
  if (!authToken && !ct0 && !apiBearer) return null;
  return { handle: h, authToken, ct0, apiBearer };
}

/** Resolve the account to act on: explicit arg → default → sole account. */
export function resolveAccount(account?: string): string | undefined {
  if (account && account.trim() !== "") return normalizeHandle(account);
  return getDefaultAccount();
}

export function isCookieConfigured(creds: AccountCreds | null): boolean {
  return Boolean(creds?.authToken && creds.ct0);
}

export function isApiConfigured(creds: AccountCreds | null): boolean {
  return Boolean(creds?.apiBearer);
}

/** True when at least one account is configured at all. */
export function anyXAccountConfigured(): boolean {
  return listXAccounts().length > 0;
}

/**
 * Proactive probe cron — ships DORMANT (`=== "true"` opt-in), armed via a systemd
 * drop-in like the V8.2 producer. Tools work regardless; only the scheduled
 * background probe + alert is gated here.
 */
export function isXProbeEnabled(): boolean {
  return process.env.X_PROBE_ENABLED === "true";
}

/** Probe cadence. Default daily 09:00 (MX tz applied by the cron registrar). */
export function getXProbeCron(): string {
  return nonEmpty(process.env.X_PROBE_CRON) ?? "0 9 * * *";
}

/** CreateTweet GraphQL feature flags; overridable wholesale via env (X rotates them). */
export function getCreateTweetFeatures(): Record<string, boolean> {
  const raw = process.env.X_CREATETWEET_FEATURES;
  if (raw && raw.trim() !== "") {
    try {
      return JSON.parse(raw) as Record<string, boolean>;
    } catch {
      /* fall through to defaults */
    }
  }
  return DEFAULT_FEATURES;
}

const DEFAULT_FEATURES: Record<string, boolean> = {
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

function nonEmpty(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}
