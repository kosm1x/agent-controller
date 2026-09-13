# email_verify R3 audit — 2026-09-11 — FAIL (1 Critical)

Scope: uncommitted `email_verify` (src/email-verify/*, tool surface, scope/rule-of-two
registration, docs/EMAIL-VERIFY.md). R1: C1 breaker latch, C2 sender-side misclassify.
R2: C-1 bare "relay"/"access denied", W-A..W-F. tsc clean; scoped run 546 passed / 1 todo.

## R2 folds re-derived (live, not trusted)
C-1 HOLDS: 43-reply corpus — Postfix `relay recipient table` and O365 DBEB
`550 5.4.1 … Access denied. AS(201806281)` both classify `invalid` again.
W-A HOLDS: maxVerifyMs=700 → wall 705 ms against a 300 ms/step server (R2 measured 500→1255).
W-B HOLDS and is now mutation-sensitive: `getent hosts mx.fake.test` exits 2 (NXDOMAIN), so
deleting the custom `lookup` makes smtp-client.test.ts:67 RED. The SSRF line finally has cover.
W-C HOLDS for DNS only (unresolvable → used=0). See the new partial below.
W-D HOLDS: live replay 1/18 FP (was 9/11). W-E, W-F, all 4 recommendations present.

## THE CLASS: a phrase entry written FOR a specific reply that cannot match it
INVALID_PHRASES (classify.ts:54-55) carries `"doesn't have an account"` /
`"does not have an account"` — written for Yahoo/AOL. Yahoo's actual string is
`554 delivery error: dd This user doesn't have a **yahoo.com** account (x@yahoo.com) [0]`:
the DOMAIN sits between "a" and "account", so neither entry matches. Live e2e: verdict
`unknown` / `unrecognized_reply`, and because `unknown` is never cached (verify.ts:243) the
address is re-probed and re-charged on every run (2 runs → 2 TCP conns, used=2). A whole
consumer-provider class silently exits the tool's only job, and providers.ts:71's yahoo note
("repeated 'unknown' means throttled, not invalid") tells the user the wrong reason.
Lesson: for every phrase written to catch ONE known reply, paste that reply verbatim into a
test — an entry that names its target in a comment is not evidence it matches it.

## Other reusable findings
- **Moving a charge past DNS is not the same as moving it past "no packets sent".**
  W-C put `resolveTargets` before `chargeConnection` (verify.ts:266→272), but `paceHost`
  (275) and the deadline re-check (276-277) still sit AFTER the charge. Proven: hostGapMs=400,
  maxVerifyMs=120 → `usedToday` 1→2 while the fake server saw **1** TCP connection total;
  reason `verify_deadline`. Ask "what is the last statement that can return before a packet
  leaves?", not "is DNS before the charge?".
- **A budget clip renames the failure.** `Math.max(1, …)` on the connect budget
  (smtp-client.ts:254) means a probe entered with 3 ms left reports
  `connect: connect timeout after 3ms` → `smtp_unreachable` — a healthy MX host is recorded as
  unreachable because we ran out of clock. Same shape mid-conversation: a connected, talking
  host surfaces as `smtp_unreachable: mail_from: probe budget exhausted` with `smtp: null`,
  discarding the banner we did receive.
- **A 4xx can reach a CACHED verdict.** `full_inbox` is the only 4xx-reachable kind that is
  not `unknown`, and FULL_PHRASES (classify.ts:67) leads with bare `"insufficient"`, so
  `452 4.3.1 Insufficient system storage` (receiving server out of disk) → `risky` /
  `full_inbox` / `fullInbox:true`, cached 24 h (2nd run: 1 TCP conn). RFC 3463 4.3.1 is
  "mail SYSTEM full", not mailbox.
- **The breaker only counts 5xx.** Postfix's rDNS refusals default to 450
  (`450 4.7.25 Client host rejected: cannot find your hostname`) → `temp_failure`, no strike.
  A day with broken rDNS burns the whole 500-connection cap without ever opening the breaker.
- **Exim sender-callout makes MAIL FROM load-bearing.** cPanel/Exim hosts verify
  `postmaster@eurekams.net` during our RCPT; if Stalwart does not accept it, every such host
  replies "Sender verify failed" → `blocked` → 3 strikes → 30 min circuit_open.
- **A deferred tool's scope regex is its discoverability, not a convenience.** 4/10 natural
  asks miss: `checa` (the es-MX form of "check") is absent from `(check|revis\w*)`, and the
  address-literal branch lists `is\s+real` but not `es\s+real`.
