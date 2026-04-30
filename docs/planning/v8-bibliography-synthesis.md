# V8 Bibliography Synthesis

> Meta-index over the 28-reference memory bibliography assembled 2026-04-30 across 7 scout waves. For each reference: which V8 design decision consumed it, and how. Inverse index (V8 component → references) for spec-author lookups. Negative findings catalog so we know what we _chose not to port_.
>
> Coverage at synthesis time: **47 of 48 items scouted (~98%)**. V8.1 + V8.2 + V8.3 + S2 + S5 + Cross-cutting ALL CLOSED. Only `cline` repo remained pending at the moment this synthesis was authored — closed in same wave, see §3.

## §1 — How to use this doc

Three lookup directions:

**By reference** (§2): "What did `reference_X.md` give us?" — each file gets a ledger entry: ports adopted, ports rejected, where ports landed.

**By V8 component** (§3): "What references back V8.2 §10 CRITIC?" — inverse map from spec section to source memories.

**By design pattern** (§4): "Where do we stand on prompt-injection defense across the system?" — pattern catalog spanning multiple references.

§5 catalogs negative findings (things we deliberately did NOT port and why). §6 wave-by-wave session ledger. §7 open threads.

---

## §2 — Reference memory ledger

### V8.1 — Proactive Context Engine (7 references)

#### `reference_letta_sleeptime.md`

- **Adopted**: N-turn-piggybacked reflection (default freq=5) replaces cron-driven assumption; bounded message-diff cursor; role-reframe via system-reminder.
- **Lands**: V8.1 spec §6 (triggers), §7 (bounded diff), §10 (role-reframe).
- **Rejected**: per-turn synchronous cadence (we are async).
- **Why it mattered**: corrected V8-VISION §5's framing that reflection is wall-clock-driven.

#### `reference_langchain_ambient.md`

- **Adopted**: triage-router → interrupt-handler → action-agent triad; learned triage policy in memory; capability-flagged Agent Inbox cards.
- **Lands**: V8.1 spec §9 (capability flags + `triage_policies` table).
- **Why it mattered**: maps onto Conway Pattern 2 — operator's promote/discard signals BECOME identity-defining context (bilateral co-evolution).

#### `reference_devin_background.md`

- **Adopted**: confidence-as-control-flow (🟢/🟡/🔴 grounded in PR-merge correlation); self-scheduled checkpoint primitive; event-driven notification cadence.
- **Lands**: V8.1 spec §9 (`confidence` enum on JudgmentSchema); §10.5 (`reflection_followups` table); V8.2 spec §12 (color-promote correlation tracker).
- **Rejected**: tests-as-verification-harness (no green-checks oracle for reflection); thin "low-confidence-question" blocker vocabulary (we want richer signal.kind enum).

#### `reference_autogen_stall.md`

- **Adopted**: LLM-judged tri-boolean ledger (request_satisfied / progress_being_made / in_loop); bidirectional stall counter (max_stalls=3); forced re-plan with explicit "what went wrong" reflection.
- **Lands**: V8.1 spec §8 (stalled-task two-layer detection); `task_progress_ledgers` table.
- **Gap noted**: AutoGen issue #7487 — no cross-conversation recurring-blocker detection. V8.1's `recurring_blockers` table is genuinely novel prior art.
- **Rejected**: per-turn synchronous cadence (we are async).

#### `reference_mirix.md`

- **Adopted**: multi-vector embeddings per record (`summary_embedding` + `details_embedding`); parallel write-fanout via meta-router; source-tagged retrieval results.
- **Lands**: V8.1 spec §5 (multi-vector schema on `general_events_vec`); §9 (parallel write to multiple tables in single transaction).
- **Architectural insight**: typed tiers (cognition kind) ≠ Conway temporal tiers — they're orthogonal axes. Captured as post-V8.0 unification candidate.
- **Rejected**: missing decay/inhibition (we add Conway-style retrieval suppression); text-only "current topic" goal modulator (we use persistent goal_context_id).

#### `reference_engelbart_1962.md`

- **Adopted (framing)**: H-LAM/T = operator+Jarvis as one system; bootstrapping principle as roadmap prioritization lens (features that improve our ability to ship features ship first); concept-tools as taxonomy for V8.1 general-events + V8.2 judgment vocabulary.
- **Lands**: V8.2 spec §3 (Engelbart bootstrapping); V8-VISION §1 (system-not-parties framing); planned `docs/concept-tools.md` index.
- **New primitive surfaced**: Jarvis-coaches-operator (Port 4) — slots post-V8.0 alongside Conway Pattern 4.
- **Rejected**: behaviorist "training as conditioning" vocabulary; single-user assumption.

#### `reference_bush_1945_memex.md`

- **Adopted (framing)**: trail-following primitive as spine of V8.3's `logs/decisions/`; associative-not-alphabetical principle for V8.1 recall (no SQL LIKE, embedding-first); "personal Memex" V8 positioning anchor.
- **Lands**: V8.3 spec §logs/decisions/ ADR pattern; V8.1 spec §5 retrieval; V8-VISION §1 framing.
- **Candidate post-V8.0**: auto-trail-blazer capability ("build me a trail through my reasoning on Project X").
- **Rejected**: 1945 hardware speculation (microfilm, dry photography); no-decay assumption (Conway working-self overrides).

### V8.2 — Strategic Initiative Layer (5 references)

