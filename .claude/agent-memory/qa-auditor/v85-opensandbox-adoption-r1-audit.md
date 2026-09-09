# OpenSandbox sandbox-runtime adoption — R1 audit (2026-08-16)

**Scope:** `SANDBOX_BACKEND` seam (`sandbox-backend.ts`), `opensandbox-backend.ts`,
`container/opensandbox/*` (TOML + fw script + units), `scripts/install-opensandbox.sh`,
`scripts/opensandbox-e2e.ts`, `mc-ctl sandboxes` + `smoke sandbox`, SDK `@alibaba-group/opensandbox@0.1.11`.
Uncommitted working tree. Verdict: **FAIL** (2 Critical). tsc 0 errors; vitest 17 files / 374 tests pass.

## Doctrine crumbs

### A wall-clock cap is NOT an inactivity cap — porting a timeout across runtimes silently changes its KIND
`container.ts` `timeoutMs` is an **activity** timer: `resetTimer()` fires on every sentinel,
so a heartbeating worker runs unbounded (`nanoclaw-runner.ts:116` states this explicitly:
"acts as inactivity guard, not wall-clock cap"). The OpenSandbox port reuses the same
number for two **absolute** server-side caps — `commands.run({timeoutSeconds: timeoutMs/1000+60})`
(SDK doc: "server will terminate the command when reached") and the sandbox TTL
(`timeoutMs/1000+120`). Same variable, opposite semantics. Observed nanoclaw tail is
400–870s vs the new 960s hard kill → ~10% headroom on a distribution that already reaches 870s.
**Check:** when a timeout crosses a runtime boundary, ask whether the NEW enforcer resets.

### A DOCKER-USER guard scoped `-i <public-iface>` protects only the EXTERNAL edge
`opensandbox-fw.sh` inserts `-i eth0 … --ctorigdstport 40000:40999 -j DROP`. Verified present in
BOTH iptables and ip6tables, and eth0 IS the v4+v6 default-route NIC. But DOCKER-USER sits in
FORWARD: container→container traffic arrives `-i docker0` / `-i br-*` and never matches. Docker's
own DNAT rule is `! -i docker0` (excludes only the sandbox's own bridge), and ICC is on by default,
so any other container on the box reaches an unauthenticated execd. The sandboxes mount
`/root/.config/gh` + `/root/.claude/.credentials.json`. **Check:** for any iptables mitigation,
enumerate every ingress interface class (public / other-bridge / same-bridge / loopback), not just
the one in the threat statement.

### `exitCode: null` means UNKNOWN — guarding with `typeof x === "number" && x !== 0` fails OPEN
SDK `inferForegroundExitCode` (commandsAdapter.ts:95) returns `null` when the stream ends with
neither a `complete` nor an `error` event. `opensandbox-backend.ts:339` then falls through to
`{status:"success", result: stdout.trim()}`. The docker path fails CLOSED on the same ambiguity
(`code !== 0` is true for `null`). **Check:** a tri-state (0 / non-zero / unknown) needs three
branches; folding unknown into the success default inverts the safe direction.

### Prefix allow-lists: the SERVER was boundary-aware, the CLIENT is not
`opensandbox-backend.ts:129` / `container.ts` use raw `hostPath.startsWith(p)` →
`/root/.config/ghost` passes. `opensandbox_server/services/validators.py:459` uses
`norm == prefix || norm.startswith(prefix + "/")` + realpath + `..` rejection. So on the
opensandbox path the server backstops the client; on the DEFAULT docker path the loose client
check is the only gate. Also: `sandbox.toml allowed_host_paths` is NARROWER than
`VOLUME_ALLOWED_PREFIXES` (`/tmp/jarvis-downloads` vs `/tmp/`) despite a comment claiming it "mirrors" it.

### Verified-clean (do not re-litigate in R2)
- `mode: 600` on `files.writeFiles` is CORRECT — SDK README:143 shows `mode: 644` (octal digits in a decimal int).
- Docker path is byte-identical: `killContainer(handle)` → `handle.kill()`, and `spawnContainer`'s
  `kill` already is `killContainer({name, process, result, kill:()=>{}})`. Dispatcher/slots untouched.
- No 5-min silent-worker path: `ConnectionConfig.initializeTransport` builds `_sseFetch` with
  `timeoutSeconds: 0` (no request timeout on the stream); undici default bodyTimeout 300s vs the
  workers' unconditional 60s `setInterval` heartbeat.
- `requestTimeoutSeconds: 60` does NOT abort the SSE body — `createTimedFetch` clears the timer in
  `finally` once headers land. `readyTimeoutSeconds` is a client poll loop (sandbox.ts:735), not one long call.
- No secret in `sandbox.toml` (key lives in `/etc/opensandbox/api.env`, 600, never printed);
  `console.log` prints only name/sandbox-id/image; Dockerfile does not COPY `container/`.
- keep=true derivative names in the TOML match `build-opensandbox-images.sh` exactly
  (`mc-opensandbox-execd:v1.0.22` / `mc-opensandbox-egress:v1.1.6`); every TOML key is a real
  pydantic field in server 0.2.2 config.py.
- SDK closes its undici Agent on every `Sandbox.create` failure path (sandbox.ts:382/507/528/588) — no leak.

### Live-state gaps worth re-checking
- `SANDBOX_BACKEND` / `OPENSANDBOX_API_KEY` are absent from the live mission-control env
  (`/proc/<MainPID>/environ`) and `mission-control.service.d/opensandbox.conf` does NOT exist,
  though adoption-doc §6 speaks of it as installed. Ships dormant — correct — but the doc overstates.
- `mc-ctl sandboxes` reads the flag via `sudo tr … < /proc/$pid/environ`; the redirect is done by
  the CALLING shell, so any read failure prints "docker (default)" — a false-negative on the one
  readout used to confirm the flip.
