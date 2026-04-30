# V8 Vision — Autonomía Estratégica + Engineering Substrate

> **Status**: Pre-plan. No activation date. Bilateral-maturity gated.
> **Prerequisite**: v7 stable + 30d hardening window (2026-04-22 → 2026-05-22) cleanly closed.
> **Authored**: 2026-04-26, consolidating Jarvis-authored vision (`projects/agent-controller/evolucion-v7-beta.md`, `v8-pre-plan.md`, both 2026-04-15) with engineering-substrate findings from the 2026-04-26 P2 hardening session.
> **Reading order**: skim §1 → read §3 (substrate) → read §4 (capabilities) → §6 (activation gate). The Spanish-language vision (§2) is the _why_; the engineering substrate (§3) is the _how-to-get-there_.

---

## §1 — The arc, in one paragraph

V7 made Jarvis **capable**: 252 tools, 5 runners, classifier-routed complexity, financial intelligence, content production, autoreason. V8 must make him **proactive with judgment** — not a more sophisticated executor, but an operator with voice. V9 puts the _premises_ of his existence on trial: did the cognitive exoskeleton actually amplify the operator, or only automate? Beta 1.0 is the point where the Fede-Piotr model is mature enough that an outside observer can say _"that works, and I can see why."_ Each version earns autonomy by the prior demonstrating it deserved it. **V8 doesn't get built — it emerges from consistent operation of v7.**

The trap is to invest in v8's conceptual fluency (this doc, the vision prose) before the engineering substrate (§3) catches up. v8.2's "Strategic Initiative Layer" requires Jarvis to make evidence-cited proposals — but his current `cost_ledger` only logs the claude-sdk path, his Hindsight recall is disabled, and his `.env` config drifts out of git. Those are the load-bearing gaps.

**The lineage** (added 2026-04-30 from bibliography wave 4): the V8.1 → V8.2 → V8.3 progression is Wiener's **Communication → Consent → Control** ladder, exactly. V8.1 communicates state. V8.2 builds informed consent through evidence-cited judgments. V8.3's autonomy is **legitimate only because V8.2 produced consent first** — without V8.2, V8.3 would be unilateral causation, the failure mode Wiener named in _The Human Use of Human Beings_ (1950). And the design thesis is Kasparov's centaur formula: in the 2005 PAL/CSS Freestyle final, two amateurs (USCF 1685 + 1398) plus three commodity engines plus **better process** beat a 2600-rated GM with engine assistance, 2.5–1.5. _"Weak human + machine + better process was superior to a strong computer alone and, more remarkably, superior to a strong human + machine + inferior process."_ V8 is the operationalization of "better process" for an operator's strategic life. Process > capability.

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

**Spec (2026-04-30)** — _Authored_: full spec at `docs/planning/v8-substrate-s1-spec.md`. ~5 days post-freeze. Adds canonical prefix layout + pre-flight linter + per-tool cache config + `cost_ledger` instrumentation + S3 watchpoint. V8.2's strategic-voice principle block is the canonical case S1 protects.

**Status (2026-04-26)** — _Partial ship_:

