---
name: evolution-log-commit-ritual-audit
description: Weekly evolution-log-commit durability ritual (2026-06-17) — FAIL, dead-on-arrival on main branch + bare-commit dirty-index sweep risk
metadata:
  type: project
---

# evolution-log-commit ritual audit (2026-06-17) — FAIL

Weekly ritual added as the durability backstop for the 2026-06-17 EVOLUTION-LOG truncation. `src/rituals/evolution-log-commit.ts` `createEvolutionLogCommit()` → fast runner, tools `[git_status, git_commit, git_push]`, cron `0 3 * * 0` (Sun 03:00 MX). Commits `docs/EVOLUTION-LOG.md` weekly.

## C1 — DEAD ON ARRIVAL: git tools blocked on `main` (the service branch)
- mc service runs on `main`. `git.ts` `resolveWorkDir()` → `checkMissionControlAccess()` THROWS for any cwd under `/root/claude/mission-control/` unless branch matches `JARVIS_BRANCH_RE = /^jarvis\/(feat|fix|refactor)\/.+$/`. `main` does not match.
- ALL THREE tools route through this: `git_status` (run()→resolveWorkDir, git.ts:157), `git_commit` (runArgs→resolveWorkDir, :292), `git_push` (additionally has explicit main-on-mc block :384-391). Ritual throws at STEP 1 (git_status). Never commits. Backstop is inert.
- The ONLY ritual that commits mc — `autonomous-improvement.ts` — does it correctly: `jarvis_dev action="branch"` (creates jarvis/* branch) → fix → `action="pr"`. Never `main`. The new ritual ignored this established pattern.
- Fix options: (A) ritual uses `jarvis_dev` to branch+PR the log like autonomous-improvement (heavy, defeats "weekly tiny commit"); (B) add `docs/EVOLUTION-LOG.md` as a narrow append-only exception to `checkMissionControlAccess` so a docs-only commit on main is permitted; (C) commit via a mechanical (non-LLM) cron like kb-backup using execFileSync with `git add docs/EVOLUTION-LOG.md && git commit -- docs/EVOLUTION-LOG.md` directly, bypassing the LLM git tools entirely. (C) is most robust and matches the "mechanical backup" rituals (kb-backup, kb-reindex).

## C2 — `git_commit` sweeps a dirty/pre-staged index (bare commit, no pathspec)
- `gitCommitTool.execute` (git.ts:292,305): `git add <files>` then BARE `git commit -m <msg>` — NO `-- <pathspec>`. Commits ALL staged content, not just `files`.
- `SENSITIVE_PATTERNS` (.env/credentials/secret/.key/.pem/token) only filters the `files[]` ARG (git.ts:284-289) — it does NOT scan already-staged content. A pre-staged secret would be committed.
- mc is a SHARED worktree (operator + Jarvis share .git, see feedback_shared_worktree_branch_inheritance). If the operator (or another tool/jarvis_dev mid-flow) has staged changes when the 03:00 cron fires, those get swept into the "weekly durability commit" and pushed.
- Real exposure if C1 is fixed without also scoping the commit. Fix: change commit to `git commit -- <files>` (pathspec-scoped) OR `git commit -o <files>` so only the named paths are committed regardless of index state. This hardens git_commit for ALL callers, not just this ritual.

## Lower severity
- W: `git.ts` hardcodes `GITHUB_ORG="EurekaMD-net"` but mc remote is `kosm1x/agent-controller`. Not hit by push path (uses `git remote get-url origin`) but a latent trap.
- Info: cron timing is fine — no 03:00 collision; Sat 23:59 evolution-log entry IS captured by Sun 03:00 commit. Sunday 03:00 is sane.
- Info: anti-git-recovery guard in daily evolution-log.ts (`Do NOT run git add/commit`) does NOT contradict this sanctioned committer — separation (daily appends / weekly commits) is clean and documented in both file headers.
- Info: no-op/empty-commit path is double-guarded (prompt STOP + git_commit "Nothing staged to commit" return) — harmless even if LLM tries.
- Info: push-failure non-fatal is prompt-only; a wedged retry-storm isn't possible because tools throw, not loop.

## Test quality
- Count bumps CORRECT: base 18→19, hindsight-disabled variant 17→18, stop 18→19, override 18→19. Verified by `npx vitest run` — 43/43 pass.
- Dispatch-wiring test (scheduler.test.ts:434) is GENUINE — asserts submitTask called + title matches `/Evolution log commit/`; would fail "Unknown ritual" if switch case missing. Mirrors the pm-daily-rebalance R2 MAJ-1 void-wrapper fix.
- Factory tests are string-assertions on the PROMPT (tools list, "files: [...]", no-op, cwd). They are NOT tautological but they CANNOT catch C1/C2 — no test exercises the real git tools against the branch gate. That's the gap that let a dead-on-arrival ritual ship green.

## Doctrine
- A ritual that grants git tools targeting mc on `main` is inert by construction — the git-tool branch gate (`checkMissionControlAccess`) is mc-wide. Trace tool→resolveWorkDir→branch gate before trusting any mc-committing ritual. Tests on prompt strings + dispatch wiring pass while the tool itself throws at runtime.
- `git_commit` is index-scoped not pathspec-scoped: `git add <files>; git commit` ≠ committing only `<files>`. Any "commit only file X" claim on this tool is FALSE if the index is dirty.
