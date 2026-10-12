# S6 step 2: the project contract (read-only spec, 2026-10-11)

This spec answers queue §2026-10-09 (late) S6 item 3, as the operator reframed it on 2026-10-11: how does Jarvis keep a good record of another operator's projects? Rulings so far: 1 (the profile is a KB file), 2 (Spanish is the default, English on command), 3a (a project enters Jarvis only through its record) and 3b (capabilities come MCP-first). Points 3c and 3d are proposed below for the operator to confirm. The repo is public, so identity literals appear by class only, and private projects use the inventory's placeholders (`<community org>`, `<X handle>`, `<operator business>`).

Sources: source code at the working tree on 2026-10-11; `mcp-servers.json` (key names only); `mc.db` through `sqlite3 -readonly /root/claude/mission-control/data/mc.db` (aggregates, ids, slugs and key names only); KB `projects/` (names and counts only). Not read: `.env*`, `data/predeploy/`, KB file content, any row content.

**Tripwires at start:** `stat -c '%Y %s' /root/claude/jarvis-kb/directives/core.md` = `1791309381 3739`; `ls /root/claude/jarvis-kb/logs/day-logs | wc -l` = `191`. The +1 over 190 is the date-named `2026-10-10.md`, created 2026-10-10 06:14 UTC.

**Corrections to the brief's figures (measured 2026-10-11 08:3x UTC):** `projects` has **56** rows, not 60 (43 active / 10 archived / 2 paused / 1 completed); tasks in the last 30 d: **1,783** (rolling); the 110 inventory-regex lines are **comment** lines, not model-facing text (§5 counts the model-facing ones); `tool.called` traces start **2026-09-10**, so every "90 d" tool count covers about 31 d.

## 1. Verdict

1. **Contract:** a project is one KB record, `projects/<slug>/project.md` (a leading fenced JSON contract, then free notes), projected into its `projects` row (the SQL surface). Routing cues, repo write access inside `profile.workspaceRoot`, its capability (its own MCP server, else generic tools scoped to its repos), schedules, success signal and stall exemption all derive from the record.
2. Every task carries the slug it was attributed to, so `mc-ctl project <slug>` shows the project's record.
3. **What the first operator's 7 code-wired families need it to express:**
4. (a) aliases with precedence (vlcms is not vlmp; a bare "williams" means the Entry radar); (b) repo paths incl. a default repo (`git.ts:15`);
5. (c) a per-project MCP server (none today — xpoz is a SERVICE, not a project, RULED 2026-10-11; DENUE and CRM are candidates); (d) secret NAMES, and deny-paths that only narrow (Pulso WhatsApp store);
6. (e) a capability brief shown when the project is in context (DENUE guard, 12 prompt lines); (f) schedules (Entry radar, X accounts);
7. (g) an inbound caller identity (Pulso calls `/api/jarvis-pull`).
8. **Smallest end-to-end build (WS1, M):** the Entry radar's record (`williams-entry-radar`; its chat README stays where it is via `kb_readme`) is the first `project.md`.
9. A projector upserts its row from it; its weekly schedule is bound by the schedule ids the record lists.
10. `mc-ctl project williams-entry-radar` reports that project's runs, tasks, gates, cost, last day-log mention and stall state.
11. No schema change, no prompt-text change, no MCP work. Proof = the next weekly run (5 runs in the last 30 d).

## 2. The project record

**Where it lives.** One file per project: `projects/<slug>/project.md`. The folder name is the slug. The file opens with a fenced `json` block (the contract) followed by free notes. JSON plus zod adds no dependency. The skills frontmatter parser (`src/skills/frontmatter.ts`) is a strict YAML subset that can only express nested `repos` or `mcp` as `*_json` strings, so it is not reused here.

**Authority: the KB record → the DB row.** Ruling 1 put the profile in the KB, so one store gives a second operator one onboarding artifact to write by hand; the reindex walk already brings disk edits into `jarvis_files` (`src/db/jarvis-reindex.ts`); the row is a projection kept for joins (detectors, the report, the dispatcher).

**When the projector runs:** on `upsertFile` of `projects/*/project.md`, at boot, and on the hourly walk's refresh. It overwrites the row's contract columns; `id`, `credentials` and `commit_goal_id` stay DB-owned. `credentials` holds secret material (7 rows, 24 key names) and never enters the KB. `commit_goal_id` (10 rows) belongs to the retired COMMIT link and is left alone.

**Write paths.** The contract decides what code runs at boot (MCP commands, repo write access), so the model-facing file tools refuse `projects/*/project.md`, the way `standingOrdersGuard` (`immutable-core.ts:566`) refuses `directives/`. `project_update` (14 calls in the window) keeps its whole surface (`name`, `description`, `status`, `urls`, `credentials`, `config`, `commit_goal_id`; `tools/builtin/projects.ts:379-386`). It writes the record's JSON block, and the projector then updates the row; `credentials` and `commit_goal_id` go straight to the row, as today. The only refused input is a `config` key named `mcp`, `trusted`, `egress` or `deny_paths` (no row uses one today, so nothing is lost). Those fields change through an operator upsert, or through the proposal tools: `jarvis-directives.ts:127,296` already accept any `target_path`, but routing project records through them, and gating the apply step on the operator, is new wiring.

**Unmatched rows and folders.** 45 slugs have both; 11 rows have no folder (3 active); 20 folders have no row. A folder is not a project (no row is created from a folder alone); the 11 legacy rows keep working until their record is written.