- ✅ `buildJarvisSystemPrompt` returns `{stable, variable}` instead of one concatenated string. Stable = P1+P2 (identity, safety, capabilities, personalData, correctionMemory). Variable = P3+P4 (scope-conditional sections + userFacts + enrichment).
- ✅ New `buildKnowledgeBaseSections(scopedTools, messageText, logTag)` exposes split KB: stable = enforce + always-read, variable = conditional + project README.
- ✅ Router callers concatenate as `stable + CACHE_BREAK_MARKER + variable + extras`. Per-call extras (patternBlock, checkpointBlock, time context, agent boilerplate) attach to the variable half.
- ✅ Fast-runner chat branch splits `input.description` on the marker and emits messages in cache-friendly order: stable persona + STATUS_SUFFIX → essentials → stable KB → variable persona → variable KB → precedent → deferredCatalog. Read-only path keeps legacy enforce-only KB call (already stable).
- ✅ Heavy/nanoclaw/swarm runners strip the marker (treat description as a single blob — no regression vs pre-S1).
- ✅ A2A runner + A2A mapper strip the marker before sending to remote peers (audit C1, C2 fix).
- ✅ Dispatcher persistence strips the marker before INSERT into `tasks.description`, `runs.input`, and event emissions (audit W1 fix). DB stays clean; runners still receive the marker via in-memory submission.
- ✅ 7 new unit tests (4 for `buildKnowledgeBaseSections`, 3 for `stripCacheMarker`).
- 🟡 **Validation pending**: post-deploy organic traffic needs ~24h to accrue N≥30 fast-runner tasks. Pre-S1 baseline (post-S4) was 81% average across n=5. Test bar is ≥80% on a full mixed-traffic day at v8 prompt sizes — measurement runs against `cost_ledger.cache_read_tokens / cost_ledger.prompt_tokens` over the post-2026-04-26 20:23 window.

### S2 — Self-audit before reporting

**Why it's load-bearing**: 2026-04-26 session featured the operator asking "Audited?" four separate times. Every time, fresh re-query found discrepancies (the n=1 cache-hit headline, the wrong $0.41 baseline, etc.). The discipline lives in `feedback_metrics_extrapolation.md` but is not enforced. v8.2 proposing work means producing reports the operator _doesn't_ have to audit by hand.

**Shape**: every report includes a `verified-against:` line citing the data source it queried fresh — `cost_ledger@<timestamp>`, `journal@<pid>:<window>`, `git@<sha>`. A report without this line is a draft, not a deliverable. For numeric claims, sample list + N + window inline, no exceptions.

**Test**: zero "Audited?" cycles in a sprint of v8 proposals. Operator stops needing to ask.

**Status (2026-04-30)** — _Specced, not shipped_. Full design at `docs/planning/v8-substrate-s2-spec.md`. Composes DATAGEN's note-agent JSON-schema enforcement with Voyager's critic-as-write-gate. Phase 1 (harness + schema, ~3 days) + Phase 2 (`morning_brief` retrofit, ~2 days) post-freeze. 6 open questions, none blocking.

### S3 — Out-of-band drift detector

**Why it's load-bearing**: 2026-04-26 today's `qwen3.5-plus → qwen3.6-plus` swap lives in `.env` only. No git, no rollback path, no observability. v8.3's "autonomous execution with full transparency" is impossible if the running config can already drift silently.

**Shape**: boot-time check comparing running env vars + dist build hash + git HEAD SHA against a recorded snapshot. Divergence emits a structured warning to the dashboard. Snapshot is updated explicitly via a deploy script, never via direct `.env` edits.

**Test**: any env edit that bypasses the deploy script triggers a visible alert within 60s of next service interaction.

**Spec (2026-04-30)** — _Authored_: full spec at `docs/planning/v8-substrate-s3-spec.md`. ~5 days. Three small tables (`drift_signals`, `drift_alerts`, `baseline_history`) + cron evaluator + 12 seed signals across S1/S2/V8.2/V8.3/S5/infra. Correlated-burst detection (3+ alerts in 5min = bundled root-cause hint) handles cascading-bug pattern. P0/P1/P2 priority + per-cadence eval (hourly/nightly/weekly/on_event) + V8.1 morning-brief delivery hook. Not freeze-blocking; pure observability layer. 8 open questions, none blocking.

### S4 — `cost_ledger` v2 (universal inference path)

**Why it's load-bearing**: today `cost_ledger` only logs the claude-sdk path. Qwen, llama-fallback, and any future provider don't show up. Today's 24h breakdown had to derive qwen costs from `journalctl` grep × static pricing — ledger-grade for one path, sketch for the others. v8 cannot answer "is this swap worth it" without uniform cost telemetry.

