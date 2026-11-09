# Hermes upstream review — v0.21.6 → v0.23.0 (2026-11-09)

Monthly review of `NousResearch/hermes-agent` since the last one (2026-10-01,
v0.21.5). Window: **11 tags**, two minors.

| Tag | Published (UTC) | Note |
| --- | --- | --- |
| v0.21.6 | 10-08 11:51 | patch |
| v0.21.7 | 10-12 05:53 | patch |
| v0.22.0 | 10-14 03:21 | minor: "~24,200 commits · ~6,080 merged PRs" since v0.21.0 |
| v0.22.1 | 10-14 23:59 | v0.22.2 notes say it was "built from the wrong commit" |
| v0.22.2 | 10-15 08:21 | patch |
| v0.22.3 / v0.22.4 | 10-21 12:21 / 18:49 | patch |
| v0.22.5 | 10-23 05:28 | patch |
| v0.22.6 / v0.22.7 | 11-02 17:18 / 11-03 21:53 | patch |
| v0.23.0 "The Hearth Release" | 11-05 21:32 | minor: "~10,080 commits · ~1,950 merged PRs" |

Repo at read time: 261,839 stars, `pushed_at` 2026-11-09T06:42:40Z. Our side:
claude-agent-sdk 0.3.316 (CLI 2.1.316, bumped 11-09) with tool search armed,
251 tools, 5 runners, memory ports 1–3 in shadow/record, W1 grader enforcing,
eval gate v4 incumbent 78.63 (last PASS 78.90, 11-09). Memory:
`feedback_prometheus_upstream`. Prior reviews: `hermes-upstream-review-2026-09-01.md`,
`hermes-upstream-review-2026-10-01.md`.

## Method

1. Release bodies for all 11 tags (`gh api repos/NousResearch/hermes-agent/releases`),
   then 37 PR bodies picked from them (`gh api repos/NousResearch/hermes-agent/pulls/<n>`),
   then the v0.23.0 source of the five load-bearing files
   (`gh api repos/NousResearch/hermes-agent/contents/<path>?ref=v0.23.0`):
   `plugins/platforms/email/adapter.py`, `agent/redact_connstr.py`,
   `hermes_cli/_subprocess_compat.py`, `tools/tool_result_storage.py`,
   `agent/tool_guardrails.py`. All upstream text was treated as untrusted data
   (saved to scratch, parsed with `python3 -I`).
2. Every candidate was checked against our code (`file:line` below) and 30 days of
   production data, read-only. Exact queries:
   - `sqlite3 -readonly data/mc.db "select agent_type,status,count(*) from tasks where created_at>=datetime('now','-30 days') group by 1,2"`
     → 1,757 tasks: `fast` 1,185 completed / 478 completed_with_concerns / 8 cancelled /
     2 needs_context / 1 failed; `heavy` 65 / 9; `swarm` 8 / 1 failed; 0 nanoclaw, 0 a2a.
   - `select name,count(*) from task_trace_events group by 1` → 8,280 `tool.called`,
     12 `task.failed`, 6 `confirmation.expired` (10-09 → 11-09).
   - `select max(c) from (select task_id,count(*) c from task_trace_events where name='tool.called' group by task_id)`
     → 60 calls max per task, mean 5.9; 56 (task, tool) pairs with ≥ 10 calls of one tool.
   - `select coalesce(decision,'(null)'),count(*) from tool_approvals group by 1`
     → 100 rows since 09-30: 83 confirmed, 9 expired, 8 superseded.
   - `schedule_runs` / `ritual_deliveries` per schedule, distinct `date(spawned_at)` in 30 d.
   - `jme_turns` by channel/role, 30 d; `user_facts` count of credential-named keys;
     `tasks.output GLOB` key shapes (counts only, no text selected).
   - Journal (retention starts 10-10 07:18 UTC): `journalctl -u mission-control --since '-30 days' -o cat | grep -c <pattern>`,
     masked shapes only. 89 boots; 89 × "Telegram channel active"; 1,739 × "Claude SDK path";
     0 "Query timed out"; 0 `error_max_turns`.
3. Verdict per candidate: SHIP NOW / SHIP LATER (trigger) / DEFER (trigger) / NO.
   Eval gate = the paid gate, required when a port changes a system prompt, a tool
   description, a model id or a classifier.

## Port candidates, ranked

### 1. Evicted tool results point the model at a path the read guard refuses — Hermes #139894

