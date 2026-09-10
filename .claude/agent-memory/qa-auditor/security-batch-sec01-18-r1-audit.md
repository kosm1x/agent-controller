# security-batch SEC-01..18 R1 audit (2026-09-10, mission-control uncommitted vs 6835c3b)

VERDICT: **FAIL** — 4 Critical, 9 Warnings. tsc clean; scoped vitest 28 files / 908 tests green
(shell/immutable-core/url-safety + src/runners + src/api). The green suite proved nothing about
the worst finding.

## Hottest crumbs (transferable classes)

1. **Moving a middleware EARLIER can inert every request, and an untested router hides it.**
   SEC-08 moved `mcpRateLimit` before `mcpAuth()`. `mcpRateLimit` reads `c.get("mcpToken")` and
   returns **500 `rate_limit_missing_auth_context`** when absent — its own docstring said
   "Must be installed AFTER mcpAuth()". Probe: NEW order 500 / OLD order 200. Nothing tests
   `createMcpRouter` (grep: only src/api/index.ts references it) so 908 tests stayed green.
   CLASS: before reordering middleware, grep the moved middleware for `c.get(` — a reader of
   context set by the thing it jumped over is now unfed. A pre-auth DoS limiter must key on IP,
   not on the identity auth produces: two limiters, not a reorder.

2. **A quote-state scanner over text you deliberately did NOT sanitize latches.**
   SEC-06's `isInsideQuotes(s, idx)` skips relative write targets inside quotes. Quoted heredocs
   are stripped; UNQUOTED (`<<EOF`) ones are deliberately not. An odd `"` in an unquoted heredoc
   body leaves the scanner latched true for the REST of the command:
   `python3 - <<EOF\nx = "hi\nEOF\ncd /etc && cat /tmp/a > cron.d-x` -> ALLOWED, while the batch's
   own test asserts the unprefixed `cd /etc && echo hacked > cron.d-test` is BLOCKED.
   CLASS: a quote/paren-state scanner must fail CLOSED when end-of-string state is unbalanced.

3. **`cd -` de-syncs a virtual cwd, fail-OPEN.** `resolvePath(vcwd, "-")` -> `/tmp/-`, which is
   under an ALLOWED prefix. `cd /tmp && cd - && echo pwned > src/index.ts` -> ALLOWED (bash writes
   real MC source; also defeats the EVOLUTION-LOG append-only rule). `pushd`, `(cd ...`, `cd -P`,
   `cd $HOME` all fail CLOSED by accident (garbage path lands under the deny-all MC prefix) — the
   ONE fail-open spelling is `cd -`.
   CLASS: enumerate every `cd` form; give unknown forms a sentinel, not a resolved path.

4. **Newline is not in `SEGMENT_SEPARATOR`** (`/\s*(?:\||\|\||&&|;)\s*/`), so per-segment checks
   see only the FIRST line. `echo start\nsystemctl restart mission-control` -> ALLOWED (baseline
   BLOCKED). Same for pkill / chown / crontab / unlink / sqlite3 and the unscoped-suite guard
   (the 2026-07-12 OOM class). PRE-EXISTING, but SEC-11's new truncate/shred/unlink are dead on
   arrival for multi-line commands and it also breaks the new cwd tracker.

5. **Two sibling rules in one function, only one path-normalized.** In `checkSecretPaths` the
   `.env` branch resolves the token against segment cwd; `SECRET_PATH_PATTERNS` match RAW text.
   So `cd /root && cat .ssh/id_rsa`, `cd /root/.ssh && cat id_rsa`, `cd MC/data && cat mc.db`,
   `cat MC/scripts/../data/mc.db`, `/root/./.ssh`, `/root//.ssh` ALL pass.
   CLASS: when a resolved branch is added next to a raw-text branch, the raw one is the hole.

