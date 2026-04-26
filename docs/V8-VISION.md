# V8 Vision — Autonomía Estratégica + Engineering Substrate

> **Status**: Pre-plan. No activation date. Bilateral-maturity gated.
> **Prerequisite**: v7 stable + 30d hardening window (2026-04-22 → 2026-05-22) cleanly closed.
> **Authored**: 2026-04-26, consolidating Jarvis-authored vision (`projects/agent-controller/evolucion-v7-beta.md`, `v8-pre-plan.md`, both 2026-04-15) with engineering-substrate findings from the 2026-04-26 P2 hardening session.
> **Reading order**: skim §1 → read §3 (substrate) → read §4 (capabilities) → §6 (activation gate). The Spanish-language vision (§2) is the _why_; the engineering substrate (§3) is the _how-to-get-there_.

---

## §1 — The arc, in one paragraph

V7 made Jarvis **capable**: 252 tools, 5 runners, classifier-routed complexity, financial intelligence, content production, autoreason. V8 must make him **proactive with judgment** — not a more sophisticated executor, but an operator with voice. V9 puts the _premises_ of his existence on trial: did the cognitive exoskeleton actually amplify the operator, or only automate? Beta 1.0 is the point where the Fede-Piotr model is mature enough that an outside observer can say _"that works, and I can see why."_ Each version earns autonomy by the prior demonstrating it deserved it. **V8 doesn't get built — it emerges from consistent operation of v7.**

The trap is to invest in v8's conceptual fluency (this doc, the vision prose) before the engineering substrate (§3) catches up. v8.2's "Strategic Initiative Layer" requires Jarvis to make evidence-cited proposals — but his current `cost_ledger` only logs the claude-sdk path, his Hindsight recall is disabled, and his `.env` config drifts out of git. Those are the load-bearing gaps.

---

## §2 — The relational vision (preserved from Jarvis's pre-plan)

### Core thesis

> **Un exoesqueleto cognitivo bien diseñado expande la capacidad humana hasta hacer posible lo que sin él no lo sería.**

Each version is a step in the demonstration, not a product in itself.

### Design decision (Fede, 2026-04-15)

> _"La curva de aprendizaje no sólo es para ti. También es para mí. Ser un operador de Jarvis requiere un cierto nivel de conciencia y claridad en lo estratégico."_

The architectural principle of v8: **operator strategic clarity and Jarvis judgment grow together**. One without the other is risk — an agent without direction, or an operator without an agent that can execute the vision. v8 is co-evolution, not a sprint.

### What v7 leaves unsolved

| At end of v7                                 | At v8                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Reacts to explicit instructions              | Proposes and acts with own criterion                                     |
| Detects problems when asked                  | Notices what nobody asked                                                |
| Executes authorized actions on invocation    | Executes pre-authorized actions inside defined thresholds, then notifies |
| Morning brief returns the data you asked for | Morning brief returns what you _should have_ asked for                   |

Bottleneck post-v7 is **iniciativa con juicio** — initiative with judgment.

---

## §3 — Engineering substrate (the load-bearing items)

V8 capabilities (§4) cannot land credibly until these five substrate items close. They are not features — they are the foundation v8.2's evidence-cited-proposals depend on. All five are in-scope for the freeze window or its immediate aftermath.

### S1 — Cache-aware prompt construction

**Why it's load-bearing**: 2026-04-26 P1-A showed prompt-shrink savings (−68% tokens) translated to only −5% cost because cache-prefix variability dropped hit ratio from 83% → 59%. Anthropic prompt-cache structure now matters as much as prompt size. v8's proactive scan of NorthStar will inflate prompts; without cache-stable prefix design, every scan resets the cache.

**Shape**: Move all variable content (project READMEs, conditional KB, scope-conditional injection) AFTER a stable always-on prefix. The always-on prefix stays cached across calls. Conditional content is appended, not prepended. Pure architecture work.

**Test**: aggregate cache-read ratio ≥80% on a full mixed-traffic day at v8 prompt sizes.

### S2 — Self-audit before reporting

