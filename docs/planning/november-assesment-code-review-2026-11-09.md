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

**Status 2026-11-14 00:46 UTC — COMMITTED, not yet deployed: the delivery-path rules for the withheld-password line `fcde0feb` (4ej) and the removal script for copies outside the service's stores `ea9f0e5f` (4ef), each after three review rounds. Both operator wrappers for the removal runs are reviewed and placed; they are run after the next deploy, the first one first. With this the code for the mailbox-password work is complete; what is left is the deploy and the two operator runs. Opened: 4ep, 4eq.**

**Status 2026-11-13 23:12 UTC — COMMITTED, not yet deployed: the explanatory line for replies that show the placeholder `698183b7` (4ej), the failed-check rule and two more small rules `0ae77614` (4el). The operator wrapper for the removal run is reviewed and placed (4ee). In build: the delivery-path follow-up (4ej) and the script for copies outside the service's stores (4ef). Opened: 4em, 4en, 4eo.**

**Status 2026-11-13 22:09 UTC — COMMITTED, not yet deployed: the removal script's hardening `e61df834` (4ee), the path-check error rule `032ed2f7` (4eh), a machine-dependent test fixed `ade414e7` (4ek). In review: the explanatory line for replies that show the placeholder (4ej). In draft: the operator wrapper for the removal run. Opened: 4el (three small follow-ups, detail off-repo).**

**Status 2026-11-13 21:00 UTC — standing store rule COMMITTED `fd926c2b` (queue 4ed, operator request of 2026-11-12), not yet deployed: a mailbox password the mailbox tool has printed is never written to a durable store; the reply check decides what the operator sees. Two review rounds. In build: the explanatory line for replies assembled from stored output (4ej), the removal script's hardening (4ee), error handling inside the path check (4eh).**

**Status 2026-11-13 20:50 UTC — second shell write check commit DONE `ab065098` (queue 4dq, ruled yes on 2026-11-13), not yet deployed: copy and move commands are judged by where each file lands; the cost of one hostile command is bounded per tool call; never looser than the committed check in any review round. Follow-ups in 4eh. Next: the operator's read-only replay of past commands (counts only), then the third commit of that series.**

**Status 2026-11-11 18:38 UTC — second shell write check commit: three review rounds, never looser than the committed check in any of them; round 3 found one cost point on a nested-command path, the third cost point in three rounds, so the work stopped for a ruling (queue 4dq). Uncommitted until ruled.**

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

**Status 2026-11-17 19:21 UTC — DEPLOYED 2026-11-17 19:18 UTC as build `aad72f4c` (queue 4fh): every piece on this page marked "COMMITTED, not yet deployed" (batches 1 to 6) is live since this deploy; the deploy script's own checks all passed (verdict OK). The two one-time removal scripts are still to be run by the operator. One finding for this batch: a schema change can reach the live database before its deploy, through any script that runs from source (three new pieces in 4fh).**

**Status 2026-11-13 20:50 UTC — in-chat deploy hand-over COMMITTED `1908b9fb` (queue 4cm (a), 4ei), not yet deployed: asked to deploy, the agent answers with the line the operator runs; the deploy script with its checks is the only deploy path. The read-only protection for source and build output is installed on the host and becomes active at the next restart. The tool's model-visible wording waits for the one evaluation run of batch 10.**

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

**Status 2026-11-18 21:28 UTC — the three remaining operator rulings of this batch are in (queue 4ge): one shared output-path check with unchanged error texts — yes; the test tool refuses when the agent's worktree is missing — yes (built with batch 10); critic gate on fast-path community replies — not now, to be counted in the Security and privacy dimension. Builds start after the removal has said clean.**

**Status 2026-11-18 19:52 UTC — a structured PDF ingest cut off at the chunk cap is reported as failed too, with the counts and the fact that the rest was not stored, `f57bca71` (queue 4gb).**

**Status 2026-11-18 19:37 UTC — the two producers that could still hide a failure from the confirmation card now say error: a failed or partly written structured PDF ingest (one short line with the counts, the full summary beside it) and a post failure without a message, `abab5262` (queue 4ga). Left of V2: an exception without a message at the gated layer, in a file the removal scripts load.**

**Status 2026-11-19 05:42 UTC — D8 is DONE `0bbe4ec8` (queue 4gi; ruled 2026-11-18): three of the four output-path validators are one shared module with unchanged error texts, and the conversion tool's copy no longer accepts the bare allowed folder; the fourth (the chart renderer) keeps its own design by ruling. The hold on code commits during the password removal ended on 2026-11-19. Still open from this table: D3 (ruled yes, model-visible, batch 10) and X3 (ruled not now).**

**Status 2026-11-18 18:45 UTC — V2 (the false success mark) is FIXED `ff537668` (queue 4fy): the operator ruled on 2026-11-18 that the failed check step, the partly failed batch delete and the memory forget whose correction stayed all count as failures; one rule in the router decides, reviewed twice. Not covered, listed in 4fy: plain-text failures of the structured PDF ingest and a failure with an empty error text. Still waiting for rulings: D8 and D3 (queue 4cx b, c).**

**Status 2026-11-14 04:48 UTC — the signal-baseline defect is FIXED `9ec11c45` (reviewed twice). Correction to the line below: the computation was not failing nightly — its only caller, the overnight tuning routine, is switched off on the live service and never runs; the query defect would have failed it whenever it ran. Whether baselines get their own nightly schedule is a yes/no in queue 4ex.**

**Status 2026-11-14 03:43 UTC — one more live defect, found by the batch 5 tests: the nightly signal baselines were never written (queue 4ew); its fix is being built as its own reviewed piece.**

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

