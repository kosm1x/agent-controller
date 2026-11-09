# November Assesment (2026-11-09)

Whole-project assessment requested by the operator on 2026-11-09, at `main` `6359a8c3`, live build `ecae5e88`. It rates the project on nine dimensions, records the evidence behind each score, and fixes the order in which the dimensions will be worked. Scores are judgments on a 1–10 scale; every number under "Evidence" was measured on the date above.

**Overall: about 6.5 / 10.** A strong, heavily used personal agent for one operator, with unusually good self-checking. It is not yet something another operator could adopt, and its security rests on rules rather than hard boundaries.

## Method

- Orchestrating session: full first-hand read of the repo (rules, roadmap, entry point, routing, model-call layer, tools, deploy, admin CLI), then read-only counts from the live database, the journal and the monitoring API for performance, resilience, memory, tool use and usability. 30-day window unless stated (2026-10-10 → 2026-11-09).
- Three independent reviewers, run in parallel, each given the code and not a conclusion: outside-world comparison (primary sources read on 11-09), code quality (static, one typecheck), security and privacy (static, no probes).
- Reviewer claims were spot-checked against the code and live data before use; they held except one small miscount (duplicate helper definitions: 4 found, 5 reported).
- Not done: no tests were run, nothing was probed against the live service, no git-history secret scan. Security items marked "inferred" are unexercised.

## Roadmap progress (destination: Beta 1.0, `docs/BETA.md`)

| Test | Estimate | Where it stands |
| --- | --- | --- |
| Credibility | ~80 % | Grader in `enforce` graded three nightly roots cleanly (11-06/07/08); eval gate PASS 78.90 vs 78.63 on 11-09. Owed: first failed grade under enforcement (queue 4bi), the two rituals that always end with concerns (queue 4bj). |
| Replicability | ~40 % | Project records and the operator-context gate are live. The operator profile (ruled 10-11), WS4 and WS6 have no code. |
| Scalability | ~25 % | Language (949 fixed-Spanish lines), identity, timezone and paths are still bound to the first operator. |
| Teachability | ~10 % | No onboarding guide, no transfer attempt. |

The percentages are the assessor's judgment, not a measurement. Of 488 commits in the 30 days, none touched the operator profile; the work went to memory, operations, security and record-keeping (145 of the last 200 commits are `docs`). W2, W4, W6 and L4 have no code. Same gap as `recon-vs-roadmap-2026-11-09.md`.

## Scores

| # | Dimension | Score | One-line reason |
| --- | --- | --- | --- |
| 1 | Code | 6 | Excellent typing and tests; weak structure (very large files and functions, no linter, growth without trimming). |
| 2 | Performance | 6 | Correct but slow: half of chat replies take over 18 s. |
| 3 | Resilience | 7 | No crashes and 2 failed tasks in 30 days; one process, one database file, one server, recurring short freezes. |
| 4 | Memory | 6 | Carefully measured; 28 % of recalled material is used; the improvements are observe-only. |
| 5 | Tool use | 7 | Broad, gated, verified after writing; leans on raw shell. |
| 6 | Security | 6 | Careful gates and secret handling; host process privilege plus best-effort shell rules; outward actions are not all human-gated after untrusted input. |
| 7 | Privacy | 5 | Personal files tracked in a public repository; a live key sat in public history for seven months. |
| 8 | Usability | 6 | Very good for the first operator; close to unusable for anyone else. |
| 9 | Currency vs other personal agents | 7 | Tracks upstream better than its peers and leads on verifying its own work; behind on channels, voice, multi-user and agent-to-agent interoperability. |

## Work order (operator ruling 2026-11-09)