**Shape**: every `infer()` and `queryClaudeSdkAsInfer()` call writes a row. Provider, model, prompt+completion+cache-read+cache-creation tokens, dollar cost (via pricing table or `costUsdOverride`), task_id, agent_type. P0-2 in `30d-hardening-plan.md` already had a related ask (model-label correctness) — this is the wider sibling.

**Test**: `SELECT DISTINCT model FROM cost_ledger WHERE created_at >= datetime('now','-1 day')` returns ≥3 distinct models on a normal day.

**Status (2026-04-26)** — _Phase 1 + Phase 2 shipped_:

- ✅ Schema additive migration: `cache_read_tokens` + `cache_creation_tokens` columns live (default 0 backfill).
- ✅ Writer (`recordCost`) and dispatcher wire-through forward cache fields end-to-end on the **fast-runner claude-sdk path** (`fast-runner.ts:918` → `dispatcher.ts:499` → `service.ts:64`).
- ✅ **Phase 2 (2026-04-26)**: cache breakdown extended end-to-end through Prometheus internals so heavy-runner + nanoclaw-runner cost_ledger rows now persist cache fields when the underlying SDK call had cache data. Type widenings: `InferenceResponse.usage` + `inferWithTools().totalUsage` (adapter.ts), `TokenUsage` (prometheus/types.ts), snapshot tokenUsage (snapshot.ts), heavy/nanoclaw IPC parse types. Producers forward via spread+conditional: planner.ts (plan + replan), reflector.ts, provenance.ts, executor.ts (selfAssess + per-goal + per-execution accumulators), orchestrator.ts (snapshot read + plan + execution + replan + reflect aggregations + final assembly), resume.ts. Heavy-runner narrowing site at `heavy-runner.ts:55-63` forwards cache from `result.tokenUsage`. SDK shim emits cache fields conditionally (omit when zero) so its shape matches the openai path's. 2 new claude-sdk.test.ts tests assert shim forwarding (215 inference tests pass).
- ⚠️ **Phase 2 deliberately skipped**: swarm-runner.ts hardcodes `{promptTokens:0, completionTokens:0}` regardless of children — that's "doesn't track at all" not "narrows the type", separate concern.
- 🟡 **Audit-deferred**: dispatcher integration test asserting `recordCost` mock receives cache fields; prometheus executor regression test for omit-vs-zero contract. Both deferred since shim+writer boundary unit tests + cost_ledger live verification cover the path mechanically.

**Spec (2026-04-30)** — _Authored_: full spec at `docs/planning/v8-substrate-s4-spec.md`. ~4.5 days. Universal `inference_events` schema + per-provider pricing table + budget tracking + 4 rollup views. Adapter shims for claude-sdk, anthropic-direct, openai, qwen, vllm-local. Decision-level + judgment-level cost attribution. IPC parse correctness as part of activation gate. Two drift signals emitted to S3 (`s4_budget_warn` P2, `s4_budget_hard_cap` P0). Default budgets seeded at $5/day, $30/week, $100/month. 10 open questions, none blocking.

### S5 — Skills-as-stored-procedures

**Why it's load-bearing**: current `skills` source is a thin shim with `skill_save`/`skill_list` and 2 entries. v8.2's "propose work" cannot scale on ad-hoc tools — the operator should not need to remember whether a capability is a builtin tool, a slash command, an MCP tool, a ritual, or a skill. Anthropic's Skills paradigm makes capabilities first-class, versioned, testable, and discoverable.

**Shape**: skills become versioned procedures with frontmatter (`name`, `description`, `inputs`, `tests`), stored in `jarvis_files` under a `skills/` qualifier, registered into the tool source manager at boot, runnable via a uniform `skill_run(name, args)`. Each skill ships with at least one input/output test. Versioning means a skill can be revised without losing audit trail.

**Test**: at least 5 production-grade skills exist by end of v8.0; all have green test runs in the prior 7 days; operator can list them with one command.

