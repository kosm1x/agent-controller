# November Assesment — dimension 1 (CODE): review and ruling list

> Opened and closed 2026-11-09 (UTC) at `main` `982aced9`, live build `ecae5e88`. Read-only: nothing in `src/`, `scripts/` or the live host was changed. This file ends at the ruling list; nothing is built until the operator rules.
> Parent: `docs/planning/november-assesment-2026-11-09.md` (§1 Code, score 6). Queue: 4cf, 4cg.

## Method

Eight sub-dimensions, each worked the same way:

1. One or more fresh reviewers (no shared context) with the code, the assessment's measurements and the instruction to verify, extend and size — not to confirm.
2. The orchestrator re-checked every load-bearing claim by direct read, and ran every live-data count itself (read-only).
3. A separate adversarial verifier per item tried to refute the report with its own scripts.
4. Only what survived all three is below. Where the three disagreed, the correction is stated.

No test, typecheck or build was run by any reviewer; every measurement is parse-only or a read-only count. Security and privacy findings are stated here as categories only; file-level detail is kept off-repo.

## Bottom line

- **The score stands at 6, for different reasons.** The assessment blamed size (very large files, no linter, dormant code). The review found size is mostly tolerable and several of those claims were wrong. What actually holds the score down is narrower and more fixable: **(1)** three gaps in the guards around what the agent may write and merge; **(2)** a deploy script that replaces the running code before it checks whether it may, and a post-deploy check that cannot see a failure; **(3)** failures that are logged but never counted or alerted, including a success mark shown to the operator after an approved action failed; **(4)** tests that are numerous and honest but thin exactly where the guards and the emergency path live.
- **What is good and should not be touched:** typing discipline (6 `any`, 0 `@ts-ignore`), the completion ledger (0 bypasses), one database handle, exact dependency pins, real-SQLite tests as the house pattern, the shell gate's structure, and the habit of writing the reason next to the code — about two-thirds of the history-tagged comments carry a real constraint.
- **Nothing found is on fire.** No evidence of data loss or of a bad deploy having run; whether the agent ever merged its own work cannot be answered either way from stored data. Every item is a latent risk or a small live defect.

### Where the assessment was wrong

| Assessment said | Review found |
| --- | --- |
| The alternate inference adapter is dormant | It is the armed emergency path (0 fires ever). Four of its branches are reached by no test. |
| Six functions are too long, five files too large | Eight functions over 500 lines, 22 files over 1,000. Two long functions are genuinely harmful (`dispatchWithSlot`, `orchestrate`); the two inference loops must NOT be split. |
| 138 dynamic imports hide coupling | 173 `import()` calls; they hide almost nothing (the largest cycle grows from 25 to 26 files when they are counted). |
| No linter | No TypeScript linter, but ~30 source-reading lock tests already enforce conventions. A typed linter fits this host badly. |
| 95 % of commits are the agent's | 966 commits in 90 days; ≈ 20 are autonomous agent commits. The rest are operator sessions under the same git identity. |
| Finance is dormant | Finance tools run every weekday. Only the prediction-market branch is idle (parked 10-04). |
| Duplicated helpers are a maintenance burden | Duplication is 0.6–0.8 % of lines. It matters only in a handful of guard copies that have drifted apart. |
| 39 stale compiled files are a deploy hazard | They are inert. The hazard is the ORDER of the deploy steps. |
| Tests mock their own subject; the suite needs ~6 GB | 0 self-mocks. Measured worker peak 341 MB. |
| 268 silent catches are a risk; migrate ~900 console calls to the logger | The count is right; ~75–90 % are correct. The migration would break operator tooling that greps console text. The real short list is ~15 sites. |
| History comments are noise | About two-thirds carry a real constraint; one in twenty is false. What rots is references to other code (line numbers, names, "same as"). |

## The ruling list

