# security-batch SEC-01..18 R3 audit (2026-09-10, uncommitted vs 6835c3b)

VERDICT: **FAIL** — 5 Critical (10 of them HEAD=BLOCK→NOW=ALLOW regressions), 4 Warnings.
tsc clean; 466/466 scoped tests green (shell 239 · url-safety 87 · immutable-core · router 2 ·
screenshot · pdf-read). All R2 C1/C2/W2/W4/W5/N4 folds verified fixed with a HEAD twin.
Method again: `git show HEAD:src/tools/builtin/shell.ts > …/shell.head.ts`, import both, print
HEAD=/NOW= per case (113 + 41 + 21 cases). Twin deleted before tsc.

## Hottest crumbs (transferable classes)

1. **A per-rule sanitiser needs the receiver of the WHOLE PIPELINE, not the token before the
   redirect.** R2 C1 was fixed by keeping a heredoc body when the command before `<<` is an
   interpreter. But `cat <<EOF | bash`, `cat <<EOF | sh`, `tee /tmp/s.sh <<EOF` and
   `cat <<EOF > /root/claude/vlved/s.sh` all feed the SAME body to a shell later in the
   pipeline / on a second turn — 10 spellings went HEAD=BLOCK → NOW=ALLOW. `stripHeredocs`
   line 653: `const segment = before.split(/\|\||&&|[|;\n]/).pop()` — deliberately discards
   everything AFTER `<<`. CLASS: when a fix asks "who receives this data?", the answer is the
   whole pipeline + every downstream write target, not the nearest token.

2. **A wrapper-stripping base-command resolver that does not skip the wrapper's FLAGS returns
   the FLAG as the base command — fail-open in both directions.** `effectiveBaseCommand`
   (line 613) skips `sudo`/`env`/`nohup` then returns `-n`/`-u`/`-i`/`--` as the base name, so
   `sudo -n systemctl restart mission-control` and `sudo -E sqlite3 …` are ALLOWED while
   `sudo systemctl …` is BLOCKED, and `env -i bash <<EOF` / `sudo -u x bash <<EOF` /
   `nohup -- bash <<EOF` lose their executor identity (regressions). Only timeout/nice/ionice/env
   have arg-skip loops. CLASS: an allow/deny keyed on "the first token that isn't a wrapper"
   must skip that wrapper's options too, and an UNRESOLVED base must fail closed, not open.

3. **Quote splicing defeats every path-shaped rule, at zero cost.** `cat "/root/.ssh"/id_rsa`,
   `cat /root/.ss"h"/id_rsa`, `cat /root/'.ssh'/id_rsa`, `cat …/mission-control/.e"nv"` are all
   ALLOWED (HEAD too). Both halves of the rule miss: the raw-text net needs the literal
   substring, and PATH_TOKEN_RE's character class has no `'`/`"`, so a token ends at the quote.
   Cheap fix: strip unescaped quote chars from a COPY of the text used for path scanning.
   CLASS: a "names the secret" rule must scan the shell-WORD (post-quote-removal), not the
   raw token.

4. **`(cd DIR` with no space skips the cd detector entirely.** Line 619's wrapper test
   (`/^\(+\w/.test(t) && COMMAND_WRAPPERS.has("(")`) SKIPS the whole `(cd` token instead of
   stripping the paren, so baseName becomes the next token's basename (`.ssh`) and the virtual
   cwd is never touched: `(cd /root/.ssh && cat id_rsa)` ALLOW vs `( cd /root/.ssh && cat id_rsa )`
   BLOCK. One space decides. CLASS: a normaliser that CONSUMES a compound token loses the very
   keyword the caller is switching on.

5. **A command-global, last-wins assignment map lets a TRAILING decoy rewrite an EARLIER read.**
   `cat $P/.ssh/id_rsa` is BLOCKED (unresolvable `$VAR` → fail-closed by basename); append
   `; P=/tmp` and it is ALLOWED. Also `HOME=/tmp cat $HOME/.ssh/id_rsa` — a bash PREFIX
   assignment does NOT affect that command's own expansion (bash reads /root/.ssh/id_rsa) but
   `collectAssignments` applies it anyway. CLASS: a substitution added to reduce false negatives
   must be scoped to the positions where the shell would apply it, and must never turn a
   fail-closed verdict into ALLOW.

6. `&` is still not in `SEGMENT_SEPARATOR` (line 540) although `\n` was added there in R2:
   `sleep 1 & systemctl restart mission-control` is ALLOWED. Same one-character class as R2 C4.

## Verified-fixed in R3 (do not re-probe)
R2 C1 (13/13 executor-fed heredoc spellings BLOCK) · R2 C2 (opener same-line redirect survives,
4/4 incl. rel + `| tee`) · R2 W2 glob ancestor FPs (11/12 ALLOW; `ls data/*` refused by design) ·
R2 W4 compound keywords (6/6 incl. `for…do`, `then`, `else`, `time`, `{`) · R2 W5 `$VAR/`
(6/6) · N4 brace expansion · W1/url-safety (5 sync callers now await the resolved check).

## Still-open FP (R2 W3 only half fixed)
`\.env` (backslash) is exempted; a BARE `.env` still resolves to `<cwd>/.env` → BLOCK:
`jq '.env' f.json`, `echo 'copy .env.example to .env'`, `ls -la <dir> | grep .env`, and now
also any prose containing `.env` inside an interpreter-fed heredoc (`python3 <<'EOF' print('set
.env first')`) — the C1 fix widened this FP because executor bodies are no longer stripped.