```bash
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT status, COUNT(*) FROM projects GROUP BY status LIMIT 10"   # 43/10/2/1 = 56
ls /root/claude/jarvis-kb/projects | wc -l                                                                                     # 65 (53 with README.md, 0 project.md)
comm -12 <(sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT slug FROM projects ORDER BY slug LIMIT 100") <(ls /root/claude/jarvis-kb/projects | sort) | wc -l   # 45 (-23 → 11, -13 → 20)
```

**Fields of the contract** (R = required, O = optional). Every consumer listed exists today unless marked NEW.

| Field | Type | | Consumer (file:line) |
| --- | --- | --- | --- |
| `slug` | `^[a-z0-9][a-z0-9-]{1,62}$`, equal to the folder name | R | `stalled-projects.ts:139`, `src/dispatch/dispatcher.ts:443`, `entity-extractor.ts:99`, `v8-2/decompose.ts:441`, `briefing/construct.ts:128`, `db/projects.ts:369` (`formatProjectsBlock`, chat prompt) |
| `name` | string | R | the same sites |
| `status` | `active·paused·completed·archived` | R | `stalled-projects.ts:139`, `src/dispatch/dispatcher.ts:445`, `cohort/self-defining.ts:120`; NEW: decides whether its MCP servers load (§3) |
| `aliases` | string[] | O | `src/dispatch/dispatcher.ts:464` (foreign-project guard), `entity-extractor.ts:100`; NEW: `stalled-projects.ts:84` `matchTermsFor` (today reads only slug and name, although its header says to add aliases to `config`), `kb-injection.ts:111` |
| `match_priority` | int, default 0, higher checked first | O | replaces the vlcms-before-vlmp special case at `kb-injection.ts:112-117` |
| `stall_exempt` | bool | O | `stalled-projects.ts:108,166` |
| `kb_readme` | KB path, default `<kb_folder>/README.md` | O | `kb-injection.ts:153` (README injected into chat); keeps a project whose chat README lives in another folder at zero loss (§5, Entry radar) |
| `trusted` | bool, default `false` unless written by the first operator | O | NEW: the MCP loader (§3 security boundary) |
| `egress` | host[] | O | NEW: the sandboxed MCP transport (WS7) |
| `parent` | slug | O | report rollup (from `config.parent_project` ×4, `parent` ×1) |
| `kb_folder` | KB path, default `projects/<slug>/` | O | `kb-injection.ts:153` (README injection), `rituals/morning.ts:103`, `jarvis-files.ts:282,290` |
| `repos` | `[{path, role: primary·other}]`; `realpath` must sit under `profile.workspaceRoot`; model-writable through `project_update` and the schema accepts `..` segments: realpath ⊂ workspaceRoot, never trusted as written (R1 W4) | O | the 6 write allow-list sites (`git.ts:33`, `shell.ts:549`, `file.ts:52`, `file.ts:561`, `runners/container.ts:49`, `write-guard.ts:16`), `git.ts:15` `DEFAULT_CWD`, `tools/builtin/projects.ts:219` |
| `deny_paths` | path[], narrow only | O | `shell.ts:434,450`, `immutable-core.ts:146,148` |
| `secrets` | `SECRET_*` names that point into the row's `credentials` | O | `lib/secret-refs.ts:104` (`projectIdentity`); NEW: MCP env (§3) |
| `capabilities.mcp[]` | §3 | O | `mcp/config.ts:15`, `mcp/manager.ts:107,178`, `rule-of-two.ts:296,312`, `mcp/annotations.ts`, `scope.ts`, `scope-classifier.ts:35,115` |
| `capabilities.brief` | heading of a section in the notes | O | NEW: replaces the DENUE guard at `runners/fast-runner.ts:1178-1311` (model-facing) |
| `routing.summary` | one line | O | NEW: classifier group line (`scope-classifier.ts:115`; model-facing) |
| `schedules` | `schedule_id`[] | O | NEW: projected to `scheduled_tasks.project_slug` (§4); `rituals/dynamic.ts:143` |
| `inbound` | `{route, token_secret}` (a NAME only) | O | `api/routes/jarvis-pull.ts:139`; the `hasCrm` gates at `messaging/router.ts:701,714,2643,4285` and `tools/sources/builtin.ts:426` |
| `success` | `{daylog: true, gates: bool}` | O | `stalled-projects.ts`, the report (§4) |
| `links.site` | string | O | `db/projects.ts:349` (`findProjectBySiteUrl`), `:376` |
| description | first paragraph of the notes | O | `briefing/construct.ts:128` (300 chars), `db/projects.ts:381` (100 chars) |

**Today's free-form `config` keys** (167 distinct names in 27 rows; no name used by more than 4 rows). Each key class is mapped or moved; none is dropped silently.

