# V8 — Where We Are Going

> Written 2026-04-30, the night the bibliography closed and the design phase finished. This doc is for whoever reads it next — possibly the same operator three weeks from now — and needs to understand what's about to happen and why, without re-reading 6,000 lines of specs.
>
> Freeze ends 2026-05-22. After that, V8 starts shipping.

## §1 — The one-paragraph version

V8 is not a more capable Jarvis. V8 is a **calibrated** Jarvis. The current Jarvis can do a lot of things; what he lacks is the _protocol_ between him and the operator that makes those things land usefully without being sycophantic, fabricating, single-pathing, or autonomous when he shouldn't be. V8 is the layer that builds that protocol — opinionated and cited briefs (V8.2), reversible autonomous action under explicit consent (V8.3), proactive context that surfaces what wasn't asked (V8.1) — all on top of an engineering substrate (S1-S5) that prevents the boring failure modes (cost drift, cache regressions, sycophancy creep, unaudited mutations). The protocol is the edge, not the model. Process > capability.

## §2 — Where we are right now

State of V8 at this snapshot:

- Design phase **complete**. 8 specs written (3 capability + 5 substrate), 1 synthesis index, vision doc updated.
- Bibliography coverage **100%** across 7 scout waves, 28 reference memories, 48/48 items.
- Implementation: **zero**. Not a single line of V8 code exists. The current Jarvis is V7 + stabilization patches.
- Freeze still in effect through **2026-05-22**. No core changes during freeze.

The night-of-design produced ~6,170 lines of planning documentation with 100% bibliography backing. That's a heavy ratio of plan-to-code, and we know it. The discipline going forward is: ship measurably, gate strictly, reverse fast on what doesn't calibrate.

## §3 — What changes, day-to-day

Concrete operator-facing differences once V8 ships. This is the "why bother" answer.

**Morning brief becomes opinionated, not observational.** Today: "you have 3 stalled tasks, 7 ticker alerts, 41 Hindsight entries." Post-V8.2: "the CRM pilot is 8 days behind schedule [evidence: tasks 1234, 1235, 1236 + your own NorthStar Q3 commitment]; my read is the unblock is internal not external; the operator-decision is whether to extend Q3 or accept slippage; here are options A/B/C with their tradeoffs."

**Every claim has a citation.** No more "Audited?" cycles. Brief sentences carry `[1]`-style markers; markers resolve to specific row IDs in tasks/kb_entries/conversations/NorthStar. Unverifiable claims are dropped from the brief, not surfaced with caveat.

**Confidence is mechanical, not LLM-chosen.** Green / yellow / red is computed from evidence count + contradiction count, then the prose register is constrained to match the color. You can't have authoritative prose with thin evidence — the system rejects it before delivery.

**Pushback discipline.** When you say "are you sure?" without new evidence, Jarvis restates the position with reason rather than caving. When you say "the customer told me X," Jarvis updates the analysis explicitly and marks the concession as `updated_with_evidence`. The third bucket — `conceded_without_evidence` — is the failure mode we measure nightly via probe.

**Some actions become autonomous.** Specifically: capability-by-capability, level-by-level, per the operational design domain you sign off. `extend_task_due_date` at L4 (act-and-summarize-EOD) only when urgency != critical, < 14 days extension, value at stake < $1000. Outside those conditions, it auto-demotes to L3 (act-and-notify) for that single decision. You stay in the loop on consequential things; you exit the loop on routine things.

**Every action is reversible.** SQL inverse-DML for database mutations. Shadow-Git per workspace for file edits. Compensating actions for irreversible side-effects. Anything truly irreversible can only run at L≤2 (operator confirmation required pre-execution).

**Cost is fully attributable.** Every inference call from every provider writes one row. "What did decision 0042 cost end-to-end?" is one query. "Is brief generation drifting in cost?" is a watched signal.

**Drift is watched, not caught after.** Cache prefix regressions, sycophancy creep, override-rate spikes, citation resolver failures — declared baselines + tolerance + cadence + delivery into morning brief. The 2026-04-26 "P1-A class of failure" — production drift caught only after operator notices — becomes mechanically harder.

## §4 — The activation order

You don't ship V8 in one go. The dependencies are real.