Fifteen decisions. Each has a recommendation; "no ruling needed" work is listed under the batch it belongs to. Recommended build order = the order below.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| 1 | **Security batch first?** Three guard gaps (S1–S3 below). | go (right after this list) / now / later | **go** — smallest change with the largest risk reduction in this review |
| 2 | After S2 the agent can no longer propose changes to its own guard files; those become operator-session work only. | accept / keep proposals possible via a reviewed exception path | **accept** — it is already the stated intent |
| 3 | Separate GitHub identity for the agent, so branch rules can tell agent from operator. | now / later / no | **later** — S3 closes the gap in code; this is the durable version |
| 4 | Public-repository hygiene (P1–P3 below): personal data in tracked files; three ignored-but-tracked directories, one holding the auditor's records; docs that describe currently-open weaknesses. | accept / clean current files and untrack the three directories / also rewrite public history / make the repository private | **clean and untrack**; history rewrite only if the operator judges the content sensitive (destructive: breaks clones, forks and the agent's worktree; caches remain) |
| 5 | Deploy: refuse a dirty working tree by default (`--allow-dirty` to override)? | refuse / keep warn-and-record | **refuse** |
| 6 | Deploy: snapshot the database automatically when a migration will run? | yes / no | **yes** (seconds, ~560 MB, helper exists) |
| 7 | Full test suite on every host commit (194 s, growing ~16–20 %/month). | keep / keep + memory fence + add docs-coupled tests / related-files locally, CI as the full gate | **keep + fence + docs-coupled tests** — the 13 red CI runs of the last 17 days are 5 episodes, and 4 of the 5 began on a commit that staged no `.ts` file, where the hook runs nothing (the longest, 9 runs, began on a docs commit that edited a file a test reads; the cause of the other three was not read from the job logs) |
| 8 | Emergency inference path drill: fix its five known defects and pin its unreached branches before it is ever needed. | now (in this dimension) / in dimension 3 Resilience | **now** — it has never run live and would be first used on the worst day |
| 9 | Structure work: how far. | (a) cycle cuts + ratchet only / (b) + pure moves out of `router.ts` and `fast-runner.ts` / (c) + splitting the production SDK path into its own function | **(b)**; (c) only after the tests of batches 5 and 6 exist |
| 10 | Low-activity areas (13.8 % of lines; 86 tools never called in 134 days). Standing ruling: never-called is not removable. | (a) leave / (b) add a per-area registration switch, default ON | **(a)** — plus narrowing the CI video exclusion (Q10) |
| 11 | Unreachable code: 30 exports referenced nowhere, plus four named dead symbols (`hasUserConfirmedDeletion` with its 21 tests, `tierToProvider`, a `conditionMatches` re-export, `execAsync` in the shell tool). Operator names what goes. | remove all / remove named ones / leave | **remove all** (not tools, not areas; plain unreachable code) |
| 12 | Comment rule. | (a) leave / (b) "why, not when": keep constraints, cite a symbol and never a line number, a "keep in sync" comment names the test that pins it / (c) strip history tags | **(b)** for new and touched comments; no mass rewrite |
| 13 | The agent's own test tool runs in the primary checkout while its edits live in its worktree. | run in the worktree / change the tool description (eval gate) | **run in the worktree** |
| 14 | Three redaction helpers each miss pattern classes the others have. Unifying changes the labels in stored recall rows. | unify / leave | **unify** |
| 15 | One paid eval-gate run for all model-visible fixes together (batch 10). | schedule after batches 1–4 / skip | **schedule once**, after the behaviour fixes |

## Rulings

Ruled by the operator on 2026-11-10 at 15:07 UTC, in one answer: **all fifteen as recommended**, build to start.