**Why it's load-bearing**: 2026-04-26 session featured the operator asking "Audited?" four separate times. Every time, fresh re-query found discrepancies (the n=1 cache-hit headline, the wrong $0.41 baseline, etc.). The discipline lives in `feedback_metrics_extrapolation.md` but is not enforced. v8.2 proposing work means producing reports the operator _doesn't_ have to audit by hand.

**Shape**: every report includes a `verified-against:` line citing the data source it queried fresh — `cost_ledger@<timestamp>`, `journal@<pid>:<window>`, `git@<sha>`. A report without this line is a draft, not a deliverable. For numeric claims, sample list + N + window inline, no exceptions.

**Test**: zero "Audited?" cycles in a sprint of v8 proposals. Operator stops needing to ask.

### S3 — Out-of-band drift detector

**Why it's load-bearing**: 2026-04-26 today's `qwen3.5-plus → qwen3.6-plus` swap lives in `.env` only. No git, no rollback path, no observability. v8.3's "autonomous execution with full transparency" is impossible if the running config can already drift silently.

**Shape**: boot-time check comparing running env vars + dist build hash + git HEAD SHA against a recorded snapshot. Divergence emits a structured warning to the dashboard. Snapshot is updated explicitly via a deploy script, never via direct `.env` edits.

**Test**: any env edit that bypasses the deploy script triggers a visible alert within 60s of next service interaction.

### S4 — `cost_ledger` v2 (universal inference path)

**Why it's load-bearing**: today `cost_ledger` only logs the claude-sdk path. Qwen, llama-fallback, and any future provider don't show up. Today's 24h breakdown had to derive qwen costs from `journalctl` grep × static pricing — ledger-grade for one path, sketch for the others. v8 cannot answer "is this swap worth it" without uniform cost telemetry.

**Shape**: every `infer()` and `queryClaudeSdkAsInfer()` call writes a row. Provider, model, prompt+completion+cache-read+cache-creation tokens, dollar cost (via pricing table or `costUsdOverride`), task_id, agent_type. P0-2 in `30d-hardening-plan.md` already had a related ask (model-label correctness) — this is the wider sibling.

**Test**: `SELECT DISTINCT model FROM cost_ledger WHERE created_at >= datetime('now','-1 day')` returns ≥3 distinct models on a normal day.

**Status (2026-04-26)** — _Phase 1 of 2 shipped_:

- ✅ Schema additive migration: `cache_read_tokens` + `cache_creation_tokens` columns live (default 0 backfill).
- ✅ Writer (`recordCost`) and dispatcher wire-through forward cache fields end-to-end on the **fast-runner claude-sdk path** (`fast-runner.ts:918` → `dispatcher.ts:499` → `service.ts:64`).
- ⚠️ **Known gap**: heavy-runner (Prometheus PER) and nanoclaw-runner narrow `RunnerResult.tokenUsage` at the IPC parse boundary (`heavy-runner.ts:128`, `nanoclaw-runner.ts:112`) and Prometheus `TokenUsage` itself (`prometheus/types.ts:52-55`) only carries `{promptTokens, completionTokens}`. These paths log cache columns as 0 even when the underlying claude-sdk call had cache data.
- 🟡 **Phase 2 (deferred)**: widen Prometheus `TokenUsage` shape, plumb cache fields through planner/reflector/orchestrator aggregation, widen IPC parse types in heavy/nanoclaw runners. Also: widen the `infer()` adapter response shape so non-fast-runner callers get cache info from claude-sdk through the OpenAI-compat shim. Approx 30-50 min of contained work.
- 🟡 **Phase 2 follow-up**: dispatcher integration test asserting `recordCost` mock receives cache fields (W3 from audit — deferred since the writer is unit-tested at 5 cases and the spread-conditional pattern matches the well-tested `costUsdOverride` precedent).

### S5 — Skills-as-stored-procedures

