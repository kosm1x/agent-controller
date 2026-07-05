/**
 * X read path (cookie session) — notifications/mentions.
 *
 * Uses the same authed Chromium request as post/probe. The endpoint is a stable
 * REST "2/" path that needs NO rotating GraphQL queryId (verified live
 * 2026-06-23: `/2/notifications/mentions.json` → 200 with the activity-stream
 * `globalObjects` shape). Env-overridable via `X_MENTIONS_URL` so X's next move
 * is a config change, not a code change — same pattern as `X_PROBE_URL`.
 *
 * Read-only: no writes, so it does NOT consume the daily send-limit (code 344)
 * that throttles posting on a low-trust account.
 */

import { getAccountCreds, isCookieConfigured } from "./config.js";
import { authHeaders, withAuthedRequest } from "./authed-request.js";
import { createLogger } from "../logger.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("x-poster");
const READ_TIMEOUT_MS = 30_000;
const DEFAULT_MENTIONS_URL =
  "https://x.com/i/api/2/notifications/mentions.json";

/** One mention, flattened for the model — `tweetId` feeds `tweet_post.reply_to_id`. */
export interface XMention {
  /** The mentioning tweet's id — pass as `reply_to_id` to reply to it. */
  readonly tweetId: string;
  /** Author handle (no leading @). */
  readonly author: string;
  /** Author display name. */
  readonly authorName: string;
  readonly text: string;
  readonly createdAt: string;
  /** Set when the mention is itself a reply (threads it under that tweet). */
  readonly inReplyToTweetId?: string;
}

export interface MentionsResult {
  readonly ok: boolean;
  readonly account: string;
  readonly mentions: readonly XMention[];
  readonly error?: string;
}

/** Mentions endpoint, env-overridable (`X_MENTIONS_URL`), read at call time. */
export function mentionsUrl(count: number): string {
  const base = process.env.X_MENTIONS_URL?.trim() || DEFAULT_MENTIONS_URL;
  const url = new URL(base);
  url.searchParams.set("count", String(count));
  return url.toString();
}

/**
 * Parse X's activity-stream `globalObjects` into a flat, newest-first mention
 * list. Defensive: tolerates missing fields / shapes (returns [] on garbage).
 * Pure → unit-testable without live cookies.
 */
export function parseMentions(raw: string): XMention[] {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const tweets = json?.globalObjects?.tweets;
  const users = json?.globalObjects?.users ?? {};
  if (!tweets || typeof tweets !== "object") return [];
  const out: XMention[] = [];
  for (const t of Object.values<any>(tweets)) {
    const id = t?.id_str;
    if (typeof id !== "string") continue;
    const u = users[t?.user_id_str] ?? {};
    out.push({
      tweetId: id,
      author: typeof u.screen_name === "string" ? u.screen_name : "",
      authorName: typeof u.name === "string" ? u.name : "",
      text:
        typeof t.full_text === "string"
          ? t.full_text
          : typeof t.text === "string"
            ? t.text
            : "",
      createdAt: typeof t.created_at === "string" ? t.created_at : "",
      inReplyToTweetId:
        typeof t.in_reply_to_status_id_str === "string"
          ? t.in_reply_to_status_id_str
          : undefined,
    });
  }
  // Newest first: tweet ids are time-ordered snowflakes. Compare by length then
  // lexicographically (longer id = larger number) — avoids a BigInt throw on a
  // malformed id and is correct for the fixed-width ids X returns.
  out.sort(
    (a, b) =>
      b.tweetId.length - a.tweetId.length ||
      (a.tweetId < b.tweetId ? 1 : a.tweetId > b.tweetId ? -1 : 0),
  );
  return out;
}

/** Read recent mentions for an account. `account` must be a resolved handle. */
export async function readMentions(
  account: string,
  count = 20,
): Promise<MentionsResult> {
  const creds = getAccountCreds(account);
  if (!creds || !isCookieConfigured(creds)) {
    return {
      ok: false,
      account,
      mentions: [],
      error: `not configured (X_AUTH_TOKEN__${account} / X_CT0__${account} unset)`,
    };
  }
  try {
    return await withAuthedRequest(creds, async (request) => {
      const res = await request.get(mentionsUrl(count), {
        headers: authHeaders(creds),
        timeout: READ_TIMEOUT_MS,
        failOnStatusCode: false,
      });
      const status = res.status();
      const raw = await res.text();
      if (status !== 200) {
        log.warn({ account, status }, "x mentions read failed");
        return {
          ok: false,
          account,
          mentions: [],
          error: `${status} reading mentions`,
        };
      }
      const mentions = parseMentions(raw).slice(0, count);
      log.info({ account, count: mentions.length }, "x mentions read");
      return { ok: true, account, mentions };
    });
  } catch (err) {
    log.warn(
      { account, err: errMsg(err) },
      "x mentions read error",
    );
    return {
      ok: false,
      account,
      mentions: [],
      error: errMsg(err),
    };
  }
}
