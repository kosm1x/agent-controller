# V9.1 Capability — Plan-Execute-Verify Gate

> Spec for the first V9 / Agentic Loop Engineering workstream (**W1**). V8 gave Jarvis judgment and consent; V9.1 gives the execution loop an **independent verification gate** before a task is reported done.
>
> Authored 2026-06-23 (Revision 1), from the _Master Reference Bibliography_ W1 entry. **This is the executable promotion of bibliography open-thread #11** ("promote the PEV verify gate to an executable spec at the level of the `v8-capability-*-spec.md` files").
>
> **Activation**: build behind `PROMETHEUS_VERIFY_GATE_ENABLED` (default off, systemd drop-in like V8.2). Ship dormant → shadow-measure false-complete catch rate on organic traffic → activate. No bilateral-maturity gate (this hardens an existing internal loop; it surfaces nothing new to the operator until it changes a _delivered_ status).
>
> **Roadmap context**: `docs/V9-ROADMAP.md` §4 (W1).

---

## §1 — Problem

Prometheus runs **Plan → Execute → Reflect**. A goal is marked `COMPLETED` the moment its executor loop returns `ok` (`src/prometheus/executor.ts:860`); the task's delivered `success` is then whatever `reflect()` _scores_ (`orchestrator.ts:485`). Two gaps:

1. **Reflect scores, it does not gate.** `reflect()` produces a 0–1 score + `success` boolean across five dimensions, but it is a post-hoc _narration of quality_, computed by the same tier that did the work, with no power to **block delivery** or trigger remediation. A confidently-wrong run scores itself confidently.
2. **The only in-loop check defaults to pass.** Per-goal `selfAssess` (`executor.ts`, `criteriaMet`) is same-model and, by design, its catch path "defaults to a `met=true` assessment to avoid spurious failure when the judge LLM itself is unavailable" (`types.ts:99-108`). So when verification is most fragile, it waves the goal through.

Net: nothing independent stands between _"the executor stopped"_ and _"the task is reported done."_ This is the failure the bibliography flags as **highest-leverage**, because a false "done" **compounds** — every downstream task, every `logs/decisions/` entry, every V8.2 judgment built on a prior "completed" inherits the error.

The corpus lesson is blunt: **same-model self-verification is unreliable** (`reference_critic_selfrefine`). Correction works only with **external grounding** — tools, tests, or a more-capable tier.

---

## §2 — Current state (baseline, post-V8.2)

| Element             | Where                                                   | Behavior today                                                |
| :------------------ | :------------------------------------------------------ | :------------------------------------------------------------ |
| Phase enum          | `prometheus/types.ts:18-23`                             | `PLAN`, `EXECUTE`, `REFLECT` — no verify                      |
| Goal completion     | `prometheus/executor.ts:859-863`                        | `ok` → `GoalStatus.COMPLETED`, else `FAILED`                  |
| Per-goal self-check | `executor.ts` (`criteriaMet`)                           | same-model `selfAssess`; defaults `met=true` on judge failure |
| Reflect             | `prometheus/reflector.ts`; called `orchestrator.ts:415` | 5-axis scorer; sets delivered `success` but **does not gate** |
| Delivered status    | `orchestrator.ts:484-485`                               | `success: reflection.success`                                 |
| Model tiering       | `prometheus/model-tier.ts:105-108`                      | `resolveUseOpus()` — regex complexity heuristic; default Opus |
| Runner surface      | `heavy-runner.ts:54-86`                                 | reads `result.success` → task done/failed                     |

**What already exists and is reusable**: the V8.2 CRITIC primitive (`src/lib/v8-2/critic.ts`) — a forced-tool, read-only, tool-grounded, tri-state (`approved`/`needs_revision`/`unfixable`) critic with a 2-loop budget and four whitelisted check tools (`sql_check`/`cost_check`/`recall_check`/`file_sha`). **W1 reuses this pattern**, retargeted from judgment-prose to execution-output, and promoted from a refinement pass to a phase gate.

---

## §3 — Precedents (composed)

