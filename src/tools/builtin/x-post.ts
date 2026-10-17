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
  currentXAccountScope,
  readMentions,
} from "../../lib/x-poster/index.js";

const NOT_CONFIGURED =
  "X posting not configured. Set X_AUTH_TOKEN__<handle> + X_CT0__<handle> (session cookies from a logged-in x.com browser) and X_DEFAULT_ACCOUNT in the environment.";

/** No reachable account: env-keyed (NOT_CONFIGURED) or none declared for this task's project (ruling 5b). */
function notConfigured(): string {
  const scope = currentXAccountScope();
  return scope.mode === "record"
    ? `No X account is reachable for this task's project (${scope.slug ?? "none"}): a task reaches an X account only through its project record's secrets (SECRET_X_AUTH_TOKEN__<HANDLE> + SECRET_X_CT0__<HANDLE>).`
    : NOT_CONFIGURED;
}

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
  if (accts.length === 0) return notConfigured();
  return account
    ? `Unknown X account "${account}". Configured: ${accts.join(", ")}. Use one of these EXACT labels (do not re-spell).`
    : `No default X account (set X_DEFAULT_ACCOUNT). Configured: ${accts.join(", ")}. Pass account: explicitly.`;
}

/**
 * Account guidance shared by the X tool descriptions. Static (S6 ruling 5b,
 * WS3b R1 W2): a description is read by every task, so it names no handle —
 * the accounts a task reaches are its project's, listed by tweet_probe.
 */
const ACCOUNTS_HINT =
  "Accounts reachable by this task are those its project's record declares; omit `account` to use the project's only/default account; tweet_probe lists them. Use account labels EXACTLY as tweet_probe returns them (do NOT re-spell, \"correct\", or normalize them; e.g. a leading lowercase \"i\" is intentional).";

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
- Other platforms — this tool posts to X/Twitter only.
- Drafting only — this PUBLISHES (confirms on the interactive path).

THIS IS THE ONLY SUPPORTED X PATH. Do NOT use shell_exec, Playwright/.cjs scripts,
or look up auth_token/ct0 cookies in user_facts or mc.db for X — that path is
RETIRED. Cookies live in the environment and are handled internally by this tool;
you never need them. If auth is stale this tool says so.

MULTI-ACCOUNT: pass account:"<handle>". ${ACCOUNTS_HINT} Omit account to use the
default. On expired cookies it returns refresh guidance — do NOT retry with
variants; surface it. Keep text ≤280 weighted chars.

ON FAILURE: relay the result's EXACT error/code/label VERBATIM. Do NOT invent an
X error code, a "daily limit"/"rate limit", or an auto-retry promise — this
result is ground truth and is logged. If a field isn't in the result, it didn't
happen.`,
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
              "X account handle to post as — an EXACT account label (as tweet_probe lists it). Omit for the project's default account.",
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
      return JSON.stringify({ error: notConfigured() });

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
          code: a.xErrorCode,
          label: a.xErrorLabel,
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
- The operator asks to "verify X access / is the X session alive".

THIS is how you check X access. Do NOT use shell_exec or hunt for cookies in
user_facts/mc.db — cookies live in the environment and this tool reads them
internally. ${ACCOUNTS_HINT}

Pass account:"<handle>" (an EXACT configured label) to check one account; omit to
check every account this task's project can use. Returns per-account/backend {ok, detail, authExpired}.`,
      parameters: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Handle to probe (an EXACT account label). Omit to probe every account this task's project can use.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!anyXAccountConfigured()) {
      return JSON.stringify({ healthy: false, error: notConfigured() });
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

export const tweetMentionsTool: Tool = {
  name: "tweet_mentions",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "lee mis menciones",
    "revisa las menciones de X",
    "check my X mentions",
    "who mentioned me on twitter",
  ],
  definition: {
    type: "function",
    function: {
      name: "tweet_mentions",
      description: `Read recent X (Twitter) MENTIONS for an account (read-only — safe; does
NOT consume the daily posting limit).

USE WHEN:
- The operator asks who mentioned/replied to an account on X, or to triage the
  mention inbox.
- You need a tweet's id to reply: read mentions → take the \`tweet_id\` → call
  tweet_post with \`reply_to_id\` set to it.

THIS is how you read X mentions. Do NOT use shell_exec, Playwright/.cjs scripts,
or user_facts/mc.db. ${ACCOUNTS_HINT}

Returns newest-first; each item: \`tweet_id\`, \`author\` (handle), \`name\`,
\`text\`, \`created_at\`, optional \`in_reply_to\`. An empty list means no
mentions, not an error.`,
      parameters: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Account whose mentions to read — an EXACT account label (as tweet_probe lists it). Omit for the default account.",
          },
          limit: {
            type: "number",
            description: "Max mentions to return (default 20, max 50).",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!anyXAccountConfigured())
      return JSON.stringify({ error: notConfigured() });
    const account =
      typeof args.account === "string" && args.account.trim() !== ""
        ? args.account.trim()
        : undefined;
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.min(Math.floor(args.limit), 50)
        : 20;

    // Reuse the router's resolution + config guard (fuzzy handle, real list error).
    if (!getXRouter(account))
      return JSON.stringify({ error: noAccountError(account) });
    const handle = resolveAccount(account);
    if (!handle) return JSON.stringify({ error: noAccountError(account) });

    const result = await readMentions(handle, limit);
    if (!result.ok)
      return JSON.stringify({ error: result.error, account: result.account });
    return JSON.stringify({
      account: result.account,
      count: result.mentions.length,
      mentions: result.mentions.map((m) => ({
        tweet_id: m.tweetId,
        author: m.author,
        name: m.authorName,
        text: m.text,
        created_at: m.createdAt,
        in_reply_to: m.inReplyToTweetId,
      })),
    });
  },
};
