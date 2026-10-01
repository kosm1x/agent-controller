# Hermes upstream review — v0.21.0 → v0.21.5 (2026-10-01)

Monthly review of `NousResearch/hermes-agent` since the last one (2026-09-01,
v0.21.0): **five patch tags, v0.21.1–v0.21.5 (`v2026.9.7` … `v2026.9.24`), no
new minor.** Upstream says curated notes are deferred to v0.22.0, so the window
was read from the five release bodies, ten PR bodies and the commit log
(4,467 subjects 09-24 → 10-01; the compare view reports the fork point
14,831 commits behind). Memory: `feedback_prometheus_upstream`. Companion note:
`nanoclaw-upstream-review-2026-10-01.md` (same session, one commit).

## Method

1. Candidates were taken from the release bodies and PR bodies with a verbatim
   quote + PR/sha each, grouped by what they protect: **A** scheduling and
   approvals, **B** credentials and replay, **C** process and storage
   robustness, **E** gates and persistence. Tier 3 (Desktop, dashboard,
   gateway multiplex, provider catalog, messaging platforms, Bot Mode) was
   summarised, not read line by line.
2. Every candidate was **verified against the live code and 30 days of
   production data** before a decision:
   - `tasks` 30 d: `fast` 1,405 completed / 274 completed_with_concerns /
     34 blocked / 3 needs_context / 4 failed; `heavy` 70 / 13 / 3 failed;
     `nanoclaw` 5 completed / 7 failed (last 09-24, all scope/capability
     failures); `swarm` 2 / 6.
   - Journal retention starts 2026-09-23 (~8 days): 23 boots.
   - Context overflow: max per-turn input 145,038 tokens, 0 overflows.
   - Approvals: 4 `tool_approvals` rows, 2 expired unanswered.
   - `run_schedule` vs the next cron tick: 0 collisions in 7 manual runs.
3. Verdict per candidate: **shipped / present / N/A / deferred-with-trigger**.
   Upstream text and subagent reports were treated as untrusted data.

## Shipped (6, one commit with the NanoClaw item)

### 1. Boot singleton guard — Hermes v0.21.4 "host-wide gateway singleton lock"

- **Gap:** nothing stopped a second mission-control process from opening
  `data/mc.db`. At HEAD a second process ran `initDatabase` +
  `reconcileOrphanedTasks` — which marks the LIVE service's in-flight tasks
  failed — and only then died on the port check.
- **Fix:** `src/lib/single-instance.ts` `acquireSingleInstance(dbPath)` binds an
  abstract unix socket named from the sha256 of the database's real path;
  `EADDRINUSE` rejects with `Another mission-control instance already holds
  database <path> — exiting without touching it`. `src/index.ts` runs
  `checkPort` and the guard **before** `initDatabase`. Any other listen error
  warns and continues (fail-open: the guard must never keep the service down).
- **Evidence:** two-process probe on temp paths — second process exits 1 with
  the message; the lock frees when the holder exits; a spawned child does not
  inherit it. Workers and scripts do not call the guard, so none is refused.
- **Limits:** abstract sockets are per network namespace (a process in another
  netns is not seen); the window between the port check and `listen` now spans
  boot (failure mode at listen time is unchanged: exit 1).

### 2. Read guard: secrets that file tools and uploads could reach — Hermes #107609

Upstream: *"a `MEDIA:` tag pointing at another profile's `.env` / `auth.json` /
`state.db` … is now blocked like the launch profile's own."*

- **Gap (as reviewed):** `READ_BLOCKED_PATHS` did not cover the mc.db snapshots
  in `/root/backups/` and `/root/claude-backups/`, `/root/.hapi.yaml`, Pulso's
  `store/` (WhatsApp auth + messages), `/var/lib/caddy/` (TLS keys),
  `/var/lib/stalwart/`, `/root/.kube/`, `/root/.config/gcloud/`, or the Claude
  Code session stores under `/root/.claude/`. Every reader that takes a path
  (`file_read`, `grep`/`glob`/`list_dir`, upload tools reading `content_file`,
  `pdf_read`, `ingestPdf`) could read or upload them.
