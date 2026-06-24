# V9 — To-Do (Agentic Loop Engineering)

> Task list projected from `docs/V9-ROADMAP.md` (§4 workstreams, §5 sequencing/gating).
> Ordered by the §5 dependency graph, **not** by workstream number. Authored 2026-06-24.
> W1 sub-tasks fold in `docs/planning/v9-capability-1-spec.md` §11. Each box = one checkable unit.
>
> **Gate legend**: 🟢 ready now · 🟡 cheap/after-W1 · 🔵 instrument (gates W4) · 🔴 hard-blocked · ⚙️ background.
> **Spine guards (do not drift)**: verify on the _capable_ tier only · validate the _system_ not the model · self-mod only behind eval+rollback · external grounding over self-attestation.

---

## 🟢 W1 — Plan-Execute-Verify gate · highest-leverage · spec written

The single highest-leverage upgrade; no hard dep on V8.3. Build behind `PROMETHEUS_VERIFY_GATE_ENABLED` (default off). Sub-tasks = spec §11 phases.

### Phase 0 — substrate reconciliation (do FIRST; line numbers drift)

- [ ] Confirm `Phase` enum still `{PLAN, EXECUTE, REFLECT}` at `types.ts:18-23`; add `VERIFY: "verify"`.
- [ ] Confirm goal completion still set at `executor.ts:860` and is the only path to `COMPLETED`.
- [ ] Confirm `orchestrator.ts` REFLECT block (~411-435); locate the verify insertion point (immediately before `reflect()`).
- [ ] Confirm `resolveUseOpus()` at `model-tier.ts:105-108`; verify `true` routes to `queryClaudeSdkTiered` capable path.
- [ ] Confirm `v8-2/critic.ts` forced-tool/read-only harness + 4 check tools (`sql_check`/`cost_check`/`recall_check`/`file_sha`) are exported/importable.
- [ ] Grep `result.success` / `reflection.success` — confirm `heavy-runner.ts:54-86` is the only completion-reading surface.
- [ ] Add `VerificationResult` + `VerifyVerdict` + `VerificationCheck` types to `prometheus/types.ts` (spec §6). **Gate: typecheck.**

### Phase 1 — `verifier.ts` core

- [ ] New `src/prometheus/verifier.ts` with `verify(taskDescription, graph, executionResults, taskId)` signature (spec §7).
- [ ] Gate check: flag-off → pure pass-through `{verdict: VERIFIED, enabled: false}`; `SIMPLE_PATTERNS`-class → `complexity_skip` pass-through.
- [ ] Target assembly: pull each goal's `completionCriteria` + `GoalResult` (`result`/`toolNames`/`provenanceRecords`/`criteriaMet`) + task objective.
- [ ] Adjudication: `verified` iff all blocking criteria have a passed check; `needs_revision` on specific fixable gap; `unverifiable` if a criterion can't be grounded at all.
- [ ] Capable-tier wiring: `useOpus = true` **hardcoded**, bypassing `resolveUseOpus()`; `PROMETHEUS_ECONOMY_MODEL` must NOT cheapen verify (spec §10). **Gate: unit tests — verdict matrix, flag-off pass-through, complexity skip.**

### Phase 2 — grounding tools (read-only whitelist, spec §8)

- [ ] `criteria_check` — criterion ↔ observed output, capable-tier judged, evidence-cited.
- [ ] `tool_evidence_check` — claim ↔ `provenanceRecords` (was it actually retrieved?).
- [ ] `build_check` / `test_run` — ReVeal agent-built checks; **sandboxed (nanoclaw path), never host** (`feedback_coding_sandbox_routing`).
- [ ] Reuse `sql_check` / `file_sha` from `v8-2/critic.ts`. **Gate: tool guard tests — read-only, sandbox-routed.**

### Phase 3 — orchestrator wiring (the veto, spec §9)

- [ ] Insert VERIFY block before REFLECT; fold `verifyUsage` into token/cost accumulators (mirror `reflectUsage`).
- [ ] Status gating: `verified`→keep COMPLETED; `needs_revision`→offending goals BLOCKED + one bounded replan reusing verified prefix; `unverifiable`→annotate, never silent-downgrade.
- [ ] Final gate: `success = verification.enabled ? (verdict === "verified" && reflection.success) : reflection.success`.
- [ ] `heavy-runner.ts` forwards `verification.verdict` + `unmetCriteria` so the report states verification status. **Gate: integration test — flag-off byte-for-byte today; flag-on flips a seeded false-complete.**

### Phase 4 — ship dormant + shadow-measure (spec §12)

