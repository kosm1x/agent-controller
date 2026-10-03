# Roadmap — one page

> Read this first in every session; end every session by adding a row to the Session log. Hard cap: one page (~60 lines). Detail lives in the linked docs, not here. Last updated 2026-10-03 (S1b).

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

V8.1 active (08:00 Morning Sync is the surface); V8.2 judgments in shadow; V8.3 Phases 0–7 done, first L1→L2 promotion 2026-09-18; V8.4 Honest Done ENFORCE armed. **No V9 workstream (W1–W6) has code yet.** Source: `docs/PROJECT-STATUS.md` header, `docs/V9-ROADMAP.md` §3.

## Active bets

| Bet | Gate | Next step | Session |
| --- | --- | --- | --- |
| W1 verify gate | Build-vs-adopt decision approved by Fede | Spike: map `task_gates` onto spec `checks[]`, compare build vs extend V8.4 | S3 → S4 |
| W3 internal eval, reshaped | Uses existing gate/outcome/eval data; gate-definition changes logged with old-definition number | Inventory real row counts, paired comparisons vs explicit-direction baseline | S5 |
| Landscape review | Every item has a primary source and a verdict (build / adopt / borrow / ignore) | First review + `docs/LANDSCAPE.md` register | S2 |
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
- W2 Ralph continuity (after W1). W6 crawl frontier (background only).
- Hosted Managed Agents or an external grader (option A). Budget hard-cap enforcement (closed 2026-07-13).

## Blocked on Fede

- S3 outcome: approve or change the W1 option before S4 is briefed.

## Session log

| Date | Brief | PR | Outcome | Follow-ups |
| --- | --- | --- | --- | --- |
| 2026-10-03 | S0 compact record + roadmap | [#53](https://github.com/kosm1x/agent-controller/pull/53) | PROJECT-STATUS 1.84 MB → ~196 KB; history moved unchanged to `docs/archive/status-history-2026-0{3..9}.md`; this page; W5 in CLAUDE.md. D2 (archive move) approved and done. | S1 next |
| 2026-10-03 | S1 cloud-session setup | [#54](https://github.com/kosm1x/agent-controller/pull/54) | Cloud-only SessionStart hook (`npm ci` when the lockfile changes, then typecheck; clean clone 27 s, rerun 10 s; never touches a node_modules it did not create); `implementer` + `qa-auditor` agents (auditor keeps `.claude/agent-memory/qa-auditor/`); skills `eval-gate`, `session-close`, `upstream-review`. | S2 next. Cloud sessions cannot run `eval:gate` or read prod data: they record it as owed. New auditor memory files are gitignored (need `git add -f`). |
| 2026-10-03 | S1b cloud guards + flaky test | [#PR](https://github.com/kosm1x/agent-controller/pull/PR) | Gmail provider-rule test no longer needs live DNS or a public FQDN hostname (both reproduced the CI failure by mutation); repo copy of the mc-guard PreToolUse hook (deploy, DB writes/resets, service restarts; 163 cases); cloud-only pre-commit (typecheck + vitest related); PR template; mcp-servers.json no longer gitignored (tracked on purpose). | VPS mc-guard stays canonical there; diff it against `.claude/hooks/mc-guard.sh` on the VPS. |
