# Roadmap — one page

> Read this first in every session; end every session by adding a row to the Session log. Hard cap: one page (~60 lines); one short line per row, detail in the linked docs. Last updated 2026-10-18 (trimmed from 104 lines; nothing deleted). Row text as it stood before the trim, verbatim: `docs/archive/roadmap-detail-2026-10-18.md` (header note, stage, bets, blocked) and `docs/archive/roadmap-session-log-2026-10.md` (Session log). Production state of record: `docs/PROJECT-STATUS.md` header + `docs/planning/next-sessions-queue.md`.

**Destination: Beta 1.0**, defined in `docs/BETA.md` (from `docs/V8-VISION.md` §8): it works for Fede with evidence AND any other operator could adopt it. Fede is the first operator; his setup becomes the first operator profile.

**Platform stance (option A, 2026-10-03):** self-hosted on the VPS; borrow Managed Agents designs, do not run on them; stay competitive in functionality, looping and tool use. **Thesis:** the harness is the lever, not the weights.

## The four Beta tests (evidence and gaps: `docs/BETA.md` §3)

| Test | Where it stands | Next missing piece |
| --- | --- | --- |
| Replicability | Inventory (1,700 sites) + project contract; S6 WS1–WS3b deployed | Operator profile, WS4 allow-list, WS6 replicability suite |
| Teachability | Vision, plan docs and first-operator guides only | Onboarding guide (after the profile); one transfer attempt |
| Scalability | Single process; channels clean; projects via records | Language (949 lines), identity, timezone, paths behind the profile |
| Credibility | Honest-done ENFORCE; eval gate v4; W1 shadow 17/30 | 13 more W1 labels → `enforce`; W3 step 2 report |

## Current stage

V8.1 active (§13 gate v2 scores the Morning Sync); V8.2 judgments in shadow; V8.3 first L1→L2 promotion 2026-09-18; V8.4 Honest Done ENFORCE. **V9:** W1 in shadow since 2026-10-06, code complete; W3 step 1 done and its 3 rulings RULED 2026-10-18; W5 done; W2, W4, W6 have no code. Detail: archive detail §Current stage.

## Active bets

| Bet | Gate | Next step | Owner |
| --- | --- | --- | --- |
| W1 verify gate | FP ≤10 % on ≥30 `really done` labels | Label to 30 (`docs/planning/v9-w1-labels.md`, 17/30 on 10-09), accept latency/cost (n=15: 20.4 s, $0.20), arm `enforce` | Operator |
| W3 internal eval | Read-only report; gate-definition changes logged | Build step 2 as ruled 10-18 (`src/eval/*`, `mc-ctl eval`; queue §2026-10-09 (late) W3) | Next session |
| S6 operator abstraction + project contract | `docs/BETA.md` merged; replicability suite green | WS1–WS3b + records LIVE; next: operator profile, WS4, WS6 (spec §7) | S6 |
| Rulings 1–5 in production | Each seen working on a real task | Deployed 10-04, unproven by real use (queue §2026-10-04) | VPS |
| L3 A2A | RULED 10-09: stays; never propose retiring | Shim to A2A 1.0 when the operator names the first consumer's date | Operator |
| Done bets | — | Landscape S2 · cloud sessions S1/S1b · W5 S0 · L1 SDK 0.3.285 · L2 · L5 and queue 3c (deployed, proof open) (archive detail §Active bets) | — |

## Review cadence (tiered, routines created 2026-10-03)

- **Weekly** (Mondays): this page + release notes for sources in `docs/LANDSCAPE.md`. Four empty scans in a row → loosen.
- **Event-triggered:** a new Agent SDK minor or platform feature touching a bet is read that week, with pin + `eval:gate`.
- **Monthly** (1st): deep review, S2 method, folded into the upstream review. **Quarterly:** is the cadence paying off?

## Not now

- W4 self-modification (blocked on W3 + V8.3 shadow-Git + L≥3 sign-off). W2 Ralph continuity (after W1). W6 crawl frontier. L4 trace spans.
- Hosted Managed Agents or an external grader (option A). Budget hard-cap enforcement (closed 2026-07-13).

## Blocked on Fede

- W1: keep labelling toward 30, then accept the latency/cost readout and arm `enforce`.
- L3: name the date of the first A2A consumer, which schedules the 1.0 shim.
- VPS: diff the live mc-guard hook against `.claude/hooks/mc-guard.sh` (S1b follow-up, open since 10-03).
- Open proofs and owed applies (queue): 10-15 cache split unproven + its community-email profile ruling · 3f use-proof (10-19 tweet) + `tool_approvals.task_id` · WS3b fallback trace + Drive guard · 4f cancel race · Part B pilot yes · post-reboot-verify (i) apply · 4i/4d proofs.
- Eval gate: nothing owed; the next prompt, tool-description or classifier change runs `npm run eval:gate -- --run` against the v4 baseline (78.63).

## Session log (older rows: `docs/archive/roadmap-session-log-2026-10.md`)

| Date | Brief | PR | Outcome | Follow-ups |
| --- | --- | --- | --- | --- |
| 2026-10-17 | Ship-it push: Drive guard, eval `scope_prompt` v4, WS3b | `f07204a` `93fd1de` `9dd4128` | Deployed `741b35c`; baseline v4 78.63 (archive) | WS3b + Drive guard proofs (archive) |
| 2026-10-17 (night) | 4e, 3r, 4f, 4g+4h | `1d5d3a9`…`c44655f` | Deployed `e93b01e` (archive) | Proofs after deploy (archive) |
| 2026-10-18 (early) | 4i notice + 4d guessed-KB-root checks; 8 rulings incl. W3 1–3 | `66ed68a` `604a941` | Deployed `202cd79` (archive) | Proofs (archive) |
| 2026-10-18 (morning) | 5a psql gate, 4l confirmation list, 3f records applied | `d6d9e7d` `87d4e1c` | Deployed `859c93b`; eval compare PASS 78.55 (archive) | Proofs (archive) |
| 2026-10-18 | Beta doc + roadmap trim (cloud, docs only) | [#63](https://github.com/kosm1x/agent-controller/pull/63) | `docs/BETA.md` written; this page 104 → ≤60 lines, detail moved verbatim to `docs/archive/`; LANDSCAPE versions refreshed | W3 step 2 build; operator profile |
