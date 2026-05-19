/**
 * V8 substrate S2 — report contract schema.
 *
 * Every report tool output is validated against `ReportSchema` at the tool
 * boundary (`submitReport`). Invalid → tool returns structured error → model
 * re-emits. This codifies the "Audited?" prose discipline as a mechanical,
 * tool-level contract per V8-VISION §3-S2.
 *
 * Cross-field invariants Zod can't express ergonomically live in
 * `validateReportInvariants` (citation freshness, window ordering,
 * evidence-index bounds).
 *
 * The `surface` enum is frozen — adding a new surface is an explicit edit.
 */

import { z } from "zod";

// Lowercase-hex contract. Matches `git log --pretty=%H`, `crypto.createHash().digest("hex")`,
// and Node's `subtle.digest` consumer convention. Producers MUST emit lowercase. If a
// future producer pulls from an upper-hex source (e.g. Windows certutil) it's the
// producer's responsibility to normalize before submission. Widening to [a-fA-F0-9]
// would invite case-mixing inconsistency in stored citations.
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA1_HEX = /^[a-f0-9]{40}$/;

const isoDatetime = z.iso.datetime({ offset: true });

const baseCitationFields = {
  queried_at: isoDatetime.describe(
    "When this citation was produced. Must be >= report.started_at — enforced by validateReportInvariants.",
  ),
};

/**
 * Closed enum of source types. No `type: 'other'` — the producer must declare
 * what it queried so the citation is forensically reconstructible.
 */
export const DataSourceCitationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cost_ledger"),
    query_sha: z.string().regex(SHA256_HEX),
    row_count: z.number().int().nonnegative(),
    window_start: isoDatetime,
    window_end: isoDatetime,
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("journal"),
    pid: z.number().int().positive(),
    window_start: isoDatetime,
    window_end: isoDatetime,
    line_count: z.number().int().nonnegative(),
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("git"),
    sha: z.string().regex(SHA1_HEX),
    path: z.string().optional(),
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("sqlite"),
    table: z.string().min(1),
    query_sha: z.string().regex(SHA256_HEX),
    row_count: z.number().int().nonnegative(),
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("recall_audit"),
    query_sha: z.string().regex(SHA256_HEX),
    row_count: z.number().int().nonnegative(),
    window_start: isoDatetime,
    window_end: isoDatetime,
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("file"),
    path: z.string().min(1),
    // sha256 is OPTIONAL in Phase 2a — `jarvis_file_read` does not yet expose
    // a content hash, and the morning_brief LLM cannot compute one without
    // additional tooling. Path alone proves what was read; sha256 strengthens
    // forensic reconstruction when available. Phase 2b retrofit candidate:
    // have jarvis_file_read return sha256 in its output, then promote this
    // field back to required.
    sha256: z.string().regex(SHA256_HEX).optional(),
    lines: z.string().optional(),
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("http"),
    url: z.url(),
    status: z.number().int().min(100).max(599),
    fetched_at: isoDatetime,
    body_sha256: z.string().regex(SHA256_HEX),
    ...baseCitationFields,
  }),
  z.strictObject({
    type: z.literal("tool_output"),
    tool_name: z.string().min(1),
    call_id: z.string().min(1),
    output_sha256: z.string().regex(SHA256_HEX),
    ...baseCitationFields,
  }),
]);
export type DataSourceCitation = z.infer<typeof DataSourceCitationSchema>;

/**
 * Spec §6 baseline: morning_brief | proposal | signal_intel | project_status | ad_hoc.
 * v7.7 Spine 1 Phase 2 retrofit deltas (per V7.7-GUIDE.md Spine 1):
 *   - closure_doc      — codifies the v7.6 closure-audit pattern that caught 4 fidelity bugs
 *   - community_email  — comunidades@mexiconecesario.org.mx reply path (live since 2026-05-15)
 * Spec amendment: docs/planning/v8-substrate-s2-spec.md §6 — kept in sync at Spine 1 close.
 */
export const REPORT_SURFACES = [
  "morning_brief",
  "proposal",
  "signal_intel",
  "project_status",
  "closure_doc",
  "community_email",
  "ad_hoc",
] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

export const CONCERN_TYPES = [
  "small_sample",
  "mixed_pid_window",
  "extrapolation",
  "stale_data",
  "audit_failed",
  "incomplete_coverage",
  "other",
] as const;
export type ConcernType = (typeof CONCERN_TYPES)[number];

export const CriticVerdictSchema = z.enum([
  "pass",
  "fail_returned_anyway",
  "skipped_allowlist",
]);
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

/**
 * Producer-submitted draft. `critic_verdict`, `critic_critique`, `retry_count`,
 * `produced_at`, and the `*_cost_usd` fields are filled by `submitReport`, not
 * by the producer.
 */
export const ReportDraftSchema = z.object({
  report_id: z.uuid(),
  started_at: isoDatetime,
  surface: z.enum(REPORT_SURFACES),
  verified_against: z.array(DataSourceCitationSchema).min(1),
  sample_n: z.number().int().positive(),
  window: z.object({
    start: isoDatetime,
    end: isoDatetime,
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
        type: z.enum(CONCERN_TYPES),
        detail: z.string().min(1),
      }),
    )
    .default([]),
  task_id: z.string().optional(),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

export const ReportSchema = ReportDraftSchema.extend({
  critic_verdict: CriticVerdictSchema,
  critic_critique: z.string().optional(),
  retry_count: z.number().int().min(0).max(3),
  produced_at: isoDatetime,
  critic_cost_usd: z.number().nonnegative().optional(),
  producer_cost_usd: z.number().nonnegative().optional(),
});
export type Report = z.infer<typeof ReportSchema>;

/**
 * Cross-field invariants Zod cannot express ergonomically.
 * Returns the list of issue strings; empty array = invariants hold.
 *
 * Invariants:
 *   1. window.end >= window.start
 *   2. every citation.queried_at >= report.started_at (freshness — enforces
 *      spec §3 "no reusing yesterday's query")
 *   3. every claims[i].evidence_index points within verified_against bounds
 */
export function validateReportInvariants(draft: ReportDraft): string[] {
  const issues: string[] = [];

  if (
    new Date(draft.window.end).getTime() <
    new Date(draft.window.start).getTime()
  ) {
    issues.push("window.end is before window.start");
  }

  const startedAtMs = new Date(draft.started_at).getTime();
  draft.verified_against.forEach((c, i) => {
    if (new Date(c.queried_at).getTime() < startedAtMs) {
      issues.push(
        `verified_against[${i}] (${c.type}) has queried_at < report.started_at — stale citation`,
      );
    }
  });

  const maxIdx = draft.verified_against.length - 1;
  draft.claims.forEach((claim, i) => {
    claim.evidence_index.forEach((idx) => {
      if (idx > maxIdx) {
        issues.push(
          `claims[${i}] cites evidence_index=${idx} but verified_against has only ${draft.verified_against.length} entries`,
        );
      }
    });
  });

  return issues;
}