- **Upstream** (v0.23.0, PR #139894, `tools/tool_result_storage.py`): "`read_file` on a
  pruned archive path returns `expired: true`"; the notice "no longer tells the model to
  re-run the producing tool, since that tool may be a mutation". Source: `def expired_archive_fields(path)` (`tool_result_storage.py:80`).
- **Protects against**: a spilled result the model cannot read back, so it re-fetches or
  improvises.
- **Our state**: `src/lib/eviction.ts:18` writes to `data/tool-results/`; `:69` tells the
  model `Use file_read(path="…")`. `src/tools/builtin/immutable-core.ts:136` read-blocks
  `/root/claude/mission-control/data/` with no exception, so that `file_read` is refused.
  Callers: `web-read.ts:184,368,501`, `expand-read.ts:247`, `jina-search.ts:254`
  (30 d: 416 `web_read`, 78 `expand_read`, 7 `jina_search` calls). Production: the model
  works around it through `shell_exec` — **15** shell-guard-OK commands read
  `data/tool-results/` (10-10 → 10-21: `cat`, `sed -n`, `grep`, `tail -c`). This is the
  10-01 deferred trigger "next eviction or web-read session": **fired**.
- **Port** (S): move `EVICT_DIR` out of the read-blocked tree (e.g. a dedicated
  `/var/lib/mission-control/tool-results/` or a `data/tool-results/` carve-out in
  `READ_BLOCKED_PATHS` that resolves the kernel path and refuses symlinks), add a
  retention sweep plus an "expired" answer for a pruned path. Files: `lib/eviction.ts`,
  `tools/builtin/immutable-core.ts`, tests beside both. Eval gate: **no** (tool-output
  text and a guard path, no prompt/description/model/classifier). Risk: a carve-out in
  the read guard is a security edit — needs the kernel-resolved-path test and qa-auditor.
- **Recommendation: SHIP NOW.**
- **Status: RULED ship-now 2026-11-09 (new folder); BUILT `9489ab3e` 17:5x UTC — `/root/claude/mission-control/tool-results/` (root-only; the first choice `/var/tmp/…` failed qa R1: world-writable parent), `file_read` expired answer; deploy + proof pending, tracked in queue 4cd.**

### 2. Redaction misses connection strings, URL userinfo, private keys — Hermes #149435 / #148862 / #149470

- **Upstream** (v0.23.0, PRs #149435, #148862, #149470; `agent/redact.py`, new
  `agent/redact_connstr.py`, 147 lines): masks `Password=` / `Pwd={…}` connection
  strings, `PGPASSWORD`, `MYSQL_PWD`, `SSHPASS`, `redis://:pw@`, `--token X` (space form),
  `docker login -p`, Azure `AccountKey=`, non-PEM / base64-PEM private keys, SMB
  `//user:pass@host`; #149470 also stops mangling JSON-LD.
- **Protects against**: a credential surviving into persisted text or a model-visible
  tool result.
- **Our state**: `src/api/mcp-server/redact.ts` — `SECRET_NAME_RE` `:31`,
  `redactSecretAssignments` `:48-63` (value = `\S*`), rules `:66-105`
  (Authorization, `sk-`/`pk-`/`xoxb-`/`ghp_`/`gho_`/`glpat-`/`jrvs_`, `AIza`, Telegram
  bot token, JSON secret fields, hex blob); shell output reaches the model through
  `redactCredentials(scrubSecrets(…))` (`shell.ts:3185,3199,3236`). By reading (not
  executed): covered — `PGPASSWORD`, `Password=`, `--password=`; **not covered** —
  URL userinfo (`postgres://u:pw@`, `redis://:pw@`), `MYSQL_PWD`/`SSHPASS`/`Pwd=`
  (no name-suffix match), `--token X`, `docker login -p X`, PEM blocks, quoted values
  with spaces (`PASSWORD="a b"` keeps `b"`), AWS `AKIA…`, bare JWTs. Production: 0 task
  outputs in 30 d match a key shape (`sk-ant-`, `sk-`+20, `ghp_`+20, `AIza`+35) and 0
  match `postgres*://*:*@*`; `shell_exec` runs `docker exec supabase-db psql` (1 masked
  journal shape), so the connection-string class is reachable.
- **Port** (S–M): add URL-userinfo, PEM, `PWD`/`PASS` names, `--token`/`-p` space
  forms and quoted values to `redact.ts`, with a JSON-LD negative test. Files:
  `api/mcp-server/redact.ts` + test. Eval gate: **no**. Risk: over-redaction of
  legitimate output (URLs with `@`, `-p` port flags) — needs a corpus replay of 30 d of
  shell outputs counting changed rows before ship.
- **Recommendation: SHIP LATER** — trigger: next touch of `redact.ts`, or the first
  connection string seen in a persisted column; bundle with item 1 if convenient.

### 3. Email `From:` resolves to the first `<…>`, so a display name can impersonate — Hermes #125212

- **Upstream** (v0.22.x, PR #125212 merged 09-27, sha `6f7a7991`;
  `plugins/platforms/email/adapter.py:288`): "Bare lowercased addr-spec from a From:
  value. Uses parseaddr, not a first-<...> regex (GHSA-rxqh-5572-8m77)". PR body: "On
  `main`, `From: "Victim <victim@example.com>" <attacker@evil.test>` resolved to the
  victim (the first `<...>` wins)". A From with a second address resolves to `""`; > 2048
  chars or > 64 `(` is dropped. The salvaged PR #124322: "On the default restricted path
  this is a full identity bypass".
- **Protects against**: a stranger's mail being treated as the owner's (owner-only
  mode) or written into another sender's thread (community-manager mode).
- **Our state**: same bug. `src/messaging/email-mime.ts:52-56` `extractAddress` takes
  `headerValue.match(/<([^>]+)>/)` (first angle bracket); `:242` decodes RFC 2047
  **before** it, so an encoded display name can carry `<owner@…>` too.
  `channels/email.ts:596-605` searches `UNSEEN FROM <owner>` (substring), `:662-667`
  is the only owner check (`mail.from !== ownerAddress`), `:681-688` and
  `router.ts:1044-1063` key community-manager threads by `from`. No
  Authentication-Results/DMARC handling anywhere in `src` (grep 0). Production: the
  email channel is **dormant** — `EMAIL_ENABLED` is not in the live process env, and
  the journal has 0 `[email:` lines and 0 "Channel active" in 30 d (Telegram is the
  only channel, 89/89 boots).
- **Port** (S): RFC 5322 mailbox parse — last angle-addr outside quotes/comments, drop
  multi-address and oversize/over-nested values, parse after unfolding and before RFC
  2047 decode of the display name. Files: `messaging/email-mime.ts` + test. Eval gate:
  **no**. DMARC alignment from Authentication-Results is a separate M, deferred.
- **Recommendation: SHIP LATER** — trigger: before any `EMAIL_ENABLED=true`. It is a
  pre-arm blocker: the channel must not be armed with this parser.

### 4. Untrusted repo `.git/config` can run commands through git — Hermes #130661

- **Upstream** (v0.22.0, PR #130661 merged 10-01; `hermes_cli/_subprocess_compat.py:289-296`):
  "Opening an untrusted repository no longer lets its `.git/config` filters, hooks or
  fsmonitor run commands"; overrides `"core.fsmonitor": "false"`,
  `"core.hooksPath": os.devnull`, `core.pager`, `diff.external`, and refuses on
  `includeIf.*.path`.
- **Protects against**: a planted `.git/config` (archive with a `.git` dir, a repo
  someone else wrote) turning `git status` into code execution.
- **Our state**: `src/tools/builtin/git.ts:195-213` `runArgs` → `execFileAsync` with
  `buildChildEnv()` (allow-listed env, `mcp/env-deny.ts:89`); no `core.fsmonitor` /
  `core.hooksPath` / `filter.*` overrides (grep 0). git runs in repos under
  `/root/claude/` (`git.ts:318,572,588,620,657`; `jarvis-dev.ts:297-299,408,423,443-445,920-921`)
  and `nanoclaw-worker.ts:65` clones (a clone does not copy config or hooks).
  Production 30 d: `git_push` 13, `git_commit` 12, `jarvis_dev` 13, `git_status` 3,
  `git_diff` 2, `gh_repo_create` 1. All in repos Jarvis or the operator created.
- **Port** (S): add `-c core.fsmonitor=false -c diff.external= -c core.pager=cat` to
  read-only verbs, `-c core.hooksPath=/dev/null` only outside `mission-control` (its
  pre-commit gate must keep running). Files: `git.ts`, `jarvis-dev.ts`. Eval gate:
  **no**. Risk: breaking a repo that relies on a filter (LFS) — read-only verbs only.
- **Recommendation: SHIP LATER** — trigger: the first Jarvis git call in a repo it did
  not create or clone (extracted archive, operator-provided tree).

### 5. Identical-call loop halt — Hermes #100967

- **Upstream** (v0.22.0, PR #100967 merged 09-02; `agent/tool_guardrails.py:39`
  `STALL_GUARD_IDENTICAL_CALL_THRESHOLD = 3`): "an identical call replayed with an
  identical result is halted for **any** tool — so a model that ignores loop warnings
  is stopped after 5 repeats".
- **Protects against**: token burn on an unattended loop.
- **Our state**: no identical-call detector; the SDK path caps rounds
  (`fast-runner.ts:1380-1389` `maxRounds`, `:1601` `maxTurns`) and wall clock
  (`claude-sdk.ts:1188` `SDK_TIMEOUT_MS = 15 min`). Production 30 d: 0 `error_max_turns`,
  0 SDK timeouts; max 60 tool calls in one task, max 34 of one tool (`file_edit`); args
  are not in the trace columns, so identical-call repeats cannot be counted without
  reading `attrs` (not done).
- **Port** (M): a PreToolUse-side hash of (tool, args) per task with a stop after N.
  Eval gate: **yes** if it injects a warning into the conversation; no if it only
  terminates. Risk: legitimate polling tools.
- **Recommendation: DEFER** — trigger: the first `error_max_turns` or SDK timeout on a
  non-`/loop` task, or a task with > 20 calls of one tool.

### 6. Turn-liveness watchdog keyed on activity, not wall clock — Hermes #99758 (+ #142905)

- **Upstream** (v0.22.0, PR #99758; `agent/turn_liveness.py`): keys "off the agent's
  activity clock (stamped by API waits, stream tokens, tool heartbeats — never by lease
  renewal)", default 600 s. #142905 (v0.22.4): "Healthy long answers … no longer get
  cancelled by the stall timer".
- **Our state**: a fixed 15-min wall clock (`claude-sdk.ts:1188`), none on `/loop`.
  0 timeouts in 30 d. This is the 09-01 deferred "TTFB watchdog".
- **Recommendation: DEFER** (S–M, eval gate no) — trigger unchanged from 09-01: first
  hung SDK query (a timeout line, or a task `running` > 15 min).

### 7. Fallback credential sent to a foreign host — Hermes #120299

- **Upstream** (v0.22.0, PR #120299 merged 09-23): "Hermes no longer hands a native
  Anthropic credential to a non-Anthropic host during a client refresh".
- **Our state**: `src/inference/vision.ts:74-77` falls back
  `INFERENCE_VISION_URL ?? inferencePrimaryUrl` and
  `INFERENCE_VISION_KEY ?? inferencePrimaryKey` **independently**: setting only the URL
  sends the primary key to the vision host. Live env has both `INFERENCE_VISION_URL` and
  `INFERENCE_VISION_KEY` set (names only), so no leak today. `adapter-openai.ts:317,327`
  keep fallback/tertiary keys paired (`?? ""`).
- **Port** (S): pair them — vision uses its own key only with its own URL, else both
  primary. File: `inference/vision.ts`. Eval gate: **no**.
- **Recommendation: SHIP LATER** — trigger: next edit of `vision.ts` or any vision env
  change; it is a two-line fix worth bundling with item 1.

### 8. Stale approval card answers the next request — Hermes #87554

- **Upstream** (v0.23.0, PR #87554 merged 11-05): "a press on a card whose request has
  already settled reports "expired" and resolves nothing". Button cards only.
- **Our state**: no buttons (grep `callback_data`/`inline_keyboard` 0); a typed "sí"
  binds to the thread's current card; a new card marks the old rows `superseded`
  (`confirmations.ts:548`). Production: 8 superseded cards; the next card in the same
  thread was confirmed within 15 s in 5 cases, 3 of them with different args; in 2 of
  those the old card was 71 min and 2.4 h old (the "sí" read the new card); **1
  ambiguous** case (old card 118 s earlier, new args, confirmed 10.1 s after).
- **Recommendation: DEFER** — fold into the open 10-01 operator ruling "late sí after
  approval expiry"; trigger: a second ambiguous supersede-then-confirm.

### Everything else read

| Upstream (tag, PR) | Our state | Verdict |
| --- | --- | --- |
| Pipe-to-shell detection: zsh/ksh/dash (v0.22.0 #116726), `sudo bash`, `/bin/sh`, `env` (v0.23.0 #87362), rule hiding a credential upload (#141377) | No remote-content-to-shell rule; shell gate guards protected paths/verbs (`shell.ts:491` `CMD_POSITION`, `:894` `SHELL_BINARIES`). 0 of 1,473 shell-guard-OK commands in 30 d were `curl/wget … | sh` | DEFER — first such command |
| Cron fire time in every scheduled prompt (v0.23.0 #82826), manual run is an extra fire (#146113) | Present: `rituals/dynamic.ts:481-499` `buildDateContext` puts `[Hoy: <date> (<day>), HH:MM CDMX]` + a manual-run note | Present (closes the 09-01 temporal-anchoring deferral for schedules) |
| Fires that never reached the model re-run after 5/15/30 min (#108731); missed-run policy (#144801) | `lib/cron.ts:31` 60 s tolerance, missed = `schedule.run_failed`, no catch-up. 30 d: every active daily schedule 30/30 days, weekday 20/20; 141/141 `schedule_runs` completed; 4 node-cron "missed execution" warnings, none cost a day | DEFER — first schedule day with no run |
| Kanban worker turns no longer reach memory as the operator's (v0.23.0 #144861) | Present: `memory/background-extractor.ts:43-63` skips ritual/proactive/`user-background`; `jme_turns` written only by `router.ts:4387,4393` (30 d: 32 rows, all telegram) | Present |
| Keep adapter secrets out of agent children (#125755) | Present: `buildChildEnv` allow-list (`mcp/env-deny.ts:89`); shell uses `buildScrubbedEnv` (`shell.ts:3176`) | Present |
| Unset `${VAR}` not passed literally to stdio MCP (#141379) | Present: `mcp/manager.ts:92-99` omits a name with no value | Present |
| Blank signing secrets refused (#133257) | No inbound HMAC webhooks; API key compare `api/auth.ts:10-21` (an empty configured key would 403 every non-empty header; empty header = 401) | N/A |
| URL authority parse differential (v0.23.0 #145578) | `lib/url-safety.ts:89,198,213` uses WHATWG `new URL`, same parser as undici/Playwright, plus connect-time IP check | Present (structural) |
| A2A no-token mode refuses foreign Origin/Host (#145310) | A2A always key-authed: `api/index.ts:53` | N/A |
| Gateway pid recycled (#139855, #138594) | Boot guard is an abstract unix socket (10-01 item 1) | Present |
| Dead stdio MCP respawn without replay (#106546) | Present since 10-01 | Present |
| Spilled-result `read_file` masks creds in secret-bearing files (#111422) | Read guard refuses those files outright (`immutable-core.ts:111+`) | Present (stricter) |
| Compaction keeps `UNVERIFIED:` lines (v0.23.0 #86019); refusal not committed as summary (#118920); prepared compaction (#144684) | SDK path compacts inside the SDK; Prometheus compressor runs only on the OpenAI path (0 runs: 1,739 "Claude SDK path", 0 OpenAI-path lines) | NO (cold path); a compaction-prompt change would need the eval gate |
| Cron fires share one prompt-cache scope (#139876); one-shot calls skip cache write (#140478) | SDK prompt cache is prefix-based, no cache key; aux one-shot cost not measured this review | N/A / not measured |
| Lock a skill (#147557) | Skills/directives are managed files; KB `directives/` never synced from disk | N/A |
| Spend limits on paid MCP tools (v0.23.0 #142470) | Hard cap CLOSED by operator ruling | NO |
| Approval prompts that wait until answered — **reverted** in v0.22.0 (#130167) | We keep a TTL | Nothing to port |

## Re-check of the 10-01 deferred items

| 10-01 deferred item | Trigger fired? | Evidence |
| --- | --- | --- |
| Late "sí" after approval expiry (ruling) | Not provable | 9 of 100 `tool_approvals` expired (was 2 of 4); 6 `confirmation.expired`, 5 `partial_reply_refused` traces; see item 8 |
| `schedule_task` ungated (ruling) | No new evidence | 5 `schedule_task` approval rows since 09-30 (it has an approval path) |
| User-facts credential injection (ruling) | Open | 15 credential-named `user_facts` keys (was 16) |
| `jarvis_test_run` / `vps_deploy` full suite (ruling) | No | 0 "test run already in progress" |
| `docker exec/cp/run -v` (ruling) | Still reachable | 1 masked `docker exec supabase-db psql` shape in 30 d |
| `jarvis_dev action=pr` outside the lock (ruling) | Not measured | 13 `jarvis_dev` calls, actions not in trace columns |
| `execGroupKill` settles on close | No | 0 "test run already in progress" |
| Output > 1 MB keeps the head | No | 0 truncation/maxBuffer lines |
| `lib/eviction.ts` points at a read-blocked path | **Yes** | 15 shell reads of `data/tool-results/` → item 1 |
| Bare `/root/.claude` listable | No | 1 shell-guard BLOCKED on a `/root/.claude/projects/…/tool-results/` path (guard held) |
| `tasks.output` raw | No | 0 key-shaped strings in 30 d (15 rows contain "AIza", none followed by 35 key chars) |
| Cut-before-redact sites | No | 0 key-shaped strings in persisted output |
| Redaction of descriptions/conversations (ruling) | Open | — |
| Text-egress filter misses `file_read` | Not measurable | needs delivered-text read (not done) |
| OpenAI-path auth-retry twin | No | 0 OpenAI-path lines; 1,739 SDK path |
| `sdkAuthFailed` false positive | No | 0 auth-retry lines |
| Read-only-hinted tools that write | Not run | needs the next tool audit |
| Reaped schedule run in the boot window | No | 0 "reap" / "router not up" lines |
| mc.db copies in `/tmp` from validation scripts | No | 0 matching paths |
| Boot guard per netns / symlink key | No | no containerised mission-control |
| Shell gate `..` / brace / relative `.env`; validator CPU at the cap | No | 0 event-loop stall lines (2 matches are migration text) |
| Structural closer (ruling) | Open | — |

09-01 deferrals that upstream re-touched: TTFB watchdog ↔ #99758/#142905 (item 6, still
0 timeouts); temporal anchoring ↔ #82826 (present for schedules); live subagent
orchestration ↔ v0.22.0 "one gateway owns every session" (no consumer here; swarm 9 tasks
in 30 d).

## Confirmed already present

- Scheduled-prompt clock + manual-run note — `src/rituals/dynamic.ts:481-499`.
- Background workers kept out of memory — `src/memory/background-extractor.ts:43-63`;
  `jme_turns` writers `src/messaging/router.ts:4387,4393`; `scrubSecrets` on write
  `src/memory/jme.ts:156`.
- Child env allow-list — `src/mcp/env-deny.ts:89-99`; shell scrubbed env `src/tools/builtin/shell.ts:3176`.
- MCP env omission — `src/mcp/manager.ts:92-99`.
- WHATWG URL + connect-time guard — `src/lib/url-safety.ts:89,198,213,628,668`.
- A2A + API key auth — `src/api/index.ts:53,91`; `src/api/auth.ts:10-38`.
- Fallback/tertiary key pairing — `src/inference/adapter-openai.ts:317,327`.
- Approval supersede/expiry state machine — `src/messaging/confirmations.ts:318,358,548,671`.

## N/A / Tier 3

Most of both minors is surface we do not run: the unified gateway owner/worker receipt
refactor (v0.22.1 is almost entirely this), Desktop and dashboard, `hermes curator`,
kanban boards, the messaging adapters (Telegram, Slack, Feishu, Matrix, WhatsApp Cloud,
Teams, QQ, LINE, Weixin, relay), provider catalog and OAuth flows, TTS, Docker images,
profiles, backup/import. Not verified this round: v0.22.0 "owner-only files at rest"
(#109509) — permission modes on `data/` were not checked (the `stat` touched `.env` and
was refused); the item belongs to the next host-hardening pass.

## After v0.23.0 (`main`, 11-05 21:32 → 11-09 06:46 UTC)

At least 300 commits in 3.5 days (the API pages were still full at page 3).
Of the first 200: 163 `fix`, 26 `test`, 5 `refactor`; scopes `telegram` 121, `gateway` 52,
then single digits. The theme is approval cards across adapters — binding a tap to the
request it was rendered for, "Deny-only" cards when a command is clipped, fencing long
commands, and "opt-in `approvals.approvers` binds shared-chat exec approvals to the
requester". It continues #87554. Nothing new for us beyond item 8: we have one approver
and no buttons. Watch for a v0.23.x note on `agent/redact.py` or `tool_guardrails.py`.

## Cadence

Next review **2026-12-01** (the same day as the MCP v2 and A2A re-checks). Pull it
earlier if: a v0.23.x patch touches `agent/redact*.py`, `tools/approval*.py`,
`plugins/platforms/email/` or `_subprocess_compat.py`; a GHSA is published on the repo;
or `EMAIL_ENABLED` is about to be set (item 3 has to land first).
