# Roadmap — one page

> Read this first in every session; end every session by adding a row to the Session log. Hard cap: one page (~60 lines); one short line per row, detail in the linked docs. Last updated 2026-10-26 (PR #63 merged with 10-26 main: trimmed from 136 lines; nothing deleted). Row text as it stood before each trim, verbatim: `docs/archive/roadmap-detail-2026-10-18.md`, `docs/archive/roadmap-detail-2026-10-26.md` (header note, stage, bets, blocked) and `docs/archive/roadmap-session-log-2026-10.md` (Session log). Production state of record: `docs/PROJECT-STATUS.md` header + `docs/planning/next-sessions-queue.md`.

**Destination: Beta 1.0**, defined in `docs/BETA.md` (from `docs/V8-VISION.md` §8): it works for the first operator with evidence AND any other operator could adopt it. The first operator's setup becomes the first operator profile.

**Platform stance (option A, 2026-10-03):** self-hosted on the VPS; borrow Managed Agents designs, do not run on them; stay competitive in functionality, looping and tool use. **Thesis:** the harness is the lever, not the weights.

## The four Beta tests (evidence and gaps: `docs/BETA.md` §3)

| Test | Where it stands | Next missing piece |
| --- | --- | --- |
| Replicability | Inventory (1,700 sites) + project contract; S6 WS1–WS3b + 3c operator-context gate LIVE; 3f records applied 10-18 | Operator profile (KB file, RULED 10-11), WS4 allow-list, WS6 replicability suite |
| Teachability | Vision, plan docs and first-operator guides only | Onboarding guide (after the profile); one transfer attempt |
| Scalability | Single process; channels clean; projects via records | Language (949 lines), identity, timezone, paths behind the profile |
| Credibility | Honest-done ENFORCE; eval gate v4 (78.63; last compare PASS 10-25, 78.13); W1 count 1 MISSED (34 really done, 3 FP > 2) → count 2 on `prompt_v=2` since 10-19 19:55 UTC: 16 graded, 0 labelled 10-26; W3 step 2 BUILT `c4baf04` + PROVEN 10-20 (`mc-ctl eval`) | W1 count-2 labels to 30 with ≤ 2 FP; W3 ruling A (next build: (ii) vs (iii)) |

## Current stage

V8.1 active (§13 gate v2 on the Morning Sync since 10-06, unproven); V8.2 judgments in shadow; V8.3 first L1→L2 promotion 09-18; V8.4 Honest Done ENFORCE. **V9:** W1 in shadow since 10-06, grader prompt v2 since 10-19; W3 step 1 done, rulings 10-18, step 2 built + proven 10-20; W5 done; W2/W4/W6 no code. Detail: archive detail §Current stage.

## Active bets

| Bet | Gate | Next step | Owner |
| --- | --- | --- | --- |
| W1 verify gate | FP ≤10 % on ≥30 `really done` labels | Count 2 labels in `docs/planning/v9-w1-labels.md` (0/30 labelled of 16 graded), accept latency/cost (n=42: median 16.0 s, $0.20/task), arm `enforce` | Operator |
| W3 internal eval | Read-only report; gate-definition changes logged | Step 2 live as `mc-ctl eval [days] [--json]`; B cadence RULED 10-20 (weekly by hand) · C delegated rating RULED 10-20 (stays queued); next: ruling A build pick, (ii) unverified numbers vs (iii) plan-gate failure rate (queue §2026-10-09 (late) W3 rulings, item 4) | Operator (weekly `./mc-ctl eval 7`) |
| S6 operator abstraction + project contract | `docs/BETA.md` merged ✔ (this PR); replicability suite green | WS1–WS3b, 3c gate, 3f records LIVE; 5a CLOSED 10-19; next: operator profile, WS4, WS6, `tool_approvals.task_id` | S6 |
| Rulings 1–5 in production | Each seen working on a real task | Deployed 10-04, unproven by real use (queue §2026-10-04); ruling 6 parked | VPS |
| L3 A2A | RULED 10-09: stays; never propose retiring | Shim to A2A 1.0 when the operator names the first consumer's date | Operator |
| Done bets | — | Landscape S2 · cloud sessions S1/S1b · W5 S0 · L1 SDK 0.3.285 · L2 · L5 (archive detail §Active bets) | — |

## Review cadence (tiered, routines created 2026-10-03)

- **Weekly** (Mondays): this page + release notes for sources in `docs/LANDSCAPE.md`. Four empty scans in a row → loosen.
- **Event-triggered:** a new Agent SDK minor or platform feature touching a bet is read that week, with pin + `eval:gate`.
- **Monthly** (1st): deep review, S2 method, folded into the upstream review. **Quarterly:** is the cadence paying off?

## Not now

- W4 self-modification (blocked on W3 + V8.3 shadow-Git + L≥3 sign-off). W2 Ralph continuity (after W1). W6 crawl frontier. L4 trace spans.
- Hosted Managed Agents or an external grader (option A). Budget hard-cap enforcement (closed 2026-07-13).

## Blocked on Fede

- W1: label count 2 → accept the latency/cost readout → `enforce` ruling. W3: ruling A (ii) unverified numbers BUILT `8dfbf8bf` (precision first: injected KB + JME count as evidence, essentials/assistant turns never), DEPLOYED 10-28 `afcd642a`; readout `./mc-ctl eval 7` after a week vs 51.7 %, then rule on a consequence + queue (iv) KB self-writes. L3: no consumer date yet (10-27), shim parked.
- BUILT 10-27 evening, DEPLOYED 01:49 UTC 10-28 build `afcd642a` PID 583203 (all four UNPROVEN until their proofs): 4y(i) `947c053a` · 4an (b)(c) `2cc8000a` ((d) premise false, comment only) · 4ao (e)–(h) `f3c3f5ca` · W3 (ii) `8dfbf8bf`; 4 proofs in the queue lines. Pulso web surface independent of the WA client: plan recorded `d5f10fe` (Pulso `docs/WEB-INDEPENDENT-OF-WA-PLAN.md`), NOT NOW. Kept as is: 4an (a), 4aq (c), 4ar (d)(e). Still open: 4am siblings; 4w/4al residuals. VPS: diff the live mc-guard hook against `.claude/hooks/mc-guard.sh` (open since 10-03).
- Open proofs (queue): 4ar `c545822c` DEPLOYED 20:06 UTC (lag line + gauge live; proof: future stalls show `lag_s` ≤ 45) · 4aq `b5e22c1c` DEPLOYED 05:17 UTC (proof: 04:30 UTC 10-28 clean, no :01/:31 lag cluster) · 3r `182b02a5`, 4a Drive `6b7dc893`, 4ai `8b4fb68f` UNPROVEN · 3h UNPROVEN.
- Eval gate: nothing owed; committed incumbent v4 78.63 (`src/tuning/eval-baseline.json`, `f606d04` 10-17), last compare PASS 2026-10-25 (78.13 vs 78.63, PR #64 `a8d328c4`; best candidate 80.38 on 10-22, 4ah); the next prompt, tool-description or classifier change runs `npm run eval:gate -- --run`.

## Session log (older rows: `docs/archive/roadmap-session-log-2026-10.md`)

| Date | Brief | PR | Outcome | Follow-ups |
| --- | --- | --- | --- | --- |
| 2026-10-26 | 4ao `MCEventLoopBlock` on tool calls: `glob`/`list_dir` async (`6e40e6cc`, deployed 20:24 UTC, unproven) + sweep part 1 git/gh/jarvis_dev async (`4a297dbe`, deployed 21:11 UTC build `e29d4c6b`) + part 2 item 1 vps/self-repair async (`61ee3be6`, deployed 21:40 UTC build `d1105b03`) + item 2 rituals async (`46620ac6`, deployed 22:28 UTC build `eceed6b4`) | `6e40e6cc` `4a297dbe` `61ee3be6` `46620ac6` | CI green; proof = next wide glob / git push turn < 1 s | Sweep part 2 + rulings 4ao (e)-(h) |
| 2026-10-26 | PR #63 checked + merged with 10-26 main (cloud draft of 10-18) | [#63](https://github.com/kosm1x/agent-controller/pull/63) | MERGED `5eabc45b` 08:22 UTC: `docs/BETA.md` live, figures refreshed to 10-26; this page 136 → 60 lines, every line archived verbatim; LANDSCAPE confirmed against the lockfile; qa R1 FAIL (stale eval-compare date) folded `3a240d2b`; branch CI green | W3 step-3 rulings; operator profile |
| 2026-10-27 | Same Telegram on the proof night; re-diagnosed read-only from the lag gauge, MC CPU, sda reads (209 MB / 17,456 reads inside the block) and the :01/:31 lag cluster | `b5e22c1c` | Root cause = `idle-detect` `SELECT 1 FROM tasks … updated_at` = `SCAN tasks` (151 MB) on a cold cache, every `*/30` tick (queue 4aq); ruling (a) → migration v10 `idx_tasks_spawn_updated` + `idx_tasks_created_at`, plan-pinning test on the exported SQL, deploy gate → 10; qa R1 folded | DEPLOYED 05:17 UTC `8d3a121d` (v10 applied, live plan SEARCH); proof = no :01/:31 lag cluster 12 h + 04:30 UTC 10-28 clean; 4aq (c). Evening /diagnose (docs): an 8-min Telegram wait = hung `getUpdates` long poll freed only by grammY's silent 500 s client timeout (queue 4ar); ruling (c) → BUILT `c545822c` 19:42 UTC: grammY client `timeoutSeconds: 45`, inbound `lag_s` journal line (warn > 30 s), gauge `mc_telegram_inbound_lag_seconds`; DEPLOYED 20:06 UTC build `d4208dc7` PID 4094038, first inbound 20:07 UTC logged `lag_s=0.7` (gauge live); stale fixed: W3 B/C were RULED 10-20, 4al(b) Stalwart 0.16.27 LIVE 10-25; 14 rulings taken one by one (queue 4an/4ao/4aq/4ar/4y(i)/W3 A/L3 + Pulso web-independent-of-WA); four builds through the full pre-commit run with qa gates (R1→fold→R2 where warned): 4y(i) `947c053a`, 4an (b)(c) `2cc8000a` ((d) premise false), 4ao (e)–(h) `f3c3f5ca` (token out of argv, per-repo mutex, drift refusal), W3 (ii) `8dfbf8bf` (qa R1 FAIL: essentials = stored Jarvis replies → dropped); CI red once on `typecheck:tests` (fixture type) → `68453f1a`; DEPLOYED 2026-10-28 01:49:37 UTC build `afcd642a` PID 583203 (health 200 / 175 ms, 0 startup errors) |
| 2026-10-29 | Watchdog mc.db alarm diagnosed: freelist 1.7 %, file = live 90-day data (prompt 38.5 KB/turn, embeddings 97 MB); option 1 ruled | — | check 7 rewritten `ff9c0bb3` (freelist ≥ 20 % / size ≥ 1 GB), LIVE via cron, no deploy; PROVEN 22:05 UTC 10-30 (no `ACTION: mc.db at` line after the fix, every tick OK through 01:55 UTC 10-31) | 4as: NEXT = prompt-section measurement (read-only) → trim ruling · embeddings folded into the pgvector plan |
| 2026-10-30 | PR 65 (Jarvis: X duplicate guard, exit 8) reviewed, fixed and merged: override is operator-shell-only via the cgroup gate, KB protocol row 8, pins + pure `overrideAllowed`; pre-commit from a linked worktree let two fixtures `git init` the REAL repo as bare (06:16 UTC, operator repaired 06:24) → fixtures scrub `GIT_*` + vitest per-worker backstop | `23468deb` `65c5ac09` → merge `1ced6612` | squash-merged 06:39 UTC, pulled on the VPS (script runs from the tree, no deploy); 13,972 tests | PROVEN 19:01 UTC 10-30 (task 12778: attempt recorded 19:01:15, receipt 19:01:20, `completed`, no `OVERRIDE_IGNORADO`, no "not confirmed"); queue 4at (R1 agent shells pass the gate · R2 guard before browser launch · 30 s timeout misreports) |
| 2026-10-31 | 46 tasks stuck at `blocked` = scope-request legs ("Necesito shell_exec") that the scope-miss auto-widen re-runs as a new task and never closes; first build aimed at confirmation cards (0 live rows) → qa R1 FAIL → retargeted | `566c573b` | BUILT 02:42 UTC, 13,989 tests, qa R2 PASS-W → folds → R3 PASS; re-run cancels its first leg (`superseded by scope-widened re-run <id>`), schema v11 = `tool_approvals.task_id` + one-time backfill (44 rows > 7 d) — DEPLOY OWED | proof = next scope-miss re-run leaves 0 new `blocked` rows; blocked count 46 → ≤ 2 after deploy; queue 4au |