- [ ] Ship behind `PROMETHEUS_VERIFY_GATE_ENABLED=false`; add `PROMETHEUS_VERIFY_GATE_SHADOW=true` sub-mode (record verdict, don't change `success`).
- [ ] Measure on organic traffic: false-complete catch-rate (target: positive on ≥20-task sample, **false-positive ≤10%**), added cost vs daily soft-cap, added latency (concurrent checks where independent).
- [ ] Docs + memory + commit. **Activate** (shadow→enforcing) when catch-rate positive, FP ≤10%, cost in budget. **Deploy = user-only** (`./scripts/deploy.sh`).

---

## 🟡 W5 — Loop vocabulary · trivial · doc-only · land anytime

- [ ] Adopt **Prompt → Context → Harness → Loop** layering as shared vocabulary in `/root/claude/CLAUDE.md` (umbrella) + `mission-control/CLAUDE.md`.
- [ ] State the binding-constraint thesis explicitly: **the harness/loop is the lever, not the weights** (Terminal-Bench 52.8→76.4 no model change; edit-tool format ≤10×).

---

## 🟡 W2 — Ralph-loop continuity · cheap · after W1

- [ ] Early-exit interceptor: detect a long task trying to bail early.
- [ ] Re-inject original intent into a fresh, **filesystem-backed** context window (durable loop state vs context rot).
- [ ] Land in the router resume path (`src/prometheus/resume.ts` + dispatcher); compose with the existing snapshot/resume primitive.
- [ ] ⚠️ Watch overlap with the LangGraph-checkpoint plans staged for V8.3 — don't double-build the checkpoint layer.

---

## 🔵 W3 — Internal eval harness · the instrument that GATES W4

- [ ] Define a fixed internal task corpus (the eval set) over `logs/decisions/`.
- [ ] Build the runner: score **Jarvis-the-system** (model+scaffold+harness) against an **explicit-direction baseline** — never a bare-model benchmark number (§6 anti-pattern).
- [ ] Primary metric: METR-style **time-horizon** (longest task finished 50% of the time) over rolling windows.
- [ ] Secondary: τ²-Bench-style policy-adherence (boundary-honoring) + LH-Bench-style **process quality** (Kasparov thesis, made measurable).
- [ ] Operationalize the V8-VISION §7 four questions: baseline-vs-Jarvis advancement delta; autonomy delta vs explicit-direction cost-of-errors; bilateral-learning-curve calibration; operational-friction sustainability.
- [ ] New `src/eval/*` + `mc-ctl eval` subcommand.
- [ ] ⚠️ Never quote a public benchmark score as Jarvis's autonomy number (off by 30–50 pts; it measures a system).

---

## 🔴 W4 — Verify-gated self-modification · hard-blocked

**Preconditions (ALL required before any build):**

- [ ] W3 eval harness shipped (empirical per-change validation gate).
- [ ] V8.3 shadow-Git reversibility shipped (rollback substrate).
- [ ] L≥3 human authorization wired (human-on-the-loop for irreversible).

**Then, and only then:**

- [ ] Self-PR path on top of V8.3 shadow-Git: Jarvis proposes changes to its own code/harness.
- [ ] Each change **empirically validated against the W3 benchmark before keep** (Darwin Gödel Machine condition).
- [ ] **Archive of known-good versions + hard rollback** (self-mod can destroy the ability to self-mod — the one unrecoverable move in the corpus).

---

## ⚙️ W6 — Crawl frontier · ongoing background · low-priority

- [ ] Standing background-research task folding the §2 V9/Loop corpus into `reference_*.md` memories on the existing wave cadence.
- [ ] Crawl the frontier: `Awesome-Code-as-Agent-Harness-Papers` + the self-evolving-survey citation graph.
- [ ] Produce `docs/AGENTIC-LOOP-ENGINEERING-CORPUS.md` (referenced by the bibliography, not yet written).

---

## Sequencing at a glance (§5)

```
NOW  ── W1 verify gate ......... Phase 0→4 → shadow → activate   [build this first]
 ├──── W5 loop vocabulary ...... fold into CLAUDE.md anytime
 ├──── W3 eval harness ......... build the instrument (gates W4)
 │       └── W4 self-mod ....... ONLY after W3 + V8.3 + L≥3
 ├──── W2 Ralph continuity ..... after W1; watch V8.3 checkpoint overlap
 └──── W6 crawl frontier ....... ongoing background
```

**Critical path to "V9 delivers value": W1 → (W3 ∥ W2) → W4.** W5/W6 ride alongside.