| Class | Keys | Goes to |
| --- | --- | --- |
| aliases (1) | `aliases` | `aliases` |
| stall (1) | `stall_exempt` | `stall_exempt` |
| parent / related (4) | `parent_project`, `parent`, `connected_projects`, `dependency` | `parent`; the other two go to the notes |
| repos (10) | `repo`, `repo_github`, `local_path`, `journal_repo`, `radar_repo`, `parent_repo`, `remote`, `backend_path`, `frontend_path`, `sessions_dir` | `repos[]` (plus `urls.repo*`/`local`: 22 rows) |
| KB (1) | `kb_path` | `kb_folder` |
| schedules (11) | `schedule_id`, `schedule_cron`, `schedule_nombre`, `schedule_time`, `schedule_hora_cdmx`, `cron`, `publish_schedule`, `publish_time_mx`, `cadence`, `cadencia`, `delivery` | `schedules[]` by id; cron and time stay on `scheduled_tasks` |
| runtime (10) | `service`, `systemd_unit`, `port`, `api_port`, `ctl`, `runtime`, `db`, `db_path`, `env_file`, `stack` | notes section "Runtime". `env_file` is never a read grant |
| locale (4) | `timezone`, `language`, `idioma`, `idiomas` | notes. Locale belongs to the operator profile (ruling 2) |
| status text (7) | `phase`, `fase`, `stage`, `status_note`, `priority`, `v8_status`, `estado_actual` | notes |
| content (118) | for example `audience`, `tone`/`tono`, `pillars`/`pilares`, `competitors`, `target_user`, `tickers`, `domain*` | notes section "Legacy config", copied verbatim by the operator-run migration |

`urls` (29 non-empty rows, 33 key names): `site` → `links.site`; `repo*`/`local`/`path` → `repos[]`; the rest go to the notes.

```bash
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT COUNT(DISTINCT j.key) FROM projects p, json_each(p.config) j WHERE json_valid(p.config) LIMIT 1"   # 167
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT COUNT(*) FROM projects WHERE json_valid(config) AND config<>'{}' LIMIT 1"   # 27
```

## 3. Capability via MCP

**Today's seam.** `McpServerConfig` (`src/mcp/types.ts`) has `command`, `args`, `env`, `enabled`, `lazy`, `tools`, `deferredTools`. It has no `cwd`, although the SDK's stdio parameters accept one. `mcp-servers.json` declares 4 servers:
- `browser`: no `env`
- `playwright`: lazy, 21 tool stubs
- `graphify-code`: no `env`
- `xpoz`: `env: {}`, with a sibling-repo path in its `args`

Tools are named `<serverId>__<tool>` (`MCP_NAMESPACE_SEP`). xpoz is an operator-wide SERVICE server (RULED 2026-10-11: not a project; it stays in `mcp-servers.json` with browser/playwright/graphify); wiring it took about 10 hand edits in 5 files — the count a record-driven loader removes for a PROJECT server: `scope.ts:439-444,1092,1564,1650`, `scope-classifier.ts:57,141`, `rule-of-two.ts:302,303,318`, `annotations.ts:115,164`, `mcp-servers.json`.

MCP traffic in the trace window: `browser__*` 100, `playwright__*` 37, one `mcp__jarvis__browser__markdown`; `graphify-code__*` and `xpoz__*` 0.

**Declaring a server in the record:**

```json
"capabilities": { "mcp": [ { "id": "acme-radar", "command": "node", "args": ["dist/mcp.js"], "repo": "primary", "cwd": ".",
  "env": ["ACME_API_TOKEN"], "trust": "AB", "tools": { "acme_trigger_run": { "trust": "B", "destructive": true } },
  "deferred": [] } ] }
```

Field rules:
- `id` defaults to the slug; every tool name, trace and Rule-of-Two row derives from it. Ids must be unique across records and `mcp-servers.json`; a duplicate is refused at boot with an alert.
- `cwd` resolves inside the named repo, and its `realpath` must start with that repo's path.
- `env` lists NAMES only. Each value is resolved from the project's `secrets` (the row's `credentials`, through `secret-refs.ts`) — record servers: secrets only; the service env never reaches a record child (audit R2 W2, orchestrator deviation from the original "else from the service environment", flagged to the operator). Service servers in `mcp-servers.json` get the same names-only rule under the service-hardening item (ruling 3).
- Operator-wide SERVICE servers (browser, playwright, graphify, xpoz) stay in `mcp-servers.json`; they are not project records.

**Loading.** `loadMcpConfig()` (`mcp/config.ts:15`) merges `mcp-servers.json` with the `mcp[]` entries of records whose `status` is `active`. Each spawn gets the SDK's default safe environment plus the declared names. It never gets `{...process.env, ...config.env}`, which `manager.ts:178-180` passes today whenever an `env` key exists. That means the `xpoz` child currently inherits every secret in the service env — a service-hardening fix at the manager, queued, independent of the contract.

**Scope, Rule-of-Two and hints, with no hand edits:**
- **Scope.** One scope group per project that declares `mcp[]` or `routing.summary` (not one per active row: 43 active rows would mean up to 43 new groups), named after its slug. It is added to `VALID_GROUPS` (`scope-classifier.ts:35`) at boot.
  - The regex fallback comes from `aliases` (the `scope.ts:1086-1093` pattern).
  - The group's tool list is every `<id>__*` tool (`scope.ts:1564`).
  - The classifier-prompt line comes from `routing.summary`. This is model-facing text, so it needs the eval gate.
  - The deferred-head rule still applies (CLAUDE.md §Infrastructure).
- **Rule-of-Two.** `trust` becomes a `RULE_OF_TWO_PREFIX_DEFAULTS` entry `<id>__` (`rule-of-two.ts:312`); per-tool `trust` becomes `RULE_OF_TWO_MCP_OVERRIDES` (`:296`). A server with no `trust` stays true/true, the file's existing "unknown = riskier" rule. The coverage test moves from reading `mcp-servers.json` ids to reading `mcp-servers.json` plus record ids.
- **Hints.** In order of preference:
  1. the `annotations` the server itself returns from `tools/list` (`bridge.ts:154` ignores them today and looks only at the name)
  2. the record's per-tool flags
  3. `getMcpToolHints`, which leaves an unknown tool conservative (destructive)

