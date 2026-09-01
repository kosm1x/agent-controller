# OpenSandbox as Jarvis's sandbox runtime backend — evaluation + adoption (2026-08-16)

**Status:** SHIPPED behind `SANDBOX_BACKEND` (default `docker` = byte-identical
in-tree path). Host server installed + armed on this VPS; see §6 for the live
state and §7 for the one-line flip / rollback.

Upstream: <https://github.com/opensandbox-group/OpenSandbox> (Alibaba; Apache-2.0;
evaluated at `f8ed873`, 2026-08-15; server `0.2.2` on PyPI, JS SDK
`@alibaba-group/opensandbox 0.1.11`, images `execd v1.0.22` / `egress v1.1.6`).

## 1. What was evaluated

OpenSandbox = a Python FastAPI **lifecycle server** (Docker or Kubernetes
backend) that launches _any_ image, injects a Go **`execd`** daemon (commands /
files / code / PTY / metrics over HTTP + SSE), an optional **egress sidecar**
(DNS proxy + nftables allow-list, credential vault via MITM), TTL expiry that
survives server restarts, snapshots/pause, multi-language SDKs, `osb` CLI, MCP
server, K8s controller (BatchSandbox / Pool).

Jarvis before this change (`src/runners/container.ts`, 438 lines): one
`docker run -i --rm --cap-drop=ALL --security-opt=no-new-privileges --memory 4g
--cpus 2 --pids-limit 512`, stdin-JSON in / sentinel-JSON out, activity
timeout, `docker stop -t 10`; `mission-control:latest` as root on the **default
bridge with unrestricted egress**; `INFERENCE_PRIMARY_KEY`, the Claude OAuth
file and `gh` config are inside the sandbox. Volume: nanoclaw 54 tasks / 90 d
(21 done, 32 failed — routing/timeouts/evaporated work, not the substrate);
containerized heavy dormant. Open pain: zombie containers outliving killed tasks
(queue 2026-07-14), `MAX_CONCURRENT_CONTAINERS` inert, V8.4 has to **skip**
shell gates for container tasks (work tree ≠ host tree).

## 2. Verdict — adopt as a _backend behind a seam_, not as a platform

