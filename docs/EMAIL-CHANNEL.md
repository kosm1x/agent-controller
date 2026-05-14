# Email Channel (SMTP/IMAP)

Status: merged to `main` (PR #25), audit-hardened. Code deployed; **activation
is operator-pending** — the channel only runs once `EMAIL_ENABLED=true` and the
`EMAIL_*` credentials are set in `.env` (see Activation below). Owner: messaging
subsystem.

## Goal

Let Jarvis converse over email — the owner emails a question, Jarvis runs the
task, Jarvis replies in the same thread. Functionally identical to the
WhatsApp and Telegram channels: a transport adapter that feeds inbound
messages into the router and sends outbound replies.

## Scope decision: client, not server

"SMTP/IMAP server" was scoped down to an **email client channel**, not a
self-hosted mail daemon. Jarvis logs into an _existing_ mailbox (Gmail,
Fastmail, mailcow, etc.):

- **Inbound** — poll IMAP for unseen mail.
- **Outbound** — send via the provider's SMTP relay.

Rejected: running our own SMTP listener on port 25 + IMAP server. That needs a
mail domain, MX/SPF/DKIM/DMARC DNS, TLS certs, spam filtering, and long-lived
public listeners — all blast radius with no benefit for a single-owner
assistant. If a self-hosted daemon is ever wanted, the `ChannelAdapter`
boundary is unchanged; only `channels/email.ts` internals would swap.

## Architecture

Mirrors the existing channel pattern exactly:

```
IMAP mailbox ──poll──> EmailAdapter ──IncomingMessage──> MessageRouter ──> submitTask()
                          ▲                                                    │
SMTP relay   <──send──────┘                                                    ▼
                          └──────OutgoingMessage<──task.completed event────────┘
```

- `EmailAdapter implements ChannelAdapter` (`src/messaging/channels/email.ts`).
- Registered in `initMessaging()` behind `EMAIL_ENABLED=true`. The adapter is
  `registerChannel()`-ed **before** `start()` is awaited: `start()` runs an
  initial poll, and the `onMessage` handler must already be attached or
  boot-time unseen mail is consumed and dropped (audit fix, PR #25).
- The router is untouched except: (1) `getOwnerAddress()` gains an `email`
  case, (2) the synchronous "working on it…" ACK is skipped for email (email
  is async by nature — an ACK email per message is noise).
- All routing, scoping, enrichment, threading, feedback detection stay in the
  router. The adapter is pure transport.

### Zero new dependencies

The codebase invariant forbids new deps without discussion. IMAP, SMTP, and
MIME are implemented as minimal raw-protocol clients over Node's `tls` module
— consistent with the "raw fetch to OpenAI-compatible endpoints" ethos. The
pure protocol helpers live in `src/messaging/email-mime.ts` and are unit
tested with no network.

This is deliberately a _minimal_ implementation, not a general MUA. Owner-only
filtering keeps the parse surface small: we only need to read mail from one
known sender. If the team later approves dependencies, `imapflow` +
`nodemailer` + `mailparser` would be the production-grade swap — again behind
the unchanged `ChannelAdapter` boundary.

## Components

| File                              | Responsibility                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/messaging/email-mime.ts`     | Pure helpers: RFC822 parse, MIME multipart text extraction, RFC2047 / base64 / quoted-printable codecs, outbound MIME builder. No I/O. |
| `src/messaging/channels/email.ts` | `EmailAdapter`: raw IMAP poll loop + raw SMTP send over TLS, owner filtering, thread tracking.                                         |
| `src/messaging/formatter.ts`      | `formatForEmail()` — strips markdown decoration to clean plain text.                                                                   |
| `src/messaging/types.ts`          | `ChannelName` gains `"email"`.                                                                                                         |
| `src/messaging/index.ts`          | `EMAIL_ENABLED` init gate.                                                                                                             |

## Inbound flow

1. Every `EMAIL_POLL_INTERVAL_MS` (default 60s), open a TLS IMAP connection.
   The socket carries its own `setTimeout` idle guard so a host that connects
   then goes silent cannot leak the socket past the operation ceiling (audit
   fix, PR #25).
2. `LOGIN`, `SELECT INBOX`, `UID SEARCH UNSEEN FROM <EMAIL_OWNER_ADDRESS>`
   (capped at 20 per poll). The search is scoped to the owner **server-side**:
   non-owner mail is never fetched and never flagged `\Seen`, so the channel
   does not mutate the read state of other mail in a shared mailbox (audit
   fix, PR #25).
3. For each UID: `UID FETCH <uid> (BODY.PEEK[])`, parse the RFC822 literal.
4. Filter: `handleRawEmail()` re-checks `From` against `EMAIL_OWNER_ADDRESS`
   as defense-in-depth — IMAP `FROM` search is a substring match and can
   over-match.
5. Extract a plain-text body (prefer `text/plain` MIME part; fall back to
   stripped HTML), strip the quoted reply tail.
6. Emit an `IncomingMessage` to the router; record the thread context
   (`Message-ID`, `References`, `Subject`) keyed by sender address.
7. `UID STORE <uid> +FLAGS (\Seen)` so it is never reprocessed. An in-memory
   processed-id set is a second guard if the flag store fails.

`BODY.PEEK[]` is used (not `BODY[]`) so the fetch itself does not set `\Seen` —
the flag is set explicitly only _after_ the message is handed to the router.

## Outbound flow

`task.completed` → router → `adapter.send()`:

1. `formatForEmail()` the result text.
2. Look up thread context for the recipient; build a reply with
   `In-Reply-To` + `References` + `Re:` subject so it lands in the same
   thread. First contact with no context → fresh subject.
3. Body is base64 `Content-Transfer-Encoding` — sidesteps dot-stuffing,
   bare-LF, and line-length pitfalls; UTF-8 safe.
4. SMTP over implicit TLS: `EHLO`, `AUTH LOGIN`, `MAIL FROM`, `RCPT TO`,
   `DATA`, `QUIT`.

## Configuration

All via env vars (channels read `process.env` directly — no `Config` change),
following the `*_ENABLED` gate convention:

| Var                      | Required | Default          | Notes                                        |
| ------------------------ | -------- | ---------------- | -------------------------------------------- |
| `EMAIL_ENABLED`          | —        | `false`          | Gate.                                        |
| `EMAIL_IMAP_HOST`        | yes      | —                | e.g. `imap.gmail.com`.                       |
| `EMAIL_IMAP_PORT`        | —        | `993`            | Implicit TLS.                                |
| `EMAIL_SMTP_HOST`        | yes      | —                | e.g. `smtp.gmail.com`.                       |
| `EMAIL_SMTP_PORT`        | —        | `465`            | Implicit TLS.                                |
| `EMAIL_USERNAME`         | yes      | —                | Login for both IMAP and SMTP.                |
| `EMAIL_PASSWORD`         | yes      | —                | App password — keep in `.env`, never commit. |
| `EMAIL_ADDRESS`          | —        | `EMAIL_USERNAME` | `From:` address.                             |
| `EMAIL_OWNER_ADDRESS`    | yes      | —                | Only mail from this sender is processed.     |
| `EMAIL_POLL_INTERVAL_MS` | —        | `60000`          | IMAP poll cadence.                           |

## Security / robustness

- **Owner-only, server-side.** The IMAP search is scoped `FROM <owner>` so
  non-owner mail is never fetched or flagged; `handleRawEmail()` re-checks the
  sender as a second layer — same trust model as the Telegram owner-chat filter.
- **Credentials** stay in `.env`. Use a provider app password, not the account
  password.
- **Polls are isolated.** Each poll opens and closes its own connection; a
  failed poll logs and is retried on the next tick — it never throws out of
  `start()`, so a flaky mail host cannot block service boot. A `polling` guard
  prevents overlapping polls, and each socket has a `setTimeout` idle guard so
  a hung connection is destroyed rather than leaked.
- **`isConnected()`** reflects the last poll outcome, surfaced on `/health`.
- **No boot-time message loss.** The channel is registered with the router
  before its initial poll runs, so mail unseen at service start is routed, not
  silently consumed.

### Audit (PR #25)

Reviewed before merge. Three issues found and fixed in the same PR:
boot-time message loss (register-before-start ordering), socket leak on a hung
host (per-socket idle timeout), and shared-mailbox read-state mutation
(server-side `FROM` scoping). Pure-helper tests (59) + the full messaging suite
(746) pass; full repo suite green.

## Known limitations (v1)

- Plain-text bodies only; no inbound attachment handling (a PDF/image arrives
  as text-only context). Telegram/WhatsApp attachment parity is future work.
- Hand-rolled MIME parser is best-effort, justified by owner-only scope.
- Polling latency: inbound mail is seen within one poll interval, not
  instantly. IMAP IDLE is a future optimization.
- Long-running tasks may still emit one interim "still working" email from the
  router's existing timer — acceptable for email cadence.

## Visibility to Jarvis

Jarvis's static identity prompt (`identitySection()` in
`src/messaging/prompt-sections.ts`) has a `## Correo electrónico` section: it
tells Jarvis that a message starting with `[Asunto: ...]` arrived by email, that
email is async (answer once, completely, no "working on it" acks), and that the
reply is threaded automatically. It also reminds him the `gmail_*` tools remain
available for reading/searching/sending mail on the project accounts he manages
— the inbound _channel_ and the outbound _tools_ are distinct surfaces.

## Activation

The code ships disabled. To turn the channel on, the operator sets in `.env`:

```
EMAIL_ENABLED=true
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_USERNAME=<mailbox-login>
EMAIL_PASSWORD=<provider app password>
EMAIL_OWNER_ADDRESS=<only this sender is processed>
# EMAIL_ADDRESS / EMAIL_*_PORT / EMAIL_POLL_INTERVAL_MS optional — see table
```

then `./scripts/deploy.sh`. Verify with `journalctl -u mission-control` for
`[messaging] Email channel active` and check `/health` for the `email` channel
status. `.env` is permission-protected on the VPS, so this step is
operator-only — Claude cannot set the credentials.
