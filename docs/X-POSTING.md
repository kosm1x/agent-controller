# X (Twitter) Posting — native multi-account tool

Replaces the old ad-hoc Playwright `/tmp/*.cjs` scripts (which read cookies from
`user_facts` and broke ~monthly) with a native, multi-account backend-router +
health probe. Code: `src/lib/x-poster/`, tools `src/tools/builtin/x-post.ts`.

## Accounts

| Label (internal)  | X handle                                                           | Mode                                       |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `iooking4ward`    | **@Iooking4ward** (capital-I registration typo for "looking4ward") | hybrid (operator chat + cron); **default** |
| `mexiconecesario` | @MexicoNecesario                                                   | cron-only (autonomous, no approval)        |

The label is an internal identifier (lowercased via `normalizeHandle`); the
cookies decide the real account. Casing of the display handle is cosmetic.

**Handle resolution is typo-tolerant.** `resolveAccount` maps a near-miss handle to
the unique configured account within edit-distance 2 (e.g. `looking4ward` /
`lookin4ward` → `iooking4ward` — the registration-typo `i`/`l` lookalike class). An
exact configured label is never overridden; an ambiguous or far handle is left
unchanged so the tool returns the real configured list. The resolved account is
echoed in every tool result, so a fuzzy bind is observable. The tool descriptions
also inject the **live** `listXAccounts()` list at load, so the model reads
ground-truth labels rather than a hardcoded example that can drift.

## Env (`.env`)

```
X_AUTH_TOKEN__<handle>=<auth_token cookie>      # per account, secret
X_CT0__<handle>=<ct0 cookie>                    # per account, secret (also the CSRF header)
X_DEFAULT_ACCOUNT=iooking4ward                  # used when a call omits account
# optional / advanced:
X_API_BEARER__<handle>=...    # enables the API-v2 fallback backend for that account
X_BEARER=...                  # public web bearer (constant; override only if X rotates it)
X_CREATETWEET_QUERY_ID=...    # GraphQL CreateTweet queryId — bump if posting 404s
X_CREATETWEET_FEATURES={...}  # GraphQL feature flags JSON — override if CreateTweet 400s
X_PROBE_URL=...               # probe endpoint (default: badge_count; override if X moves it)
X_MENTIONS_URL=...            # mentions read endpoint (default: notifications/mentions.json; override if X moves it)
X_PROBE_ENABLED=true          # arm the daily proactive probe (systemd drop-in, ships dormant)
X_PROBE_CRON="0 9 * * *"      # probe cadence (MX tz)
```

A bare `X_AUTH_TOKEN`/`X_CT0` (no handle) maps to the `default` account if
`X_DEFAULT_ACCOUNT` is unset — migration convenience, not the steady state.

**`.env` changes require a restart** (`systemctl restart mission-control`) — env
loads at boot.

## Tools (deferred; activate on the `social` scope group)

- `tweet_post { text, account?, reply_to_id? }` — destructive; **confirms on the
  interactive (chat) path, runs unattended from a scheduled task**. On expired
  cookies returns `{auth_expired:true, ...}` + refresh guidance (do NOT retry
  with script variants). 280-weighted-char pre-check.
- `tweet_probe { account? }` — read-only doctor; omit `account` to probe all
  accounts. Hits `badge_count` (read-only) to detect expiry without posting.
- `tweet_mentions { account?, limit? }` — **read-only**; reads an account's
  recent mentions (the reply inbox). Returns newest-first
  `{tweet_id, author, name, text, created_at, in_reply_to?}`. To reply, feed a
  `tweet_id` into `tweet_post`'s `reply_to_id`. Reads do NOT consume the daily
  send-limit (code 344), so this works even while posting is throttled. Empty
  list = no mentions, not an error. Code: `src/lib/x-poster/read.ts`
  (`/2/notifications/mentions.json`, env-overridable `X_MENTIONS_URL`, no
  rotating GraphQL queryId needed).