One dimension at a time, regardless of the time and effort each takes, in this order: **1 Code → 2 Performance → 3 Resilience → 4 Memory → 5 Tool use → 6 Security and privacy → 7 Usability → 8 Currency.** The operator fixed the first and the last; the middle follows the order in which the dimensions were requested. This program runs before the roadmap's next items (operator profile, onboarding guide). Each dimension opens with a thorough multi-dimension, multi-agent review of that dimension, then rulings, then build → audit → commit → deploy → proof as usual. Progress is tracked in queue item 4cf and in the table at the end of this file.

## 1. Code — 6

### Measurements

| Metric | Value |
| --- | --- |
| Non-test source | 637 files / 195,973 lines |
| Test files / lines | 589 / 207,578 (ratio ≈ 1.0) |
| `it`/`test` cases · `expect` calls | 11,403 · 29,052 |
| Skipped / todo / only | 1 / 6 / 0 (+ 7 conditional skips) |
| Excluded from CI | `src/video/**` and `src/tools/builtin/video.test.ts` |
| Typecheck | 0 errors (16 s) |
| Largest files | `messaging/router.ts` 5,696 · `tools/builtin/shell.ts` 3,241 · `runners/fast-runner.ts` 2,801 · `inference/claude-sdk.ts` 2,538 · `inference/adapter-openai.ts` 2,112 |
| Functions over 100 / 200 / 500 lines | 215 / 49 / 8 of 7,264 |
| Longest functions | `fast-runner.ts` `execute` 1,950 · `db/index.ts` `initDatabase` 1,520 · `claude-sdk.ts` `queryClaudeSdk` 1,065 · `adapter-openai.ts` (l.1289) 824 · `index.ts` `main` 665 · `router.ts` `handleTaskCompleted` 589 |
| Static import cycles | 4 groups of 25 / 8 / 4 / 2 files (the 25 spans `db/index`, `tools/registry`, `messaging/scope`, `lib/secret-refs`, v8-3) |
| Dynamic `await import()` | 138 |
| `any` · `as any` · `as unknown as` | ~2 · 2 · 37 |
| `@ts-ignore` / `@ts-expect-error` | 0 / 0 |
| TypeScript linter | none (4 `eslint-disable` comments point at a linter that is not installed) |
| `catch` blocks | 1,168; 0 empty; 268 comment-only |
| Silent promise catches | 41 `.catch(() => {})` + 49 returning null/undefined |
| `console.*` vs logger calls | ~900 in 163 files vs 237 in 38 files |
| `process.env` reads outside `config.ts` | 204 (141 names, 93 files) |
| TODO / FIXME / HACK | 15 / 1 / 1 |
| Comment share | 23 % of non-blank lines (`claude-sdk.ts` 42 %); 2,191 comment lines cite dates, queue ids or audit rounds |
| Dependencies | 20 runtime + 7 dev; 3 exact pins; `baileys` on a release-candidate range |
| Compiled modules in `dist/` with no source | 39 (the build writes in place and never cleans) |
| 30-day churn, non-test source | +17,357 / −2,364 (≈ 7.3 added per line removed) |
| Commits, 30 days | 488 (105 touch `src`: 38 fix / 28 feat) ; 1 revert in 2,272 |

### Strengths

1. Type discipline: strict mode, almost no escape hatches, clean typecheck; CI also type-checks the tests and refuses a vacuous pass.
2. Tests are many and mostly assert behavior (corpus replays, hand-computed values, cases named after real incidents); mock targets are checked for existence.
3. Errors are rarely swallowed silently; the comment-only catches sampled are best-effort telemetry.
4. The deploy script guards itself (schema preflight, sandbox image/lockfile match, refuses on running tasks, verifies the old process died).
5. Many "why" comments are good and state a contract.

### Weaknesses