#### `reference_anthropic_agentic_research.md`

- **Adopted**: 4-field decomposition contract (objective / output_format / tool_guidance / boundaries); CitationAgent post-pass with deterministic resolver; 4-axis runtime gate.
- **Lands**: V8.2 spec §6 (decomposition); §8 (citation pass); §10 (CRITIC composes 4-axis).
- **Empirical anchor**: Endex deployment took source hallucination 10% → 0% via this pattern.
- **Rejected**: "more tokens = better quality" (cap angles at 3); synchronous lead-waits-for-subagents (we're async); silent on anti-sycophancy (gap filled by Constitutional+Sycophancy scout).

#### `reference_perplexity_attribution.md`

- **Adopted**: bracketed `[N]` markers as slot indices into pre-built evidence ledger (LLM never invents URLs); multi-source `[1][3]` adjacency; no-marker = unsupported (UX rule: be explicit, never fill).
- **Lands**: V8.2 spec §5 (`attributed_claims` schema); §8 (citation pass + resolver).
- **Why it mattered**: poka-yoke that mechanically prevents URL/source fabrication, transferable to our smaller local-evidence universe.

#### `reference_constitutional_sycophancy.md`

- **Adopted**: strategic-voice principle block (~250 words, stable cache prefix); `concession_kind` enum (`held_position` / `updated_with_evidence` / `conceded_without_evidence`); Sharma 2-turn easy-swayability probe.
- **Lands**: V8.2 spec §9 (principle block); §5 (concession_kind on judgments table); §11 (S2 nightly sycophancy probe).
- **Empirical anchor**: Claude 1.3 caved on 98% of correct answers under bare pushback (Sharma 2023). Target: <5% concede-without-evidence rate.
- **Rejected**: 23k-word constitution at runtime (cache-prefix concerns); RLAIF training (not runtime); filtering operator pushback (destroys the probe).

#### `reference_multioption_planning.md`

- **Negative finding**: Devin / Aider / Claude Code Plan Mode / OpenManus are all **single-plan-with-refinement**. V8.2's A/B/C has no direct precedent in coding-agent space.
- **Adopted**: Coinbase RAPID-D pattern — fixed-cast roles (Analyst / Seeker / Devil's-Advocate / Synthesizer); diversity by role assignment, NOT by asking one LLM for "3 alternatives"; cosine-similarity diversity-gate (>0.18 threshold, 2 retries → graceful degrade).
- **Lands**: V8.2 spec §7 (multi-option pass); §5 (`proposed_options` schema length-3-or-zero invariant).
- **Why it mattered**: revealed that "ask LLM for 3 alternatives" collapses to safe/predictable ("Price of Format" research). Role assignment is the load-bearing mechanism.

#### `reference_critic_selfrefine.md`

- **Adopted**: tool-grounded SQL critic (whitelisted read-only: `sql_check`, `cost_check`, `recall_check`, `file_sha`); 5-tool-calls-per-iter cap; 2-loop outer budget (Self-Refine diminishing returns); tri-state verdict (`approved` / `needs_revision` / `unfixable`).
- **Lands**: V8.2 spec §10 (CRITIC integration); S2 spec §3 (extends `src/audit/critic.ts`).
- **Headline finding**: same-model self-verification is **unreliable**; external tool grounding is what makes correction work. Validates our composition with S2 substrate.
- **Rejected**: 5-shot ~1500-token preambles (1-2 in-domain few-shots only); same-model critic for numeric claims (CRITIC explicitly disproved this); `max_interaction=7` (we cap at 5).

### V8.3 — Autonomous Execution Gates (6 references)

#### `reference_pheropath.md`

- **Adopted**: closed signal taxonomy (DANGER/TODO/SAFE/INSIGHT); target-id attached to every signal; SHA256 invariance check.
- **Lands**: V8.3 spec, `decisions` table foundation.
- **Rejected**: xattr+sidecar storage (replaced with SQLite append-only events).

#### `reference_anthropic_computer_use.md`

- **Adopted**: 3-layer defense (RL training → input classifier → steer-to-confirm runtime gate); `<external_content source=... trust="untrusted">` XML envelope + always-on system-prompt rule "data, never instructions"; capability-token schema with capability/scope/reversible/blast_radius/requires_confirm_if; explicit `reversal_op` payload for dry-run.
- **Lands**: V8.3 spec capability tokens; PheroPath `decisions` row gets `capability_token_json`; S2 `actions` table gets paired `reversal_op`.
- **Closed gap**: Anthropic explicitly omits dry-run primitive — we add it.
- **Rejected**: screenshot-OCR classifier (we're structured-content); Xvfb/Mutter sandbox (no desktop); beta-header-as-flag.

#### `reference_langgraph_checkpoints.md`

- **Adopted**: 4-tuple checkpoint key `(thread_id, checkpoint_id, parent_checkpoint_id, ns)`; super-step granularity; interrupt-encodes-question pattern; parent-pointer fork model; SqliteSaver schema.
- **Lands**: V8.3 spec `decision_checkpoints` table; 2-phase commit `gate<T>(plan)` primitive; `jarvis_decision_history` + `jarvis_decision_replay` tools.
- **Rejected**: channels/reducers/`versions_seen` (no parallel nodes to merge); `checkpoint_ns` (no subgraphs); super-step batching (per-decision is fine); `writes` WAL (decisions are atomic); sync+async dual interface (better-sqlite3 is sync).

#### `reference_sae_autonomy_levels.md`

- **Adopted**: SAE 0-5 fused with Knight Institute L1-L5 (user-role: operator/collaborator/consultant/approver/observer); per-capability autonomy level stored in `capability_autonomy` table; ODD as JSON predicate; auto-demote on out-of-ODD.
- **Lands**: V8.3 spec autonomy controller; V8.2 spec §13 cross-substrate alignment.
- **Rejected**: L3 "death zone" (real-time-handover-specific; V8.3 is async); MRC under-specification; L5-with-no-ODD.

#### `reference_adr_eventsourcing.md`

- **Adopted**: MADR-adapted ADR frontmatter for `logs/decisions/` (id, date, capability, autonomy_level, status, supersedes, superseded_by, operator_override, reversal_procedure); `decision_events` append-only table; `audit_decisions` SQL view + `jarvis_audit_decisions` tool.
- **Lands**: V8.3 spec `logs/decisions/` format; ADR lifecycle (Proposed → Accepted → Deprecated/Superseded-by-N).
- **Rejected**: full kurrent infrastructure (volume <1000/month, SQLite suffices); launch-time snapshotting (replay <100ms); event upcasters; hash IDs (lose operator readability); ADR's "architectural-only" framing (V8.3 is operational).

#### `reference_cline_repo.md` (wave 5)

- **Adopted**: **shadow-Git reversibility per workspace** with 3-mode restore (`task` / `workspace` / `taskAndWorkspace`); separation of gate-config (immutable rules) from UX-confirm-flag (operator preference) — prevents conflation in `capability_autonomy` planning.
- **Lands**: V8.3 spec reversibility primitive (NEW — fills gap LangGraph + ADR + Computer Use didn't cover for filesystem mutations); `capability_autonomy` schema gets gate-config-vs-flag split.
- **Rejected**: Plan/Act 2-mode global toggle (too coarse vs SAE per-capability L0-L4); plan-as-chat-history (regression vs V8.2's plans-as-rows).
- **Verdict**: ~60% confirmation, ~30% genuinely additive, ~10% anti-pattern. Worth the scout.

### S2 — Self-Audit substrate (4 references; 2 shared with S5)

#### `reference_datagen.md` (also S5)

- **Adopted**: tool-level poka-yoke (note-agent JSON enforcement); 3-level progressive disclosure for skill descriptions; frontmatter contract (name ≤64 / description ≤1024).
- **Lands**: S2 spec §2 (mechanical enforcement); S5 spec §7 frontmatter.

#### `reference_voyager.md` (also S5)

- **Adopted**: critic-as-write-gate (skill rejected if test fails); description-not-code embedding for retrieval; failed_tasks anti-list to avoid repeating failures.
- **Lands**: S2 spec §4 (write-gate critic); S5 spec foundation; V8.2 spec §3 (precedent).

#### `reference_process_supervision.md`

- **Adopted**: step-tagged drafts (`<step n=K>`); per-step critic verdict; complexity-gated activation (judgment chains > 3); step-truncation revision (reuses verified prefix tokens — ~60% input reduction, ~85% with cache).
- **Lands**: V8.2 spec §10 (process supervision integration); S2 spec §3 (extends critic).
- **Rejected**: PRM800K labels (math-only); training a custom PRM (out of scope); Math-Shepherd MC-rollout labeling (cost-prohibitive); Best-of-1860 reranking (volume too low).

#### `reference_many_shot_enforcement.md`

- **Negative finding**: do NOT port to v1 S2. Cost is in operator confirmation latency not just tokens; ICL behavioral conditioning may collapse output diversity; if S2 v1 plateaus, pilot N=16 only then.
- **Lands**: S2 spec open-questions section (deferred until v2 measurement plateau).
- **Why it mattered**: explicit go/no-go on the most exotic angle in the bibliography. Saved us from premature optimization.

### S5 — Skills as Stored Procedures (5 references; 2 shared with S2 above)

#### `reference_skillclaw.md`

- (Pre-existing reference, folded as adopted into S5 spec foundation.)

#### `reference_smolagents.md`

- **Adopted (1 pilot)**: typed `MemoryStep` discriminated union as model for action history schema.
- **Rejected (2)**: code-as-action vs JSON tool calls (we keep JSON for MCP compatibility); single mutable state dict (we want auditable per-step state).

#### `reference_stella_mass.md` (wave 5)

- **Adopted**: distillation-at-write-time (STELLA Template Library — pre-critic stage that turns successful traces into generalized templates); influence-weighted retrieval re-ranking (MASS Stage-2: `historical_lift` column re-orders cosine top-k); seed-from-existing-corpus (both papers reject empty-start, validates keeping our 57-skill seed).
- **Lands**: S5 spec §7 (distillation), §6 (re-ranking), §13 (phasing).
- **Rejected**: skill DAG / `unlocks` field (both papers use flat libraries — downgrades S5 §15 Q4 to "no"); MASS topology search (runner-routing territory, not skill-library); STELLA Tool Creation Agent (deferred to V8.3); RL-on-skill-set (too heavy at V8.0 scale).

### Cross-cutting — operator-Jarvis co-evolution (5 references)

#### `reference_conway_2005_sms.md`

- **Adopted**: 5 patterns mapped — Pattern 1 (3-tier hierarchy) → V8.1 spec §5; Pattern 2 (self-defining cohort) → S1 follow-on + V8.2 prerequisite; Pattern 3 (coherence/correspondence rename) → small refactor freeze-aligned; Pattern 4 (working-self / goal_context_id) → post-V8.0 recall-stack; Pattern 5 (default_visible flag) → post-V8.0.
- **Lands**: V8.1 spec §5; V8.2 spec §3 (precedents); V8-VISION §3.
- **Why it mattered**: gave V8 its memory-architectural backbone. Conway's "coherence vs correspondence" is the load-bearing distinction we'd otherwise have re-invented.

#### `reference_licklider_1960.md`

- **Adopted (framing + measurement)**: partnership-not-service anchor for V8.2 strategic voice; **85/15 hypothesis as MEASURABLE** — track strategic-thinking-fraction over 90-day windows; async-vs-realtime reconciliation (brief-action-rate test).
- **Lands**: V8.2 spec §3 (precedents), §15 (Licklider 85/15 metric).
- **Rejected**: hardware predictions (moot); literal biology (symbiosis is structural metaphor); fabricated quote "for thinking, not for living" (verified absent from canonical text).

#### `reference_wiener_cybernetics.md`

- **Adopted**: PI controller calibration math — `level_adjustment = round(8·e_t + 2·Σe_i)` clamped ±1/cycle, skip D term (operator interaction too sparse for derivative stability); homeostasis as architectural goal (V8 success = loop stability, not asymptotic L5); **Communication → Consent → Control ladder = V8.1 → V8.2 → V8.3**.
- **Lands**: V8.3 spec calibration math; V8.2 spec §3 (Wiener ladder); V8-VISION §3 lineage documentation.
- **New schema**: `capability_autonomy` adds `override_window_start_at`, `override_integral`, `last_pi_evaluation_at`.
- **Rejected**: biological-organism enthusiasm; Markov-process operator modeling; cybernetic-society Ch. 9-11 speculation; continuous-time assumption; single-loop framing (V8 has cascade-control nesting).

#### `reference_lee_see_trust.md`

- **Adopted**: 3-D trust (Performance / Process / Purpose) as instrumentation — `override_rate` (Performance/misuse), `pull_to_push_ratio` (Process/disuse), `weeks_at_current_level` (Purpose/calibration-stability); asymmetric promote/demote (slow promote ≥4 weeks, fast demote >5%); **anthropomorphism guard** (mechanical confidence levels, NOT LLM-chosen).
- **Lands**: V8.2 spec §12 (confidence compute as anthropomorphism guard); V8.3 spec autonomy controller; new `capability_trust_signals` table.
- **Why it mattered**: established the principle that authoritative LLM prose is itself a trust-calibration vector that needs mechanical counter-discipline. V8.2's mechanical confidence is the direct response.
- **Rejected**: industrial/automotive kinesthetic-failure framing; "more transparency = better calibration" oversimplification (operator parsing capacity caps Process gain — progressive-disclosure not firehose).

#### `reference_kasparov_centaur.md`

- **Adopted (empirical anchor + framing)**: 2005 PAL/CSS Freestyle final ZackS (Cramton USCF 1685 + Stephen USCF 1398 + Fritz/Shredder/Junior) beat GM Dobrov + 2600 partner 2.5–1.5 (effective Elo ~3100-3200, 200-300 above contemporary engines); centaur formula has expired in chess (closed-world), but the formula's STRUCTURE (process > capability) generalizes; expiration test for V8 ("when to auto-promote toward L5") = override-rate below noise floor + operator can articulate no domain-specific tacit knowledge Jarvis lacks.
- **Lands**: V8-VISION §1 quote-line; V8.2 spec §3 + §18 closing quote; V8.3 spec L5-promotion test.
- **Rejected**: full transferability (chess closed-world; operator's life open-world).

### Comparative repos (2 references — wave 5)

#### `reference_openmanus_repo.md` (wave 5)

- **Negative finding**: 55.9k-star MetaGPT-team "general agent". Zero novel ports. Single ReAct loop + linear PlanningFlow + 100-msg FIFO Memory; no persistence, no strategic/execution split, no substrate.
- **Lands**: nowhere directly — but cited as evidence that V8.1+V8.2+V8.3 deltas are real differentiators, not bolt-ons.
- **Why it mattered**: validates our deltas by negative-by-omission.

#### `reference_open_deep_research.md` (wave 5)

- **Low value-add**: strict subset of Anthropic Agentic Research blueprint. NO sentence-level [N] poka-yoke (Perplexity has it), NO post-pass CitationAgent (Anthropic has it), NO CRITIC verification.
- **Two minor borrowable details**: (1) `think_tool` serialized between delegations (no LLM call; structural slot for staged planning); (2) `override_reducer` pattern — state channels accept `{type:"override", value}` to wipe context at subagent handoff.
- **Lands**: candidates for V8.2 phase-7+ instrumentation; not load-bearing.

### Reading queue triage (1 reference — wave 5)

#### `reference_v8_reading_queue.md` (wave 5)

- **Top READ-LATER**: (1) Anthropic eng "Scaling Managed Agents: Decoupling the brain from the hands" (Apr 8) — `getEvents()` instead of compaction maps onto V8.1 long-context; `execute(name, input)` interface maps onto S5 stored procedures; (2) Anthropic eng April 23 Claude Code postmortem — 3 production failure modes including cache-cleared-every-turn, same-class as `cache_prefix_variability`; (3) Latent Space "Extreme Harness Engineering" — Symphony Elixir orchestration, ghost libraries.
- **Recurring discipline verdict**: NOT worth maintaining. Hit-rate skew (Anthropic eng 40%, Interconnects 8%). Recommend quarterly skim of Anthropic eng only; drop Interconnects + Simon Willison from active queue.

---

## §3 — Inverse index (V8 component → references)

### V8.1 spec (`docs/planning/v8-capability-1-spec.md`)

| Section                                        | References                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| §5 general-events middle layer                 | `reference_conway_2005_sms.md`, `reference_mirix.md` (multi-vector)            |
| §5 retrieval (associative-not-alphabetical)    | `reference_bush_1945_memex.md`                                                 |
| §6 triggers                                    | `reference_letta_sleeptime.md`, `reference_devin_background.md` (event-driven) |
| §7 bounded diff scope                          | `reference_letta_sleeptime.md`                                                 |
| §8 detection algorithms                        | `reference_autogen_stall.md` (tri-boolean ledger)                              |
| §9 briefing schema (capability flags + triage) | `reference_langchain_ambient.md`, `reference_devin_background.md` (confidence) |
| §10 judgment prompt                            | `reference_conway_2005_sms.md` (coherence/correspondence shift)                |
| §10 role-reframe                               | `reference_letta_sleeptime.md`                                                 |
| §10.5 self-scheduled checkpoints               | `reference_devin_background.md`                                                |
| §3 framing language                            | `reference_engelbart_1962.md`, `reference_bush_1945_memex.md`                  |

### V8.2 spec (`docs/planning/v8-capability-2-spec.md` — authored 2026-04-30)

| Section                        | References                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| §3 precedents (composed)       | All 11+ references contributing primitives                                                                                       |
| §5 schema additions            | `reference_constitutional_sycophancy.md` (concession_kind), `reference_perplexity_attribution.md` (attributed_claims)            |
| §6 decomposition contract      | `reference_anthropic_agentic_research.md` (4-field artifact)                                                                     |
| §7 multi-option pass (RAPID-D) | `reference_multioption_planning.md`                                                                                              |
| §8 citation pass + resolver    | `reference_perplexity_attribution.md`, `reference_anthropic_agentic_research.md` (CitationAgent)                                 |
| §9 strategic-voice prompt      | `reference_constitutional_sycophancy.md`, `reference_licklider_1960.md` (partnership), `reference_kasparov_centaur.md` (process) |
| §10 CRITIC + Self-Refine       | `reference_critic_selfrefine.md`, `reference_process_supervision.md`                                                             |
| §11 sycophancy probe           | `reference_constitutional_sycophancy.md` (Sharma 2-turn)                                                                         |
| §12 confidence compute         | `reference_lee_see_trust.md` (anthropomorphism guard), `reference_devin_background.md` (color-promote correlation)               |
| §13 cross-substrate            | `reference_wiener_cybernetics.md` (Communication-Consent-Control ladder)                                                         |
| §15 measurement (85/15)        | `reference_licklider_1960.md`                                                                                                    |
| §18 closing quote              | `reference_kasparov_centaur.md`                                                                                                  |

### V8.3 spec (TBD — composed but unwritten as of 2026-04-30)

| Component                             | References                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Capability tokens                     | `reference_anthropic_computer_use.md`                                                                    |
| Prompt-injection defense              | `reference_anthropic_computer_use.md` (`<external_content trust="untrusted">`)                           |
| Reversibility / shadow-Git            | `reference_cline_repo.md` (3-mode restore), `reference_anthropic_computer_use.md` (paired actions table) |
| Decision checkpoints (durable replay) | `reference_langgraph_checkpoints.md`                                                                     |
| Per-capability autonomy levels        | `reference_sae_autonomy_levels.md` (SAE+Knight fused)                                                    |
| ODD predicates                        | `reference_sae_autonomy_levels.md`                                                                       |
| `logs/decisions/` ADR format          | `reference_adr_eventsourcing.md` (MADR-adapted)                                                          |
| `decision_events` event-source        | `reference_adr_eventsourcing.md`                                                                         |
| Calibration math (PI controller)      | `reference_wiener_cybernetics.md`                                                                        |
| Trust calibration (3D, asymmetric)    | `reference_lee_see_trust.md`                                                                             |
| Stigmergy signals / decisions row     | `reference_pheropath.md`                                                                                 |
| Gate-config vs UX-flag split          | `reference_cline_repo.md`                                                                                |
| Self-driving expiration test          | `reference_kasparov_centaur.md`                                                                          |

### S2 spec (`docs/planning/v8-substrate-s2-spec.md`)

| Section                               | References                                                           |
| ------------------------------------- | -------------------------------------------------------------------- |
| §2 mechanical enforcement             | `reference_datagen.md`                                               |
| §3 critic agent (extends)             | `reference_critic_selfrefine.md`, `reference_process_supervision.md` |
| §4 write-gate                         | `reference_voyager.md`                                               |
| Sycophancy probe (cross-cuts V8.2)    | `reference_constitutional_sycophancy.md`                             |
| Open question (many-shot enforcement) | `reference_many_shot_enforcement.md` (deferred)                      |

### S5 spec (`docs/planning/v8-substrate-s5-spec.md`)

| Section                             | References                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------- |
| §1 foundation                       | `reference_voyager.md`                                                     |
| §6 retrieval (description-not-code) | `reference_voyager.md`                                                     |
| §6 influence-weighted re-ranking    | `reference_stella_mass.md`                                                 |
| §7 frontmatter + distillation       | `reference_datagen.md`, `reference_stella_mass.md` (distillation-at-write) |
| §13 phasing (seed from existing 57) | `reference_stella_mass.md`                                                 |
| §15 Q4 skill DAG                    | `reference_stella_mass.md` (downgrades to "no")                            |

### S1 spec (TBD)

| Component                      | References                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Stable cache prefix discipline | `feedback_cache_prefix_variability.md` (existing) + V8.2 strategic-voice principle block consumer |

### V8-VISION (`docs/V8-VISION.md`)

| Section                     | References                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| §1 framing                  | `reference_engelbart_1962.md`, `reference_bush_1945_memex.md`, `reference_licklider_1960.md`, `reference_kasparov_centaur.md` |
| §3 substrate ladder lineage | `reference_wiener_cybernetics.md` (Communication-Consent-Control)                                                             |
| §6 bilateral maturity       | `reference_lee_see_trust.md`, `reference_wiener_cybernetics.md` (homeostasis)                                                 |

---

## §4 — Design pattern catalog

Cross-reference index by pattern, spanning multiple references:

### Confidence + uncertainty

- **Mechanical computation, not LLM-chosen**: `reference_lee_see_trust.md` (anthropomorphism guard) + `reference_devin_background.md` (color-promote correlation)
- **Hedge register enforcement**: V8.2 §12 — prose register must match computed color, CRITIC checks alignment

### Citation discipline

- **Slot-index markers, never invented URLs**: `reference_perplexity_attribution.md` (`[N]` poka-yoke)
- **Post-pass resolver**: `reference_anthropic_agentic_research.md` (CitationAgent)
- **Trail-following lineage**: `reference_bush_1945_memex.md` (1945 ancestor)

### Verification

- **Tool-grounded critic**: `reference_critic_selfrefine.md` (CRITIC) — same-model self-verification fails
- **Process supervision**: `reference_process_supervision.md` (step-tagged)
- **Write-gate**: `reference_voyager.md`
- **Mechanical enforcement**: `reference_datagen.md` (note-agent JSON)

### Anti-sycophancy

- **Principle block**: `reference_constitutional_sycophancy.md` (Diplomatically honest)
- **Probe**: `reference_constitutional_sycophancy.md` (Sharma 2-turn)
- **Concession discriminator**: `concession_kind` enum

### Calibration / autonomy

- **Per-capability levels**: `reference_sae_autonomy_levels.md` (SAE+Knight fused)
- **PI controller math**: `reference_wiener_cybernetics.md`
- **3-D trust signals**: `reference_lee_see_trust.md`
- **Asymmetric promote/demote**: `reference_lee_see_trust.md` + `reference_wiener_cybernetics.md`
- **Expiration test for L5**: `reference_kasparov_centaur.md`

### Reversibility

- **Capability tokens + dry-run**: `reference_anthropic_computer_use.md`
- **Checkpoint replay/fork**: `reference_langgraph_checkpoints.md`
- **Shadow-Git**: `reference_cline_repo.md`
- **ADR supersession chain**: `reference_adr_eventsourcing.md`

### Memory architecture

- **3-tier hierarchy**: `reference_conway_2005_sms.md`
- **6-tier typed**: `reference_mirix.md` (orthogonal axis)
- **Multi-vector embeddings**: `reference_mirix.md`
- **Trail-following recall**: `reference_bush_1945_memex.md`

### Multi-option / strategic A/B/C

- **Role-assigned diversity**: `reference_multioption_planning.md` (RAPID-D)
- **Diversity-gate**: `reference_multioption_planning.md` (cosine threshold)
- **Negative finding (single-plan)**: `reference_multioption_planning.md` (Devin/Aider/etc.)

### Self-scheduling / checkpoints

- **Self-cron**: `reference_devin_background.md`
- **`reflection_followups`**: V8.1 spec §10.5

### Stall detection

- **Tri-boolean ledger**: `reference_autogen_stall.md` (LLM-judged)
- **Bidirectional counter**: `reference_autogen_stall.md`
- **Cross-conversation gap**: `reference_autogen_stall.md` (issue #7487 — V8.1 fills)

### Bilateral / co-evolution

- **System-not-parties framing**: `reference_engelbart_1962.md` (H-LAM/T)
- **Partnership not service**: `reference_licklider_1960.md`
- **Triage policy as learned memory**: `reference_langchain_ambient.md`
- **85/15 hypothesis**: `reference_licklider_1960.md`
- **Empirical anchor**: `reference_kasparov_centaur.md`
- **Homeostasis loop**: `reference_wiener_cybernetics.md`

---

## §5 — Negative findings catalog

Things we deliberately did NOT port, and why. The bibliography's value is sometimes telling us what to avoid.

| Negative finding                                                | Source                                    | Why we rejected                                                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Many-shot enforcement (inverted jailbreaking) for v1 S2         | `reference_many_shot_enforcement.md`      | Cost is operator confirmation latency, not just tokens; ICL conditioning may collapse output diversity. Pilot N=16 only if S2 v1 plateaus. |
| Devin/Aider/OpenManus single-plan paradigm for V8.2 A/B/C       | `reference_multioption_planning.md`       | Single-plan-with-refinement, not multi-option. RAPID-D role-assigned diversity is the right pattern.                                       |
| Same-model self-verification for numeric claims                 | `reference_critic_selfrefine.md`          | CRITIC explicitly disproved this. External tool grounding is required.                                                                     |
| OpenManus as a port source                                      | `reference_openmanus_repo.md`             | No persistence, no strategic/execution split, no substrate. Confirms our V8.1+V8.2+V8.3 deltas are real.                                   |
| Skill DAG / `unlocks` field                                     | `reference_stella_mass.md`                | Both STELLA + MASS use flat libraries. Skill graph topology is unwarranted complexity at V8.0.                                             |
| RL-on-skill-set training                                        | `reference_stella_mass.md`                | Too heavy; iterative refinement + MIPRO-style proposal+validate beats it at V8.0 scale.                                                    |
| Cline Plan/Act 2-mode global toggle                             | `reference_cline_repo.md`                 | Too coarse vs SAE-style per-capability L0-L4.                                                                                              |
| Cline plan-as-chat-history                                      | `reference_cline_repo.md`                 | Regression vs V8.2's plans-as-rows.                                                                                                        |
| Per-turn synchronous detection cadence                          | `reference_autogen_stall.md`              | We are async; detection runs as background watcher.                                                                                        |
| Tests-as-verification-harness for reflection                    | `reference_devin_background.md`           | No green-checks oracle. Replaced by S2 critic + operator promote-rate.                                                                     |
| Thin "low-confidence-question" blocker vocabulary               | `reference_devin_background.md`           | V8.1 needs richer signal.kind enum (`need_info` / `need_decision` / `time_constraint` / `stale_context` / `recurring_blocker`).            |
| MIRIX text-only "current topic" goal modulator                  | `reference_mirix.md`                      | Conway requires persistent goal_context_id, not per-turn LLM rewrite.                                                                      |
| MIRIX no decay/inhibition                                       | `reference_mirix.md`                      | Conway working-self requires retrieval suppression; we add `default_visible` flag.                                                         |
| Anthropic Agentic Research "more tokens = better"               | `reference_anthropic_agentic_research.md` | Cap angles at 3 per question. V8.2 is judgment at fixed budget.                                                                            |
| Anthropic Agentic Research synchronous lead-waits-for-subagents | `reference_anthropic_agentic_research.md` | We are operator-paced async.                                                                                                               |
| Constitutional AI 23k-word constitution at runtime              | `reference_constitutional_sycophancy.md`  | Cache-prefix concerns. Use ~250-word principle block.                                                                                      |
| Computer Use screenshot-OCR classifier                          | `reference_anthropic_computer_use.md`     | We're structured-content, not pixels.                                                                                                      |
| Computer Use Xvfb/Mutter desktop sandbox                        | `reference_anthropic_computer_use.md`     | No desktop in our model.                                                                                                                   |
| LangGraph channels/reducers/`versions_seen`                     | `reference_langgraph_checkpoints.md`      | No parallel nodes to merge.                                                                                                                |
| LangGraph `checkpoint_ns`                                       | `reference_langgraph_checkpoints.md`      | No subgraphs.                                                                                                                              |
| SAE L3 "death zone"                                             | `reference_sae_autonomy_levels.md`        | Real-time-handover-specific (Koopman). V8.3 is async — operator can retroactively review.                                                  |
| Full kurrent.io infrastructure                                  | `reference_adr_eventsourcing.md`          | Volume <1000/month; SQLite suffices.                                                                                                       |
| Process Supervision PRM800K labels                              | `reference_process_supervision.md`        | Math-only; don't transfer to strategic reasoning.                                                                                          |
| Lee & See industrial/automotive kinesthetic-failure framing     | `reference_lee_see_trust.md`              | We're async; override is cheap.                                                                                                            |
| 1945 microfilm/dry-photography hardware                         | `reference_bush_1945_memex.md`            | Mechanical assumptions of era.                                                                                                             |
| Engelbart behaviorist "training as conditioning"                | `reference_engelbart_1962.md`             | Modern equivalent is calibration + scaffolding + spaced reminders.                                                                         |
| Licklider hardware predictions                                  | `reference_licklider_1960.md`             | Moot.                                                                                                                                      |
| Wiener biological-organism enthusiasm                           | `reference_wiener_cybernetics.md`         | V8 is policy, not metabolism.                                                                                                              |
| Kasparov full transferability                                   | `reference_kasparov_centaur.md`           | Chess closed-world; operator's life open-world.                                                                                            |
| Recurring reading-queue discipline                              | `reference_v8_reading_queue.md`           | Hit-rate skew. Quarterly Anthropic-eng skim only.                                                                                          |

**Pattern**: ~half the rejections are framing/scope mismatches (academic benchmarks vs production async; closed-world vs open-world; pixels vs structured content). The other half are explicit "we measured / reasoned / and it's not worth the cost" decisions. Both kinds are valuable for not litigating the same trade-offs again.

---

## §6 — Wave-by-wave session ledger

| Wave   | Date       | Scouts | Angle                                                                                                                            | Coverage delta        |
| ------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Wave 1 | 2026-04-30 | 10     | V8.1 modern patterns: Letta, Voyager, smolagents, PheroPath, DATAGEN, Conway 2005, LangChain ambient, Devin, AutoGen, MIRIX      | initial → 22/45 (49%) |
| Wave 2 | 2026-04-30 | 5      | V8.2 fill: Agentic Research, Perplexity, Constitutional+Sycophancy, multi-option, CRITIC/Self-Refine                             | 22 → 28 (62%)         |
| Wave 3 | 2026-04-30 | 7      | V8.3 + S2 closeout: Computer Use, LangGraph, SAE Levels, ADR/Event Sourcing, Process Supervision, Many-Shot inversion (negative) | 28 → 34 (76%)         |
| Wave 4 | 2026-04-30 | 6      | Classical foundations + cross-cutting: Engelbart 1962, Bush 1945, Licklider 1960, Wiener, Lee & See, Kasparov                    | 34 → 39 (87%)         |
| Wave 5 | 2026-04-30 | 5      | Trailing items: STELLA/MASS, cline, OpenManus, open_deep_research, reading queue triage                                          | 39 → 47 (~98%)        |

**Total scouts**: 33 across 5 waves on a single night.

**Negative findings count**: ~28 explicit rejections logged in §5.

**Novel patterns surfaced** (no prior art covered them): V8.1 cross-conversation `recurring_blockers` (AutoGen issue #7487 confirmed gap); V8.2 mechanical confidence as anthropomorphism guard; V8.3 paired actions+reversal_op (Computer Use omits this); shadow-Git per-workspace from cline (covers gap LangGraph + ADR + Computer Use missed).

---

## §7 — Open threads

What remains explicitly unresolved post-bibliography:

1. **V8.3 spec authoring** — composed but unwritten as of synthesis. All references staged in §3.
2. **S1 spec authoring** — composed implicitly (V8.2 strategic-voice principle block requires S1 stable-prefix discipline). Existing `feedback_cache_prefix_variability.md` is the ground.
3. **Cross-judgment consistency detection** (V8.2 §16 Q6) — flagged for V8.2.1 follow-on.
4. **Synthesizer collapse mode in tiny domains** (V8.2 §16 Q7) — needs shadow-run measurement.
5. **Per-evidence-kind staleness windows** (V8.2 §16 Q3) — task statuses flip hourly while NorthStar entries are stable for months.
6. **Cline shadow-Git port specifics** — needs spec section in V8.3 (mode enum, restore semantics, integration with existing Git workflow).
7. **Strategic-voice principle versioning under bilateral maturity** (V8.2 §16 Q2) — overlay vs single-source.
8. **S1 cache-prefix specifically for V8.2 principle block** — phase work in V8.2 §14 Phase 5 ties to S1 spec when authored.
9. **Dynamic check on STELLA distillation timing** — when does a successful trace become a template? Per-skill threshold or global?
10. **Anthropic-eng quarterly skim** (per `reference_v8_reading_queue.md`) — institutionalize as recurring discipline post-V8.0.

---

## §8 — Cross-references

- `project_v8_bibliography.md` — the master tracker (authoritative scoreboard, this synthesis is derivative)
- `docs/V8-VISION.md` — V8 master vision
- `docs/planning/v8-capability-1-spec.md` — V8.1 spec (enriched wave 1)
- `docs/planning/v8-capability-2-spec.md` — V8.2 spec (authored 2026-04-30 from waves 2-3)
- `docs/planning/v8-substrate-s2-spec.md` — S2 spec
- `docs/planning/v8-substrate-s5-spec.md` — S5 spec
- All 28 `reference_*.md` files in `/root/.claude/projects/-root-claude/memory/`

---

## §9 — One-page summary

**What this is**: a meta-index over 28 reference memories assembled in 5 scout waves on 2026-04-30. ~98% bibliography coverage. V8.1 + V8.2 + V8.3 + S2 + S5 + Cross-cutting all closed.

**Why it exists**: the bibliography is dense enough that without an index, picking a V8 spec section to author requires re-reading 6-8 reference files to recall which primitives apply. This synthesis collapses that to a table lookup.

**How it's organized**: §2 by reference, §3 by V8 component, §4 by design pattern, §5 negative findings, §6 wave ledger.

**Key insights surfaced by composition**:

1. **Wiener's Communication → Consent → Control ladder = V8.1 → V8.2 → V8.3 directly**. Not analogy, exact lineage. Document this in V8-VISION §3.
2. **V8.2 is the load-bearing ETHICAL layer of V8** — not a feature, a foundation. Without explicit consent flowing through V8.2, V8.3 is unilateral causation (Wiener's _Human Use_ failure mode).
3. **Mechanical confidence is anti-sycophancy by structure** — Lee & See's anthropomorphism guard meets Constitutional AI's principle block. The compute-then-constrain-prose pattern is novel composition.
4. **Centaur formula structure generalizes; centaur formula expiration does not**. V8 ports Kasparov's "process > capability" architectural claim, NOT his "humans always help" empirical claim (which expired in chess by 2017).
5. **Bibliography negative findings are themselves load-bearing** — ~28 explicit rejections protect us from re-litigating cost/transferability trade-offs in future spec discussions.
6. **Bush 1945 is V8.1's deepest ancestor** — trail-following memory + associative-not-alphabetical recall = V8.1 retrieval principle, finally personal-scale 80 years late.

**Status**: synthesis complete; V8.2 spec authored; V8.3 spec composed but unwritten. Suggested next: V8.3 spec authoring drawing from §3 V8.3 row.