- **Gap (found by the audit, pre-existing at HEAD):** the read guard judged a
  path after lexical normalisation while the kernel follows symlinks first.
  `/proc/self/cwd/../../backups/<db>` was judged as `/proc/backups/…` and opened
  the real backup; the same spelling reached `mc.db` and `/root/.claude.json`,
  which were already on the denylist. A second member of the class:
  `/proc/<pid>/root/…` of a containerised process — `readlink` returns `/`, but
  it is the container's root; one container on this box bind-mounts the host
  `/`, so the whole host filesystem was reachable through it.
- **Fix:**
  - `write-guard.ts` `kernelWalk(p)` (the existing kernel-style walker, now
    exported) stops on any `/proc/<pid|self|thread-self>[/task/<tid>]/`
    `root|cwd|exe|fd/<n>|map_files/<x>` component, including when reached
    through ordinary symlinks; `validatePathSafety` refuses such a path for
    read, write and delete.
  - Read mode checks the kernel-resolved path in addition to the lexical and
    `realpath` candidates; `code-search.ts` listing filters do the same.
  - New `READ_BLOCKED_PATHS` entries for the stores above plus the container
    filesystems (`/var/lib/docker/`, `/var/lib/containerd/`,
    `/run/containerd/` — this host uses the containerd snapshotter, so the
    docker path alone does not cover them) and every backup destination in
    the table below that was not covered; a blocked directory passed as the
    path is refused instead of listing empty.
  - `/root/.claude/` is **default-deny** for reads; readable: `CLAUDE.md`,
    `NOW.md`, `rules/`, `agents/`, `global-memory/`, and
    `projects/<proj>/memory/`.
  - `ingestPdf` calls the guard (it did not).
  - `shell.ts` `SECRET_PATH_PATTERNS` mirrors each entry with a literal pattern
    (the shell gate stays a string gate). Three changes to the gate itself:
    `//` and `/./` are collapsed in the copy the patterns are matched against
    (`cat /root//.ssh/id_rsa` passed every pattern at HEAD); a command longer
    than 131,072 bytes is refused before any regex (the kernel refuses a single
    `sh -c` argument of that size, measured — nothing runnable is lost); and
    the quadratic `\S*` patterns, including the pre-existing
    `/proc/…environ`, were rewritten to linear shapes with identical verdicts
    (differential fuzz, 0 disagreements). The absolute-`.env` rule's
    directory part became optional, because the collapse turns `//.env` into
    `/.env`, which the rule did not match (R4 regression, fixed before
    commit); a `.env` directly under `/` is therefore refused now.
- **Where copies of `mc.db` / `.env` are written on this host** (enumerated
  from `scripts/`, `mc-ctl`, `deploy.sh`, crontab, `/etc/cron.d`, systemd
  timers, `src/` and `/root/*.sh`; names and sizes only, nothing opened):

  | Destination | Writer | Holds | Read guard | Shell gate |
  | --- | --- | --- | --- | --- |
  | `/root/backups/` (+ `vlcms/`) | weekly KB cleanup (`kb-janitor.timer`), vlcms backup timer | `mc-db-pre-kbcleanup-*.db`, KB snapshots, cms db copies | added (item 2) | added |
  | `/root/claude-backups/` | manual snapshots | archived trees, old `.env` files | added (item 2) | added |
  | `/root/claude/mission-control/backups/` | `vps_backup` tool (`db.backup`), `scripts/backup-db.sh` (cron line retired) | `mc.db.<ts>`, `mc-<date>.db` | added | added (+ relative `backups/mc.db…`) |
  | `/opt/supabase/backups/` | `scripts/backup-state-bundle.sh` (02:30), `/opt/supabase/backup.sh` (04:00) | state bundles (mc.db, `.env`, WhatsApp session), Supabase dumps | added | added |
  | `/root/claude/Pulso-Aura-Upfront/data/backups/` | Pulso `scripts/db-snapshot.sh` (03:15) | copies of the CRM db and of the blocked `store/messages.db` | added | added |
  | `mission-control/data/sonnet-bench/` | `scripts/benchmark-sonnet-tier.ts` | `bench.db`, a full mc.db copy | already (via `data/`) | added |
  | `.env.bak*` beside each `.env` | rotation / cutover scripts | timestamped `.env` copies | already, by name | already, by name |
  | `/tmp/eval-gate-*`, `/tmp/tool-search-val-*`, `/tmp/mc-bundle-*` | eval gate, tool-search validation, bundle staging (all delete on exit) | transient mc.db copies | open | open |
  | `/tmp/sdk-tool-vis-*/mc.db`, `/tmp/validate-planner-sizing.db*`, `/tmp/mc-evolution-verify.db*` | three operator-run validation scripts with **no cleanup** | mc.db copies (none exist now) | open | open |

  The two `/tmp` rows stay open: random-suffix directories cannot be expressed
  as denylist entries, and the fix for the second row is in the writers (an
  exit-time `rmSync`, as the eval gate already does) — queued.
