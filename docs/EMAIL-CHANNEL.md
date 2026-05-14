# Email Channel (SMTP/IMAP)

Status: merged + multi-mailbox. The channel is **multi-account** — Jarvis runs
one mailbox per project, each as its own `email:<id>` channel. Code is
deployed; **activation is operator-pending** — the channel only runs once
`EMAIL_ENABLED=true` and the per-account `EMAIL_*` credentials are set in `.env`
(see Activation below). Owner: messaging subsystem.

## Goal

Let Jarvis converse over email — the owner emails a question, Jarvis runs the
task, Jarvis replies in the same thread from the same mailbox. Functionally
identical to the WhatsApp and Telegram channels: a transport adapter that feeds
inbound messages into the router and sends outbound replies. Unlike those two,
email is **multi-instance**: Jarvis manages several project mailboxes at once.

## Scope decision: client, not server

"SMTP/IMAP server" was scoped down to an **email client channel**, not a
self-hosted mail daemon. Jarvis logs into _existing_ mailboxes (Gmail,
Hostinger, Fastmail, mailcow, etc.):

- **Inbound** — poll IMAP for unseen mail.
- **Outbound** — send via the provider's SMTP relay.

Rejected: running our own SMTP listener on port 25 + IMAP server. That needs a
mail domain, MX/SPF/DKIM/DMARC DNS, TLS certs, spam filtering, and long-lived
public listeners — all blast radius with no benefit. If a self-hosted daemon is
ever wanted, the `ChannelAdapter` boundary is unchanged; only
`channels/email.ts` internals would swap.

## Architecture

Multi-mailbox via per-account channel identity. Each configured mailbox is one
`EmailAdapter` instance registered under a distinct channel name `email:<id>`
(e.g. `email:comunidades`). This rides the router's existing channel-routing:
an inbound message carries `channel: "email:comunidades"` end-to-end, so when
the task completes the router's `sendToChannel(pending.channel, …)` resolves
straight back to the originating mailbox — no email-specific routing logic in
the router. Each account also gets its own conversation thread (the thread key
is the channel name).

```
EMAIL_ACCOUNTS=comunidades,proyecto2
   │
   ├─ email:comunidades  ─ EmailAdapter ─ IMAP poll / SMTP send ─┐
   └─ email:proyecto2    ─ EmailAdapter ─ IMAP poll / SMTP send ─┤
                                                                 ▼
        IncomingMessage(channel:"email:<id>") ──> MessageRouter ──> submitTask()
        OutgoingMessage <── sendToChannel("email:<id>") <── task.completed event
```

- `EmailAdapter implements ChannelAdapter` (`src/messaging/channels/email.ts`),
  constructed from a `MailboxConfig`. `parseEmailAccounts()` reads
  `EMAIL_ACCOUNTS` + the per-account `EMAIL_<ID>_*` vars and **throws on any
  misconfiguration** so a bad `.env` fails fast at boot.