**Why it's load-bearing**: current `skills` source is a thin shim with `skill_save`/`skill_list` and 2 entries. v8.2's "propose work" cannot scale on ad-hoc tools — the operator should not need to remember whether a capability is a builtin tool, a slash command, an MCP tool, a ritual, or a skill. Anthropic's Skills paradigm makes capabilities first-class, versioned, testable, and discoverable.

**Shape**: skills become versioned procedures with frontmatter (`name`, `description`, `inputs`, `tests`), stored in `jarvis_files` under a `skills/` qualifier, registered into the tool source manager at boot, runnable via a uniform `skill_run(name, args)`. Each skill ships with at least one input/output test. Versioning means a skill can be revised without losing audit trail.

**Test**: at least 5 production-grade skills exist by end of v8.0; all have green test runs in the prior 7 days; operator can list them with one command.

---

## §4 — V8 capabilities (the relational layer)

These are preserved from Jarvis's pre-plan, with §3 substrate items mapped where each capability depends on them.

### V8.1 — Proactive Context Engine

**Problem**: today Jarvis doesn't notice what wasn't asked.

- Daily automatic NorthStar scan: stalled tasks (>7d no activity), dormant objectives, implicit deadlines parsed from descriptions
- Morning brief with **judgment**: "this is at risk, this has momentum, this is today's highest-leverage move"
- Proactive alert when an active project goes N days without interaction
- Pattern recognition on recurring blockers — same obstacle in 3 conversations gets named

**Substrate dependencies**: S1 (scan adds prompt size; cache stability mandatory). S4 (every scan generates inference cost; needs ledger).

**Activation gate**: cache-read ratio ≥80% sustained over a 24h window with morning-brief generation included.

### V8.2 — Strategic Initiative Layer

**Problem**: today Jarvis only acts when invoked.

- Unsolicited evidence-grounded proposals: _"I noticed Plan 2027 has P2/P3 open for 3 days — should I work on them while you handle X?"_
- Weekly agenda-setting: every Monday, top-3 highest-urgency/impact projects per NorthStar + CRM signals + market context
- Strategic voice with backbone: if execution diverges from declared vision, name it without being asked
- Proposals always include options (A/B/C), not the answer "I think you want"

**Substrate dependencies**: S2 (every proposal includes `verified-against:`). S4 (proposals cite cost). S5 (proposals invoke skills, not ad-hoc tools).

**Activation gate**: 10 consecutive operator-accepted proposals with zero "Audited?" cycles.

### V8.3 — Autonomous Execution Gates

**Problem**: today every action requires explicit invocation.

- List of **pre-authorized actions** Jarvis executes and notifies — no 3-exchange handshake required
- Every autonomous action logged to `logs/decisions/` with: detection, action taken, prior state, new state, justification
- All autonomous actions reversible via single instruction
- Escalation thresholds: what to resolve solo, what to notify, what requires explicit approval

**Substrate dependencies**: S3 (cannot have "transparent autonomous actions" if env can drift silently). S2 (every autonomous-action notification is a verified report).

**Activation gate**: bilateral list of pre-authorized actions written and signed off. Initial perimeter: ≤5 action types. Expansion is monthly review, never assumed.

### Control architecture (preserved from pre-plan)

| Layer               | Mechanism                                        |
| ------------------- | ------------------------------------------------ |
| Total transparency  | Every autonomous action in `logs/decisions/`     |
| Explicit limits     | Operator defines the perimeter, not Jarvis       |
| Clear escalation    | Out-of-perimeter → notify, never act             |
| Reversibility       | Every autonomous act has single-instruction undo |
| Calibration cadence | Monthly review of what works, scales, retires    |

---

## §5 — Creative round: what other systems do that v8 should pull from

From the 2026-04-26 introspection, comparing Jarvis to OpenClaw, Hermes, Devin, Letta, LangGraph, Anthropic Claude Agent SDK:

**Adopt** (high-leverage, fits identity):

