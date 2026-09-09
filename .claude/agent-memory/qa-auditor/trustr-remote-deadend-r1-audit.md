# trustr remote dead-end — R1 audit (2026-09-01)

Bundle: `gh_repo_create` gains `cwd` (→ `gh repo create --source <dir> --remote origin`),
`git_push` gains `remote` (regex-gated GitHub HTTPS URL, existence-checked before
`git remote add`), shell-guard reason rewritten. Files: `src/tools/builtin/git.ts`,
`shell.ts` + both test files. Verdict: **PASS WITH WARNINGS**, 0 Critical, 2 High.

## Doctrine crumbs

1. **`gh repo create --source` resolves the OWNER via the API BEFORE it checks the
   local remote.** Probed safely with a nonexistent org and a source dir that already
   had `origin`: the error was `HTTP 404 … api.github.com/users/<org>`, not
   "remote already exists". So on a repo that already has `origin`, gh creates the
   GitHub repo and only then fails on `git remote add` — orphaning a fresh, possibly
   PUBLIC repo. gh *does* check `IsLocalGitRepo` before the API (a bad path fails safe).
   **Probe recipe**: to learn a CLI's internal ordering without a live side effect,
   feed it an input that makes the network step fail (nonexistent org) — the error
   text names which check ran first.
2. **An input allow-list and its DOWNSTREAM extractor must share one alphabet.**
   `GITHUB_HTTPS_REMOTE_RE` admits dots in the repo name; the existence-check
   extractor `/github\.com[:/]([^/]+\/[^/.]+)/` stops at the first dot, so
   `…/o/socket.io.git` → `o/socket` → 404 → "does not exist on GitHub. Create it
   first" — the fix re-creates the exact dead-end class it was written to remove.
   Always run the accepted-input set through every downstream parser.
3. **A bare `catch` becomes a WRITE-ENABLING branch the moment a fix adds a write
   to it.** `catch` around `git remote get-url origin` was a read-only "no origin"
   signal; it also swallows `resolveWorkDir`'s path-guard rejection. Still fail-safe
   here only because the later `runArgs(..., cwd)` re-runs the guard. Re-audit every
   pre-existing bare catch that a diff turns into a decision point.
4. **A deprecated CLI flag missing from `--help` is not removed.** gh 2.67.0 still
   accepts `--confirm`; it prints `Flag --confirm has been deprecated…` to **stderr**
   and proceeds. `stdio:["pipe","pipe","pipe"]` + stdout-only return hides it.
   Never conclude "flag gone" from help text — force a parse error to test.
5. **Mutation counts get rounded up in docs.** The queue entry said "7+1 new tests,
   mutation-verified RED on the old code"; 2 of the 8 pass unchanged on old code
   (the tools ignored the new params), so it is 6/8 RED + 2 forward regression
   guards. State the split, not the total.

## Verified-good (don't re-litigate)
- `--push` deliberately omitted ⇒ `--source` never uploads working-tree content.
- Every write routes through `resolveWorkDir` ⇒ `checkMissionControlAccess` still
  blocks the primary mission-control checkout via the new `cwd`/`remote` paths.
- `remote` cannot rewrite an existing origin (the write lives only in the
  no-origin catch); `execFileSync` array args + the regex block metachars,
  userinfo, ports and non-GitHub hosts.