- **Evidence:** 0 in-code readers through the guard and 0 mentions in 30 days
  of `tasks` for every new entry, except one legitimate read of a memory `.md`
  under `/root/.claude/projects/` — which stays readable.
- **Behaviour changes:** `list_dir /root` and `list_dir` of the checkout no
  longer show the names of blocked directories (`backups/`, `data/`, `.ssh/`);
  `ls /root/.claude` is refused in Jarvis's shell (`list_dir` shows the allowed
  names).
- **Open by design (string gate / path guard limits):** `cp -r <dir>` then
  reading the copy; `cd <dir> && <relative path>`; `tar c <dir> | …`; globs;
  shell variables; a recursive grep on a parent directory; paths assembled
  inside an interpreter; quote/escape splits; hard links; read-then-open races.
  In the shell gate only (the file tools resolve these): `..` through an
  existing sibling directory (`/root/claude/../.ssh/…`), brace expansion under
  `bash -c`, and a `.env` named through a relative path with a directory part
  (`cat foo/.env`, `cat src/../.env`) — all pre-existing, found by the R4/R5
  audits, not patched (see the structural-closer ruling).

### 3. Auth retry no longer replays tools that already ran — Hermes #106546

Upstream: *"a non-idempotent action (a charge, a send, a delete) is never
applied twice."*

- **Gap:** the fast runner's auth-retry leg restarted from the original prompt
  after leg 1 had already executed tools, so a write or send could run twice.
  The cap-resume leg already told the model which tools had run; the auth leg
  did not.
- **Fix:** `fast-runner.ts` shares one `continuationPrompt(reason, progress,
  ranNames)` between the two legs. On the auth leg the "already ran" list holds
  only tools with side effects (`readOnlyHint !== true`; unknown or unhinted
  names count as side-effecting; the SDK built-in `ToolSearch` is excluded);
  when leg 1 ran only reads — or only calls stopped by the confirmation gate —
  the retry uses the original prompt unchanged.
- **Evidence:** the resume-leg prompt is byte-identical to HEAD (three
  independent comparisons: 405, 1,700 and 20,000 input combinations, 0 diffs)
  and its bytes are now pinned by an exact-string test. `ToolSearch` appears in
  495 of 1,683 tool-using tasks in 30 d.
- **Also:** two quadratic regexes on the leg-merge path (7.8 s on 50,000
  newlines) were replaced by linear helpers, equal to the regexes over
  60,000 generated inputs.
- **Eval gate:** not run and not required. No model id, system prompt or tool
  description changed; the auth leg's continuation text is a recovery-leg user
  prompt built by the existing builder; the resume leg is unchanged.

### 4. Dead in-flight schedule runs are reaped — Hermes #106733 / `ef640340`

Upstream: *"A `fire_claim` whose same-host owner pid has exited is treated as
stale immediately."*

- **Gap:** `pendingScheduled` entries are removed only when a `task.completed`
  / `task.failed` event reaches the scheduler. A runner that threw past the
  dispatcher (no bus event) left the entry in the Map and the `schedule_runs`
  row `running` until restart: `run_schedule` refused the schedule as "in
  flight", and the Morning Sync strategic dedupe treated it as running.
- **Fix:** `dynamic.ts` `reapIfDead(taskId)` — called from
  `inFlightScheduleRun` and the strategic-dedupe loop — drops the entry when
  the task row is terminal and `completed_at` is older than 120 s, marks a
  still-`running` `schedule_runs` row failed (`lost: task <status> but its
  result never reached the scheduler`) and sends the same operator alert as a
  normal failed run. The function is total: a DB error inside it cannot sink
  the Morning Sync.