- `initMessaging()` loops `parseEmailAccounts()` behind `EMAIL_ENABLED=true`,
  creating one adapter per account. Each is `registerChannel()`-ed **before**
  `start()` is awaited: `start()` runs an initial poll, and the `onMessage`
  handler must already be attached or boot-time unseen mail is consumed and
  dropped (audit fix, PR #25).
- Router touch points are minimal: `ChannelName` gained `` `email:${string}` ``;
  `getOwnerAddress()` prefers `adapter.ownerAddress` (each account owns its own
  owner mapping); the synchronous "working on it…" ACK is skipped for any
  `email*` channel (email is async — an ACK email per message is noise);
  `hydrateThreadIfNeeded()` keeps the full `email:<id>` key instead of
  splitting on `:`.
- All routing, scoping, enrichment, threading, feedback detection otherwise
  stay in the router. The adapter is pure transport.

### Zero new dependencies

The codebase invariant forbids new deps without discussion. IMAP, SMTP, and
MIME are implemented as minimal raw-protocol clients over Node's `tls` module
— consistent with the "raw fetch to OpenAI-compatible endpoints" ethos. The
pure protocol helpers live in `src/messaging/email-mime.ts` and are unit tested
with no network.

This is deliberately a _minimal_ implementation, not a general MUA. Owner-only
filtering keeps the parse surface small: each mailbox only reads mail from one
known sender. If the team later approves dependencies, `imapflow` +
`nodemailer` + `mailparser` would be the production-grade swap — again behind
the unchanged `ChannelAdapter` boundary.

## Components

| File                                   | Responsibility                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/messaging/email-mime.ts`          | Pure helpers: RFC822 parse, MIME multipart text extraction, RFC2047 / base64 / quoted-printable codecs, outbound MIME builder. No I/O. |
| `src/messaging/channels/email.ts`      | `MailboxConfig`, `parseEmailAccounts()`, and `EmailAdapter` — raw IMAP poll loop + raw SMTP send over TLS, owner filtering, threading. |
| `src/messaging/formatter.ts`           | `formatForEmail()` — strips markdown decoration to clean plain text.                                                                   |
| `src/messaging/types.ts`               | `ChannelName` gains `` `email:${string}` ``; `ChannelAdapter` gains optional `ownerAddress`.                                           |
| `src/messaging/router.ts`              | `getOwnerAddress` per-account, `email*` ACK skip, `email:<id>` hydration key.                                                          |
| `src/messaging/index.ts`               | `EMAIL_ENABLED` gate → one adapter per `parseEmailAccounts()` entry.                                                                   |
| `src/messaging/channels/email.test.ts` | `parseEmailAccounts()` validation + `EmailAdapter` identity tests.                                                                     |

## Inbound flow (per account)

1. Every `pollIntervalMs` (default 60s), open a TLS IMAP connection. The socket
   carries its own `setTimeout` idle guard so a host that connects then goes
   silent cannot leak the socket past the operation ceiling (audit fix, PR #25).
2. `LOGIN`, `SELECT INBOX`, `UID SEARCH UNSEEN FROM <ownerAddress>` (capped at
   20 per poll). The search is scoped to the owner **server-side**: non-owner
   mail is never fetched and never flagged `\Seen`, so the channel does not
   mutate the read state of other mail in a shared mailbox (audit fix, PR #25).
3. For each UID: `UID FETCH <uid> (BODY.PEEK[])`, parse the RFC822 literal.
4. Filter: `handleRawEmail()` re-checks `From` against the account's
   `ownerAddress` as defense-in-depth — IMAP `FROM` search is a substring match
   and can over-match.
5. Extract a plain-text body (prefer `text/plain` MIME part; fall back to
   stripped HTML), strip the quoted reply tail.
6. Emit an `IncomingMessage` with `channel: "email:<id>"`. The text is prefixed
   `[Cuenta: <id> (<from-address>) | Asunto: <subject>]` — the account `id` is
   the stable project identifier (same token as the channel name, tags and
   logs), with the address in parens for context. Thread context
   (`Message-ID`, `References`, `Subject`) is recorded per account.
7. `UID STORE <uid> +FLAGS (\Seen)` so it is never reprocessed. An in-memory
   processed-id set is a second guard if the flag store fails.

`BODY.PEEK[]` is used (not `BODY[]`) so the fetch itself does not set `\Seen` —
the flag is set explicitly only _after_ the message is handed to the router.

## Outbound flow

`task.completed` → router → `sendToChannel("email:<id>", …)` → the matching
`EmailAdapter.send()`:

1. `formatForEmail()` the result text.
2. Look up thread context for the recipient; build a reply with `In-Reply-To` +
   `References` + `Re:` subject so it lands in the same thread. First contact
   with no context → fresh subject.
3. Body is base64 `Content-Transfer-Encoding` — sidesteps dot-stuffing,
   bare-LF, and line-length pitfalls; UTF-8 safe.
4. SMTP over implicit TLS: `EHLO`, `AUTH LOGIN`, `MAIL FROM`, `RCPT TO`,
   `DATA`, `QUIT` — from the account's own `fromAddress`.

## Configuration

`EMAIL_ENABLED` gates the channel. `EMAIL_ACCOUNTS` is a comma-separated list
of account ids (each `[a-z0-9_]+`). Every id `ID` carries its own
`EMAIL_<ID>_*` block (the id is uppercased for the env-var infix). Channels
read `process.env` directly — no `Config` change.

| Var (per account `<ID>`)      | Required | Default     | Notes                                        |
| ----------------------------- | -------- | ----------- | -------------------------------------------- |
| `EMAIL_ENABLED`               | —        | `false`     | Global gate.                                 |
| `EMAIL_ACCOUNTS`              | yes      | —           | Comma list of account ids.                   |
| `EMAIL_<ID>_IMAP_HOST`        | yes      | —           | e.g. `imap.hostinger.com`.                   |
| `EMAIL_<ID>_IMAP_PORT`        | —        | `993`       | Implicit TLS.                                |
| `EMAIL_<ID>_SMTP_HOST`        | yes      | —           | e.g. `smtp.hostinger.com`.                   |
| `EMAIL_<ID>_SMTP_PORT`        | —        | `465`       | Implicit TLS.                                |
| `EMAIL_<ID>_USERNAME`         | yes      | —           | Login for both IMAP and SMTP.                |
| `EMAIL_<ID>_PASSWORD`         | yes      | —           | App password — keep in `.env`, never commit. |
| `EMAIL_<ID>_ADDRESS`          | —        | `_USERNAME` | `From:` address.                             |
| `EMAIL_<ID>_OWNER_ADDRESS`    | yes      | —           | Only mail from this sender is processed.     |
| `EMAIL_<ID>_POLL_INTERVAL_MS` | —        | `60000`     | IMAP poll cadence.                           |

Any missing required var, an invalid or duplicate id, or a port / poll
interval that is present but not an integer in range makes
`parseEmailAccounts()` throw at boot with a precise message. Absent optional
vars fall back to the defaults above; present-but-garbage values fail fast.

## Security / robustness

- **Owner-only, server-side.** Each account's IMAP search is scoped
  `FROM <owner>` so non-owner mail is never fetched or flagged;
  `handleRawEmail()` re-checks the sender as a second layer — same trust model
  as the Telegram owner-chat filter.
- **Credentials** stay in `.env`. Use a provider app password, not the account
  password.
- **Polls are isolated.** Each poll opens and closes its own connection; a
  failed poll logs and is retried on the next tick — it never throws out of
  `start()`, so a flaky mail host cannot block service boot. A `polling` guard
  prevents overlapping polls, and each socket has a `setTimeout` idle guard so
  a hung connection is destroyed rather than leaked. Accounts are independent —
  one bad mailbox does not affect the others.
- **Fail-fast config.** `parseEmailAccounts()` throws on a bad `.env` rather
  than silently running fewer mailboxes than intended.
- **`isConnected()`** reflects the last poll outcome per account, surfaced on
  `/health` keyed by `email:<id>`.
- **No boot-time message loss.** Each adapter is registered with the router
  before its initial poll runs, so mail unseen at service start is routed, not
  silently consumed.

### Audit (PR #25)

Reviewed before merge. Three issues found and fixed in the same PR: boot-time
message loss (register-before-start ordering), socket leak on a hung host
(per-socket idle timeout), and shared-mailbox read-state mutation (server-side
`FROM` scoping). The multi-mailbox refactor that followed preserves all three
fixes.

## Known limitations

- Plain-text bodies only; no inbound attachment handling (a PDF/image arrives
  as text-only context). Telegram/WhatsApp attachment parity is future work.
- Hand-rolled MIME parser is best-effort, justified by owner-only scope.
- Polling latency: inbound mail is seen within one poll interval, not
  instantly. IMAP IDLE is a future optimization.
- Long-running tasks may still emit one interim "still working" email from the
  router's existing timer — acceptable for email cadence.
- Per-account thread context is last-write-wins: if the owner sends a second
  email to the same mailbox before the first task replies, the reply threads
  under the later message.

## Visibility to Jarvis

Jarvis's static identity prompt (`identitySection()` in
`src/messaging/prompt-sections.ts`) has a `## Correo electrónico` section: it
tells Jarvis that a message starting with `[Cuenta: <id> (<address>) | Asunto:
...]` arrived by email, that the account `id` identifies which project mailbox
it came in on, that email is async (answer once, completely, no "working on it"
acks),
and that the reply goes back automatically from that same account in-thread. It
also reminds him the `gmail_*` tools remain available for reading/searching/
sending mail on the project accounts — the inbound _channel_ and the outbound
_tools_ are distinct surfaces.

## Activation

The code ships disabled. To turn the channel on, the operator sets in `.env` —
one block per mailbox:

```
EMAIL_ENABLED=true
EMAIL_ACCOUNTS=comunidades,proyecto2

EMAIL_COMUNIDADES_IMAP_HOST=imap.hostinger.com
EMAIL_COMUNIDADES_SMTP_HOST=smtp.hostinger.com
EMAIL_COMUNIDADES_USERNAME=comunidades@mexiconecesario.org.mx
EMAIL_COMUNIDADES_PASSWORD=<provider app password>
EMAIL_COMUNIDADES_OWNER_ADDRESS=<only this sender is processed>
# optional: EMAIL_COMUNIDADES_ADDRESS / _IMAP_PORT / _SMTP_PORT / _POLL_INTERVAL_MS

EMAIL_PROYECTO2_IMAP_HOST=...
# ...one block per id listed in EMAIL_ACCOUNTS
```

then `./scripts/deploy.sh`. Verify with `journalctl -u mission-control` for
`[messaging] Email channel active — N mailbox(es)` and per-account
`[email:<id>] Channel active`, and check `/health` for the `email:<id>` channel
statuses. `.env` is permission-protected on the VPS, so this step is
operator-only — Claude cannot set the credentials.
