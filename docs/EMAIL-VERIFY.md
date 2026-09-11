# email_verify — SMTP mailbox verification (closed box)

> Added 2026-09-11. Engine: `src/email-verify/`. Tool surface: `src/tools/builtin/email-verify.ts`.
> Zero new dependencies (`node:net`, `node:dns`, `node:crypto`).

## What it does

Answers "does this mailbox exist?" without sending mail, per address:

```
syntax → typo suggestion → MX (null-MX, implicit-MX) → provider rules
  → governed SMTP probe: banner · EHLO/HELO · MAIL FROM · RCPT TO <random> (catch-all) · RCPT TO <target> · QUIT
  → classify (RFC 3463 enhanced codes first, phrase table second)
  → verdict safe | risky | invalid | unknown  + machine-readable reason
```

| Verdict   | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `safe`    | server accepted `RCPT TO`, nothing lowers confidence                                     |
| `risky`   | deliverable but catch-all domain · role account · full inbox · disposable domain          |
| `invalid` | bad syntax · no mail host (nxdomain / null MX / no records) · server rejected the mailbox |
| `unknown` | no trustworthy answer: greylisted · temporary_failure · blocked_by_host · smtp_unreachable · unrecognized_reply · dns_error · smtp_skipped · daily_cap_reached · circuit_open · verify_deadline · batch_deadline · internal_error |

`unknown` is never "bad": it means the probe could not prove anything. A false `invalid` is
the worst outcome for a list clean, so **a 4xx reply, or any reply about the sender / our host,
is never classified invalid**; a 5.7.x policy code rejects a contact only when its text carries
an explicit mailbox phrase ("user unknown", "no existe", …) and no sender-side token.

## Provenance and licence

