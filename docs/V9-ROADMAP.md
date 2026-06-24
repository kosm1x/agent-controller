# V9 — Agentic Loop Engineering

> **Status**: Roadmap scoped. No activation date — V9 is gated by V8 bilateral maturity (V8-VISION §6), not a calendar.
> **Authored**: 2026-06-23, contextualizing the _Master Reference Bibliography_ (Jarvis's single research source-of-truth: the V8 corpus of 28 `reference_*.md` memories + the V9 "Agentic Loop Engineering" scout block, wave 6 / 2026-06-23).
> **Source of truth (lookup)**: the Master Reference Bibliography gdoc — `https://docs.google.com/document/d/15dZlFcMa3gko7Ifzp58KPPt78M4iD8_NDm-IXAbGlW4`. This roadmap is the _operational_ projection of that bibliography onto Jarvis's repo: what to build, where it lands, in what order, behind which gate.
> **Reading order**: §1 (the arc) → §2 (the spine — do not drift) → §4 (the six workstreams) → §5 (sequencing & gating). §6 is the negative-findings guard; §7 is measurement.

---

## §1 — The arc, in one paragraph

V7 made Jarvis **capable**. V8 made him **proactive with judgment** — Communication → Consent → Control (V8.1 ships state, V8.2 ships cited consent, V8.3 ships gated autonomy). **V9 puts the premises of his existence on trial** and, where they hold, upgrades the _loop itself_. The original V9 framing (V8-VISION §7) named the four questions — _did Jarvis amplify decisions or only execute them? did delegated autonomy beat explicit direction? was the bilateral learning curve real? is the system sustainable without constant attention?_ — but left them as a "validation period" with no instrument. The Agentic Loop Engineering corpus supplies the missing instrument (**W3** — an internal eval harness with a time-horizon metric over `logs/decisions/`) **and** the upgrades V9 ships while that validation runs: a structural **Verify** phase gate (**W1**), Ralph-loop continuity (**W2**), loop vocabulary (**W5**), and — gated behind the eval harness — verify-gated self-modification (**W4**). V9 is therefore _both_ the validation period _and_ the loop-engineering build that makes the validation answerable.

**The reframe that drives V9** (binding-constraint thesis): **the harness/loop is the lever, not the weights.** Terminal-Bench moved 52.8% → 66.5% → 76.4% with no model change; edit-tool format alone bought up to 10×. So V9 validates **Jarvis-the-system** (model + scaffold + harness) against an explicit-direction baseline on an internal task set — never a bare-model benchmark number.

---

## §2 — The spine (do not drift from these)

Carried forward from the bibliography's one-page summary. Each is load-bearing; none is up for re-litigation without new evidence.

1. **Wiener ladder** — Communication → Consent → Control = V8.1 → V8.2 → V8.3. V8.2 is the load-bearing _ethical_ layer; skipping it makes V8.3 unilateral causation. V9 does not re-order this — it validates that the ladder held.
2. **Kasparov centaur** — _process > capability._ Port the **structure** (weak human + machine + better process beats strong machine alone), not the **expiration** (the centaur edge expired in closed-world chess; the operator's strategic life is open-world).
3. **Mechanical confidence is anti-sycophancy by structure** — Lee & See anthropomorphism guard × Constitutional principle block. Confidence is _computed_, never LLM-chosen.
4. **Same-model self-verification fails** (CRITIC) — verification needs **external grounding** (tools, tests, a more-capable tier). **This is the load-bearing justification for W1**: the PEV verify gate routes to the capable tier and grounds in read-only tools / agent-built tests, rather than asking the executing model "are you done?"
5. **Negative findings are load-bearing** — ~30 explicit rejections (§6 here, the bibliography's §5) protect against re-arguing settled cost/transferability trade-offs.
6. **Validate the system, not the model** — V9's eval set measures Jarvis-the-system on an internal task corpus, and any self-evolution (W4) is gated behind that eval + a rollback archive.

---

## §3 — Where V8 stands at V9 entry (status map)

| Layer                                                | Wiener stage         | Status (2026-06-23)                                                                                                       |
| :--------------------------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| V8.1 Proactive Context Engine                        | Communication        | **ACTIVE** — §13 gate passed 2026-05-27; 06:00 cron briefing live                                                         |
| V8.2 Strategic Initiative Layer                      | Consent              | **SHADOW** — P0–P9 shipped; judgment producer armed 2026-06-19 (delivery OFF); judgments accruing toward the §17 ≥10 gate |
| V8.3 Autonomous Execution Gates                      | Control              | **Specced, not shipped** — `docs/planning/v8-capability-3-spec.md` (~821 lines)                                           |
| S1 cache / S2 audit / S3 drift / S4 cost / S5 skills | substrate            | **All shipped** (S1+S4 2026-04-26; S2+S3+S5 + Conway 1–3 2026-05-19/20)                                                   |
| **V9 Agentic Loop Engineering**                      | (puts V8.x on trial) | **Frontier — scoped here**                                                                                                |

V9 does not require V8.3 to ship first. W1 (verify gate) and W3 (eval harness) operate on the existing Prometheus loop and `logs/decisions/`; W4 (self-mod) is the only workstream that hard-depends on V8.3's shadow-Git reversibility.

---

## §4 — The six workstreams

Each is a **candidate gated behind its own readiness bar** — none is "decided" until its gate clears. Sources are starting points; re-fetch current arXiv versions at build time (W6).

### W1 — Plan-Execute-Verify gate · **highest-leverage · spec written**

**What**: insert an explicit **Verify** phase into Prometheus's Plan-Execute-**Reflect** loop. Today execution marks a goal `COMPLETED` (executor.ts:860) and `reflect` _scores_ the run but does not _gate_ it; the only in-loop check (per-goal `selfAssess`) defaults to `met=true` when the judge LLM is unavailable — i.e. no independent verification stands between "executor finished" and "task delivered as done." Verify closes that gap: a capable-tier, tool/test-grounded pass that can flip the delivered status before Reflect runs. **The single highest-leverage upgrade** — it compounds (every downstream task trusts an unverified "done").
**Sources**: PEV / "Reasoning Sandwich" (Masood, _AI Control Plane_, Apr 2026); **ReVeal** (arXiv 2506.11442 — generation↔verification loop, agent builds its own tests); **Guideline-Grounded Evidence Accumulation for High-Stakes Verification** (arXiv 2603.02798). _Extends_ `reference_critic_selfrefine` + `reference_process_supervision` (same "external grounding, not same-model" lesson) but is a **structural phase gate**, not a refinement pass.
**Lands**: `src/prometheus/*` (new `verifier.ts` + `Phase.VERIFY` + `VerificationResult`), runner status path.
**Gate**: executable spec at the level of `v8-capability-*-spec.md` → **done: `docs/planning/v9-capability-1-spec.md`**. Then build behind `PROMETHEUS_VERIFY_GATE_ENABLED` (default off), shadow-measure false-complete catch rate, activate.
**Status**: **spec authored 2026-06-23 (this session).** Implementation = next code phase.

### W2 — Ralph-loop continuity

**What**: an early-exit interceptor that re-injects original intent into a fresh, filesystem-backed context window when a long task tries to bail early — durable loop state against context rot.
**Sources**: Osmani/Steinberger, _Agent Harness Engineering / Loop Engineering_ (Jun 2026, addyosmani.com/blog/agent-harness-engineering/) — the **Prompt → Context → Harness → Loop** layering + the **Ralph Loop** primitive.
**Lands**: the router resume path (`src/prometheus/resume.ts` + dispatcher); composes with the existing snapshot/resume primitive.
**Gate**: cheap; can follow W1. Watch overlap with LangGraph-checkpoint plans already staged for V8.3.
**Status**: candidate.

### W3 — V9 internal eval harness · **gates W4**

**What**: an internal evaluation set + runner that scores Jarvis-the-system on a fixed task corpus over `logs/decisions/`, with the **time-horizon** metric (longest task finished 50% of the time) as the primary autonomy yardstick. This is the instrument that finally answers V8-VISION §7's four questions.
**Sources**: METR HCAST / Time-Horizons; **τ²-Bench** (τ-bench arXiv 2406.12045 — tool-agent-user + policy adherence); **Terminal-Bench 2.0** (arXiv 2601.11868); **LH-Bench** (arXiv 2603.22744 — _process quality_, matches the Kasparov thesis). Capability-specific: GAIA / SWE-bench Pro / OSWorld / WildClawBench / Claw-eval (2604.06132).
**Lands**: new `src/eval/*`, `mc-ctl eval` subcommand.
**Gate**: prerequisite for **any** self-evolution (W4). **Caveat (load-bearing)**: public benchmark scores measure a _system_ (model+scaffold+harness), differing 30–50 pts from the bare model — so build the _internal_ eval vs an explicit-direction baseline; never quote a public number as Jarvis's autonomy score.
**Status**: candidate; **the gate W4 hangs on.**

### W4 — Verify-gated self-modification

**What**: the autonomy frontier beyond skill-accretion — Jarvis proposing changes to its own code/harness, each **empirically validated against the W3 benchmark before keep**, with an **archive of known-good versions + hard rollback** (self-modification can destroy the ability to self-modify).
**Sources**: **Darwin Gödel Machine** (arXiv 2505.22954, ICLR 2026 — archive + open-ended exploration + empirical-validation gate); **SICA** (arXiv 2504.15228 — collapses meta/target agent → maps to a `jarvis_dev` self-PR); **Gödel Agent** (arXiv 2410.04444); **AlphaEvolve** (arXiv 2506.13131); **EvoAgentX** (arXiv 2507.03616); **HyperAgents DGM-H** (arXiv 2603.19461); Survey of Self-Evolving Agents (arXiv 2507.21046); ReVeal. _Extends_ `reference_voyager` (write-gate critic) into self-code-modification.
**Lands**: a gated self-PR path on top of V8.3 shadow-Git.
**Gate (hard)**: W3 eval harness **+** V8.3 shadow-Git reversibility **+** L≥3 human authorization. Wiring this before W3 risks the unrecoverable "self-modified past the ability to edit" trap (§6).
**Status**: candidate; **blocked on W3 + V8.3.**

### W5 — Loop vocabulary

**What**: adopt the Prompt → Context → Harness → Loop layering as shared vocabulary in `CLAUDE.md`, so Code reasons about the harness as the lever explicitly.
**Sources**: Loop-engineering framing; binding-constraint survey (openreview eONq7FdiHa; arXiv 2603.25723).
**Lands**: `CLAUDE.md` (umbrella + mission-control).
**Gate**: trivial; doc-only.
**Status**: candidate.

### W6 — Crawl frontier

**What**: a standing background-research task that folds the §2 V9/Loop corpus into `reference_*.md` memories on the existing wave cadence, and crawls the frontier (Awesome-Code-as-Agent-Harness-Papers; the self-evolving survey's citation graph).
**Sources**: github.com/YennNing/Awesome-Code-as-Agent-Harness-Papers + survey citation graph.
**Lands**: new `reference_*.md` memories; eventually a long-form `docs/AGENTIC-LOOP-ENGINEERING-CORPUS.md` (referenced by the bibliography but **not yet created** — W6 produces it).
**Gate**: none; ongoing, low-priority background.
**Status**: candidate; background.

---

## §5 — Sequencing & gating

```
NOW  ── W1 PEV verify gate ......... spec ✅ (this session) → implement behind flag → shadow → activate
 │
 ├──── W5 loop vocabulary ........... trivial; fold into CLAUDE.md anytime
 │
 ├──── W3 eval harness .............. build the instrument; it gates W4 and answers V8-VISION §7
 │       └── W4 self-mod ............ ONLY after W3 + V8.3 shadow-Git + L≥3 sign-off
 │
 ├──── W2 Ralph continuity .......... cheap; after W1; watch V8.3 checkpoint overlap
 │
 └──── W6 crawl frontier ............ ongoing background; produces reference_*.md + the corpus doc
```

**Why W1 first**: it is the highest-leverage upgrade (a false "done" compounds through every downstream task), it has no hard dependency on V8.3, and its design is the most settled (it extends two already-adopted references). **Why W3 before W4**: a self-modifying agent without an empirical-validation gate + rollback archive is the one move in this whole corpus that can be _unrecoverable_. **W5** can land any time. **W6** runs in the background and feeds everything.

---

## §6 — Negative-findings guard (V9 additions — do NOT port)

From the bibliography's §5. Re-introducing any of these requires new evidence.

| Rejected                                                        | Why                                                                                                                                                               |
| :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open-ended self-mod **without** eval harness + rollback archive | DGM's result is _conditional_ on per-change empirical validation + a known-good archive. Wiring W4 before W3 risks the "self-modified past ability to edit" trap. |
| Highly autonomous **swarms for autonomous _execution_**         | Brittle, expensive, hard to debug (field consensus). Keep Swarm for parallel _analysis_ only; never auto-select it for V8.3 action.                               |
| Human-out-of-the-loop at high risk                              | Keep human-on-the-loop authorization for irreversible/high-risk actions **regardless** of measured trust (computer-use + Lee & See).                              |
| Verification on the **cheap** tier                              | Planning + verify gates go to the _capable_ model ("Reasoning Sandwich"); only intermediate work goes cheap. This is a hard constraint on W1.                     |
| A **public benchmark number** as Jarvis's autonomy score        | It measures a _system_, off by 30–50 pts from the bare model. Build the internal eval (W3).                                                                       |

---

## §7 — Measurement

V9's instrument (W3) is built from these, but the **output is an internal score**, not a leaderboard entry:

- **Primary**: METR-style **time-horizon** — the longest task Jarvis-the-system finishes 50% of the time, tracked over rolling windows.
- **Policy adherence**: τ²-Bench-style tool-agent-user scenarios scored for boundary-honoring (ties to V8.2's boundary contract + V8.3's ODD predicates).
- **Process quality**: LH-Bench-style — _did the process improve_, not just the outcome (the Kasparov thesis, made measurable).
- **The V8-VISION §7 questions, operationalized**: baseline-vs-Jarvis project-advancement delta; v8.3 autonomy delta vs explicit-direction cost-of-errors; bilateral-learning-curve evidence (operator decision quality + Jarvis judgment-confidence calibration over 90-day windows, per `reference_licklider_1960`'s 85/15 measurable hypothesis); operational-friction sustainability.

---

## §8 — Cross-references

- **Master Reference Bibliography** (gdoc) — the single research source-of-truth this roadmap projects: `https://docs.google.com/document/d/15dZlFcMa3gko7Ifzp58KPPt78M4iD8_NDm-IXAbGlW4`
- `docs/planning/v9-capability-1-spec.md` — **W1 PEV verify-gate executable spec** (authored alongside this roadmap)
- `docs/V8-VISION.md` §7 — the original "V9 validation of premises" framing this roadmap operationalizes
- `docs/planning/v8-bibliography-synthesis.md` — the long-form V8 synthesis (28 `reference_*.md`, waves 1–5)
- `docs/planning/v8-capability-3-spec.md` — V8.3 spec (W4 hard-depends on its shadow-Git reversibility)
- `project_v8_bibliography.md` (memory) — authoritative scoreboard the bibliography indexes
- **Pending (W6)**: `docs/AGENTIC-LOOP-ENGINEERING-CORPUS.md` — long-form V9 corpus, not yet written

---

## §9 — One-page summary

**What V9 is**: the period that puts V8's premises on trial _and_ engineers the loop that makes the trial answerable. Six workstreams: **W1** verify gate (highest-leverage, spec'd), **W2** Ralph continuity, **W3** eval harness (gates W4), **W4** verify-gated self-mod (blocked on W3 + V8.3), **W5** loop vocabulary, **W6** crawl frontier.

**The reframe**: the harness is the lever, not the weights — so validate Jarvis-the-_system_ on an internal eval, not a bare-model benchmark.

**The spine (don't drift)**: Wiener ladder · Kasparov process>capability · mechanical confidence · same-model self-verification fails (→ W1 grounds externally on the capable tier) · negative findings are load-bearing · validate the system.

**Do next**: implement W1 behind `PROMETHEUS_VERIFY_GATE_ENABLED` per `v9-capability-1-spec.md`; fold W5 into `CLAUDE.md`; stand up W3 as the gate W4 waits on.
