/**
 * Cookie backend — the PRIMARY X path, per account. Codifies the previously
 * ad-hoc Playwright approach: re-use one account's `auth_token` + `ct0` session
 * cookies to call X's internal GraphQL/REST endpoints through a real Chromium
 * context (browser TLS), not the compose UI.
 *
 * `probe()` hits v1.1 `verify_credentials` (stable, read-only) to detect cookie
 * expiry WITHOUT posting. `post()` calls GraphQL `CreateTweet` (queryId is
 * env-configurable because X rotates it). The post path is inherently brittle
 * and cannot be unit-tested without live cookies; the probe path is the
 * verified-value half.
 */

import type { XBackend, ProbeResult, PostResult } from "./types.js";
import {
  getAccountCreds,
  getXGlobals,
  getProbeUrl,
  getCreateTweetFeatures,
  isCookieConfigured,
  type AccountCreds,
} from "./config.js";
import { STEALTH_LAUNCH_ARGS } from "../stealth-browser.js";

const NAV_TIMEOUT_MS = 30_000;

function authHeaders(creds: AccountCreds): Record<string, string> {
  return {
    authorization: getXGlobals().bearer,
    "x-csrf-token": creds.ct0 ?? "",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "content-type": "application/json",
  };
}

/** Cookies on both apex domains (X migrated x.com↔twitter.com). */
function cookiePayload(creds: AccountCreds) {
  const out: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }> = [];
  for (const domain of [".x.com", ".twitter.com"]) {
    if (creds.authToken)
      out.push({
        name: "auth_token",
        value: creds.authToken,
        domain,
        path: "/",
      });
    if (creds.ct0)
      out.push({ name: "ct0", value: creds.ct0, domain, path: "/" });
  }
  return out;
}

async function withAuthedRequest<T>(
  creds: AccountCreds,
  fn: (request: import("playwright").APIRequestContext) => Promise<T>,
): Promise<T> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: [...STEALTH_LAUNCH_ARGS],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies(cookiePayload(creds));
    return await fn(context.request);
  } finally {
    await browser.close().catch(() => {});
  }
}

export class CookieBackend implements XBackend {
  readonly name = "cookie";
  private readonly creds: AccountCreds | null;

  /** @param account normalized handle (e.g. "lookin4ward"). */
  constructor(private readonly account: string) {
    this.creds = getAccountCreds(account);
  }

  isConfigured(): boolean {
    return isCookieConfigured(this.creds);
  }

  async probe(): Promise<ProbeResult> {
    if (!this.creds || !this.isConfigured()) {
      return {
        backend: this.name,
        ok: false,
        detail: `not configured (X_AUTH_TOKEN__${this.account} / X_CT0__${this.account} unset)`,
        authExpired: false,
      };
    }
    const creds = this.creds;
    try {
      return await withAuthedRequest(creds, async (request) => {
        const res = await request.get(getProbeUrl(), {
          headers: authHeaders(creds),
          timeout: NAV_TIMEOUT_MS,
          failOnStatusCode: false,
        });
        const status = res.status();
        return {
          backend: this.name,
          ok: status === 200,
          detail: `${status} badge_count`,
          authExpired: status === 401 || status === 403,
        };
      });
    } catch (err) {
      return {
        backend: this.name,
        ok: false,
        detail: `probe error: ${err instanceof Error ? err.message : String(err)}`,
        authExpired: false,
      };
    }
  }

  async post(text: string, replyToId?: string): Promise<PostResult> {
    if (!this.creds || !this.isConfigured()) {
      return {
        backend: this.name,
        ok: false,
        error: `not configured (X_AUTH_TOKEN__${this.account} / X_CT0__${this.account} unset)`,
        authExpired: false,
      };
    }
    const creds = this.creds;
    const queryId = getXGlobals().createTweetQueryId;
    const url = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;
    const variables: Record<string, unknown> = {
      tweet_text: text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    };
    if (replyToId) {
      variables.reply = {
        in_reply_to_tweet_id: replyToId,
        exclude_reply_user_ids: [],
      };
    }
    const body = {
      variables,
      features: getCreateTweetFeatures(),
      queryId,
    };

    try {
      return await withAuthedRequest(creds, async (request) => {
        const res = await request.post(url, {
          headers: authHeaders(creds),
          data: body,
          timeout: NAV_TIMEOUT_MS,
          failOnStatusCode: false,
        });
        const status = res.status();
        const raw = await res.text();
        if (status === 401 || status === 403) {
          return {
            backend: this.name,
            ok: false,
            error: `${status} — cookies expired/invalid`,
            authExpired: true,
          };
        }
        if (status !== 200) {
          return {
            backend: this.name,
            ok: false,
            error: `${status} — ${raw.slice(0, 240)}`,
            authExpired: false,
          };
        }
        const tweetId = extractTweetId(raw);
        return {
          backend: this.name,
          ok: Boolean(tweetId),
          tweetId,
          error: tweetId
            ? undefined
            : `200 but no tweet id — ${raw.slice(0, 240)}`,
          authExpired: false,
        };
      });
    } catch (err) {
      return {
        backend: this.name,
        ok: false,
        error: `post error: ${err instanceof Error ? err.message : String(err)}`,
        authExpired: false,
      };
    }
  }
}

/** Pull `rest_id` from a CreateTweet GraphQL response without a brittle full parse. */
function extractTweetId(raw: string): string | undefined {
  try {
    const json = JSON.parse(raw) as unknown;
    const result = (json as Record<string, any>)?.data?.create_tweet
      ?.tweet_results?.result;
    const id = result?.rest_id ?? result?.legacy?.id_str;
    return typeof id === "string" ? id : undefined;
  } catch {
    const m = raw.match(/"rest_id"\s*:\s*"(\d+)"/);
    return m?.[1];
  }
}