**Status 2026-11-12 02:08 UTC — BATCH 4 BUILT: fast-runner trace events COMMITTED `a6cb3888` (queue 4dw) and the ratchet COMMITTED `cf360d49` (queue 4dx), not yet deployed. Every planned piece of this batch is committed; what stays open is listed as to-decide items in queue 4dr–4dx (untraced decisions, uncounted swallowed failures, the backlog of 314 silent catches).**

**Status 2026-11-11 20:33 UTC — comment clean-up COMMITTED `d5db2ff1` (queue 4dt) and router trace events COMMITTED `26d89ef9` (queue 4du), not yet deployed: seventeen catch comments say what is swallowed; nine reply decisions of the router leave a trace event. Left in this batch: trace events for the fast runner's own decisions, the ratchet.**

**Status 2026-11-11 19:28 UTC — fourth wave COMMITTED `cf363d67` (queue 4dr), not yet deployed: dropped prompt blocks are counted and traced; nothing the model reads changes. Two review rounds. Left in this batch: trace events for router and fast-runner decisions (router part building), the comment clean-up, the ratchet.**

**Status 2026-11-11 18:38 UTC — third wave COMMITTED `ccef640e` (queue 4dp), not yet deployed: provider-failing alert rule, outbound send-failure counter, two cost-row write sites, a test over the rules file. Two review rounds. Fourth wave (prompt blocks that vanish) is building.**

**Status 2026-11-11 10:06 UTC — second wave COMMITTED `9b14beaa` (queue 4dn), not yet deployed: failed scheduled jobs are recorded and alert like a missed run, no job detaches its promise, ten self-catching jobs count their failures. Two review rounds, round 2 passed. One ruling opened (should those ten jobs alert). Third wave (provider alert rule, outbound send counter, two cost-row sites) is in review.**

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

**Status 2026-11-18 19:20 UTC — the test setup reports both guards in one check, so a finding is never blamed on the next test or lost, and the connection guard no longer treats decorated addresses as local, `e6330f06` (queue 4fz). The small follow-ups of 4fe are closed.**

**Status 2026-11-18 18:45 UTC — the last test that reached the network in the commit check is offline: the speech tests stub every child process fail-closed, `43c39e9d` (queue 4fy); writing them found and fixed a not-a-number duration.**

**Status 2026-11-14 12:03 UTC — tests can no longer connect to another machine, COMMITTED `0372b969` (suite 680 files, 17,819 tests): the setup refuses the attempt and fails the test (4fe (1)(2)); the spend-window reads and one warning log line are pinned without the wall clock (4ez (2)(3), 4ep test part). Work on this batch is PAUSED at the operator's request. Left in this batch: the three shell tool assertions (4fa (1)), the comment sweep (4fc (4)), the sweep leftovers (4fd (3), 4fe (4)(7) and the two small follow-ups noted there), the fixture names (4ey (3)), the host commit check install (4db, operator).**

**Status 2026-11-14 11:31 UTC — the triage value lists have one source and tool selection is pinned, COMMITTED `cc47cc26` (suite 680 files, 17,790 tests): the schema the triage model fills in now derives from the same list as the types and is held to the database rule by a test, with the model-visible schema shown unchanged (4fe (3)); the tool-list trace found no null producer and one open question about the empty list (4fd (6), 4ff (1) to decide). Left in this batch: the refusing step for outside connections (4fe (1), in build), the three shell tool assertions (4fa (1)), the comment sweep (4fc (4)), the sweep leftovers (4fd (3), 4fe (2)(4)(7)), the host commit check install (4db, operator).**

**Status 2026-11-14 11:13 UTC — four of the seven wall-clock bounds that needed a source seam are assertions on work done, COMMITTED `11807f1d` (suite 679 files, 17,785 tests): two optional arguments with unchanged defaults, stand-ins and a fake clock in place of real connections, name lookups and child processes (4fa (1)). Left in this batch: the three shell tool assertions (4fa (1)), the refusing step for outside connections (4fe (1)), the comment sweep (4fc (4)), the sweep leftovers (4fd (3)(6), 4fe (2)–(4)(7)), the host commit check install (4db, operator).**

**Status 2026-11-14 10:57 UTC — the test setup records outside connections, the request limiter has its first test, and the smaller schema modules are pinned, COMMITTED `bf5a213c` (suite 677 files, 17,779 tests): every test process records each attempt to reach another machine without refusing it yet, and the first full run found three such attempts in the whole suite (4fb (2) step 1, 4fe (1)); four more allowed-value rules are held together with their types and the limiter is covered edge by edge (4fd (4)(5)). Left in this batch: the refusing step for outside connections (4fe (1)), seven assertions that need a source seam (4fa (1), four of them built and in review), the comment sweep (4fc (4)), the sweep leftovers (4fd (3)(6), 4fe (2)–(4)), the host commit check install (4db, operator).**

**Status 2026-11-14 10:22 UTC — the last unreached database statements are under test and two more input checks are in, COMMITTED `ae1ba977` (suite 674 files, 17,717 tests): the run phase of task dispatch runs in-process behind stubs that fail closed, pinning six statements plus the pull route's cost reader (4fc (3)); a wrong nested value in a batch file write is refused in the tool's own words, and the provider of a stored market bar has a type that matches the database rule (4fd (1)(2)). Left in this batch: the comment sweep (4fc (4)), seven assertions that need a source seam (4fa (1)), the network stand-in follow-up (4fb), the sweep leftovers (4fd (3)–(6)), the host commit check install (4db, operator).**