- **Evidence:** the 120 s grace cannot race a normal delivery
  (`handleScheduledTaskResult` deletes the entry before any send; `emitEvent`
  broadcasts synchronously); `completed_at` and `datetime('now')` are both UTC
  text (1,760 rows checked); 0 terminal tasks without `completed_at`.

### 5. `jarvis_test_run` / `vps_deploy` kill the process group and run one at a time — Hermes #106589

Upstream: *"timeout kills the whole CLI process tree instead of orphaning
pipe-holders."* (NanoClaw #3957 is the same class.)

- **Gap:** four `execFileSync("npx", …)` calls blocked the event loop for up to
  120 s and, on timeout, killed only the `npx` parent — vitest workers and
  `tsc` survived.
- **Fix:** both tools use `execGroupKill` (already used by `shell_exec`), which
  kills the process group. Because the blocking call had been an accidental
  mutex, `withSuiteRunLock` now allows one suite run at a time across both
  tools (the full suite OOMs this box). Tool descriptions are unchanged.

### 6. Credentials are redacted before error and output text is stored — Hermes `4e740313`

Upstream: *"a secret echoed by a provider or tool error reached the 'store' and
'export' sinks verbatim … Force-redact every string in the payload at the
producer."*

- **Gap:** error and output text was written raw to `events.data`,
  `runs.output`, `runs.error`, `runs.trace`, `tasks.error` and
  `task_trace_events.attrs`, and forwarded raw on the SSE stream. 30-day
  evidence: one Google-key-shaped match each in `events`, `tasks.output` and
  `runs.output`.
- **Fix:** `redact.ts` `stringifyRedacted` / `redactCredentialsForPersist`
  (existing patterns, `redactCredentials` — not the 40-hex rule, which would
  erase git SHAs) at the persistence seams: `bus.ts` `persist()`, the SSE
  `send()`, the dispatcher's runs update and `updateTaskStatus`, and
  `task-trace.ts`. In-process subscribers still receive the unmodified event,
  so delivery, retries and schedule results are unchanged. Redaction fails
  open (raw value + one warning) so the audit row is never lost.
- **Redact before truncating:** a fixed-length key rule cannot match a key cut
  by `.slice(0, N)`. Fifteen sites that cut first were reordered
  (`dispatcher.ts`, `container.ts`, `opensandbox-backend.ts`,
  `adapter-openai.ts`, `reactions/rules.ts`, `router.ts`, `provenance-gate.ts`).
