---
name: nanoclaw-upstream-review-r1-audit
description: R1 audit (2026-09-01) of the nanoclaw upstream review bundle — host dist/ RUNTIME_CODE_MOUNTS, volumeRefusal, image lock label, --init, parseSandboxBackend throw. PASS WITH WARNINGS.
metadata:
  type: project
---

# nanoclaw upstream review — R1 (2026-09-01)

Verdict PASS WITH WARNINGS, 0 Critical. 100/100 scoped tests green.

**Why the bundle's own thesis is empirically true here.** A live probe proved the
motivating failure AND the guard that catches it in one shot:

    docker run --rm --init --cap-drop=ALL \
      -v /root/claude/mission-control/dist:/app/dist:ro \
      mission-control:latest node -e "import('/app/dist/runners/heavy-worker.js')…"
    # => Cannot find package 'undici' imported from /app/dist/lib/url-safety.js

`undici@7.29.0` is a **prod** dependency added after the image's 2026-07-14
build. So mounting today's host dist onto the live image really does break the
heavy worker — and `imageLockDrift` refuses that exact spawn (live image labels
are `{"keep":"true"}`, no `mc.lock-sha256`). nanoclaw-worker imported fine; heavy
did not. **Lesson: probe EACH entrypoint, not one — a shared mount can be OK for
one worker and fatal for its sibling.**

**Doctrine crumbs:**

- A lockfile-sha label proves the LOCKFILE matched, not that every import
  RESOLVES: the image installs `--omit=dev`, the host `node_modules` has
  everything. Sweep with: list `devDependencies`, grep non-test `src/` for
  `from "<dev>"`. (Ran it: 0 hits, so the gap is not live here.)
- Re-authoring an allow-list function does not fix what it never checked.
  `volumeRefusal` advertises "boundary-safe", but `..` still walks out —
  `volumeRefusal("/root/claude/../.ssh:/x:ro") === null` (verified via tsx).
  The old `startsWith` had the same hole, so it is pre-existing, and every
  caller string is an internal literal — Warning, not Critical.
- `docker image inspect --format '{{index .Config.Labels "X"}}'` on a MISSING
  label prints an empty line and exits **0** (verified with `od -c`). So
  "label absent" and "read succeeded, value empty" are indistinguishable; only
  a *failed* inspect hits the catch. Ordering saves it: `imageExistsLocally`
  runs first, so daemon-down surfaces as "image missing", not `<absent>`.
- `--init` is compatible with `--cap-drop=ALL --security-opt=no-new-privileges
  --pids-limit 512` on this host (`/usr/libexec/docker/docker-init` present,
  probe showed `pid 7` ⇒ tini is PID 1). Don't assume; one throwaway
  `docker run` settles it and is read-only.
- A test that pins a mount list through a **mocked** `./container.js` pins the
  mock, not the constant. Here `container.test.ts` `toEqual([...])` on the real
  `RUNTIME_CODE_MOUNTS` is what makes the runner tests non-vacuous.
- `opensandbox-backend.test.ts:163` calls `buildCreateOptions({… volumes: [] …})`
  and never asserts `base.volumes` — the `toVolumes` → `create` wiring is
  UNPINNED. Deleting `volumes: toVolumes(opts.volumes)` keeps 13/13 green.

**Live state at audit time:** `SANDBOX_BACKEND=opensandbox` is ACTIVE in
`/etc/systemd/system/mission-control.service.d/opensandbox.conf`; image
`mission-control:latest` created 2026-07-14 (the "7 weeks" claim checks out;
"27 commits" does not — 111 commits since that date, 13 under `src/tools/`).
`mc-ctl` / `systemctl restart` do NOT rebuild the image; only `scripts/deploy.sh`
does. A restart that bypasses deploy.sh leaves every container task refusing.