**Status 2026-11-14 09:55 UTC — two source defects found by the sweep are FIXED and the second measuring helper is shared, COMMITTED `62c725eb` (suite 671 files, 17,695 tests): the schema file's spawn-type rule matches the submission type, the task route refuses a malformed priority, tags or tools with a clear message, and the dashboard's task form no longer defaults to a priority the database refuses (4fc (1)(2)); six test files import one growth-ratio helper instead of carrying a copy (4fa (2) complete). Left in this batch: the seven statements that need a seam and the comment sweep (4fc (3)(4)), seven assertions that need a source seam (4fa (1)), the network stand-in follow-up (4fb), the sweep leftovers (4fd), the host commit check install (4db, operator).**

**Status 2026-11-14 09:21 UTC — quiet-fault sweep COMPLETE and the per-call measuring helper shared, COMMITTED `9818be69` (suite 671 files, 17,663 tests): twelve more real-schema test files pin sixty-three statements in fifteen modules (4ez), thirteen test files import one helper instead of carrying a copy (4fa). The sweep also found two small source defects, now queued as fixes (4fc): the schema file is narrower than the running database for one task column, and one local API route passes a value to the database unchecked. Left in this batch: those two fixes and the seven statements that need a seam (4fc), seven assertions that need a source seam and the ratio helper (4fa), the network stand-in follow-up (4fb), the host commit check install (4db, operator).**

**Status 2026-11-14 08:44 UTC — quiet-fault sweep, first two areas, and a suite-wide block on real model calls from tests COMMITTED `04ade284` (suite 658 files, 17,563 tests): eight new real-schema test files pin fifty-seven statements in seven modules that other modules' tests only passed through (4ez), and the test setup now blocks the model entry point and drops inherited service settings for every test (4fb). Lessons: a loud fault (a misspelled column, or not-equal on a key) proves only that a statement runs; a stub that throws is not enough when the caller swallows errors, so the guard also records the call and fails the test. Left in this batch: the last two sweep areas (4ez), seven assertions that need a source seam (4fa), the network stand-in follow-up (4fb), the host commit check install (4db, operator).**

**Status 2026-11-14 07:40 UTC — wall-clock bounds, video tests and one path-form fix COMMITTED `e7e5db6c` (suite 650 files, 17,514 tests): twenty-seven elapsed-time assertions now measure work or processor time instead of the clock (4em), three video test files gate CI again (4er), and the path rules for protected files recognise the same path forms (4en). Lessons: a ratio bound between two input sizes needs a measurement well above timer noise, a four-times step and a best-of-three; a stand-in that overrides only a module's named exports never reaches code that reads the default import. Left in this batch: the quiet-fault sweep (4ez), seven assertions that need a source seam (4fa), the host commit check install (4db, operator).**

**Status 2026-11-14 06:05 UTC — real-database tests: ALL THIRTY PIECES COMMITTED, the last `0a3919d5` (suite 650 files, 17,454 tests), with the Q2 write test inside it. The video-folder guard follow-up is in the same commit. Lesson from the last review: a misspelled-column check proves a statement runs, not that a test looks at its result — a quiet-fault sweep over the statements counted as indirectly covered is queued (4ez). The host commit check still waits for the operator's install line (4db). Left in this batch: the wall-clock bounds (4em), three video test fixes (4er), the quiet-fault sweep (4ez).**

**Status 2026-11-14 05:32 UTC — real-database tests: pieces 24–29 COMMITTED (`11ddbeb2`, `115982fe`; twenty-nine of thirty done; suite 645 files, 17,416 tests). The last piece is being built in two halves. Test safety, same commit `115982fe`: tests cannot reach the live vector store, and two of the three older video tests work in a throwaway folder (queue 4ey; the third waits for the yes/no in 4ex). The host commit check still waits for the operator's install line (4db). Left: the last piece with the Q2 cancel-pattern test, 4er, the follow-up pieces in 4ey.**

**Status 2026-11-14 04:48 UTC — real-database tests: pieces 19–23 COMMITTED `17a1cb5b` (twenty-three of thirty done; suite 635 files, 17,383 tests). Pieces 24–26 are being built. Found on the way: three older host-only video tests leave folders behind in the service's video working folder on every commit run, and one of them calls an outside service (queue 4ex). The host commit check still waits for the operator's install line (4db). Left: the Q2 cancel-pattern test, seven more pieces, 4er.**

**Status 2026-11-14 03:43 UTC — real-database tests: pieces 13–18 COMMITTED `629c5f52` (eighteen of thirty done; suite 631 files, 17,347 tests). They found one live defect (the nightly signal baselines were never written; fix in progress) and one question (the hold-back for repeated alerts is recorded but never applied), both in queue 4ew. The host commit check still waits for the operator's install line (4db). Left: the Q2 cancel-pattern test, twelve more pieces, 4er.**

**Status 2026-11-14 03:25 UTC — real-database tests: pieces 7–12 COMMITTED `815afc1a` (twelve of thirty done; suite 626 files, 17,324 tests), pieces 13–18 in flight. One finding needs a decision before it is fixed (skills switched off by the nightly review, queue 4ev). The host commit check still waits for the operator's install line (4db). Left: the Q2 cancel-pattern test, eighteen more pieces, 4er.**

**Status 2026-11-14 02:36 UTC — the class of database times read or compared in the wrong zone, found by the real-database tests, is FIXED `14da59d8` (twenty expressions in thirteen source files, two fix sets, each independently reviewed; queue 4et, follow-ups 4eu). The host commit check (Q3 + Q6) is built, reviewed twice and waits for the operator's install line (4db). Q8 pieces 7–12 are in flight. Left: the Q2 cancel-pattern test, eighteen more Q8 pieces, 4er.**