Design, verdict contract, provider rules and the reply-phrase tables are ported from
[reacherhq/check-if-email-exists](https://github.com/reacherhq/check-if-email-exists)
(Rust, AGPL-3.0 / commercial dual licence — review memo `reference_check_if_email_exists`).
mission-control is private and not distributed, so no AGPL obligation attaches today. **If this
module is ever published or exposed as a service to third parties, revisit the licence first.**

Improvements over the original: structured enhanced-status classification before phrases;
MX failover across records; RFC 7505 null MX + RFC 5321 implicit MX; per-domain MX and
catch-all caches (a batch costs one catch-all probe per domain); greylist retry keyed on the
4xx class; es-MX reply phrases; governance below; integration tests against a real in-process
SMTP server rather than socket mocks; no headless-browser paths (Hotmail/Yahoo consumer
answer SMTP honestly enough — live probe 2026-09-11: hotmail.com `550 5.5.0` on an unknown user).

## Governance (safety-critical)

Every probe leaves **this box's mail IP** (`mail.eurekams.net`, the IP Stalwart delivers from).
`src/email-verify/governance.ts`:

| Guard                    | Default | Env                          |
| ------------------------ | ------- | ---------------------------- |
| Daily cap on **connections** (every MX host tried and every greylist retry is charged; Mexico City day; in-memory) | 500 | `EMAIL_VERIFY_DAILY_CAP` |
| Global concurrency       | 4       | `EMAIL_VERIFY_CONCURRENCY`   |
| Gap between connections to the same MX host (slot reserved atomically: concurrent workers are staggered, never simultaneous) | 1500 ms | `EMAIL_VERIFY_HOST_GAP_MS` |
| Breaker                  | 3 "blocked / needs rDNS" replies in 10 min → every probe returns `circuit_open` for 30 min, then probing resumes (no half-open state that can latch) | (constants) |
| Wall-clock bound per address (all hosts + retries; every SMTP read and the TCP connect are clipped to what is left) | 90 s | `VerifierOptions.maxVerifyMs` |
| Batch size per tool call | 100 (`verbose` honoured only for ≤ 10); one call is bounded to 240 s, rows not started by then return `batch_deadline` | (constant) / `VerifyOptions.maxBatchMs` |
| Per-step SMTP timeout    | 10 s (45 s floor for `antispamcloud` MX, per `providers.ts`); TCP connect capped at 5 s, Happy-Eyeballs across the pre-filtered IPv4/IPv6 list (300 ms family fallback); every step is also clipped to the address deadline | `EMAIL_VERIFY_TIMEOUT_MS` |
| HELO name                | short `os.hostname()` (`mail`) resolved to its FQDN through `/etc/hosts` (= `mail.eurekams.net`, matches rDNS; no process spawned). **Structural guard:** a HELO that is not a public FQDN (no dot, `localhost.localdomain`, `.local`, `[1.2.3.4]`, …) or a MAIL FROM that is not a routable address disables every probe with reason `misconfigured: …` (logged at error on first use) rather than putting `EHLO mail` on the wire | `EMAIL_VERIFY_HELO` |
| MAIL FROM                | `postmaster@<helo minus first label>` = `postmaster@eurekams.net`. **Operator prerequisite: create `postmaster@eurekams.net` in Stalwart** (RFC 5321 §4.5.1 requires it; checked 2026-09-11: `550 5.1.2 Mailbox does not exist`) — until then cPanel/Exim sender-callout hosts answer `blocked`. Why not the null sender `<>`: Microsoft's consumer MX answered the mailbox status for postmaster@ and refused a `<>` probe in the live test. `EMAIL_VERIFY_FROM=""` selects `<>` explicitly | `EMAIL_VERIFY_FROM` |

The daily counter lives in memory: a service restart resets it (accepted; persisting it is a
queued follow-up). A connection is charged only once DNS, host pacing and the deadline have all
passed — nothing is charged unless a packet can leave the box. `safe`/`risky`/`invalid` results are cached 24 h per address; `unknown` is never
cached, so re-running an all-unknown list re-probes and spends budget again. The tool reports `budget` on every call and a top-level `halted` reason when
a batch hit the cap or the open breaker — the description tells the model to stop, not retry.

MX hosts that resolve only to private, loopback or **this box's own interface** addresses are
refused (`src/lib/url-safety.ts` `filterSafeAddresses` + `os.networkInterfaces()` in
`smtp-client.ts`). The socket never re-resolves the hostname (the filtered list is fed through a
custom `lookup`), so a flipping DNS record cannot bypass the filter. Consequence: addresses at
`eurekams.net` come back `unknown` — check those in Stalwart.

**Classification safety rule**: a 4xx reply, or any 5xx that talks about the sender, our HELO,
our IP or its reputation, is never `invalid`. Such replies are `blocked` (a breaker strike only
when the code is 5xx — a 4xx about us stops that address but cannot open the breaker) or
`temp_failure`/`greylisted` (retry later). Only mailbox-status codes (5.1.x, 5.2.x)
and explicit mailbox phrases reject a contact. Round-1 audit inputs that used to leak through
("5.7.1 Sender domain could not be found in DNS", "el registro PTR no existe para su IP", …)
are pinned in `classify.test.ts`.

## Tool contract

`email_verify({ emails: string[] (1-100), skip_smtp?, catch_all_probe?, verbose? })` →

```json
{
  "summary": { "total": 3, "safe": 1, "risky": 0, "invalid": 2, "unknown": 0 },
  "budget": { "usedToday": 3, "dailyCap": 500, "breakerOpen": false },
  "results": [
    { "email": "ana@clinic.mx", "verdict": "safe", "reason": "deliverable", "provider": "google_workspace" },
    { "email": "contacto@gmial.com", "verdict": "invalid", "reason": "nxdomain", "suggestion": "contacto@gmail.com" }
  ]
}
```

`verbose:true` returns the full `VerifyResult` (MX hosts, SMTP host, reply code/text, timings).
Rows are keyed by `email` (normalized) in domain-interleaved order, not input order. Rows the
batch never started (`batch_deadline`) keep a truthful `syntax` block and are never cached.
Deferred tool, scope group `utility` (regex covers ES/EN verbs + plurals, "existe este correo",
"limpia/depura la lista", "bounce"/"are dead", address-literal + "existe/es real", and the `email_verify` name; 28 positive and 28 negative phrases
pinned in `scope.test.ts`). Rule-of-Two class **A** (server free text in, no private data), `readOnlyHint`.

## Programmatic use

```ts
import { EmailVerifier, verifierOptionsFromEnv } from "../email-verify/index.js";
const v = new EmailVerifier(verifierOptionsFromEnv());
const { results, summary } = await v.verifyMany(list);
```

Test seams on `VerifierOptions`: `mxLookup`, `resolveTargets`, `probe`, `allowPrivateAddresses`, `now`, `sleep`.
`src/test-utils/fake-smtp-server.ts` is a scripted SMTP server (per-address replies, delay,
drop-on-connect) — the integration tests in `src/email-verify/verify.test.ts` drive real sockets.

## Live smoke (2026-09-11, from this box)

| Address                                     | Verdict | Reply                                            |
| ------------------------------------------- | ------- | ------------------------------------------------ |
| fake mailbox @gmail.com                      | invalid | `550 5.1.1 … does not exist`                      |
| real mailbox @gmail.com                      | safe    | `250 2.1.5 OK`                                    |
| fake mailbox @hotmail.com                    | invalid | `550 5.5.0 … mailbox unavailable`                 |
| `contacto@gmial.com` (typo, dead MX)         | unknown | connect timeout (5 s) → suggestion `contacto@gmail.com` |
| `postmaster@eurekams.net` (own host)         | unknown | refused by the own-host guard, by design          |

## Follow-ups (queued in `docs/planning/next-sessions-queue.md` §2026-09-11)

- Disposable-domain list as a data file (today ~60 hand-picked domains + `EMAIL_VERIFY_EXTRA_DISPOSABLE`).
- Persist the daily counter (survives restarts).
- Dogfood script over the doctoralia list (1,007 addresses ≈ 2 days at the default cap).
- `npm run eval:gate -- --run` for the new description (operator, ~$5) per CLAUDE.md.
