# V8 Substrate S2 — Implementation Delta vs. Spec

> **Status**: Spine 1 close artifact (per V7.7-GUIDE operating rule 8: "for each spine, the deliverable diff against the existing spec is itself an artifact").
> **Authored**: 2026-05-19 · **Spec**: `docs/planning/v8-substrate-s2-spec.md`
> **Phases shipped**: P1 (`ebf68c0`), P2a (`973254c`), P2b (`8c371fe`), P2c (`1ddefd6`).

This document is read alongside the spec. The spec is the _intent_; this is the _delivered_. Where they diverge, this document explains _why_ — so the next reader (V8.2 author, V9 vision author) can pick up the actual primitives without reverse-engineering them from code.

---

## §1 — High-level shape

| Aspect          | Spec said                                                | Shipped as                                                                                                            |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Effort          | Phase 1 ~3 days, Phase 2 ~2 days (5 days total)          | Phase 1 ~3 hours, Phase 2 ~10 hours across 2a+2b+2c (single-day push)                                                 |
| Primitives      | Typed-evidence contract + critic-as-write-gate           | **Same two primitives, three application shapes**                                                                     |
| Mechanism       | Tool-boundary Zod validation + dedicated critic LLM call | Tool-boundary for typed reports, **router-level for free-text replies**, **heuristic markdown lint for closure docs** |
| Activation gate | Zero "Audited?" cycles in a sprint of v7.7 reports       | Not yet measured — telemetry pending                                                                                  |

The spec assumed a single application shape (typed report tools). The deliverable found that the spec's primitives generalize to three surface families — typed-report producers, free-text reply senders, and human-authored markdown documents — each warranting a different deployment shape but reusing the same audit semantics.

---

## §2 — Primitive A: typed-evidence schema (DATAGEN pattern)

Shipped largely as specced. Differences:

### Surface enum — expanded

Spec §6 baseline: `morning_brief | proposal | signal_intel | project_status | ad_hoc` (5 surfaces).

Shipped: same 5 + `closure_doc` + `community_email` (7 surfaces). Spec §6 amended in Phase 1 commit. Justification: V7.7-GUIDE Spine 1 Phase 2 retrofit targets included community email + closure docs; the enum had to admit them or every audit would route to `ad_hoc`.

### Citation contract (8 variants) — shipped as specced

`src/audit/report-schema.ts` discriminated union matches spec §3 byte-for-byte. ONE delta:

- **`file.sha256` made optional in Phase 2a** (`report-schema.ts:75-83`). Spec required SHA256 for forensic reconstruction. Producer `jarvis_file_read` does not return content hashes; the morning_brief LLM had no way to compute one without a new tool. Made optional + comment + queue trigger for Phase 2b+ to add SHA256 emission to `jarvis_file_read`.
- Trade-off accepted: path alone proves what was read; sha256 strengthens forensic reconstruction when available. The R1 audit caught this immediately as W2 and the fold landed in-bundle.

### Reports table — shipped as specced minus FK

Schema mirrors spec §6. **DELIBERATELY OMITTED** the `FOREIGN KEY (task_id) REFERENCES tasks(id)` clause: mc.db's task table is `task_history`, not `tasks`, and the codebase convention is to skip cross-table FK enforcement. `task_id` is preserved as a free-text column for join-by-app-code. Comment in `submit-report.ts:269-273` documents the deviation.

### Validation invariants — added beyond spec

`validateReportInvariants()` enforces three cross-field invariants Zod can't express ergonomically:

1. `window.end >= window.start`
2. Every `verified_against[i].queried_at >= report.started_at` (freshness — encodes spec §3 "no reusing yesterday's query")
3. Every `claims[i].evidence_index` points within `verified_against` bounds

These aren't in the spec but follow from spec §3 ("citation must have been written during the current report-generation pass"). The validator returns issue strings; `submitReport()` returns structured errors for the producer to fix.

---

## §3 — Primitive B: critic-as-write-gate (Voyager pattern)

Spec §4 prescribed a producer-side `reviseFn` callback model: producer LLM → draft → critic → on fail, producer LLM revises → re-critic, up to 3 retries.

**Shipped differently.** Three application shapes, two of which deviate from the spec's mechanism:

### Shape 1: typed-report producer (morning_brief) — Phase 2a

Spec model preserved at the LIBRARY level: `submitReport(draft, {reviseFn})` supports the reviseFn pattern. But the TOOL exposed to LLM producers (`submit_report` builtin) is **single-pass**:

