# email_verify R5 (delta) audit — 2026-09-11 — FAIL (1 Critical)

Scope: R4 folds only (C-1 short HELO, W-1 no-account phrase, W-2 4xx strike, W-3 scope,
W-4 skipped rows, W-5 buffer cap, S-1/S-2, logging, RE_ENHANCED anchor).
`npx tsc --noEmit -p .` exit 0. Scoped vitest: 11 files, 574 passed / 1 todo, exit 0.
3x repeat of the email-verify scope: 161/161 each time, no flake.

## THE CLASS: a phrase widened to catch ONE reply now matches replies it was never meant to
R3's Critical was the mirror ("a phrase written FOR one reply that cannot match it": Yahoo's
domain sat mid-phrase). The R4 fix replaced two literals with
`RE_NO_ACCOUNT = /(?:doesn'?t|does not|do not) have an? [\w.-]* ?(?:account|mailbox|buz[oó]n|cuenta)/`
(classify.ts:113). The wildcard slot accepts ANY word, `do not` is new breadth, and there is
NO SUBJECT ANCHOR — so a SENDER-side or RELAY refusal that carries no SENDER_SIDE token lands
on the `invalid` branch. E2E vs the fake server: `550 5.7.0 Sender does not have a mailbox on
this server`, `550 5.7.1 We do not have an account for this domain`, `550 5.7.1 The sender
doesn't have a valid account` -> all `invalid / mailbox_rejected`, and **cached 24 h**
(2nd run = 1 TCP conn). Control `550 5.7.1 Sender verify failed` -> `blocked` (correct), Yahoo
target still `invalid`. Verified fix: anchor the SUBJECT and restrict the slot to a domain —
`/(?:this |the )?(?:user|recipient|address|mailbox|e-?mail|usuario|destinatario) (?:doesn'?t|does not) have an? (?:(?:[\w-]+\.)+[a-z]{2,} )?(?:account|mailbox|buz[oó]n|cuenta)/`
= 0/9 misclassified vs CURRENT 5/9.
Lesson: when a fix WIDENS a matcher, replay the widened form against the *other* side of the
axis it discriminates (here: sender-side text), not only against its own target.

## Other reusable findings
- **A guard that only checks SHAPE misses the likeliest bad VALUE.** `envelopeConfigError`
  refuses a dotless HELO, so it catches `mail` and `(none)` — but `hostname -f` returning
  `localhost.localdomain` HAS a dot and sails through. PATH-shim run: wire =
  `EHLO localhost.localdomain | MAIL FROM:<postmaster@localhost.localdomain>`. Enumerate the
  bad values the guard's own NEW SOURCE can produce, not just the value that motivated it.
  (Live box is fine: `hostname -f` = `mail.eurekams.net`, /etc/hosts 127.0.1.1 alias `mail`.)
- **Adding a sibling alternation branch does not inherit the sibling's guard.** W-3 put
  `(?=\s*(\?|$))` on `(correos|emails) (es|son|is|are) (válidos|real...)` but the NEW branch
  `(are|is) (these|this|the|those) (emails|correos) (valid|real)` (scope.ts:852) has none:
  "are these emails valid for the invoice?" and "these emails are valid, do not worry" fire.
  Same fix ALSO over-tightened the other direction: `(correos) existen?(?=\s*(\?|$)|\s+o\s)`
  kills "quiero saber si estos correos existen antes de la campaña". 6/10 fresh natural
  positives miss; for a `deferred: true` tool the scope regex IS the discoverability.
- **Anchoring a structural parser un-masks the phrase table behind it.** RE_ENHANCED now reads
  only `text.slice(0,16)`, which correctly kills the R4 target (`452 Too many recipients from
  4.2.2.1`: full_inbox -> temp_failure). But the trailing-`(#5.x.x)` family (qmail/Plesk) loses
  its code: `550 Invalid User (#5.1.1)` and `550 User not found (#5.1.1)` go invalid ->
  unknown_reply, `550 Account has been suspended (#5.2.1)` disabled -> unknown_reply. Root
  cause is the TABLE, not the anchor — the same texts with no code already returned
  unknown_reply. And `unknown` is never cached (verify.ts:294) => re-probed + re-charged every
  run. Missing phrases: "user not found", "invalid user", "suspend" (only the ES stem
  "suspendid" is present), "mailbox is full" (only "mailbox full").
  Only real CLASS change: qmail `553 ... rcpthosts (#5.7.1)` blocked -> unknown_reply — an
  improvement (no breaker strike for a per-domain condition).
- **The >=500 strike gate is clean.** Exactly two `recordBlocked()` sites (verify.ts:416 RCPT,
  verify.ts:425 envelope), both gated; no 4xx path strikes. A garbage banner never completes a
  reply framing, so it lands on `smtp_unreachable` (never `blocked`) — 5 consecutive burn 5
  connections with breakerOpen=false the whole way (pre-existing: `unreachable` never struck).
- **`getSharedVerifier()` is lazy** — the only caller is email-verify.ts:93 inside `execute()`,
  so the 2 s `execFileSync("hostname","-f")` does NOT run at service boot. Measured 2005 ms of
  SYNCHRONOUS event-loop block with a hung `hostname` shim: a one-shot whole-process stall on
  the first tool call, not a boot hazard.
- **SMTP injection is closed twice over**: `checkSyntax` rejects whitespace + non-printable
  ASCII (syntax.ts:35-36) and `assertSafeToken` (smtp-client.ts:74-76) re-checks
  `[\r\n\0 <>]` on toEmail/fromEmail/heloName. A CRLF-bearing `EMAIL_VERIFY_HELO` passes
  `envelopeConfigError` but throws at the socket.
- **Tests touch no external network**: only `resolveMxTargets("localhost")` (/etc/hosts) and
  `("mx.does-not-exist.invalid")` (RFC 2606, measured 1-9 ms locally), `os.networkInterfaces()`,
  `hostname -f`; everything else is 127.0.0.1 loopback or an injected seam.
