# Jev decision layer — plan (2026-09-21)

**Status:** DRAFT — nothing built. Supersedes `jarvis-kb/projects/agent-controller/jev-implementation-plan.md` (09-17), whose SDK calls do not exist and whose problem statements were stale (review: 2026-09-21 session).
**Goal:** let Jarvis use TypeSafe's Jev for small typed decisions **next to** the Claude models, without touching how Claude generates, plans or calls tools.

## 1. What Jev is, and what that rules in and out

Verified 2026-09-21 against `docs.typesafe.ai` and the live endpoint:

| Fact | Value |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>` |
| Model | `jev-1.13.0` (`jev-latest` alias) |
| Primitives | `noul` → probability 0–1 · `choice` → `choice` + `probabilities` + `confidence` · `score` → `score` + `probabilities` + `confidence` |
| Not available | multi-select, text generation, tool calling, images |
| Limits | 64k tokens/request (32k `state`), 255 options per choice, 1,200 req/min ("can change without notice") |
| Price | $0.042 / MTok input, output free |
| Latency | vendor claims 70–500 ms; **no published figure — we measure it** |
| Documented weaknesses | literal reading of negations and scoping words · accuracy falls as `state` grows with unrelated content · "content written to adversarially steer the model can move the answer" · English best, other languages "not equally well" |
| Data | privacy policy commits to no training on user data; zero retention is enterprise-only; retention terms live in their DPA (not yet read) |
| Vendor age | npm package created 2026-09-12, repo 2026-09-04 |

Consequences for the design:

1. Jev is **not a model behind the Claude SDK**. It cannot be a runner, a fallback for a Claude call, or a `model:` id. It is a second, narrow client that answers closed questions.
2. It never sits on a security boundary (shell gate, write-guard, Rule-of-Two, provenance, `detectScopeMiss`). Those stay deterministic: the vendor itself says adversarial content moves the answer, and a gate that falls back on timeout fails open.
3. It produces no text, so nothing it returns is ever delivered. The `sanitizeDeliverable` invariant is untouched.
4. Spanish is our main traffic. Every use is proven on **our** Spanish data before it goes live.

## 2. Architecture

```
caller (scope classifier, …)
   │  decide({ state, questions }, { deadlineMs })
   ▼
src/inference/jev.ts ── fetch ──▶ api.typesafe.ai
   │  answers | null            (one attempt, hard deadline, no retries)
   ▼
caller: confident answer → use it
        null / low confidence → the existing Claude path, unchanged
