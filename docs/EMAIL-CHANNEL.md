# Email Channel (SMTP/IMAP)

Status: implemented (v1). Owner: messaging subsystem.

## Goal

Let Jarvis converse over email — the owner emails a question, Jarvis runs the
task, Jarvis replies in the same thread. Functionally identical to the
WhatsApp and Telegram channels: a transport adapter that feeds inbound
messages into the router and sends outbound replies.

## Scope decision: client, not server

"SMTP/IMAP server" was scoped down to an **email client channel**, not a
self-hosted mail daemon. Jarvis logs into an *existing* mailbox (Gmail,
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
- Registered in `initMessaging()` behind `EMAIL_ENABLED=true`.
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

This is deliberately a *minimal* implementation, not a general MUA. Owner-only
filtering keeps the parse surface small: we only need to read mail from one
known sender. If the team later approves dependencies, `imapflow` +
`nodemailer` + `mailparser` would be the production-grade swap — again behind
the unchanged `ChannelAdapter` boundary.

## Components

| File | Responsibility |
| --- | --- |
| `src/messaging/email-mime.ts` | Pure helpers: RFC822 parse, MIME multipart text extraction, RFC2047 / base64 / quoted-printable codecs, outbound MIME builder. No I/O. |
| `src/messaging/channels/email.ts` | `EmailAdapter`: raw IMAP poll loop + raw SMTP send over TLS, owner filtering, thread tracking. |
| `src/messaging/formatter.ts` | `formatForEmail()` — strips markdown decoration to clean plain text. |
| `src/messaging/types.ts` | `ChannelName` gains `"email"`. |
| `src/messaging/index.ts` | `EMAIL_ENABLED` init gate. |

## Inbound flow

1. Every `EMAIL_POLL_INTERVAL_MS` (default 60s), open a TLS IMAP connection.
2. `LOGIN`, `SELECT INBOX`, `UID SEARCH UNSEEN` (capped at 20 per poll).
3. For each UID: `UID FETCH <uid> (BODY.PEEK[])`, parse the RFC822 literal.
4. Filter: drop anything whose `From` is not `EMAIL_OWNER_ADDRESS`.
5. Extract a plain-text body (prefer `text/plain` MIME part; fall back to
   stripped HTML), strip the quoted reply tail.
6. Emit an `IncomingMessage` to the router; record the thread context
   (`Message-ID`, `References`, `Subject`) keyed by sender address.
7. `UID STORE <uid> +FLAGS (\Seen)` so it is never reprocessed. An in-memory
   processed-id set is a second guard if the flag store fails.

`BODY.PEEK[]` is used (not `BODY[]`) so the fetch itself does not set `\Seen` —
the flag is set explicitly only *after* the message is handed to the router.

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

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `EMAIL_ENABLED` | — | `false` | Gate. |
| `EMAIL_IMAP_HOST` | yes | — | e.g. `imap.gmail.com`. |
| `EMAIL_IMAP_PORT` | — | `993` | Implicit TLS. |
| `EMAIL_SMTP_HOST` | yes | — | e.g. `smtp.gmail.com`. |
| `EMAIL_SMTP_PORT` | — | `465` | Implicit TLS. |
| `EMAIL_USERNAME` | yes | — | Login for both IMAP and SMTP. |
| `EMAIL_PASSWORD` | yes | — | App password — keep in `.env`, never commit. |
| `EMAIL_ADDRESS` | — | `EMAIL_USERNAME` | `From:` address. |
| `EMAIL_OWNER_ADDRESS` | yes | — | Only mail from this sender is processed. |
| `EMAIL_POLL_INTERVAL_MS` | — | `60000` | IMAP poll cadence. |

## Security / robustness

- **Owner-only.** Mail from any other sender is dropped before reaching the
  router — same trust model as the Telegram owner-chat filter.
- **Credentials** stay in `.env`. Use a provider app password, not the account
  password.
- **Polls are isolated.** Each poll opens and closes its own connection; a
  failed poll logs and is retried on the next tick — it never throws out of
  `start()`, so a flaky mail host cannot block service boot. A `polling` guard
  prevents overlapping polls.
- **`isConnected()`** reflects the last poll outcome, surfaced on `/health`.

## Known limitations (v1)

- Plain-text bodies only; no inbound attachment handling (a PDF/image arrives
  as text-only context). Telegram/WhatsApp attachment parity is future work.
- Hand-rolled MIME parser is best-effort, justified by owner-only scope.
- Polling latency: inbound mail is seen within one poll interval, not
  instantly. IMAP IDLE is a future optimization.
- Long-running tasks may still emit one interim "still working" email from the
  router's existing timer — acceptable for email cadence.