1. God objects and functions: the message router mixes about 15 interceptors, feedback, completion/delivery and scope re-runs; 49 functions exceed 200 lines.
2. No TypeScript linter, so project rules are not enforced in code: env is read 204 times outside the config singleton; logging is split ~900 to 237.
3. Coupling: one 25-file import cycle through the database singleton and the tool registry; 138 dynamic imports.
4. Growth without trimming: duplicated helpers (`withTimeout` defined 4 times beside `lib/with-timeout.ts`, `levenshtein` 3, `isUnderPrefix` 3, `useSdkPath` 3); low-activity areas still ship — `finance` (11.6k lines, 5 commits in 90 days), `video` (3.6k + 1.8k, excluded from CI), `teaching` (1.2k, 0 commits in 90 days), `ads-audit` (0 commits in 90 days), `adapter-openai.ts` (2.1k, fallback disabled in production).
5. Comment noise (opaque queue/round ids inside logic) and a build that writes into the live `dist/` in place: no clean step, no rollback, only a warning on a dirty tree.

### What would move it

+1: a linter in CI and the three largest functions split. −1: the router and fast runner keep growing, or the console/env split widens.

### Candidate work (to be confirmed by the dimension's opening review)

- Split `router.ts` and `fast-runner.ts` `execute` into interceptor, feedback, completion/delivery and phase modules (~8.5k lines touched).
- ESLint in CI (typed rules, no-console, restricted `process.env`, import cycles, function length as a warning), then mechanical migration to the logger and `config`, and one copy of each duplicated helper.
- Move schema and migrations out of `initDatabase`; cut the `db/index` ↔ `tools/registry` cycle.
- Atomic build (build to a temporary directory, swap) with a clean step; decide the fate of each dormant area (keep, park behind a flag, or remove — operator names what goes).

## 2. Performance — 6

| Metric (30 days) | Value |
| --- | --- |
| Chat task duration | n 1,379 · median 18.4 s · p90 64.7 s |
| Fast runner, all tasks | n 1,689 · median 19.0 s · p90 54.5 s · p99 208.8 s |
| Heavy runner | n 74 · median 110 s · p90 234 s |
| Swarm | n 9 · median 372 s · p90 564 s |
| Model turn latency | n 13,825 · median 1.8 s · p90 8.6 s |
| Prompt cache read share | fast 82.8 % · heavy 74.9 % · swarm 3.1 % |
| Booked cost per task | fast $0.26 · heavy $1.34 · swarm $0.67 |
| Booked cost by month | Jun $891 · Jul $902 · Aug $606 · Sep $1,120 · Oct $742 · Nov 1–9 $95 |
| Largest non-task cost lines | unattributed SDK calls $19.97 (2,024 rows) · grader $14.26 · scope classifier $4.71 |
| Event-loop lag, 7 days | max 10.8 s; 16 samples above 5 s (overnight database jobs on a cold file cache) |

Reading: the per-turn model latency is fine; a chat reply is slow because a turn chain averages about 8 turns per task and enrichment plus scope classification run before the first one. Telegram streaming softens the wait. The swarm path gets almost no cache benefit. 2,024 SDK calls are booked without an owner.

## 3. Resilience — 7

| Metric (30 days) | Value |
| --- | --- |
| Scrape uptime | 99.983 % |
| Crashes, OOM kills, systemd restarts | 0 |
| Process starts | 92 (all deploys or operator restarts; ≈ 3 per day) |
| Tasks | 1,772: 1,268 completed · 492 completed with concerns · 8 cancelled · 2 failed · 2 needs-context |
| Error-level journal lines, 7 days | 0 |
| Alerts that fired | `RetainOutcomeConcerns` (near-constant) · `BudgetDailyHigh` · `MCEventLoopBlock` · load/CPU · `MCTelegramPollStalled` (3 samples) |
| Scheduled runs | 144 completed, 25 schedules |

Guards present: deploy refuses to interrupt running work; a last-line fallback provider is armed; watchdog and health check every 5 minutes; nightly offsite backup. Limits: one process, one SQLite file, one VPS that the host has power-cycled unannounced; two Telegram long-poll stalls of about 8 minutes (queue 4ar, 4bu); overnight freezes of 5–11 s (queue 4bq, 4br); two alerts fire so often they carry no signal.