| Decision                                                                  | Why                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM controls retries (not a programmatic callback)                        | LLM-as-producer is the natural retry agent; the dispatcher loop already handles N-call task budgets. A callback model assumed a non-LLM caller.                                                                                         |
| Per-task cap at the tool boundary (3 audit revisions, passes don't count) | Belt-and-suspenders. The runner's `MAX_ROUNDS_DEFAULT` is a coarser bound; the per-task cap targets the specific failure mode of an LLM that keeps re-critic-ing without revising.                                                      |
| `gmail_send` runs regardless of audit verdict                             | Audit is observability for this surface. Dropping a morning brief because the critic disagreed is a worse failure mode than shipping one with `audit_failed` flagged. Phase 2b's surface is the opposite — critic IS a true write-gate. |

### Shape 2: free-text reply gate (community-manager email) — Phase 2b

Spec §5 listed `community_email` as a S2 surface but assumed the typed-report contract. **It doesn't fit.** Community-manager replies are conversational free text; the LLM has only 5 read-only tools (no `submit_report` exposed); the reply text BECOMES the email body via the messaging adapter, not via a tool call.

**Shipped as a router-level post-LLM gate** (`src/messaging/community-reply-gate.ts`):

- Specialized free-text critic prompt (Spanish, targets org-specific factual claims)
- `sendLLMReplyToChannel` extracted from `sendToChannel`; gate fires for email channels NOT in owner-only mode (positive default-deny)
- On fail or critic infra error → reply REPLACED with `COMMUNITY_REPLY_FALLBACK` (generic Spanish acknowledgement)
- New Prometheus counter `mc_community_gate_verdict_total{verdict=pass|fail|error}` for false-positive rate monitoring
- `gateInflight: Set<Promise>` + `stopAll()` await — shutdown drains in-flight gates before stopping adapters (R1-C1 architectural fix)

This is **primitive B without primitive A** — the critic stands alone over free text, no schema enforcement. The free-text critic prompt is purpose-built (`COMMUNITY_REPLY_CRITIC_PROMPT`) — biases toward PASS on ambiguity, lists explicit FAIL and PASS exemplars.

### Shape 3: heuristic markdown lint (closure docs) — Phase 2c

Spec §7 Phase 4 mentioned "backfill (optional) for other report-emitting tools" — closure docs were not anticipated. **Shipped as a third primitive shape**: convention + lint, no LLM critic at all.

The audit isn't an LLM call here — it's a markdown linter (`src/audit/closure-doc-validator.ts`) that:

- Identifies scoreboard sections by heading pattern
- Extracts claim candidates (numbers + context, commit SHAs, shipped/added verbs)
- Matches adjacent `verified_against:` citations (forward scan, stops at next claim)
- Exits 0/1/2 per the same convention as `mc-ctl audit-claim` cli

Why no LLM critic for closure docs: the producer is Jarvis-the-Claude-Code-author, NOT the runtime agent. The verification target is the doc's structural completeness, not its claim accuracy (the author is presumed to have re-derived numbers; the lint checks they cited where they re-derived from). Spine 7's `mc audit-closure` continuity tool will WRAP this lint into broader closure pre-checks.

---

## §4 — Spec §9 open questions — which bit?

The spec listed 6 open questions, none blocking. Implementation experience:

| Q                                              | Spec default                                                 | Outcome                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1 Critic model — same as producer or smaller? | Same-model (cache-friendly)                                  | **Defaulted, didn't bit.** Same model via heavy-runner SDK path. Telemetry (`mc_community_gate_verdict_total` cost metric) will inform if a cheaper Haiku-tier critic is warranted. Revisit at 30-day mark.                                            |
| Q2 Retry policy on critic infra failure        | Return draft with `concerns: [{type: audit_failed, detail}]` | **Didn't bit.** Shipped as specced for both Phase 2a (`fail_returned_anyway` semantic) and Phase 2b (fall back to `COMMUNITY_REPLY_FALLBACK`).                                                                                                         |
| Q3 Allowlist governance                        | Scope-level config                                           | **Didn't bit; sidestepped.** `CRITIC_SKIP_FOR` is a hardcoded empty `ReadonlySet` in `submit-report.ts`. Phase 2b explicitly did NOT add an entry — the critic stays mandatory for community email. S2-I2 deferred to "first allowlist entry" trigger. |
| Q4 Cross-report citation reuse                 | NO — every citation primary-source                           | **Bit subtly, enforced mechanically.** The freshness invariant `queried_at >= report.started_at` encodes this without any explicit reuse-check code. Schema does the work.                                                                             |
| Q5 Critic-as-tool vs critic-as-runner          | Dedicated function                                           | **Didn't bit.** Stayed as a dedicated function (`runCritic` in `src/audit/critic.ts`, `gateCommunityReply` in `src/messaging/community-reply-gate.ts`). No 6th runner.                                                                                 |
| Q6 Operator override on `fail_returned_anyway` | NO — operator just sees the flag                             | **Didn't bit.** No operator-side acknowledge mechanism shipped. Defer to V8.3 design as the spec suggested.                                                                                                                                            |

**None of the 6 changed shipping decisions.** Spec defaults held.

---

## §5 — Decisions NOT anticipated by spec

Several judgment calls came up during implementation that the spec hadn't pre-decided:

| Decision                                                  | Surface                | Rationale                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surface enum expanded (`closure_doc`, `community_email`)  | Phase 1 fold           | V7.7-GUIDE Phase 2 retrofit targets required them. Without expansion, all post-spec retrofits would route to `ad_hoc`.                                                   |
| `file.sha256` made optional                               | Phase 2a fold (R1-W2)  | `jarvis_file_read` doesn't emit content hashes; forcing the LLM to fabricate or omit would defeat the contract. Path alone proves what was read.                         |
| Per-task call cap (PER_TASK_CALL_CAP=3) at tool boundary  | Phase 2a tool wrapper  | Independent of reviseFn budget; targets the specific LLM-loop failure mode where the LLM keeps re-critic-ing the same draft without revising.                            |
| Single-pass tool vs reviseFn callback                     | Phase 2a tool exposure | LLM-as-producer fits single-pass + dispatcher-loop retry better than a callback model. The library still supports reviseFn for non-LLM callers.                          |
| Router-level critic gate for community email              | Phase 2b architecture  | The LLM doesn't have `gmail_send`; the reply text IS the send. Producer-tool model doesn't apply.                                                                        |
| `gateInflight` Set + `stopAll()` drain                    | Phase 2b R1-C1 fold    | Original IIFE design had async-detach shutdown race. Architectural refactor extracted `sendLLMReplyToChannel` + tracked pending IIFEs.                                   |
| `mc_community_gate_verdict_total` Prom counter            | Phase 2b R1-W1 fold    | Observability for false-positive rate over 7-14d post-deploy. Drives Q1 critic-model decision.                                                                           |
| Heuristic markdown lint as third primitive shape          | Phase 2c architecture  | Closure docs are author-written markdown, not LLM-produced typed reports. Lint convention fits where critic-LLM doesn't.                                                 |
| Convention applied to V7.7+ only, NOT retroactive to V7.6 | Phase 2c policy        | Historical record stays intact. V7.6 back-test ran the validator as proof case (10 unverified claims surfaced, 3 mapping to known R1 bugs) without rewriting V7.6 prose. |

---

## §6 — Substrate already partly shipped (carried in from pre-v7.7)

Per V7.7-GUIDE "Substrate already shipped" table:

- `mc-ctl audit-claim` primitive (commit `095647b`) — the FOUNDATION of S2's diagnostic surface. Phase 1's harness made it composable with reports; Phase 2a-c built the production surfaces.

S2 substrate state at v7.7-close (projected):

- `mc-ctl audit-claim` — query-time audit primitive (live since pre-v7.7)
- `src/audit/report-schema.ts` — typed evidence contract (P1)
- `src/audit/critic.ts` — typed-report critic LLM wrapper (P1)
- `src/audit/submit-report.ts` — boundary fn with reviseFn loop (P1)
- `reports` table — persistence (P1)
- `src/tools/builtin/submit-report.ts` — LLM-facing tool for typed reports (P2a)
- `src/rituals/morning.ts` — first production producer (P2a)
- `src/messaging/community-reply-gate.ts` — free-text router gate (P2b)
- `src/messaging/router.ts:sendLLMReplyToChannel` — write-gate enforcement (P2b)
- `mc_community_gate_verdict_total` Prom metric (P2b)
- `src/audit/closure-doc-validator.ts` — markdown lint library (P2c)
- `scripts/validate-closure-doc.ts` — CLI wrapper (P2c)
- `docs/audit/CLOSURE-DOC-CONVENTION.md` + `CLOSURE-TEMPLATE.md` — doc conventions (P2c)

---

## §7 — Activation gate measurement plan

Per spec §8: **"50% reduction in operator 'Audited?' messages within 30d, 80% within 60d."**

### Status

- **Pre-S2 baseline**: NOT YET PULLED. Spec calls for "journal Apr 22-30 (Day 1-9 of freeze)" sampled. Defer to first observation window.
- **Post-S2 start**: 2026-05-19 (today, Phase 2c ship).
- **Telemetry**: morning_brief audit verdicts in `reports` table (P2a onwards); community gate verdicts in `mc_community_gate_verdict_total` (P2b onwards); closure-doc validator is invocation-on-demand (no telemetry).
- **First measurement gate**: 2026-06-19 (30 days). Decision point: did "Audited?" cycles drop ≥50%?

### Operator-message detection query (planned)

```typescript
// Approximate; needs taxonomy validation against journal corpus
const AUDIT_REGEX = /\b(audited|audit\?|fact.?check|verify|verified|where.+from)\b/i;
SELECT COUNT(*) FROM journal
WHERE role = 'USER' AND created_at >= datetime('now', '-7 days')
  AND text REGEXP <AUDIT_REGEX>;
```

Spine 7's `mc audit-closure` continuity tool COULD include this metric in v7.7 closure measurement. Defer the implementation; baseline will surface from the journal regardless.

---

## §8 — Cumulative scoreboard across Spine 1

| Phase                 | Commit    | Files   | LOC              | Tests added | Audit verdict                                            |
| --------------------- | --------- | ------- | ---------------- | ----------- | -------------------------------------------------------- |
| P1 — harness          | `ebf68c0` | 12 (+)  | +1843 / -17      | +99         | 0 Crit / 8 W / 4 I — 11 folded, 1 queued                 |
| P2a — morning_brief   | `973254c` | 13      | +817 / -45       | +17         | 2 Crit / 5 W / 4 I — 10 folded, 1 queued                 |
| P2b — community email | `8c371fe` | 12      | +1041 / -25      | +29         | 1 Crit / 6 W / 4 I — 9 folded, 1 queued                  |
| P2c — closure docs    | `1ddefd6` | 9       | +1222 / -19      | +43         | 1 Crit REJECTED / 4 W / 3 I — 4 folded                   |
| **TOTAL**             | 4 commits | ~46 net | **+4923 / -106** | **+188**    | **4 C (1 rejected) / 23 W / 15 I — 34 folded, 3 queued** |

**Open queue items from Spine 1** (3 total, all P3 hygiene with explicit triggers):

- **S2-I2** (P2a): Freeze `CRITIC_SKIP_FOR` Set once populated. Trigger: first allowlist entry.
- **S2-W3** (P2b): Per-mailbox `COMMUNITY_REPLY_FALLBACK` locale. Trigger: non-Spanish community mailbox provisioned.
- (No P2c queue items — all folded in-bundle.)

S2-W6 from P1 (prepared-statement hoisting) was already folded in P2a per its trigger.

---

## §9 — Lessons that generalize

Three patterns from Spine 1's 4-phase arc that should inform v7.7 Spines 2-7:

### Pattern 1 — Spec primitives generalize to surface families, not surface instances

The spec defined one tool-boundary application (typed reports). Implementation found three surface families: typed-report producers, free-text reply senders, human-authored markdown. Same primitives (schema + critic), different deployment shapes (LLM tool, router gate, lint).

**Apply to**: Spine 2 (S3 drift detector) likely has similar generalization — alert evaluators for sync data, async cron checks for batch data, manual `mc-ctl drift-check` for ad-hoc. Don't force a single shape.

### Pattern 2 — qa-auditor empirical claims need re-verification before folding

Phase 2c R1 reported a Critical finding (CLI exits 0 on proof case) that did not reproduce. Re-running the exact repro command confirmed `EXIT=1`. Had this been folded blindly, ~30 min of refactor would have addressed a non-bug.

**Apply to**: every R1 finding involving "I ran X and observed Y" — re-run X. The auditor's hypothesis surface is valuable; its empirical claims are not authoritative.

### Pattern 3 — Convention vs. enforcement is a separate axis from spec vs. ship

Phase 2c chose convention (markdown lint, manual pre-tag invocation) over enforcement (CI gate, auto-blocking). The spec said nothing about this axis. Choosing convention bought 80% of the value at 20% of the integration cost — closures are infrequent, manual invocation is sufficient, Spine 7 will wrap.

**Apply to**: Spine 3+ (S5 skills) and Spine 4-6 (Conway patterns) where the temptation is to over-enforce. Conventions with optional validators are cheaper to evolve than CI gates.

---

## §10 — Spine 1 status: CLOSED

V7.7-GUIDE Spine 1 row marked Closed in this commit. Spine 1 contributed:

- 1 substrate (S2) fully shipped per V8-VISION §10
- 4 commits (P1 + P2a + P2b + P2c)
- 1 architectural pattern (router-level critic gate) usable beyond S2
- 3 reusable artifacts: convention + template + validator for closure docs
- 0 production regressions
- 0 user-facing capability changes

**v7.7 spine progress: 1/7 closed.** Recommended next: Spine 2 (S3 drift detector) or Spine 3 (S5 skills) — both parallel-eligible per V7.7-GUIDE.
