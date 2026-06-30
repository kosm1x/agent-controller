/**
 * Cookie backend — the PRIMARY X path, per account. Codifies the previously
 * ad-hoc Playwright approach: re-use one account's `auth_token` + `ct0` session
 * cookies to call X's internal GraphQL/REST endpoints through a real Chromium
 * context (browser TLS), not the compose UI.
 *
 * `probe()` hits the read-only `badge_count` endpoint (`getProbeUrl()`, env-
 * overridable — X retired the old v1.1 `verify_credentials`) to detect cookie
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
import {
  classifyXError,
  classifyNoTweetId,
  describeXError,
} from "./x-errors.js";
import { authHeaders, withAuthedRequest } from "./authed-request.js";
import { createLogger } from "../logger.js";

const NAV_TIMEOUT_MS = 30_000;
const log = createLogger("x-poster");

export class CookieBackend implements XBackend {
  readonly name = "cookie";
  private readonly creds: AccountCreds | null;

  /** @param account normalized handle (e.g. "iooking4ward"). */
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
        if (status !== 200) {
          // Classify X's ACTUAL error (code + verbatim message) so the model
          // relays facts instead of inventing a cause — and log it durably, the
          // gap that let the 2026-06-23 "code 344 daily limit" confabulation
          // reach the operator with no ground-truth record. See x-errors.ts.
          const info = classifyXError(status, raw);
          log.warn(
            {
              account: this.account,
              status,
              code: info.code,
              label: info.label,
              message: info.message,
            },
            "x post failed",
          );
          return {
            backend: this.name,
            ok: false,
            error: describeXError(info),
            authExpired: info.authExpired,
            xErrorCode: info.code,
            xErrorLabel: info.label,
          };
        }
        const tweetId = extractTweetId(raw);
        if (tweetId) {
          log.info(
            { account: this.account, backend: this.name, tweetId },
            "x post ok",
          );
          return {
            backend: this.name,
            ok: true,
            tweetId,
            authExpired: false,
          };
        }
        // 200 + no tweet id = a GraphQL-level REJECTION. Two shapes: an `errors[]`
        // body (the original "AuthorizationError code 344", never an HTTP error), OR
        // `{"data":{"create_tweet":{"tweet_results":{}}}}` — accepted but EMPTY, a
        // silent withhold with no code. `classifyNoTweetId` maps the latter to
        // `silent_withhold` (was a confabulation-inviting `unknown`, 2026-06-29).
        // Log RAW either way so X's exact response is captured, not hidden by 200.
        const info = classifyNoTweetId(raw);
        log.warn(
          {
            account: this.account,
            status: 200,
            code: info.code,
            label: info.label,
            message: info.message,
            body: raw.slice(0, 400),
          },
          "x post rejected (200, no tweet id)",
        );
        return {
          backend: this.name,
          ok: false,
          error: describeXError(info),
          authExpired: info.authExpired,
          xErrorCode: info.code,
          xErrorLabel: info.label,
        };
      });
    } catch (err) {
      log.warn(
        {
          account: this.account,
          err: err instanceof Error ? err.message : String(err),
        },
        "x post error",
      );
      return {
        backend: this.name,
        ok: false,
        error: `post error: ${err instanceof Error ? err.message : String(err)}`,
        authExpired: false,
        xErrorLabel: "unknown",
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
