# NanoClaw upstream review — v1.2.52 → v2.3.0 (2026-09-01)

Review of `nanocoai/nanoclaw` (formerly `qwibitai/nanoclaw`; the old URL
redirects) since the last review (2026-04-14, v1.2.52): **v2.0.0 major
(04-22) → v2.1.0 → v2.1.54 → v2.2.0 → v2.3.0 (08-24) + Unreleased through
08-31**, 1,956 commits, 30.7K stars (+3.4K). Upstream now publishes tagged
GitHub Releases (since v2.0.63) — the old "query package.json, no tags" rule in
`reference_nanoclaw_upstream` is obsolete. Memory: `reference_nanoclaw_upstream`.
Cadence rule ("monthly") was missed by ~3.5 months; this note is the catch-up.

## Method

1. Three parallel readers over the release corpus (CHANGELOG.md 42 KB, release
   bodies 68 KB, commit subjects) — slices v2.0→v2.1 / v2.1.17→v2.1.54 /
   v2.2→v2.3+Unreleased — extracted **105 candidates: 44 Tier-1, 16 Tier-2,
   45 Tier-3**, each with a verbatim quote + PR/sha. Tier-3 (channels, group
   model, IPC, OneCLI gateway, `ncl` CLI, skills marketplace, setup/migration
   skills, Slack/WhatsApp/Discord/Gmail/iMessage, Codex provider) summarised.
2. Every Tier-1 candidate was **verified against the live code AND the live
   image** (`docker run --rm mission-control:latest grep …`), then grounded in
   production data before any decision:
   - `tasks` 30 d: 831 — `fast` 787, `heavy` 36, **`nanoclaw` 6 (6 completed,
     avg 3.2 min, max 6.6 min)**, `swarm` 2. 90 d nanoclaw: 57 — 26 completed /
     30 failed / 1 cancelled; failure causes: planner JSON parse (2), exit 137
     with `[embeddings] No API key configured` on stderr (2), stuck-task
     watchdog (1); none substrate-level.
   - Since the OpenSandbox backend went live (08-16): 5/5 nanoclaw tasks
     completed (2 smoke, 3 real chat tasks), 0 `[opensandbox] mc-heavy` lines
     ⇒ `HEAVY_RUNNER_CONTAINERIZED` is off; the egress decision touches
     **only** the nanoclaw population.
   - Harness-tag leaks (`</parameter>`, `<invoke …>`) in delivered content or
     task output, 30 d: **0**. Service restarts (`NRestarts`): **0**.
3. Decision per candidate: **shipped / present / rejected-by-measurement /
   deferred-with-trigger / N/A**.

## The finding that reshaped the bundle

The sandbox image `mission-control:latest` was built **2026-07-14**. The worker
runs `node dist/runners/nanoclaw-worker.js` with `WORKDIR /app` — i.e. the
image's **baked** `/app/dist`, not the host repo mounted `:ro` alongside it.
Probed inside the live image: `immutable-core.js` had no
`STANDING_ORDERS_PROTECTED`, `http.js` no `safeFetch`, the 08-02 `jarvis-dev`
OOM-containment fix absent — **27 commits touching sandbox-executed paths
(`src/tools`, `src/runners/nanoclaw-*`, `src/prometheus`, `src/inference`,
`src/lib`; 111 commits total) since the image build never reached the sandbox**, including both
guards shipped in this morning's Hermes review. `build-mc-image.sh`'s own
header said rebuilds were needed "rare[ly] — usually only when the container
worker entrypoint or its deps change", which is exactly the wrong rule when the
whole `dist/` is baked. Upstream solved this class in v2.0.0: *"all groups
mount the same agent-runner read-only … Source is never baked in — /app/src is
provided by a shared read-only bind mount at runtime … Source-only changes
never require an image rebuild"*, and pins the image to its lockfile with a
`dev.nanoclaw.agent-runner-lock-sha256` label checked before retag.

## Shipped (8)

### 1. The sandbox executes the host's deployed `dist/` — nanoclaw v2.0.0 "source is never baked in"