**Status (2026-04-30)** — _Specced, not shipped_. Full design at `docs/planning/v8-substrate-s5-spec.md`. Builds on existing 57-skill shim (`src/db/skills.ts`). Composes DATAGEN's frontmatter contract + 3-level disclosure with Voyager's description-embedding + critic-as-gate + failed-tasks anti-list. ~10 days post-freeze across 5 phases. 7 open questions, none blocking. Reuses S2 critic primitive.

---

## §4 — V8 capabilities (the relational layer)

These are preserved from Jarvis's pre-plan, with §3 substrate items mapped where each capability depends on them.

**Lineage** (Wiener 1948 / 1950, per `reference_wiener_cybernetics.md`): the three layers are **Communication (V8.1) → Consent (V8.2) → Control (V8.3)**, in that exact order. V8.1 surfaces signal. V8.2 surfaces _opinionated, cited, multi-option judgments_ — the consent material, the load-bearing ethical layer. V8.3 takes autonomous action _only because V8.2 already informed the operator's strategic posture_. Skipping V8.2 turns V8.3 from consented control into unilateral causation. This is the failure mode that legacy "automation that thinks for you" exhibits.

### V8.1 — Proactive Context Engine

**Problem**: today Jarvis doesn't notice what wasn't asked.

- Daily automatic NorthStar scan: stalled tasks (>7d no activity), dormant objectives, implicit deadlines parsed from descriptions
- Morning brief with **judgment**: "this is at risk, this has momentum, this is today's highest-leverage move"
- Proactive alert when an active project goes N days without interaction
- Pattern recognition on recurring blockers — same obstacle in 3 conversations gets named

**Substrate dependencies**: S1 (scan adds prompt size; cache stability mandatory). S4 (every scan generates inference cost; needs ledger). **Conway Pattern 1** (general-events middle layer — V8.1 cannot construct judgments without it). **Conway Pattern 2** (self-defining cohort — V8.1 reads as generic without it).

**Activation gate**: cache-read ratio ≥80% sustained over a 24h window with morning-brief generation included.

**Status (2026-04-30)** — _Specced, not shipped_. Full design at `docs/planning/v8-capability-1-spec.md`. Composes Letta sleep-time pattern (N-turn trigger + bounded cursor + role-reframe) with Conway SMS Patterns 1+2+3 (general events + self-defining cohort + coherence/correspondence modes). ~18 days post-freeze across 9 phases; Phases 1-3 (Conway-pattern foundations) can ship independently. 7 open questions, none blocking. Reuses S2 critic + S5 skill registration.

### V8.2 — Strategic Initiative Layer

**Problem**: today Jarvis only acts when invoked.

- Unsolicited evidence-grounded proposals: _"I noticed Plan 2027 has P2/P3 open for 3 days — should I work on them while you handle X?"_
- Weekly agenda-setting: every Monday, top-3 highest-urgency/impact projects per NorthStar + CRM signals + market context
- Strategic voice with backbone: if execution diverges from declared vision, name it without being asked
- Proposals always include options (A/B/C), not the answer "I think you want"

**Substrate dependencies**: S2 (every proposal includes `verified-against:`). S4 (proposals cite cost). S5 (proposals invoke skills, not ad-hoc tools). **S1** (strategic-voice principle block must live in stable cache prefix per `docs/planning/v8-substrate-s1-spec.md`).

**Activation gate**: 10 consecutive operator-accepted proposals with zero "Audited?" cycles. Per spec activation queries: 7-day shadow run with ≥95% citation-resolver success + ≤5% sycophancy concede-without-evidence + green/red promote-rate ratio ≥1.5×.

