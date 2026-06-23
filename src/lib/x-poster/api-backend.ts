/**
 * API backend — the ROBUST fallback slot (X API v2), per account. Ships
 * unconfigured: until `X_API_BEARER__<handle>` is set it reports
 * `isConfigured() === false`, so the router skips it and behaviour is identical
 * to cookie-only. When an account provisions an X developer app, this backend
 * drops in with zero router changes. Plain `fetch` (no new dependency).
 */

import type { XBackend, ProbeResult, PostResult } from "./types.js";
import {
  getAccountCreds,
  isApiConfigured,
  type AccountCreds,
} from "./config.js";
import { classifyXError, describeXError } from "./x-errors.js";
import { createLogger } from "../logger.js";

const ME_URL = "https://api.x.com/2/users/me";
const TWEETS_URL = "https://api.x.com/2/tweets";
const TIMEOUT_MS = 20_000;
const log = createLogger("x-poster");

export class ApiBackend implements XBackend {
  readonly name = "api";
  private readonly creds: AccountCreds | null;

  constructor(private readonly account: string) {
    this.creds = getAccountCreds(account);
  }

  isConfigured(): boolean {
    return isApiConfigured(this.creds);
  }

  async probe(): Promise<ProbeResult> {
    if (!this.creds || !this.isConfigured()) {
      return {
        backend: this.name,
        ok: false,
        detail: `not configured (X_API_BEARER__${this.account} unset)`,
        authExpired: false,
      };
    }
    try {
      const res = await fetch(ME_URL, {
        headers: { authorization: `Bearer ${this.creds.apiBearer}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        backend: this.name,
        ok: res.status === 200,
        detail: `${res.status} users/me`,
        authExpired: res.status === 401 || res.status === 403,
      };
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
        error: `not configured (X_API_BEARER__${this.account} unset)`,
        authExpired: false,
      };
    }
    const payload: Record<string, unknown> = { text };
    if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };
    try {
      const res = await fetch(TWEETS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.creds.apiBearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const raw = await res.text();
      if (res.status !== 201 && res.status !== 200) {
        const info = classifyXError(res.status, raw);
        log.warn(
          {
            account: this.account,
            status: res.status,
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
      let tweetId: string | undefined;
      try {
        tweetId = (JSON.parse(raw) as { data?: { id?: string } })?.data?.id;
      } catch {
        /* leave undefined */
      }
      if (tweetId) {
        log.info(
          { account: this.account, backend: this.name, tweetId },
          "x post ok",
        );
      } else {
        // 2xx + no id = the body carried the rejection; capture it like the
        // cookie backend's GraphQL-200 path.
        const info = classifyXError(res.status, raw);
        log.warn(
          {
            account: this.account,
            status: res.status,
            code: info.code,
            label: info.label,
            message: info.message,
            body: raw.slice(0, 400),
          },
          "x post rejected (2xx, no tweet id)",
        );
      }
      return {
        backend: this.name,
        ok: Boolean(tweetId),
        tweetId,
        error: tweetId ? undefined : `created but no id — ${raw.slice(0, 240)}`,
        authExpired: false,
        xErrorLabel: tweetId ? undefined : "unknown",
      };
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