## 4. Memory — 6

| Metric | Value |
| --- | --- |
| Active facts (JME) | 538: project 320 · preference 102 · decision 81 · event 34 · emotion 1 |
| Conversation rows · KB files · user facts | 12,779 · 1,323 · 135 |
| Recalls audited, 30 days | 4,159; used in the answer 28.2 % |
| By source | sqlite-primary n 2,341, used 26.9 %, 639 ms · JME n 1,172, used 20.1 %, 50 ms · precedents (shadow) n 646, used 47.7 %, 251 ms |
| Memory ports 1–3 | armed shadow / shadow / record since 11-07; readout ≈ 11-14 |

Reading: storage and consolidation are sound and honestly instrumented, but most of what is recalled is not used, so it is prompt noise; the precedents source, still in shadow, has the best use rate. The improvements built in November only observe.

## 5. Tool use — 7

| Metric (30 days) | Value |
| --- | --- |
| Tools registered | 251 at the 10-26 boot (58 from MCP servers confirmed at the 11-09 boot; total not re-derived) |
| Distinct tools called · calls | 96 · 8,142 |
| Top tools | `shell_exec` 1,652 · `jarvis_file_read` 942 · `web_search` 561 · `file_read` 489 · `web_read` 402 · `jarvis_file_update` 377 · `ToolSearch` 363 · `grep` 362 · `file_edit` 304 |
| Harness gates | 795 met · 2 failed |
| Plan gates | 17 met · 18 failed · 4 abandoned |
| Ritual gates | 13 met · 8 abandoned |
| Operator confirmations (all time) | 83 confirmed · 9 expired · 8 superseded |
| Autonomy levels | 5 capabilities at L1, 1 at L2 |
| Sandboxed runs | 0; last sandboxed task 2026-09-24 |
| Where shell and file writes ran | fast runner: 1,646 shell, 303 edits, 63 writes; heavy: 6 shell, 1 edit |
| Eval gate (tool selection) | PASS 78.90 vs incumbent 78.63 (11-09) |

Reading: selection, deferral, confirmation and read-back verification work. One call in five is raw shell; about 155 registered tools were not called in the window (a cost figure only: by ruling, an unused tool is not a removal candidate). Plan gates fail as often as they pass, which deserves a look. Tool error rate is not recorded in traces, so it is unmeasured here.

## 6. Security — 6 and Privacy — 5

Detail (file and line references, counts per path) is kept off-repo in the operator's session memory under the name `reference_november_assesment_security_detail`, because this repository is public. Categories only here.

### Structural strengths

1. The confirmation gate on the SDK path fails closed (no context, or no one to ask, means refuse); a tool that alone holds all three Rule-of-Two properties is forced to high risk with confirmation.
2. Secret hygiene at the seams: credentials used by reference; results and errors scrubbed before the model sees them; traces carry argument key names only; child processes and MCP servers get a reduced environment.
3. API authentication details are right (timing-safe comparison, forwarded-address handling, hashed expiring MCP tokens).
4. Channels are pinned to the owner; community email gets a default-deny tool list.
5. Sandbox mounts are allow-listed and read-only, with dropped capabilities and limits.
6. The operator gate keys on a kernel fact a task cannot forge; supply chain has a release-age floor, a script allow-list and a committed lockfile.

### Structural weaknesses (severity for a single-operator agent)

1. High — outward actions after untrusted input are not all human-gated; the run-level composition check only bites above autonomy level 1.
2. High — the host process is privileged and the shell rules are a text denylist with documented gaps; they hold against mistakes, not against a hijacked model. The sandbox carried no load in 30 days.
3. Medium-high — exposure of the HTTP API surface and its single long-lived key.
4. Medium, dormant — group-chat scope on the disabled channel.
5. Medium — credentials reachable from inside the coding sandbox; egress allow-list state unverified.
6. Medium — incident detection: the 11-08 leaked key was found by a vendor email after alerts sat unread for seven months (queue 4bx); one writer is still unidentified (queue 4by).
7. Low — secret and personal text in readable places on the host.
8. Low — dependency ranges, action pins, CI token permissions, no request body limit.

