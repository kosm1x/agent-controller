# S6 step 1 — what is hardcoded to the operator and this VPS (inventory, 2026-10-09)

Read-only grep survey at `10f7fbb`. Answers the ROADMAP Beta-tests gap "inventory of what is hardcoded to Fede/VPS (S6)". Public repo: identity literals appear here by CLASS and file:line only. Sources: `src/**/*.ts` (tests counted apart), `scripts/`, `mc-ctl`, `package.json`, `mcp-servers.json`, top-level `docs/*.md` (counts only), the systemd drop-ins (key NAMES only). Not read: `.env*`, `env.example`, `data/` (except one `scheduled_tasks` count), KB content, `~/.claude`, sibling repos.

Every count below re-runs from the repo root with this preamble. Identity literals are pulled from the code at run time so they never appear in this file:

```bash
cd /root/claude/mission-control
S='--include=*.ts --exclude=*.test.ts --exclude-dir=test-utils'   # source
# Counts assume /usr/bin/grep. A shell wrapper that adds -I skips the two binary-looking sources (kb-backup.ts, channels/email.ts); use -a where a fence has it.
T='--include=*.test.ts'                                             # tests
C='^[^:]+:[0-9]+:\s*(\*|//|/\*)'                                    # comment-line filter (grep -E)
V=$(grep -oE 'JARVIS_GH_USER \?\? "[A-Z][a-z]+' src/tools/builtin/git.ts | sed 's/.*"//')   # assistant vocative
D=$(grep -oE '@[a-z0-9.-]+\.net' src/tools/builtin/schedule.ts | head -1)                    # operator mail domain
G=$(grep -oE '[a-z0-9._-]+@gmail\.com' src/tools/builtin/git.ts | head -1)                   # second operator address
O=$(grep -oE 'e\.g\. "[a-z]+"' src/tools/builtin/x-post.ts | grep -oE '[a-z]{6,}')          # community-org handle
N=$(grep -oE 'works for [A-Z][a-z]+' docs/ROADMAP.md | head -1 | awk '{print $3}')                # operator first name, as ROADMAP uses it
GO=$(grep -oE 'GITHUB_ORG = "[^"]+"' src/tools/builtin/git.ts | sed 's/.*"\(.*\)"/\1/')     # GitHub-org default
H1=$(grep -oE 'https://[a-z0-9.-]+' src/db/pgvector.ts | head -1 | sed 's#https://##')      # Supabase host
H2=$(grep -oE '[a-z0-9-]+\.net' src/email-verify/governance.ts | head -1)                    # mail-server domain
```

Tripwires at start: `stat -c '%Y %s' /root/claude/jarvis-kb/directives/core.md` = `1791309381 3739`; `ls /root/claude/jarvis-kb/logs/day-logs | wc -l` = `190`. Both match the brief.

## 1. Verdict

