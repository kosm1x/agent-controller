# V8 Substrate S2 — Self-Audit Before Reporting

> **Status**: Spec, not implementation. Freeze-aligned (no code changes proposed for the 2026-04-22 → 2026-05-22 window).
> **Authored**: 2026-04-30 — synthesis of V8-VISION §3-S2, `feedback_metrics_extrapolation.md`, `feedback_audit_discipline.md`, and the 2026-04-30 scout findings on DATAGEN (note-agent JSON enforcement) + Voyager (critic-as-write-gate).
> **Activation**: post-freeze. Ship gate is V8.2 Strategic Initiative Layer — S2 is the prerequisite that makes V8.2 proposals trustworthy without "Audited?" cycles.
> **Reading order**: §1 problem → §2 two primitives → §3 contract → §4 critic → §5 surface → §6 schema → §7 retrofit → §8 measurement → §9 open questions.

---

## §1 — Problem

The 2026-04-26 P1-A session featured the operator asking "Audited?" four separate times. Every time, a fresh re-query found discrepancies — n=1 cache-hit headline, wrong $0.41 baseline, unverified daily-cost extrapolations. The discipline lives in `feedback_metrics_extrapolation.md` ("don't headline AVG when n=1; print the sample list") but is **not enforced by code**. It's prose advice the model is expected to follow.

V8.2's "Strategic Initiative Layer" — proposing work to the operator unsolicited — fails immediately if proposals require manual audit on every read. The proposal has to come pre-audited, with the audit visible inline and the data sources cited freshly. Otherwise the operator becomes the audit oracle, which is the bottleneck v8 is supposed to remove.

S2 codifies this discipline into a **mechanical, schema-enforced** contract. A report without verified-against fields is a draft, not a deliverable.

---

## §2 — The two enforcement primitives

This spec composes two patterns lifted from external precedents (see `reference_datagen.md` and `reference_voyager.md`):

### Primitive A — DATAGEN's note-agent: schema-enforced typed evidence

Every `report` tool's response is a typed JSON object, NOT prose. Typed fields are:

- `verified_against`: array of data-source citations (see §3)
- `sample_n`: integer (the N behind any aggregate claim)
- `window`: ISO timestamp range (start, end)
- `claims`: array of `{statement, evidence_index}` — every claim must point into `verified_against`
- `concerns`: optional array of `{type, detail}` — known limitations, drift, low-confidence claims

**Mechanism**: tool-level poka-yoke (per CLAUDE.md ACI principles). Zod schema validates at the tool boundary. Invalid → tool returns error → model re-emits. No prose-discipline, no "the model should remember to" — the schema enforces it.

### Primitive B — Voyager's critic: separate LLM call as the only write-gate

The agent that produces the report cannot grade its own work. Reports flow through a **second LLM call** (the critic) before being returned to the operator.

```
producer LLM → produces draft report → critic LLM → {verdict: pass|fail, critique: string} → only on pass: return to operator
```

**Mechanism**: dedicated `critic_report` system prompt, separate inference call. Up to 3 self-correction retries (producer revises based on critique). After 3, the report is returned with a `concerns: [{type: "audit_failed", detail: critique}]` flag — operator sees that the audit failed but still receives the draft. **Never silently skip the critic.**

**Why two passes, not just schema**: schema catches missing fields. Critic catches wrong values, stale citations, claims that don't follow from cited evidence, and small-sample extrapolations the producer rationalized away.

---

## §3 — The `verified_against` contract

Every citation is a typed object, not a free-form string. Closed enum of source types:

```typescript
type DataSourceCitation =
  | {
      type: "cost_ledger";
      query_sha: string;
      row_count: number;
      window_start: string;
      window_end: string;
    }
  | {
      type: "journal";
      pid: number;
      window_start: string;
      window_end: string;
      line_count: number;
    }
  | { type: "git"; sha: string; path?: string }
  | {
      type: "sqlite";
      table: string;
      query_sha: string;
      row_count: number;
      queried_at: string;
    }
  | {
      type: "recall_audit";
      query_sha: string;
      row_count: number;
      window_start: string;
      window_end: string;
    }
  | { type: "file"; path: string; sha256: string; lines?: string }
  | {
      type: "http";
      url: string;
      status: number;
      fetched_at: string;
      body_sha256: string;
    }
  | {
      type: "tool_output";
      tool_name: string;
      call_id: string;
      output_sha256: string;
    };
```

**Why typed citations**:

- `query_sha` proves the query was actually run (hash of the SQL/filter)
- `row_count` proves the producer saw the data, not a cached summary
- `window_start/end` makes the temporal scope auditable
- `output_sha256` makes tool outputs forensically reconstructible
- The closed enum (no `type: 'other'`) forces the producer to declare _what_ it queried

**The hard rule**: every numeric claim in `claims` must reference at least one `verified_against` entry, and that entry must have been written **during the current report-generation pass**. No reusing yesterday's `cost_ledger` query as evidence for today's claim.

This is enforced via tool-level audit: the `submit_report` tool records timestamps for each citation and rejects citations older than the report's start time.

---

## §4 — The critic call

### Critic system prompt (template)

```
You are the audit gate for a report produced by another agent. Your only job is to detect:

1. NUMERIC INTEGRITY: do the numbers in `claims` actually appear in the data cited under `verified_against`? Re-derive at least the headline number from the citation's row_count + window — if it doesn't match, fail.
2. SAMPLE INTEGRITY: any aggregate (avg, %, rate) with sample_n < 30 must be flagged unless the report's `concerns` already names it. Citing "n=5 average" without a concern is a fail.
3. WINDOW INTEGRITY: do the windows in `verified_against` overlap the windows of the claims? A claim about "the last 24h" cited against a `window_start` 3 days ago is a fail.
4. CITATION FRESHNESS: every `verified_against` entry must have a `queried_at` >= report.started_at. Stale = fail.
5. CONCERN COMPLETENESS: post-restart data, mixed-PID windows, single-day extrapolations to monthly — these MUST be in `concerns`. Missing = fail.

Return ONLY:
{ "verdict": "pass" | "fail", "critique": "<one paragraph max if fail; empty if pass>" }

Do not propose fixes. Do not rewrite the report. Your output is a verdict, nothing else.
```

### Why minimal critic, not a full re-derivation

A full re-derivation would double the cost. The critic only needs to spot-check 1-2 headline numbers + verify the schema invariants. If it spots a discrepancy, the producer revises. If it can't spot anything within its budget, it passes — and the operator's "Audited?" reflex is the final gate.

### Cost model

- Producer: existing call (no new cost)
- Critic: estimated 30-40% of producer prompt size (sees only the report JSON + citations summary, not the full producer context)
- Retry budget: 3 producer revisions max
- **Worst case**: 4× producer + 4× critic = 1 task generates ~5x normal cost. Mitigated by the `critic_skip_for` allowlist (§5).

---

## §5 — Surface area: which tools are subject to S2

S2 doesn't apply to every tool output. It applies to **reports** — outputs intended for operator-facing consumption that include claims about state, trends, or recommendations.

### Subject to S2 (Round 1 retrofit)

- `morning_brief` (rituals/morning.ts) — V8.1's morning brief generator
- `intel-query` outputs — especially when claims are made about the data
- `market` ritual outputs (signal-intelligence) — already produces structured output
- `projects.ts` proposals — V8.2 territory
- Any V8.2 tool that emits `propose_*` (future)

### NOT subject to S2 (skip critic)

- Tool outputs that are pure data dumps (`crm-query`, `cost_ledger` raw queries)
- Read-only retrieval (`exa-search`, `gemini-research` _raw_)
- Action confirmations ("created file X", "sent message Y")
- Dev/diagnostic outputs (`mc-ctl drift`, `mc-ctl status`)