**Status (2026-04-30)** — _Specced, not shipped_. Full design at `docs/planning/v8-capability-2-spec.md` (~821 lines). 8 phases, ~14 days post-V8.1. Composes 11 reference primitives: Anthropic Agentic Research (decomposition contract + CitationAgent) + Perplexity (`[N]` poka-yoke) + Constitutional AI v2 + Sycophancy (strategic-voice principle + `concession_kind` + Sharma 2-turn probe) + RAPID-D (4-role multi-option) + CRITIC + Self-Refine (tool-grounded SQL critic, 2-loop budget, tri-state verdict) + DeepMind Process Supervision (step-tagged drafts) + Devin (confidence-as-control-flow) + Lee & See 2004 (anthropomorphism guard — mechanical confidence). 7 open questions. **V8.2 is the consent layer; V8.3 cannot legitimately fire without it.**

### V8.3 — Autonomous Execution Gates

**Problem**: today every action requires explicit invocation.

- List of **pre-authorized actions** Jarvis executes and notifies — no 3-exchange handshake required
- Every autonomous action logged to `logs/decisions/` with: detection, action taken, prior state, new state, justification
- All autonomous actions reversible via single instruction
- Escalation thresholds: what to resolve solo, what to notify, what requires explicit approval

**Substrate dependencies**: S3 (cannot have "transparent autonomous actions" if env can drift silently). S2 (every autonomous-action notification is a verified report). **V8.2 (load-bearing prerequisite — V8.3 decisions at L≥3 require linked V8.2 judgment with confidence ∈ {green, yellow}).**

**Activation gate**: bilateral list of pre-authorized actions written and signed off. Initial perimeter: ≤5 action types. Expansion is monthly review, never assumed. Per spec: 7-day shadow run on default-L1 capabilities; operator explicitly signs off the first L1→L2 promotion as smoke test.

**Status (2026-04-30)** — _Specced, not shipped_. Full design at `docs/planning/v8-capability-3-spec.md` (~821 lines). 12 phases, ~18 days post-V8.2. Composes Anthropic Computer Use (capability tokens + `<external_content trust="untrusted">` envelope + paired `reversal_op`) + LangGraph checkpoints (4-tuple key, super-step granularity, parent-pointer fork) + SAE J3016 + Knight Institute autonomy levels (per-capability L0-L5 + ODD predicates) + ADR + Event Sourcing (MADR-adapted `logs/decisions/<id>.md` + `decision_events`) + Wiener PI controller (`level_adjustment = round(8·e + 2·Σe)`, no D term) + Lee & See asymmetric thresholds (slow promote ≥4 weeks, fast demote >5%) + cline shadow-Git per-workspace 3-mode restore (fills gap LangGraph + ADR missed for filesystem mutations) + PheroPath signal taxonomy + Kasparov L5-expiration test. 10 open questions. **Bilateral-maturity gating strongest here**: no L3+ activation without operator signing off per-capability.

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
- **Coherence drift toward confabulation**. Per Conway 2005 SMS framework (`reference_conway_2005_sms.md`) and empirical instance in `feedback_completed_task_failure_narrative.md`: pure-coherence recall (default outcome filter excluding failures) without a periodic correspondence audit drifts toward confidently-wrong system over time. Pattern 3 (named recall modes + weekly correspondence-audit task) is the codified defense.

---

## §10 — One-page summary

| Layer                                             | Item                            | Status                                                                                                                             |
| ------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Foundation (must ship before v8 capabilities)** | S1 cache-aware prompts          | **Shipped 2026-04-26** — split persona + KB into stable/variable, marker-based emission via fast-runner. Validation pending N≥30   |
|                                                   | S2 self-audit before reporting  | **Specced 2026-04-30** — `docs/planning/v8-substrate-s2-spec.md`. Implementation post-freeze (~5 days, 2 phases)                   |
|                                                   | S3 out-of-band drift detector   | Not started                                                                                                                        |
|                                                   | S4 `cost_ledger` v2             | **Phases 1+2 shipped 2026-04-26** — cache breakdown end-to-end on fast/heavy/nanoclaw paths. Swarm zero-track is separate concern. |
|                                                   | S5 skills-as-stored-procedures  | **Specced 2026-04-30** — `docs/planning/v8-substrate-s5-spec.md`. 57-skill shim extended; ~10 days post-freeze, 5 phases           |
| **Capabilities**                                  | V8.1 Proactive Context Engine   | Pre-plan                                                                                                                           |
|                                                   | V8.2 Strategic Initiative Layer | Pre-plan                                                                                                                           |
|                                                   | V8.3 Autonomous Execution Gates | Pre-plan                                                                                                                           |
| **Activation**                                    | Bilateral-maturity gate         | Stage B today                                                                                                                      |
| **Horizon**                                       | V9 validation period            | Activated by v8 maturity                                                                                                           |
|                                                   | Beta 1.0                        | Activated by v9 evidence                                                                                                           |

