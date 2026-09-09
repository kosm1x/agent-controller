# Archived audits — 2026-06-16 → 2026-07-01 + the V8.2 phase cluster

Moved out of MEMORY.md 2026-08-24 to keep the index under cap. Grep this file by audit name.

## Project Knowledge (06-16 → 07-01)

- [v83-phase5-trigger-seam-audit](v83-phase5-trigger-seam-audit.md) — trigger.ts ledger into router confirm (07-01): PASS W/WARN. Seam is observability-only; non-interactive delete bypasses the confirm gate.
- [v82-phase2-gather-ledger-kb-audit](v82-phase2-gather-ledger-kb-audit.md) — widen-gather-ledger KB (07-01): PASS W/WARN. computeConfidence counts DISTINCT sources over the WHOLE ledger, not the cited subset → flips red→GREEN.
- [evolution-deterministic-persist-audit](evolution-deterministic-persist-audit.md) — deterministic-persist + Opus pin (06-28): R1 FAIL→R2 PASS. heavy/Prometheus `output.content` is the reflector meta-summary, NOT the agent answer.
- [v83-phase4-adr-render-audit](v83-phase4-adr-render-audit.md) — ADR lazy-render (06-27): PASS. Hand-rolled YAML frontmatter is safe only because every fm value is enum/number/controlled-id.
- [v82-critic-entity-identity-audit](v82-critic-entity-identity-audit.md) — §11 sibling-name false contradiction (06-27): PASS W/WARN. Entity conflation in an LLM verifier is fixed at the PROMPT layer. +"0-ROW ≠ ABSENCE".
- [v83-phase3-reversibility-audit](v83-phase3-reversibility-audit.md) — reversal.ts (06-26): RE-AUDIT→FAIL. TWIN-PATH: same op via 2 call sites → diff them; the auto path drops the guard the ledger path keeps.
- [v83-phase2-pipeline-audit](v83-phase2-pipeline-audit.md) — pipeline skeleton (06-26): PASS W/NITS. execute→{ok:false} emits no terminal event → dangling 'pending' row.
- [code-read-explain-guard-audit](code-read-explain-guard-audit.md) — `isCodeReadOrExplainTask` (06-26): FAIL. An author-exclusion built from a hand-maintained verb regex inherits every list gap; guard the REAL trigger.
- [v82-section17-brief-grain-audit](v82-section17-brief-grain-audit.md) — §17 judgment→BRIEF grain (06-26): PASS. A grain-change is only as correct as the keyed field surviving the WRITE path verbatim.
- [v82-delivery-layer-audit](v82-delivery-layer-audit.md) — surface judgments into brief (06-26): PASS W/WARN. The DB READ feeding a pure renderer is the throw site.
- [foreign-project-name-routing-audit](foreign-project-name-routing-audit.md) — EurekaMS-Landing misroute (06-24): PASS W/WARN. A gate that falls THROUGH to a 2nd routing path must re-apply there.
- [x-poster-error-classifier-audit](x-poster-error-classifier-audit.md) — tweet_post classifier (06-23): PASS W/WARN. Verify BOTH precedence directions; secret-leak = logged field types + serializers.
- [x-poster-backend-router-audit](x-poster-backend-router-audit.md) — native X backend router (06-23): FAIL. A deferred tool needs registration AND a scope group; grep scope.ts — absent = unreachable from chat.
- [swarm-fanout-routing-audit](swarm-fanout-routing-audit.md) — chat fan-out → swarm (06-20): PASS W/WARN. The bus emits result.output as a RAW OBJECT by-ref; the string-branch fix targets a shape chat never produces.
- [foreign-repo-nanoclaw-guard-audit](foreign-repo-nanoclaw-guard-audit.md) — targetsForeignRepo() (06-20): PASS W/WARN. A path-literal guard catches only inputs naming the path; the real trigger is the semantic class.
- [self-healing-triage-monitor-audit](self-healing-triage-monitor-audit.md) — triage monitor (06-19): PASS W/WARN. Direct queryClaudeSdk → cost never hits recordCost (3rd ledger-bypass repeat).
- [confabulated-permission-block-audit](confabulated-permission-block-audit.md) — gmail/MCP "bloqueado" (06-16): PASS W/WARN. The prompt's absolute "no permission gate" contradicts the real task-executor gate.
- [agent-controller-audit](agent-controller-audit.md) — architecture patterns, tech stack, baseline findings (03-24).

## V8.2 cluster

- [v82-section17-unfixable-split-audit](v82-section17-unfixable-split-audit.md) — exclude critic-INFRA `unverified` (07-06): PASS. Excluding a bucket from BOTH num+denom makes a gate STRICTER; audit the CLASSIFIER, not the math.
- [v82-producer-cost-abort-audit](v82-producer-cost-abort-audit.md) — producer COST/ABORT (06-19): PASS W/WARN. Spend never hits cost_ledger; no wall-clock bound; MAX_JUDGMENTS uncapped.
- [v82-phase17-gate-audit](v82-phase17-gate-audit.md) — §17 activation gate (06-19): PASS W/WARN. A dormant gate OR'd into the exit code silently demotes the old gate's contract; a per-parent metric measured per-child collapses to 1.0.
- [v82-phase6-critic-audit](v82-phase6-critic-audit.md) — §11 forced-tool verifier (06-03): PASS W/WARN. sql_check write-proof genuine; referencedTables regex misses a comma-join 2nd table.
- [v82-phase8-confidence-sycophancy-audit](v82-phase8-confidence-sycophancy-audit.md) — §12 confidence + §14 probe (06-03): PASS W/WARN. `quizá` reads direct not uncertain (trailing `\b` after á).
- [v82-phase7-concession-r2](v82-phase7-concession-r2.md) — §13 C1 fix R2 (06-03): RESOLVED. replyCarriesEvidence keeps number/date/quote/marker only.
- [v82-phase5-strategic-voice-audit](v82-phase5-strategic-voice-audit.md) — strategic-voice prompt+cache (06-03): PASS W/WARN. Dockerfile omits prompt_modules/ → fail-loud in container; identity-guard test is substring-only.
- [v82-phase3-multioption-audit](v82-phase3-multioption-audit.md) — RAPID-D (06-02): PASS W/WARN. Dispatch-by-shape mock bypasses the SDK Zod parse.
- [v82-phase2-decompose-audit](v82-phase2-decompose-audit.md) — decompose.ts (06-01): PASS W/WARN. Copied the forced-tool pattern but DROPPED the abort-during-handler guard.