**Unloading a disabled or archived project's server.** At boot it is excluded, the same path as `enabled === false` (`manager.ts:117`). At runtime there is no unregister: neither the registry nor the manager has one, and a dead server's tools stay registered and fail fast (`manager.ts:195-203`). A status flip therefore makes the bridge refuse the call with `{error}` naming the project status. Full removal happens at the next restart. No new unregister API is proposed.

**Fallback for a project without a server:** `http_fetch` with `{{SECRET_X}}` substitution (`secret-refs.ts:35` `TEMPLATE_TOOLS`); `shell_exec`, `git_*` and the file tools with the working directory constrained to the record's `repos`. No generic SQL tool exists: the only `*query*` tools are `crm_query`, `intel_query` and `memory_kg_query`. SQL goes through `psql` in the repo's shell, or through the project's MCP server. None is proposed.

**Security boundary (stated explicitly).** `mission-control.service` runs as `User=root` (unit line 7), so a project MCP server is a root child process with the host's network. What does not cover it today:
- The write allow-list (6 sites) governs only Jarvis's own `file_*`, `shell_exec` and `git_*` tools. It has no say over what the server process writes.
- The package-manager shim covers only `shell_exec` and `task_gates.check_cmd` children (`shell.ts`, `lib/v8-4/gate-check.ts`). An MCP child can install or `npx` freely.
- The OpenSandbox egress allow-list covers only runner containers started through `spawnSandbox` (heavy, nanoclaw).
- Rule-of-Two judges the tool calls, not the process.

For the first operator this is unchanged trust: the operator wrote that code. Before any second operator's server is trusted, all of these must hold:
1. The capability fields are writable only through the operator path (§2).
2. The env carries declared names only.
3. The command and `cwd` resolve inside the project's repo.
4. The server runs either under the sandbox backend, with an egress allow-list taken from a record `egress` field, or as a non-root user. That needs new code: an MCP stdio transport over `SANDBOX_BACKEND`.
5. Unclassified tools stay at true/true.

Until point 4 exists, a record with `trusted: false` (the default for any record not written by the first operator) declares its server but the manager does not load it.

## 4. The per-project record (3c, proposed)

**Attribution rule** (priority top to bottom; the first match wins and is never overwritten):

| Source of the task | How the slug is set | Confidence | 30 d population |
| --- | --- | --- | --- |
| Schedule run (`rituals/dynamic.ts:143`; tag `schedule:<id>`, which `src/dispatch/dispatcher.ts:309-322` already resolves, including the parent chain) | `scheduled_tasks.project_slug`, projected from the record's `schedules` | exact | 130 runs; 131 tasks tagged |
| Sub-task or swarm child (`parent_task_id`) | inherits the parent's slug and source | exact (inherited) | 16 subtasks |
| Code ritual (`metadata.ritualId`) | a `project` field in the ritual's config; usually null (operator-level) | exact or null | 217 tasks |
| Inbound API call (`/api/jarvis-pull`) | the record whose `inbound.token_secret` matched | exact | n/a (no column to count) |
| Operator chat naming a project | `detectProjectInMessage` (`kb-injection.ts:111`) over record aliases; carried for the thread's next turns | high | 1,378 tasks carry `threadId` |
| Operator chat, no name | the project scope group the classifier chose (§3) | medium | (inside the 1,378) |
| Day-log slug | computed when the report runs, from the detector's term match; never written to `tasks` | low | per day, not per task |