**Next session, post-freeze**: write engineering specs for S1, S2, S3 (the cheapest of the five). S4 and S5 are larger; defer until S1-S3 are shipping.

**Today's freeze posture remains correct**: hardening first, vision second. This document codifies the vision so it's ready to consume when the freeze lifts (target 2026-05-22).

---

## Related documents

- `docs/planning/v8-where-we-are-going.md` — **post-freeze orientation doc** (2026-04-30); plain-language map across all V8 specs + activation order + gating discipline + risks; start here if you want the path before the depth
- `docs/planning/v8-bibliography-synthesis.md` — meta-index across 28 reference memories (waves 1-7, 100% bibliography coverage; ports/rejects/pattern catalog)
- `docs/planning/v8-substrate-s1-spec.md` — S1 cache-aware-prompts full spec (2026-04-30)
- `docs/planning/v8-substrate-s2-spec.md` — S2 self-audit-before-reporting full spec (2026-04-30)
- `docs/planning/v8-substrate-s3-spec.md` — S3 out-of-band drift detector full spec (2026-04-30)
- `docs/planning/v8-substrate-s4-spec.md` — S4 cost_ledger v2 universal inference path full spec (2026-04-30)
- `docs/planning/v8-substrate-s5-spec.md` — S5 skills-as-stored-procedures full spec (2026-04-30)
- `docs/planning/v8-capability-1-spec.md` — V8.1 Proactive Context Engine full spec (2026-04-30)
- `docs/planning/v8-capability-2-spec.md` — V8.2 Strategic Initiative Layer full spec (2026-04-30)
- `docs/planning/v8-capability-3-spec.md` — V8.3 Autonomous Execution Gates full spec (2026-04-30)
- `docs/planning/v8-bibliography-synthesis.md` — meta-index across 28 reference memories (waves 1-7, 100% bibliography coverage; ports/rejects/pattern catalog)
- `project_v8_bibliography.md` — master tracker (CLOSED 2026-04-30 at 48/48)
- `projects/agent-controller/evolucion-v7-beta.md` — Jarvis-authored arc (v7 → Beta), Spanish, 2026-04-15
- `projects/agent-controller/v8-pre-plan.md` — Jarvis-authored v8 pre-plan, Spanish, 2026-04-15
- `projects/agent-controller/metricas-alfa-a-beta.md` — Jarvis-authored success metrics
- `docs/V7-ROADMAP.md` — current v7 phase tracking
- `docs/V7-READINESS-CRITERIA.md` — graduation criteria from v7
- `docs/COMPETITIVE-ANALYSIS.md` — Jarvis vs OpenClaw/Hermes/Devin
- `docs/planning/stabilization/30d-hardening-plan.md` — current freeze window
- `docs/planning/stabilization/next-session-brief.md` — operative carry-forward
- Memory files: `feedback_jarvis_thinking_capability`, `feedback_metrics_extrapolation`, `feedback_kb_injection_extraction`, `feedback_unbounded_alternation_fp`, `feedback_prometheus_upstream`
- `reference_conway_2005_sms.md` — Conway's Self-Memory System framework (5 portable patterns; Pattern 2 is V8.2 prerequisite per Conway's empirical claim; Pattern 1 is V8.1 structural foundation)