**Status 2026-11-14 02:09 UTC — Q8 STARTED: thirty test-only pieces planned, the first six COMMITTED (`2e394dc8`, `906ba0ee`, `3aa669d6`), CI green (queue 4es). They found two defects: the memory clean-up kept the less trusted copy of a duplicate (FIXED `906ba0ee`), and a class of database times read or compared the wrong way (fix in flight, 4et). The suite's memory use was measured during these commits: about 1.3 GB at its peak, far below the limit of the new host commit check (in its second review round). Left: the Q2 cancel-pattern test, twenty-four Q8 pieces, the host commit check hand-over, 4er.**

**Status 2026-11-14 01:04 UTC — Q10 COMMITTED `bd9158b8`, CI green: four video test files are excluded by name, thirteen gate CI again (queue 4ec). Three of the four could gate CI after small test changes (4er). Left: the Q2 cancel-pattern test, Q8, the operator-applied host commit check (Q3 + Q6).**

**Status 2026-11-12 18:17 UTC — first part COMMITTED `782b6945` + `f5c254c8` + `9e5949ed` + `547137a8` (queue 4ec): Q5 (every script type-checked), the small Q2 cases, Q9 with the two live-folder hazards, the racing test, Q4 (simulated time in both slow files). Left: the Q2 cancel-pattern test, Q8, Q10, the process-group cases of the shell test (CI-only), and the operator-applied host commit check (Q3 + Q6).**

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

**Status 2026-11-13 19:57 UTC — late-cancel fix COMMITTED `97655dcf` (queue 4dy), not yet deployed: a cancel that arrives late in a run (during the fallback run, the required-tools check or the closing work) still ends the run as cancelled, is announced exactly once, and a run that throws after a cancel leaves run and task rows in agreement. Three review rounds with mutation tests; follow-ups in 4eg. The drill itself now allows one database ask in its size-refusal scenario, pinned to its caller, and still proves the path completes when that ask fails (comes with the store-rule piece, not yet committed).**

**Status 2026-11-12 17:19 UTC — the drill's findings COMMITTED `addecf81` (queue 4dy), not yet deployed: a cancelled run is recorded as cancelled on every path and nothing follows it; a size refusal is resent inside its round; a caller's cancellation is not a provider failure; the comment corrected; the authentication guard tested. One review round, 20 mutants. Left: a terminal trace event for a cancelled task, three runners that do not stop on a cancel, and the paid drill (a later operator decision).**

**Status 2026-11-12 02:08 UTC — mocked drill COMMITTED `4146e642` (queue 4dy): five scenarios through the real runner and adapters, no real model call. Left in this batch: the fix for a cancelled run reported as completed, one untrue comment, one missing guard test; the paid drill stays a later operator decision.**

**Status 2026-11-11 20:33 UTC — piece B COMMITTED `91fadfc9` (queue 4dv), not yet deployed: a write the retry completes counts as done on positive evidence only; the retry leg can be cancelled. Three review rounds. The mocked end-to-end drill is building; the paid drill stays a later operator decision.**

