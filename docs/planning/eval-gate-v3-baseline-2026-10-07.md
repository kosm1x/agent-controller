# Eval gate — scoring-v3 baseline capture (2026-10-07)

Queue §2026-10-07 item 6. `SCORING_VERSION = 3` (multi-round probe, `dcac186`) left the committed v2 baseline unusable: every compare run exited 2 before any spend. This records the v3 capture, what was checked before accepting it, and the per-case table.

## Result

| | v2 incumbent (2026-10-04 04:04 UTC) | v3 incumbent (2026-10-07 05:46 UTC) |
|---|---|---|
| Composite | 76.87 | **85.01** |
| Tool selection (50 %) | 53.75 | **70.03** |
| Scope accuracy (30 %) | 100 | 100 |
| Classification (20 %) | 100 | 100 |
| Cases (all / tool_selection / probed / excluded) | 263 / 188 / 163 / 25 | 261 / 187 / 162 / 25 |
| Probe | 1 round | 3 rounds (default) |
| Fast-tier model in the probe | claude-sonnet-5-5 (canary drop-in; journal override line at every start since 10-03); effort not recorded | claude-sonnet-5-5, `SONNET_EFFORT=low` (live env, MainPID 2079410) |

Run: `npm run eval:gate -- --run --update-baseline --percase-out=data/predeploy/eval-percase-v3-20261007.json` from the repo root with `JARVIS_KB_MIRROR_DIR` pointed at a scratch dir. 162 probe calls, **$7.60** (sum of the SDK `Completed:` lines; the gate's own `est.cost` line said $4.86 because it is calibrated on single-round probes), 1,613 s, 10.0 M tokens. All 162 calls ran on `claude-sonnet-5-5`; no Haiku fallback, no 429/overload, 0 errored probes. The gate has no `--max-usd` flag. The run was watched and would have been killed at $15. The snapshot db was deleted on exit, and the live `mc.db` was never written: the working tree's pending `cost_ledger.cost_basis` migration applied only to the snapshot.

Pre-spend proof on the new file (free; it runs the compare path's two refusals with mock inference against a fresh snapshot): `preSpendRefusal` null, `preSpendPopulationRefusal` null, drift 0 new / 0 gone / 0 newly excluded. So a compare run now proceeds to a verdict (exit 0/1) instead of exiting 2. The same check against the v2 file returned the "older scoring (scoringVersion 2, current 3)" refusal.

## Why 85.01 is not comparable to 76.87

The two numbers come from different scorers, and the gate refuses to compare across `scoringVersion` on purpose. v2 scored only the probe's first round, so a sensible first step (search, list, status) counted as a miss for the tool that finishes the job. v3 counts an expected tool called in any of 3 rounds. The populations also differ slightly: 163 → 162 probed (the two NorthStar-sync cases were deactivated on 10-06). Counting probed and excluded cases together, 7 v2 cases are gone and 6 are new.

Case-level transitions v2 → v3 over the 162 probed cases:

- **32 improved.** 17 cases that were misses under v2 now hit in round 2. 15 now hit in round 1. Round 1 is the same probe under both scorers, so these come from run-to-run variance or from effort: the v2 capture's `SONNET_EFFORT` was not recorded.
- **1 regressed**: a mined case went from hit-r1 to called-nothing. This is single-sample noise; round 1 is the same probe in both scorers.
- Everything else is unchanged or new: 75 hit-r1 → hit-r1, 1 hit-r1 → hit-r2 (same score), 5 forbidden-only passes, 1 violation, 42 misses → misses, and 5 newly probed flywheel cases (1 hit).

The +16.3 tool-selection points are therefore mostly the scorer change, not the model. Both captures ran on the same fast-tier model id.

## The 48 misses (score 0), classified

| class | n | what happens |
|---|---|---|
| **Structural: discovery then stop** | 32 | Round 1 (and sometimes round 2) calls only discovery tools (`jarvis_file_search`, `jarvis_file_list`, `project_list`, `gdrive_list`, `task_history`, …). The generic simulated result ("the call succeeded, continue") carries no path, id or data, so the model has nothing to read or write and ends with text. 22 stop after round 1, 10 after round 2. Parallel round-1 calls do continue: 15 cases with more than one round-1 call hit in round 2, so this is not a probe bug. It is the limitation documented in the `scripts/eval-gate.ts` header. |
| Model: no tool (answered or asked) | 13 | No call in any round. Seed examples: `ts-chart-01` asks for bar-chart data that the message does not give, and `ts-gmail-send-01` ("send the report") does not say which report. Both are defensible clarifications from an under-specified case. The probe also sends no system prompt. |
| Model: other tool | 2 | `project_update` where `jarvis_file_update` was expected; `jarvis_file_read` where `file_read` was expected. |
| Model: forbidden call | 1 | A mined negative-feedback case: `jarvis_file_write` in round 2. Also a violation in v2. |

Seed misses read in full (the messages are public in `src/tuning/seed-cases.json`):

- `ts-dashboard-01` gathers metrics (`vps_status`, `list_schedules`, `task_history`, `project_list`) and gets no data back.
- `ts-delete-01` searches for the task file and gets no path back.
- `ts-gmail-01` and `ts-screenshot-01` look up the project or blog first, and the simulated result gives no summary or URL.
- `ts-northstar-list-01` lists, then searches, then stops without a path.
- `ts-schedule-task-01` checks `list_schedules` first.

All six are structural.

**Verdict on accepting the baseline:** the artefact is real and large. If all 32 structural misses were hits, tool selection would read about 90 instead of 70, so it moves the composite by about 10 points. It does not dominate the score: 114 of 162 probed cases pass, and the artefact is a fixed property of the probe that a same-probe compare run carries on both sides. Baseline written.

Caveat for model swaps: the artefact penalises a candidate that checks before it acts more than one that acts directly. Read a FAIL whose per-case shift sits in the "discovery then stop" class as a probe effect before calling it a regression.

The flywheel group scores 14.29 (1 of 7). These cases are pinned from past failures, so they are hard by construction; 5 of the 6 misses are discovery-then-stop.

## Privacy

Seed cases (group `seed`, 34 probed) are synthetic and committed in `src/tuning/seed-cases.json`; all 101 active seed rows in `tune_test_cases` are in that file. Mined and flywheel cases come from real traffic. They are listed below only by the same 16-hex sha256 digest the baseline stores (`caseIdDigest`), with tool names and outcomes and no message text. The full per-case file stays in the gitignored `data/predeploy/eval-percase-v3-20261007.json` (mode 600).

## Per-case table (162 probed tool_selection cases)

Outcome key: `hit-rN` = an expected tool was called first in round N; `forbidden-pass` = a forbidden-only case with no forbidden call; `called-other` = only non-expected tools; `called-nothing` = no tool call in any round; `absent` = the case was not in the v2 population. The 25 excluded cases (nothing checkable offered: `shell_exec` scoped out ×13, `mcp__sequential-thinking` not registered ×4, WordPress and others scoped out) are the same 25 as in v2 and are not listed.

| # | group | case | weight | v2 (10-04) | v3 (10-07) | v3 score | expected tools | miss class |
|---|---|---|---|---|---|---|---|---|
| 1 | seed | ts-calendar-01 | 1 | hit-r1 | hit-r1 | 1 | calendar_list |  |
| 2 | seed | ts-chart-01 | 1 | called-nothing | called-nothing | 0 | chart_generate | model: no tool (answered/asked) |
| 3 | seed | ts-dashboard-01 | 1 | called-other | called-other | 0 | dashboard_generate | structural: discovery then stop |
| 4 | seed | ts-delete-01 | 1 | called-other | called-other | 0 | jarvis_file_write | structural: discovery then stop |
| 5 | seed | ts-file-read-01 | 1 | hit-r1 | hit-r1 | 1 | file_read |  |
| 6 | seed | ts-followup-01 | 1.5 | hit-r1 | hit-r1 | 1 | web_search |  |
| 7 | seed | ts-gdrive-01 | 1 | hit-r1 | hit-r1 | 1 | gdrive_list |  |
| 8 | seed | ts-gemini-podcast-01 | 1 | hit-r1 | hit-r1 | 1 | gemini_audio_overview |  |
| 9 | seed | ts-gemini-research-01 | 1 | hit-r1 | hit-r1 | 1 | gemini_research |  |
| 10 | seed | ts-gemini-upload-01 | 1 | hit-r1 | hit-r1 | 1 | gemini_upload |  |
| 11 | seed | ts-git-commit-01 | 1 | called-other | hit-r2 | 1 | git_commit |  |
| 12 | seed | ts-gmail-01 | 1 | called-other | called-other | 0 | gmail_send | structural: discovery then stop |
| 13 | seed | ts-gmail-send-01 | 1.5 | called-nothing | called-nothing | 0 | gmail_send | model: no tool (answered/asked) |
| 14 | seed | ts-greeting-01 | 1 | forbidden-pass | forbidden-pass | 1 |  |  |
| 15 | seed | ts-image-gen-01 | 1 | hit-r1 | hit-r1 | 1 | gemini_image |  |
| 16 | seed | ts-intel-query-01 | 1 | hit-r1 | hit-r1 | 1 | intel_query |  |
| 17 | seed | ts-multi-tool-01 | 1.5 | hit-r1 | hit-r1 | 1 | web_search, user_fact_set |  |
| 18 | seed | ts-northstar-create-01 | 1 | called-other | hit-r2 | 1 | jarvis_file_write |  |
| 19 | seed | ts-northstar-list-01 | 1 | called-other | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 20 | seed | ts-northstar-no-create-01 | 1.5 | hit-r1 | hit-r1 | 1 | web_search |  |
| 21 | seed | ts-project-01 | 1 | hit-r1 | hit-r1 | 1 | project_list |  |
| 22 | seed | ts-rss-01 | 1 | hit-r1 | hit-r1 | 1 | rss_read |  |
| 23 | seed | ts-schedule-01 | 1 | called-other | hit-r2 | 1 | schedule_task |  |
| 24 | seed | ts-schedule-task-01 | 1 | called-other | called-other | 0 | schedule_task | structural: discovery then stop |
| 25 | seed | ts-screenshot-01 | 1 | called-other | called-other | 0 | screenshot_element | structural: discovery then stop |
| 26 | seed | ts-shell-01 | 1 | called-other | hit-r1 | 1 | shell_exec |  |
| 27 | seed | ts-skill-01 | 1 | hit-r1 | hit-r1 | 1 | skill_list |  |
| 28 | seed | ts-task-history-01 | 1 | hit-r1 | hit-r1 | 1 | task_history |  |
| 29 | seed | ts-user-fact-01 | 1 | hit-r1 | hit-r1 | 1 | user_fact_set |  |
| 30 | seed | ts-vps-status-01 | 1.5 | hit-r1 | hit-r1 | 1 | vps_status |  |
| 31 | seed | ts-vps-status-02 | 1 | hit-r1 | hit-r1 | 1 | vps_status |  |
| 32 | seed | ts-web-read-01 | 1 | hit-r1 | hit-r1 | 1 | web_read |  |
| 33 | seed | ts-web-search-01 | 1 | hit-r1 | hit-r1 | 1 | web_search |  |
| 34 | seed | ts-web-search-02 | 1 | hit-r1 | hit-r1 | 1 | web_search |  |
| 35 | mined | `002fffe7e7e9c159` | 0.6 | called-nothing | called-nothing | 0 | jarvis_file_read, jarvis_file_list, jarvis_file_write | model: no tool (answered/asked) |
| 36 | mined | `0217f86a3817db1a` | 0.6 | called-other | hit-r2 | 1 | shell_exec |  |
| 37 | mined | `0360271f31979279` | 0.8 | forbidden-pass | forbidden-pass | 1 |  |  |
| 38 | mined | `081f60817092bbd1` | 0.6 | called-other | hit-r2 | 1 | web_search, web_read |  |
| 39 | mined | `0825d15ea8bd6460` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, tweet_post, jarvis_file_write |  |
| 40 | mined | `098ee21ba0e629cd` | 0.6 | called-nothing | called-other | 0 | shell_exec, browser_navigate, web_read | structural: discovery then stop |
| 41 | mined | `0d5c2887c2757780` | 0.6 | called-nothing | called-other | 0 | jarvis_file_read, jarvis_file_list, jarvis_file_write | structural: discovery then stop |
| 42 | mined | `11a225485f8216cf` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_list, jarvis_file_update |  |
| 43 | mined | `11a399be0a41b791` | 0.6 | called-nothing | hit-r1 | 1 | web_search, web_read, gmail_send |  |
| 44 | mined | `12542b0bcfc71027` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, web_read, jarvis_file_write |  |
| 45 | mined | `135cf8a595069af6` | 0.6 | called-other | called-other | 0 | jarvis_file_search, jarvis_file_update | model: other tool |
| 46 | mined | `17418f145e5c1239` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, exa_search |  |
| 47 | mined | `175b1d5a36b143e2` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, gdocs_read_full, jarvis_file_search |  |
| 48 | mined | `1b3819cf915b7e21` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 49 | mined | `1dbc78dd4d02e1b2` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_list, calendar_list, jarvis_file_read |  |
| 50 | mined | `1def57f4645ab573` | 0.6 | hit-r1 | hit-r1 | 1 | shell_exec |  |
| 51 | mined | `1e71a838c08faac1` | 0.6 | called-other | called-other | 0 | ToolSearch, file_read, file_write | model: other tool |
| 52 | mined | `1fef1376c57aa261` | 0.6 | hit-r1 | called-nothing | 0 | jarvis_file_read, jarvis_file_write | model: no tool (answered/asked) |
| 53 | mined | `232c72dd7d923a57` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search, jarvis_file_read |  |
| 54 | mined | `233546d5cf8e1163` | 0.6 | called-other | hit-r2 | 1 | ToolSearch, shell_exec, jarvis_file_write |  |
| 55 | mined | `248ebe55bb83ec79` | 0.6 | called-other | hit-r2 | 1 | mcp__sequential-thinking__sequentialthinking, web_search, jarvis_file_write |  |
| 56 | mined | `2520aa513f434952` | 0.6 | called-other | called-other | 0 | jarvis_file_read, jarvis_file_update | structural: discovery then stop |
| 57 | mined | `26d81c6de82912fe` | 0.6 | called-other | hit-r1 | 1 | jarvis_file_search, jarvis_file_read |  |
| 58 | mined | `2a3be884ad68f38b` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_search, gslides_create |  |
| 59 | mined | `2b0d7a61df3c16fa` | 0.6 | called-nothing | called-nothing | 0 | user_fact_set | model: no tool (answered/asked) |
| 60 | mined | `2c45db76788b15a6` | 0.6 | hit-r1 | hit-r1 | 1 | ToolSearch, jarvis_dev |  |
| 61 | mined | `2f46e54f6e9cd630` | 0.6 | called-other | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 62 | mined | `2fbe5a23ca46ea9c` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 63 | mined | `30da00b8e0e7121a` | 0.6 | hit-r1 | hit-r1 | 1 | shell_exec |  |
| 64 | mined | `333f30f5a40cfbd4` | 0.6 | called-nothing | hit-r2 | 1 | web_search, exa_search |  |
| 65 | mined | `33e155e1ca16a355` | 0.6 | called-other | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 66 | mined | `342da92ad40220c3` | 0.6 | called-nothing | called-nothing | 0 | web_search | model: no tool (answered/asked) |
| 67 | mined | `3c2e751d900c5554` | 0.6 | hit-r1 | hit-r1 | 1 | shell_exec |  |
| 68 | mined | `4325cc1a7dfcadf0` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 69 | mined | `48e4a1687857b8aa` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 70 | mined | `4a8c2001cfa31b41` | 0.6 | called-nothing | called-other | 0 | mcp__sequential-thinking__sequentialthinking, jarvis_file_read, jarvis_file_write | structural: discovery then stop |
| 71 | mined | `4b6e900c16baf727` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, tweet_post, jarvis_file_write |  |
| 72 | mined | `4dedd6717541d563` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 73 | mined | `51712ab3d2e6aa67` | 0.6 | hit-r1 | hit-r2 | 1 | schedule_task |  |
| 74 | mined | `518acbcdb64bc2b5` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 75 | mined | `53240dca329cc203` | 0.6 | called-other | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 76 | mined | `534607b91b0ecbef` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, shell_exec |  |
| 77 | mined | `55531af3c7688b8d` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search, jarvis_file_read, gslides_create |  |
| 78 | mined | `5b5f18083cd8104c` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_search, web_search |  |
| 79 | mined | `5f7d5dffc1cb7917` | 0.6 | called-other | called-other | 0 | jarvis_file_read, jarvis_file_write | structural: discovery then stop |
| 80 | mined | `62451fc030369c4d` | 0.6 | called-nothing | called-nothing | 0 | task_history, jarvis_file_read | model: no tool (answered/asked) |
| 81 | mined | `69679df1414e44c1` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 82 | mined | `6b0ae72c63a6f28f` | 0.6 | called-nothing | called-nothing | 0 | jarvis_file_search, gdrive_create, gdocs_replace | model: no tool (answered/asked) |
| 83 | mined | `73310a9aca252a98` | 0.6 | called-other | called-other | 0 | gsheets_read, gsheets_write | structural: discovery then stop |
| 84 | mined | `733aeeef2e871fb2` | 0.6 | called-other | hit-r2 | 1 | shell_exec, jarvis_file_read, jarvis_file_write |  |
| 85 | mined | `74192ec739071cac` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, web_read, gmail_send |  |
| 86 | mined | `76a90a18affd738e` | 0.6 | called-other | hit-r2 | 1 | jarvis_file_write |  |
| 87 | mined | `7bafc554ec7f4eed` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, exa_search |  |
| 88 | mined | `7f36f1891edea2f7` | 0.6 | called-other | called-other | 0 | jarvis_file_read, shell_exec | structural: discovery then stop |
| 89 | mined | `8044ceb3ed02acf8` | 0.6 | called-other | hit-r2 | 1 | jarvis_file_read, jarvis_file_list |  |
| 90 | mined | `8052ee7e68c96ac8` | 0.6 | hit-r1 | hit-r1 | 1 | web_search |  |
| 91 | mined | `8125fd452d359c1b` | 0.6 | called-other | called-other | 0 | gsheets_read, gsheets_write | structural: discovery then stop |
| 92 | mined | `845528ee3039e58c` | 0.6 | hit-r1 | hit-r1 | 1 | web_read, mcp__playwright__browser_navigate, exa_search |  |
| 93 | mined | `84934cb7024ee63d` | 0.6 | called-nothing | hit-r1 | 1 | web_search, gmail_send |  |
| 94 | mined | `8617bc9a0fea266c` | 0.6 | hit-r1 | hit-r1 | 1 | file_read |  |
| 95 | mined | `864ccd6a576d863e` | 0.6 | called-other | called-other | 0 | project_update, jarvis_file_write | structural: discovery then stop |
| 96 | mined | `8881698e3b09b02c` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search, web_read, file_read |  |
| 97 | mined | `88903c00d2c1f374` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search, jarvis_file_read |  |
| 98 | mined | `8ad04ae036c13228` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search, jarvis_file_read |  |
| 99 | mined | `8b493b8d870030ba` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_search |  |
| 100 | mined | `8ec9c5f702afe0cc` | 0.6 | called-other | called-other | 0 | gsheets_read, gsheets_write | structural: discovery then stop |
| 101 | mined | `8ee5f4d114c2e263` | 0.6 | hit-r1 | hit-r1 | 1 | gdrive_list, gdrive_create, gsheets_write |  |
| 102 | mined | `91e4c91b30bea038` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_search, jarvis_file_update |  |
| 103 | mined | `9247e03b7b6ca30c` | 0.6 | called-nothing | called-nothing | 0 | web_search | model: no tool (answered/asked) |
| 104 | mined | `92ad239b699319dc` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, ToolSearch, tweet_post |  |
| 105 | mined | `9a169b255441126b` | 0.6 | hit-r1 | hit-r1 | 1 | file_read |  |
| 106 | mined | `9ce237fdb0454ed1` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 107 | mined | `9ece5b6e062bd407` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 108 | mined | `a3097ac058c60ba9` | 0.6 | called-other | called-other | 0 | code_search, file_read | structural: discovery then stop |
| 109 | mined | `aa979f7e39f74c90` | 0.6 | hit-r1 | hit-r1 | 1 | skill_list, mcp__playwright__browser_evaluate, skill_save |  |
| 110 | mined | `aaaff04d2af8bf4b` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_search |  |
| 111 | mined | `ab22ebe649fb598d` | 0.6 | called-nothing | called-other | 0 | jarvis_file_read, jarvis_file_list, gslides_create | structural: discovery then stop |
| 112 | mined | `b1e3821aa9bbbc0e` | 0.6 | called-nothing | called-other | 0 | mcp__sequential-thinking__sequentialthinking, web_search, shell_exec | structural: discovery then stop |
| 113 | mined | `b33f7aae7582a611` | 0.6 | called-nothing | called-other | 0 | jarvis_file_read, jarvis_file_list, jarvis_file_write | structural: discovery then stop |
| 114 | mined | `b4af4cd9ac26935d` | 0.6 | hit-r1 | hit-r1 | 1 | skill_list, mcp__playwright__browser_evaluate, skill_save |  |
| 115 | mined | `b8f823b35d97f582` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_list, jarvis_file_write |  |
| 116 | mined | `bd2e262bf23727a3` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 117 | mined | `be00389007550204` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, web_read, file_read |  |
| 118 | mined | `beda2c034a75f9f6` | 0.6 | hit-r1 | hit-r1 | 1 | prediction_markets, pm_alpha_run, pm_paper_rebalance |  |
| 119 | mined | `bf5b50f496181507` | 0.6 | called-nothing | hit-r2 | 1 | jarvis_file_write |  |
| 120 | mined | `c13836e3bc78384a` | 0.6 | called-other | hit-r2 | 1 | gemini_image, shell_exec, wp_media_upload |  |
| 121 | mined | `c1637f31381e8161` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, jarvis_file_search |  |
| 122 | mined | `c26f90b94d89c92b` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 123 | mined | `c2d4508ecb26857a` | 0.6 | called-nothing | called-nothing | 0 | jarvis_file_write | model: no tool (answered/asked) |
| 124 | mined | `c3df54b30ce4ba12` | 0.6 | called-other | called-other | 0 | jarvis_file_read, file_edit, shell_exec | structural: discovery then stop |
| 125 | mined | `c79190a0147185e6` | 0.6 | called-nothing | hit-r2 | 1 | web_search, ToolSearch |  |
| 126 | mined | `cb7dcf6cad8d40c7` | 0.8 | forbidden-pass | forbidden-pass | 1 |  |  |
| 127 | mined | `cc470dab5d8723e8` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 128 | mined | `d39acdc1f0f926fa` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 129 | mined | `d51e37dae01c1702` | 0.6 | called-other | hit-r2 | 1 | jarvis_file_write |  |
| 130 | mined | `d58ac66dfcb889bf` | 0.6 | called-other | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 131 | mined | `d7d6de924a0604c5` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 132 | mined | `db63b830caaad84f` | 0.6 | called-other | hit-r1 | 1 | gdrive_create, gdocs_replace |  |
| 133 | mined | `db70c0c98a71d451` | 0.6 | called-nothing | called-nothing | 0 | jarvis_file_read, jarvis_file_write | model: no tool (answered/asked) |
| 134 | mined | `dbdfd3b4150f9ccc` | 0.6 | called-nothing | called-other | 0 | web_search, web_read | structural: discovery then stop |
| 135 | mined | `dd3bbde6df47f3c1` | 0.6 | hit-r1 | hit-r1 | 1 | mcp__sequential-thinking__sequentialthinking, web_search |  |
| 136 | mined | `ddd6d6c0eb9208bf` | 0.8 | forbidden-pass | forbidden-pass | 1 |  |  |
| 137 | mined | `dfe56e8fa8509220` | 0.6 | hit-r1 | hit-r1 | 1 | shell_exec |  |
| 138 | mined | `e2bf4e009ac765b6` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_list, calendar_list, jarvis_file_read |  |
| 139 | mined | `e3190d8cad730cd7` | 0.6 | hit-r1 | hit-r1 | 1 | list_schedules |  |
| 140 | mined | `e9b5e113d1d14710` | 0.6 | hit-r1 | hit-r1 | 1 | code_search, file_read |  |
| 141 | mined | `ea4c9624a5ff37bb` | 0.6 | called-nothing | hit-r1 | 1 | web_search, web_read, gmail_send |  |
| 142 | mined | `ec2774843e7d9512` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read |  |
| 143 | mined | `eece54b8cbc4ce9d` | 0.6 | called-other | hit-r2 | 1 | shell_exec |  |
| 144 | mined | `eee9279acf90bfb3` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 145 | mined | `f039e122a81fe798` | 0.6 | called-nothing | called-nothing | 0 | jarvis_file_write | model: no tool (answered/asked) |
| 146 | mined | `f1d17f33d0609fbe` | 0.6 | called-nothing | hit-r1 | 1 | shell_exec |  |
| 147 | mined | `f42906512c13d579` | 0.6 | called-nothing | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 148 | mined | `f5f1b55c7f45ff39` | 0.6 | hit-r1 | hit-r1 | 1 | web_search, gmail_send |  |
| 149 | mined | `f5f7a0aa47f33d2f` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_list, calendar_list, jarvis_file_read |  |
| 150 | mined | `f7cf7571c03e6e83` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, shell_exec |  |
| 151 | mined | `f9376a0a9d537815` | 0.6 | called-other | hit-r2 | 1 | jarvis_file_read |  |
| 152 | mined | `fb2b00cb5b2afe04` | 0.6 | called-nothing | hit-r1 | 1 | jarvis_file_read, jarvis_file_write |  |
| 153 | mined | `fb9567b37877474c` | 0.8 | forbidden-pass | forbidden-pass | 1 |  |  |
| 154 | mined | `fc264e7fcc939e84` | 0.8 | violation | violation | 0 |  | model: forbidden call |
| 155 | mined | `ff2c3abaa8d06063` | 0.6 | hit-r1 | hit-r1 | 1 | jarvis_file_read, project_list, gmail_send |  |
| 156 | flywheel | `46208dfaa179341c` | 1 | called-other | called-other | 0 | git_status, jarvis_dev, shell_exec | structural: discovery then stop |
| 157 | flywheel | `48bcfe67dbc023a7` | 1 | absent | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 158 | flywheel | `593f16d2afc56776` | 1 | called-nothing | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 159 | flywheel | `7b2b920141686147` | 1 | absent | hit-r1 | 1 | gdrive_list, gdrive_create, gdocs_write |  |
| 160 | flywheel | `aa8688142667d93d` | 1 | absent | called-nothing | 0 | gdrive_create, gsheets_write | model: no tool (answered/asked) |
| 161 | flywheel | `c2b7a6d7736fe1a2` | 1 | absent | called-other | 0 | jarvis_file_read | structural: discovery then stop |
| 162 | flywheel | `eab14413d38d836d` | 1 | absent | called-other | 0 | file_read, gslides_create | structural: discovery then stop |
