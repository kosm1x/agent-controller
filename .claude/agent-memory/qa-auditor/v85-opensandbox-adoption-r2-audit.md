# OpenSandbox adoption — R2 (fold verification), 2026-08-16

Scope: only the folds applied after R1 (C1 wall-clock, C2 lateral execd, W1 fail-open exit,
W2–W6, recs). Verdict **MERGE-READY WITH WARNINGS** — 0 Critical, 5 Warnings.
`npx tsc --noEmit` → 0. `npx vitest run src/runners/ src/dispatch/dispatcher.test.ts` → 0
(17 files / 376 tests).

## What was proven closed

- **C1** — `commands.run` no longer passes `timeoutSeconds`; TTL renewed via
  `sandbox.renew(ttl)` from `resetTimer()`. Verified against the SDK
  (`dist/index.js:915` — `expiresAt = now + timeoutSeconds`, strictly monotonic) and
  against the LIVE server 0.2.2: `docker_service.renew_expiration` validates only
  `ensure_future_expiration` — **no `max_sandbox_timeout_seconds` clamp on renew**, so
  indefinite renewal is legal. TTL headroom is 8.5× (1020 s TTL vs ≤120 s worst renew gap).
- **W1** — `exec.exitCode == null && !exec.complete`. SDK `inferForegroundExitCode`
  (chunk-67D4V6XL.js:320) returns 0 on `complete`, null on a cut, and `run()` passes
  `inferExitCode = !opts?.background` (always true here). Branch order is correct.
- **C2** — LIVE: 3 rules in `iptables -S DOCKER-USER` and 3 in ip6tables, `br_netfilter`
  loaded, both bridge-nf-call sysctls = 1, `-A FORWARD -j DOCKER-USER` is FORWARD's
  first rule. Installed script byte-identical to the repo copy.

## Doctrine crumbs

- **A `grep -c` that legitimately returns 0 is a `set -e` landmine.** `mc-ctl:2997-2998`
  counts guard rules with `grep -c` under `set -euo pipefail`; zero matches → exit 1 →
  the whole `cmd_sandboxes` function aborts, so the `INCOMPLETE` branch it guards is
  **unreachable exactly when the guard is gone**. Worse, the W2 per-family skip (ip6tables
  without DOCKER-USER is a *supported* config) makes n6=0 the normal case on such a host.
  Whenever a readout counts the thing it is meant to alarm about, run the zero case.
- **Truncation that "preserves the marker" can delete the bound.** The MAX_RAW_STDOUT rec
  replaced a hard `slice(-MAX)` with `slice(min(keepFrom, len-MAX))`; once an unterminated
  START marker is older than MAX bytes, `keepFrom` wins forever and the buffer grows
  **unbounded**. Simulated and confirmed. Any "keep the head intact" fix to a ring buffer
  needs a second clamp for when the head itself exceeds the cap.
- **A wildcard `-i` with no `-o` is an egress rule, not an ingress rule.**
  `-i br-+ --ctorigdstport 40000:40999 -j DROP` blocks container→*internet* on those ports
  from every user-defined bridge, not just the published-port DNAT path. Scope with `-o`.
- **docker-proxy hairpin is outside DOCKER-USER.** Docker's DNAT rule carries
  `! -i <own bridge>` (verified live on the 8888 rule), so `-i docker0` → hostIP:published
  is NOT DNATed → lands in **INPUT**, where only UFW's default-deny stops it. Any future
  UFW ALLOW inside 40000-40999 silently re-opens lateral execd. A FORWARD-chain guard can
  never cover the hairpin.
- **A probe whose catch-all maps every failure to the PASS string cannot fail.**
  `opensandbox-e2e.ts:136-159` returns `"CLOSED (timeout)"` for any `execFileSync` throw —
  a missing image / deleted network / busy daemon is indistinguishable from a real DROP,
  and only `OPEN` fails the run. No positive control.
- **A structural "no cast" check is weaker than it reads.** TS method-shorthand params are
  bivariant, so `SandboxLike` catches SDK *return*-shape drift but not param drift.
- **The C1 invariant is a 3-file coupling with no test.** `TTL_GRACE_S=120` must exceed
  2× the worker heartbeat interval (60 s, `nanoclaw-worker.ts:164` / `heavy-worker.ts:56`).
  The unit test proves renew *cadence*, not that the TTL cannot lapse (the fake has no TTL).