| # | Ruling |
| --- | --- |
| 1 | **go** — the security batch is built first |
| 2 | **accept** — guard files become operator-session work only. Clarified 2026-11-10 15:55 UTC when the build showed the protected list also holds core files (message handling, task routing, database setup, scheduling; 5 of the agent's 10 merged pull requests touched one): **guards and core both protected, in both checkouts, as a transitory state** — the goal is the agent improving its own code safely; exit conditions = queue 4cj |
| 3 | **later** — separate GitHub identity for the agent stays open, no date |
| 4 | **clean current files and untrack the three directories**; no history rewrite (it stays a separate operator decision) |
| 5 | **refuse** a dirty working tree at deploy (`--allow-dirty` overrides) |
| 6 | **yes** — automatic database snapshot before a migrating deploy |
| 7 | **keep** the full suite at host commit, **plus** the memory fence and the docs-coupled tests |
| 8 | **now** — the emergency inference path drill is part of this dimension |
| 9 | **(b)** — cycle cuts, ratchet and pure moves; (c) only after the tests of batches 5 and 6 exist |
| 10 | **(a) leave** the low-activity areas; narrow the CI video exclusion (Q10) |
| 11 | **remove all** — the 30 unreferenced exports and the four named dead symbols |
| 12 | **(b)** — "why, not when" for new and touched comments; no mass rewrite |
| 13 | **run in the worktree** |
| 14 | **unify** the three redaction helpers |
| 15 | **schedule once** — one eval-gate run after the behaviour fixes |

## Batches

Sizes: S = under a day, M = one to three days, including audit. Every code batch ships as usual: builder → separate auditor → full suite at commit → CI → operator deploy → proof.

### Batch 1 — Security (ruling 1–4, 14) — detail off-repo

**Status 2026-11-11 07:33 UTC — shell write check, first commit COMMITTED `a7ed9174` (queue 4dj), not yet deployed; three review rounds, round 3 passed; the operator runs the read-only replay before the deploy that carries it. Next: second commit, then the third after the replay.**

**Build status 2026-11-10 21:01 UTC — built; the pieces listed here are deployed (see the end of this paragraph).** In the repository, each piece audited by a separate reviewer and green on CI: S4 `613662f0` · S1 + S2 + S6 `0d3ffed9` (test fix `cb65fa7e`) · the protected list checked again on the result when a branch is pushed `791fd0c8` · S5 `5cb63e76` · P2 `f4ba7f0c` (three directories untracked) · P1 `fc3ba82c` (example data in docs, comments and tests is synthetic; one ignored config file untracked; values the running program uses are left for a ruling, queue 4cn). S3 RULED 2026-11-10: the simple rule plus the agent's own GitHub identity, `main` protected on GitHub the same day (queue 4cp); the simple rule `9bc76c44` and identity separation `f17c22e4` are COMMITTED (2026-11-11), not yet deployed: one operator host script, then the deploy (queue 4cs); two text corrections `651151ba` ride the same eval run and deploy (4cu); designs are done for the remaining shell piece (4cv) and for the per-build deploy with rollback (4cw, rulings needed); the shell-route part of S1/S2 touches the same file and follows it; S8 operator script prepared, not run, three rulings (queue 4cm); S7 stays with dimension 6. **DEPLOYED 2026-11-10 22:13 UTC as build `9928c1a8` (PID 705777, 0 startup errors, health 200, same PID after 25 s).** The container worker runs the same build (the build folder is mounted read-only over the image's copy). Live proof is by the test suites; the guards are not probed against real files on purpose, so the first refusal seen in normal use is the field confirmation. S3 and the shell-route piece follow in a later deploy.

