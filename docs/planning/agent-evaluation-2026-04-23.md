# Agent-Controller Evaluation & Opportunity Backlog

> Assessed 2026-04-23 (session 101, day after 5/5 audit dimensions closed). Rates agent-controller against comparable personal-agent peers and enumerates forward-looking work as IDed items (E1–E10) for incremental execution across future sessions. Complements `docs/COMPETITIVE-ANALYSIS.md` (2026-04-10, peer feature matrix); this doc focuses on honest self-rating + next-move prioritization.

## TL;DR

**Overall: 8.5 / 10** — among the strongest self-hosted personal agents in existence. Engineering discipline (audit rigor, test coverage, runtime safeguards, token discipline) exceeds most commercial offerings. Breadth of domain coverage matches Manus/Lindy-class agents. Weak flanks are all externally-facing: UX polish, public-benchmark anchoring, shareability, and single-VPS resilience.

Ceiling is no longer set by internals. Further investment should focus on external validation, survivability, and coherence — not on adding more tools or domains.

## Peer comparison (spring 2026)

| Dimension                         | agent-controller | Claude Code | Cursor / Windsurf | Manus / Lindy | Letta / mem0 | Aider / OpenDevin |
| --------------------------------- | ---------------- | ----------- | ----------------- | ------------- | ------------ | ----------------- |
| Multi-domain coverage             | **9**            | 5           | 4                 | 8             | 3            | 4                 |
| Tool breadth (246)                | **9**            | 8           | 6                 | 8             | 3            | 4                 |
| Memory & continuity               | 8                | 6           | 5                 | 7             | **9**        | 3                 |
| Engineering rigor (tests, audits) | **9**            | 9           | 7                 | 6             | 7            | 5                 |
| Personalization                   | **10**           | 6           | 6                 | 6             | 7            | 4                 |
| Observability (Prom, cost ledger) | 7                | 6           | 5                 | 5             | 6            | 4                 |
| UX polish                         | 5                | 9           | **9**             | 8             | 6            | 6                 |
| Shareability / bus factor         | 3                | —           | —                 | —             | 7            | 7                 |

Scores are 0–10 relative, not absolute. Bold = category lead.

## Strengths

- **Rigor stack.** 5-dim audit, 2-round QA discipline, `reflector_gap_log`, GEPA, autoresearch loop, 3733 tests, pre-commit hook + 3-doc update discipline on every ship.
- **Runtime hardening.** SG1–SG5 (kill switch, immutable core, directive cooldown, pre-cycle git tags, weekly diff digest), WAL checkpoints, degradation routing with separate interactive vs dashboard windows (3-min/25% vs 10-min/3%).
- **Token discipline.** Deferred-tool system (177/246 deferred, schema-on-first-match) cuts prompt tokens ~52%. Genuine innovation that most frameworks lack.
- **Vendor agnosticism.** Raw fetch to OpenAI-compatible endpoints (no SDK) enabled the qwen → Sonnet flip with near-zero code rewrite. Fallback tool cap (>15 → skip non-primary) prevents kimi paralysis on degradation failover.
- **Multi-runner routing.** fast / nanoclaw / heavy (Prometheus PER) / swarm / a2a. Most personal agents are single-loop.
- **Domain depth.** F1 → F9 + γ scope covers market data, walk-forward backtesting (F7.5 PBO/DSR firewall), alpha combination (F7 Fama-MacBeth), paper trading (F8), rituals (F9), chart rendering, CRM. Not just chat + code.
- **Ingest-side reasoning.** Hindsight KG, pgvector hybrid retrieval (v6.2 M-series queued), Ebbinghaus 4-tier decay, overnight tuning with 73-case seed and 85% scope accuracy.

## Weaknesses

- **Bus factor = 1.** Extreme personalization (NorthStar, rituals, KB, user_facts) means nobody else can run this. Opposite of Letta's team-mode design.
- **Single-VPS SPOF.** No replicated SQLite, no standby. VPS loss = agent loss. Key path `/root/claude/mission-control/data/mc.db` is labelled "irreplaceable" in infrastructure rules — treat that as an alarm, not a feature.
- **Cost observability gap.** `cost_ledger` mislabels under claude-sdk (W7 from v7.9 Sonnet port) — still open. No per-task or per-day hard ceilings.
- **Runner reliability tails.** Nanoclaw historically ~30% fail (session 100 traced to env propagation + missing image; rebuilt but needs soak). Heavy-runner 31% fail listed as a 30d-hardening P0 — not yet closed.
- **Browser fragility.** Playwright / Chromium headless crashes on this VPS (confirmed v7.1 chart sprint and v7.12 mmdc). Any future browser-agentic work is gated by this — can't just assume Playwright will work.
- **No public eval anchor.** Zero SWE-bench / GAIA / AgentBench / TAU-bench numbers. "Is it getting better?" is currently a feel judgment, not a trendline. Blind to regressions that don't trip unit tests.
- **Thin UX surface.** Telegram + web dashboard + terminal. No voice (despite the pipesong sibling project being phase-3 RAG complete), no mobile app, no polished consumer-facing surface.
- **MEMORY.md bloat.** 324 lines, 82.9KB at time of writing, with explicit truncation warnings. The memory system is starting to push its own limits — a lagging indicator that the index needs periodic gardening.

## Opportunities (ranked by leverage × feasibility)

Each item has an ID so future sessions can say "tackle E3" without re-reading this whole doc.

### E1 — Public benchmark harness