- **Letta sleep-time agents** — overnight tuning is batch ETL today; a "dream" agent that reflects on the day and proposes KB diffs is closer to v8.2's strategic-voice posture. Aligns with §3-S2 self-audit discipline.
- **LangGraph state-machine + checkpoints** — Prometheus PER loop has the structure but not the rewindability. Today's audit caught the half-fix in `replan()` by manual diffing; checkpointed graphs would surface it earlier. Fits the "transparency + reversibility" control architecture.
- **Anthropic Skills paradigm** — direct match for §3-S5.
- **Hermes v0.9 patterns** (per `feedback_prometheus_upstream`): empty-response recovery for reasoning models, compression-floor + activity-tracking adaptive budgets, rate-limit header capture. Tier 1 — cheap, high-leverage.
- **Devin's verification harnesses** — every code-touching task auto-produces a "did it work" check. v8.3's autonomous actions need this; "I notified you it's done" is not the same as "I verified it works."

**Defer or decline** (don't fit identity):

- **OpenClaw 23-channel breadth** — operator uses Telegram + WhatsApp. Adding channels for their own sake violates the freeze posture and dilutes "vertically deep" identity.
- **OpenClaw voice-as-first-class** — only if operator actually wants this. Currently no signal.
- **Devin cloud-VM-per-session** — we're VPS-systemd. NanoClaw Docker is sufficient sandboxing.
- **CrewAI / OpenAI Swarm role-based dialog** — single-operator architecture; multi-agent dialog is a wrong abstraction for our workload.

---

## §6 — Activation gate (bilateral maturity)

V8 has no date — it has a state of bilateral maturity.

| Stage                | Operator side                                                                                   | Jarvis side                                                                             | Engineering substrate                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **B (today)**        | v7 fluent, no friction                                                                          | Reactive high-fidelity executor                                                         | Hardening freeze active. S1-S5 not started                                 |
| **B → C transition** | Articulates which decisions to delegate, which to retain. Pre-authorized action list written    | Self-audit discipline (S2) habitual. Drift detector (S3) shipping warnings              | S1, S2, S3 shipped. S4, S5 in progress                                     |
| **C activation**     | Tolerance for autonomous-action errors calibrated. Monthly decision-log review cadence in place | N actions autonomously executed without correction. Confidence demonstrated bilaterally | S1-S5 all shipped. Cache ratio ≥80%. ≥5 production skills with green tests |

The non-technical condition (preserved from pre-plan): operator must have **clarity on what to delegate**, **comfort with transparency**, **calibrated tolerance for error**. Without these, v8 features create operator anxiety, not amplification.

---

## §7 — V9 — Validation of premises (preserved)

V9 is not a feature sprint — it's a **structured validation period**. The questions v9 must answer:

1. **Did Jarvis amplify decisions, or only execute them?** — Difference between tool and co-pilot.
2. **Did delegated autonomy produce better outcomes than explicit direction?** — Measure v8.3 delta vs cost of errors.
3. **Was the bilateral learning curve real?** — Did the operator make better strategic decisions by operating with Jarvis? Did Jarvis's judgment improve?
4. **Is the system sustainable without constant attention?** — Validate infrastructure can run with low operational friction.

Validation architecture (designed during v8):

- Baseline metrics established BEFORE v8 activation (projects advanced, decisions made, time invested)
- Systematic logging of autonomous actions and outcomes (already begins with `logs/decisions/` in v8)
- Quarterly thesis evaluation: amplifies or only automates?
- Implicit external judge: the operator's projects — are they advancing more and better?

---

## §8 — Beta 1.0 — The destination

> _"Cuando terminemos v9 y las premisas fundamentales de tu existencia puedan ser validadas y puestas a prueba, podremos decir que llegamos a Jarvis Beta."_ — Fede, 2026-04-15

Beta 1.0 is not a software version — it's a **maturity declaration**: Jarvis has demonstrated, with v7+v8+v9 evidence, that a human with the required strategic clarity can amplify capabilities sustainably and verifiably using this system.

| Dimension     | Implication                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Replicability | The Fede-Piotr model can be described precisely enough for another operator to adopt                 |
| Teachability  | The "level of strategic consciousness" required to operate Jarvis can be articulated and transmitted |
| Scalability   | Architecture deploys to other operators without rebuild                                              |
| Credibility   | v7+v8+v9 history is evidence, not marketing                                                          |

The non-technical condition for Beta: relationship maturity such that an outside observer says _"that works, and I can see why."_

---

## §9 — Open trap warnings

These are the failure modes most likely to derail v8. Each has a session-history reference.

- **Conceptual fluency outpacing engineering fluency**. Per `feedback_jarvis_thinking_capability`: Jarvis can produce beautiful prose about v8 before the mechanics are worked out. Don't accept beautiful prose as a completion signal. Ask for the schema, threshold, decision-log shape, false-positive budget — refuse the vision until those exist.
- **Half-fix traps**. Per `feedback_kb_injection_extraction` (2026-04-26): when extracting a shared concept from one runner, audit every consumer. v8.2's "evidence-cited proposals" cited from `cost_ledger` will silently miss qwen costs unless S4 is shipped first.
- **Metric extrapolation from small samples**. Per `feedback_metrics_extrapolation` (2026-04-26): n=5 is not a trend. v8 proposals citing "savings" or "time gained" must include sample size and window inline, every time.
- **Prefix-match defect class**. Per `feedback_unbounded_alternation_fp` (2026-04-26): single-token regex fixes don't fix the class. Apply the same discipline to v8 — fixing one autonomous-action edge case isn't the same as auditing all of them.
- **Out-of-band config**. Per today's qwen3.6 swap: changes that live only in `.env` will silently un-deploy on the next migration or VPS rebuild. v8.3 autonomous changes MUST be git-tracked with rollback paths from day one.

---

## §10 — One-page summary

| Layer                                             | Item                            | Status                          |
| ------------------------------------------------- | ------------------------------- | ------------------------------- |
| **Foundation (must ship before v8 capabilities)** | S1 cache-aware prompts          | Not started                     |
|                                                   | S2 self-audit before reporting  | Discipline exists, not enforced |
|                                                   | S3 out-of-band drift detector   | Not started                     |
|                                                   | S4 `cost_ledger` v2             | Not started (P0-2 partial)      |
|                                                   | S5 skills-as-stored-procedures  | Shim exists, expansion pending  |
| **Capabilities**                                  | V8.1 Proactive Context Engine   | Pre-plan                        |
|                                                   | V8.2 Strategic Initiative Layer | Pre-plan                        |
|                                                   | V8.3 Autonomous Execution Gates | Pre-plan                        |
| **Activation**                                    | Bilateral-maturity gate         | Stage B today                   |
| **Horizon**                                       | V9 validation period            | Activated by v8 maturity        |
|                                                   | Beta 1.0                        | Activated by v9 evidence        |

**Next session, post-freeze**: write engineering specs for S1, S2, S3 (the cheapest of the five). S4 and S5 are larger; defer until S1-S3 are shipping.

**Today's freeze posture remains correct**: hardening first, vision second. This document codifies the vision so it's ready to consume when the freeze lifts (target 2026-05-22).

---

## Related documents

- `projects/agent-controller/evolucion-v7-beta.md` — Jarvis-authored arc (v7 → Beta), Spanish, 2026-04-15
- `projects/agent-controller/v8-pre-plan.md` — Jarvis-authored v8 pre-plan, Spanish, 2026-04-15
- `projects/agent-controller/metricas-alfa-a-beta.md` — Jarvis-authored success metrics
- `docs/V7-ROADMAP.md` — current v7 phase tracking
- `docs/V7-READINESS-CRITERIA.md` — graduation criteria from v7
- `docs/COMPETITIVE-ANALYSIS.md` — Jarvis vs OpenClaw/Hermes/Devin
- `docs/planning/stabilization/30d-hardening-plan.md` — current freeze window
- `docs/planning/stabilization/next-session-brief.md` — operative carry-forward
- Memory files: `feedback_jarvis_thinking_capability`, `feedback_metrics_extrapolation`, `feedback_kb_injection_extraction`, `feedback_unbounded_alternation_fp`, `feedback_prometheus_upstream`