| Source                                                              | What W1 takes                                                                                                                       | What it rejects                                                  |
| :------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| **PEV / "Reasoning Sandwich"** (Masood, AI Control Plane, Apr 2026) | The explicit **Verify** node between Execute and report; planning + verify routed to the _capable_ tier, intermediate work to cheap | Verifying on the cheap tier (defeats the point)                  |
| **ReVeal** (arXiv 2506.11442)                                       | Generation↔verification loop; **the agent builds its own tests/checks** for code-touching goals                                     | —                                                                |
| **Guideline-Grounded Evidence Accumulation** (arXiv 2603.02798)     | Calibrated, evidence-grounded verdict — verdict cites the evidence it accumulated, never a bare boolean                             | —                                                                |
| `reference_critic_selfrefine` (adopted, V8.2 §10)                   | Tool-grounded critic; tri-state verdict; bounded loop; **same-model self-verification fails**                                       | Same-model critic for the numeric/factual claims it can't ground |
| `reference_process_supervision` (adopted, V8.2 §10 / S2 §3)         | Step-tagged verification; complexity-gated activation; reuse-verified-prefix on revision                                            | PRM800K-style trained reward model (math-only, doesn't transfer) |

**The distinction that matters**: `critic_selfrefine` and `process_supervision` are **refinement passes** inside a generation step. W1 is a **structural phase gate** in the orchestrator loop — it runs once per task, after Execute, with the authority to change the _delivered_ status. Same grounding lesson, different control-flow role.

---

## §4 — Architecture overview

Insert `Phase.VERIFY` between `EXECUTE` and `REFLECT`:

```
PLAN ── EXECUTE ──▶ [VERIFY] ──▶ REFLECT ──▶ deliver
                       │
                       ├─ verified        → keep COMPLETED, proceed to Reflect
                       ├─ needs_revision  → bounded replan (reuse verified prefix) OR downgrade
                       └─ unverifiable    → do NOT claim done; surface honestly
```

Design invariants:

1. **Capable tier, always.** Verify calls pass `useOpus = true` unconditionally (Reasoning Sandwich). It does **not** inherit the task's economy-mode tier — a cheap verifier is the rejected anti-pattern (§3, V9-ROADMAP §6).
2. **External grounding, not self-attestation.** Verify runs read-only grounding tools (criteria check, tool-evidence check, build/test run, `sql_check`) — it does not ask the executing model "are you done?". For code-touching goals it follows ReVeal: **build the check, then run it.**
3. **A gate, not a score.** Its verdict can flip the delivered status. Reflect still runs after (scoring is orthogonal), but `success` is now `verify.verdict === "verified" && reflection.success` — verify holds a veto.
4. **Bounded.** One verify pass per task; on `needs_revision`, at most one bounded replan that reuses the verified prefix (process-supervision pattern), then deliver with the honest verdict. No unbounded verify↔fix loop.
5. **Complexity-gated.** Trivial tasks (the `model-tier.ts` `SIMPLE_PATTERNS` class) skip verify — gating it on the same complexity signal avoids taxing one-line edits. Default-complex tasks always verify.
6. **Additive + dormant until flagged.** Behind `PROMETHEUS_VERIFY_GATE_ENABLED`. When off, the orchestrator path is byte-for-byte today's (the verify call is skipped, `success` falls back to `reflection.success`). Zero live-path risk before activation.

---

## §5 — Phase 0: substrate reconciliation (do FIRST)

Mirror V8.2 R2 discipline — reconcile _designed_ vs _shipped_ before building. Verify at implementation time (line numbers drift):

- [ ] `Phase` enum still `{PLAN, EXECUTE, REFLECT}` at `types.ts:18-23` → add `VERIFY: "verify"`.
- [ ] Completion still set at `executor.ts:860` and the only path to `COMPLETED`.
- [ ] `orchestrator.ts` REFLECT block still at ~411-435; the verify insertion point is **immediately before** the `reflect()` call (after the EXECUTE/snapshot block, before line 412's `emitProgress(...REFLECT...)`).
- [ ] `resolveUseOpus()` still the tier hook at `model-tier.ts:105-108`; confirm passing `true` routes to `queryClaudeSdkTiered` capable path.
- [ ] V8.2 `critic.ts` forced-tool + read-only-check pattern still the reuse target; confirm the four check tools are exported/importable.
- [ ] `heavy-runner.ts:54-86` still the surface that reads `result.success`; confirm no other runner reads completion differently (grep `result.success`, `reflection.success`).

Any drift → update this spec's §6/§7 before writing code.

---

## §6 — Data model

New `VerificationResult` in `prometheus/types.ts` (mirrors `ReflectionResult`):

```ts
export const VerifyVerdict = {
  VERIFIED: "verified", // criteria met, grounded in evidence → keep COMPLETED
  NEEDS_REVISION: "needs_revision", // a specific, fixable gap → bounded replan or downgrade
  UNVERIFIABLE: "unverifiable", // cannot be grounded → do NOT claim done; surface honestly
} as const;
export type VerifyVerdict = (typeof VerifyVerdict)[keyof typeof VerifyVerdict];

export interface VerificationCheck {
  kind: "criteria" | "tool_evidence" | "build" | "test" | "sql";
  target: string; // which goal/criterion/file this check addresses
  passed: boolean;
  evidence: string; // the grounded justification (tool output digest, not a bare claim)
}

export interface VerificationResult {
  verdict: VerifyVerdict;
  checks: VerificationCheck[]; // every check run, with grounded evidence
  unmetCriteria: string[]; // criteria the run did not satisfy (drives replan targeting)
  summary: string;
  enabled: boolean; // false when the flag is off (gate was a no-op pass-through)
}
```

No new tables in v1 — verify outcomes ride the existing `trace` events (`traceRecord(trace, "phase_end", {phase: Phase.VERIFY, verdict, ...})`) and the orchestrator return. A `verify_events` table is an open question (§13) deferred until shadow data shows it's worth the write.

---

## §7 — The verify pass (`src/prometheus/verifier.ts`)

```ts
export async function verify(
  taskDescription: string,
  graph: GoalGraph,
  executionResults: ExecutionResult,
  taskId: string,
): Promise<{ result: VerificationResult; usage: TokenUsage }>;
```

Flow:

1. **Gate check** — if `process.env.PROMETHEUS_VERIFY_GATE_ENABLED !== "true"` → return `{verdict: VERIFIED, enabled: false, checks: [], ...}` (pure pass-through; orchestrator treats as no-op). If task is `SIMPLE_PATTERNS`-class → same pass-through with a `complexity_skip` note.
2. **Assemble the verification target** — pull each goal's `completionCriteria`, its `GoalResult` (`result`, `toolNames`, `provenanceRecords`, `criteriaMet`), and the task description's stated objective.
3. **Build checks** (ReVeal) — for each criterion, choose a grounding `kind`: code/file-touching → `build`/`test` (run it); data claims → `sql`; research claims → `tool_evidence` (was the claim actually returned by a tool, per provenance?); else → `criteria` (capable-tier judgment against the stated criterion + observed output).
4. **Run checks** via the **forced-tool, read-only** harness reused from V8.2 `critic.ts` (whitelist only; no writes; per-pass call cap = 5, matching critic). Capable tier (`useOpus = true`).
5. **Adjudicate** — `verified` iff all blocking criteria have a `passed` check; `needs_revision` if ≥1 criterion has a _specific fixable_ unmet check; `unverifiable` if a criterion cannot be grounded at all (no tool can speak to it). Verdict `summary` cites the evidence (guideline-grounded).

---

## §8 — Grounding tools (read-only whitelist)

Reuse V8.2's four check tools and add execution-specific ones; **all read-only**, all returning a digest as evidence:

| Tool                  | Grounds                                                           | Source                         |
| :-------------------- | :---------------------------------------------------------------- | :----------------------------- |
| `criteria_check`      | criterion ↔ observed output (capable-tier judged, evidence-cited) | new                            |
| `tool_evidence_check` | claim ↔ provenance record (was it actually retrieved?)            | new; reads `provenanceRecords` |
| `build_check`         | `tsc`/build passes for code-touching goals                        | new; sandboxed read-only run   |
| `test_run`            | agent-built or existing tests pass (ReVeal)                       | new; sandboxed                 |
| `sql_check`           | data/count claims ↔ DB                                            | reuse `v8-2/critic.ts`         |
| `file_sha`            | "I changed X" ↔ file actually changed                             | reuse `v8-2/critic.ts`         |

`build_check`/`test_run` execute in the existing runner sandbox (nanoclaw path) — **never** the host. Coding-task verification routes through the established sandbox per `feedback_coding_sandbox_routing`.

---

## §9 — Status gating (the veto)

In `orchestrator.ts`, immediately before the REFLECT block:

```ts
// --- VERIFY (V9.1, flag-gated) ---
emitProgress(taskId, Phase.VERIFY, 80, "Verifying execution");
traceRecord(trace, "phase_start", { phase: Phase.VERIFY });
const { result: verification, usage: verifyUsage } = await verify(
  taskDescription,
  graph,
  executionResults,
  taskId,
);
// fold verifyUsage into the token/cost accumulators (same pattern as reflectUsage)
traceRecord(trace, "phase_end", {
  phase: Phase.VERIFY,
  verdict: verification.verdict,
});
```

Verdict → action:

| Verdict                  | Goal status                 | Replan?                                                                               | Delivered `success`                                                        |
| :----------------------- | :-------------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------- |
| `verified` (or flag off) | keep `COMPLETED`            | no                                                                                    | `reflection.success` (unchanged)                                           |
| `needs_revision`         | offending goals → `BLOCKED` | one bounded replan reusing verified prefix; if budget exhausted, deliver with verdict | `false` unless replan verifies                                             |
| `unverifiable`           | keep status, **annotate**   | no                                                                                    | `false` — report surfaces "completed, not independently verified" honestly |

Final gate at the return: `success: verification.enabled ? (verification.verdict === "verified" && reflection.success) : reflection.success`. The runner surface (`heavy-runner.ts`) additionally forwards `verification.verdict` + `unmetCriteria` so the delivered report can state the verification status (never a silent downgrade — `feedback_high_stakes_data_guard`).

---

## §10 — Model tiering

Verify is the canonical Reasoning-Sandwich "capable tier" consumer. Implementation: `verify()` calls the SDK via the tiered path with `useOpus = true` **hardcoded**, bypassing `resolveUseOpus()`. Rationale stated inline so a future economy-mode sweep doesn't accidentally cheapen the gate (the rejected anti-pattern). The `PROMETHEUS_ECONOMY_MODEL` kill-switch does **not** apply to verify — verify is always capable, by design.

---

## §11 — Phasing (~4–5 days)

| Phase | Work                                                                                                                       | Gate                                                                                           |
| :---- | :------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **0** | Substrate reconciliation (§5); add `Phase.VERIFY` + `VerificationResult` types                                             | typecheck                                                                                      |
| **1** | `verifier.ts` core: gate/skip, target assembly, adjudication, capable-tier wiring; reuse `critic.ts` harness               | unit tests (verdict matrix, flag-off pass-through, complexity skip)                            |
| **2** | Grounding tools: `criteria_check`, `tool_evidence_check`, `build_check`/`test_run` (sandbox), reuse `sql_check`/`file_sha` | tool guard tests (read-only, sandbox-routed)                                                   |
| **3** | Orchestrator wiring (§9) behind the flag; status gating + replan-once; token/cost accumulation; runner surface forwarding  | integration test: flag-off = today's path byte-for-byte; flag-on flips a seeded false-complete |
| **4** | Ship dormant; shadow-measure (§12); docs + memory + commit (deploy = user)                                                 | shadow data                                                                                    |

Each phase: typecheck → scoped vitest → qa-auditor → (full suite via pre-commit hook). Deploy is **user-only** (`./scripts/deploy.sh`).

---

## §12 — Activation gate & measurement

Ship behind `PROMETHEUS_VERIFY_GATE_ENABLED=false`. Arm in **shadow** first: run `verify()` and **record** the verdict but **do not** let it change delivered `success` (a `PROMETHEUS_VERIFY_GATE_SHADOW=true` sub-mode). Measure over organic traffic:

- **False-complete catch rate** — of tasks Reflect scored `success=true`, how many did verify flag `needs_revision`/`unverifiable` with a _defensible_ grounded reason (operator-spot-checked). Target: verify catches real misses, with a **false-positive rate ≤10%** (verify must not cry wolf on good runs).
- **Cost** — verify adds one capable-tier pass per complex task. Track via `cost_ledger`; budget it against the daily soft-cap.
- **Latency** — verify is on the critical path before delivery; measure added wall-clock; it must not starve under the task deadline (`feedback_serial_under_deadline_starvation` — verify checks run concurrently where independent).

**Activate** (shadow → enforcing) when: catch-rate is positive on a ≥20-task sample, false-positive ≤10%, added cost within budget. This feeds the W3 eval harness — verify verdicts over `logs/decisions/` become a labeled signal for the time-horizon metric.

---

## §13 — Open questions

1. `verify_events` table vs trace-only — defer until shadow shows query demand.
2. Verify on **research/strategic** tasks (no build/test oracle) — how much weight can `tool_evidence_check` + capable-tier `criteria_check` carry without a green-checks oracle? (`reference_devin_background`: "no green-checks oracle for reflection" — same risk here.)
3. Overlap with V8.2 CRITIC — V8.2 judgments already run a critic; does a V8.2-produced judgment double-verify? Likely skip verify for V8.2-internal tasks (the critic is the gate there).
4. Replan-once vs deliver-with-verdict default — which is less surprising to the operator on `needs_revision`?
5. `build_check`/`test_run` sandbox cost on the nanoclaw path — is per-task test execution affordable, or only for an explicit `verify:strict` class?
6. Interaction with the existing `criteriaMet`/`selfAssess` — collapse the two (selfAssess becomes verify's per-goal layer) or keep both? Leaning: keep selfAssess in-loop (fast, cheap, per-goal), verify as the task-level capable gate.

---

## §14 — Cross-references

- `docs/V9-ROADMAP.md` §4 (W1), §5 (sequencing), §6 (anti-patterns)
- Master Reference Bibliography (gdoc) — W1 entry + §4 Verification pattern catalog
- `src/lib/v8-2/critic.ts` — the forced-tool read-only critic harness W1 reuses
- `src/prometheus/{types,executor,orchestrator,reflector,model-tier}.ts` — the seams (§2, §5)
- `reference_critic_selfrefine.md`, `reference_process_supervision.md` (memory) — the adopted references W1 extends
- `feedback_serial_under_deadline_starvation.md`, `feedback_coding_sandbox_routing.md`, `feedback_high_stakes_data_guard.md` — operating constraints on §8/§9/§12

---

## §15 — One-page summary

**What**: an explicit **Verify** phase between Execute and Reflect in Prometheus — a capable-tier, externally-grounded gate that can flip a task's delivered status before it's reported done. Closes the gap where execution marks `COMPLETED` (executor.ts:860) and Reflect only _scores_ it, with the sole in-loop check defaulting to pass.

**Why now**: highest-leverage V9 workstream — a false "done" compounds through every downstream task. No hard dependency on V8.3.

**How**: `Phase.VERIFY` + `verifier.ts`; reuse V8.2's forced-tool read-only critic harness; verdict tri-state (`verified`/`needs_revision`/`unverifiable`) with veto power over delivered `success`; capable tier always; ReVeal-style agent-built checks; complexity-gated; additive + dormant behind `PROMETHEUS_VERIFY_GATE_ENABLED`.

**Spine ties**: _same-model self-verification fails_ → external grounding on the capable tier (not the cheap tier — a named anti-pattern). _Validate, don't narrate_ → a gate, not a score.

**Do next**: Phase 0 reconciliation → `verifier.ts` core → grounding tools → flag-gated orchestrator wiring → shadow-measure → activate. Deploy is user-only.