**Data change (recommended): columns, not a link table.**
- `tasks.project_slug TEXT NULL` and `tasks.project_source TEXT NULL` (`schedule·parent·ritual·inbound·chat·thread·classifier`; `thread` = inherited from the thread's last explicit mention within 24 h, never from another inherited row), with an index on `(project_slug, created_at)`.
- `scheduled_tasks.project_slug TEXT NULL`.
- Set once, at the insert (`src/dispatch/dispatcher.ts:529`).
- Two entries in `SCHEMA_MIGRATIONS` (`db/index.ts:1178`), plus the schema-head pins in the SAME commit, or deploy aborts: `scripts/deploy.sh:40,55,57` hardcode `user_version=8` and `src/db/cost-ledger-basis-schema.test.ts:54,86,106` assert `toBe(8)`. An operator deploy.
- `cost_ledger`, `task_gates`, `schedule_runs` and `task_trace_events` already key on `task_id` and inherit the slug through a join.

Why not a link table: no source above produces a task that belongs to several projects. The readers that span projects (Morning Sync, nightly, evolution-log) are operator-level and stay null. A link table would add a second write path, plus deduplication, for no evidenced population.

**What can be attributed back, read-only (a view or a join when the report runs; no backfill writes):**
- **Yes:**
  - Schedule runs whose schedule still exists, through the record's schedule ids: 79 of 130 runs in 30 d.
  - Their sub-tasks, by inheritance.
  - Their gates and cost, through `task_id`.
  - The last day-log mention, through the detector.
- **No:**
  - 51 runs of 5 schedules that were deleted (their names are gone).
  - Chat tasks: only an operator-run one-off that applies `detectProjectInMessage` to stored titles could attribute them. That is a content read, outside this spec.
  - Rituals before a ritual→project map exists.

```bash
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT r.schedule_id IN (SELECT schedule_id FROM scheduled_tasks), COUNT(*), COUNT(DISTINCT r.schedule_id) FROM schedule_runs r WHERE r.spawned_at >= datetime('now','-30 days') GROUP BY 1 LIMIT 5"   # 0|51|5 · 1|79|9
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT j.key, COUNT(*) FROM tasks t, json_each(t.metadata) j WHERE t.created_at >= datetime('now','-30 days') AND json_valid(t.metadata) GROUP BY j.key ORDER BY 2 DESC LIMIT 30"   # tools 1774 · tags 1542 · threadId 1378 · ritualId 217 — no project key exists
```

By name, the 20 schedules are: personal 6 (5 active, 26 runs in 30 d); X accounts 5 (1 active, 7 runs); salones 3 (0 active); Jarvis itself 3 (1 active, 10 runs); Entry radar 1 (active, 5 runs); `<operator business>` 1 (active, 31 runs); PipeSong 1 (inactive).

**The report: `mc-ctl project <slug>`** (read-only, `sqlite3 -readonly`). This report IS the "good record". It shows:
- the record summary: status, repos, MCP ids, schedules
- tasks by status and by `project_source`, for 7 and 30 d
- schedule runs: count, last run, failed
- gates: met, failed, abandoned
- cost (quoted only after `mc-ctl audit-claim`, per CLAUDE.md)
- calls to the project's MCP server, by tool (trace column `tool`, prefix `<id>__`)
- last day-log mention and stall state (the `stalled-projects.ts` logic, now including aliases and `stall_exempt`)

The report names its censored window: traces begin 2026-09-10. 30 d totals for scale: gates met 826, failed 20, abandoned 18.

## 5. Migration of the code-wired projects

The inventory regex, re-run with `/usr/bin/grep`, gives 192 lines in 55 files: 110 comment lines and 82 code lines. Grouping by kind follows from the file: routing (`scope`, `scope-classifier`, `kb-injection`, `precedent`, `dispatch/classifier`, `stalled-projects`); prompt (`fast-runner`, `prompt-sections`, `rituals/`, `v8-2/critic`, `jarvis-pull`, `jarvis-self-repair`); path guard; default path (`git.ts`); tool code. The totals are: comment 110, routing 33, prompt 18, tool code 15, path guard 9, default path 5, false positive 2.

`-w` is NOT used for this pattern. It drops 35 lines, 33 of them real identifier hits such as `CRM_API_TOKEN`, `xpoz__…` and `mentionsDenue` (157 lines in 48 files with `-w`).

```bash
cd /root/claude/mission-control; S='--include=*.ts --exclude=*.test.ts --exclude-dir=test-utils'
O=$(/usr/bin/grep -oE 'e\.g\. "[a-z]+"' src/tools/builtin/x-post.ts | /usr/bin/grep -oE '[a-z]{6,}')
R="Pulso|agentic-crm|CRM_API|crm-azteca|crm\.db|denue|trustr|vlmp|cuatro-flor|williams-entry|williams[ _-]?radar|pipesong|xpoz|uncharted|salones|gilda|${O}|EurekaMS-Landing|vlcrm|very-light-cms|vlcms|promo-video|intelligence-ops"
/usr/bin/grep -rniE $S "$R" src | wc -l                                   # 192 (files: -l → 55; comments: | /usr/bin/grep -cE '^[^:]+:[0-9]+:\s*(\*|//|/\*)' → 110)
# family = first match in order: xpoz · denue|uncharted · pulso(word-start)|agentic-crm|CRM_API|crm-azteca|crm.db|vlcrm · williams · cuatro-flor · vlcms|very-light-cms · salones|gilda · vlmp · pipesong · $O · trustr · rest
/usr/bin/grep -rniE $S "$R" src | /usr/bin/grep -ciE 'xpoz'               # 29 (xpoz is first in the order, so this equals its family count)
```

**Zero-loss measure:** `tool.called` traces grouped by `tool`, 2026-09-10 → 2026-10-11 (7,596 calls, 113 tools, `attrs` NULL on every row). The arguments are not stored, so the share of a generic tool such as `shell_exec` or `git_commit` that served one project cannot be separated.

| Family (lines code/comment) | Kinds | The record carries | Becomes an MCP server (in the project's repo) | Generic tools | Prompt text that becomes record-derived (eval gate) | Residual | Zero-loss check (31 d) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DENUE + uncharted, 66 (20/46) | prompt 12, routing 4, path guard 4 | **Recommended: a NEW record for the DENUE analyzer** (no row, no folder today; repo, `secrets`, aliases, `capabilities.brief`), with `uncharted-lite` (active row, own folder, own repo) as its child. Reason: the guard's data, `.env` and SQL live in the analyzer repo (`fast-runner.ts:1212`), while `uncharted-lite` is a separate repo whose config already declares `parent_project`/`parent_repo` (values not read; the operator confirms the parent) | the API path (`fast-runner.ts:1208-1212`) → `denue__*` | `psql` through shell in its repo | guard `fast-runner.ts:1178-1311`; `scope-classifier.ts:155,162`; `dispatch/classifier.ts:32`; `jarvis-pull.ts:145` | the `.env` read exception (`shell.ts:521,534`, `immutable-core.ts:190,425`) until its server holds the key | `http_fetch` 35, `shell_exec` 1,012 (DENUE share not separable); `scope.ts:1298` cue |
| Pulso / CRM + vlcrm, 31 (17/14) | tool code 8, path guard 4, prompt 3, routing 2 | the Pulso row and folder; `inbound`, `secrets`, `deny_paths` — today: `crm_query` is a CORE tool (`crm-query.ts`), an exception to 3b (ruling 5) | — (`crm_query` stays core, ruling 5) | `hasCrm` ×5 → "has capability" | `signal-intelligence.ts:60`, `jarvis-self-repair.ts:83` | the inbound route `api/routes/jarvis-pull.ts` (the call runs in reverse) and the WhatsApp-store deny paths (`shell.ts:434,450`, `immutable-core.ts:146,148`): security, record may only add | `crm_query` 0; the jarvis-pull route; the `kb-injection.ts:126` cue |
| xpoz, 29 (18/11) | routing 13, tool code 5 | **SERVICE, not a project (RULED 2026-10-11)**: no record, stays in `mcp-servers.json` | n/a (service server) | — | `scope-classifier.ts:57,141` stay as service wiring | all 29 lines (service wiring is not project coupling) | `xpoz__*` 0 calls; nothing moves |
| Entry radar, 13 (3/10) | routing 3 | row `williams-entry-radar` (21 config keys) and folder `williams-entry-radar` (7 files) match; `williams-radar-journal` matches the archived row. But chat injection reads a SECOND, row-less folder: `kb-injection.ts:107` lists `williams-radar` (2 files) and `:132` sends a bare "williams" there, so the project has two live READMEs. The record sets `kb_readme: projects/williams-radar/README.md` to stay zero-loss until ruling 4 picks the canonical one (a default `kb_folder` would silently switch chat injection; `kb_folder=williams-radar` would orphan the row's own folder); aliases; 1 schedule | — | git and shell in its repos | `kb-injection.ts:107,132` → aliases + `kb_readme` | none | 5 schedule runs; the alias guard `src/dispatch/dispatcher.ts:458-470`; README injected on "williams" unchanged |
| cuatro-flor, 11 (9/2) | default path 5, path guard 1, prompt 1, routing 1, tool code 1 | row and folder; `repos` (primary) | — | `git.ts:15` `DEFAULT_CWD` → the primary repo of the project in context | `git.ts:180,232,297,386`, `prompt-sections.ts:213`, `file.ts:344`, `jarvis-files.ts:117` | none | `git_commit` 35, `git_push` 25, `git_status` 4, `git_diff` 1 |
| salones / gilda, 10 (3/7) | the 3 "routing" hits are example comments on generic code (`stalled-projects.ts:90-93`) | row and folder; 3 schedules | — | — | — | none | 0 runs (0 active) |
| vlcms, 7 (4/3) | routing 3, prompt 1 | row `very-light-cms` and folder; aliases; `match_priority` | — | — | `v8-2/critic.ts:142` | none | README injection on "vlcms" |
| X accounts (`<community org>`, `<X handle>`), 6 (1/5) | tool code 1 | records with 5 schedules | — (`tweet_post` / `tweet_probe` stay core, ruling 5) | `tweet_post` / `tweet_probe`, an exception to 3b (ruling 5) | `x-post.ts:222` example | the `jev/shadow-kb.ts:39` path policy | `tweet_post` 16, `tweet_probe` 2; 7 runs |
| Mentions only: pipesong 4, trustr 5, vlmp 3, landing/promo-video/intelligence-ops 5 = 17 (5/12) | routing 4, prompt 1 | rows (pipesong, vlmp, trustr); aliases | — | — | `rituals/day-narrative.ts:96`; the slug lists `kb-injection.ts:96` (11 slugs) and `precedent.ts:57` | none | README injection |
| False positive "impulso", 2 (2/0) | — | — | — | — | — | none (`briefing/render.ts:25`, `v8-2/judgment-render.ts:46`) | — |

**10 rows, 192 lines.** What cannot move:
- the inbound `/api/jarvis-pull` route and the Pulso WhatsApp-store deny paths. They stay in core, keyed by the record.
- the DENUE `.env` exception, until DENUE's server exists. Then the exception is deleted.
- the core tools `crm_query` (`crm-query.ts`; 0 calls in the window) and `tweet_post`/`tweet_probe` (16 + 2), which serve one project family each. They stay core unless ruling 5 moves them into the project's MCP server: `crm_query` is a thin client of Pulso's own API, and the X tools are generic over env-keyed accounts.
- the 110 comment lines.

Project tools in the window: `project_list` 62, `project_update` 14, `project_get` 6. Their outputs and accepted inputs must not change for operator #1 (§2 write paths).

## 6. Replicability test (3d, proposed)

**What it is.** A vitest suite, `src/projects/replicability.test.ts`:
- `initDatabase(":memory:")`, seeded through the real schema path
- the KB rooted in the run's throwaway mirror (`JARVIS_KB_VITEST_FALLBACK` from `vitest.global-setup.ts`; `getMirrorDir()` already refuses the live KB under vitest)
- scratch repos under `mkdtemp`
- LLM calls mocked (CLAUDE.md §Testing)
- never the live db, KB, or `/root/claude`

**Fixtures:**
- **Profile:** `directives/operator.md` for a synthetic operator: English, `UTC`, a `workspaceRoot` equal to the scratch dir, and no first-operator literal.
- **`acme-ledger` (active, MCP):** the record declares `mcp[{id:"acme"}]` and runs `trusted: true` (written through the fixture's operator path). That proves the record→load path, not the trust boundary; the `trusted: false` case is criterion 6. The server is a fixture stdio script in its scratch repo with one read tool and one write tool, `env: ["ACME_TOKEN"]` and `trust: "B"`. The transport is mocked in unit cases, with one real stdio child for the load path.
- **`field-notes` (active, repo + schedule only):** `repos[primary]`, `schedules: ["s-field"]`, aliases `["notas de campo"]`, no server.
- **`old-site` (archived):** declares an MCP server that must not load.

**Pass criteria, all with the same build** (no first-operator code path changed between runs):
1. **Routing.** "check acme" activates group `acme-ledger` and offers `acme__*`. `old-site`'s tools are not registered. The dispatcher's foreign-project names and the KB README injection resolve `field-notes` from its alias. The rendered prompt, scope and tool lists contain 0 hits for the first operator's family regex (the §5 `R`) and 0 identity literals (the inventory §3.1 classes).
2. **Scheduling.** Firing `s-field` inserts a task with `project_slug=field-notes` and `project_source=schedule`. Its sub-task inherits the slug.
3. **Record.** The report function returns, for each project, tasks by status, runs, gates (met/failed/abandoned) and cost that match the seeded rows. `old-site` reports "archived, server not loaded".
4. **Stall detection.** Day-log rows are seeded in `jarvis_files`: `field-notes` (by alias) 2 days ago → not stalled; `acme-ledger` absent → stalled; `old-site` → not evaluated; setting `stall_exempt` → skipped.
5. **Boundaries.** A write under `acme-ledger`'s repo is allowed. A write outside `workspaceRoot` is refused. The MCP child's env holds `ACME_TOKEN` plus the safe defaults only. A record with `trusted: false` does not load (before WS7).
6. **Untrusted load (after WS7 only).** The same `acme` server with `trusted: false` loads only through the sandboxed transport, and a call to a host outside `egress` fails.

**What it cannot prove:**
- the routing quality of the live LLM classifier (it is mocked)
- the persona and language quality of model-facing text (that is the paid `eval:gate`)
- process isolation for a hostile server (point 4 of §3)
- channels
- more than one operator in one process (the design is one install per operator)
- that a real second operator's projects look like these
- operator #1's zero loss, which is §5's checks, not this test

## 7. Build order

| # | Workstream (depends on) | Size | Gate |
| --- | --- | --- | --- |
| WS1 | Record parser (JSON + zod), projector (KB→row), guard on `projects/*/project.md`, Entry radar record, `mc-ctl project` from record-declared schedule ids. **The first slice; one real project end-to-end** — BUILT `f4f6c73` 2026-10-11 (R1 FAIL → R2/R2b/R2c PASS; 26 mutants red); DEPLOYED `d96f72c` + Entry radar record EXPORTED 2026-10-11 (report attributes 5 runs / 5 tasks over 30 d via the schedule id); forward proof = the 2026-10-16 run. Deviation (R1 W5, orchestrator ruling): `project_update` refuses the 4 operator-only keys (`mcp`, `trusted`, `egress`, `deny_paths`) even when the project has no record (0 live rows use them) | M | scoped vitest + qa-auditor; no schema, no prompt text |
| WS2 | Attribution columns (`tasks`, `scheduled_tasks`), set at `src/dispatch/dispatcher.ts:529` from schedule, parent, ritual, inbound, chat; stall detector reads aliases (WS1) — BUILT `2a59503` 2026-10-11 (R1 FAIL → R2 PASS WITH WARNINGS → re-check PASS; 23 mutants red); DEPLOYED `b7dc7d9` 2026-10-11 (v9 applied at boot, Entry radar schedule claimed); PROVEN 2026-10-11 (two chat tasks → `agent-controller`/`chat`, 19:29 and 21:26 UTC). Residual: the chat detector (`kb-injection.ts` `detectProjectInMessage`) maps any word `CRM` to `pulso-aura-upfront`; attribution reads only the operator's typed text (attached-file text after `EXTRACTED_FILE_MARKER` is cut) and validates every slug against `projects` (a slug named in words — chat, thread, inbound — binds only to an active/paused row; a whole-phrase alias outranks a single hyphen-word alias). Mentions of `cmll-gira-estrellas` resolve to null until the operator adds an alias to the `alianza-cmll` record (ruling). Retries (`src/reactions/manager.ts:311`) do not pass `projectSlug`, so a retried chat turn becomes `thread` (from its own original row, inside 24 h) or null | M | `SCHEMA_MIGRATIONS` + the `user_version` pins (`deploy.sh:40,55,57`, `cost-ledger-basis-schema.test.ts:54,86,106`) moved together; operator deploy |
| WS3 | MCP from records: `cwd`, env names only, the merging loader, derived scope / Rule-of-Two / hints; first record-declared server = DENUE's (ruling 5) or the synthetic operator's (WS6); xpoz stays a service server and does not migrate — BUILT `9026838` 2026-10-12 (names-only env for service AND record servers, closes queue 3a; zero records declare a server or a routing summary today, so the classifier prompt is byte-identical and the paid eval gate is owed at the first real record, not at this deploy) | M | **paid eval gate** (classifier group text moves) |
| WS4 | Write allow-list fed by `profile.workspaceRoot` and record `repos` (6 sites, one commit, qa R1+R2); each `repos[].path`: realpath ⊂ workspaceRoot, never trusted as written (R1 W4) (WS1, S6 profile workstream) | M | security invariant |
| WS5 | Remaining families: DENUE server (work in the DENUE repo), CRM capability, `DEFAULT_CWD`, slug lists → records (WS3, WS4) | L | **paid eval gate** (DENUE guard, tool descriptions, prompt examples) |
| WS6 | Replicability suite (§6); first pass after WS3, final pass after WS5 | M | scoped vitest |
| WS7 | Sandboxed MCP transport and `egress` field: needed before any `trusted: false` server loads (WS3) | L | qa R1–R3 (`multi-round-audit`) |

Eval-gate-sensitive moves (`npm run eval:gate -- --run`):
- WS3: no existing group line moves (xpoz stays a service); the gate applies when the first record-declared server adds a classifier group line.
- WS5: the coding/DENUE classifier lines `scope-classifier.ts:125,155,162`; `fast-runner.ts:1193-1311`; tool descriptions `git.ts:180,232,297,386`, `x-post.ts:222`, `jarvis-files.ts:117`, `file.ts:344`, `jarvis-self-repair.ts:83`; prompt text `prompt-sections.ts:213`, `v8-2/critic.ts:142`, `day-narrative.ts:96`, `signal-intelligence.ts:60`, `jarvis-pull.ts:139,145`.

WS1, WS2, WS4 and WS6 change no model-facing text.

**Rulings needed from the operator:**
1. **3c as proposed?** The attribution order in §4 (schedule → parent → ritual → inbound → chat → classifier → day-log at report time), stored as nullable columns on `tasks` and `scheduled_tasks` rather than a link table.
2. **3d as proposed?** The synthetic-operator vitest suite with the pass criteria in §6 (1–5 after WS3 with `acme` trusted; 6 after WS7), as the replicability evidence for the Beta test.
3. **MCP trust.** Capability fields operator-only. Env limited to declared names for record servers. xpoz: RULED 2026-10-11 a service, outside the contract — its full-env inheritance (`manager.ts:178-180`) is a service-hardening item in the queue, not a contract ruling. No server from a non-first-operator record loads before WS7. **RULED 2026-10-12 as proposed.** WS3 unblocked: the loader, names-only env for record AND service servers (queue 3a folds in), derived scope/Rule-of-Two/hints, `trusted: true` required to load until WS7.
4. **First slice and the Entry radar's canonical README.** The Entry radar (record → row → schedule → report, no MCP, proof within a week). RULED Entry radar 2026-10-11 (xpoz is a service, not a candidate). Still open: which README is canonical, `projects/williams-entry-radar/` (the row's folder) or `projects/williams-radar/` (what chat injects today)? Until ruled, `kb_readme` keeps today's behaviour. RULED 2026-10-11: canonical README = `projects/williams-entry-radar/README.md`; injection resolves from the row's `config.kb_readme` (record-derived) — BUILT `a60ebf0` (audit R1 FAIL → R2 → R2b, all folded; `kb_readme` operator-only, `KB_README_RE` shared); deploy = operator
5. **3b exceptions and DENUE.** `crm_query` and `tweet_post`/`tweet_probe` stay core tools (listed residuals) or move into their projects' MCP servers; **RULED 2026-10-12 (5b): NOT exceptions — three capabilities owned by three different projects, treated as such.** `crm_query` is `pulso-aura-upfront`'s capability (thin client of Pulso's own API; becomes a record-declared capability under WS3: Pulso's MCP server or `http_fetch` + `SECRET_` ref, the core tool retires on that deploy). The X tools stay generic core infrastructure, but an X ACCOUNT is a project capability declared by its owner's record (`secrets` names `SECRET_X_AUTH_TOKEN__<handle>` / `SECRET_X_CT0__<handle>`): the daily-tweet account → `mexico-necesario-ac` (1 active schedule, 14 posts/90 d), the second handle → `personal-branding` (2 inactive schedules). A task reaches an account only through its attributed project's record; `tweet_probe` with no `account` checks the task's project's accounts, not all configured ones. Build = WS3 scope (records for the three rows via `mc-ctl project-create`, `secrets`/`capabilities` consumers, eval gate for the `accountsHint` description text); the three rows have no record yet (checked 2026-10-12). and confirm DENUE as a new record with `uncharted-lite` as its child. RULED 2026-10-11: DENUE record `denue-data-analysis` (repo `projects/data-intelligence/denue-data-analysis`), `uncharted-lite` child via `parent`; creation path `mc-ctl project-create`; dangling parent warns — BUILT `7bc9334` (audit R1 FAIL → R2 FAIL → R3 PASS WITH WARNINGS, all folded; operator gate `src/lib/operator-gate.ts` = cgroup login-session allow-list + TTY; queue 3c/3d); DEPLOYED `381cd71` 2026-10-11 21:05 UTC; `mc-ctl project-create denue-data-analysis` + export `uncharted-lite --parent` APPLIED 21:07 UTC (row created from the record; child linked; first project to enter Jarvis through the create path)

**Tripwires at end:** `stat -c '%Y %s' /root/claude/jarvis-kb/directives/core.md` = `1791309381 3739`; `ls /root/claude/jarvis-kb/logs/day-logs | wc -l` = `191`.