```
Stabilization (current — through 2026-05-22)
    │
    ▼
S1: Cache-Aware Prompts        (~5 days)   ← foundation for V8.2 principle block caching
    │
    ▼
S4: cost_ledger v2             (~4.5 days) ← visibility into everything that follows
    │
    ▼
V8.1: Proactive Context Engine (~18 days)  ← Conway memory tiers + general_events
    │
    ▼
S2: Self-Audit Substrate       (~5 days)   ← critic + sycophancy probe (some prep can parallel)
    │
    ▼
V8.2: Strategic Initiative     (~14 days)  ← consent layer; needs V8.1 BriefingContext + S2 critic
    │
    ▼
S3: Drift Detector             (~5 days)   ← needs all above as signal sources
    │
    ▼
V8.3: Autonomous Gates         (~18 days)  ← needs V8.2 consent layer; load-bearing dependency
    │
    ▼
S5: Skills as Stored Procedures (~10 days, partly parallel) ← shared infra throughout
```

**Calendar estimate**: ~80 calendar days of focused work post-freeze if shipped sequentially. Realistic given operator's parallel commitments: 12-16 weeks. **Likely staged**: V8.1 + S1 + S4 ship first as a coherent group (the substrate + memory layer); V8.2 ships next as a behavioral re-foundation; V8.3 + S3 ship last and require the highest bilateral-maturity gate.

**Why this order**:

- **S1 ships first** because V8.2's strategic-voice principle block is ~250 stable cache-prefix tokens that have to live correctly or every brief becomes 30% more expensive.
- **S4 ships before V8.1** because once V8.1 starts producing morning briefs, you need to know what they cost. Without S4 universal logging, V8.1 cost data would be incomplete (only the claude-sdk path shows up).
- **V8.1 ships before V8.2** because V8.2 consumes V8.1's BriefingContext. V8.2 without V8.1 has nothing to make judgments about.
- **S2 ships alongside / before V8.2** because V8.2 deploys S2's CRITIC + sycophancy probe as instances. The substrate primitives have to exist.
- **V8.2 ships before V8.3** because V8.3 decisions at L≥3 require linked V8.2 judgments with confidence ∈ {green, yellow}. Without V8.2's consent layer, V8.3 is unilateral causation — Wiener's failure mode.
- **S3 ships after V8.2** because most of S3's signals (sycophancy, citation resolver, override-rate) only exist once their producing substrates do.
- **S5 weaves throughout** because skills are shared infrastructure for V8.1/V8.2/V8.3 (each RAPID-D role in V8.2 is a skill; each ODD predicate in V8.3 is a skill; each reflection prompt in V8.1 is a skill).

## §5 — The gating discipline

Each ship has an activation gate with measurable criteria. We don't move to the next ship until the previous one's gate passes. The gates are in each spec. The summary:

| Layer | Activation gate                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| S1    | 7-day cache-read ratio meets per-tool target on top-5 tools                                                             |
| S4    | All 4-5 inference paths logging; non-zero cost on all non-local events                                                  |
| V8.1  | Cache-read ratio ≥ 80% with morning-brief generation included; first 7-day shadow run                                   |
| S2    | Sycophancy concede-without-evidence rate ≤ 5% over 30 days                                                              |
| V8.2  | 7-day shadow run: ≥95% citation-resolver success + ≤5% sycophancy + green/red promote ratio ≥1.5×                       |
| S3    | 12 seed signals all evaluated within cadence; first round of P1 alerts validated for true-positive                      |
| V8.3  | Operator explicitly signs off first L1→L2 promotion; all default capabilities at L1; reversibility coverage 100% on L≥3 |
| S5    | Existing 57-skill seed migrated; first new skill round-trips through harness                                            |

**The bilateral-maturity gate is the load-bearing one.** This isn't engineering theater. The 2026-04-15 design decision — _"la curva de aprendizaje no sólo es para ti, también es para mí"_ — means each gate requires the operator to have grown into it as much as Jarvis has. If the operator hasn't actually used the prior layer enough to know whether it works for them, the next layer doesn't ship.

