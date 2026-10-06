# Roadmap — one page

> Read this first in every session; end every session by adding a row to the Session log. Hard cap: one page (~60 lines). Detail lives in the linked docs, not here. Last updated 2026-10-05 (V8.2 gather + revision ledger; PDF pdftotext fallback; page trimmed). Full text of trimmed Session log rows: `docs/archive/roadmap-session-log-2026-10.md`.

**Destination: Beta 1.0** (`docs/V8-VISION.md` §8). Decided 2026-10-03: Beta means both (a) it works for Fede, with evidence, and (b) any other operator could adopt it. Fede is the first operator and super beta tester; his setup becomes the first operator profile, not a special case.

**Platform stance (decided 2026-10-03, option A):** Jarvis stays self-hosted on the VPS. Nothing runs on hosted Managed Agents; borrow their designs. Goal: stay competitive with managed agents in functionality, looping and tool use while holding to the vision. **Thesis:** the harness is the lever, not the weights (`docs/V9-ROADMAP.md` §1).

## The four Beta tests

| Test | Evidence today | Missing |
| --- | --- | --- |
| Replicability | V8.4 completion ledger, eval:gate with committed incumbent, decision logs | Written operator model; inventory of what is hardcoded to Fede/VPS (S6) |
| Teachability | Vision + V8/V9 docs, CLAUDE.md | Any transfer attempt; operator onboarding doc (S6) |
| Scalability | Single-process design, `SANDBOX_BACKEND` seam | Per-operator config for identity, language, paths, channels, KB seed (S6) |
| Credibility | Honest-done gates ENFORCE since 2026-08-27; incident history in `docs/archive/status-history-*` | Internal measurement answering V8-VISION §7 (W3, S5) |

## Current stage

