# classifier foreign-repo nanoclaw guard audit (2026-06-20)

`targetsForeignRepo()` + `FOREIGN_REPO_PATH` regex in `src/dispatch/classifier.ts:210` guards the
nanoclaw routing branch so coding tasks naming a sibling `/root/claude/<repo>` fall through to HOST
runners (nanoclaw only mounts `/root/claude/mission-control:ro`, clones it to /workspace). Fixes the
W25 Williams-Journal silent-no-publish regression.

VERDICT: PASS WITH WARNINGS. Regex itself is correct & tight; fall-through landing is correct
(`src/tools/builtin/git.ts:16` ALLOWED_CWD_PREFIXES includes `/root/claude/thewilliamsradar-journal/`,
so host fast/heavy/swarm reach it). 49/49 tests green. But the guard is PATH-LITERAL only.

KEY GAP (warning, not fixed): the regression-class input recurs when the task is coding-by-keyword
(`repo`/`git`/`commit`) but does NOT literally type the path. Verified empirically:
- "Chat: commit the journal repo and push to origin" → isCodingTask=true, targetsForeignRepo=false → NANOCLAW (regression survives)
- "Chat: git commit del journal semanal y push" → same
The actual messaging title is `Chat: <60-char user msg>` and detectText=title-only for messaging, so
unless the operator pastes the absolute path in the first ~60 chars, the guard whiffs. The test's
scenario ("git_commit en /root/claude/thewilliamsradar-journal") puts the path literally in the
description — only catches the path-literal subset.

Other notes:
- Regex `[a-z0-9]` leading guard correctly rejects `/root/claude/...` ellipsis (persona embeds only
  `/root/claude/mission-control`, verified) and leading `.`/`_`/`-` repos.
- Negative-lookahead `(?!mission-control(?:[/\s]|$))` FALSE-POSITIVE-EXCLUDES `mission-controlx` and
  `mission-control.bak` (matches as foreign because boundary char after `mission-control` is `x`/`.`
  which fails the lookahead → treated foreign). Theoretical only: no live `/root/claude/mission-control*`
  dir besides mission-control itself. NOT a real-traffic bug today.
- detectText asymmetry: non-messaging uses title+description (path in either catches); messaging uses
  title only. A foreign path that appears ONLY in the description of a messaging task is missed — but
  messaging detectText has always been title-only by design (description is persona-inflated).

DOCTRINE: a path-literal guard for a "wrong-runner" routing bug only catches inputs that name the
path. The bug's true trigger is the SEMANTIC class (operate on sibling repo), which the coding
classifier recognizes by keyword without the path. Either (a) make the journal/sibling-repo publish a
ritual with explicit agentType (bypasses classifier entirely), or (b) detect the repo by its
domain keywords (journal/williams) not just the absolute path.
