# QA Auditor Memory Index

> One line per entry: link + date + verdict + one doctrine crumb. Full detail lives in each topic file — Read the file, don't inline paragraphs here.
> Retention: hooks ≤180 chars. Never inline a paragraph. Cap ~17KB.

## Project Knowledge

- [usability-phase0-r1-audit](usability-phase0-r1-audit.md) — deliverable filter + ritual delivery policy (08-23): FAIL, 3 Crit. Score a sanitizer against the CORPUS, not fixtures (40% of 379 real replies altered, 7 mid-token truncations via `index.html`); a `reserve` on both sides of a guard makes it vacuous; a change-only gate suppressed 0/6 real PM reports; sentinel with no producer.
- [v83-seam-origin-r1-audit](v83-seam-origin-r1-audit.md) — §14 origin label + `shadowBySource` (08-17): PASS W/WARN, 0 Crit. A label whose producer serves EVERY inbound sender is not "operator" (WA group members reach it with the full toolset); both wiring points untested ⇒ deleting one reads 100% background silently; `in` on a bucket table, 3rd recurrence.
- [v85-opensandbox-adoption-r2-audit](v85-opensandbox-adoption-r2-audit.md) — R1 folds verified (08-16): MERGE-READY W/WARN, 0 Crit. A `grep -c` readout aborts under `set -e` exactly when the count is 0 — the INCOMPLETE branch is unreachable when the guard is GONE; "keep the marker" truncation deletes the memory bound; docker-proxy hairpin lives in INPUT, outside any DOCKER-USER guard.
- [v85-opensandbox-adoption-r1-audit](v85-opensandbox-adoption-r1-audit.md) — SANDBOX_BACKEND seam + OpenSandbox runtime (08-16): FAIL, 2 Crit. Porting a timeout across runtimes changes its KIND (activity→wall-clock); a DOCKER-USER `-i eth0` rule guards only the EXTERNAL edge, not container→container; `exitCode:null` guarded by `typeof==="number"` fails OPEN.
- [v84-honest-done-r1-audit](v84-honest-done-r1-audit.md) — completion ledger `task_gates` (08-16): PASS W/WARN dormant, FAIL to arm. A 2nd exec path around a guarded tool WIDENS the envelope (gate-check bypasses every shell_exec guard); an LLM-authored regex on 256KB wedges the process; a check without `cwd` measures the HARNESS tree; a set-keyed loop bound resets on oscillation.
- [v85-rule-of-two-r2-audit](v85-rule-of-two-r2-audit.md) — R1 folds verified (08-15): PASS W/WARN, 0 Crit. Widening an ALS store from fresh→inherit-parent turns every in-context callback (queue drain, slot release) into a cross-task bleed — proven; a hand-kept fixture pin needs a LIVE detector; grep-sweep a W-fix into files the SAME ship added.
- [v85-rule-of-two-r1-audit](v85-rule-of-two-r1-audit.md) — Rule-of-Two tool matrix + ALS run composition (08-15): FAIL, 1 Crit. An "exact set" pinned over a registry the test never BUILDS is vacuous (MCP source absent from all 3 verification surfaces); a layer whose only wiring point fails OPEN must have that point tested; `[]`/`in` on a name-keyed safety table inherit 8 prototype escape hatches.
- [unicode-token-absence-probe-audit](unicode-token-absence-probe-audit.md) — `\p{L}\p{N}` sweep + recall absence probe + §17 30d window (08-14): PASS W/WARN. A guard whose FAILURE reads identical to its PASS licenses the act it guards; FTS5 barewords allow any codepoint >127.
- [v83-background-seam-audit](v83-background-seam-audit.md) — registry chokepoint + delete_inverse (08-08): PASS W/WARN. A throw-capable resolve OUTSIDE the try defeats "never blocks"; a wrapper on a chokepoint changes the FAILURE CHANNEL; a gate admitting a TEMPLATE admits a promise.
- [v82-sync-surfacing-r1-audit](v82-sync-surfacing-r1-audit.md) — brief retired → Morning Sync is the strategic surface (08-03): FAIL, 3 Crit. `sent>0` ≠ delivered (telegram `return "error"` RESOLVES); `mc-ctl` never sources `.env` → env gate fail-OPEN.
- [oom-containment-scope-wrap-audit](oom-containment-scope-wrap-audit.md) — gate children in `systemd-run --scope` (08-02): PASS W/WARN, 2 Crit diagnostic-loss. `??` on execFile `err.stdout` never fires; swapping the binary moves which STREAM carries errors; 137/143 dead code under exec.
- [v82-combinator-r3-closure](v82-combinator-r3-closure.md) — print-the-combined-verdict (08-02): PASS W/WARN. All 3 exit codes empirically forced. A headline naming ONE cause of a multi-cause state eventually names the GREEN one; `scripts/` is outside tsconfig.
- [v82-combinator-r2-audit](v82-combinator-r2-audit.md) — worst-of-two `combineVerdicts` (08-02): PASS W/WARN, 1 Crit. An exit-code-only fix on an operator CLI is INVISIBLE; grep the CALLER's prose for the old rule; a count over a population empty by construction is a vacuous ✓.
- [v82-section17-6a-removal-audit](v82-section17-6a-removal-audit.md) — §17 6a deleted, FAIL→PASS (08-02): PASS W/WARN, 1 Crit. Deleting the check that PINNED gate B un-pins the `||` combinator; count the OPERATOR-GROUNDED terms left.
- [planner-workload-sizing-audit](planner-workload-sizing-audit.md) — Prometheus PLAN/REPLAN sizing (07-27): FAIL, 1 Crit. A decision-table row is DORMANT unless a producer emits its trigger token — trace the reason-string producer.
- [graded-down-delivery-split-audit](graded-down-delivery-split-audit.md) — grading/execution split + failed-task delivery (07-27): PASS W/WARN. Promote-to-deliver must promote the CAVEAT; a new delivery site inherits its neighbour's SENDER; persisting a NULL column wakes dormant detectors.
- [v85-phase33-seam-metering-audit](v85-phase33-seam-metering-audit.md) — cost_ledger seam + dormant gate (07-13): FAIL, 2 Crit. Aggregate-fed-site inventory is bigger than the design doc lists; a UNIVERSAL writer contaminates every agent_type-agnostic READER.
- [v82-6a-verdict-affordance-audit](v82-6a-verdict-affordance-audit.md) — explicit-verdict brief affordance (07-10): FAIL, 1 Crit. An explicit-token allow-list only helps if the tokens are RARE outside the intended act (`ok|dale|listo` = chatter).
- [v81-section13-heavy-exclusion-audit](v81-section13-heavy-exclusion-audit.md) — §13 excludes `heavy` from cache-read (07-10): PASS W/WARN. Measurement-correction verified via DB; flips 78.29→80.51%, razor-thin.
- [skill-discovery-fast-route-audit](skill-discovery-fast-route-audit.md) — auto→fast misroute fix (07-06): PASS W/WARN. Routing to the right runner ≠ end-to-end persistence.
- [v83-phase7-activation-gate-audit](v83-phase7-activation-gate-audit.md) — §14 read-only readiness gate (07-06): PASS. SYMMETRIC `datetime()` wrapping is the correct fix for ISO storage; empty ledger → insufficient_data, not fail.
- [v83-phase6-consent-linkage-audit](v83-phase6-consent-linkage-audit.md) — §12/§14 consent gate (07-06): PASS. Enforcement airtight; asymmetric `datetime(?)` still fails SAFE; degrade-on-throw bypasses the gate for a wired L≥3 caller.
- [v83-phase5-injection-defense-audit](v83-phase5-injection-defense-audit.md) — §8 prompt-injection (07-06): PASS. The heuristic is a TRIPWIRE not a boundary — English-only regex slips all Spanish probes.
- [hardening-sweep-2waves-closure-audit](hardening-sweep-2waves-closure-audit.md) — 9-lane hardening bundle (07-05): PASS W/WARN. Process-lifetime liveness gauge stamped only on success can't fire on boot-wedge; notifier only catches THROWS.
- [efficiency-refactor-r1-closure-audit](efficiency-refactor-r1-closure-audit.md) — ~220 files, −4.7k LOC (07-05): PASS W/WARN. Batched delete violates self-ref parent FK when a subtree straddles a batch boundary.
- [efficiency-refactor-phase0-audit](efficiency-refactor-phase0-audit.md) — 9 perf fixes (07-05): PASS W/WARN. Counter outside a writeWithRetry callback double-counts on SQLITE_BUSY; index→UNIQUE needs a live-DB dup check.
- [support-subsystems-bloat-audit](support-subsystems-bloat-audit.md) — ~44k-LOC bloat scan (07-05). Dead-file scan MUST grep src+scripts+dynamic `import()`. 4 dead ~915 LOC.
- [hotpath-perf-audit](hotpath-perf-audit.md) — per-message hot path (07-05). buildMcpServer rebuilds ~150 Zod schemas/msg; the infer() OpenAI loop is an INERT revert path, not dead.
- [phase0-1a-concern-buildauth-audit](phase0-1a-concern-buildauth-audit.md) — `concern_reason` + `BUILD_AUTHORING_RE` (07-04): PASS W/WARN. Verb-alt HOMOGRAPH FP (`cre[oa]`→"creo que").
- [git-shell-file-prefix-broaden-audit](git-shell-file-prefix-broaden-audit.md) — allow-list → bare `/root/claude/` (07-04): FAIL. Broadening to the PARENT prefix grants the parent's non-project children. +symlink escape.
- [v83-reversibility-seams-audit](v83-reversibility-seams-audit.md) — V8.3 seams a+b (07-06): PASS. Move a structural invariant OFF a mutable DB column so drift can't grant autonomy.
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