V8.1 active (08:00 Morning Sync is the surface); V8.2 judgments in shadow; V8.3 Phases 0–7 done, first L1→L2 promotion 2026-09-18; V8.4 Honest Done ENFORCE armed. **W1 is live in shadow (#60 + pre-arm fixes `d0d95a8`; `TASK_GATES_GRADER=shadow` armed 2026-10-06 03:35 UTC, first trace pending); W2–W6 have no code.** Source: `docs/PROJECT-STATUS.md` header, `docs/V9-ROADMAP.md` §3.

## Active bets

| Bet | Gate | Next step | Session |
| --- | --- | --- | --- |
| W1 verify gate | **Shadow armed 2026-10-06** ([#60](https://github.com/kosm1x/agent-controller/pull/60) `e9d7efb` 10-04 + `d0d95a8` 10-06; `TASK_GATES_GRADER=shadow`): shadow FP ≤10% on ≥30 labelled runs | In order: breaker fix (live) → item 11 (b)–(e) (`d0d95a8` live 10-06) → `eval:gate -- --run` → Fede arms `shadow` and labels via `mc-ctl gates graded` (decision note §6) | S4 done → Phase 5 (operator) |
| W1 pre-arm fixes | typecheck + scoped vitest; implementer + qa-auditor | **Done 2026-10-06** (breaker fix `21e2386` live 10-04; item 11 (b)–(e) `d0d95a8`, R1+R2 audits, deployed 10-06 03:1x UTC). Left before arming: enforce-mode cap (queue §2026-10-06 item 1) only matters for `enforce` | Operator: eval gate → arm `shadow` |
| Rulings 1–5 in production | Each ruling seen working on a real task (credential by name, outbound scrub, docker read, expiry notice); critic SQL guard on a real critic run | Deployed 2026-10-04, unproven by real use; first nightly tuning run under scoring v2; queue §2026-10-04 items 1–10, 12–15 | VPS |
| W3 internal eval, reshaped | Uses existing gate/outcome/eval data; gate-definition changes logged with old-definition number | Inventory real row counts, paired comparisons vs explicit-direction baseline | S5 |
| Landscape review | Every item has a primary source and a verdict (build / adopt / borrow / ignore) | **Done in S2:** register `docs/LANDSCAPE.md`; inputs folded into S3, S5, W2 | S2 |
| L1 Agent SDK 0.3.245 → 0.3.288 | `eval:gate -- --run` passes (VPS) | `verbatimPrompts`, snapshot check, telemetry caveat, MCP timeout | L1 (operator) |
| L2 MCP result fidelity | typecheck + scoped vitest; implementer + qa-auditor | Bridge keeps `structuredContent` + resource links; SDK 1.32.0 within caret | L2 (cloud) |
| L5 Stop-hook own deadline + trace | typecheck + scoped vitest; implementer + qa-auditor | Gates hook past 180 s stops silently, already at the current pin; not tied to L1 | L5 (cloud) |
| L3 A2A: interop or retire | VPS data, then operator ruling | Is A2A used at all? Then shim to A2A 1.0 or retire (ties to S6) | L3 |
| Beta scope + operator abstraction | `docs/BETA.md` merged | Hardcoded-to-Fede inventory, first transferability workstream | S6 |
| Cloud-session support | Clean clone runs hook; agents + skills load; guards match the VPS | **Done in S1 + S1b.** VPS-only: `eval:gate` (even dry), `mc-ctl`, prod data, deploy | S1, S1b |
| W5 loop vocabulary | Doc only | **Done in S0** (CLAUDE.md) | S0 |

## Review cadence (tiered, routines created 2026-10-03)

- **Weekly** (Mondays): read this page + release notes for sources in `docs/LANDSCAPE.md`. Output: what changed an answer to a Beta question; items past their trigger. Four empty scans in a row → loosen.
- **Event-triggered:** a new Agent SDK minor or platform feature touching a bet gets read that week, alongside pin + `eval:gate`.
- **Monthly** (1st): deep review using the S2 method, folded into the existing upstream review.
- **Quarterly:** short retrospective on whether the cadence pays off.

## Not now

- W4 self-modification (blocked on W3 + V8.3 shadow-Git + L≥3 sign-off).
- W2 Ralph continuity (after W1). W6 crawl frontier (background only). L4 trace spans (after S5).
- Hosted Managed Agents or an external grader (option A). Budget hard-cap enforcement (closed 2026-07-13).

## Blocked on Fede

- W1: pre-arm fixes live (`d0d95a8`) and `eval:gate -- --run` PASSED 2026-10-06 03:3x UTC (composite 75.70 vs incumbent 76.87, delta −1.18 within ε 2; 239 cases, 0 errored probes, $4.92). `TASK_GATES_GRADER=shadow` ARMED 03:35 UTC (drop-in `v9-grader.conf`, PID 3625470). Next = first `gates.graded` trace, then label ≥30 runs in `docs/planning/v9-w1-labels.md` ("excelente" = really done, explicit negative = not done, rest by hand from `mc-ctl gates graded`). Also owed: weekly count of gradeable tasks.
- Eval gate: the committed baseline (`src/tuning/eval-baseline.json`, 2026-10-04 04:04 UTC, 76.87) predates #60's `src/` changes; the 10-06 run passed against it. A re-capture (`npm run eval:gate -- --run --update-baseline`, ~$5) is still owed BEFORE the next Jarvis system-prompt / tool-description change, so that change is measured against today's code, not 10-04's.
- Ruling 5a: the read-only DB role (operator-run DDL).
- L1: run the Agent SDK bump with `npm run eval:gate -- --run` on the VPS (cloud sessions cannot).
- L3: after the VPS A2A-usage check, rule shim-to-1.0 or retire.

## Session log

| Date | Brief | PR | Outcome | Follow-ups |
| --- | --- | --- | --- | --- |
| 2026-10-03 | Rulings 1–5 finish (cloud) | [#57](https://github.com/kosm1x/agent-controller/pull/57) | Ruling 3 rounds 6–9 + combined audit; merged. | Deployed 10-04 (Active bets) |
| 2026-10-03 | S2 landscape review #1 | [#55](https://github.com/kosm1x/agent-controller/pull/55) | 59 items with verdicts and primary sources; register `docs/LANDSCAPE.md`. | L1, L2, L3, L5 (Active bets) |
| 2026-10-03 | S1b cloud guards + flaky test | [#56](https://github.com/kosm1x/agent-controller/pull/56) | DNS-free Gmail test, repo copy of mc-guard, cloud pre-commit, PR template. | **Open:** diff the VPS mc-guard against the repo copy |
| 2026-10-03 | S3 W1 build-vs-adopt | [#58](https://github.com/kosm1x/agent-controller/pull/58) | Option B (grader as a ledger gate) recommended and approved by Fede. | Gradeable-task count (Blocked on Fede) |
| 2026-10-04 | VPS: rulings 1–5 pre-deploy check; eval gate scoring v2 | `f9c7e7e`, `e1ad4a1`, `6cbaa6c` (direct to `main`) | Read-only pre-deploy check (`scripts/predeploy-rulings-1-5.sh`). Gate now scores only offered tools, any-hit for multi-tool cases, versioned + population-guarded baseline; tool selection 35 → 53.75, composite 76.87 (baseline re-captured, 0 errored probes). Rulings 1–5 DEPLOYED 04:14 UTC at `6cbaa6c` (pre-deploy check READY WITH NOTES; health 200, 0 startup errors). | Prove the rulings by first real use; ruling 5a DB role; first nightly tuning run under v2. Queue §2026-10-04 (scoring_version column, round boundaries, no-call cases). |
| 2026-10-04 | S4 W1 grader gate (dormant) | [#60](https://github.com/kosm1x/agent-controller/pull/60) | Phases 0–4 of the W1 decision note: fresh-context Opus grader (no fallback; malformed ⇒ pending), harness-only `GR-` rows, shadow fire-and-forget (trace + cost, cap 4), enforce demotes through the existing ledger, `mc-ctl gates graded`. Flag off byte-identical. Critic SQL whitelist now resolved via EXPLAIN (quoted/commented table bypass closed). qa-auditor R1 7 warnings → R2 4 → R3 pass; scoped 997 tests, related 8004. | Operator: deploy, `eval:gate` before arming, arm shadow, label ≥30 runs. Phase 6 replan only if shadow justifies it. |
| 2026-10-04 | VPS: #60 review + merge + deploy; KB mirror guard | `04a3dc8`, `e9d7efb` | #60 audited (flag-off live changes: critic EXPLAIN guard, `GR-` reservation; both exercised), merged, deployed 05:10 UTC with rulings 1–5. Two self-inflicted incidents: verification code overwrote live KB mirror files (restored from the DB); guard shipped so only the live db writes the live mirror. | Queue §2026-10-04 items 11–15: breaker half-open fix before arming the grader, reserved gate ids at validation, guard follow-ups. Eval gate baseline re-capture owed (src changed). |
| 2026-10-04 | VPS: real-run check; PM paper ritual archived | `597ce8c` | 10-03 Morning Sync confirmed on the day-log fix (brief 30.9k chars, 1 KB read instead of 4). `pm-daily-rebalance` archived by operator ruling (`enabled: false`; zero fills ever); delivery `ERROR_RE` no longer trips on negated mentions and now matches "falló". No nightly tuning exists (`TUNING_ENABLED` off). | Deployed 05:52 UTC. Queue §2026-10-04 items 16 (intermediate text glued onto results, all SDK tasks) and 17. Rulings still unproven by real use. |
| 2026-10-04 | VPS: breaker half-open fix; inbound pre-task deadline | (this commit) | A HALF_OPEN probe that exits unjudged is now released by its holder (token) or expires after 20 min. A Telegram message stalled before task creation at 05:58 UTC (cause unknown); enrichment and scope classification are now each bounded and fall back, so a task is always created. Schedule gate restored by operator (`a60914c`). | Deploy. Queue §2026-10-04 items 11 (b)–(e), 19 (stall root cause, praise filter). Gated run proof 10-05 19:00 UTC. |
| 2026-10-05 | VPS: V8.2 critic-unfixable causes; PDF read failure | `45dcb0a`, `a370983`, `113a1d8`, `6567f58` | §17 gate fails only on critic-unfixable 11.8 % (need < 5 %). Fixed two of three causes: evidence gather now finds day-logs by project slug (not only the display name), and a revision can cite KB files the critique names (append-only ledger, compare-and-set write). PDF: Type 3 decks read as empty (library tiny-text filter) → `pdftotext` fallback; `gemini_upload` had failed on every file since ~08-20 (explicit Content-Length rejected by the guarded fetch). All deployed 22:20 UTC. | Queue §2026-10-05 |
| 2026-10-06 | VPS: W1 grader pre-arm fixes, queue item 11 (b)–(e) | `d0d95a8` | Orphaned grader calls hold their shadow slot and read-only connection until they settle or a 15-min hold fires; every grader prompt section fenced with a per-call token; critic `sql_check` allows `json_each`/`json_tree` by vtab pointer identity, `northstar` dropped from the whitelist and every copy of it. qa-auditor R1 PASS-with-warnings (21 bypass probes, 0 through) → 4 folds → R2 PASS-with-warnings (20 probes, 0 through) → 4 folds. Deployed 03:1x UTC (PID 3587651, health 200, 0 startup errors, build=d0d95a8). | Operator: deploy; eval baseline re-capture; `eval:gate -- --run`; arm `shadow`. Queue §2026-10-06 (enforce cap, breaker residuals, fence class elsewhere, §13 readout ruling). |
