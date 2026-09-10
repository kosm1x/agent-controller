# security-batch SEC-01..18 R4 audit (2026-09-10, uncommitted vs 6835c3b)

VERDICT: **FAIL** — 1 Critical (a loosening class, 12 spellings), 4 Warnings, 5 Notes.
tsc clean; 406/406 scoped tests green (shell 203 · immutable-core · url-safety · router).
shell.ts was REVERTED to HEAD after R3 (3-strike on the token/cwd pipeline) and re-patched
strictly additively. Method: HEAD twin + 230 cases in 3 probes, printing HEAD=/NOW=.
Result: **loosened=8 of 230** (all one class), tightened=~55, everything else identical.

## Hottest crumbs (transferable classes)

1. **"Strictly additive" is a claim about the CODE PATH, not about the VERDICT — a
   rewrite that *replaces* a regex with a shared predicate can loosen even when every
   new line only adds.** SEC-01 replaced HEAD's mission-control `.env` rule
   (`\.env(?:\.[A-Za-z0-9_-]+)?\b` + reader-verb lookahead) with `ENV_ABS_RE` →
   `isBlockedEnvFile()`. The shared predicate carries an FP-avoidance exemption
   (`if (/\.(?:d\.ts|ts|js|mjs|cjs|json|md|txt|ya?ml)$/.test(base)) return false;`,
   immutable-core.ts:157) written for the *file_read* surface. Consequence:
   `cat /root/claude/mission-control/.env.secrets.json`, `.env.bak.txt`, `.env.prod.yml`,
   `.env.old.md` = HEAD BLOCK → NOW ALLOW. CLASS: when a rule is re-homed into a shared
   predicate, replay the OLD rule's blocked set through the NEW predicate — the other
   surface's FP exemptions are now yours.

2. **A trailing-boundary lookahead is narrower than `\b` and silently drops a suffix
   family.** HEAD `\.env…\b` matched inside `.env-prod` (boundary between `v` and `-`);
   NOW `(?![\w-])` (shell.ts:353/354) explicitly rejects `-`. `cat …/.env-prod`
   HEAD=BLOCK → NOW=ALLOW. Changing `\b` to a hand-written lookahead is a behavior
   change; enumerate the separator chars `\b` used to accept.

3. **A one-character prefix defeats a brand-new bare-name rule and it is not in the
   deferred list.** `cat .env` BLOCK / `cat ./.env` ALLOW — ENV_BARE_RE's lookbehind
   `(?<![\w.\/\\$@-])` excludes `/`, and ENV_ABS_RE requires a leading `/`. Also
   `cat ../mission-control/.env`. Not "after cd", not `$VAR`, not a glob — a third
   spelling the docstring never names.

4. **A docstring that states the RECEIVER a sanitiser assumes, over code that never
   checks the receiver, is the R2-crumb-2 pattern again.** shell.ts:356 says unquoted
   heredoc bodies are skipped because they are "prose piped to `cat`/`tee`";
   `heredocBodyRanges` (359) has no receiver test, so `bash <<EOF\ncat .env\nEOF`,
   `cat <<EOF | bash\ncat .env\nEOF`, `sh <<-EOF` all skip the bare-`.env` rule
   (HEAD allowed too — a residual, not a regression, but the new skip *creates* it).

5. **`&`/`\n` as segment separators cost ZERO false positives on 55 realistic shapes.**
   URLs with `&` query params, `2>&1`, `&>`, trailing `&`, `AT&T` in quotes,
   `git -C … commit -m "a & b"` — all identical to HEAD. The FP that *does* appear is
   the `\n`-splitting of UNQUOTED heredoc bodies: `cat <<EOF > README.md\nrm -rf
   node_modules && npm ci\nEOF` → "command 'rm' is blocked" for text that is never
   executed. Quoted (`<<'EOF'`) is stripped and stays ALLOW — so the refusal message
   must name that escape hatch or the agent flails (retry-guard strike class).

6. **The wrapper allow-list is the right shape and still finite.** `effectiveBaseCommand`
   (shell.ts:262) catches sudo/-n, `env -i`, `do`, `{`, `!`, `exec`, `stdbuf`,
   `timeout 5`, VAR= prefixes — 12/12 probed. Unlisted: `watch`, `flock`, `script`,
   `chroot`, `parallel`, and every pipe form (`find … | xargs rm`). HEAD had NO wrapper
   handling, so all are pre-existing; say "non-exhaustive by design" in the docstring
   rather than chasing them (flag-deny-never-converges).

## Verified-clean in R4 (do not re-probe)
`&` + `\n` separators (0 FP / 0 loosening, 55 cases) · effectiveBaseCommand wrapper set ·
quote-stripped normalize + `$HOME`/`${HOME}`/`~` rewrite (D12–D16, G08) ·
SECRET_PATH_PATTERNS ⊇ all 7 removed HEAD reader-verb rules (A01–A16) ·
mc.db abs+relative · kong.yml · find -delete/-exec · truncate/shred/unlink ·
`.envrc`/`.environment`/`.env-example`/`myapp.env`/`/tmp/x.env` all correctly NOT matched.

## Method notes
- `git show HEAD:src/tools/builtin/shell.ts > src/tools/builtin/shell.head.ts` is enough
  this round (HEAD signature is 1-arg, same as NOW) — no `git archive` tree needed.
  DELETE it before tsc or the twin is typechecked.
- The probe MUST `process.chdir("/root/claude/mission-control")`: ENV_BARE_RE resolves
  against `process.cwd()`, so a scratchpad cwd silently un-blocks every bare `.env` case.
- `find /root/claude -maxdepth 3 -name ".env.*" | grep -E '\.(json|txt|md|ya?ml)$'` → 0 rows:
  the loosening has no live target TODAY. Say that; it sizes the finding without deflating it.
