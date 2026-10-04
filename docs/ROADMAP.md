# Roadmap — one page

> Read this first in every session; end every session by adding a row to the Session log. Hard cap: one page (~60 lines). Detail lives in the linked docs, not here. Last updated 2026-10-04 (S4).

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

V8.1 active (08:00 Morning Sync is the surface); V8.2 judgments in shadow; V8.3 Phases 0–7 done, first L1→L2 promotion 2026-09-18; V8.4 Honest Done ENFORCE armed. **W1 has dormant code (S4, #60); W2–W6 have none.** Source: `docs/PROJECT-STATUS.md` header, `docs/V9-ROADMAP.md` §3.

## Active bets

| Bet | Gate | Next step | Session |
| --- | --- | --- | --- |
| W1 verify gate | **Built dormant in S4 ([#60](https://github.com/kosm1x/agent-controller/pull/60))**: ledger grader gate behind `TASK_GATES_GRADER` (off); shadow FP ≤10% on ≥30 labelled runs | Fede: merge + deploy, `eval:gate -- --run`, then arm `shadow` and label via `mc-ctl gates graded` (decision note §6) | S4 → Phase 5 (operator) |
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

- W1: merge + deploy #60, run `eval:gate -- --run` (grader prompt), then arm `TASK_GATES_GRADER=shadow`. Also owed: weekly count of gradeable tasks.
- L1: run the Agent SDK bump with `npm run eval:gate -- --run` on the VPS (cloud sessions cannot).
- L3: after the VPS A2A-usage check, rule shim-to-1.0 or retire.

## Session log

| Date | Brief | PR | Outcome | Follow-ups |
| --- | --- | --- | --- | --- |
| 2026-10-03 | S0 compact record + roadmap | [#53](https://github.com/kosm1x/agent-controller/pull/53) | PROJECT-STATUS 1.84 MB → ~196 KB; history moved unchanged to `docs/archive/status-history-2026-0{3..9}.md`; this page; W5 in CLAUDE.md. D2 (archive move) approved and done. | S1 next |
| 2026-10-03 | S1 cloud-session setup | [#54](https://github.com/kosm1x/agent-controller/pull/54) | Cloud-only SessionStart hook (`npm ci` when the lockfile changes, then typecheck; clean clone 27 s, rerun 10 s; never touches a node_modules it did not create); `implementer` + `qa-auditor` agents (auditor keeps `.claude/agent-memory/qa-auditor/`); skills `eval-gate`, `session-close`, `upstream-review`. | S2 next. Cloud sessions cannot run `eval:gate` or read prod data: they record it as owed. New auditor memory files are gitignored (need `git add -f`). |
| 2026-10-03 | VPS: day close + Morning Sync read the whole day-log; bot token leak | `0fa9c5f`, `4a69615` (direct to `main`) | Harness embeds the day-log for the four rituals and the Morning Sync (the read tool returned a 60-char outline); cut entries marked `…`; Telegram HTML converted locally, token redacted. DEPLOYED 07:27 UTC; token rotated, 37 stored rows redacted. Rulings 1–5 moved to `wip/rulings-1-5` (cloud). Detail: `docs/PROJECT-STATUS.md` header. | Prove the 08:00 Sync + 23:50 close of 10-03. Operator: apply mount tripwire. `wip/rulings-1-5` must merge `main` (`router.ts`). |
| 2026-10-03 | Rulings 1–5 finish (cloud) | [#57](https://github.com/kosm1x/agent-controller/pull/57) | Ruling 3 rounds 6–9 + combined audit (rulings 1, 2, 4, 5 PASS; ruling 3 fixes: grep 64 MiB streamed cap, dir-glob rg cwd mapping, `http_fetch` by-name description, refusal traces, placeholder pre-gate) and a follow-up audit with no blockers; `main` merged; CI green at `5a93b90`. Ruling 3 guessing oracles and ruling 5 docker residuals accepted by the operator. | OWED: one `eval:gate -- --run` on the VPS (tool-description + refusal text changed; no ship on FAIL); operator merge + deploy; VPS checklist in `docs/planning/rulings-1-5-wip-resume.md`; docker exec-time shim queued. |
| 2026-10-03 | S2 landscape review #1 | [#55](https://github.com/kosm1x/agent-controller/pull/55) | 59 items across Agent SDK/platform, MCP, A2A, four frameworks and OTel each got a verdict with a primary source (`docs/planning/landscape-review-2026-10.md`); register `docs/LANDSCAPE.md`. MCP: spec 2026-07-28, our SDK 1.29.0 negotiates up to 2025-11-25 (so does 1.32.0). A2A: upstream 1.0.1, ours matches no released version. qa-auditor index trimmed (MEMORY.md 23.9 KB → 16.1 KB; verbatim pre-trim copy in `archived-index-2026-10-03.md`). | L1 SDK bump (VPS, eval:gate), L2 MCP fidelity (cloud), L5 Stop-hook deadline (cloud), L3 A2A ruling (VPS data); inputs to S3, S5, W2; L4 later |
| 2026-10-03 | S1b cloud guards + flaky test | [#56](https://github.com/kosm1x/agent-controller/pull/56) | Gmail provider-rule test no longer needs live DNS or a public FQDN hostname (both reproduced the CI failure by mutation); repo copy of the mc-guard PreToolUse hook (deploy, DB writes/resets, service restarts; 163 cases); cloud-only pre-commit (typecheck + vitest related); PR template; mcp-servers.json no longer gitignored (tracked on purpose). | VPS mc-guard stays canonical there; diff it against `.claude/hooks/mc-guard.sh` on the VPS. |
| 2026-10-03 | S3 W1 build-vs-adopt | [#58](https://github.com/kosm1x/agent-controller/pull/58) | Spec re-checked against `main`: the "done" decision moved to the dispatcher's `applyCompletionLedger`, Opus silently falls back to Sonnet, no sandbox exec helper, swarm not covered. Recommends option B (grader as a ledger gate, `TASK_GATES_GRADER` off/shadow/enforce); A conflicts with "no second done decision"; C ruled out by D4. Shadow plan with FP ≤10%. | Fede approved B 17:39 UTC (defaults: same-model OK, demote-only). S4 next. Owed (VPS): weekly count of gradeable tasks. |
| 2026-10-04 | S4 W1 grader gate (dormant) | [#60](https://github.com/kosm1x/agent-controller/pull/60) | Phases 0–4 of the W1 decision note: fresh-context Opus grader (no fallback; malformed ⇒ pending), harness-only `GR-` rows, shadow fire-and-forget (trace + cost, cap 4), enforce demotes through the existing ledger, `mc-ctl gates graded`. Flag off byte-identical. Critic SQL whitelist now resolved via EXPLAIN (quoted/commented table bypass closed). qa-auditor R1 7 warnings → R2 4 → R3 pass; scoped 997 tests, related 8004. | Operator: deploy, `eval:gate` before arming, arm shadow, label ≥30 runs. Phase 6 replan only if shadow justifies it. |