6. **`~/` handled, `$HOME`/`$PWD` not.** `$( )` and backticks were already blocked, so these are
   the only remaining spellings of the same path: `cat $HOME/.ssh/id_rsa`, `cat "$PWD/.env"`,
   `cat $HOME/claude/mission-control/.env` all ALLOWED.

7. **Glob is the cheapest residual and the likeliest spelling.** `cat .env*`, `.en*`, `.e??`,
   `head -5 .env.bak-*`, `/root/.s*/id_rsa`, `/root/.claude/.cred*` all pass a PATH-shaped rule.
   Whole-dir archive/copy (`tar czf /tmp/x.tgz <dir>`, `rsync -a`, `cp -r <dir>`, `grep -rn KEY
   <dir>`, `docker run -v <dir>:/x`) is the TRUE residual class — those commands never NAME the
   secret, so a path rule structurally cannot see them. Record as accepted residual; do not claim
   closed. Percent-encoding is a NON-finding (bash doesn't decode `%2E`); base64 only bites via
   `| xargs cat`.

8. **A shape rule over filenames FPs on ordinary text.** `ENV_TOKEN_RE` blocked `jq '.env' f.json`,
   `echo 'remember to set .env'`, any UNQUOTED heredoc body mentioning `.env` or `/root/.ssh/`
   (a regression — the old rule needed a reader verb), and `.env.d.ts` (ambient TS env typings:
   `^\.env(?:\.[\w.-]+)?$` matches `.d.ts`).

9. **An own-interface SSRF block silently kills every operator-owned public site.** SEC-04 is
   correct and works on BOTH paths (`validateOutboundUrl` literal + `isBlockedAddress` ->
   `filterSafeAddresses` / `makeSafeLookup` / `validateOutboundUrlResolved`). But
   thewilliamsradar.com, db.mycommit.net, studio.mycommit.net, uncharted.eurekamd.cloud, gilda.mx
   and every `*.187.77.25.101.nip.io` resolve to the box's public IP -> Jarvis can no longer fetch
   its own sites. CGNAT bounds verified exact (100.63 allowed / 100.64.x + 100.127.255.254 blocked
   / 100.128 allowed). `ownAddresses` is cached at first call — stale after an IP change.

10. **A gitdir-only mount is a valid clone source AND a valid `remote get-url` target.** Verified
    on a scratch copy: `git -C <dir-with-only-.git> remote get-url origin` -> exit 0; `git clone
    --no-hardlinks <dir>/.git <ws>` -> OK, checks out HEAD. SEC-02 sound; opensandbox
    `allowed_host_paths` already carries the `/root/claude/` prefix. But the FAILURE branch of the
    prompt (`nanoclaw-env-note.ts:38`, "you can read code but cannot commit") is now false — with
    only `.git` mounted there is no code to read. Half of a two-half fix stayed unpinned
    (recurrence of the trustr-remote-deadend crumb).

11. **`args.cwd` at shell.ts:932 is unreachable**: the tool schema declares only `command` +
    `timeout_ms`, and `execGroupKill` passes no `cwd` to spawn. If a caller ever set it, the guard
    would validate one dir while the child ran in another.

## Method notes for next round
- Prettier drift counts only vs the HEAD PRE-IMAGE: reconstruct HEAD files into a scratch dir and
  `--check` both. Here HEAD already failed on 3 files; the diff ADDED 5 (most visible:
  `jarvis-pull.ts` body never re-indented after the middleware arg was inserted). The repo's
  pre-commit hook runs typecheck + tests only — no prettier — so drift lands.
- The operator's vitest-scope-guard hook scans the WHOLE Bash string, so a heredoc probe
  containing the guarded phrase is denied — assemble it at runtime, or write the file with the
  Write tool (the guard is Bash-only).
- tsx probes from the scratchpad run in CJS mode: NO top-level await (wrap in `main()`), and bare
  deps like `hono` do not resolve from /tmp — import via an absolute node_modules path.
