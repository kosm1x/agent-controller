# Agent Learnings — mission-control (Jarvis)

## Standing rules
- Measure demand in mc.db before rating any external capability for Jarvis. Examples: 1 voice note since 06-25 (so R2T2 streaming ASR is no use); 0 `seo_*` calls in 30 days (so open-seo is no use).
- `task_trace_events` keeps only ~30 days. For longer horizons use `scope_telemetry` (from 2026-06-25). Run `.tables` + `pragma table_info(<t>)` before the first query.
- Group activation is not usage. `active_groups LIKE '%seo%'` hit only broad turns that switch every group on, so print sample rows before counting activation as demand.
- For a threshold re-tune, first reproduce the registered replay number from STORED answers, then walk forward. A fixed threshold that drifts does not mean periodic re-tuning helps: the Jev scope 0.70 walk-forward gave 92.6 % vs 92.0 % fixed, +2 turns of 299.
- Check whether a grid-search pick sits on the grid edge before trusting it.
- Replay/result files that carry user message text are sensitive: delete them when the readout closes, then check the backup paths too (`scripts/backup-state-bundle.sh` bundles only named `data/` subdirs).
- For a "no demand today" verdict, write a trigger-gated findings doc (e.g. `docs/planning/seo-capability-findings-2026-09-23.md`) so a later step-up starts from facts.

## 2026-09-23 — Jev walk-forward, open-seo, R2T2 (Jarvis side)
- **Mistake:** `pkill -f <pattern>` inside a compound Bash command matched its own shell and killed it (exit 144) → `pgrep -f` first, then `kill <pid>` in a separate call.
- **Mistake:** deleted a reviewed clone right after the verdict, then had to re-clone it for the findings doc → keep review clones in the scratchpad until the session ends.
- **Avoid:** putting `git` and `grep` in the same Bash command. The hook-bypass guard scans the whole string → run git commands alone.
- **Better:** voice-note transcription (`src/inference/transcription.ts`) is batch and Whisper-compatible, and almost unused. Check that call site first before probing any new ASR for Jarvis. Pipesong is the only streaming consumer.

## 2026-09-24 — Jarvis PR review (#37, #33 closed; #32 redone as 9d825dd)
- **Mistake:** rewrote the nanoclaw env-note guard around the incident's "read-only mc.db mount" without re-reading today's mount list; SEC-02 (4b353ac) had removed that mount, so the guard stated a false fact (qa R1 FAIL) → before writing any prompt text about the sandbox, read `nanoclaw-runner.ts` volumes + `MC_DB_PATH` on the CURRENT base, not the incident report.
- **Mistake:** put a review worktree under the scratchpad; `shell.test.ts` resolves `cd ..` against the real FS, so the pre-commit full suite failed there only → create temporary worktrees beside the main checkout (`/root/claude/<name>-tmp`) and remove them after the push.
- **Avoid:** reviewing a Jarvis PR on its own base. Check `git rev-list --count <branch>..origin/main`, trial-merge with `git merge-tree`, and replay its test inputs on main: #32's classifier rule was already redundant (5c279d0), #37's hunk re-added code main had removed.
- **Better:** measure each PR's premise in live data before judging the code: request rate vs the vendor limit (#37: 1/15 min vs 1/5 s), whether the configured ID still exists (#33: schedule recreated 09-23), and whether the incident has recurred (#32: 0 in 30 days).

## 2026-09-24 — jarvis_dev branch base (root cause of the stale #33/#37 PRs)
- **Mistake:** wrote git-fixture tests (tmpdir repos) whose helper inherited `process.env`; the pre-commit hook exports `GIT_DIR`/`GIT_INDEX_FILE`, so under the hook every fixture call hit the REAL repo (tests red + `user.email t@t` written to the shared `.git/config`; qa R1 caught it before commit) → any test that spawns git passes an env with every `GIT_*` key stripped; prove it by running the file with `GIT_DIR` pointed at a scratch repo.
- **Mistake:** ran `npm run eval:gate -- --run` from a temp worktree; the inherited live `MC_DB_PATH` is relative and resolved against the worktree (no `data/`) → from a worktree pass `MC_DB_PATH=/root/claude/mission-control/data/mc.db` explicitly.
- **Avoid:** `try { git checkout main } catch {}` in Jarvis's linked worktree — git refuses (`main` is held by the primary), the swallow hid it, and `checkout -b` stacked every new branch on the previous one → cut branches with `fetch origin main` + `checkout --no-track -b <name> origin/main`, and return every git failure.
- **Mistake:** rewrote two `jarvis_dev` description lines without checking length; it sat at 1497/1500 (`registry.test.ts` DESC_THRESHOLD), went to 1616 (qa R2) → before editing any tool description, measure its headroom and run `registry.test.ts` scoped; start the paid eval gate only on the FINAL text.

## 2026-09-24 — jarvis_dev action=pr staging paths + node_modules ignore
- **Avoid:** parsing `git status --porcelain` through a helper that `trim()`s the whole output — the first entry's leading status space vanishes and `slice(3)` eats a path char (`src/x.ts` → `rc/x.ts`) → use raw `status --porcelain -z --untracked-files=all` and `--literal-pathspecs add -- <paths>`.
- **Avoid:** treating both rename columns alike: an index rename (X=R) must SKIP the original path, a worktree rename (Y=R, intent-to-add) must STAGE it (it's a worktree-only deletion) — qa R2 caught my first fold, which skipped both; assert a clean tree after staging, not just the returned list.
- **Avoid:** `name/` ignore patterns for a path that can be a symlink — a trailing slash matches directories only; the worktree's `node_modules` symlink was hidden only by `.git/info/exclude`.