`src/runners/container.ts` `RUNTIME_CODE_MOUNTS` = `dist/` and
`prompt_modules/` bind-mounted `:ro` over `/app/dist` and
`/app/prompt_modules`; both `nanoclaw-runner.ts` and `heavy-runner.ts`
prepend them. The image now contributes node + system deps + `node_modules`
only; the baked copies stay as the fallback for a bare `docker run`. Verified:
the worker's static import graph from `dist/runners/nanoclaw-worker.js` (115
modules) resolves `node_modules` upward from `/app/dist` → `/app/node_modules`;
`dist/db/schema.sql` is present in the host `dist/` (`npm run build` copies
it); `prompt_modules` in the nanoclaw path already came from the `/workspace`
clone (cwd), the mount fixes the heavy path.

### 2. Image ↔ lockfile coupling — nanoclaw `agent-runner-lock-sha256`

Host `dist/` on the image's `node_modules` means the image must have been
built from the same `package-lock.json` (today's image lacked `undici` and
`@alibaba-group/opensandbox` — both added since 07-14; neither is in the
worker's graph today, which is luck, not design). `Dockerfile` stamps
`LABEL mc.lock-sha256 mc.git-sha` (ARGs placed LAST so they don't invalidate
the `npm ci` layers — upstream's lesson); `scripts/build-mc-image.sh` computes
and passes them and verifies the label after build; `container.ts`
`imageLockDrift()` compares label vs `sha256(package-lock.json)`; both
runners **refuse to spawn** on drift (FATAL + rebuild line +
`mc_nanoclaw_image_lock_drift_total`, same contract as the missing-image
pre-flight); `scripts/deploy.sh` compares after `npm run build` and rebuilds
the image on drift **before** the in-flight guard/restart, so the refusing
state is transient (lockfile changed on 3 days in the last 3 months).

### 3. One mount gate for both doors: allow-listed prefix + read-only — nanoclaw v2.1.54 "mount allowlists honor readOnly"

`volumeRefusal(spec)` in `container.ts`, used by `buildDockerRunArgs` AND
`opensandbox-backend.ts` `toVolumes`: host path under
`VOLUME_ALLOWED_PREFIXES` **with a boundary-safe match** (the old bare
`startsWith` admitted `/root/.config/gh-evil` under `/root/.config/gh` and
`….credentials.json.bak` under the credentials entry) AND mode `:ro`. Every
mount the runners make is `:ro` (grep: zero `:rw` in `src/`), so a writable
host mount is now a deliberate code change, never a caller-side string.
Pre-existing test that admitted `/tmp/ok:/work:rw` flipped to the new contract.

### 4. `--init` on the docker path — nanoclaw v2.1.54 #2748 "use Docker's init process"

node as PID 1 never takes SIGTERM's default action, so `docker stop -t 10`
always burned the full grace before SIGKILL. **Measured on the live image:
10.3 s → 0.2 s** with `--init`; zombie children of the agent's shell are now
reaped against `--pids-limit 512`. Docker path only: on the live OpenSandbox path `execd` is PID 1, the
server exposes no init option (R2 W-A verified against `container_ops.py`),
and `kill()` is a force-remove, so the stop-latency class does not arise there.

### 5. Unknown `SANDBOX_BACKEND` refuses at boot — nanoclaw v2.3.0 "An unknown `NANOCLAW_RUNTIME_DRIVER` aborts startup"

`config.ts` `parseSandboxBackend()`: unset/empty/`docker` → docker,
`opensandbox` → opensandbox, anything else throws → `main().catch → exit(1)`.
Before: silent fallback to docker — with the egress allow-list live (#6), a
typo (`opensandbox ` with a trailing space) would have silently downgraded
every sandbox to unrestricted egress. `sandbox-backend.ts`'s own fallback for
an unknown *config value* stays as defence in depth.

### 6. Egress allow-list ON — nanoclaw v2.1.17 #2713 "egress lockdown (opt-in) … outbound network calls outside the allowlist fail closed"

Our analog (`SANDBOX_EGRESS_ALLOW` → OpenSandbox `networkPolicy`
default-deny, shipped 08-16) had been left OFF "until the observation week is
over". Trigger met: 16 days, 5/5 completions. The queued list
(`*.anthropic.com,github.com,api.github.com,*.githubusercontent.com,registry.npmjs.org`)
was **corrected with evidence**: the vendored Claude Agent SDK/CLI references
`platform.claude.com` (16×), `api.anthropic.com` (9), `code.claude.com` (8),
`mcp-proxy.anthropic.com` — so `*.claude.com` was added (OAuth refresh would
have failed). Live probes before the flip: a wildcard probe
(`scratchpad/nanoclaw/egress-wildcard-probe.mts`, one-off `systemd-run`) —
`api.anthropic.com`, `platform.claude.com`, `raw.githubusercontent.com`,
`github.com`, `registry.npmjs.org` resolve; `example.org` and the lookalike
`evil-anthropic.com` do not; the documented `scripts/opensandbox-e2e.ts` PASS
1–3 with the full list. The auto-mode classifier first refused the `/etc`
drop-in edit (Bash and Edit); the operator answered "run it" in-session, the
edit went through, and the flip was deployed at 06:44 UTC (pid 1034295):
`mc-ctl sandboxes` → `Egress allow-list set: yes`; `mc-ctl smoke sandbox`
PASS 42 s (task `b3053a69`) with the egress sidecar attached — inference
through `*.anthropic.com` / `*.claude.com` from inside the box is the
end-to-end wildcard proof. Population: nanoclaw only (6 tasks/30 d).
Rollback: comment the line + restart.

**The line that was run (for the record):**

```bash
sed -i 's|^# Environment=SANDBOX_EGRESS_ALLOW=.*$|Environment=SANDBOX_EGRESS_ALLOW=*.anthropic.com,*.claude.com,github.com,api.github.com,*.githubusercontent.com,registry.npmjs.org|' /etc/systemd/system/mission-control.service.d/opensandbox.conf && ./scripts/deploy.sh --drain 900 && ./mc-ctl sandboxes && ./mc-ctl smoke sandbox
```

(The trailing smoke is what proved the wildcards end-to-end.)

### 7. Image npm 10.9.9 — nanoclaw v2.2.0 #3207 tar GHSA-23hp-3jrh-7fpw

Verified against the advisory (critical, "node-tar: Decompression/parse DoS
via unlimited input", tar ≤ 7.5.18, patched 7.5.19; npm 10.9.9 depends on
tar ^7.5.22). The image's npm 10.9.8 vendors tar 7.5.11. `Dockerfile` runs
`npm install -g npm@10.9.9` before `npm ci` — which (R2 W-D) now installs
**devDependencies too**: the sandbox is a coding sandbox whose prompt says
"run `npx vitest run <file>`", yet `--omit=dev` had left the image with no
vitest/tsc/tsx — the real cause of task `4c34b839`'s (08-27) "vitest not
installed". Host and sandbox now install the same lockfile set. **The host's npm
10.9.8 carries the same tar 7.5.11** — host-level bump is the operator's
(below).

### 8. `.npmrc` key correction — the 04-14 adoption was a silent no-op

`minimum-release-age=10080` was never an npm option (`npm config get
min-release-age` → `undefined` on 10.9.8; npm's definition is
`min-release-age`, unit **days**, and it lands in npm 11.10.0 (`min-release-age-exclude` in 12.0.0) —
`npm/cli workspaces/config/lib/definitions/definitions.js`). Fixed to
`min-release-age=7`. Still inert on the host until npm is upgraded
(`verification_that_cannot_fail` class: the 04-14 adoption was never probed).
Upstream itself now uses pnpm's `minimumReleaseAge` (3 days) with an `.npmrc`
`minReleaseAge=3d` fallback that npm would also ignore.

## Confirmed already present (no action)

| Upstream item | Where we already have it |
| --- | --- |
| Heartbeat/liveness — "idle container with no heartbeat file is exempt from the absolute-ceiling kill" (v2.3.0 #3252) | `container.ts`/`opensandbox-backend.ts` arm the activity timer at spawn, so a worker that never emits is killed at `NANOCLAW_TIMEOUT_MS`; heartbeats reset it; OpenSandbox TTL renewed per sentinel — both directions handled |
| "Container boot failures now log why — 10-line stderr tail at warn" (v2.1.17) | non-zero exit ⇒ `Container exited with code N: <stderr 500 chars>` in the task error, both backends |
| cap-drop ALL / no-new-privileges / pids-limit (v2.1.54 #2748) | `buildDockerRunArgs` H5 set (pids 512) + server TOML on the OpenSandbox path |
| Credentials never in container env / OneCLI vault (v2.0.0, v2.3.0 admission rule) | partial by design: `SANDBOX_NEUTRALIZED_ENV` stubs `MC_API_KEY`; `INFERENCE_PRIMARY_KEY` + `:ro` SDK credentials DO enter the box (the worker needs them) — the compensating control is #6 |
| Node 22 requirement (v2.3.0) | host v22.23.2, image v22.23.1, `engines >=22` |
| Host restart "adopts running sessions instead of restarting them" (v2.3.0 #3307) | fire-and-forget: `deploy.sh` refuses to restart over running tasks (`--drain`); OpenSandbox TTL reaps a sandbox whose host died; boot reconciles orphaned tasks (`reconcileOrphanedTasks`) |
| "compact_boundary must not surface as a result" / rate_limit_event (v2.1.54) | N/A shape: the worker returns one structured `orchestrate()` result, never raw SDK stream events |
| "Errored batch no longer silently acked completed" (#2966) | V8.4 Honest Done: a worker blob without `success` lands `DONE_WITH_CONCERNS` |
| CLAUDE.md `@`-imports silently dropped outside the project dir (Unreleased) | N/A: `settingSources: []` — no CLAUDE.md is loaded on any path, host or sandbox |
| Orphan reaper scoped by install label (#1928) | one install per host; `mc-ctl sandboxes` lists `sandbox-*`; OpenSandbox owns lifecycle |
| Command-gate fail-open fixes (#2930) | the sandbox shell deny-regex is a synchronous `test()` — no error path to fail open |

## Rejected by measurement (no evidence in 30 d)

- **Trailing harness-tag strip** (`stripHarnessTagArtifacts`): 0 leaked
  `</parameter>`/`<invoke`/`</invoke>`/`<function_calls>` in delivered
  content or task output in 30 d. Bookmark; re-measure if a leak is reported.
- **Startup circuit breaker** (v2.0.x #2080, exponential backoff up to 15 min):
  `NRestarts=0`; systemd `Restart=on-failure RestartSec=5s StartLimitBurst=5/10s`
  — note the burst limit can never trip at a 5 s cadence, so a real crash loop
  would restart every 5 s forever. Native equivalent queued as an operator
  drop-in line (below); no code.
- **`CONTAINER_CPU_LIMIT`/`CONTAINER_MEMORY_LIMIT` knobs + validation**
  (v2.1.54 #2856, v2.3.0): ours are fixed constants (4g / 2 cpus, mirrored in
  the OpenSandbox `resource`); no malformed-input surface exists. The
  "loosen only if a real build fails" watch (audit I1) still stands.
- **Label-based container discovery / `create`+`start --attach`** (v2.3.0
  #3306): names `mc-<runner>-<task8>-<ts>` + OpenSandbox `metadata.mc_name`
  already give forensic mapping; `mc-ctl sandboxes` lists by name.

## Deferred — with triggers

1. **Claude Agent SDK 0.3.207 → 0.3.252** (upstream on 0.3.238 since 08-21;
   `latest` 0.3.252). Blast radius is the whole `fast` hot path (787
   tasks/30 d), not nanoclaw — its own session with `npm run eval:gate -- --run`
   (~14 min, ~$5.6) + deploy. **Trigger:** before the 2026-10-01 upstream
   reviews, or the first SDK-attributed failure in `task.failed`.
2. **Host npm upgrade** so #8 becomes live: `npm install -g npm@12`
   (npm 12.0.2 requires node ^22.22.2 — host has 22.23.2). Also clears the
   host's tar 7.5.11 (GHSA-23hp-3jrh-7fpw). Operator-level toolchain change
   (affects every Node project on the box). **Trigger:** operator's next
   maintenance window. Verify: `npm config get min-release-age` → `7`.
3. **systemd restart backoff** (the circuit-breaker analog):
   `printf '[Service]\nRestartSteps=6\nRestartMaxDelaySec=15min\n' > /etc/systemd/system/mission-control.service.d/restart-backoff.conf && systemctl daemon-reload`.
   **Trigger:** first `NRestarts > 3` within an hour.
4. **Watchdog vs container lifetime** (queued P2, unchanged): a task the
   15-min watchdog fails keeps its heartbeating sandbox alive (TTL renewed) →
   ghost pushes. Upstream's claim fence ("never adopt or finalize without the
   claim fence — fail closed", 08-25) is the reference design. **Trigger:**
   next ghost push, or the P2 classifier item.
5. **Non-root container identity** (v2.3.0 `--user uid:gid`): deliberate
   divergence — the worker reads root-owned mode-600 credentials; documented
   on `buildDockerRunArgs`. **Trigger:** if credentials ever move to a
   vault/proxy pattern (then `--user` + `HOME=/home/node` follow).
6. **Mid-deploy `dist/` rewrite race:** `npm run build` rewrites host `dist/`
   while a running sandbox has it mounted; lazily `await import()`ed modules
   could load a half-written file. Pre-existing on the HOST process for the
   same dynamic imports, and WIDENED by #1: `deploy.sh` builds BEFORE its
   in-flight guard, so the rewrite now also reaches a running sandbox's `:ro`
   `/app/dist` (qa R1 W6); window ≈ build duration × (6 sandbox tasks / 30 d).
   **Trigger:** a task error naming a syntax/ESM error inside `dist/` during a
   deploy window → move the build to a staging dir + atomic rename.
7. **Probe artefact — result resolves before teardown:** `spawnOpenSandbox`
   resolves `result` and only then `finally → teardown()`, so a consumer that
   `process.exit`s on result leaks the sandbox until the server TTL (observed
   with both probe scripts today; reaped by TTL). The runner process never
   exits, so no live impact. **Trigger:** any new one-off script that awaits
   `handle.result` — await a short drain or the kill, or let the TTL reap.
8. **Egress list growth:** a nanoclaw task failing with `ENOTFOUND`/
   `EAI_AGAIN` for a host = a needed egress not on the list. Add it in
   `opensandbox.conf`, one host, with the reason. Candidates already known
   but NOT added (no evidence of use): `codeload.github.com`, `objects.githubusercontent.com`.

## Tier 3 skipped (categories, 45 items)

Slack/WhatsApp/Discord/Gmail/iMessage channels and formatting skills; users/
roles/messaging-groups entity model; per-group containers, IPC, mailbox seam,
on-wake messages, destinations; OneCLI gateway + SDK pins; `ncl` CLI and its
scope model; setup wizard, `nanoclaw.sh`, v1→v2 migration, upgrade-marker
tripwire, per-install service slugs; Agent Plugins / skills marketplace
(`/learn`, `/add-*`); Codex/OpenCode/Ollama providers; scheduled tasks
(`ncl tasks`); `/upload-trace`; two-DB session split; Bun runtime; central DB
async `DbDriver`; release-pipeline CI (attestations, publisher identity —
our image is built locally from local source).

## How mission-control's nanoclaw compares to NanoClaw v2.3 (positioning, 2026-09-01)

| Dimension | NanoClaw v2.3.0 | mission-control nanoclaw runner |
| --- | --- | --- |
| Purpose | persistent per-group agent containers behind messaging channels | fire-and-forget coding-task sandbox inside the Prometheus orchestrator |
| Runtime seam | `src/drivers/` session driver (Docker built-in), admission-checked `SessionSpec` | `sandbox-backend.ts` seam: `docker` \| `opensandbox` (OpenSandbox lifecycle server, live since 08-16) |
| Code delivery into the box | agent-runner source mounted RO; image = deps; lockfile-sha label checked before retag | **now the same**: host `dist/` + `prompt_modules/` mounted RO; `mc.lock-sha256` label; runners refuse on drift; `deploy.sh` rebuilds |
| Credentials | OneCLI vault; admission refuses credential VALUES in env on every lane | `MC_API_KEY` stubbed; inference key + `:ro` SDK credentials enter the box; compensated by egress default-deny (**ON**) |
| Egress | opt-in lockdown via `--internal` network + gateway, fail-closed | OpenSandbox sidecar default-deny + FQDN/wildcard allow-list, **ON** for nanoclaw (2026-09-01) |
| Hardening | cap-drop ALL, no-new-privileges, `--init`, pids 2048 (configurable), non-root `--user` | cap-drop ALL, no-new-privileges, **`--init` (new)**, pids 512, `--memory 4g --cpus 2`; root by design |
| Mounts | allow-list file, `readOnly` honoured, group-folder label admission | `VOLUME_ALLOWED_PREFIXES` boundary-safe + **`:ro`-only gate on both doors (new)** |
| Liveness | heartbeat file mtime + absolute ceiling; host-sweep with wake grace | 60 s stdout sentinels reset an inactivity timer; OpenSandbox TTL renewed per sentinel |
| Restart semantics | adopt running sessions; claim fence; orphan reaper by install label | refuse-to-restart over running tasks (`--drain`); TTL reaps host-death orphans; boot reconciles tasks |
| Completion truth | task delivery "one door"; errored batch logged | V8.4 Honest Done ledger; `G-landing` verified on the host against origin |
| Supply chain | pnpm `minimumReleaseAge` 3 d; digest-pinned images with attestations (opt-in); npm 10.9.9 | `.npmrc` `min-release-age=7` (inert until npm ≥ 11.10 on host); locally built image; **npm 10.9.9 in image (new)**; **devDependencies now in the image** so `npx vitest` inside the sandbox is real |

Net: after this bundle the runner matches upstream on the container-runtime
axis it shares (code delivery, lock coupling, mounts, init, egress); the
remaining divergences (credential vault, non-root) are deliberate and
documented with their compensating control.

## Cadence

- Upstream velocity: ~450 commits/month, 3 minors in August alone. Rule stays
  **monthly**; >2 minors since last review ⇒ full-day review with parallel
  readers. **Next: 2026-10-01** (aligned with the Hermes review).
- Query `gh api repos/nanocoai/nanoclaw/releases` (tagged since v2.0.63) +
  `CHANGELOG.md` `[Unreleased]`; the old package.json-only rule is obsolete.
- Star velocity 3.4K/4.5 months — not a hot phase; monthly holds.

## Audit (multi-round, Tier 1: mounts + egress + config + image — 16 files)

Tier 1 (R1 + R2) — >5 files and a security surface (mounts, egress, boot
config, image). R2 found 0 new Criticals, so no R3.

**R1 — adversarial (qa-auditor): PASS WITH WARNINGS — 0 Critical, 6 Warning.**
The five highest-risk hypotheses were falsified by live probe: mount shadowing
/ ESM resolution (`import('/app/dist/runners/nanoclaw-worker.js')` under
`--init --cap-drop=ALL` with host dist mounted → `pid 7 / IMPORT OK`); the
bundle's own thesis (`heavy-worker` from a mounted dist on the OLD image →
`Cannot find package 'undici'` — exactly what `imageLockDrift` now refuses);
boot throw exits non-zero; the drift metric is on the served registry; no
ungated `spawnSandbox`/`-v` caller. Warnings, all folded:
W1 `volumeRefusal` not `..`-safe (pre-existing) → `posix.normalize` +
absolute-only + strict sub-path for directory prefixes (+7 refusal cases,
+2 acceptances) · W2 `toVolumes → buildCreateOptions` wiring unpinned → test
· W3 `prompt_modules` mount inert on the nanoclaw path (worker `chdir`s to
the clone) → documented, kept for heavy · W4 `mc-ctl restart` bypasses the
rebuild → `sandbox_image_lock_state()` WARN in `restart`, "Image lock" line
in `sandboxes` · W5 superseded `keep=true` image escapes the nightly prune →
sweep in `build-mc-image.sh` (containerd store had already GC'd it; belt for
the classic store) · W6 mid-deploy `dist/` rewrite race widened → deferred #6
reworded. Info: "27 commits" needed its denominator (111 total) → fixed in
four places.

**R2 — fix-the-fix + adjacent (qa-auditor): PASS WITH WARNINGS — 0 Critical,
5 Warning, no R3.** All six R1 folds verified correct (30-spec fuzz of
`volumeRefusal`: no string passes normalized and mounts elsewhere; `mc-ctl`
helper safe under `set -euo pipefail` because it is called in `$(…)`; sweep
loop safe; counts 27/111 confirmed; `parseSandboxBackend` never runs inside
the container — `SANDBOX_BACKEND` is in no `envVars`). Warnings:
W-A `--init` is docker-path-only and the live path is OpenSandbox → verified
the server exposes no init option; documented (#4) · W-B the W2 pin was
truncation-blind (one accepted spec) → second accepted spec · W-C
`npm run build`, not bare `tsc`, is now a runtime dependency (the mount
shadows the baked `dist/db/schema.sql`) → `missingHostDistAssets()` pre-flight
in both runners, refuses with "Fix: npm run build" · W-D **the image had no
devDependencies** (`npm ci --omit=dev`) while the worker comment and the
env-note promise `npx vitest` → `npm ci` installs the full lockfile set (the
08-27 task `4c34b839`'s "vitest not installed" was this) · W-E `.npmrc`
wording: `min-release-age` lands in npm 11.10.0, `min-release-age-exclude`
in 12.0.0 → fixed. Adjacent surfaces: `Dockerfile.nanoclaw`/`build-nanoclaw.sh`
dead; `NANOCLAW_IMAGE` advertised in four files, read by none (queue #10);
Pulso's `container-runner.ts` shares the class (queue #9).

**Mutation checks (13, each RED with the guard broken, then restored):**
`--init` removed (1 fail) · ro rule removed (7) · prefix boundary loosened (2)
· nanoclaw drift guard off (1) · heavy drift guard off (1) · code mounts
dropped (1) · unknown backend falls back (8) · normalization removed (3) ·
absolute rule removed (2) · `toVolumes` wiring cut (2) · assets guard off (1)
· asset list shortened (1) · wiring truncated `.slice(0,1)` (2).

**Scoreboard:** pre-existing bugs found 5 (baked stale dist · `startsWith`
prefix boundary · `..`-unsafe prefix · dev deps absent in the image ·
`.npmrc` key never an npm option) — the real value; bundle-regression catches
5 (W2/W-B pin quality, W-C asset coupling introduced by the mount, W3/W-A
documentation, W6 race widening); rounds 2. Verdict **PASS WITH WARNINGS**,
closure-ready for this bundle; egress flip is the operator's.

## Deploy

- Image rebuilt twice today (`scripts/build-mc-image.sh`): final 3.27 GB,
  base resolved to node **v22.23.2**, npm **10.9.9**, `tsc tsx vitest` in
  `/app/node_modules/.bin`, `undici` + `@alibaba-group/opensandbox` present,
  labels `mc.lock-sha256=08714edc8699…` (= host lockfile) and
  `mc.git-sha=843202c`. The superseded 07-14 image was already gone
  (containerd image store GC); the sweep stays as belt for the classic store.
- `./scripts/deploy.sh --drain 300` at 06:33 UTC: migration gate OK
  (`user_version=5`), build, **"Sandbox image lockfile matches host"**, pid
  **825681 → 1002476** (2 s transition, 0 startup errors), health 200, 6
  schedules, Telegram polling up.
- `./mc-ctl sandboxes`: backend `opensandbox` · egress `no` at that point ·
  **Image lock … matches (08714edc8699)** · server ok · guard 4/4.
- **Egress flip, 06:44 UTC** (operator: "run it"): drop-in line active →
  `./scripts/deploy.sh --drain 900` → pid **1034295**, health 200 →
  `Egress allow-list set: yes` → `./mc-ctl smoke sandbox 600` **PASS 42 s**
  (task `b3053a69`, `Gates: 1/1 met`, reported `9ba2ce3` · `v22.23.2`); the
  watcher saw `sandbox-egress-c8bd991c…` created/started by the server and the
  same `/app/dist` / `/app/prompt_modules` RO mounts.
- `./mc-ctl smoke sandbox 600` → **PASS in 48 s** (task `0cc7c217`, `Gates:
  1/1 met`, reported `843202c` · `v22.23.2`). A watcher inspected the live
  sandbox container `sandbox-317411dd…` during the run:
  `/root/claude/mission-control/dist -> /app/dist rw=false`,
  `/root/claude/mission-control/prompt_modules -> /app/prompt_modules rw=false`,
  every mount `rw=false`; inside the box
  `grep -c STANDING_ORDERS_PROTECTED /app/dist/tools/builtin/immutable-core.js`
  → **1** (the baked image of the morning gave 0) and
  `/app/dist/runners/nanoclaw-worker.js` mtime = today's host build. No
  `sandbox-*` leftovers after the run.
- Watches: `journalctl -u mission-control -o cat | grep -E "different package-lock|missing build assets"`
  must stay empty (a hit = a deploy bypassed `deploy.sh` or a bare `tsc`
  build); `./mc-ctl sandboxes` "Image lock" line; the next real nanoclaw coding
  task under egress — an `ENOTFOUND`/`EAI_AGAIN` names a host to add, one at a
  time.
