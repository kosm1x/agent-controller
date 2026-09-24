# Agent Learnings — mission-control (Jarvis)

## Standing rules
- Measure demand in mc.db before rating any external capability for Jarvis. Examples: 1 voice note since 06-25 (so R2T2 streaming ASR is no use); 0 `seo_*` calls in 30 days (so open-seo is no use).
- `task_trace_events` keeps only ~30 days. For longer horizons use `scope_telemetry` (from 2026-06-25). Run `.tables` + `pragma table_info(<t>)` before the first query.
- Group activation is not usage. `active_groups LIKE '%seo%'` hit only broad turns that switch every group on, so print sample rows before counting activation as demand.
- For a threshold re-tune, first reproduce the registered replay number from STORED answers, then walk forward. A fixed threshold that drifts does not mean periodic re-tuning helps: the Jev scope 0.70 walk-forward gave 92.6 % vs 92.0 % fixed, +2 turns of 299.
- Check whether a grid-search pick sits on the grid edge before trusting it.
- Replay/result files that carry user message text are sensitive: delete them when the readout closes, then check the backup paths too (`scripts/backup-state-bundle.sh` bundles only named `data/` subdirs).
- For a "no demand today" verdict, write a trigger-gated findings doc (e.g. `docs/planning/seo-capability-findings-2026-09-23.md`) so a later step-up starts from facts.
- A version/pointer move owns every derived flag (certified, embedded): reset it in the LOWEST shared writer (`pointSkillAtVersion`), not in one caller — the boot scan and seed `skillSave` bypassed a caller-level decertify (#40 qa C1, #41 qa R2 W1). A write-back from a measurement keys on the exact version measured (`AND current_version_id = ?`; #41 qa C1: a slow run of a superseded version certified a failing newer one).
- A "never delivered / never happens" gate lives at the seam EVERY terminal path shares — enumerate each task status → handler (completed, blocked, needs_context, failed, cancelled, timeout) before claiming "never". The scope-ask gate sat on `handleTaskCompleted` only; the model ends a scope ask with STATUS: BLOCKED, so 34/34 real asks (08-24→09-24) went through `handleTaskFailed` verbatim while the invariant said NEVER. Same class as the pointer-move rule above: fix at the lowest shared point, not the caller you looked at.
- Live-test scripts for Jarvis: pin `"agent_type": "fast"` when the task exercises host tools (file-shaped text → nanoclaw, which lacks them; task 9ce19a10); run every verification query once before handing the script over; put cleanup in `trap … EXIT` (an ambiguous-column query under `set -e` skipped the archive, task 0878a62a).

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

## 2026-09-24 — Jarvis versioned skills (ogilvy "can't store the version")
- **Mistake:** my first SKILL.md template used `tests_json: '[]'` and pointed the model at `skills/ogilvy-slogan/` — both fail the skill critic (≥2 tests, verb-led name) → read `src/skills/critic.ts` SKILL_CRITIC_SYSTEM_PROMPT before writing any skill template or skill file.
- **Avoid:** guarding only the model's write tools when a scheduled importer (hourly kb-reindex) turns ANY disk write (shell_exec, editor) into a registry row — close the door at the importer (`MANAGED_FILE_RE`), keep tool refusals for the error message.
- **Better:** settle "already registered" (sha of the body) BEFORE a paid LLM gate — an identical rewrite must not cost, or be failed by, the critic.


## 2026-09-24 — skill auto-certify + monotonic versions
- **Mistake:** ran tests inside the registration step, BEFORE the KB write; a cut-short run left DB and file disagreeing and the identical-rewrite recovery refused (qa R1 W3) → return the slow step as a continuation the caller runs after the durable write.
- **Avoid:** an unbounded "rewrite to retry" path on a paid gate — a real failure became a flaky pass after 6 identical rewrites (qa R1 W2) → retry only infrastructure outcomes (error/timeout), cap runs per version.
- **Avoid:** running a mc-ctl copy from a worktree: `PROJECT_DIR` is hard-coded to the LIVE checkout → copy it to scratch with `PROJECT_DIR` sed-replaced; mc-guard also blocks any `rm`/write `sqlite3` on a path ending `mc.db`, so seed scratch DBs through `initDatabase` in a tsx script.
- **Better:** a DB trigger as the structural backstop (`skills_version_monotonic`) + early refusals in each writer for the clear message; a pre-check before an await is racy, so the record+point pair runs in one transaction that turns the trigger error into a typed refusal.
- **Avoid:** a queued request can name work already finished (the "check qa, fold, PR" message arrived after #41 merged and its worktree was deleted) → check the branch, worktree and PR state before acting on it.
- **Mistake:** the status table's test count sat at 9,182 and the README at 8,896 while the headline said 9,326 → when a wrap updates a count, grep every doc that quotes it (`grep -nE "[0-9],[0-9]{3} tests" README.md docs/PROJECT-STATUS.md`).

## 2026-09-24 — scope ask delivered on the BLOCKED path ("Necesito `shell_exec`" for a domain check)
- **Mistake (inherited, 08-23 Phase 1.2):** the scope-miss gate was tested only through `task.completed` → any output gate needs one test per terminal status the model can pick; count the corpus by status first (`tasks.status` × delivered reply) — here 34 of 34 asks were `blocked`.
- **Avoid:** trusting `[router] Stored prior scope` — it printed the groups the turn RAN with, not the base actually stored; turn 1's stored prior was empty, so the follow-up could not inherit `coding` (log fixed to print both).
- **Avoid:** reading the 09-05 classifier-timeout fix as closing "blocked turns ask for shell_exec" — it fixed one feeder; the delivery path stayed open and the symptom recurred 13 more times.
- **Better:** `/diagnose` from the task row (status, tool_calls=0) → `scope_telemetry` (tools_in_scope) → journal scope lines → the handler that the status routes to; then replay the stored replies through the detector (34/34 caught, 0/6 real questions) before writing the fix.
- **Avoid:** a `.catch` on a call that never rejects (`TelegramStreamController.finalize()` swallowed its own failures) — the fallback path is dead and a missed placeholder drops the reply silently; fix the shared callee (send fresh when no placeholder landed, run once), which covers every caller at once.

## 2026-09-24 — #41/#42 open items (sweep recovery, certify cancel + claim, heavy scope gate)
- **Mistake (inherited, v7.7 sweep):** the 6 h test sweep examined only `is_certified=1`, so ONE 30 s LLM timeout decertified 5 healthy skills for 3+ months → any flag a transient error can clear needs a path that re-evaluates it; query the population the gate can never reach (`is_certified=0` with no `fail` row).
- **Mistake:** my first retry bound counted unfinished runs "since the version's last pass" — a passing sibling test reset the count every tick, so a skill with one slow test was retried forever (qa R2) → bound per `test_name`, and pin it with a 2-test mixed fixture.
- **Avoid:** test rows that all share one `datetime('now')` second — the per-version mutant stayed GREEN because every row tied with the last pass; stagger `ran_at` per tick before trusting a time-window predicate's test.
- **Better:** two runners of the same resource (kb-file certify + sweep) share ONE claim (`claimCertificationRun`) taken with no await after the last check; re-check the cap at claim time, not only at registration.
- **Better:** when a gate must replace a long partial deliverable, cut only the offending tail (`stripScopeAskTail`, re-checked by the same detector) — replacing the whole report re-created the "7 minutes of work discarded" bug the branch exists to prevent (qa R1 W3).
