/**
 * V8 substrate S2 — `submit_report` tool (Phase 2a).
 *
 * The runtime entry-point producers (rituals, runners, LLM tool calls) use
 * to flow a report through the schema → critic → persistence pipeline built
 * in Phase 1 (`src/audit/submit-report.ts`).
 *
 * This is the **single-pass** boundary: the LLM controls retries (see
 * tool description). On `ok:false`, the LLM revises the draft and re-calls;
 * after 3 calls per `task_id` (the cap below), the tool refuses further
 * audits and instructs the LLM to proceed to the actual delivery sink
 * (e.g. `gmail_send`) with the report content. The persisted records form
 * the audit trail.
 *
 * Critical operating invariant: this tool is observability + discipline,
 * NOT a delivery gate. Even on `fail_returned_anyway`, the LLM should
 * proceed to send the report — the failure surfaces in `reports.critic_verdict`
 * for post-hoc operator inspection, not by blocking the user-facing channel.
 * (Phase 2b — community-manager email — uses the critic as a TRUE
 * write-gate where send-blocking is appropriate.)
 */

import { getDatabase } from "../../db/index.js";
import { submitReport } from "../../audit/submit-report.js";
import type { Tool } from "../types.js";

/**
 * Per-task hard cap on submit_report invocations. Independent of the
 * `MAX_RETRIES=3` inside `submitReport`'s reviseFn loop (which this tool
 * doesn't use — single-pass + LLM retry instead). Belt-and-suspenders to
 * bound critic spend when the LLM mis-implements the cap in its own loop.
 */
const PER_TASK_CALL_CAP = 3;

/**
 * Cap counts only audit-revision attempts, not successful passes. Otherwise a
 * task_id that gets recycled across cron runs (date-stamped IDs) would
 * hard-fail on the 4th day even when every prior call passed cleanly.
 * Semantically: "you've revised this report 3 times AND the critic still
 * isn't happy — stop spending; proceed to delivery."
 *
 * `pass` does NOT count; `fail_returned_anyway` and `skipped_allowlist` do.
 * (skipped_allowlist is included defensively — if a producer is hitting the
 * cap on an allowlisted surface, something is wrong upstream.)
 */
function countPriorAttempts(taskId: string): number {
  try {
    const row = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS c FROM reports WHERE task_id = ? AND critic_verdict != 'pass'",
      )
      .get(taskId) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0; // permissive on DB error — bias toward LLM autonomy
  }
}