**This is what makes V8 different from "build a more autonomous agent."** Most agent projects optimize for capability. V8 optimizes for calibration. The number we want at steady state is "operator's strategic-thinking-time fraction" (Licklider's 85/15) climbing toward 30-40%. The number we DON'T want is "capabilities at L5" climbing toward 100%.

## §6 — What stays the same

A non-trivial number of things.

- **V7 keeps running throughout.** V8 doesn't replace V7; it overlays. The current 252-tool registry, 4 runners, classifier-routing, NorthStar, Williams Entry Radar — none of it goes away. V8 builds on it.
- **The operator-Jarvis relationship doesn't restart; it deepens.** No "first contact" reset. The Hindsight bank, conversation history, memory files, NorthStar entries all carry forward. V8 layers on top.
- **The TypeScript runtime principle holds.** Per `feedback_ts_runtime_principle.md`. We don't add Python services to core; V8 is implemented in TS through and through.
- **The freeze-window discipline survives.** Post-2026-05-22 is "freeze lifted" not "anything goes." Each V8 ship has its own audit + activation gate. The discipline doesn't relax.
- **The project portfolio keeps shipping.** crm-azteca beta, vlcms, vlmp, williams-entry-radar — V8 work doesn't displace ongoing project deliverables.

## §7 — Risks we're taking, on purpose

Honest list.

**Plan-to-code ratio is heavy.** ~6,170 lines of design vs zero lines of V8 code. The spec set could turn out to be over-engineered. The mitigation: each spec ships in phases; first phase of each is intentionally minimum-viable; if first phase doesn't calibrate, we cut later phases rather than complete the over-engineered version. Reverse-out path: shipping S1 + S4 + V8.1 (~27 days of work) and stopping there is a _valid V8_ if the consent layer turns out unnecessary. We'd lose V8.2/V8.3 but the substrate alone is worth shipping.

**Cost projection is uncertain.** Per-brief V8.2 cost projected $0.10-$0.20 with cache discipline; not measured. If actual is 3-5× projection, we ship V8.2 cheaper-version (fewer angles, shorter principle block, smaller multi-option pass) before we ship full version. The S4 ledger shows us the truth within the first 7 days.

**Bilateral-maturity gating could feel slow.** Operator may want autonomy faster than gating allows. The discipline: Lee & See's "slow promote, fast demote" asymmetry. Trust builds slowly, breaks fast (10:1 break-vs-build per `reference_lee_see_trust.md`). The cost of one bad L4 capability is large; the cost of one extra week at L3 is small. Default conservative.

**Operator-confirmation throughput could remain the bottleneck even at L3+.** If the operator's review time per V8.2 brief or V8.3 decision is ~10 minutes, and there are 30 of those per day, the math doesn't work no matter how autonomous Jarvis becomes. Mitigation: V8.2's A/B/C structure + mechanical confidence color is designed precisely so operator can triage briefs in seconds, only deep-reading the yellow/red ones. If that triage UX doesn't deliver, we revisit V8.2 surface design before V8.3 scaling.

**The strategic-voice principle block could feel wrong.** ~250 words trying to encode strategic counsel personality. Will probably need 2-3 revision rounds based on lived experience. Versioning is built in (`strategic_voice_principle_v1.md` → `v2.md` etc.); not a re-foundation, an evolution.

**S3 alerts could be noisy.** First 30 days will likely have false-positive bursts as tolerances calibrate. Tuning is operator-driven, not auto. We accept the early noise as the cost of having watchpoints exist at all.

## §8 — What we know we don't know

Survivors of the design phase that only resolve in production:

1. **Will operator actually trust mechanical confidence colors more than LLM-prose-confidence?** The Lee & See bet says yes. Untested in our context.
2. **Will the strategic-voice principle block survive operator's 2-week experience?** Likely needs revision. Not a failure, an iteration.
3. **Is V8.2 multi-option (RAPID-D 4-role) cost-justified vs single-option-with-good-citation?** Depends on whether operator actually USES the B and C options. If 90% of decisions go with rank-1, multi-option is theatre.
4. **Will V8.3 capability autonomy ever reach L5 for any capability?** Per Kasparov-expiration test, only when override-rate is below noise floor for ≥1 quarter AND operator can articulate no domain-specific tacit knowledge gap. Likely first-flippers: scheduling, routine email triage. Likely never-flippers: strategic life decisions.
5. **Do shadow-Git per-workspace and ADR/event-source actually compose well, or are they redundant audit trails?** Three audit surfaces (git history, ADR markdown, decision_events table) might be 2-too-many. Production will tell.
6. **Will S3's correlated-burst detection catch real cascading bugs, or surface noise?** First 90 days of operation = the experiment.
7. **What's the steady-state autonomy distribution per capability?** V8.3 hypothesis: ~50% L3, ~30% L4, ~10% L1-2, ~10% L5. No empirical basis for the split; it's a design intuition.

## §9 — The destination

Not utopia. Calibrated equilibrium.

Beta 1.0 — the eventual destination V7 → V8 → V9 trajectory points at — is the point where an outside observer can say _"that works, and I can see why."_ That's the empirical claim. Inside the system, it looks like:

- The operator spends meaningfully more of their thinking time on strategy and meaningfully less on retrieval / aggregation / "what was that thing again." The Licklider 85/15 ratio shifts measurably.
- Morning briefs are read in 2-3 minutes, not skimmed in 30 seconds. Triage by color: greens get accepted, yellows get glanced at, reds get a short conversation. Per-brief decision throughput goes up.
- Decisions Jarvis takes autonomously match the kind of decisions the operator would have taken anyway, at the level the operator authorized, with reversal a single operator gesture away.
- The "Audited?" cycle becomes rare. Not zero — the operator should still audit periodically as discipline — but the default expectation is briefs are correct and cited.
- When Jarvis gets it wrong, the failure mode is _bounded_ (reversible action, demoted capability, dropped claim) not _cascading_ (silent regression for a week).

V8 is not the end state. V9 is the validation phase ("did the cognitive exoskeleton actually amplify the operator, or only automate?"). Beta 1.0 is the destination. V8 is the hinge.

## §10 — Right now: the first concrete action post-freeze

When the freeze lifts (2026-05-22), the first commit is small and structural:

**S1 Phase 1**: PromptBuilder library + linter. ~1.5 days. Purely additive — no behavior change to any existing tool. The PromptBuilder API exists; nothing yet uses it. The linter exists; nothing yet runs against it.

This is intentional. The first V8 commit is a tool nobody is forced to use yet. It exists so the SECOND commit (S1 Phase 2) can extend `cost_ledger`, and the THIRD (S1 Phase 3) can stand up the per-tool cache health view, and only by Phase 4 does any production tool migrate to it.

**Decision pending operator signal**: do we lift the freeze on 2026-05-22 (date-based) or on day-30 audit re-baseline (criteria-based)? The 30-day plan says criteria. Likely both align.

The second commit, assuming Phase 1 lands clean: S4 schema migration. Add 5 columns to `cost_ledger`, 4 new tables (`inference_events`, `provider_pricing`, `model_pricing`, `cost_budgets`), 4 views. Idempotent. No behavior change.

By the end of week 2 post-freeze, the goal is: **S1 + S4 substrate live, no production behavior changed yet, but every inference path now writes universal events to the new ledger, and prompt structure is linted.**

That's the first measurable V8 milestone. Everything else follows from there.

## §11 — What this doc is not

- Not a spec. The specs are at `docs/planning/v8-*-spec.md`. This doc is a map of them.
- Not a marketing pitch. V8 might fail; the gates are what tell us.
- Not a commitment to ship in any specific order or timeframe — operator priorities may pull this work later.
- Not a replacement for `docs/V8-VISION.md` — that doc carries the relational vision and the philosophical lineage. This doc is "given the vision, what concretely happens next."

## §12 — The shortest possible read

If you have 60 seconds:

> V8 design phase ended 2026-04-30 with 100% bibliography coverage and 8 specs ready. Implementation starts when freeze lifts (2026-05-22+). Order: S1 → S4 → V8.1 → S2 → V8.2 → S3 → V8.3, with S5 woven throughout. Each ships behind a measurable gate. Each gate requires bilateral maturity — operator and Jarvis BOTH ready. ~12-16 weeks of staged delivery if priorities allow. Destination: a calibrated Jarvis whose strategic counsel is opinionated, cited, multi-option, sycophancy-resistant, and whose autonomous actions are per-capability, ODD-bounded, reversible, audited. Not a more capable Jarvis. A calibrated one. Process > capability.

## Cross-references

- `docs/V8-VISION.md` — relational vision + philosophical lineage
- `docs/planning/v8-bibliography-synthesis.md` — meta-index over all reference research
- `docs/planning/v8-capability-{1,2,3}-spec.md` — V8.1 / V8.2 / V8.3 full specs
- `docs/planning/v8-substrate-{s1,s2,s3,s4,s5}-spec.md` — substrate full specs
- `project_v8_bibliography.md` — closed bibliography (48/48)
- `reference_post_bibliography_papers.md` — papers presented post-closure with verdicts