| Dimension                                                  | `docker run` (before)                                          | OpenSandbox Docker runtime                                                                                                                                                        | Net                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Egress control                                             | none (bridge; any host incl. host services via 172.17.0.1)     | sidecar default-deny + FQDN allow-list (`dns+nft`)                                                                                                                                | **gain** — exfil defence for the keys we ship into the box                                                              |
| Lifecycle                                                  | `--rm` + hourly `mc-*` prune; container survives a killed task | server-owned TTL/kill, `renew`, `list`, restart-safe timers                                                                                                                       | **gain** — closes the zombie class structurally                                                                         |
| Exec surface                                               | one stdin→stdout run                                           | `execd`: many commands, files, metrics, streaming                                                                                                                                 | **gain** — V8.4 gate checks can later run _inside_ the sandbox (today's W1 skip)                                        |
| Hardening                                                  | cap-drop ALL, pids 512                                         | configurable (set to ALL / 512), no-new-privileges, seccomp/AppArmor, gVisor option                                                                                               | parity as configured; gVisor later (`runsc` systrap — KVM guest, no nested virt)                                        |
| Secrets                                                    | env + ro mounts                                                | credential vault (MITM)                                                                                                                                                           | **not usable yet** for the LLM channel (mitmproxy truncates SSE >1 MB; Claude auth is a rotating OAuth token) — skipped |
| Ops cost                                                   | 0 extra processes                                              | +1 Python service, +2 images, pre-1.0 API                                                                                                                                         | cost                                                                                                                    |
| Exposure                                                   | container publishes no ports                                   | publishes **unauthenticated execd** on `0.0.0.0:<40000-60000>` (hardcoded in `port_allocator.py` + the sidecar path); Docker's iptables bypass UFW (`DOCKER-USER` was empty here) | must ship a DOCKER-USER guard first — done (§4)                                                                         |
| Nightly `docker image prune -af --filter label!=keep=true` | handled (`keep=true`)                                          | hub images pruned nightly                                                                                                                                                         | derived `keep=true` images (§4)                                                                                         |

Adopt: server (Docker runtime, bridge, `127.0.0.1:8098`, API key), `execd`,
egress sidecar (opt-in allow-list), TS backend via the pinned SDK.
Adapt: keep the in-tree `docker run` path as the default backend; same worker,
same sentinel protocol, same mounts / allow-list.
Skip: K8s, code-interpreter image (2.6 GB), Jupyter, MCP server, ingress,
snapshots/pause, credential vault, gVisor (for now).

Honest caveat: this does not move the nanoclaw failure rate by itself — those
failures are routing/timeouts/evaporated work. It buys security posture, a real
lifecycle, and in-sandbox verification capability.

## 3. Shape shipped (code)

- `src/runners/sandbox-backend.ts` — seam. `spawnSandbox(opts)` → `docker`
  (`spawnContainer`) or `opensandbox` (`spawnOpenSandbox`); `SandboxHandle` =
  `{name, result, kill}` (the subset the runners use). Unknown → docker.
- `src/runners/opensandbox-backend.ts` — `Sandbox.create` (image, neutralized
  env, allow-listed volumes → SDK `Volume[]`, `{cpu:"2", memory:"4Gi"}`,
  `timeoutSeconds = ceil(timeout)+120` TTL, `metadata.mc_name`, optional
  `networkPolicy` from `SANDBOX_EGRESS_ALLOW`) → `files.writeFiles(INPUT_PATH,
  mode 600)` → `commands.run('<argv quoted> < INPUT_PATH', {cwd:/app})`
  streamed (`skipAccumulation`) → same sentinel scan as container.ts (delegates
  to `parsePayload`) → resolves exactly once; teardown (`kill()` + `close()`,
  idempotent) on every exit path; activity timeout text identical (`Container
  timed out after Nms`). **Inactivity semantics kept (qa C1):** no execd
  `timeoutSeconds` (it is an absolute wall clock), and the server TTL
  (`timeout+120s`) is RENEWED on every sentinel (throttled 1/min) — a
  heartbeating worker is never wall-clock-killed; a dead mission-control stops
  renewing and the server reaps at last-activity + TTL. A stream that ends with
  neither `complete` nor `error` fails closed (qa W1).
- Runners: `nanoclaw-runner.ts` / `heavy-runner.ts` call `spawnSandbox` and
  `handle.kill()`; `container.ts` only exports `SANDBOX_NEUTRALIZED_ENV` +
  `VOLUME_ALLOWED_PREFIXES` (shared with the backend). Docker path unchanged.
- Config: `sandboxBackend` (`SANDBOX_BACKEND`), `opensandboxUrl`
  (`OPENSANDBOX_URL`, default `127.0.0.1:8098`), `opensandboxApiKey`
  (`OPENSANDBOX_API_KEY`), `sandboxEgressAllow` (`SANDBOX_EGRESS_ALLOW`, csv).
- Ops: `./mc-ctl sandboxes` (live backend flag by name-presence, server health,
  DOCKER-USER guard, live `sandbox-*` and `mc-*` containers).
- Tests: `sandbox-backend.test.ts` (selection), `opensandbox-backend.test.ts`
  (helpers, round-trip, heartbeat/timeout, kill idempotency, create/exit/exec
  errors, egress policy), runner tests updated to the `handle.kill()` contract.
- e2e: `scripts/opensandbox-e2e.ts` — real server + real image: sentinel
  round-trip, ro mount, env neutralization, `docker inspect` hardening
  (CapDrop ALL, pids 512, 4 GiB, 2 CPUs, no-new-privileges), **lateral probes**
  (from another container: same-bridge `ip:44772` and cross-bridge
  `host:published` must be CLOSED), teardown, and (with an allow-list) egress
  default-deny. A failing probe reaps the sandbox it holds.
  key — never paste it:
  `sudo systemd-run --wait --pipe --collect -p EnvironmentFile=/etc/opensandbox/api.env --setenv=SANDBOX_BACKEND=opensandbox --setenv=SANDBOX_EGRESS_ALLOW=api.anthropic.com,github.com --setenv=MC_API_KEY=e2e-placeholder --setenv=INFERENCE_PRIMARY_PROVIDER=claude-sdk --setenv=HOME=/root --setenv=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin --working-directory=/root/claude/mission-control npx tsx scripts/opensandbox-e2e.ts`
  (2026-08-16: PASS 1+2, PASS 3.)

## 4. Shape shipped (host) — `scripts/install-opensandbox.sh` (idempotent)

- `uv tool install opensandbox-server==0.2.2` (isolated venv, `/root/.local/bin`).
- `scripts/build-opensandbox-images.sh` → `mc-opensandbox-execd:v1.0.22`,
  `mc-opensandbox-egress:v1.1.6` (`FROM opensandbox/…` + `LABEL keep=true`;
  the nightly prune would otherwise delete the hub tags).
- `/root/.opensandbox/sandbox.toml` (source: `container/opensandbox/sandbox.toml`,
  no secrets): `127.0.0.1:8098`, `max_sandbox_timeout_seconds=7200`, docker
  bridge, `drop_capabilities=["ALL"]`, `pids_limit=512`, `no_new_privileges`,
  ports `40000-40999`, `allowed_host_paths` mirroring `VOLUME_ALLOWED_PREFIXES`,
  egress `dns+nft`, sqlite store.
- `/etc/opensandbox/api.env` (700 dir / 600 file, generated once with
  `openssl rand -hex 32`, never printed): `OPENSANDBOX_SERVER_API_KEY` (server),
  `OPENSANDBOX_API_KEY` + `OPENSANDBOX_URL` (mission-control).
- `opensandbox-fw.service` (oneshot, `PartOf=docker.service`) →
  `/usr/local/sbin/opensandbox-fw.sh`: loads `br_netfilter` (so same-bridge
  frames traverse FORWARD) and keeps four idempotent DROPs (v4 + v6, per-family
  guarded — qa W2; array-expanded, no `eval`): **R1** `DOCKER-USER -i eth0 …
  --ctorigdstport 40000:40999` (public edge; original dst port because DNAT
  precedes FORWARD), **R2** `DOCKER-USER -i br-+ -o docker0 … --ctorigdstport
  40000:40999` (published-port DNAT path from any other docker network — qa C2;
  `-o docker0` so container egress to that range is untouched — R2 W-3), **R3**
  `DOCKER-USER -i docker0 -o docker0 --dports 44772,18080` (sandbox→sandbox
  execd / egress API — qa C2), **R4** `INPUT -i docker0 --dport 40000:40999`
  (docker-proxy hairpin: a container hitting `<hostIP>:40xxx` is not DNATed for
  its own bridge and lands in INPUT — self-contained instead of relying on
  UFW's default-deny). Host→sandbox is OUTPUT, so mission-control is
  unaffected. Proven by the e2e lateral probes (positive control `host:22` must
  read OPEN; only a `timeout` exit-124 counts as CLOSED, any other docker-run
  failure fails the run): before R2/R3 both `172.17.0.x:44772` (same bridge)
  and `<host-ip>:<published>` (from `a_default`) were OPEN; after, same-bridge,
  cross-bridge and hairpin all CLOSED. Existing stacks (supabase, hindsight,
  prometheus) verified healthy after `br_netfilter`. Verify:
  `sudo iptables -S DOCKER-USER` (3) + `sudo iptables -S INPUT` (1) or
  `./mc-ctl sandboxes` (4/4).
- `opensandbox-server.service` (`After=docker opensandbox-fw`,
  `EnvironmentFile=/etc/opensandbox/api.env`, `MemoryMax=768M`, `Restart=on-failure`).

## 5. Risks / limits recorded

- Pre-1.0 upstream (v1 API "not currently planned"); SDK exact-pinned; server
  version pinned in the installer. Bump deliberately, re-run the e2e.
- execd `mode` = octal digits in a decimal int (`600`, not `0o600`) — a `0o600`
  upload 500s (found by the e2e).
- Egress default-deny + allow-list is **off by default** (parity). **Probed 2026-09-01
  (flip pending the operator)** after the observation week (16 d, 5/5 completions) with the list
  corrected from SDK evidence (`platform.claude.com` is what the vendored CLI
  talks to for OAuth):
  `*.anthropic.com,*.claude.com,github.com,api.github.com,*.githubusercontent.com,registry.npmjs.org`
  — wildcard + lookalike-deny probed live before the flip
  (`docs/planning/nanoclaw-upstream-review-2026-09-01.md` §6).
  (`*.anthropic.com` covers `api` + `mcp-proxy`, both reached by the Claude
  Agent SDK). Deny → in-sandbox DNS NXDOMAIN; tasks that legitimately fetch
  other hosts will fail there, visibly.
- Server TOML has no typo protection (pydantic `extra='ignore'`): a misspelled
  hardening key is silently dropped — the e2e's `docker inspect` probe is the
  detector; run it after every TOML edit.
- Client-side allow-list check is prefix-based (`startsWith`); the server's is
  boundary- and symlink-aware and is the effective gate on this path. The
  docker path's identical prefix check is pre-existing.
- Credential vault skipped (LLM SSE truncation >1 MB; OAuth rotation).
- undici default `bodyTimeout` (300 s between chunks) vs the workers' unconditional
  60 s heartbeat — a heartbeat-less worker would be cut at 5 min; keep heartbeats.
- Server owns `sandbox-*` containers (TTL-reaped); the hourly `mc-*` prune ritual
  deliberately does not touch them.
- Host is runc-only (KVM guest, no `/dev/kvm`); gVisor is possible later via
  `[secure_runtime] type="gvisor" docker_runtime="runsc"` (systrap platform).

## 6. Live state (2026-08-16, end of session)

- `opensandbox-server` active on `127.0.0.1:8098`; `opensandbox-fw` active with
  the three guard rules (v4 3/3, v6 3/3) + `br_netfilter`; keep images built;
  script e2e PASS (round-trip, hardening inspect, lateral probes CLOSED,
  teardown, egress deny).
- mission-control **ARMED**: drop-in
  `/etc/systemd/system/mission-control.service.d/opensandbox.conf`
  (`EnvironmentFile=-/etc/opensandbox/api.env` + `SANDBOX_BACKEND=opensandbox`;
  egress line commented), redeployed pid 2581358 → final build pid 2625181. `./mc-ctl sandboxes` reads
  `opensandbox`. First real task through the backend: `mc-ctl smoke sandbox` →
  nanoclaw task `8840e3b2…` completed in 52 s (worker cloned the ro mount,
  reported HEAD + node version), sandbox `DELETE 204`, no leftover container,
  V8.4 shadow ledger evaluated (`G-landing` met).
- qa R1 FAIL (C1 wall-clock kill, C2 lateral execd) → both folded + proven; R2
  MERGE-READY-with-warnings — W-1 (`mc-ctl sandboxes` `grep -c` under `set -e`
  aborted exactly when the guard was missing), W-2 (truncation clamp lost the
  hard 4 MiB bound), W-3 (cross-bridge rule was an egress rule), W-4 (probe
  could not fail), W-5 (dead `Math.max`), S-1/S-2 (doc wording) all folded
  in the same pass; recs 1/2/3/4/7 folded (INPUT hairpin rule, no `eval`,
  TTL/heartbeat invariant comment, property-style SDK types, timer clear after
  final drain); rec 5 (Prometheus counter on renew failure) deferred.
- The e2e's egress probe (3/3) ran in a one-off `systemd-run` with
  `SANDBOX_EGRESS_ALLOW` exported; the live service ran without an allow-list
  (egress unrestricted, docker parity); on **2026-09-01** the line below was
  prepared (with `*.claude.com` added) — the operator uncomments it (auto-mode
  cannot edit `/etc`); one-liner in the nanoclaw review note §6.

## 7. Flip / rollback (drop-in, one key at a time)

```
# /etc/systemd/system/mission-control.service.d/opensandbox.conf
[Service]
EnvironmentFile=-/etc/opensandbox/api.env
Environment=SANDBOX_BACKEND=opensandbox
# Environment=SANDBOX_EGRESS_ALLOW=*.anthropic.com,*.claude.com,github.com,api.github.com,*.githubusercontent.com,registry.npmjs.org
```

`sudo systemctl daemon-reload && sudo systemctl restart mission-control && ./mc-ctl sandboxes`.
Rollback = delete the `SANDBOX_BACKEND` line (or set `docker`) + restart. The
docker path is untouched.

## 8. Next (not built)

- V8.4 W1: run shell gate checks INSIDE the sandbox via execd before teardown
  (needs the backend to expose `exec()` on the handle + hold the sandbox until
  the ledger is evaluated).
- Sandbox metrics (`execd /metrics`) into the task trace.
- Egress allow-list ON after the observation week — **probes PASS 2026-09-01, operator flips** (one-liner in `nanoclaw-upstream-review-2026-09-01.md` §6); then decide gVisor.
- Since 2026-09-01 the sandbox executes the HOST `dist/` (RO mount over `/app/dist`) on the image's `node_modules`, pinned by the `mc.lock-sha256` label — see `container.ts` `RUNTIME_CODE_MOUNTS` / `imageLockDrift` and the nanoclaw review note.