| Id | Category | Severity | Size |
| --- | --- | --- | --- |
| S1 | **Write-boundary parity.** The write-capable tools do not all enforce the same path boundary. Fix = one shared boundary + a parity table test that drives every write-capable tool over the same forbidden paths. | High | S–M |
| S2 | **Self-modification guard coverage.** The protected-file guard does not cover every location in which the agent can edit code. | High (governance) | S |
| S3 | **Merge authority enforced in code.** "The agent cannot merge its own work" is a prose rule that code does not enforce on every route. Whether it was ever broken is not answerable from stored data (agent and operator share one login). | High (governance) | S |
| S4 | Two guards that fail open by accident (their "safe to ignore" reason holds only at boot or in tests). | Medium | S |
| S5 | Redaction helpers with mutually missing pattern classes (ruling 14). | Low–Medium | S |
| S6 | A guard helper lives in a file that is not on the protected list. | Low | S |
| S7 | Child-process environment scope on the primary inference path. | Medium (dimension 6) | — |
| S8 | Operator-only hardening, two items (write protection of the live build tree; install-policy parity of the sandbox image). | Low | S |
| P1 | **Personal data in tracked files** (ruling 4): email addresses at real-looking domains in 49 files, phone or chat-id shapes in 7 (14 of these are tests; whether each value is real was not checked). | Medium | S |
| P2 | **Ignored but still tracked**: three directories listed in `.gitignore` remain tracked — browser page snapshots (25 files), logs (4), the auditor agent's memory (218 files, 191 of them audit records). | Medium | S |
| P3 | **Open weaknesses described in public text**: 237 lines pair weakness wording with a guard name (planning docs, archive, source comments, one project-instructions invariant). Going-forward rule adopted 11-09: categories in the repo, detail off-repo. | Low–Medium | rule |
| T1 | Tooling: two source files contain a NUL byte, so plain `grep` skips them silently (every sweep must use `grep -a`). Fix = remove the bytes + a lock test. | Low | S |

Guard tests today: of 24 cells (four write-capable tools × six forbidden-path categories) 5 have a behavioural test, 5 a unit-only test, 14 none. The parity table test of S1 fills all 24.

### Batch 2 — Deploy path (rulings 5, 6)

**Status 2026-11-11 04:29 UTC — DEPLOYED 2026-11-11 04:27 UTC as build `555c888f` (queue 4dg): the new deploy script ran for the first time on a real deploy and ended with verdict OK; the per-build deploy and rollback piece (2c) still waits for rulings (4cw).**

**Build status 2026-11-10 23:40 UTC — committed, NOT yet deployed.** R5 + R9 `e8d35597` (CI runs the build and checks its artifacts; the admin script is linted and its dead check is gone). R3 + R4 + R6 and rulings 5 and 6 `8f81accd`, three audit rounds by a separate reviewer, CI green: every refusal now comes BEFORE the build (uncommitted code unless `--allow-dirty`, installed packages that differ from the lockfile, running tasks, the migration check); a snapshot is taken and verified before a deploy that will migrate the database; after the restart the script requires the same process for the whole stability window with no restart counted, a healthy loopback answer and every previously connected channel connected again, compares the tool count and counts error lines of the new process only; one system-log line per attempt and one boot line naming the build. The decisions live in a library that loads only in an operator context and is tested with stub commands (86 tests). The first real deploy exercises it: expect the task check first, `[deploy] OK` about 15 s after the restart, and exactly one `mc-deploy` log line; a FAILED verdict means the new build is already running. OPEN: R1 and R2 (per-build directory, link flip, rollback) are a separate design (queue 4cq(e)). The interim rule below stays until R1 ships, narrowed: a refusal no longer leaves anything on disk; a build error or an interruption AFTER the build still does.

Findings: the script builds over the live `dist/` BEFORE it checks for running tasks, so any of eight exit paths after the build (blocked, build error, Ctrl-C…) leaves new code on disk under the old process — and 91 unit starts in 30 days were not all deploys (≈ 18 were health-check, watchdog or package-upgrade restarts that boot whatever is on disk, with none of the deploy checks). The post-restart check passes on a crash loop (it stops at the first new PID), its error count has never matched a logger line since it was written (07-05; the logger writes level labels, the pattern expects numbers) and its window is the few seconds the PID switch took. There is no rollback; the printed hint is unsafe. CI never runs the build.