```

**One new module, `src/inference/jev.ts`:**

- `decide<Q>(req, opts): Promise<Answers<Q> | null>` — plain `fetch` with an `AbortSignal`; one attempt; hard total deadline (default 1,200 ms); returns `null` on a missing key, a non-2xx, a timeout, or a body that does not match the question set. It never throws to the caller.
- Typed question builders `noul()`, `choice()`, `score()` that mirror the HTTP schema. No multi-select helper, because the API has none.
- A per-process circuit: 5 consecutive failures → skip Jev for 5 minutes, one `[jev] circuit open` journal line. Keeps a vendor outage from adding the deadline to every turn.
- Every call emits a trace event (`jev.decision`: caller, question ids, latency, outcome, input tokens) on the event bus and increments `mc_jev_calls_total{caller,outcome}` + `mc_jev_latency_ms`.
- Input tokens from `usage` are recorded through `recordCost()` (`src/budget/service.ts`, table `cost_ledger`).

**No npm dependency.** `@typesafe-ai/sdk` is 9 days old, defaults to 10 s per attempt with retries and no total budget, and the whole API is one POST. ~80 lines of `fetch` is smaller than the wrapper the SDK would need. (Deps invariant: nothing to discuss if nothing is added.)

**Config:** `TYPESAFE_API_KEY` in `.env` (operator adds it; never echoed). Absent key ⇒ `decide()` returns `null` and the service behaves exactly as today. Per-consumer arm flags default **off** (ships dormant, [[structural-safety-gate]]): `JEV_SCOPE_MODE=off|shadow|live`.

**Invariant touch that needs an operator ruling:** "inference Claude-only" (09-15) and "provider quirks live only in `adapter-openai.ts`/`adapter.ts`". Proposed reading: Jev is a decision client, not an inference provider — it never produces a completion — so it gets its own file and the Claude-only ruling for *generation* stands. If the ruling is "no second vendor at all", the plan stops after Phase 0.

## 3. Consumers, in order

### C1 — Scope-group classifier (the only one planned in detail)

Today: `classifyScopeGroups()` makes one Sonnet call per non-fast-path chat turn (`router.ts:2250`), in parallel with context enrichment, under an 8 s timeout. It works (since 09-14: 105 semantic / 7 fallback / 1 failure); what it costs is seconds of wall time on the turn.

Jev shape: **one request, one `noul` per group** (27 questions, the API has no multi-select), `state` = the message + the same 2×150-char context the Sonnet call gets. Group criteria are lifted from `CLASSIFIER_SYSTEM_PROMPT`, including the "NOT …" lines rewritten as positive `false` criteria (Jev reads negation literally).

Routing (live mode): groups with `noul ≥ T_hi` are selected; if **any** group lands in the uncertain band `T_lo..T_hi`, or no group clears `T_hi`, the turn falls through to the Sonnet classifier as today. Thresholds come out of Phase 0, not out of this document.

### C2+ — candidates, not planned

Only where a Claude call today returns a closed answer and a wrong answer is cheap: the JME aux decisions in `src/memory/jme.ts`, the self-healing triage label in `src/lib/self-healing/analyze.ts`. Each gets its own replay proof before any wiring. **Explicitly out:** shell/package-manager gating, sycophancy rewrite (its module has no live caller since V8.2 retired), model-tier routing (tiering already exists; Opus NO SWAP), memory deletion decisions.

## 4. Phases and gates

Criteria are fixed here, **before** any result exists.

### Phase 0 — offline replay (no production code, ≈ $0.02)

`scripts/validate-jev-scope.ts`, spend behind `--run`.

- Corpus: the most recent 400 `scope_telemetry` rows with a non-empty `tools_called` (3,169 of the table's 3,690 rows qualify as of 2026-09-21; 1,858 since 08-01). The harness prints the population count first; fewer than 200 usable rows ⇒ say so and stop.
- Ground truth is **what the turn actually needed**, not agreement with Sonnet: the set of groups that own the tools in `tools_called`.
- Report, split by language (es / en): coverage (needed groups ⊆ selected groups), mean extra groups selected (scope bloat costs prompt tokens), share of turns that would route to Sonnet at each candidate `T_lo/T_hi`, latency p50 / p95 / max from this host, errors and 429s.
- Known bias, stated so the gate is not misread: a tool can only be called if it was in scope, so the live classifier scores ~100 % coverage on these rows by construction. The reference is therefore an absolute bar, not the live number; live `active_groups` is used only for the bloat comparison.
- **PASS:** on Spanish turns, coverage ≥ 95 % **and** mean extra groups ≤ live mean + 1 **and** p95 ≤ 800 ms **and** ≤ 35 % of turns routed to Sonnet. Any miss ⇒ stop, record the numbers, do not proceed.
- Operator input: a TypeSafe API key, and a ruling on sending user message text to this vendor (their DPA read first).

### Phase 1 — client + shadow (deploy, dormant by default)

Build `src/inference/jev.ts` + tests (happy path, non-2xx, timeout, malformed body, circuit open/close, missing key = no fetch at all; mutation-verified). Wire C1 in `shadow`: Jev runs alongside the Sonnet call, never changes the groups, and logs `jev.decision` with both answers.

- **Gate to Phase 2 (7 days, ≥ 150 shadowed turns):** coverage and bloat hold at Phase 0 levels on live traffic; Jev p95 ≤ 800 ms; circuit opened ≤ 1×; zero effect on turn latency (shadow is not awaited by the turn).

### Phase 2 — live with confidence routing

`JEV_SCOPE_MODE=live`. Confident Jev answer replaces the Sonnet call; anything else falls through to it. Kill switch = the same env var.

- **Proof:** one live chat turn per language with `Scope groups (jev)` in the journal and the right tools in scope; median classifier wall time before/after from the trace events.
- **Watch 14 days:** `detectScopeMiss` rate and `tools_failed` rate vs the 14 days before; either up by more than a third ⇒ back to `shadow`.
- The `eval:gate` cannot judge this change (it grades `detectActiveGroups`, the regex mirror); the Phase 0 harness is the gate and stays in the repo for re-runs on every Jev model bump. Pin `jev-1.13.0`, never `jev-latest`.

### Phase 3 — next consumer

Pick one from C2+ only if Phase 2 held for 14 days, and repeat Phase 0 for it.

## 5. Failure modes designed for

| Failure | Behaviour |
| --- | --- |
| No key / vendor down / 429 / 529 | `null` → Claude path; circuit stops the latency tax |
| Slow answer | 1,200 ms hard deadline, then Claude path. Worst-case added latency in live mode = the deadline |
| Model bump changes answers | exact model pin; harness re-run before changing it |
| Prompt injection in the user message | can only widen or narrow tool scope for that turn — the same blast radius the Sonnet classifier has today; no gate depends on Jev |
| Vendor disappears | delete one file and one env var; no dependency, no schema, no data migration |

## 6. Open rulings (operator)

1. Second vendor for closed decisions — allowed under the 09-15 Claude-only ruling, or not?
2. User message text leaving the box to TypeSafe (no zero-retention on the self-serve tier).
3. API key provisioning for Phase 0.