**Status 2026-11-11 19:28 UTC — piece A COMMITTED `78f1bebf` (queue 4ds), not yet deployed: the OpenAI-compatible adapter names an open breaker, counts the rounds that ran, keeps streamed usage; untested branches pinned. Piece B (the fast runner's retry and hand-over legs) is building; the mocked drill follows; the paid drill stays a later operator decision.**

**Status 2026-11-11 02:55 UTC — re-checked by a read-only reviewer (queue 4cz): all five defects present, a sixth probable (usage figures on streamed replies); the drill is planned as a fully mocked end-to-end test; a paid test against the real provider is a separate operator decision.**

Armed, never fired. Five defects on it (a retried write that succeeds is reported as not completed → the user resends → duplicate write; spend of the primary attempts lost from the ledger when it engages; a retry leg that ignores cancellation; a round counter that misreports early exits to the model; a breaker-open message that hides the cause) and four branches no test reaches (413 retry, the alternate provider call, the stream parser, the escalation switch). Fix + pin together. M.

### Batch 7 — Coupling and structure (ruling 9)

**Status 2026-11-23 09:16 UTC — batch 10 piece 17 part 2 of 8 COMMITTED `86e27763` (queue 4ij; not deployed, ships with the batch): thirteen more older tool descriptions say when not to use the tool (host, project, knowledge-base file and dashboard tools); 13 statements the code contradicted, 9 unconditional pointers and 1 private example value replaced. Review: pass with warnings; one sentence still untrue and one first line too wide, both narrowed with the reviewer's text; ten of its eleven faults red, the eleventh equivalent. Next: parts 3 to 8.**

**Status 2026-11-23 08:38 UTC — batch 10 piece 17 part 1 of 8 COMMITTED `446845d9` (queue 4ii; not deployed, ships with the batch): seven older tool descriptions say when not to use the tool; five existing lines were replaced (two the code contradicted, three unconditional pointers). The piece on the failure results of the git, shell and propose tools is NOT built in this batch (seven sites go on the conventions lock's allow-list; a Tool-use piece on the failure readers comes first). Review: pass with warnings; 26 lines re-derived, all hold; six of the reviewer's seven faults red, the seventh outside the change. Next: parts 2 to 8.**

**Status 2026-11-23 07:29 UTC — batch 10 piece 16 COMMITTED `e2d5591f` and `c1fb1a1d` (queue 4ih; not deployed, ships with the batch): the self-test tool runs in the agent's own worktree, refuses when it is missing and reports a busy suite as an error; the shell description no longer recommends a test command its guard refuses. Review: pass with warnings; two faults stayed green, one closed by a case, one left with an added assertion that was not shown red; one sentence corrected. Next: the failure results in the protected git, shell and propose tools.**

**Status 2026-11-23 06:13 UTC — batch 10 piece 15 COMMITTED `fb0092a4` (queue 4ig; not deployed, ships with the batch): under tool search, a non-interactive run's own list of up to 12 tools loads up front on the other model path. The effort half of the same ruling is NOT built and waits for the operator (it would override an earlier ruled setting). Review: pass with warnings; three green faults closed by three cases. Next: the self-test tool on the agent's own worktree.**

**Status 2026-11-23 05:22 UTC — batch 10 piece 14 COMMITTED `24a006ff` (queue 4if; not deployed, ships with the batch): the memory search tool is registered in the narrow mode of the memory source and is in the core set; its description is true on both stores. Review: pass with warnings, no behaviour finding; two texts replaced by the reviewer's, one pin added, four of my sentences corrected. Next: the effort rating on the other model path and short tool lists loaded up front.**

**Status 2026-11-23 04:23 UTC — batch 10 piece 13 COMMITTED `d3a97958` (queue 4ie; not deployed, ships with the batch): the describe and load skill tools are in the core set, the three description pointers to the run tool are conditional, the skill-proposing task gets the load tool. Review: pass with warnings; three whole-text pins added, one comment replaced by the reviewer's text, three of my sentences corrected. Next: memory search on the local memory store.**

**Status 2026-11-23 03:27 UTC — batch 10 piece 12 COMMITTED `168ae37c` (queue 4id; not deployed, ships with the batch): nine description sentences of the history, categories, probe, deactivate, run and file tools say what the code does. Review: pass with warnings; four absence checks added, one sentence replaced by the reviewer's fuller text, two of my sentences corrected. Next: the skill tools on offer together.**

**Status 2026-11-21 16:27 UTC — batch 10 piece 11 COMMITTED `b2c704bf` (queue 4ic; not deployed, ships with the batch): the planner's list of check programs no longer names a program the shell guard refuses; the code-search tool's too-short query is an error object, its example says what the call returns, and the directory tool's message for a listing without names is true. Review: pass with warnings; two test cases added, one test name narrowed, three of my sentences corrected. Next: nine description sentences, then the skill tools on offer together.**

**Status 2026-11-21 15:51 UTC — batch 10 piece 10 COMMITTED `fe287ae4` (queue 4ib; not deployed, ships with the batch): thirteen undescribed input properties described, the condition text of both file write tools names the words it is matched against, and a lint case walks every schema property at every depth. Review: pass with warnings; four texts and a comment replaced, one walk case strengthened. Next: the untrue texts, then the piece that makes the skill list and the load tool travel together.**

**Status 2026-11-21 14:53 UTC — batch 10 piece 9 COMMITTED `f346ecee` (queue 4ia; not deployed, ships with the batch): the skill list returns compact rows within a size budget and takes a query; texts of the save, list and report tools made true; four nested properties described. Review: pass with warnings; three texts and a comment replaced, one missing case added. Next: the remaining texts, then the piece that makes the list and the load tool travel together.**

**Status 2026-11-21 13:59 UTC — batch 10 piece 8 COMMITTED `8fddd6f5` (queue 4hz; not deployed, ships with the batch): failures of six tools in five files start with an error and keep what was made; three candidates left as results on purpose; the upload's time-out message made true. Review: pass with warnings; one untrue sentence of new text replaced and three surviving faults closed by added cases. Next: the skills file and the report tool.**

**Status 2026-11-21 13:05 UTC — batch 10 piece 7 COMMITTED `112d5aea` (queue 4hy; not deployed, ships with the batch): the twelve non-ok returns of the site tools put error first as fixed words and keep the site's answer under a new key; a create answered with a server error says the site may have saved it; the memory store limit's refusal is an error object. Review: pass with warnings; two surviving faults and one lost reader case closed by added cases. Next: the unowned non-standard failure shapes.**

**Status 2026-11-21 12:21 UTC — batch 10 piece 6 COMMITTED `14a38d2e` (queue 4hx; not deployed, ships with the batch): the batch insert tool returns an error with the counts when an entry failed or nothing was written, its two refusals are error objects, a chunk cap below 1 is refused before the document is read, and the ingest descriptions match the code. Review: pass with warnings; four surviving faults closed by added cases. Next: the site tools' failure envelope.**

**Status 2026-11-21 11:49 UTC — batch 10 piece 5 COMMITTED `89be39e8` (queue 4hw; not deployed, ships with the batch): the apply tool refuses, before any write, a modify or remove it cannot apply and a proposal with an unknown type, and it matches the proposal name exactly (an empty or ambiguous name is refused). One parameter description of the propose tool corrected. Review: pass with warnings; three surviving faults closed by one more case. Next: the knowledge-base ingest file.**

**Status 2026-11-21 11:18 UTC — batch 10 piece 4 COMMITTED `7f2c164b` (queue 4hv; not deployed, ships with the batch): ten failure returns of the apply, backup and logs tools are error objects; the deploy tool's description says what the tool does. The propose tool's three refusals were cut after the review (the retry leg would have replaced a truthful refusal) and move to the protected-files piece. Review: fail on the cut part, pass with warnings after the cut. Next: a small piece on two faults of the apply tool recorded in 4hv.**

**Status 2026-11-21 10:29 UTC — batch 10 piece 3 COMMITTED `7d4ccfeb` (queue 4hu; not deployed, ships with the batch): four "could not start" returns of the two paper-trading rebalance tools are error objects; nothing-to-trade and the stale-price abort stay plain. A sweep of every tool handler by script changed the batch plan (two sites the inventory missed, one new piece). Review passed after a tests-only fold. Next: the directives tools and the host-management tools.**

**Status 2026-11-21 09:32 UTC — batch 10 piece 2 COMMITTED `2edb75d9` (queue 4ht; not deployed, ships with the batch): the quote line prints the source's change percent, previous close and trading day; the signals reply names every scanned symbol's newest bar date with a marker for the stored fallback; the data layer keeps that flag on reuse. Review passed after one fold. Next: the paper-trading tools' failure shape with a sweep of the tool folder.**

**Status 2026-11-21 08:41 UTC — batch 10 piece 1 COMMITTED `fb14097e` (queue 4hs; not deployed, ships with the batch): the whole-call failures of fourteen tools in five finance tool files come back as an error object with the same words; no success result changes; three backtest description passages no longer name a look-alike table. Review passed after one fold (one unguarded return got its case; three header comments reworded). The batch plan gains one piece: two further finance tool files with the same class, with a sweep of the tool folder. Batch 10 pieces left: see queue 4hr and 4hs.**

**Status 2026-11-21 07:56 UTC — comments that named real site addresses, site aliases and private projects are reworded, COMMITTED `c0745e4f` (queue 4hr; comments only, no deploy), with the held comment file `0453d850`. Batch 10 was re-read against today's tree (26 rows: 16 ready, 7 need a decision or a check, 4 left the batch) and its first piece, the finance tools' failure shapes, is in work; the list in the batch 10 section below is older than that read, queue 4hr holds the corrections and the order. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. LIVE build unchanged, `b9b48657`.**

**Status 2026-11-21 06:41 UTC — build `b9b48657` is LIVE since 2026-11-21 06:38 UTC (queue 4hq); everything committed is deployed, 4hn and 4hp included; none of the failed-write changes is proven on a real case yet. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 06:32 UTC — a failed write that a later write left unrepaired leaves a trace row, COMMITTED `5bb82e86` (queue 4hp; not yet deployed, with `acf1efeb`). The rule that the last write decides the status stays; the new rows are the measure for a later decision. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 05:52 UTC — the other session's verdict mode landed `077a6809` (queue 4ho; its files only, no deploy needed); `acf1efeb` (4hn) is still not deployed. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: a failed write hidden by a later successful write, then batch leftovers and batch 10.**

**Status 2026-11-21 05:42 UTC — a write whose failure carries its error after other fields is recorded as failed, COMMITTED `acf1efeb` (queue 4hn; not yet deployed). One of eighteen write tools returned that form. Recorded for the re-score: five failure forms of three write tools are still recorded as successful writes (an empty or non-object answer to a publish, the batch insert's plain text, the memory store's warning). Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 05:19 UTC — build `d6d1c23d` is LIVE since 2026-11-21 05:17 UTC (queue 4hm); everything committed is deployed, the three failure-recording fixes (4hj, 4hk, 4hl) included; none is proven on a real case yet. Batch 7 unchanged: pure moves done, D3 not yet done, wait list A2, A4, B3, C1, F1, D1. Next: the site-publish write outcome, then the other batch leftovers and batch 10.**

**Status 2026-11-21 04:59 UTC — the shared error-text helper never returns an empty text, COMMITTED `fa3a6131` (queue 4hl; not yet deployed, together with the 4hj and 4hk commits). This closes the empty-text case at its root for every caller of the helper. Recorded for the re-score: thirty-three places still build an error text without the helper, and the site-publishing tools' failures are not counted as errors. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 04:12 UTC — the external-tool empty-error fix is COMMITTED `2b8c7f4e` (queue 4hk; not yet deployed, together with the 4hj commit). The first read for it corrected the previous item's list of remaining cases. Recorded for the re-score: the helper that turns a thrown value into text can still return an empty text, and eleven tools carry a confirmation flag that has no effect. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 03:13 UTC — two leftover failure shapes are COMMITTED `9f9e1f4a` (queue 4hj; not yet deployed): a partly failed batch write is recorded as a failed write, and the gated layer no longer returns an empty error text. Recorded for the re-score: the places that decide whether a tool result failed still disagree on several result shapes, and the same two faults remain in other tools (listed in the queue item). Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 02:21 UTC — the operator tool's cancel fallback fix is COMMITTED `9c91ad24` (queue 4hi): the direct write no longer rewrites a task that has ended, and a test holds the tool's lists against the service's own. Recorded for the re-score: the four ended statuses are written out by hand in several modules, with no single exported list. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 01:36 UTC — batch 11: the third comment piece is COMMITTED `b608138a` (queue 4hh): no comment under the source and script folders names a person any more. The comment work of batch 11 on record is done; one corrected comment waits for the operator's staging command. Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: the operator tool's cancel fallback (a fault reported by the peer session and verified), batch leftovers, then batch 10.**

**Status 2026-11-21 01:05 UTC — batch 11: the second comment piece is COMMITTED `8490216a` (queue 4hg): comments that placed moved code in the router, the false statements noticed by earlier pieces, and the two kinds of sensitive comment. Left in batch 11: one small piece (two older router comments that name a person, with a sweep). Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-21 00:14 UTC — batch 11: the seven leftover false statements, the nine citations on the lock test's list (now EMPTY) and batch 7's comment repair in the inference folder (D3) are COMMITTED `6707b48d` (queue 4hf). Left in batch 11: a later comment piece (messaging leaves, scripts that place the prompt builder in the router, the items noticed in 4hf). Batch 7 wait list unchanged: A2, A4, B3, C1, F1, D1. Next: batch leftovers, then batch 10.**

**Status 2026-11-20 23:24 UTC — build `d416150f` is LIVE since 23:20 UTC (queue 4he); everything committed is deployed. The start-row piece (4gz) is proven on live tasks. Batch 7 unchanged: pure moves done, D3 not yet done, wait list A2, A4, B3, C1, F1, D1. Next: 4gr (4), then the batch leftovers and batch 10.**

**Status 2026-11-20 23:07 UTC — checks 4gm and 4gp (4) answered (queue 4hc); a security fix found by that pass is committed `31c7f6fe` (queue 4hd: a restricted channel keeps its tool restriction). Batch 7 unchanged: pure moves done, D3 not yet done, wait list A2, A4, B3, C1, F1, D1. Next: 4gr (4), then the batch leftovers and batch 10.**

**Status 2026-11-20 22:20 UTC — A1 is DONE `2c105bcc` (queue 4hb): the system-prompt builder is its own module on the protected list; the router is at 4,888 lines. The pure moves of batch 7 are done (D2, C2, B1, B2, A3, A1); D3 is not yet done. Wait list unchanged: A2, A4, B3, C1, F1, D1. Next: the three open checks (4gm, 4gp, 4gr), then the batch leftovers and batch 10.**

**Status 2026-11-20 21:28 UTC — A3 is DONE: second half `856b90cb` (queue 4ha), first half `d6e90da3`. The router is at 5,119 lines. Next: A1 (the router's prompt builder; model-visible strings byte-identical as the done-check). Wait list unchanged: A2, A4, B3, C1, F1, D1.**

**Status 2026-11-20 20:33 UTC — the build of a task is recorded when it starts `b382d2de` (queue 4gz; committed, not deployed). Next: A3 second half (builder brief written: the critical-data safety net and the per-message scope helpers leave the router as two new protected modules), then A1.**

**Status 2026-11-20 20:05 UTC — DEPLOYED: build `ce115c37` is live since 2026-11-20 19:58 UTC with schema 18 (queue 4gx). The only commit after the live build is the other session's digest, which the service does not load. Next: the build of a task recorded at its start, then A3 second half (inventory done: all eight helpers free of router state, two new modules), A1.**

**Status 2026-11-20 18:56 UTC — the concern text and the build of tasks that end the normal way are kept `8d70e6ae` (queue 4gw; one new table, schema head 18, not deployed). Next: A3 second half, A1.**

**Status 2026-11-20 18:00 UTC — DEPLOYED: build `bd9efc51` is live since 2026-11-20 17:58 UTC (queue 4gu); every structure piece committed so far is in it. Next: the concern text and the build id of every finished task are kept (one new table), then A3 second half, A1.**

**Status 2026-11-20 17:52 UTC — G3 is DONE `6e9d929a` (queue 4gs): opening the database does schema only; the seed and the tuning activation are explicit calls at the programs that need them; tuning table creation is the leaf `src/db/tuning-schema.ts`; the import-cycle baseline is lowered (the 26-file cycle is gone). Next: the outcome record of ritual and scheduled tasks (queue 4gt), then A3 second half, A1.**

**Status 2026-11-19 08:34 UTC — B2 is DONE `ba787fad` (queue 4gq): the DENUE guard helpers are `src/runners/denue-guard.ts`, on the protected list; the fast runner is at 2,616 lines. The guard messages stay in the runner (model-visible; not part of a pure move). Next: G3 (inventory running first), A3 second half, A1.**

**Status 2026-11-19 08:13 UTC — B1 is DONE `3f1ae33d` (queue 4gp): the claimed-action guard is `src/runners/hallucination-guard.ts`, on the protected list; the fast runner is at 2,694 lines. Next: B2 (brief written), G3, A3 second half, A1.**

**Status 2026-11-19 07:42 UTC — C2 is DONE `4d693425` (queue 4gn): the ten optional scheduled jobs register from `src/optional-crons.ts`, on the protected list; the entry point is at 631 lines. The other session's branch landed in between (queue 4go). Next: B1 (brief written), B2, G3, A3 second half, A1.**

**Status 2026-11-19 06:58 UTC — A3 first half is DONE `d6e90da3` (queue 4gl): confirmation formatting and the day-log writer are modules of their own, both on the protected list; the router is at 5,550 lines. A3 second half (critical-data detection, scope helpers) follows as its own piece with its own step 0; whether each block is self-contained is not yet established. Next: the other session's branch lands; then B1, B2, G3, and C2 (brief written). Queue 4gm records a prompt-assembly finding to check.**

**Status 2026-11-19 06:27 UTC — D2 is DONE `4b772678` (queue 4gk): the provider metrics are a leaf module that imports only the pricing helper; one shared object, proven by identity; the health rating's class boundaries are pinned for the first time. Next: A3 in two halves (confirmation formatting and the day log first), then A1 and C2; B1, B2 and G3 wait for another session's branch.**

**Status 2026-11-19 06:04 UTC — the cache marker and the poisoned-exchange check are leaf modules, COMMITTED `021068b5` (queue 4gj): with the third edge cut on 2026-11-18 this removes the router's runtime cycle altogether (3 runtime cycles → 2; with dynamic imports 27 / 5 / 3 files); both new files joined the protected list in the same commit. G2 and G4 are done, G1 in its minimal form. Next: the pure moves that touch neither the runners nor the tuning schema (D2, A3, A1, C2); B1, B2 and G3 wait for another session's branch.**

**Status 2026-11-18 14:28 UTC — the entry point constructs the router and hands it in, COMMITTED `6e3f8d1e` (queue 4fs): the runtime cycle around the router is 7 modules (was 8), 11 with dynamic imports (was 18). The two leaf modules out of the router are BUILT and set aside (queue 4fr): every move of code out of a protected file waits until the protected list can take the new file in the same commit.**

**Status 2026-11-18 07:40 UTC — the eight remaining dynamic imports of already-loaded modules are static, COMMITTED `dbc663a2` (queue 4fq); baseline unchanged; three calls gained their first test. Next in batch 7: the messaging trio (two leaf modules out of the router, then how the router is constructed).**

**Status 2026-11-18 07:18 UTC — the two dynamic imports of already-loaded modules (router, fast runner) are static, COMMITTED `f0d93a9e` (queue 4fp); baseline unchanged; four new test cases. Next in batch 7: the eight identical places the sweep found, then the messaging trio.**

**Status 2026-11-18 06:02 UTC — the ratchet is COMMITTED `9e46f239` (queue 4fk): a lock test compares the tree's import cycles (3 today: 26, 8 and 4 files) and its 63 mutual directory pairs with a baseline in both directions, so a new one fails and every cut lowers the baseline in the same commit. Next: the two redundant dynamic imports, then the cuts.**

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

**Status 2026-11-18 06:56 UTC — the cache-ratio drift signal now measures the gate's population, COMMITTED `2a550c19` (queue 4fo); a test rebuilds the query from the gate's constants. The stored row needs one operator update after the next deploy window. Left in batch 8: the ledger prefix constants (after the removal scripts) and the plain-string failure rule (with batch 10).**

**Status 2026-11-18 06:39 UTC — the description check is COMMITTED `551fa483` (queue 4fm): it now reads every host-defined tool (197) and the whole not-for block, and the legacy list shrank from 97 to 82. The three wrong sentences of the agent instructions are corrected (4fn). Left: the ledger prefix constants (after the removal scripts) and the plain-string failure rule (with batch 10).**

**Status 2026-11-18 06:02 UTC — first piece COMMITTED `f6ac3444` (queue 4fl): four of the five rules (scheduling, database handle, column changes, container seam) are pinned by one parser-based lock test with a 45-entry named allow-list compared in both directions. The fifth rule (plain-string failures in tool handlers) waits for batch 10; the description check, the ledger constants and the three sentences are still to do.**

**Status 2026-11-11 03:52 UTC — re-checked by a read-only reviewer (queue 4de): five rules in one compiler-parsed lock test with named allow-lists; three sentences of the agent instructions corrected; hand-typed ledger prefixes are 10 sites, not 7; one new defect found on the way (queue 4df).**

Order that survived refutation: fix the violations first (batch 3), then four or five targeted lock tests with named allow-lists (raw cron, extra database handle, plain-string failure returns in tool catches, column-adds outside the migration list, container calls outside the container module), generalise only past ~8 rules. Also: two `CLAUDE.md` invariants whose wording does not match the real rule ("model ids only in adapters", "`.describe()` on every Zod field"); the description lint that omits one tool source; ledger-line prefixes typed by hand at 7 sites. Honest limit: a source-reading test is not selected by related-files runs — only the host's full-suite hook and CI see it.

### Batch 9 — Low-activity areas and unreachable code (rulings 10, 11)

Facts only (counts, no prune list): 30-day trace 96 of 196 built-in tools called; over 134 days 86 never; 0-call areas = 26,923 of 195,264 lines; their share of the classifier prompt ≈ 20 %. No ruling needed: narrow the CI exclusion (Q10).

### Batch 10 — Model-visible fixes, one eval-gate run (ruling 15)

**Note 2026-11-14 10:22 UTC — for the list of this batch's single evaluation run: `ae1ba977` adds one new error sentence that the batch file tool returns for a wrong nested value (it replaces a raw database message; no description or schema text changed).**

**Status 2026-11-11 03:52 UTC — re-checked by a read-only reviewer (queue 4dd): 17 plain-failure sites (not 18) plus 19 siblings in the same handlers; three more wrong texts found; the eval run cannot see failure shapes or the planner prompt, which get unit tests instead.**

18 tool handlers that return a plain failure string instead of the `{error}` shape; a planner prompt that lists a check binary the shell gate refuses; a shell tool description that recommends a command the gate refuses; 27 schema properties without a description; a false doc comment on the two history flatteners (leave the flatteners themselves).

### Batch 11 — Comments (ruling 12)

**Status 2026-11-18 19:20 UTC — four leftover file-and-line pointers outside TypeScript comments (two SQL scripts, one note string) name the code, and one more false doc line is corrected, `92dfe270` (queue 4fz). Still open in this batch, all in files the removal scripts load: seven C1 findings, the nine C2 rows on the lock test's list, and a few bare line pointers.**

**Status 2026-11-18 17:47 UTC — C3 COMMITTED `3c09b09e` as a lock test over the comments of every production TypeScript file (shrink-only list of nine leftovers; queue 4fx); bare line-number pointers by name and four more false statements COMMITTED `61604fa3`. Still open in this batch, all in files the removal scripts load: seven C1 findings, the nine C2 rows on the lock test's list, and a few bare line pointers.**

**Status 2026-11-18 17:05 UTC — C1 remaining false statements outside the removal list COMMITTED `047b1174`; C2 citations by name, first part COMMITTED `0ef41ba4` (queue 4fw): 36 of 46 rows rewritten in 18 files, 1 already gone, 9 left in five files the removal scripts load. Still open in this batch: seven C1 findings and nine C2 rows in those files, and C3 (the shrink-only check on added comment lines).**

**Status 2026-11-18 15:42 UTC — C1 first part COMMITTED `fd7c7ca5` (queue 4fu): thirteen false comments corrected in eleven files, comments only (identical code tokens, checked twice). Left of C1: seven findings in files the removal scripts load, and one false echo string in a pre-deploy script. C2 (line citations → symbol names) and C3 (the shrink-only check on added lines) not started.**

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