| Id | Change | Size |
| --- | --- | --- |
| R1 | Guard first; build into a per-build directory; flip a `dist` symlink; keep the previous tree. The old process keeps importing its own tree until it exits. Closes the half-deployed state and the mixed-tree window, removes the stale files, makes rollback free. | S–M |
| R2 | `--rollback` (flip back, restart, same checks); delete the unsafe hint. | S |
| R3 | Real post-restart check: same main PID for ≥ 15 s; loopback health shows the channel connected; tool count equals the previous boot; corrected error pattern and window. | S |
| R4 | Provenance: one syslog line per deploy and one boot line naming the build. | S |
| R5 | CI job runs the build. | S |
| R6 | Deploy compares host `node_modules` with the lockfile and refuses on mismatch. | S |
| R9 | Lint `mc-ctl` in the shell-lint workflow; delete its one check that greps for strings no code emits. | S |

Interim operating rule until R1 ships: **a deploy that stops before the restart is half-done — re-run it to the end.**

### Batch 3 — Live defects (ruling 13 only)

**Status 2026-11-11 07:33 UTC — six more fixes COMMITTED `a823bbf9` (queue 4dk), not yet deployed: stop sequence (direct calls, isolated steps, triggers stopped), adapters stop independently, notice character, fast-path filter, usage kept on the fallback switch. Every batch 3 item that needs no ruling is committed; three wait for rulings.**

**Status 2026-11-11 06:33 UTC — four more fixes COMMITTED `e59234af` (queue 4di), not yet deployed: cancel leaves completed-with-concerns alone, cost booked on the required-tools retry, usage summed after an authentication retry, failed database start-up leaves no handle. Ten of the fourteen that need no ruling are committed; the next group (stop sequence, adapter stop, notice character, fast-path filter, plus one new item: usage on the fallback switch) is in build.**

**Status 2026-11-11 05:30 UTC — first six fixes COMMITTED `12ad31f3` (queue 4dh), not yet deployed: verdict parser, email reply end, reflection failure log, abort listener, self-healing budget limit, three scheduled jobs through the shared helper; each with a test that fails without it, reviewed in two rounds. Remaining: the fixes in protected files, one at a time, and V2, D8, D3 after rulings (4cx).**

**Status 2026-11-11 02:55 UTC — re-checked against the code by a read-only reviewer: none of the 17 is fixed yet and four are wider than first described (V2, L3, X3, D7). Fourteen need no ruling and are built after the pending deploy; V2, D8 and D3 wait for rulings (queue 4cx).**

| Id | Defect | Size |
| --- | --- | --- |
| V2 | **False success mark.** After the operator approves an action, a failure is shown as "✅ … ejecutado" when the tool reports it as plain text or under a key other than `error` (7 of 18 confirmation-required tools at the 2026-11-11 recount: deploy, apply-proposal, structured PDF ingest, skill run, the dev test step, batch delete, and memory-forget on a partial failure). The card then counts as succeeded: later items on it run and the original request resumes. | S–M |
| L1 | `cancelTask` can flip a `completed_with_concerns` task to `cancelled` (its terminal set omits that status; 1,106 of 4,778 tasks have it). | S |
| X1 | A run that fails the required-tools check books no cost (returns before the ledger write) — the only ledger gap in 30 days. | S |
| X2 | Corrupted warning glyph in the background-agent limit message. | S |
| X3 | The fast-path reply skips the deliverable sanitizer (0 uses in 30 days). | S |
| D5, D8, D9 | Byte-identical critic-verdict parser (56 lines) → one home; four copies of an output-path validator; an SMTP fix that landed only in the copy. | S each |
| L3, L5, L7 | Three raw cron registrations in two modules (2026-11-11 recount); a budget default that contradicts config; database work outside its `try`. | S each |
| D3 | The agent's own test tool checks the primary checkout, not the worktree that holds its edits (ruling 13; 4 calls ever). | S |
| D7 | The usage merge on the auth-retry path drops cache tokens (alternate inference path only). | S |
| X5, X6, X8, V11 | Stop path: stop calls outside any `try`, one stop function never called, a listener never removed, a singleton set before its tables exist. | S |

### Batch 4 — Failures become visible (no ruling needed)