### Privacy

- Off the box: the model provider receives every prompt and tool result; the fallback provider only when both primary legs fail; an embeddings provider; the KB mirror and workspace APIs; search and reader services receive queries and addresses; the chat channel receives all delivered text.
- Retention exists: tasks 90 days then archived 365; events and traces pruned; conversations consolidated; fact TTLs.
- The public repository tracks four groups of files that should not be public, plus scattered personal identifiers; 0 live credential shapes at `HEAD`. History was not rewritten after the 11-08 rotation.

### What would move it

Security +1: bind credentials to destinations and require confirmation (or apply the composition check) for outward tools after untrusted input, or close the API exposure. −1: re-enabling group chat as it stands, or another unnoticed leaked key. Privacy +1: untrack the four file groups and scrub the identifiers. −1: any further personal data committed.

## 7. Usability — 6

| Metric (30 days) | Value |
| --- | --- |
| Active days · chat tasks | 31 of 31 · 1,379 (≈ 44 a day) |
| Explicit feedback | positive 49 · negative 9 · rephrase 15 |
| Implicit feedback | positive 119 · rephrase 24 |
| Completed with concerns | 27.8 % overall: chats 23.5 % (324 of 1,379) · other tasks 42.7 % (168 of 393) |
| Runner end states | DONE 1,197 · DONE_WITH_CONCERNS 484 · BLOCKED 6 · NEEDS_CONTEXT 4 |

Reading: for the first operator it is in daily, heavy, mostly satisfied use, with streaming, confirmations and a rich admin CLI. The concerns flag fires on more than a quarter of tasks, which dilutes it. For anyone else there is no profile, no onboarding guide, and the README names a different default provider than the one that runs.

## 8. Currency vs other personal agents — 7

Sources read 2026-11-09; items marked (s) rest on secondary sources.

| Capability | This project | Field | Position |
| --- | --- | --- | --- |
| Channels | Telegram + WhatsApp (unofficial library on a release candidate; off in production); email off | Leading open projects: many channels, web and mobile surfaces, one gateway | Behind |
| Memory | FTS + vectors, decay, consolidation, measured recall, shadow ports | Comparable features; little published measurement | Level, ahead on measurement |
| Tool protocol | MCP SDK 1.32.0, protocol `2025-11-25` | Spec latest is `2026-07-28`; no SDK negotiates it yet | Level with the field |
| Skills | KB skill files, critic-gated | Open skills standard widely adopted (s) | Level; portability unverified |
| Sandboxed code | OpenSandbox pinned at 0.1.11 (latest 1.2.0) + container runner, unused in 30 days | Hosted/stable environments elsewhere | Pin a major behind |
| Multi-agent | Swarm (9 tasks), A2A (0 tasks) | Pluggable delegation, agent templates | Level |
| A2A | Pre-0.3 dialect | A2A 1.0.1 (2026-05-26) | Behind; parked by ruling until 12-01 |
| Proactive work | Rituals, schedules, Morning Sync | Event-triggered automations | Level; no event triggers |
| Verifying own work | Completion ledger + grader enforced, measured false positives | Experimental elsewhere | Ahead |
| Voice / multimodal | Voice-note transcription | Real-time voice (s) | Behind |
| Computer / browser | Headless browser + Playwright MCP | Device and cross-device sessions | Partial |
| Model portability | Agent SDK primary, dormant OpenAI-compatible path, armed last line | Multi-provider by default | Locked by design, with an exit |
| Multi-user / onboarding | Single operator | Roles, guests, sharing (s) | Behind |
| Self-improvement | Skill evolution, tuning; self-modification deliberately blocked | Skill curators, learned skills | Level, safer |
| Evals | Paid gate on every prompt/model/tool-text change; weekly internal eval | Multi-run eval in one vendor kit | Ahead |