**Leverage: high.** Turns "is it getting better?" into a weekly trendline. Also a credibility asset if the code ever goes public.
**Scope.** SWE-bench-Lite + TAU-bench retail + GAIA L1 on a weekly cron. Small harness (Dockerized runner, score aggregator, Grafana panel). Reuse `src/tuning/` infra.
**Feasibility.** Medium. 1–2 sessions to scaffold, then iterate.
**Gate.** Sonnet-primary is now stable across runners (session 100) — a precondition.

### E2 — Unified filesystem project (already queued)

**Leverage: high.** Collapses `jarvis_files` + `user_facts` + Hindsight into one store. Biggest coherence win on the roadmap; also shrinks `MEMORY.md` pressure indirectly.
**Scope.** Design agreed per memory index, build pending.
**Feasibility.** Medium–high. Schema design is the hard part; migration can be phased.

### E3 — Second-VPS standby + WAL shipping (Litestream)

**Leverage: high-per-dollar.** Cheap (~$5/mo) insurance against total SPOF. `mc.db` is labelled irreplaceable; act like it.
**Scope.** Litestream or equivalent SQLite WAL streamer → second DO/Hetzner droplet. Readonly standby, manual cutover acceptable for v1.
**Feasibility.** High. Roughly a 1-day job.

### E4 — Voice bridge via pipesong

**Leverage: high.** Turns Jarvis into something usable from the car / kitchen / walk. Pipesong phase-3 RAG is already done per memory — the integration is glue, not new engineering.
**Scope.** Pipecat → Jarvis MCP server (v7.7, already shipped) as tool surface. Deepgram in, Kokoro TTS out, <$0.03/min target already proven in pipesong.
**Feasibility.** Medium. Phase-3 readiness is the anchor; mostly wiring.

### E5 — Cost ceiling + `cost_ledger` mislabel fix (close W7)

**Leverage: medium-high.** Unblocks more autonomous runs by making cost bounded. Also closes a lingering audit deferral.
**Scope.** (a) Fix dispatcher pinning model to env var regardless of provider (v7.9 W7). (b) Per-task hard cap + per-day hard cap with auto-degrade-to-qwen on approach.
**Feasibility.** High. Bug is localized and understood.

### E6 — Tiered model routing

**Leverage: medium-high.** Sonnet for plan/synth, Haiku 4.5 for extraction/classification, qwen as fallback. Matches model strength to task cost.
**Scope.** Extend existing provider registry. Route classification by task type (scope detection, wrap-up, synthesis). Few personal agents do this well.
**Feasibility.** Medium. Logic is straightforward; calibration per route is the work.

### E7 — Stripped public "Jarvis-core"

**Leverage: medium but compounding.** Extracts runner + deferred-tool + audit framework without personal scopes. Raises bus factor from 1 and is the natural public donation of the engineering investment.
**Scope.** New repo. Scrub NorthStar / rituals / KB. Keep runner, router, deferred-tool, audit harness, SG1–SG5 pattern. MIT or Apache-2.
**Feasibility.** Medium. Careful scrubbing needed — personal data leaks here would be expensive.

### E8 — Supervised paper → live for F8.1

**Leverage: medium-high (operator-dependent).** F7.5 firewall (PBO/DSR walk-forward) + F8 paper trading are built and honestly ship-blocked the first strategy. Small live allocation with kill-switch is the payoff the Phase β stack was aimed at.
**Scope.** F8.1 Polymarket adapter (deferred from F8). Small live bankroll. Daily stop-loss + kill-switch wired to SG2.
**Feasibility.** Medium. Mostly risk-management and adapter work; the math is done.
**Gate.** Operator-lock on weekly-equity still in force per memory — confirm intent before coding.

### E9 — Cross-agent MCP fabric

**Leverage: medium.** Use Jarvis MCP server (v7.7, shipped) from Claude Code instances and other agents so they share memory / tools. Symmetric fabric. Rare among personal agents.
**Scope.** Document the MCP surface. Publish client recipes. Consider auth model for read vs write tools.
**Feasibility.** High. Server already exists.

### E10 — Eval-driven tool pruning

**Leverage: medium.** Instrument tool call precision/recall per scope. Auto-demote tools with `<1%` 7-day activation AND `<50%` success. Makes the 246-tool surface self-tidying.
**Scope.** Extend existing tool telemetry (Dim-5 audit already wrote the activation query). Add recall-side metric. Promotion/demotion as PR proposals with cooldown (reuse SG4 pattern).
**Feasibility.** Medium. Telemetry plumbing exists; the decision logic is the interesting part.

## Execution plan

### Stabilization window (now → 2026-05-22)

No new features per freeze policy. Close 30d-hardening P0s already listed: telegram flap, cost_ledger mislabel (feeds E5), heavy-runner 31% fail investigation, credential rotation + P4b/P4c/S2b provisioning, runner image-existence warn. E5 and the soak on nanoclaw/heavy are the only evaluation items that belong inside the window — both are bug-close, not features.

### Tier 1 (immediately post-freeze, 2026-05-22 onward)

E1 (benchmark harness), E2 (unified filesystem), E3 (standby VPS). In that order.

- E1 turns the agent from bespoke tool into something with external validation.
- E2 buys internal coherence.
- E3 buys survivability.

### Tier 2 (mid-term, ~2026 Q2–Q3)

E4 (voice), E6 (tiered routing), E8 (F8.1 live — operator-dependent), E10 (tool pruning).

### Tier 3 (long-term)

E7 (public Jarvis-core), E9 (cross-agent MCP fabric). These are the "turn the investment into shared infrastructure" moves, best attempted after E1–E3 exist to support them.

## One-liner

Engineering-wise this is top-decile for personal agents; the ceiling is now set by externally-facing concerns (benchmarks, UX, shareability, resilience), not internals.