### `critic_skip_for` allowlist

A scope-level config: certain ritual paths skip the critic when the producer is using a deterministic tool chain (e.g., `morning.ts` aggregating `cost_ledger` directly). The schema is still enforced. This bounds worst-case cost.

---

## §6 — Schema (Zod)

```typescript
import { z } from "zod";

export const DataSourceCitationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cost_ledger"),
    query_sha: z.string().regex(/^[a-f0-9]{64}$/),
    row_count: z.number().int().nonnegative(),
    window_start: z.string().datetime(),
    window_end: z.string().datetime(),
    queried_at: z.string().datetime(),
  }),
  // ... (8 total variants per §3)
]);

export const ReportSchema = z.object({
  report_id: z.string().uuid(),
  started_at: z.string().datetime(),
  surface: z.enum([
    "morning_brief",
    "proposal",
    "signal_intel",
    "project_status",
    "ad_hoc",
  ]),
  verified_against: z.array(DataSourceCitationSchema).min(1),
  sample_n: z.number().int().positive(),
  window: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }),
  claims: z
    .array(
      z.object({
        statement: z.string().min(10),
        evidence_index: z.array(z.number().int().nonnegative()).min(1),
      }),
    )
    .min(1),
  concerns: z
    .array(
      z.object({
        type: z.enum([
          "small_sample", // n < 30 on aggregate
          "mixed_pid_window", // service restarts in window
          "extrapolation", // single-day → monthly etc
          "stale_data", // citation queried_at far behind report.started_at
          "audit_failed", // critic flagged after retry budget exhausted
          "incomplete_coverage", // known data-source gaps
          "other",
        ]),
        detail: z.string(),
      }),
    )
    .default([]),
  critic_verdict: z.enum(["pass", "fail_returned_anyway", "skipped_allowlist"]),
  critic_critique: z.string().optional(),
  retry_count: z.number().int().min(0).max(3),
});

export type Report = z.infer<typeof ReportSchema>;
```

### Storage

New table `reports`:

```sql
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  report_id TEXT UNIQUE NOT NULL,
  surface TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  report_json TEXT NOT NULL,
  critic_verdict TEXT NOT NULL CHECK (critic_verdict IN ('pass','fail_returned_anyway','skipped_allowlist')),
  critic_retries INTEGER NOT NULL DEFAULT 0,
  critic_cost_usd REAL,
  producer_cost_usd REAL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX idx_reports_surface ON reports(surface);
CREATE INDEX idx_reports_critic_verdict ON reports(critic_verdict);
CREATE INDEX idx_reports_produced ON reports(produced_at DESC);
```

Additive migration, applies live (per CLAUDE.md schema rules).

---

## §7 — Retrofit plan (post-freeze)

### Phase 1: harness + schema (~3 days)

1. Add `src/audit/report-schema.ts` (Zod definitions)
2. Add `src/audit/critic.ts` (critic LLM call wrapper, uses heavy-runner SDK path for cache stability)
3. Add `src/audit/submit-report.ts` (the boundary function — validates schema, runs critic, retries, persists to `reports` table)
4. Add `reports` table migration
5. Tests: schema validation, critic mock returning pass/fail/error, retry exhaustion path, allowlist skip path

### Phase 2: morning_brief retrofit (~2 days)

- `rituals/morning.ts` first, since it's V8.1's primary surface
- Replace prose template with structured JSON emission via `submit_report`
- Validate operator-facing rendering: render the JSON to markdown for Telegram, with `verified_against` as a footer (collapsed by default, visible on tap)

### Phase 3: V8.2 proposals (during V8.2 build)

- Every `propose_*` tool calls `submit_report` before delivering
- The "verified-against:" line in V8-VISION §3-S2 becomes the rendered footer

### Phase 4: backfill (optional)

- Other report-emitting tools (`intel-query`, `signal-intelligence`) retrofitted opportunistically as they're touched for other reasons

