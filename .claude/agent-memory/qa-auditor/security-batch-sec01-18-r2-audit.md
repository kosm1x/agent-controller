# security-batch SEC-01..18 R2 audit (2026-09-10, uncommitted vs 6835c3b)

VERDICT: **FAIL** — 2 Critical (both REGRESSIONS vs HEAD, both from the W5 fix), 5 Warnings.
tsc clean; 20 files / 855 tests green + router.test.ts 2/2. All four R1 Criticals verified fixed
and mutation-pinned. Method that found both C's: **run every case against a `git archive HEAD`
copy of the same module in the same process and print HEAD=x NOW=y** — a fix that only *loosens*
is invisible in a green suite and invisible in a NOW-only probe table.

## Hottest crumbs (transferable classes)

1. **Silencing a false positive by DELETING text from the scan input deletes it for EVERY rule,
   including the ones that must still see it.** W5 asked for "unquoted heredoc PROSE is data";
   the fix stripped all unquoted heredoc bodies before `scanned`. But a heredoc feeding an
   interpreter IS the program: `bash <<EOF\ncat /root/.ssh/id_rsa\nEOF` and 11 sibling spellings
   (sh/zsh/`bash -`/`env bash`/`docker exec -i bash`/custom delimiter/`<<-`) go HEAD=BLOCK →
   NOW=ALLOW, including `echo pwned > .../src/index.ts` (immutable core) and a
   `cat /dev/null > docs/EVOLUTION-LOG.md` truncation. CLASS: sanitisation is per-RULE, never
   global — strip for the rules that FP, keep the text for the rules that must not.
   The discriminator is the segment's base command ∈ {bash,sh,zsh,python*,node,perl,ruby,php,…}.

2. **A heredoc-strip regex whose body match starts at the DELIMITER swallows the rest of the
   opener line — including the redirect target.** `/<<-?\s*(\w+)[\s\S]*?\n\t*\1/` applied to
   `cat <<EOF > /root/claude/mission-control/src/index.ts\nfoo\nEOF` eats ` > <path>`, so
   WRITE_INDICATORS never sees it (the function's own docstring claims "the first-line redirect
   stays intact" — false; verified). The quoted form (`<<'EOF' > path`) had this hole at HEAD too
   and nobody noticed. Fix shape: capture the opener tail — `/<<-?\s*(\w+)([^\n]*)\n[\s\S]*?\n\t*\1/`
   → replace with `"<<HEREDOC_STRIPPED" + $2`. CLASS: when a docstring asserts what a regex
   preserves, write the probe that reads it back.

3. **Moving a security check into a port-aware wrapper narrows WHICH layers run it.** W6 fixed
   "own public sites unfetchable" by gating on port ≠ 80/443 — but the new helper is called only
   from `validateOutboundUrl` (literal) and `validateOutboundUrlResolved`. `isBlockedAddress`
   (→ `filterSafeAddresses` → the undici safe-lookup Agent) never got it, and ~5 tools
   (screenshot, seo-page-audit, seo-telemetry, pdf-read, ads-brand-dna) call ONLY the sync
   literal check, which cannot resolve DNS. `http://thewilliamsradar.com:7462/` → ALLOWED.
   CLASS: after a security predicate gains a parameter, re-grep every call site of the ORIGINAL.

4. **A glob rule keyed on "the literal prefix could reach a secret dir" fires on every ANCESTOR.**
   `SECRET_DIR_PREFIXES.some(d => d.startsWith(dir) || dir.startsWith(d))` blocks `ls /root/*`,
   `ls /root/claude/*`, `ls /root/claude/mission-control/*.json`, `ls ./*.json` (cwd = MC),
   `ls data/*`, `grep -l x /etc/*.conf` — all HEAD=ALLOW. And `basePrefix` matching means
   `ls /tmp/i*` is blocked because `id_rsa` starts with `i`, `ls /tmp/.*` because `.env` starts
   with `.`. The batch's own allow-tests only cover `/root/claude/vlved/*.json` (vlved is not an
   ancestor of anything secret) so the FP class is unpinned. 400-run live corpus: 0 glob-shaped
   shell commands, so blast radius is bounded — say so instead of inflating severity.

5. **A path rule that resolves a BARE token against cwd turns every mention of a filename into a
   path.** R1 W8 unfixed: `.env` anywhere in a command resolves to `<cwd>/.env` →
   `grep -rn "\.env" <dir>`, `jq '.env' f.json`, `echo 'remember to set .env'`,
   `git log --grep='.env'`, `ls -la <dir> | grep .env` all HEAD=ALLOW → NOW=BLOCK. A bare
   basename needs an argument-position/verb signal before it counts as a path.

6. **Compound-keyword segments defeat a base-token deny-list** (pre-existing, `;` was always a
   separator): `for s in a; do systemctl restart mission-control; done` → base token is `do`,
   ALLOWED. Same for `then`. SEC-11's new truncate/shred/unlink inherit it. Strip leading
   `do|then|else|elif|{|(|!|time|exec` before taking the base name.

7. **Variable indirection on the DIRECTORY half still walks** (pre-existing, unchanged):
   `P=/root; cat $P/.ssh/id_rsa` — PATH_TOKEN_RE's lookbehind `(?<![\w.\/~$-])` kills every
   token start inside `$P/.ssh/id_rsa`, so the segment yields NO token at all. Only the
   full-path form (`P=/root/.ssh/id_rsa; cat $P`) is caught, by the raw-text net.

## Verified-fixed (do not re-probe)
C1 mcp order (router.test.ts 2/2; apiRateLimit IP-keyed pre-auth, socket-addr keyed, XFF only
when TRUST_FORWARDED_FOR + loopback) · C2 quote latch · C3 `cd -` sentinel · C4 `\n` separator
(9/9) · W1/W2 resolved secret paths incl. `$HOME`/`$PWD`/`~`/`//`/`..` (11/11) · W6 (6 operator
sites ALLOWED, 6 own-host internal ports BLOCKED on the resolved path) · W7 · W9 · N2/N4/N9.

## Method notes
- `git archive HEAD | tar -x -C <scratch>` + `cp -r node_modules` gives a runnable HEAD twin;
  import BOTH modules in one tsx probe and print `HEAD=/NOW=`. HEAD's signature was
  `validateShellCommand(command)` — cast to `any` to call it with one arg.
- Prettier drift vs the HEAD pre-image: HEAD 7 files → now 12 (+5). `npx --prefix <repo> prettier`
  from inside the extracted HEAD tree resolves the same config.
- `mc.db` has no tool-call table; `runs.output` is prose. `select output from runs where output
  like '%shell_exec%'` (1059 rows) is the closest live corpus and yields no command strings —
  do not promise a command-frequency number from it.