Reach them in chat with X-intent phrasing ("tuitea…", "postea en X…", "verifica
la sesión de x", "tweet_probe", "lee mis menciones de X", "check my X mentions")
**or by naming a configured account** — the scope
also activates when the message mentions a configured handle (exact or near-miss,
e.g. "Verifica @iooking4ward" / "@lookin4ward"), via `findConfiguredHandleInText`.
Ground-truth from `listXAccounts()`, so unrelated `@mentions` and the "México
Necesario" project name don't over-fire. A persistent always-read KB directive
card (`directives/x-posting-card.md`) also tells the model these are the only X
path and never to use `shell_exec`/`user_facts` for X.

## Backends (per account, ordered)

1. **cookie** (primary) — `auth_token`+`ct0` via a Chromium request context →
   GraphQL `CreateTweet`. Probe = `badge_count`.
2. **api** (fallback, dormant) — X API v2 via `fetch`; configured only when
   `X_API_BEARER__<handle>` is set. Robust path if you provision a dev app.

## Observability

- Gauge `mc_x_backend_healthy{account,backend}` (1=auth valid, 0=expired/unreachable).
- Proactive probe cron (dormant; `X_PROBE_ENABLED=true`): daily check, edge-triggered
  Telegram alert to the operator on healthy→unhealthy (cookies expiring) BEFORE a post 401s.
- **Every post outcome is logged** (pino `module:"x-poster"`): `x post ok`
  `{account, backend, tweetId}` on success, `x post failed`
  `{account, status, code, label, message}` on an X rejection, `x post error`
  on a network error. Before this (2026-06-23) a failure existed nowhere but the
  model's narration — grep `journalctl -u mission-control` for `"x post failed"`
  to see the REAL X error of any failed tweet.

## Error classification (`x-errors.ts`)

`tweet_post` failures used to return X's raw body only as a transient string,
logged nowhere — so the operator could not VERIFY the model's account of a failure.
`classifyXError(status, raw)` now parses X's actual `{code, message}` and maps known
codes to a stable `label`, returned on the tool result (`code` + `label`) and logged:

| X code     | label               | meaning                                                                         |
| ---------- | ------------------- | ------------------------------------------------------------------------------- |
| 32, 89     | `auth_expired`      | bad/expired token → refresh cookies                                             |
| 88 / `429` | `rate_limited`      | too many requests                                                               |
| 185, 344   | `daily_limit`       | over daily send limit (185=v1.1; 344=GraphQL CreateTweet / automation throttle) |
| 186        | `too_long`          | tweet > 280 (pre-check usually catches)                                         |
| 187        | `duplicate`         | identical to a recent tweet                                                     |
| 226        | `flagged_automated` | spam/automation filter                                                          |
| 261        | `write_restricted`  | app/account cannot write                                                        |
| 64, 326    | `account_locked`    | suspended / temporarily locked                                                  |
| `5xx`      | `server_error`      | X-side outage                                                                   |
| _other_    | `unknown`           | surfaced VERBATIM (code + X's message)                                          |

A recognized non-auth code on a 401/403 (e.g. 64=suspended) keeps its real label
and does NOT trigger the cookie-refresh path; a bare 401/403 with no code remains
the canonical `auth_expired` signal. An unrecognized code comes back as `unknown`
with X's verbatim message — never a guess.

**GraphQL errors arrive at HTTP 200.** `CreateTweet` is GraphQL, so a REJECTED
tweet returns `200` with the reason in an `errors[]` body (`{data:{}, errors:[{code,
name:"AuthorizationError", message}]}`), NOT an HTTP error status. The cookie/api
backends classify the 200 body on a no-`rest_id` result and log it raw as
`x post rejected (200, no tweet id)`. This is how `code 344` ("you have reached your
daily limit for sending Tweets and messages") was finally captured 2026-06-23 —
it had been a 200-body error all along.

## Scheduled posting

`@MexicoNecesario` daily tweet = schedule `63bfd0bd-b859-44ab-a05e-ece2e8f5b171`
("MexicoNecesario — Tweet Diario", `0 13 * * 1-5`), tools include `tweet_post`.
It reads `mexiconecesario/calendario-editorial.md`, posts via
`tweet_post account:"mexiconecesario"`, marks the calendar. Protocol:
`jarvis-kb/projects/mexico-necesario-ac/docs/protocolo-publicacion.md`.

## Operator scripts (`/root/`)

- `inject-x-cookies.sh` — interactive (hidden prompts) one-shot to set both accounts.
- `rotate-x-cookies.sh <account>` — the ~monthly refresh when a session expires.
- `setup-x-multiacct-env.sh` — auto-migrate (pull mexiconecesario from `user_facts`,
  reuse the bare iooking4ward pair).

## Cookie rotation (when a probe / post reports `auth_expired`)

1. Log into x.com in a real browser → DevTools → Storage/Application → Cookies →
   copy `auth_token` + `ct0`.
2. `/root/rotate-x-cookies.sh <account>` (paste at the hidden prompts).
3. `systemctl restart mission-control`, then `tweet_probe account:"<account>"`.

## Notes / gotchas

- **This is the ONLY supported X path.** Do not post/check X via `shell_exec`,
  Playwright/`.cjs` scripts, or by looking up `auth_token`/`ct0` in `user_facts` /
  `mc.db` — that path is retired. Cookies live in the environment and the tools read
  them internally. The tool descriptions state this explicitly (2026-06-23 diagnosis:
  the tools were in scope but the model kept reaching for the old `shell_exec` path,
  and four poisoned `execution-patterns` KB entries were reinforcing it — deleted).
- **`code 344` = X's daily send-limit / automation throttle (verified live
  2026-06-23).** A scheduled `@iooking4ward` tweet failed and the model reported
  "daily posting limit, code 344". Capturing X's raw body (now that we log it)
  PROVED the model right: X returns `{code:344, name:"AuthorizationError",
"...you have reached your daily limit for sending Tweets and messages..."}`. The
  earlier guess that 344 was fabricated (reasoned from the v1.1 code 185) was the
  mistake — the lesson is **capture the tool's real output BEFORE concluding the
  model lied**, which is exactly what the logging now enables. On a low-trust
  account this throttle hits automated posts while MANUAL posts still succeed; the
  durable fix is account trust/age or the X API v2 slot, not cookie tweaks.
  Backstops still hold (card rule 6 + schedule prompt mandate verbatim relay) so
  the model never _embellishes_ a real error (e.g. a guessed reset time).
- X session cookies live ~30 days; the proactive probe is the early warning.
- X retires API endpoints periodically — that's why the queryId, features, and
  probe URL are all env-overridable. A **404** (vs 401) from the probe means a
  dead endpoint, not bad cookies (verify against the path `CreateTweet` uses,
  host `x.com/i/api`).