Models in use (cost ledger, 30 days): `claude-sonnet-5-5` 4,879 calls (current) · `claude-opus-4-8` 157 calls (legacy; stays by operator ruling) · `claude-haiku-4-5-20251001` 36 calls (still active, past its earliest possible retirement date; current is the 5.5 small model). The code default for the main model is an older id overridden by environment. Agent SDK 0.3.316 against a latest of 0.3.321. `@anthropic-ai/sdk` 0.111.0 against 1.7.0 (peer only, no direct imports).

Risks by likelihood × cost: (1) small-model retirement notice — the swap needs the eval gate; (2) the first MCP server or SDK that speaks only the new spec; (3) breakage or ban on the unofficial chat library; (4) SDK surface churn, absorbed by the bump-plus-gate routine; (5) the Anthropic SDK 1.x becoming a peer floor; (6) an A2A consumer appearing; (7) heavy-model retirement (not before 2027-05-28).

What would move it: +1 = small-model id through the gate, the A2A 1.0 shim, the operator profile. −1 = a retirement lands unhandled, or a new-spec-only MCP server is needed before migration starts.

## Top five moves across all dimensions

1. Operator profile, then the onboarding guide (moves three of the four Beta tests).
2. Close the outward path and the API exposure (security).
3. Clean the public repository of personal files (privacy).
4. Move the small model to the current id through the eval gate (currency).
5. Linter in CI and split the two largest files (code).

## Progress tracker

| Dimension | Opened | Review | Rulings | Shipped | Re-score |
| --- | --- | --- | --- | --- | --- |
| 1 Code | next session | — | — | — | — |
| 2 Performance | — | — | — | — | — |
| 3 Resilience | — | — | — | — | — |
| 4 Memory | — | — | — | — | — |
| 5 Tool use | — | — | — | — | — |
| 6 Security and privacy | — | — | — | — | — |
| 7 Usability | — | — | — | — | — |
| 8 Currency | — | — | — | — | — |

## Next session: CODE (dimension 1)

Open with a thorough multi-agent review of the code dimension, one reviewer per sub-dimension, each given the code and the measurements above and asked to verify, extend and size the work, not to confirm the candidate list:

1. Structure: the six longest functions and the five largest files — natural seams, extraction order, what the existing tests already pin.
2. Coupling: the four import cycles and the 138 dynamic imports — which are deliberate cycle breaks, the minimal cut set.
3. Conventions in code: a linter rule set that encodes the `CLAUDE.md` invariants (config singleton, logger, `scheduleCron`, completion ledger, `sanitizeDeliverable`), with the violation count per rule today.
4. Dead weight and duplication: per dormant area, boot wiring, size, last use in production (tool-call counts are in §5), and a keep / park / remove recommendation for the operator to rule on; one home per duplicated helper.
5. Build and deploy path: atomic build, clean step, rollback, the 39 orphan modules, dirty-tree policy.
6. Tests: where tests mock themselves, slow or flaky files (queue 4ap, 4bm, 4cb), the CI exclusion, the memory ceiling history (queue 4bs, 4ca).
7. Error handling and logging: the 268 comment-only catches and 90 silent promise catches by risk; the console-to-logger migration plan.
8. Comments: a rule for incident history in code versus in docs, and the files where it buries logic.

Constraints that bind the review: read-only until the operator rules; no test runs outside the 6 GB fence; one heavy process at a time; no behavior change ships without builder → separate auditor → full suite on commit → CI → operator deploy → proof; a prompt, tool-description or model-id change needs the eval gate; refactors that leave those strings byte-identical do not. The review ends in one ruling list: what to split, what to enforce, what to park or remove, in what order.
