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
- A red `main` is an open defect, never a baseline: run `gh run list --branch main --limit 3` before any merge and fix or log the red. #41–#43 merged over a main red since ≤09-22 that memory had normalized ("compare a PR's failing set to main's"), and a known-red set hid a timing flake until #44 cleared it.
- Verify against the CURRENT tree and live state, never an incident report, a PR's own base or a queued message: re-read today's code before writing prompt text about it (the SEC-02 `4b353ac` mount removal made a guard state a false fact); for a Jarvis PR run `git rev-list --count <branch>..origin/main`, trial-merge with `git merge-tree` and replay its test inputs on main (#32 redundant, #37 re-added removed code); check branch, worktree and PR state before acting on a queued request (the post-merge #41 request).
- Temporary worktrees: create them beside the main checkout (`/root/claude/<name>-tmp`, not the scratchpad — `shell.test.ts` resolves `cd ..` on the real FS) and remove them after the push; from a worktree pass `MC_DB_PATH=/root/claude/mission-control/data/mc.db` explicitly (the inherited relative path resolves against the worktree); never run a `mc-ctl` copy as-is (`PROJECT_DIR` is hard-coded to the live checkout — copy it to scratch with `PROJECT_DIR` sed-replaced, and seed scratch DBs through `initDatabase` in a tsx script, since mc-guard blocks `rm`/write `sqlite3` on a path ending `mc.db`).
- Bound every retry on a paid or certifying gate: retry only infrastructure outcomes (error/timeout), and count unfinished runs per `test_name` since that test's last pass — a per-version count let a passing sibling reset it every tick (#41 qa R1 W2, #43 qa R2); pin the bound with a 2-test mixed fixture.
- Diagnose from stored rows before reading code: task row (status, tool_calls) → `scope_telemetry` / `task_trace_events` (tool sequence of a working vs a failing task) → journal → the handler the status routes to; reproduce an upstream with a direct `curl` (#42, #47).
- Replay the stored corpus old-vs-new through a detector or term list BEFORE writing or trusting it — unit tests cannot see corpus-level false positives (#42: 34/34 asks caught, 0/6 real questions; #50: 34 of 36 alias hits were noise).
- Prove each new test with a mutant that goes RED: rows sharing one `datetime('now')` second kept a per-version mutant GREEN until `ran_at` was staggered (#43); mutation-check each qa fold (#50).
- Timing tests: size each adversarial input so the slow (quadratic) code takes seconds instead of hanging CI and the pre-commit hook (vitest cannot interrupt a synchronous parse), keep the real-cap test for valid input only, and put the bound between the measured linear worst case and a mutant's time (#44: 800 ms vs ≤ 520 ms real / 984 ms mutant; #48).

## 2026-09-23 — Jev walk-forward, open-seo, R2T2 (Jarvis side)
- **Mistake:** `pkill -f <pattern>` inside a compound Bash command matched its own shell and killed it (exit 144) → `pgrep -f` first, then `kill <pid>` in a separate call.
- **Mistake:** deleted a reviewed clone right after the verdict, then had to re-clone it for the findings doc → keep review clones in the scratchpad until the session ends.
- **Avoid:** putting `git` and `grep` in the same Bash command. The hook-bypass guard scans the whole string → run git commands alone.
- **Better:** voice-note transcription (`src/inference/transcription.ts`) is batch and Whisper-compatible, and almost unused. Check that call site first before probing any new ASR for Jarvis. Pipesong is the only streaming consumer.

## 2026-09-24 — Jarvis PR review (#37, #33 closed; #32 redone as 9d825dd)
- **Better:** measure each PR's premise in live data before judging the code: request rate vs the vendor limit (#37: 1/15 min vs 1/5 s), whether the configured ID still exists (#33: schedule recreated 09-23), and whether the incident has recurred (#32: 0 in 30 days).

## 2026-09-24 — jarvis_dev branch base (root cause of the stale #33/#37 PRs)
- **Mistake:** wrote git-fixture tests (tmpdir repos) whose helper inherited `process.env`; the pre-commit hook exports `GIT_DIR`/`GIT_INDEX_FILE`, so under the hook every fixture call hit the REAL repo (tests red + `user.email t@t` written to the shared `.git/config`; qa R1 caught it before commit) → any test that spawns git passes an env with every `GIT_*` key stripped; prove it by running the file with `GIT_DIR` pointed at a scratch repo.
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
- **Better:** a DB trigger as the structural backstop (`skills_version_monotonic`) + early refusals in each writer for the clear message; a pre-check before an await is racy, so the record+point pair runs in one transaction that turns the trigger error into a typed refusal.
- **Mistake:** the status table's test count sat at 9,182 and the README at 8,896 while the headline said 9,326 → when a wrap updates a count, grep every doc that quotes it (`grep -nE "[0-9],[0-9]{3} tests" README.md docs/PROJECT-STATUS.md`).

## 2026-09-24 — scope ask delivered on the BLOCKED path ("Necesito `shell_exec`" for a domain check)
- **Mistake (inherited, 08-23 Phase 1.2):** the scope-miss gate was tested only through `task.completed` → any output gate needs one test per terminal status the model can pick; count the corpus by status first (`tasks.status` × delivered reply) — here 34 of 34 asks were `blocked`.
- **Avoid:** trusting `[router] Stored prior scope` — it printed the groups the turn RAN with, not the base actually stored; turn 1's stored prior was empty, so the follow-up could not inherit `coding` (log fixed to print both).
- **Avoid:** reading the 09-05 classifier-timeout fix as closing "blocked turns ask for shell_exec" — it fixed one feeder; the delivery path stayed open and the symptom recurred 13 more times.
- **Avoid:** a `.catch` on a call that never rejects (`TelegramStreamController.finalize()` swallowed its own failures) — the fallback path is dead and a missed placeholder drops the reply silently; fix the shared callee (send fresh when no placeholder landed, run once), which covers every caller at once.

## 2026-09-24 — #41/#42 open items (sweep recovery, certify cancel + claim, heavy scope gate)
- **Mistake (inherited, v7.7 sweep):** the 6 h test sweep examined only `is_certified=1`, so ONE 30 s LLM timeout decertified 5 healthy skills for 3+ months → any flag a transient error can clear needs a path that re-evaluates it; query the population the gate can never reach (`is_certified=0` with no `fail` row).
- **Better:** two runners of the same resource (kb-file certify + sweep) share ONE claim (`claimCertificationRun`) taken with no await after the last check; re-check the cap at claim time, not only at registration.
- **Better:** when a gate must replace a long partial deliverable, cut only the offending tail (`stripScopeAskTail`, re-checked by the same detector) — replacing the whole report re-created the "7 minutes of work discarded" bug the branch exists to prevent (qa R1 W3).
- **Better:** multi-round qa via SendMessage to the SAME auditor (R1 → R2 → R3 deltas) kept each round to one or two minutes and let it re-verify its own findings (it reproduced W1-R2 in sqlite).

## 2026-09-24 — CI green again (#44: 4 VPS-only test files)
- **Mistake:** dated the red CI "since #41, 5 runs" from memory; `gh run list --limit 30` showed ~30 red runs from ≤09-22 → count the streak with `gh run list` before dating it.
- **Mistake:** the first path sweep grepped `/root/claude` and `~/claude` only; the `"$HOME"/claude` and `${HOME}/claude` spellings were missed, and PR CI caught one (vitest stops an `it` at its first failure, so the other was hidden) → sweep every spelling of a root (`/root`, `~`, `$HOME`, `${HOME}`), and reproduce CI locally: a scratch worktree at a non-VPS path plus a fake `HOME=` made main's file fail and the fix pass.
- **Better:** env-coupled tests: derive the checkout from `import.meta.url`, give a fake PATH a node-only symlink dir (the CI toolcache dir also holds a real `npm`), and `it.skipIf` root-only and live-host checks.

## 2026-09-25 — Claude Code role split for this repo (#45, #46)
- **Avoid:** relying on `CLAUDE_CODE_SUBAGENT_MODEL` for "every subagent on Opus": agent `model:` pins win over it (`inherit` → the Fable main model, `sonnet` → Sonnet). `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` enforces it.
- **Better:** cloud sessions read only this repo's `.claude/settings.json` (not the VPS `~/.claude`), so the model split and `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` live here too. Verify with `claude -p --output-format json` (`modelUsage`) and `/context`.

## 2026-09-25 — Jarvis could not read tweets (#47)
- **Avoid:** a tool that returns only the upstream status code. Jina's JSON body said "anonymous access to x.com blocked (someone else's abuse)"; `web_read` passed on "403 Forbidden", and the model read it as "this tweet is private" and gave up. Carry the upstream's reason and a next route in the error.
- **Better:** live-verify a deployed tool fix through `/api/tasks` with `agent_type:"fast"` and `tools:[<tool>]`, then read `tasks.output` and the trace's `tool.called` rows.

## 2026-09-25 — google_news RSS failures (#48)
- **Better:** when a third-party proxy fails, fetch the origin directly from the host before blaming the origin: Google's feed returned 200 from the VPS while rss2json failed, which settled the diagnosis in one curl.
- **Avoid:** lazy `[\s\S]*?` regex spans in an in-process parser of untrusted input. Each unclosed opener rescans to EOF, so a 5 MB hostile feed blocked the event loop > 90 s. Use indexOf scans that stop at the first unclosed opener.

## 2026-09-26 — Jarvis conflated VLCMS with VLMP (#49)
- **Mistake:** hardcoded project-slug lists (`kb-injection.ts` `PROJECT_SLUGS`, `precedent.ts` `projectPatterns`, `entity-extractor.ts` `PROJECT_SLUGS`) drift from the `projects` registry — a project with no KB README, no slug entry and no registry row gets absorbed by its nearest-named neighbour ("VLCMS is part of VLMP"; the vlmp KB doc was updated instead).
- **Avoid:** adding a project in only one of the three places (KB README, registry row, slug list). A slug loop that runs `includes()` also lets a contrast mention ("VLCMS is not VLMP") bind to the wrong slug — check the more specific name before the loop.
- **Better:** new project = KB `projects/<slug>/README.md` + registry row with `config.aliases` (Jarvis can do it via `project_update`, which creates a missing slug) + slug in `PROJECT_SLUGS`; grep `'"vlmp"'` to find the lists.
- **Resolved in #50:** `entity-extractor.ts` no longer has its own list — terms come from the `projects` registry.

## 2026-09-26 — entity-extractor slugs from the registry (#50)
- **Mistake:** the first cut folded every `config.aliases` entry into the extractor. Aliases are tuned for dispatch routing (`williams`, `radar`, `journal`), and a corpus replay showed 34 of their 36 solo hits were NFL surnames or "systemd journal" → replay the last N conversation rows old-vs-new BEFORE trusting a term list; unit tests cannot see corpus-level false positives.
- **Avoid:** fixing an over-matching alias by editing `projects.config` — the dispatcher (`dispatcher.ts` foreign-project names) routes on the same aliases. Stoplist on the consumer side and leave the data alone.
- **Avoid:** normalising an existing knowledge-graph subject ("eurekamD" → "eurekamd") — `knowledge_triples` joins and supersede by exact subject string; check `sqlite3 -readonly ... group by subject` and emit the string the rows already use.
- **Better:** a registry-driven list keeps a static fallback core that covers the registry-read failure path, a log-once warn, and a `_reset…ForTests` hook; mutation-check each fold (empty the stoplist, drop the static entry) so the tests prove the behaviour, not the plumbing.

## 2026-09-26 — Repo-wide docs refresh (34 files, 3 implementers + qa)
- **Mistake:** the orchestrator's "ground truth" block seeded "4 ToolSources" and "234 tools" from memory; the boot log says 5 sources, and two implementers read the same log line as MCP 72 (sources reported) vs MCP 43 (registry holds, after the concurrent-diff double count) → for any count, name the oracle in the brief (`journalctl … "tool sources loaded"` for tools, `package.json` for deps, the pre-commit tail for tests) instead of a number.
- **Avoid:** hand-appending `docs/EVOLUTION-LOG.md` — it is ritual-owned (`src/rituals/evolution-log.ts` writes it 23:59 MX; the prompt forbids editing past entries). A dead link inside an old entry stays.
- **Avoid:** re-wrapping prose so a line starts with `+ ` or `- ` (X-POSTING:132 became a list item); run `npx prettier --check` on every file that was clean at HEAD, using `git show HEAD:<file>` copies as the baseline.
- **Better:** "MERGED, awaiting deploy" markers age silently across PROJECT-STATUS, README and plan headers; resolve them from the journal restart times + `git merge-base --is-ancestor <sha> <live-sha>`, and a repo-wide backticked-path scan (scratchpad `deadlinks.py`) finds stale paths that link checkers miss.
- **Finding (operator):** `gh repo view` says agent-controller is PUBLIC; `docs/EMAIL-VERIFY.md` claimed "private, no AGPL obligation" for the check-if-email-exists port — corrected to a due licence decision.
