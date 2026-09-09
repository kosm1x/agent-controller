# trustr remote dead-end — R2 verification (2026-09-01)

R1's 6 folds re-verified in the working tree. Verdict: **SHIP**, 0 Critical, 0 High.
232/232 GREEN on the 3 allowed files, `tsc --noEmit` exit 0. All 5 code folds carry a
live mutation-sensitive pin; the prose fold does not.

## Doctrine crumbs

1. **Answer "did the new regex lose a shape?" with a printed OLD-vs-NEW table, not prose.**
   22 real remote spellings through both extractors in one `node -e`: the only shapes where
   NEW returns null while OLD matched are (a) `https://github.com:443/o/r.git` — where OLD's
   `[^/]+` had produced the BOGUS name `443/o` (a false "does not exist"), so NEW skipping is
   a fix, not a loss; (b) a stderr line trailing the URL under `2>&1` (`$` is end-of-input in
   JS, no `m` flag); (c) the four injection shapes NEW is meant to reject. **No shape loses a
   check that was previously correct.** Run the table before calling an anchoring change safe.
2. **Alphabet agreement is a MEASURABLE property, not an argument.** Feed the allow-list's
   accepted set through the downstream extractor and count unextractable: 11/11 accepted URLs
   extract, 0 skipped. That is the R1 crumb-2 class closed with a number. Degenerate names
   (`-/-`, `./..`, `o/.git`) extract and then fail SAFE — cobra rejects a leading `-`, gh 404s
   the rest, and the `git remote add` write never runs.
3. **A path-guard hoist is pinned by asserting the guard fired BEFORE any subprocess.**
   `expect(mockExecSync).not.toHaveBeenCalled()` after a blocked cwd goes RED the moment the
   hoisted `resolveWorkDir(cwd)` is deleted (the `gh auth status` call reappears). Stronger
   than asserting the message text alone.
4. **Probe a CLI's flag-vs-cwd precedence with a deliberately-failing target.** `gh repo
   create <nonexistent-org>/x --source <dir>` from a *different* git repo: with a non-repo
   source it names the SOURCE path ("is not a git repository"), with a real source it reaches
   `HTTP 404 …/users/<org>`. Proves `--source` beats process cwd (the tool runs gh in
   DEFAULT_CWD) and that a commit-less repo is accepted — so "right after git init" in the
   tool description is honest. Zero side effects: nothing is created.
5. **Prettier drift is only visible against HEAD.** `prettier --check` flagged 3 files, but
   `git show HEAD:<f>` piped through prettier showed 1 was ALREADY dirty. Only the delta
   counts — check the pre-image before calling formatting a violation of the change.
6. **The prose half of a two-half fix is the unpinned half.** The tool descriptions and the
   Spanish `GIT Y GITHUB` block are how the LLM learns the new params; `prompt-sections.test.ts`
   has zero references to them, so deleting both new lines leaves 232/232 GREEN. `codingSection()`
   already has assertion-style tests — a prose fold with an existing test host and no test is a gap.
7. **A guard reason rewritten on ONE pattern leaves sibling spellings on the stale text.**
   `git -C <dir> remote add …` misses `/\bgit\s+remote\s+…/` and falls to the generic
   `\bgit\b[^|;&]*\b(push|commit|add)\b` reason. Also found pre-existing: `git config
   remote.origin.url <url>` is not blocked at all and `git remote rm` isn't either (`remove`
   only). Deny-lists of spellings never converge — the reason text is routing, not a boundary.