---

## §8 — Activation gate & measurement

Per V8-VISION §3-S2: **"zero 'Audited?' cycles in a sprint of v8 proposals."**

### Operational metric

- Count of operator messages matching `/(audited|fact.?check|where.+from|verify|verified)/i` per 7-day window
- Pre-S2 baseline: pull from journal Apr 22-30 (Day 1-9 of freeze)
- Post-S2 target: 50% reduction in 30 days, 80% in 60 days

### Schema-violation metric

- `SELECT count(*) FROM reports WHERE critic_verdict = 'fail_returned_anyway'`
- Healthy: < 5% of reports
- Watchpoint: > 15% (means producer is consistently failing critic — prompt or schema issue)

### Cost metric

- `SELECT AVG(critic_cost_usd / producer_cost_usd) FROM reports WHERE critic_verdict != 'skipped_allowlist'`
- Target: < 0.4 (critic is < 40% of producer cost)
- Watchpoint: > 0.6 (critic prompt too verbose, retry rate too high)

---

## §9 — Open questions

1. **Critic model choice**: same model as producer (cache-friendly) or smaller model (cheaper)? Spec defaults to same-model + heavy-runner SDK path for cache stability. Revisit after 24h of post-deploy data.

2. **Retry policy on critic infrastructure failure** (LLM API timeout): currently spec says "return draft with concerns: audit_failed". Alternative: queue for re-audit when API recovers. Defer to operator preference.

3. **Allowlist governance**: who decides what skips the critic? Currently scope-level config. Risk: drift toward "everything is allowlisted." Mitigation: a daily `mc-ctl audit-coverage` showing % of reports that ran through the critic.

4. **Cross-report citation reuse**: can report B cite report A as a data source? Spec says no — every citation must be a primary-source query. Risk: V8.1 morning briefs will re-query `cost_ledger` even if last hour's brief did the same. Performance implications when V8.1 traffic grows.

5. **Critic-as-tool vs critic-as-runner**: spec uses dedicated function. Alternative: model it as a Voyager-style separate "critic runner" (6th runner type). Defer — current scope is bounded.

6. **Operator override**: can the operator force-pass a `fail_returned_anyway` report? Spec says no — the operator just sees the concern flag. Alternative: explicit `acknowledge_concerns` action that promotes it to pass. Useful for V8.3 (autonomous gates) integration. Defer to V8.3 design.

---

## §10 — Cross-references

- V8-VISION.md §3-S2 — original requirement
- `feedback_metrics_extrapolation.md` — the prose discipline this codifies
- `feedback_audit_discipline.md` — 2-round protocol the critic implements at tool level
- `reference_datagen.md` — note-agent JSON enforcement pattern
- `reference_voyager.md` — critic-as-write-gate pattern
- `feedback_completed_task_failure_narrative.md` — adjacent pattern (recall-side outcome filter); S2 is the write-side equivalent for reports

---

## §11 — One-page summary

| Item                | Decision                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| **Mechanism**       | Schema enforcement (Zod) + critic LLM call (separate prompt)             |
| **Cost overhead**   | < 40% of producer per report; allowlist for deterministic tools          |
| **Storage**         | New `reports` table, additive migration                                  |
| **First retrofit**  | `morning_brief` (V8.1's primary surface)                                 |
| **Activation gate** | 50% reduction in operator "Audited?" messages within 30 days             |
| **Effort**          | Phase 1 (~3 days) + Phase 2 (~2 days) + per-tool retrofit cost           |
| **Freeze posture**  | Spec only. No code changes during freeze. Implementation post 2026-05-22 |
| **Dependencies**    | S4 (cost_ledger v2) ✅ shipped — citations cite real cost data           |
| **Unblocks**        | V8.2 Strategic Initiative Layer (every proposal must pass S2)            |
| **Open Q count**    | 6 (§9) — none are blocking                                               |