export const submitReportTool: Tool = {
  name: "submit_report",
  // Pure DB write + LLM critic call. Recoverable (persisted record can be
  // ignored downstream), not external — the critic stays inside the
  // multi-provider inference path mc already governs.
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  deferred: false,
  // Per CLAUDE.md ACI guidance: DB write only, no operator-facing surface,
  // recoverable. "Low" rather than "medium" because the report record is
  // post-hoc inspection data — its absence/incorrectness never bricks
  // anything downstream of the producer.
  riskTier: "low",
  definition: {
    type: "function",
    function: {
      name: "submit_report",
      description: `Validate and audit a draft report before delivering it to the operator.

USE WHEN composing any operator-facing report that quotes aggregate metrics, project status, recent events, or recommendations — BEFORE the actual delivery tool (gmail_send, telegram_send, etc.).

EVERY claim must cite a data source via verified_against. Build each citation while reading the source:
  - jarvis_file_read result → {type:"file", path, sha256:"<64-hex>", queried_at}
  - intel_query / intel_alert_history output → {type:"tool_output", tool_name, call_id, output_sha256, queried_at}
  - memory_search results → {type:"tool_output", tool_name:"memory_search", call_id, output_sha256, queried_at}
  - git history → {type:"git", sha:"<40-hex>", path?, queried_at}
  - cost_ledger / SQLite queries → {type:"sqlite", table, query_sha:"<64-hex>", row_count, queried_at}

Every claim.evidence_index points into verified_against by zero-based index.

CONCERNS — list explicitly when any apply:
  - small_sample: any aggregate where sample_n < 30
  - mixed_pid_window: window spans a service restart
  - extrapolation: single-day metric projected to monthly
  - stale_data: data more than expected window-age behind
  - incomplete_coverage: known data-source gaps

RESPONSE shapes:
  - {ok:true, report_id, critic_verdict:"pass", retry_count}  — ship the report as-is
  - {ok:true, report_id, critic_verdict:"fail_returned_anyway", retry_count, critic_critique} — critic flagged issues but report is still persisted; SHIP the report anyway (don't drop the user's brief) and surface the critique in operator-visible logs. The failure is recorded in the reports table for post-hoc inspection.
  - {ok:false, kind:"schema"|"invariants", issues:[...]}  — fix the cited issues and CALL submit_report AGAIN with a corrected draft. Max ${PER_TASK_CALL_CAP} attempts per task.
  - {ok:false, kind:"cap_exceeded", message}  — you've already audited 3 times. PROCEED to delivery with the latest draft; the audit trail exists in the reports table.

NEVER skip the actual delivery tool because of an audit failure. submit_report is observability, not a gate.`,
      parameters: {
        type: "object",
        properties: {
          report_id: {
            type: "string",
            description:
              "UUID for this report. Generate a fresh UUID per attempt (a retry of the same logical report is a NEW report_id sharing the same task_id).",
          },
          started_at: {
            type: "string",
            description:
              "ISO 8601 datetime (with offset) when you began assembling this report. Citations queried_at MUST be >= this value (freshness invariant).",
          },
          surface: {
            type: "string",
            enum: [
              "morning_brief",
              "proposal",
              "signal_intel",
              "project_status",
              "closure_doc",
              "community_email",
              "ad_hoc",
            ],
            description:
              "Which operator-facing surface this report serves. Choose the most specific match.",
          },
          verified_against: {
            type: "array",
            description:
              "Citations for every data source you read while assembling this report. At least one required; every claim must reference at least one.",
            items: { type: "object" },
            minItems: 1,
          },
          sample_n: {
            type: "integer",
            description:
              "The N behind the headline aggregate. For per-task summaries, count examined items. For composed briefs with no single aggregate, use the count of source items read.",
            minimum: 1,
          },
          window: {
            type: "object",
            description:
              "ISO datetime range the report covers (start, end). end >= start.",
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
            required: ["start", "end"],
          },
          claims: {
            type: "array",
            description:
              "Each claim is a {statement, evidence_index[]} pair. Statement >= 10 chars. Every evidence_index points into verified_against.",
            items: { type: "object" },
            minItems: 1,
          },
          concerns: {
            type: "array",
            description:
              "Optional list of {type, detail} flagging known limitations. Omit when no concerns apply.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "small_sample",
                    "mixed_pid_window",
                    "extrapolation",
                    "stale_data",
                    "audit_failed",
                    "incomplete_coverage",
                    "other",
                  ],
                },
                detail: { type: "string" },
              },
              required: ["type", "detail"],
            },
          },
          task_id: {
            type: "string",
            description:
              "Optional. The dispatcher task_id this report belongs to. Used for the per-task call cap and audit-trail joins.",
          },
        },
        required: [
          "report_id",
          "started_at",
          "surface",
          "verified_against",
          "sample_n",
          "window",
          "claims",
        ],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    // Per-task cap check — refuses further audits, NOT delivery.
    // NOTE: cap counts only non-pass attempts (see countPriorAttempts); this
    // call's draft is NOT validated when the cap fires — proceed with the
    // most recent draft you composed, not this one.
    const taskId = typeof args.task_id === "string" ? args.task_id : undefined;
    if (taskId && countPriorAttempts(taskId) >= PER_TASK_CALL_CAP) {
      return JSON.stringify({
        ok: false,
        kind: "cap_exceeded",
        message: `submit_report exhausted ${PER_TASK_CALL_CAP} audit attempts for task_id ${taskId}. This call's draft was NOT validated. PROCEED to delivery with the most recent draft you successfully composed; the audit trail is in the reports table.`,
      });
    }

    const result = await submitReport(args);

    if (!result.ok) {
      // Schema / invariants failure — give the LLM the issues to fix
      return JSON.stringify({
        ok: false,
        kind: result.kind,
        issues: result.issues,
      });
    }

    return JSON.stringify({
      ok: true,
      report_id: result.report.report_id,
      critic_verdict: result.report.critic_verdict,
      retry_count: result.report.retry_count,
      critic_critique: result.report.critic_critique,
    });
  },
};
