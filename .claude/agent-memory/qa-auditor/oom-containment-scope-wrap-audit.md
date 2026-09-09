# jarvis_dev OOM-containment scope wrap — audit (2026-08-02)

Scope: uncommitted diff on `src/tools/builtin/jarvis-dev.ts` + `.test.ts`, plus
`/etc/systemd/system/mission-control.service.d/oom-policy.conf`.
Fix wraps both gate children in `systemd-run --scope --collect --quiet
--property MemoryMax=8G --property MemorySwapMax=512M --property RuntimeMaxSec=300 -- <cmd>`.

**Verdict: PASS WITH WARNINGS.** Containment mechanism is sound and was
mutation-verified. 2 Critical, both about *diagnostic loss on failure*, not
about containment. 1 is diff-introduced, 1 is pre-existing.

## Doctrine earned

- **`??` on Node's execFile error streams is always wrong.** `promisify(execFile)`
  attaches `err.stdout` / `err.stderr` as `""` (empty string), NEVER `undefined`.
  So `e.stdout ?? e.message` yields `""` and the fallback never fires →
  `FAIL: ` with zero text. Verified across 6 probe shapes. Use
  `[e.stdout, e.stderr].filter(Boolean).join("\n") || e.message`.
- **Swapping the SPAWNED BINARY changes which STREAM carries diagnostics.**
  The wrapper's own failures (ENOENT, `Unknown assignment: X`, dbus/permission)
  are stderr-only with `stdout===""`. A catch branch that reads stdout-only
  goes content-free for the entire new failure class. Audit the new binary's
  error stream, not just its exit code.
- **Twin-stream asymmetry is a real bug shape**: here the typecheck branch reads
  `stderr` only (but `tsc --noEmit` writes ALL diagnostics to **stdout** —
  measured 77B stdout / 0B stderr, exit 2), and the tests branch reads `stdout`
  only (but systemd-run + vitest's "Failed Tests" block write to **stderr**).
  Both branches read the wrong stream for their own producer. Diff them.
- **`systemd-run --scope` EXECS the command** — Node's direct child IS the
  command, so signals propagate natively. Numeric 137/143 NEVER appear.
  Measured 4/4 kill paths (self-SIGKILL, self-SIGTERM, RuntimeMaxSec deadline
  vs real npx+vitest, MemoryMax cgroup-OOM vs a 4GB fork worker): every one
  surfaced as `signal=SIG*`, `code=null`. Adding numeric-code matches to a
  killed-classifier is dead code unless you measure it first.
- **Escaping the service cgroup cuts both ways**: the scope survives a host
  restart, so an orphan can stack with a retry. Per-scope caps don't bound the
  AGGREGATE — put N children in a shared slice if the box can't hold N caps.

## Verified-sound (don't re-litigate)

- `MemorySwapMax=` spelling correct: systemd 255.4, `default-hierarchy=unified`,
  `/sys/fs/cgroup/system.slice/memory.swap.max` exists. Also self-proving —
  systemd-run rejects unknown assignments with exit 1 + stderr.
- No scope-name collision: auto-names are random (`run-r<hex>.scope`), no
  fixed `--unit=`. Two concurrent scopes coexisted.
- `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` still fires identically through the wrapper.
- RuntimeMaxSec is honored promptly (8s deadline → 8.19s kill), so the Node
  `TIMEOUT_MS + 30s` backstop is correctly the OUTER bound. No stop-timeout drag.
- Drop-in is live (`systemctl show` → `OOMPolicy=continue`, `Restart=on-failure`,
  `User=root`); daemon-reload already applied. Main-process OOM = SIGKILL, which
  `Restart=on-failure` DOES restart (man systemd.service excludes only
  SIGHUP/SIGINT/SIGTERM/SIGPIPE).
- `vitest.config.ts`: `pool: "forks"`, `maxWorkers: 4` on a 4-core/15G box —
  relevant to whether 8G is really "well under" the suite's peak.

## Probe recipe (reusable)

`/tmp/.../scratchpad/probe*.mjs` pattern: promisify(execFile) around
`systemd-run --scope --collect --quiet [--property X] -- sh -c '<shape>'`,
printing `code / typeof code / signal / stdout / stderr / message`. Shapes worth
re-running on any wrapper change: ENOENT, bad-property, exit-1, self-SIGKILL,
self-SIGTERM, RuntimeMaxSec, MemoryMax-vs-fork-worker, maxBuffer breach.
NOTE: a repo hook blocks bare `vitest run` — always pass a file argument.
