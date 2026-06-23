/**
 * X (Twitter) posting tools — native replacement for ad-hoc Playwright/cookie
 * scripts. Multi-account: each call targets an `account` (handle), resolved to
 * its own cookie pair via the backend-router (cookie primary, API fallback).
 *
 * `tweet_post` — publish (destructive/external; confirms on the interactive path,
 *   runs unattended from a scheduled task).
 * `tweet_probe` — read-only `doctor`: is an account's X auth valid?
 */

import type { Tool } from "../types.js";
import {
  getXRouter,
  probeAllAccounts,
  listXAccounts,
  resolveAccount,
  anyXAccountConfigured,
} from "../../lib/x-poster/index.js";

const NOT_CONFIGURED =
  "X posting not configured. Set X_AUTH_TOKEN__<handle> + X_CT0__<handle> (session cookies from a logged-in x.com browser) and X_DEFAULT_ACCOUNT in the environment.";

const REFRESH_GUIDANCE =
  "X cookies are expired/invalid for this account (every backend returned auth-expiry). " +
  "Do NOT retry with script variants — it's a known wall. To unblock: log into x.com in a real " +
  "browser → DevTools → Application/Storage → Cookies → copy `auth_token` and `ct0` → update " +
  "X_AUTH_TOKEN__<handle> / X_CT0__<handle> and restart.";

/** Estimate Twitter-weighted length: URLs collapse to 23 (t.co), count codepoints. */
function weightedLength(text: string): number {
  const collapsed = text.replace(/https?:\/\/\S+/g, "x".repeat(23));
  return Array.from(collapsed).length;
}

function noAccountError(account?: string): string {
  const accts = listXAccounts();
  if (accts.length === 0) return NOT_CONFIGURED;
  return account
    ? `Unknown X account "${account}". Configured: ${accts.join(", ")}.`
    : `No default X account (set X_DEFAULT_ACCOUNT). Configured: ${accts.join(", ")}. Pass account: explicitly.`;
}

export const tweetPostTool: Tool = {
  name: "tweet_post",
  requiresConfirmation: true,
  riskTier: "high",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "postea en X",
    "publica un tweet",
    "tuitea esto",
    "post to X",
    "tweet this",
  ],
  definition: {
    type: "function",
    function: {
      name: "tweet_post",
      description: `Publish a tweet to X (Twitter) via the native backend-router (cookie → API).

USE WHEN:
- User asks to post/tweet to X, or a scheduled task publishes a tweet.
- A reply in a thread (pass reply_to_id).

DO NOT USE FOR:
- Other platforms (use social_publish).
- Drafting only — this PUBLISHES (confirms on the interactive path).

MULTI-ACCOUNT: pass account:"<handle>" (e.g. "mexiconecesario" or "lookin4ward").
Omit it to use the default account. On expired cookies it returns refresh
guidance — do NOT retry with variants; surface it. Keep text ≤280 weighted chars.`,
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Tweet body. ≤ 280 weighted chars (URLs collapse to 23).",
          },
          account: {
            type: "string",
            description:
              'X account handle to post as (e.g. "mexiconecesario"). Omit for the default account.',
          },
          reply_to_id: {
            type: "string",
            description:
              "Optional id of the tweet to reply to (threads under it).",
          },
        },
        required: ["text"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const account =
      typeof args.account === "string" && args.account.trim() !== ""
        ? args.account.trim()
        : undefined;
    const replyToId =
      typeof args.reply_to_id === "string" && args.reply_to_id.trim() !== ""
        ? args.reply_to_id.trim()
        : undefined;

    if (!text) return JSON.stringify({ error: "text is required" });
    if (!anyXAccountConfigured())
      return JSON.stringify({ error: NOT_CONFIGURED });

    const weighted = weightedLength(text);
    if (weighted > 280) {
      return JSON.stringify({
        error: `tweet too long: ~${weighted} weighted chars (limit 280). Trim before posting.`,
      });
    }

    const router = getXRouter(account);
    if (!router) return JSON.stringify({ error: noAccountError(account) });

    try {
      const result = await router.post(text, replyToId);
      if (result.ok) {
        return JSON.stringify({
          ok: true,
          account: resolveAccount(account),
          backend: result.backend,
          tweet_id: result.tweetId,
          url: result.tweetId
            ? `https://x.com/i/web/status/${result.tweetId}`
            : undefined,
        });
      }
      if (result.allAuthExpired) {
        return JSON.stringify({
          error: REFRESH_GUIDANCE,
          account: resolveAccount(account),
          auth_expired: true,
        });
      }
      return JSON.stringify({
        error: "post failed on all backends",
        account: resolveAccount(account),
        attempts: result.attempts.map((a) => ({
          backend: a.backend,
          error: a.error,
        })),
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const tweetProbeTool: Tool = {
  name: "tweet_probe",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "está viva la sesión de X",
    "check X auth",
    "is twitter posting working",
  ],
  definition: {
    type: "function",
    function: {
      name: "tweet_probe",
      description: `Health-check X posting WITHOUT posting (the 'doctor' for X auth).

USE WHEN:
- Before a thread, to confirm an account's cookies are valid.
- Diagnosing why tweet_post failed (expired vs unreachable).

Pass account:"<handle>" to check one account; omit to check ALL configured
accounts. Returns per-account/backend {ok, detail, authExpired}.`,
      parameters: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              'Handle to probe (e.g. "mexiconecesario"). Omit to probe all accounts.',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!anyXAccountConfigured()) {
      return JSON.stringify({ healthy: false, error: NOT_CONFIGURED });
    }
    const account =
      typeof args.account === "string" && args.account.trim() !== ""
        ? args.account.trim()
        : undefined;

    try {
      if (!account) {
        const all = await probeAllAccounts();
        return JSON.stringify({
          healthy: all.some((a) => a.probe.healthy),
          accounts: all.map((a) => ({
            account: a.account,
            healthy: a.probe.healthy,
            backends: a.probe.results.map((r) => ({
              backend: r.backend,
              ok: r.ok,
              detail: r.detail,
              auth_expired: r.authExpired,
            })),
          })),
        });
      }
      const router = getXRouter(account);
      if (!router)
        return JSON.stringify({
          healthy: false,
          error: noAccountError(account),
        });
      const probe = await router.probe();
      return JSON.stringify({
        account: resolveAccount(account),
        healthy: probe.healthy,
        backends: probe.results.map((r) => ({
          backend: r.backend,
          ok: r.ok,
          detail: r.detail,
          auth_expired: r.authExpired,
        })),
      });
    } catch (err) {
      return JSON.stringify({
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
