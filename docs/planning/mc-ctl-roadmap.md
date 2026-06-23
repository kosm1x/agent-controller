# mc-ctl roadmap — the operator CLI surface for V8 / V9

> **Authored** 2026-06-23. The operator-facing CLI (`mc-ctl`, bash → tsx/sqlite) is how the V8/V9 roadmap becomes _legible and steerable_ without reading the DB by hand. This doc is the thoughtful to-do for that surface: what exists, what's next, in what order, and what each item is gated on. Companion to `docs/V9-ROADMAP.md` (the capability roadmap) — this is its CLI projection.

## Why mc-ctl is the right lever here

Each V8/V9 layer produces SHADOW state before it's activated (V8.1 briefs, V8.2 judgments, V9 verify verdicts). Shadow state is worthless if the operator can't _see_ it to make the activation call. `mc-ctl` is the read path. The discipline: every layer that writes a shadow table earns an inspector + a gate command before it can be promoted. Inspectors ship via `tsx` from source (no service deploy), so they're cheap and land same-session.

## What exists (V8-era)

| Command                             | Layer                   | What it does                                                                            |
| :---------------------------------- | :---------------------- | :-------------------------------------------------------------------------------------- |
| `status` / `stats`                  | core                    | service health + full metrics dashboard                                                 |
| `tasks` / `task <id>` / `outcomes`  | core                    | task introspection                                                                      |
| `audit-claim <metric>`              | V8 S2                   | self-audit-before-reporting gate (stratified metric + warnings)                         |
| `drift`                             | V8 S3                   | config-drift report (running env vs declared invariants)                                |
| `briefing-gate`                     | V8.1 §13 **+ V8.2 §17** | both activation gates in one report; exit = worst-of-two                                |
| **`judgments [id]`**                | **V8.2**                | **NEW (this session) — list/detail the shadow judgments + a §17 gate-readiness header** |
| `recall-utility` / `recall-compare` | memory                  | Hindsight vs SQLite recall telemetry                                                    |

## V8.2 — Strategic Initiative Layer (ACTIVE shadow)

**Shipped 2026-06-23: `mc-ctl judgments`.** The producer (Phase 9, armed 2026-06-19) writes `judgments` + `attributed_claims` rows but delivers nothing; the operator had no window into them beyond raw `db "SELECT…"`. Now:

- `mc-ctl judgments` — recent judgments, newest-first: id · age · confidence · posture · claims(resolved/total) · concession · critic verdict · subject, under a §17 gate-readiness header.
- `mc-ctl judgments <id>` — full detail: prose, RAPID-D options (A/B/C summaries), confidence basis, attributed claims with resolver status.
- `--window=N` / `--limit=N`.

**The inspector's first finding (actionable — this is the real V8.2 "next"):** the §17 gate is currently **FAIL on quality**, not merely accumulating:

| §17 check            | live (2026-06-23) | threshold | verdict                                                                                          |
| :------------------- | :---------------- | :-------- | :----------------------------------------------------------------------------------------------- |
| shadow volume        | 15 in 7d          | ≥10       | ✓                                                                                                |
| citation resolver    | 92.7%             | ≥95%      | ✗ (close)                                                                                        |
| **critic unfixable** | **57.1%**         | **<5%**   | ✗✗ (dominant blocker)                                                                            |
| sycophancy           | 0%                | ≤5%       | ✓                                                                                                |
| acceptance (6a)      | 1.5×              | ≥1.5×     | ✓ (but carries the per-judgment-vs-per-brief calibration caveat in `v82-activation-gate.ts:176`) |

**Read of the finding:** 8 of 14 judgments with a critic trail end `unfixable` — the producer's author→critic loop cannot ground most judgments to the critic's satisfaction. That's a _producer-quality_ problem (decomposition / evidence-ledger / author prompt), NOT an inspector bug, and NOT something to fix inside this CLI change. It is the highest-leverage V8.2 work item: **diagnose why the critic-unfixable rate is 57%** (sample the `unfixable` judgments via `mc-ctl judgments <id>`, read their critic trails, find whether it's thin evidence, over-strict critic, or genuine ungroundable subjects). Resolver at 92.7% is the secondary item (3 of ~410 claims unresolved). Until both clear, V8.2 is not §17-activatable regardless of volume.

**Remaining V8.2 mc-ctl candidates (not yet built):**

- `mc-ctl judgments --unfixable` filter — surface just the failing judgments for the diagnosis above. Cheap; build when the diagnosis starts.
- `mc-ctl sycophancy` — inspect the nightly sycophancy-probe results (the §17 sycophancy term). Lower priority (currently 0%, healthy).

## V8.3 — Autonomous Execution Gates (specced, not shipped)

No mc-ctl surface yet (the layer isn't built). When V8.3 ships, it will need:

- `mc-ctl decisions [id]` — inspect `logs/decisions/` ADRs + `decision_events` (detection → action → reversal).
- `mc-ctl autonomy` — per-capability autonomy level (L0–L5), ODD predicate state, trust signals, last PI-controller adjustment.
- `mc-ctl decision-replay <id>` — the LangGraph-checkpoint replay/fork primitive.

All gated on V8.3 implementation (`docs/planning/v8-capability-3-spec.md`).

## V9 — Agentic Loop Engineering

- **W1 PEV verify gate** → `mc-ctl verify-gate` — shadow-metrics for the verify gate's false-complete catch rate + false-positive rate (spec §12). Gated on W1 _code_ shipping (`docs/planning/v9-capability-1-spec.md`; behind `PROMETHEUS_VERIFY_GATE_ENABLED`). Mirror `briefing-gate`.
- **W3 eval harness** → `mc-ctl eval` — run the internal eval set, report the METR-style time-horizon metric over `logs/decisions/`. **This is the next _large_ mc-ctl build.** Gated on a W3 spec (not yet written — the W1 spec is the template) + a new `src/eval/*`. It is the instrument that answers V8-VISION §7's four questions and the gate W4 (self-mod) hangs on.

## Priority order

1. **(shipped)** `mc-ctl judgments` — V8.2 shadow visibility.
2. **V8.2 producer quality** (not mc-ctl, but what the inspector surfaced): diagnose the 57% critic-unfixable rate. Highest-leverage V8.2 work. `mc-ctl judgments --unfixable` is the cheap CLI assist for it.
3. **W3 `mc-ctl eval`** — needs a W3 spec first; the next large CLI build, and the V9 keystone.
4. **W1 `mc-ctl verify-gate`** — after W1 code ships.
5. **V8.3 inspectors** — after V8.3 ships.

## Conventions for new mc-ctl inspectors

- Bash `cmd_*` → `npx --no-install tsx scripts/<name>.ts "$@"` (mirror `cmd_briefing_gate` / `cmd_judgments`). Ships without a service deploy.
- Read-only: import readers only; no writes. (Note: `initDatabase` opens the shared DB RW and applies idempotent schema DDL — "read-only" means _no row writes_, same caveat as every tsx inspector.)
- Parameterized SQL only; clamp any `--limit`. Put pure formatters in a `src/lib/.../*-format.ts` module so their defensive parsing is unit-testable (the script self-executes and can't be imported).
- A gate-readiness header on list views so the operator sees activation distance at a glance.