## Older audits

- **Archived: 16 v6.x sprint audits (2026-04)** → [archived-v6-sprint-audits](archived-v6-sprint-audits.md) — grep for any v6.0/v6.2/v6.3/v6.4 sprint audit.
- [sdk-wrapper-vs-direct-call-audit](sdk-wrapper-vs-direct-call-audit.md) — claude-sdk cache_control + phantom-$0 (05-23): FAIL. Audit ALL consumer seams when fixing a shared inference module.
- [skill-evolution-cascade-audit](skill-evolution-cascade-audit.md) — ritual ~50% fail (05-24): PASS W/WARN. Retry drops agent_type/tools/ritualId → re-classifies to nanoclaw.
- [community-manager-email-round2](community-manager-email-round2.md) — email mode R2 (05-15): PASS W/WARN. (R1 [community-manager-email-audit] FAIL: allowlist exposed operator KB/Gmail to anonymous senders.)
- [northstar-sync-strict-mirror-audit](northstar-sync-strict-mirror-audit.md) — strict-mirror (05-08): FAIL. Deletes local files on stale COMMIT_IDs while INDEX claims "no deletes".
- [v76-spine6-round2-audit](v76-spine6-round2-audit.md) — Spine 6 R2 (05-08): PASS W/WARN. Structurally-sound R1 bundles surface forward-looking contract looseness in R2, NOT moved drift.
- [prompt-enhancer-leakage-audit](prompt-enhancer-leakage-audit.md) — RC1-RC5 enhancer leak (05-07): PASS W/WARN. Cold-start guard ignores risk=high; SPLIT marker collision unsanitized.
- [v73-p4a-round2-audit](v73-p4a-round2-audit.md) — v7.3 P4a R2 (04-21): FAIL. Scalar-sanitization bypass; ROAS boundary matches "roast".
- [f81b-pm-paper-audit](f81b-pm-paper-audit.md) — PM paper adapter (04-20): PASS W/WARN. Dust filter blocks full exits; no stale-abort gate.
- [f81a-pm-alpha-round2](f81a-pm-alpha-round2.md) — PM Alpha R2 (04-20): PASS W/WARN. Whale multi-outcome, UTC slice; 4/8 fixes untested.
- [f9-rituals-round2](f9-rituals-round2.md) — Morning/EOD Rituals R2 (04-20): PASS W/WARN. task.failed path bypasses budget.
- [f8-paper-trading-audit](f8-paper-trading-audit.md) — Phase β S11 (04-19): PASS W/WARN. Silent stale-quote fallback distorts totalEquity.
- [f7-round3-production-readiness](f7-round3-production-readiness.md) — F7 R3 (04-18): PASS W/WARN. Zero observability; as_of unvalidated.
- [gdocs-read-full-audit](gdocs-read-full-audit.md) — gdocs_read_full (04-16): FAIL. Missing from GOOGLE_TOOLS scope group + READ_ONLY_TOOLS guard; never loads.
- [google-workspace-audit](google-workspace-audit.md) — Google Workspace (04-10): PASS W/WARN. URL scope injection misses 3 domains.
- [hardening-commit-audit](hardening-commit-audit.md) — commit ed0d56b (04-09): PASS W/WARN. SSRF IPv6 bypass (brackets); Telegram restart/stop null race.
- [inference-prompt-efficiency-audit](inference-prompt-efficiency-audit.md) — inference+prompt (04-09): PASS W/WARN. Pricing drift; max_tokens truncation.
- [security-audit-20260409](security-audit-20260409.md) — full security audit (04-09): PASS W/WARN. Shell injection in code-search, SSRF in http_fetch.
- [ccp5-regression-audit](ccp5-regression-audit.md) — riskTier regression (04-08): FAIL. registry.execute() still blocks 10 tools; Prometheus bypasses the fix.
- [ccp1-ccp4-audit](ccp1-ccp4-audit.md) — CCP1-CCP4 (04-08): FAIL. Browser tool names wrong in UNTRUSTED_TOOLS; WRITE_VERIFICATION markers wrong for 4/11.
- [evolution-log-commit-ritual-audit](evolution-log-commit-ritual-audit.md) — weekly commit ritual (06-17): FAIL. Git tools route through checkMissionControlAccess which THROWS on `main`; git_commit index-scoped not pathspec.
- [evolution-log-append-gate-audit](evolution-log-append-gate-audit.md) — RITUAL_WRITABLE_DOCS append-only gate R2 (06-17): FAIL. An append-only gate keyed on a write-indicator regex inherits every gap in that regex.