**Status 2026-11-11 08:21 UTC — first wave COMMITTED `ba5d334e` (queue 4dm), not yet deployed: bus subscriber failures logged, journal priority for console errors and warnings, failed best-effort writes counted. Two review rounds, round 2 passed. Next: scheduled jobs, the provider alert rule, router and dispatcher sites, prompt blocks, trace events, comments, ratchet.**

**Status 2026-11-11 02:55 UTC — re-checked by a read-only reviewer (queue 4cy): all eight items open; recounts: comment-only catches 264, silence-justifying comments 15 plus 2 borderline (the 23 below could not be reproduced). One ruling is asked (page or only record the failures of ten background jobs); built after batch 3.**

Today: 0 logger error lines and 0 journal lines at error priority in 24 h, next to 60 console lines with error wording. Failures are written, not counted.

| Id | Change | Size |
| --- | --- | --- |
| V6 | Console errors get a journal priority (a ~10-line shim at boot, extracted so it is testable). No call site changes; operator grep patterns unchanged. | S |
| V4 | Data writes that can fail without a trace (conversation row, cost rows, embedding, mutation log…) → rate-limited warning + one counter. Correct the 23 comments that justify the silence with a boot-only or test-only condition. | S |
| V5 | Prompt blocks that can vanish silently (knowledge injection incl. mandatory directives, profile block, the "unverified" caveat, a pending confirmation card) → one trace event each. | S |
| V7 | Default listener on the event bus's error channel (it has had no subscriber since 03-12). | S |
| V8 | Scheduled jobs: callbacks return their promise; the scheduler's failure event is recorded as a failed run; the ten cron modules that never report failures use the shared recorder. (They are logged today, not alerted.) | S then M |
| V9 | Alert rule on provider success rate; counter for failed outbound delivery. | S |
| V12 | Ratchet: comment-only catches may not grow past 268 without a stated reason. | S |
| X4 | Decision points in the router and fast runner that log but emit no trace event. | S–M |

Not worth doing: migrating the ~900 console calls; a logging framework; Result types.

### Batch 5 — Tests (ruling 7)

**Status 2026-11-11 03:14 UTC — re-checked by a read-only reviewer (queue 4db): every item open; recounts by the reviewer's method differ from the table below (docs-reading tests 4 plus 1, not 24; SQL modules without a real-database test of their own 34; hand-copied tables that drop a constraint 30 in 21 files; 12 of 17 excluded video test files look runnable on CI, not 4); Q5 measured at 0 errors; three hazards in existing tests are fixed with this batch.**

589 files, ≈ 11,500 cases, +20.7 % last month. Honest overall (0 self-mocks; ≈ 15 named cases that cannot fail). Thin where it matters:

| Id | Change | Size |
| --- | --- | --- |
| Q1 | Guard parity table (= S1). | — |
| Q2 | Fix the named cannot-fail cases; test the real cancel-message branch instead of a copy of its regexes. | S |
| Q3 | Docs-coupled tests (24 test files read docs) run when `docs/` is staged. | S |
| Q4 | Fake timers in the two files that sleep for real (≥ 93 s by CI log timestamps; one shard's critical path). | S |
| Q5 | Typecheck the 55 scripts (≈ 11,100 lines, incl. the deploy preflight and the eval gate) on CI. | S–M |
| Q6 | Host hook: include deletion-only commits, typecheck test files, run inside the memory fence (operator-applied; the hook is unversioned). | S |
| Q8 | SQL that no test runs on a real database (15 of 76 SQL modules); stop hand-copying tables without their constraints (36 test files, 20 copies drop CHECK/UNIQUE). | M |
| Q9 | Unique temp directories in the three test files that use fixed names (two runs of the same file collide). | S |
| Q10 | Narrow the CI video exclusion to the 13 files that need a binary (4 of 17 do not). | S |

Not worth doing: chasing a coverage percentage; rewriting mock-heavy tests; local sharding.

### Batch 6 — Emergency inference path drill (ruling 8)

**Status 2026-11-11 02:55 UTC — re-checked by a read-only reviewer (queue 4cz): all five defects present, a sixth probable (usage figures on streamed replies); the drill is planned as a fully mocked end-to-end test; a paid test against the real provider is a separate operator decision.**

Armed, never fired. Five defects on it (a retried write that succeeds is reported as not completed → the user resends → duplicate write; spend of the primary attempts lost from the ledger when it engages; a retry leg that ignores cancellation; a round counter that misreports early exits to the model; a breaker-open message that hides the cause) and four branches no test reaches (413 retry, the alternate provider call, the stream parser, the escalation switch). Fix + pin together. M.

### Batch 7 — Coupling and structure (ruling 9)

**Status 2026-11-11 08:21 UTC — first piece COMMITTED `71b42aa2` (queue 4dl), not yet deployed: the ritual failure recorder is a leaf module and one import loop is gone. The rest of the batch (cycle cuts, ratchet, pure moves) keeps its place in the order.**

**Status 2026-11-11 03:31 UTC — re-checked by a read-only reviewer with a parse-only import graph (queue 4dc): cycles unchanged (25 / 8 / 4 / 2 files), mutual directory pairs 60 (57 at the review); the failure recorder moves first because batch 4 needs it; seven of the listed moves are pure, six wait (A2, A4, B3, C1, D1, F1).**

Prerequisites for ANY file move (new in this review): seven source-text test pins and three module-path mocks that break on a move; scripts are not typechecked, so a dropped re-export fails silently; the protected-file list is by exact path, so every new file is added in the same commit; model-visible strings must move byte-identical (a string-multiset identity check is each slice's done-check); moves land right after an agent merge.

| Id | Change | Effect | Size |
| --- | --- | --- | --- |
| G0 | Ratchet test with a baseline of today's cycles (25 / 8 / 4 / 2 files) and mutual directory pairs. | Cycles cannot grow. | S |
| G3 | Seeding and variant activation out of `initDatabase`; tuning DDL becomes a leaf. | `db/index` leaves every cycle (25 → 8/4/2); scripts that open the live database stop writing to it; removes two latent load-order hazards. | M |
| G1, G2 | Failure recorder → leaf; messaging trio (cache marker module, router constructed in `index`, poison check passed in). | Removes the 2-file and 8-file cycles. | S, S–M |
| G4 | Two redundant dynamic imports → static. | — | S |
| A1–A4 | Router: prompt builder, thread buffer, pure helpers, post-delivery side effects → own modules. | 5,696 → ≈ 4,050 lines. | S–M each |
| B1–B3 | Fast runner: hallucination guard, domain helpers, message assembly → modules. | File shrinks; `execute` (1,950 lines) changes little until (c). | S each |
| C1, C2 | `main`: shutdown closure and the nine optional-cron blocks → modules. | — | S each |
| D1–D3 | Inference: tool layer → own file; metrics → leaf; comment repair. | — | M, S, S |
| F1 | `dispatchWithSlot` → same-file private helpers, one per commit. | — | M |
| (c) B4, B5, F2 | SDK path and alternate path as separate functions; `orchestrate` and swarm `execute` after tests. | `execute` ≈ 180 lines. | M each |

Not now: an interceptor table (tried and dropped 07-05); splitting the two inference loops; the 4-file inference cycle (real recursion); a directory layer rule (42 of 45 directories are mutually reachable); bulk dynamic→static conversion.

### Batch 8 — Conventions (no ruling needed)

**Status 2026-11-11 03:52 UTC — re-checked by a read-only reviewer (queue 4de): five rules in one compiler-parsed lock test with named allow-lists; three sentences of the agent instructions corrected; hand-typed ledger prefixes are 10 sites, not 7; one new defect found on the way (queue 4df).**

Order that survived refutation: fix the violations first (batch 3), then four or five targeted lock tests with named allow-lists (raw cron, extra database handle, plain-string failure returns in tool catches, column-adds outside the migration list, container calls outside the container module), generalise only past ~8 rules. Also: two `CLAUDE.md` invariants whose wording does not match the real rule ("model ids only in adapters", "`.describe()` on every Zod field"); the description lint that omits one tool source; ledger-line prefixes typed by hand at 7 sites. Honest limit: a source-reading test is not selected by related-files runs — only the host's full-suite hook and CI see it.

### Batch 9 — Low-activity areas and unreachable code (rulings 10, 11)

Facts only (counts, no prune list): 30-day trace 96 of 196 built-in tools called; over 134 days 86 never; 0-call areas = 26,923 of 195,264 lines; their share of the classifier prompt ≈ 20 %. No ruling needed: narrow the CI exclusion (Q10).

### Batch 10 — Model-visible fixes, one eval-gate run (ruling 15)

**Status 2026-11-11 03:52 UTC — re-checked by a read-only reviewer (queue 4dd): 17 plain-failure sites (not 18) plus 19 siblings in the same handlers; three more wrong texts found; the eval run cannot see failure shapes or the planner prompt, which get unit tests instead.**

18 tool handlers that return a plain failure string instead of the `{error}` shape; a planner prompt that lists a check binary the shell gate refuses; a shell tool description that recommends a command the gate refuses; 27 schema properties without a description; a false doc comment on the two history flatteners (leave the flatteners themselves).

### Batch 11 — Comments (ruling 12)

**Status 2026-11-11 03:52 UTC — re-checked by a read-only reviewer (queue 4de): 22 false comments with corrected text, 46 file-and-line citations (about 10 right); C3 becomes a shrink-only test instead of a workflow step.**

23 % of non-blank lines are comments (41,718); 2,191 carry a date, queue id or audit-round tag. Two independent samples: about two-thirds of those carry a real constraint (18 % a constraint found nowhere else, 47 % one that a test also pins), a quarter are narrative, **one in twenty is stale or false**. Stripping them would be wrong; trusting them is also wrong. What rots is not the date but the reference to other code: of 27 `file:line` citations 3 are right, 21 point at the wrong line and 3 past the end of the file; of 30 "keep in sync / same as" claims checked, 6 are false (one of them on a write guard — S1). Harm on record: `8311e655` (a comment claimed an isolation that did not exist; audits trusted it for four months) and `2cc8000a` (a ruling made from a stale comment).

| Id | Change | Size |
| --- | --- | --- |
| C1 | Correct the ≈ 17 comments found false (three on guards or invariants; the rest e.g. a header whose counts no longer match the prompt below it, a TODO five months past its date, two orphaned doc blocks). | S |
| C2 | Replace the 24 wrong line citations with symbol names. | S |
| C3 | Enforce rule (b) with a grep over ADDED diff lines in a CI workflow (no baseline; third-party type files allowed). A source-reading lock test would not be selected by related-files runs. | S |
| C5 | 68 comment units point at ~50 files that are not in this repository → a one-line reason instead, when the comment is next touched. | — |

Not worth doing: stripping or mass-rewriting history tags; moving incident history into docs; a number-versus-code sweep (4–5 low mismatches in 132); a JSDoc parameter sweep (2 in 31); script usage blocks (0 wrong of 15 checked).

## What this review did not answer

- Whether a blocked deploy ever left a half-deployed tree (deploy output is not kept).
- Whether the agent ever merged its own pull request (one shared login; command text is not stored by design).
- A four-worker memory peak for the suite (only the sequential sweep was measured).
- Volume semantics of the sandbox backend after a `dist` symlink flip (to be checked in R1's build).
- Per-group scope activation counts; any environment override of the gated-capability list.
- Conversation-write loss (no independent table to compare against).

## Next

Ruled 2026-11-10 (section "Rulings"). Build order = queue item 4ch, starting with batch 1. Dimension 2 (Performance) opens when the code batches the operator selects are shipped and proven, or earlier if the operator says so.