1. **1,700 source sites in 7 categories** (a line can sit in two categories; §2 shows the overlap rule). By move class: **prompt 657 · profile 453 · leave 331 · KB seed 111 · env 96 · infra 52**.
2. **Biggest cluster: language.** 949 lines: 904 lines of fixed Spanish (a diacritic proxy, so a lower bound), 30 timezone-literal lines and 15 `es-MX` lines. 557 are prompt or tool-description text and 374 are harness, channel, matcher, timezone and locale text. `prompt-sections.ts` alone has 173 lines. No language setting exists except `WHISPER_LANGUAGE`.
3. **Second: the portfolio.** 192 lines across 55 files name sibling projects (DENUE 61, Pulso/CRM 27+7, xpoz 29). 44 sit in routing or prompt text.
4. **Third: paths.** 177 `/root/` lines. The `/root/claude/` write allow-list is hardcoded at 6 sites that must stay in sync, and the install dir `/root/claude/mission-control` appears on 49 code lines (48 classed env; the other is also a secret deny-list line). Only the KB root (`JARVIS_KB_MIRROR_DIR`) and the DB (`MC_DB_PATH`) have an env key.
5. **Identity is small but sits in prompts.** 117 lines: the first name "Fede" on 83 (60 code), the operator email on 16, the vocative on 22, and the GitHub-org default on 5. 50 of the 71 code lines are persona or tool-description prose, so changing them needs the paid `eval:gate`.
6. **Already clean: channels.** No Telegram chat id or WhatsApp JID literal is in the code. Owner ids, group JIDs, email accounts, port and bind host all come from env. The only leaks are the operator email in ritual delivery text (counted under identity) and 3 comment lines with a phone or LID literal (§3.1).
7. **Timezone is half-seamed.** `RITUALS_TIMEZONE` is read from env at 6 sites, but `USER_TIMEZONE` (`src/lib/timezone.ts:11`) and 11 other bare literals ignore it. `USER_TIMEZONE` reaches 36 non-import lines in 20 files, directly or through 5 helpers (`toMexTime`, `nowMexIsoDate`, `nowMexDate`, `nowMexTime`, `mxNowSql`), and 21 files import `lib/timezone`. A second operator who sets the env key would get mixed clocks.
8. **The env "source of truth" is not one place.** `src/config.ts` has 47 keys, while `src/` reads 136 distinct `process.env` keys from 105 other files (§4 has the grep). None of the operator keys (owner ids, timezone, KB root, GitHub bot) are in `config.ts`.
9. **Smallest first workstream (a chat turn for operator #2):** a profile record (name, vocative, language, timezone) feeding three places: the chat-path persona (`prompt-sections.ts` 17 name lines + 3 vocative lines, `fast-path.ts:78`, the `seedDirectives()` default `directives/core.md`), and one workspace-root key that replaces the 6 allow-list literals. Telegram needs nothing new. Making the timezone follow the profile touches `lib/timezone.ts` plus its 36 consumer lines (20 files) and the 6 env-read sites.
10. **Not surveyable under the constraints:** which of the 20 `scheduled_tasks` rows depend on operator KB files, because that needs prompt text. §3.5 narrows it by name: 18 of the 20 names are operator-personal or portfolio tasks.

## 2. Summary table (source lines; tests and docs are separate columns)

| # | Category | Source / tests / docs-top | Already behind a seam | Move split (env · profile · KB seed · prompt · infra · leave) | Hardest item |
| --- | --- | --- | --- | --- | --- |
| 1 | Identity | 117 / 150 name + 42 vocative + 7 email / 285 name (284 without one "federal" match; `grep -ni -- "$N" docs/*.md \| wc -l`, current tree incl. an uncommitted EVOLUTION-LOG edit) + 7 email | owner ids (Telegram, WhatsApp), GitHub bot (`JARVIS_GH_*`) | 2 · 18 · 1 · 50 · 0 · 46 | persona prose in `prompt-sections.ts` + memory-extraction prompts (`jme.ts`) — eval gate |
| 2 | Language + TZ | 949 (904 Spanish + 30 TZ + 15 `es-MX`) / 1,769 Spanish + 24 TZ / — | `WHISPER_LANGUAGE`, `RITUALS_TIMEZONE` (partial) | 6 · 374 · 0 · 557 · 0 · 12 | Spanish keyword matchers that route input (`scope.ts` 49, `confirmation-verbs.ts` 35) |
| 3 | Paths | 177 / 435 / 35 | KB root, DB path, `HOME`, `DOCKER_CONFIG` | 59 · 23 · 0 · 4 · 28 · 63 | the 6-site write allow-list (security invariant) |
| 4 | Channels | 20 env-read lines / — / — | all adapters | 20 · 0 · 0 · 0 · 0 · 0 | none in code; ritual delivery email is under #1 |
| 5 | KB seed | 163 / 619 / 4 (`jarvis-kb`) | KB root env | 0 · 0 · 110 · 0 · 0 · 53 | `seedDirectives()` writes an operator-specific persona |
| 6 | Infra | 82 / — / — | Hindsight, Prometheus, OpenSandbox, CRM URLs, heavy image | 9 · 0 · 0 · 2 · 24 · 47 | Supabase host with no env key (`pgvector.ts:12-13`, `lesson-decay.ts:23`, `kb-backup.ts:11`) |
| 7 | Portfolio | 192 / — / — | `CRM_API_*`, `WP_SITES`, X accounts | 0 · 38 · 0 · 44 · 0 · 110 | sibling repos named in the routing classifiers |
| | **Total** | **1,700** | | **96 · 453 · 111 · 657 · 52 · 331** | |

Overlap rule: within a category, a line is counted once (identity is a union). Across categories, a line can appear twice. For example, `prompt-sections.ts:213` is both a path and an operator-name line. Comment lines are always **leave**.

## 3. Categories

### 3.1 Identity

```bash
grep -rni $S -- "$N" src | grep -vi federal | wc -l                    # 83 lines (25 files: add | cut -d: -f1 | sort -u | wc -l)
grep -rni $S -- "$N" src | grep -vi federal | grep -cE "$C"            # 23 comment lines
grep -rni $S -- "$N" src | grep -vi federal | grep -vE "$C" | grep -vF -- "$D" | wc -l   # 47 name-only code lines
grep -rn  $S -- "$V" src | wc -l ; grep -rn $S -- "$V" src | grep -cE "$C"           # 22 vocative / 15 comments
grep -rnF $S -- "$D" src | wc -l ; grep -rnF $S -- "$D" src | grep -cE "$C"          # 16 operator-email / 2 comments
grep -rnE $S '[0-9]{10,}@(s\.whatsapp\.net|lid|g\.us)|\b52[0-9]{10,11}\b' src | wc -l  # 3 phone/LID literals
grep -rnF $S -- "$GO" src | wc -l ; grep -rnF $S -- "$GO" src | grep -cE "$C"        # 5 GitHub-org default / 1 comment
# identity union (all classes, de-duplicated by file:line) → 117 lines; append | grep -cE "$C" → 46 comments
{ grep -rni $S -- "$N" src | grep -vi federal; grep -rn $S -- "$V" src; grep -rnF $S -- "$D" src; grep -rnF $S -- "$G" src; \
  grep -rnE $S '[0-9]{10,}@(s\.whatsapp\.net|lid|g\.us)|\b52[0-9]{10,11}\b' src; grep -rnF $S kosm1x src; \
  grep -rniF $S -- "$O" src; grep -rnF $S -- "$GO" src; } | sort -u -t: -k1,2 | wc -l
```

The brief's starting count (86 lines / 27 files, from `grep -rni "$N"`) includes 3 FEDERAL lines in 2 finance files, so the real count is 83 / 25. Its "14 contact literals" equals the 14 code lines with the operator email.

| Class | Sites (file:line) | Where it sits | Seam today | Move |
| --- | --- | --- | --- | --- |
| Operator first name in persona prose (47 code lines) | `prompt-sections.ts` 17 (e.g. :85, :91, :135, :213, :467), `jme.ts` 7 (:1114-1123), `briefing/judgment-prompt.ts` 5 (:145-198), rituals `morning`/`nightly`/`signal-intelligence`/`market-*`/`weekly-review`/`evolution-log` 12, `reflection/runner.ts:55,57`, `fast-path.ts:78`, `hindsight-backend.ts:477`, `background-extractor.ts:77`, `user-facts.ts:817`, `tools/builtin/memory.ts:149` | system, ritual and extraction prompts; tool description | none | prompt (43) |
| Name as data, not prose | `memory/sqlite-backend.ts:93` (FTS stopword), `memory/jme.ts:1099` (self-naming guard regex), `memory/jme.ts:1148` (transcript speaker label) | harness code | none | profile (3) |
| Name in the default KB seed | `db/jarvis-fs.ts:890` (`seedDirectives()` body) | KB seed written on first boot | none | KB seed (1) |
| Operator email (14 code lines) | `tools/builtin/schedule.ts:107`; `rituals/nightly.ts:45,48`, `morning.ts:118`, `signal-intelligence.ts:101`, `weekly-review.ts:75`, `market-morning-scan.ts:43`; `rituals/dynamic.ts:436,567,694` (`email_to ??` default); `tools/builtin/google-gmail.ts:82,84,86` (recipient auto-correct); `lib/v8-4/citations.ts:71` (API contact) | ritual delivery and tool defaults | none | profile (14) |
| Assistant vocative, outside name lines | `prompt-sections.ts:73,150` | chat persona | none | prompt (2) |
| GitHub bot handle + address defaults | `tools/builtin/git.ts:50` (vocative-derived handle), `git.ts:51` (second operator address) | env default | `JARVIS_GH_USER`, `JARVIS_GH_EMAIL` | env (2) |
| GitHub org (repo owner) | `prompt-sections.ts:576` (code), `git.ts:534` (comment) — `grep -rnF $S kosm1x src` | prompt | none | prompt (1) / leave (1) |
| GitHub-org default for new repos (`$GO`) | `tools/builtin/git.ts:16` (`GITHUB_ORG` constant, used at :648); `git.ts:601,614,621` (tool description); `git.ts:647` (comment) | harness default + tool description | none | profile (1) / prompt (3) / leave (1) |
| Community-org handle | `tools/builtin/x-post.ts:222` (code); `lib/x-poster/config.ts:11,178`, `audit/report-schema.ts:111`, `community-reply-gate.ts:4`, `delivery-policy.ts:328` (comments) — `grep -rniF $S -- "$O" src` | tool description example | X accounts via env | prompt (1) / leave (5) |
| Phone / LID literal | `rituals/prometheus-alert-poller.ts:20`, `messaging/channels/whatsapp.ts:234,235` | comments in a public repo | n/a | leave (3); scrub = operator ruling |
| Telegram chat id, WhatsApp JID | none in source | — | `TELEGRAM_OWNER_CHAT_ID`, `WHATSAPP_OWNER_JID`, `WHATSAPP_GROUP_JIDS` | — |
| Pronoun forms | 10 name lines also carry he/his/him (`grep -rni $S -- "$N" src \| grep -vi federal \| grep -ciE '\b(he\|his\|him\|himself\|él\|su equipo)\b'`) | prompts | none | inside the prompt rows |

Owner concepts already in code: the Telegram owner-only filter (`channels/telegram.ts:26,487`), the WhatsApp owner and groups (`channels/whatsapp.ts:31,35,101`), the operator-address resolver per channel (`messaging/router.ts:4914-4920`; email has no single owner address), `broadcastToAll` used for owner alerts (`rituals/scheduler.ts:179`), and `JME_REDACT_ALLOW_EMAILS` (`memory/jme.ts:832`). Union of all identity classes: 117 lines, 46 of them comments (the union command in the fence above).

### 3.2 Language and locale

```bash
grep -arnP $S '[áéíóúñ¿¡ÁÉÍÓÚÑ]' src | grep -vE "$C" | wc -l         # 904 (-a: channels/email.ts reads as binary; without -a, 903)
grep -arlP $S '[áéíóúñ¿¡ÁÉÍÓÚÑ]' src | wc -l                           # 144 files (143 without -a)
grep -arnP $S '[áéíóúñ¿¡ÁÉÍÓÚÑ]' src | grep -vE "$C" | grep -cE '^src/(messaging/prompt-sections|messaging/fast-path|rituals/|briefing/|dispatch/classifier|messaging/scope-classifier|db/jarvis-fs|runners/fast-runner|reflection/|memory/(jme|background-extractor|entity-extractor)|intelligence/)'  # 456
#   same pipe, '^src/tools/' → 101 ; '^src/messaging/(scope|confirmation-verbs|scope-miss|normalize)\.ts' → 93
#   '^src/(messaging/(router|deliverable-filter|community-reply-gate|formatter|post-filter)|lib/v8-4/|api/|inference/escalation|lib/secret-refs)' → 160 ; remainder 94
grep -rn $S 'America/Mexico_City' src | wc -l                        # 30 (21 files); comments 12; with RITUALS_TIMEZONE 6
grep -rn $S 'es-MX' src | wc -l                                      # 15 (10 files)
grep -rn $S 'en-CA' src | wc -l ; grep -rn $S 'en-US' src | wc -l     # 31 / 13
grep -rn $S 'process\.env\.RITUALS_TIMEZONE' src | wc -l             # 6 env-read sites
grep -rn $S 'RITUALS_TIMEZONE' src | wc -l                           # 82 lines naming it (mostly the imported constant; 27 in rituals/scheduler.ts)
# USER_TIMEZONE consumers, direct or via the helpers in lib/timezone.ts, import lines dropped → 36 lines; | cut -d: -f1 | sort -u | wc -l → 20 files
grep -rnE $S 'USER_TIMEZONE|toMexTime|nowMexIsoDate|nowMexDate|nowMexTime|mxNowSql' src | grep -v '^src/lib/timezone\.ts:' \
  | grep -vE ':[0-9]+:\s*(import |\}|[A-Za-z_]+,\s*$)' | wc -l
grep -rlE $S "lib/timezone(\.js)?['\"]|from ['\"]\./timezone(\.js)?['\"]" src | grep -v '^src/lib/timezone.ts$' | wc -l   # 21 importers
```

| Class | Count + representative sites | Where it sits | Seam | Move |
| --- | --- | --- | --- | --- |
| Spanish prompt text | 456 lines: `prompt-sections.ts` 173, `runners/fast-runner.ts` 54, `dispatch/classifier.ts` 36 | system, ritual and classifier prompts | none | prompt (456) |
| Spanish tool descriptions | 101 lines under `src/tools/` (e.g. `schedule.ts` 10, `teaching-tools.ts` 9) | tool description | none | prompt (101) |
| Spanish input matchers | 93 lines: `scope.ts` 49, `confirmation-verbs.ts` 35 | keyword regexes that route input | none | profile/language (93) |
| Harness and channel strings | 160 lines: `router.ts` 54, `api/routes/jarvis-pull.ts` 23, `community-reply-gate.ts` 16, `deliverable-filter.ts` 11, `lib/v8-4/numbers.ts` 11 | text appended to replies, error texts, filters | `deliverable-filter.ts:116-121` detects English (`looksEnglish`) — the one bilingual spot | profile/language (160) |
| Ledger line prefixes | `lib/v8-4/ledger-lines.ts:20-27`, 7 prefixes (5 Spanish) read by `isLedgerLine` in `gates.ts`, `numbers.ts`, `deliverable-filter.ts`, `router.ts` | harness-appended lines | none | inside the 160 above |
| Other Spanish | 94 lines (intel, finance, misc tool code, `channels/email.ts`) | mixed | none | profile (94) |
| TZ literal with env fallback | `rituals/dynamic.ts:430,470`, `canary.ts:20`, `rituals/config.ts:6`, `intelligence/session-end-writer.ts:33`, `proactive.ts:26` (the only 6 env reads; the other 76 `RITUALS_TIMEZONE` lines name the exported constant: uses, imports, log text) | `RITUALS_TIMEZONE ?? literal` | `RITUALS_TIMEZONE` | env (6) |
| TZ literal with no seam | 12 lines: `lib/timezone.ts:11` (`USER_TIMEZONE`), `briefing/render.ts:42`, `messaging/router.ts:1457,1460`, `memory/lesson-decay.ts:213,231`, `lib/v8-3/seed.ts:123`, `db/drive-sync.ts:146` …; `USER_TIMEZONE` reaches 36 consumer lines in 20 files directly or through 5 helpers (`toMexTime`, `nowMexIsoDate`, `nowMexDate`, `nowMexTime`, `mxNowSql`) | constants and date formatting | none | profile (12) |
| `es-MX` locale | 15 lines, e.g. `rituals/dynamic.ts` ×2, `lib/timezone.ts`, `briefing/render.ts` | `toLocale*String` | none | profile (15) |
| `en-CA` (ISO-date trick), `en-US` | 31 + 13 | date formatting | n/a | leave (not counted) |

The service unit sets `Environment=TZ=` (key name only, `/etc/systemd/system/mission-control.service:16`). `lib/v8-4/gate-check.ts:151` defaults its children to `TZ=UTC`.

### 3.3 Paths

```bash
grep -rn $S '/root/' src | wc -l ; grep -rn $S '/root/' src | grep -cE "$C"           # 177 / 63
grep -rn $S '/root/' src | grep -vE "$C" | grep -cE '/root/(\.|backups/|claude-backups/|/\.)'   # 28 secret deny-list
grep -rn $S '"/root/claude/"' src | wc -l                                            # 6 allow-list sites
grep -rn $S '/root/claude/mission-control' src | grep -vE "$C" | wc -l               # 49 install-dir code lines
grep -rn $S '/root/claude/mission-control' src | grep -vE "$C" | grep -vcE '/root/(\.|backups/|claude-backups/|/\.)'   # 48 (1 is also a deny-list line)
grep -rn $S '/root/tmp-' src | wc -l ; grep -rn $S '/root/tmp-' src | grep -vE "$C" | wc -l   # 10 video-scratch lines / 7 code
grep -rnoE $S '/root/[A-Za-z0-9._-]*(/[A-Za-z0-9._-]*)?' src | awk -F: '{print $3}' | sort | uniq -c | sort -rn   # by subpath
grep -rn '/root/' scripts | wc -l ; grep -rln '/root/' scripts | wc -l ; grep -c '/root/' mc-ctl   # 118 / 42 of 115 / 1
```

| Class | Sites | Seam | Move |
| --- | --- | --- | --- |
| Workspace root `/root/claude/` write and cwd allow-list | `git.ts:33` (`ALLOWED_CWD_PREFIXES`), `file.ts:52` + `shell.ts:549` (`getAllowWritePrefixes`), `runners/container.ts:49`, `write-guard.ts:16`, `file.ts:561` — 6 sites | none (CLAUDE.md invariant: keep the sites in sync) | profile (6) |
| Workspace root in tool and prompt text | `shell.ts:1849`, `file.ts:483`, `prompt-sections.ts:213`, `runners/nanoclaw-env-note.ts:49` | none | prompt (4) |
| Install dir `/root/claude/mission-control` (+ worktree `-jarvis`) | 49 code lines, 48 classed here (the 49th is in the deny-list row): `runners/container.ts:56` (`MC_ROOT`), `immutable-core.ts:14`, `git.ts:17,25` (`JARVIS_MC_WORKTREE`), `shell.ts:571,1578`, `file.ts:61,82,140-160`, `nanoclaw-runner.ts:150` | none (`process.cwd()` not used) | env (48) |
| KB root `/root/claude/jarvis-kb` | `db/jarvis-fs.ts:33` default + 1 more; `file.ts:51` and `shell.ts:548` (`getJarvisKbRoot()` entries whose comment names `/root/claude`); 28 `getJarvisKbRoot()` calls | `JARVIS_KB_MIRROR_DIR` | env, exists (4) |
| Video scratch `/root/tmp-video-*` | 10 lines, 7 of them code, in `video/html-*.ts`, `tools/builtin/video.ts` | none | env (7) |
| Sibling repos | 17 lines: `git.ts:15` (`DEFAULT_CWD` is a sibling repo), `immutable-core.ts:146,148,190`, previews, `projects/` | none | profile/portfolio (17) |
| Secret deny-list (`~/.ssh`, `~/.claude`, `~/.config/gh`, backups …) | 28 lines, `immutable-core.ts:113-152` mostly; `code-editing.ts:46`; `runners/container.ts:52` | should derive from `HOME` | infra (28) |
| DB file | `config.ts:221` default `./data/mc.db`, 6 more direct `MC_DB_PATH` reads | `MC_DB_PATH` | env, exists |
| `/tmp/*` | 95 lines (e.g. `/tmp/jarvis-downloads`, `/tmp/video-jobs`) | none | leave (host-neutral) |

Other surfaces: `mcp-servers.json:127` has one absolute sibling path (the xpoz MCP server). The systemd unit has `WorkingDirectory=` and `EnvironmentFile=` under the install dir. `pm-shim.sh:14` names `/usr/bin/npm` (host-neutral).

### 3.4 Channels

```bash
grep -rnE $S 'process\.env\.(TELEGRAM_|WHATSAPP_|EMAIL_ENABLED|MC_BIND_HOST|CRM_API_)' src | wc -l   # 20
grep -rn $S ':8080\|"8080"' src | grep -vE "$C" | cut -d: -f1,2                             # vps-management.ts:147 only
```

| Channel | Keyed by | Operator allow-list | Literal leaks |
| --- | --- | --- | --- |
| Telegram | `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` (`channels/telegram.ts:26`, `messaging/index.ts:50`) | owner-only filter on the chat id | none |
| WhatsApp | `WHATSAPP_ENABLED`, `WHATSAPP_OWNER_JID`, `WHATSAPP_GROUP_JIDS` (`channels/whatsapp.ts:31,35`); turned off by drop-in `no-whatsapp.conf` (`UnsetEnvironment`) | owner JID + group list | phone/LID comments (§3.1) |
| Email | `EMAIL_ENABLED` + per-account `EMAIL_<ID>_IMAP_*/SMTP_*/PERSONA_FILE` (`channels/email.ts:18-20`); turned off by `no-email.conf` | none (`router.ts:4914`: no single owner address) | ritual delivery to the operator email (14 lines, §3.1) |
| HTTP / dashboard | `MC_PORT` (8080 default, `config.ts:220`), `MC_BIND_HOST` (`index.ts:365`, default `0.0.0.0`), `MC_API_KEY` | API key | `tools/builtin/vps-management.ts:147` health URL (counted in §3.6) |
| CRM pull API | `CRM_API_URL`, `CRM_API_TOKEN` (`tools/builtin/crm-query.ts:14`) | token | none |

### 3.5 KB seed (paths and counts only; no KB content read)

```bash
K='["'"'"'`/](directives|NorthStar|logs/day-logs|logs/day-narratives|knowledge|projects|skills)/'
grep -rnE $S "$K" src | wc -l ; grep -rnE $S "$K" src | grep -cE "$C"      # 163 (48 files) / 53
grep -rhoE $S '(directives|NorthStar|knowledge|people)/[A-Za-z0-9._-]+\.md' src | sort -u | wc -l   # 10 named files
grep -rn $S 'jarvis-kb' src | wc -l                                         # 26 (12 files)
sqlite3 -readonly data/mc.db "select count(*), count(distinct name) from scheduled_tasks"   # 20|20
```

| Item | Count / sites | Move |
| --- | --- | --- |
| KB layout the code opens by name | 110 code lines; top `tools/builtin/jarvis-files.ts` 24, `immutable-core.ts` 7, `jev/shadow-kb.ts` 7, `lib/external-kb-policy.ts` 5. Directories: `directives/`, `NorthStar/{objectives,goals,visions,tasks}`, `logs/{day-logs,day-narratives,decisions}`, `knowledge/{domain,procedures,people,proposals,execution-patterns,preferences,learning}`, `projects/`, `skills/`, `inbox/` — all present on disk | KB seed (110) |
| Named files | 10, e.g. `directives/core.md` (4 refs), `directives/context-management.md` (2), 7 more `directives/*.md`; `logs/sessions` and `people/name.md` are named but absent (may be examples) | KB seed |
| Code-level seed | `db/jarvis-fs.ts:873-897` `seedDirectives()` writes `directives/core.md` when missing; called at `db/index.ts:1158`. Its persona names the operator (§3.1) | KB seed — the natural onboarding hook |
| Repo `seed/` | 26 files (`find seed -type f \| wc -l`): generic skills + a screenwriting corpus. `grep -rn "seed/" src --include=*.ts --exclude=*.test.ts` returns 1 hit, a comment at `db/user-facts.ts:42` that does not refer to this directory, so there is no `src` consumer | leave |
| Code rituals | 11 ids in `src/rituals/config.ts` (`grep -cE '^\s+id: "' src/rituals/config.ts`); 8 ritual sources reference KB paths (`day-narrative` 5, `scheduler` 5, `diff-digest` 3, `morning` 3, `weekly-review` 3, `evolution-log` 2, `nightly` 1, `dynamic` 1) | KB seed |
| Scheduled tasks (DB) | 20 rows / 20 names (listed below) | **KB dependency not surveyed**: it needs prompt text, which the brief forbids reading. By name, 18 of the 20 are operator-personal or portfolio tasks |

Names only (`sqlite3 -readonly /root/claude/mission-control/data/mc.db "select name from scheduled_tasks order by name"`). Identity tokens inside names are replaced by their class:

- **Product surface / maintenance (2):** `Morning Sync — <vocative> 8am`; `Weekly upstream ref sweep (non-core rotating batch)`.
- **Portfolio (12):** `<X handle> — Tweet 6pm (Jarvis's Voice)`, `<X handle> — Tweet Nocturno Diario`; `Gilda Outreach — Resumen Diario`, `— Triage Leads`, `— Vigía Ban (secundaria)`; `<community org> — Tweet 15 Mayo (sin emojis)`, `— Tweet Diario`, `— Tweet Hoy 15 Mayo (manual)`; `PipeSong Tech Radar - Revisión TTS/STT`; `Williams Journal — Publicación Semanal W`; `Nudge: Autoreason Phase 2 feasibility evaluation`; `Reporte Diario Pharma & Cáncer + <operator business>`.
- **Personal (6):** `<fantasy team> — Chequeo Final de Lineup (Domingo AM)`, `— Lineup Lock pre-TNF (Jueves)`, `— Waiver Wire (Martes)`; `Química Básica — Tarjeta de Estudio Diaria`; `Renovar <hostname literal> en Hostinger`; `Transición al Posthumanismo — Reflexión Diaria`.

### 3.6 Infra

```bash
grep -rnoE $S '(127\.0\.0\.1|localhost|0\.0\.0\.0):[0-9]{2,5}' src | wc -l                 # 16
grep -arnF $S -- "$H1" src | wc -l ; grep -rnF $S -- "$H2" src | wc -l                        # 6 (1 comment; -a: kb-backup.ts reads as binary) / 2
grep -rnE $S '([0-9]{1,3}\.){4}[a-z]{3}\.io' src | wc -l                                      # 2 (VPS-IP wildcard host)
grep -rniE $S 'supabase-db|mc-prometheus|crm-hindsight' src | wc -l                           # 20 (15 comments)
grep -rniE $S 'systemctl [a-z-]+ [a-z][a-z0-9.-]+|journalctl -u [a-z0-9-]+' src | wc -l       # 6 (4 comments)
grep -rniE $S '\bcaddy\b|/etc/caddy|\bufw\b' src | wc -l                                      # 24 (17 comments)
grep -rniE $S '\.opensandbox|/etc/opensandbox' src | wc -l                                    # 4
```

| Class | Sites | Env-keyed? | Move |
| --- | --- | --- | --- |
| host:port literals | 8 code defaults behind env: `config.ts:275` (8098), `index.ts:285`, `memory/index.ts:33`, `recall-compare.ts:185` (8888), `hindsight-cost-pull.ts:23`, `prometheus-alert-poller.ts:38`, `self-healing/detect.ts:15` (9090), `crm-query.ts:14` (3000); bare: `vps-management.ts:147`; prompt: `evolution-log.ts:163`; 6 comments | 8 yes | env 8 · infra 1 · prompt 1 · leave 6 |
| Supabase host | `db/pgvector.ts:12,13`, `memory/lesson-decay.ts:23`, `db/kb-backup.ts:11` (`COMMIT_DB_URL`), `rituals/scheduler.ts:647` (log text); `kb-backup.ts:2` comment | **no** | infra 5 · leave 1 |
| Mail-server domain | `email-verify/governance.ts:3`, `verify.ts:102` | comments | leave (2) |
| VPS-IP wildcard preview host | `messaging/scope-classifier.ts:152` (prompt), `scope.ts:573` (comment) | no | prompt 1 · leave 1 |
| Docker images | `config.ts:271` `HEAVY_RUNNER_IMAGE` default; `runners/container.ts:476` comment | yes | env 1 · leave 1 |
| Container names | 5 code: `shell.ts:1135,1186,1852,1863`, `fast-runner.ts:1234`. `shell.ts:1135` is inside a refusal string the model sees (infra in prompt text) | no | infra 5 · leave 15 |
| systemd units | 2 code lines | no | infra 2 · leave 4 |
| Caddy / UFW | 7 code lines, 12 files | no | infra 7 · leave 17 |
| OpenSandbox host paths | 4 lines | no (server URL is) | infra (4) |
| Drop-ins `/etc/systemd/system/mission-control.service.d/` | 18 files (2 `.bak`); keys: `ALERT_NOTIFY_ENABLED`, `ALERT_RENOTIFY_HOURS`, `DEBUG_CACHE_DIAG`, `GOAL_TIMEOUT_MS`, `ORCHESTRATOR_TIMEOUT_MS`, `JARVIS_MCP_ENABLED`, `INFERENCE_{FALLBACK,TERTIARY}_{URL,MODEL,KEY}`, `SANDBOX_BACKEND`, `SANDBOX_EGRESS_ALLOW`, `V82_SYNC_SCHEDULE_ID`, `TOOL_SEARCH_ENABLED`, `V82_JUDGMENT_PRODUCER_ENABLED`, `V83_ENABLED`, `V83_GATED_CAPABILITIES`, `TASK_GATES_MODE`, `TASK_GATES_STOP_HOOK`, `TASK_GATES_GRADER`, `X_PROBE_ENABLED`; unsets `EMAIL_ENABLED`, `WHATSAPP_ENABLED`; `OOMPolicy`; one `EnvironmentFile=` | — | infra (per-host config; outside the line totals) |

Scripts name the unit `mission-control` 44× and `opensandbox-*` 7× (`grep -rnoE 'systemctl [a-z-]+ [a-z][a-z0-9-]+' scripts mc-ctl`). Hindsight is a 230-line feature (33 files) behind `HINDSIGHT_ENABLED`/`HINDSIGHT_URL`, not a hardcoding.

### 3.7 Other projects wired in (the operator's portfolio)

```bash
R="Pulso|agentic-crm|CRM_API|crm-azteca|crm\.db|denue|trustr|vlmp|cuatro-flor|williams-entry|williams[ _-]?radar|pipesong|xpoz|uncharted|salones|gilda|${O}|EurekaMS-Landing|vlcrm|very-light-cms|vlcms|promo-video|intelligence-ops"
grep -rniE $S "$R" src | wc -l ; grep -rliE $S "$R" src | wc -l ; grep -rniE $S "$R" src | grep -cE "$C"   # 192 / 55 / 110
# per project: grep -rniE $S '<pattern>' src | wc -l
```

| Project (pattern) | Lines / files | Representative sites | Move |
| --- | --- | --- | --- |
| DENUE (`denue`) | 61 / 19 | `dispatch/classifier.ts`, `runners/fast-runner.ts:1208` (API host + prompt), `lib/external-kb-policy.ts`, `messaging/scope.ts` | prompt + profile |
| xpoz (`xpoz`) | 29 / 7 | `mcp/manager.ts`, `tools/rule-of-two.ts`, `mcp-servers.json:127` | profile (plugin) |
| Pulso / CRM (`Pulso\|agentic-crm\|CRM_API`; `crm-azteca\|crm\.db`) | 27 / 13; 7 / 7 | `tools/builtin/crm-query.ts`, `api/routes/jarvis-pull.ts`, `immutable-core.ts:146,148` | profile (plugin) |
| Entry radar (`williams-entry\|williams[ _-]?radar`) | 13 / 9 | `kb-injection.ts:112`, `scope.ts`, `git.ts` | prompt |
| cuatro-flor | 12 / 7 | `git.ts:15` default cwd, `prompt-sections.ts:213`, `jarvis-files.ts` | profile |
| vlcms (`very-light-cms\|vlcms`) | 10 / 5 | `lib/url-safety.ts`, `v8-2/critic.ts`, `scope.ts` | prompt |
| salones/gilda | 10 / 3 | — | prompt |
| vlmp · pipesong · community org (`"$O"`) | 7/4 · 7/5 · 6/6 | `x-post.ts:222` | prompt / leave |
| trustr · uncharted · EurekaMS-Landing · vlcrm · promo-video · intelligence-ops | 5/3 · 5/3 · 4/3 · 2/2 · 1/1 · 1/1 | `scope.ts:586`, `dispatch/classifier.ts:314` | prompt |

Split of the 82 code lines: routing and prompt files 44 (prompt), `src/tools/` 24 and other 14 (profile, i.e. optional plugins). `wordpress`/`WP_SITES` (110 lines) is a generic, env-keyed tool and is excluded. `williams` alone also matches the Williams %R indicator in `finance/`, so the pattern above excludes it.

## 4. Existing seams to reuse

`src/config.ts` keys that already abstract an operator or VPS fact. The consumer count is `grep -rnE $S "(config|getConfig\(\)|cfg)\.<field>\b" src | grep -v '^src/config\.ts:' | wc -l`:

| Key (field) | Default | Consumers |
| --- | --- | --- |
| `MC_PORT` (`port`) | 8080 | 3 |
| `MC_DB_PATH` (`dbPath`) | `./data/mc.db` | 3 (+ 6 direct `process.env` reads, 11 lines in all) |
| `MC_API_KEY` (`apiKey`) | required | 2 |
| `MC_MCP_CONFIG` (`mcpConfigPath`) | `./mcp-servers.json` (in `mcp/config.ts:16`) | 1 |
| `HEAVY_RUNNER_IMAGE` (`heavyRunnerImage`) | `mission-control:latest` | 13 |
| `SANDBOX_BACKEND` · `OPENSANDBOX_URL` · `SANDBOX_EGRESS_ALLOW` | docker · `127.0.0.1:8098` · empty | 1 · 1 · 1 |
| `A2A_AGENT_NAME` · `A2A_AGENT_URL` | optional | 1 · 1 |
| `INFERENCE_*` (12 keys), `BUDGET_*`, `TUNING_*`, finance keys | — | provider and cost config, not operator identity |

Operator seams that live **outside** `config.ts` (line count = `grep -rn $S <KEY> src | wc -l`): `RITUALS_TIMEZONE` 6 env-read sites (`grep -rn $S 'process\.env\.RITUALS_TIMEZONE' src`) and 82 lines naming the exported constant, `TELEGRAM_OWNER_CHAT_ID` 14, `MC_DB_PATH` 11, `WHATSAPP_OWNER_JID` 9, `JARVIS_KB_MIRROR_DIR` 9 (+28 `getJarvisKbRoot()` calls), `JARVIS_GH_USER` 4, `JARVIS_GH_EMAIL` 3, `DRIVE_KB_FOLDER_ID` 4, `HINDSIGHT_URL` 4, `ALERT_NOTIFY_PROM_URL` 3, `MC_PROMPT_MODULES_DIR` 3, `WHATSAPP_GROUP_JIDS` 2, `WHISPER_LANGUAGE` 2, `JME_REDACT_ALLOW_EMAILS` 2, `MC_BIND_HOST` 1, `CRM_API_URL` 1, `MC_DECISIONS_DIR` 1, plus the per-account `EMAIL_<ID>_*`. Spread: `src/config.ts` defines 47 keys, while `src/` reads 136 distinct keys through `process.env` (`grep -arhoE $S 'process\.env(\.[A-Z0-9_]+|\["[A-Z0-9_]+"\])' src | grep -oE '[A-Z][A-Z0-9_]+' | sort -u | wc -l`) from 105 files other than `config.ts` (`grep -rlaE $S 'process\.env' src | grep -v '^src/config\.ts$' | wc -l`; 106 with `config.ts` kept; other filters give other numbers, so use this one). This undercounts keys read as `env.X` (e.g. `jarvis-fs.ts:47`).

## 5. Proposed S6 step 2

**Profile shape (fields only):** `operatorName`, `operatorFullName`, `assistantVocative`, `pronoun`, `language` (BCP-47), `locale`, `timezone`, `email`, `channels{telegramChatId, whatsappJid, whatsappGroups[], emailAccounts[]}`, `workspaceRoot`, `installDir`, `kbRoot`, `githubBot{user, email}`, `portfolio[]` (enabled plugin ids).

**Workstream order:**
1. **Profile** — a loader for the shape above. Each field reads its existing env key first (§4), so nothing changes for Fede. `USER_TIMEZONE` (36 consumer lines in 20 files through the constant and its 5 helpers; 21 importers) and the 6 `RITUALS_TIMEZONE` env reads collapse into `profile.timezone`; the 76 other `RITUALS_TIMEZONE` lines keep using the exported constant.
2. **Paths** — `workspaceRoot` replaces the 6 allow-list sites in one commit (security invariant; qa-auditor R1+R2). `installDir` replaces the 48 install-dir lines (49 code lines; one is in the deny-list). The secret deny-list derives from `HOME`.
3. **Channels** — move the delivery email (14 lines) to `profile.email`. Owner ids already come from env, so only wire them into the profile.
4. **Language** — a string table for the 160 harness and channel lines and the 7 ledger prefixes (`isLedgerLine` reads the table). The 93 input matchers get a per-language set. Spanish stays the table's first locale.
5. **Prompt / KB seed** — template the persona (operator name in 43 prompt lines, vocative in 2, `fast-path.ts:78`, the `seedDirectives()` body). Portfolio tools (24 + 15 lines) become optional plugins gated by `profile.portfolio`.

**Paid eval gate (`npm run eval:gate -- --run`):** required by step 5 and by any step 4 change to prompt or tool-description text (557 lines). Template substitution that leaves Fede's rendered prompt byte-identical can be proven with a render-diff test before the paid run, but CLAUDE.md still requires the gate for any system-prompt change.

**Operator rulings needed:**
1. **Profile store:** env keys (fits today's seams; secrets and identity mixed in `.env`), a KB file such as `directives/operator.md` (human-editable; KB is mutable by Jarvis), or a DB row (versioned; `mc.db` is irreplaceable and migration-gated).
2. **Language default:** Spanish stays the product default with a per-operator override, or the string table and prompts move to English-first with Spanish as Fede's profile value (larger eval surface).
3. **Portfolio tools:** become optional plugins off by default (DENUE, CRM, xpoz, radar, vlcms), or stay core with a per-operator disable list. Also: should the 3 phone/LID comment lines and the operator email in 7 top-level doc lines be scrubbed from the public repo?

Tripwires at end: `1791309381 3739` and `190`. Both unchanged.
