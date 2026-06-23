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

Reach them in chat with X-intent phrasing ("tuitea…", "postea en X…", "verifica
la sesión de x", "tweet_probe").

## Backends (per account, ordered)

1. **cookie** (primary) — `auth_token`+`ct0` via a Chromium request context →
   GraphQL `CreateTweet`. Probe = `badge_count`.
2. **api** (fallback, dormant) — X API v2 via `fetch`; configured only when
   `X_API_BEARER__<handle>` is set. Robust path if you provision a dev app.

## Observability

- Gauge `mc_x_backend_healthy{account,backend}` (1=auth valid, 0=expired/unreachable).
- Proactive probe cron (dormant; `X_PROBE_ENABLED=true`): daily check, edge-triggered
  Telegram alert to the operator on healthy→unhealthy (cookies expiring) BEFORE a post 401s.

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

- X session cookies live ~30 days; the proactive probe is the early warning.
- X retires API endpoints periodically — that's why the queryId, features, and
  probe URL are all env-overridable. A **404** (vs 401) from the probe means a
  dead endpoint, not bad cookies (verify against the path `CreateTweet` uses,
  host `x.com/i/api`).
