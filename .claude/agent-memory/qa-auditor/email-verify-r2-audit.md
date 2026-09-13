# email_verify R2 audit — 2026-09-11 — FAIL (1 Critical)

Scope: uncommitted `email_verify` feature (src/email-verify/*, tool surface, scope/rule-of-two
registration, docs/EMAIL-VERIFY.md). R1 had found C1 breaker latch, C2 sender-side misclassify,
W1-W10. tsc clean; `npx vitest run src/email-verify ... --reporter=dot` = 538 passed / 1 todo.

## Confirmed fixed (re-derived, not trusted)
C1 breaker (no half-open; governance.ts + governance.test.ts:52-69 + verify.test.ts:139-162),
W1 cap-per-connection (`chargeConnection` at verify.ts:256 is inside the ONLY call site of
`this.probe`, verify.ts:262; pinned by the dailyCap:1 test verify.test.ts:234), W2 atomic pace
reservation, W3 4xx catch-all not cached, W4 greylist-envelope block, W6 own-host filter,
W7/W8/W9/W10 present. Release-in-`finally` verified: nothing throwable sits between
`acquire()` resolving (verify.ts:225) and the `try` (227).

## THE CLASS: a pre-empting safety check inherits its phrase list's FALSE POSITIVES
C2's fix moved `has(text, SENDER_SIDE_PHRASES)` to classify.ts:121 — BEFORE the enhanced-code
branch. The list carries bare tokens ("relay", "access denied", "sender", "ptr"). Consequence,
proven e2e with the real threshold (3 strikes / 10 min) against the fake SMTP server:
- `550 5.1.1 <x>: Recipient address rejected: User unknown in relay recipient table`
  (canonical Postfix `relay_recipient_maps`, every backup-MX/gateway) → `blocked`
- `550 5.4.1 Recipient address rejected: Access denied. AS(201806281)`
  (Office 365 Directory-Based Edge Blocking — the default unknown-recipient reply) → `blocked`
- CONTROL `...User unknown in LOCAL recipient table` → `invalid` (correct)
5 invalid mailboxes → 5 `unknown`/`blocked_by_host`, `breakerOpen:true` ⇒ next 30 min every
address on every domain returns `circuit_open`. One word of server prose is the whole delta.
Lesson: when a check is hoisted ABOVE a structurally-correct classifier (RFC 3463 5.1.x), it
must be at least as precise as what it pre-empts. Anchor tokens to their sentence
("unable to relay", "relaying denied"), never bare substrings.

## Other reusable findings
- **A per-STEP timeout is not a wall-clock bound.** `maxVerifyMs` is only checked BETWEEN
  connections (verify.ts:254); inside one probe each of 5-6 SMTP steps gets the full
  `timeoutMs`. Measured: maxVerifyMs=500 → durationMs=1255. Prod worst case ~2.2x (90s→~130s),
  and `antispamcloud` (providers.ts minTimeoutMs 45_000) can burn ~275 s on ONE host.
- **The SSRF enforcement point was the untested line.** smtp-client.ts `connect()`'s custom
  `lookup` is what stops Node re-resolving. EVERY test host is an IP literal
  (`host: "127.0.0.1"`, `exchange: "10.255.255.1"`) and Node SKIPS `lookup` for IP literals ⇒
  zero coverage; deleting `lookup` keeps 538 tests green and reopens DNS rebinding.
  Verified on Node v22.23.2: with `autoSelectFamily:true` the custom lookup DOES receive
  `options.all === true` (`{hints:32, all:true}`); with it false, `all` is undefined.
  `socket.destroy()` on connect timeout cleans up all in-flight attempts (0 orphan handles).
- **Charging a budget before the work can charge for work never done**: 3 unresolvable MX hosts
  = 3 cap charges, 0 TCP sockets (DNS fails inside `resolveTargets`, before `connect`).
- **A 14-positive / 1-negative regex test is a positive-only test.** scope.test.ts:1247 is the
  ONLY negative (`expect(scope("qué hora es")).not.toContain("email_verify")`). Live replay:
  9 of 11 ordinary phrases false-activate — "el cheque rebotó", "limpia la lista de tareas",
  "clean the list of pending items", "valida la dirección fiscal", "revisa el correo que te
  mandé ayer". Cause: bare `rebot\w*` + `\s+(\S+\s+){0,3}?(direcci[oó]n(es)?|address(es)?)`.
- **Tool description contradicted the code AND itself**: "Results are cached 24 h per address;
  re-verifying the same list is free" vs verify.ts:239 `if (result.verdict !== "unknown")` —
  the unknown-heavy list is exactly the one that is NOT free, and the same description says
  "never retry in a loop".