- **Deliberately raw:** `tasks.output` (the swarm runner delivers a child's
  stored output verbatim), `runs.output.pendingConfirmation` and
  `tool_approvals.args_json` (executed on approval, bound to the args' sha256),
  `runs.goal_graph` (resume input). Rows written before deploy are not
  rewritten.
- **Evidence:** stored JSON byte-identical to `JSON.stringify` over 60,000
  generated objects; provider-error classification unchanged on 12 realistic
  bodies; worst-case redaction cost linear (37 ms on 500 kB).

## Confirmed already present (no action)

| Hermes item | Ours |
| --- | --- |
| #106306 an off-tick "run now" no longer cancels the next scheduled run | `run_schedule` does not stamp the cron slot; 0 collisions in 7 manual runs. Residual: a manual run stamped in the minute before the tick suppresses that tick (silent skip); the cron path does not check in-flight, so both can deliver |
| Approvals survive restart; a stale approval cannot be confirmed (`447fb495`, #113158) | `tool_approvals` rows persist within the 5-min TTL; one call, args hash, consumed once |
| #106546 MCP call not replayed after a server dies | MCP calls and the tool registry have no retry |
| Partial replies kept on a failed turn | `keepLeg1Partial` / `mergeSdkLegs` |
| `state.db` backup integrity (v0.21.1 store fixes) | backups use `.backup` + `integrity_check` |
| SQLite variable limit on large IN-lists | largest list 500 / 400 vs limit 32,766 |
| FTS / corrupt-row degrade | search degrades to no results; two silent catches noted (queue) |
| #106589 process-tree kill on timeout | `shell_exec` and `check_cmd` already group-kill (item 5 closes the two remaining tools) |
| #106567 context overflow after partial streaming cannot grow the request | max per-turn input 145,038 tokens; 0 overflows in 30 d |

## N/A

- **Delivery-retry persistence (queued-lane redelivery):** nothing is persisted
  for redelivery here; sends throw on failure.
- **#107978 one Anthropic credential per client:** no `ANTHROPIC_*` variable in
  the live environment. Latent: the SDK child inherits `...process.env`.
- **#106866 compressor silent timeout:** the compressor runs only on the
  OpenAI path (0 runs on record).
- **#106676 `tool_search` empty result:** ours is the SDK's `ToolSearch`.
- **#106310 skills-only review cannot delete memory:** no background-review
  fork with a memory toolset.

## Deferred — with triggers, and operator rulings

| Item | Why not now | Trigger / owner |
| --- | --- | --- |
| Late "sí" after an approval expired (2 of 4 approvals expired) | options change the gate's UX: expiry notice / re-issue the card / longer TTL; a re-issue can swallow an unrelated "sí" | **operator ruling** |
| `schedule_task` is not confirmation-gated, and non-interactive runs skip the gate (1 of 20 active schedules carries `gmail_send`) | gate behaviour is ruled by the operator | **operator ruling** |
| User-facts block injects credential values verbatim into the prompt (16 credential-named facts) | masking changes the system prompt → paid eval gate, and may break flows that rely on the value | **operator ruling**; rotate the Gemini key first (see below) |
| `jarvis_test_run` / `vps_deploy` run the FULL vitest suite inside the service | scoping them changes tool behaviour | **operator ruling** |
| `docker exec` / `docker cp` / `docker run -v` are allowed by the shell gate and reach container and host filesystems without a path | verb-level decision on `docker`, not a path pattern | **operator ruling** |
| `jarvis_dev action=pr` runs the full suite outside the new one-at-a-time lock | changes `jarvis_dev` behaviour | with the full-suite ruling above |
| `execGroupKill` settles only on `close` (a grandchild that leaves the process group while holding stdout would keep the suite lock until restart) | not reachable with `tsc`/`vitest`; shared with `shell_exec` | first stuck "test run already in progress" |
| Output over 1 MB keeps the head, the vitest summary is at the tail ("Tests: ? passed"; pass/fail still comes from the exit code) | cosmetic | first such report |
| `lib/eviction.ts` tells the model to `file_read` `data/tool-results/…`, which the read guard already refused at HEAD (web-read eviction flow broken, pre-existing) | unrelated bug, out of scope | next eviction or web-read session |
| Bare `/root/.claude` is listable by `list_dir` (shows only the six allowed names) while the shell refuses the bare directory | no leak | none |
| `tasks.output` stays raw | swarm reads children's output from the DB; needs the in-memory payload or a short-lived raw column | next swarm change, or a key found in `tasks.output` |
| Cut-before-redact sites left: `intel/adapters/http-error.ts`, `lib/fetch-json.ts`, `lib/llm-json.ts`, `google/client.ts`, transcription, vision, `x-errors.ts`, five in `fast-runner.ts` | indirect; providers rarely echo a full key | a cut key found in a redacted column |
| Redaction of `tasks.description`, `conversations`, `jme_turns`, day-logs | user-authored text; out of the error/output class | operator ruling with the user-facts item |
| Text-egress filter does not cover `file_read` output | separate surface | first secret seen in a delivered `file_read` excerpt |
| OpenAI-path twin of the auth-retry replay guard | path dormant (0 runs) | `INFERENCE_PRIMARY_PROVIDER=openai` |
| `sdkAuthFailed` false positive on a successful answer containing "API Error" + "401" | pre-existing; no incident | first wrong auth retry in the journal |
| Tools hinted read-only that write or cost money (`knowledge_map`, `email_verify`, `chart_generate`, paid search/market tools) | HEAD replayed all of them on every auth retry; the change only reduces replay | hint review with the next tool audit |
| A reaped schedule run when the router is not yet up (boot window) logs only | the Map is empty at boot | first such journal line |
| Guard residuals: a future FILE directly under `/root/.claude/projects/` would be readable; the sandbox mount gate (`volumeRefusal`) normalises lexically | not reachable from model input today | mount specs or that directory level become model-influenced |
| mc.db copies in `/tmp`: three validation scripts (`validate-sdk-tool-visibility.ts`, `validate-planner-sizing.ts`, `verify-evolution-fix.ts`) leave a copy behind; `MC_BENCH_SCRATCH` moves the bench copy outside the guarded directory; `.bak-*` copies of systemd drop-ins under `/etc/systemd/system/mission-control.service.d/` carry `Environment=` lines | fix belongs in the writers; none exists today | next run of any of those scripts — add the exit-time cleanup first |
| Structural closer for the path-guard class: file and shell tools under a separate uid or in a mount namespace that hides the secret stores | a path-string guard cannot close two things: aliases (the same bytes at another mount point — the containerd finding) and check-then-open races | **operator ruling** (design); until then the guard is defense in depth |
| Boot guard is per network namespace | no second netns runs the service | service moves into a container |
| Boot guard key on a first boot through a symlink: when the database file does not exist yet and its path goes through a dangling file symlink or a symlinked parent of a missing directory, the holder's key is the unresolved spelling and a later boot gets the real path (R4) | the live path is a regular file with no symlinked parent | the database path is moved behind a symlink |
| Shell gate: `..` through a sibling directory, brace expansion, and a relative `<dir>/.env` pass the secret and env rules (R4/R5, pre-existing) | a fourth round of string patterns; the recipe (match a copy with `path.posix.normalize` applied to tokens containing `/..`) only adds refusals but leaves the class open | structural-closer ruling; do not patch alone |
| Shell validator CPU at the 131,072-byte cap (R4, all pre-existing shapes, unbounded before the cap): a whitespace run 24–27 s (`shell.ts` split regex), `(` × N 15.6 s (regex re-run in a loop condition — hoist it), `${` × N 8.5 s, `find ` / `git ` × N 5–6 s, nested `bash -c` 0.8 s at 800 levels (fails closed with a `RangeError` from ~1,600) | blocks the event loop for one model-supplied command; not in this change's delta; a smaller cap changes which commands are accepted | first event-loop stall traced to `validateShellCommand`, or the next edit of the tokenizer |

## Operator action: rotate the Gemini API key

`user_facts` holds a Gemini API key saved by Jarvis from an image on
2026-03-25 (category `projects`, key `gemini_api_key`). `formatUserFactsBlock`
injects it into the prompt when a message word matches (two tasks in
September), and copies exist in `projects.credentials`, ten `conversations`
rows, two `tasks.description` rows, one `runs.input`, one `events` row and the
weekly mc.db snapshots. `GEMINI_API_KEY` is also set in the live environment
(checked by name), which the tools read first. Steps: rotate the key in the
Google Cloud console; put the new key in `.env` **from the Panel terminal**
(not from a Claude Code session); restart; then ask Jarvis to delete the fact
(`user_fact_delete`, category `projects`, key `gemini_api_key`). The same
exposure applies to the `alpha_vantage_api_key` fact and to a WordPress
application password present in two `conversations` rows.

A scrub of the historical copies (UPDATE … `replace(…, <the fact's value>,
'[REDACTED-GOOGLE-API]')` over `tasks`, `runs`, `events`, `conversations`;
`json_remove` on `projects.credentials`; then DELETE the fact) exists only as a
**draft that was never replayed on a scratch copy** — do not run it as written;
it needs a replay on a copy of mc.db first.

## Tier 3 skipped

Desktop terminal batching and Desktop/host backend attach, dashboard, gateway
multiplex and profiles, hosted rooms, provider/model catalog, messaging
platform fixes, WAL/OpenZFS store fixes specific to `state.db`'s connection
pool, Windows process handling.

## Cadence

Upstream is at **v0.21.5 (2026-09-24)**; v0.22.0 will carry the curated notes
for this window. Next review due **2026-11-01** — if v0.22.0 has landed, read
its notes against this note's verdicts first.

## Audit

Separate `qa-auditor` runs per bundle; implementers never audited their own
change. Every fix was mutation-checked (mutant RED, file restored).

| Bundle | R1 | R2 | R3 |
| --- | --- | --- | --- |
| Boot guard | PASS as written | — | PASS WITH WARNINGS → symlink-alias key + boot-order pin folded |
| Read guard, shell patterns, group-kill | **FAIL** — `..` after a symlink bypasses the guard (pre-existing) | **FAIL** — `/proc/<pid>/root` of a containerised process (pre-existing); auditor stopped part-way by a safety classifier | PASS WITH WARNINGS — no third bypass of the read guard; 29/29 mutants RED; four warnings folded (below) |
| Schedule reap + auth retry | PASS WITH WARNINGS (reap could throw into the Morning Sync; resume bytes unpinned; read tools listed as "already ran") | PASS WITH WARNINGS (`ToolSearch` counted as side-effecting; reap silent) | PASS |
| MCP recovery (NanoClaw note) | PASS WITH WARNINGS (alert storm, leaked child, shutdown race) | PASS WITH WARNINGS (storm moved past the threshold) | PASS WITH WARNINGS → boot failure counted as a death, bound comment corrected |
| Redaction | — | PASS WITH WARNINGS (cut-before-redact; `keepRaw` aliasing; `runs.trace`) | PASS WITH WARNINGS → two test pins added |

**After R3.** The read guard's four R3 warnings (container layers under
`/var/lib/containerd` and `/run/containerd`; `//` and `/./` spellings in the
shell gate; quadratic patterns with no length cap; a backups pattern that was
too narrow) were folded, and the backup destinations were then enumerated
(table in item 2) instead of patched one by one.

**R4** — three auditors in parallel: a delta audit of the shell gate and read
guard, a delta audit of MCP recovery and the boot guard, and a verification of
the whole change set. Boot guard and MCP: PASS WITH WARNINGS (a first-boot
symlink key — queued; a false bound in a test comment — fixed; nine alert
schedules replayed, every clause of the source comment true). Shell gate:
**FAIL** on a regression introduced by the R3 fold — the slash collapse rewrote
`cat //.env` to `cat /.env`, which the absolute-`.env` rule never matched;
plus one linear rewrite that differed from its old shape on 8 of 300,000 fuzz
inputs (not exploitable), and four older linearity pins that the new length
cap had turned into no-ops. All folded: the rule's directory part is optional,
the lookahead is corrected, the four inputs sit just under the cap and every
case asserts it is not refused for length.

**R5** — a separate auditor on that fold only: no Critical. 200,000 distinct
commands × 2 seeds, 0 refuse→allow against the pre-fold rule. Against HEAD the
only commands refused then and allowed now are a `.env` under a RELATIVE path
spelled with `//` (`cat x///y/.env`); HEAD refused them by accident and already
allowed the single-slash spelling (0 exceptions over 5,525 + 5,550 cases).
The lookahead: 0 disagreements with the old shape over 300,000 strings. Both
mutants RED; removing the collapse turns five timing pins RED. The R5 auditor
was cut off by an infrastructure failure after its mutants (tree verified
byte-identical to its backup) and before its closing test run, which the
orchestrating session ran instead.

Left open and queued — all pre-existing, all in the shell string gate: `..`
through a sibling directory, brace expansion, a relative `<dir>/.env`, and the
validator's CPU cost at the length cap.

Verification at commit: `npm run typecheck` exit 0. Scoped tests over the 40
test files that cover the change: 1,653 passed, 0 failed, 0 skipped (R4
verification run); the R4 fold added 9 tests, and the six files it touches
were re-run after it — 572/572 (`shell.test.ts` 340, `immutable-core.test.ts`
128, `code-search.test.ts` 25, `manager.test.ts` 43, `gate-check.test.ts` 27,
`single-instance.test.ts` 9). Secret scan over 4,182 added lines: 0 hits. No
tool description, system prompt or model id changed (`prompt_modules` diff
empty; the cap-resume prompt is byte-identical and pinned). The full suite ran
once, in the pre-commit hook.

## Deploy

Operator: `cd /root/claude/mission-control && ./scripts/deploy.sh`

Post-deploy proof: `systemctl is-active mission-control`; journal clean for
30 s; `ss -xl` shows `@mission-control:<hash>`; MCP servers connected in the
boot log; ask Jarvis to `file_read /proc/self/cwd/package.json` → refused; a
scheduled run delivers.
