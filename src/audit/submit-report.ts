/**
 * V8 substrate S2 — report submission boundary.
 *
 * `submitReport()` is the only sanctioned way a producer (ritual / runner /
 * tool) emits an operator-facing report. It enforces the discipline
 * `feedback_metrics_extrapolation.md` and `feedback_audit_discipline.md`
 * describe in prose:
 *
 *   draft → Zod schema → cross-field invariants → allowlist check
 *         → critic LLM call (≤ 3 producer revisions) → persist to reports table
 *         → return validated Report
 *
 * On schema failure: structured error `{ ok: false, kind: 'schema', issues }` —
 * the producer revises and resubmits.
 *
 * On critic failure after retry budget: report is returned WITH
 * `critic_verdict: 'fail_returned_anyway'` and a `concerns` entry of type
 * 'audit_failed'. **Never silently skip the critic.**
 *
 * On allowlist hit: critic is bypassed (verdict 'skipped_allowlist').
 * Schema is still enforced.
 *
 * Cost / retry policy (spec §4): worst case 4× producer + 4× critic per task.
 * The retry loop expects a `reviseFn` from the caller; if absent, the draft
 * is returned after a single critic pass with `fail_returned_anyway` on fail.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../db/index.js";
import { runCritic, type CriticOptions } from "./critic.js";
import {
  ReportDraftSchema,
  validateReportInvariants,
  type Report,
  type ReportDraft,
  type ReportSurface,
} from "./report-schema.js";

/**
 * Surfaces that bypass the critic call. Schema is STILL enforced. This is
 * the V8 spec §5 escape hatch for ritual paths whose producer chain is
 * deterministic (e.g. `morning.ts` aggregating cost_ledger via raw SQL —
 * no LLM extrapolation to grade).
 *
 * Phase 1: hardcoded empty. Phase 2 surfaces may opt in here; an env-var or
 * scope-config promotion is deferred until ≥1 production surface needs it.
 *
 * Anti-pattern guard: a surface that LLM-extrapolates over data MUST NOT be
 * allowlisted (defeats the audit). The list is intentionally tiny.
 */
// NOTE: `ReadonlySet<ReportSurface>` is a compile-time contract only. At
// runtime this is a normal Set — tests mutate it via `as Set<...>` casts.
// Phase 2 should either freeze the set (Object.freeze on the underlying Set
// once populated) or move the allowlist to a config-driven source.
export const CRITIC_SKIP_FOR: ReadonlySet<ReportSurface> =
  new Set<ReportSurface>([]);

const MAX_RETRIES = 3;

export interface SubmitReportOptions {
  /**
   * Producer's revision callback. Receives the failed draft + critique;
   * returns a revised draft. Omit to ship without revision (single critic
   * pass; on fail, the draft is returned with `fail_returned_anyway`).
   */
  reviseFn?: (
    draft: ReportDraft,
    critique: string,
    retryCount: number,
  ) => Promise<ReportDraft>;
  /** Producer-cost in USD, recorded alongside critic cost. */
  producerCostUsd?: number;
  /** Passed through to the critic. */
  criticOptions?: CriticOptions;
}

export type SubmitResult =
  | { ok: true; report: Report }
  | { ok: false; kind: "schema"; issues: string[]; draft: unknown }
  | { ok: false; kind: "invariants"; issues: string[]; draft: ReportDraft };

/**
 * Validate, audit, and persist a report draft. See module docstring.
 */
export async function submitReport(
  raw: unknown,
  options: SubmitReportOptions = {},
): Promise<SubmitResult> {
  // 1. Zod schema.
  const parsed = ReportDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "schema",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
      draft: raw,
    };
  }
  let draft = parsed.data;

  // 2. Cross-field invariants.
  const invariantIssues = validateReportInvariants(draft);
  if (invariantIssues.length > 0) {
    return {
      ok: false,
      kind: "invariants",
      issues: invariantIssues,
      draft,
    };
  }

  // 3. Allowlist short-circuit (schema STILL enforced — see check above).
  if (CRITIC_SKIP_FOR.has(draft.surface)) {
    const report = freezeReport(draft, {
      critic_verdict: "skipped_allowlist",
      retry_count: 0,
      critic_cost_usd: undefined,
      producer_cost_usd: options.producerCostUsd,
    });
    persistReport(report);
    return { ok: true, report };
  }

  // 4. Critic loop (≤ MAX_RETRIES producer revisions).
  let retryCount = 0;
  let lastCritique: string | undefined;
  let totalCriticCostUsd = 0;

  while (retryCount <= MAX_RETRIES) {
    const critic = await runCritic(draft, options.criticOptions);
    if (typeof critic.costUsd === "number")
      totalCriticCostUsd += critic.costUsd;

    if (critic.verdict === "pass") {
      const report = freezeReport(draft, {
        critic_verdict: "pass",
        retry_count: retryCount,
        critic_cost_usd:
          totalCriticCostUsd > 0 ? totalCriticCostUsd : undefined,
        producer_cost_usd: options.producerCostUsd,
        critic_critique: undefined,
      });
      persistReport(report);
      return { ok: true, report };
    }

    lastCritique = critic.critique;

    // Critic infrastructure failure: do NOT spend retry budget on it.
    // Fold into concerns and return immediately so operator sees the audit
    // failed but still receives the draft (spec §4 Q2).
    if (critic.error) {
      const folded = appendConcern(draft, {
        type: "audit_failed",
        detail: critic.critique,
      });
      const report = freezeReport(folded, {
        critic_verdict: "fail_returned_anyway",
        retry_count: retryCount,
        critic_cost_usd:
          totalCriticCostUsd > 0 ? totalCriticCostUsd : undefined,
        producer_cost_usd: options.producerCostUsd,
        critic_critique: critic.critique,
      });
      persistReport(report);
      return { ok: true, report };
    }

    // Content failure: revise and re-critic if reviseFn provided AND budget left.
    if (!options.reviseFn || retryCount >= MAX_RETRIES) break;
    retryCount += 1;
    // Producer's reviseFn can throw (LLM call failure, async bug). Fold into
    // audit_failed and return rather than propagating an unhandled rejection.
    try {
      draft = await options.reviseFn(draft, critic.critique, retryCount);
    } catch (e) {
      const detail = `reviseFn threw on retry ${retryCount}: ${
        e instanceof Error ? e.message : String(e)
      }`;
      const folded = appendConcern(draft, { type: "audit_failed", detail });
      const report = freezeReport(folded, {
        critic_verdict: "fail_returned_anyway",
        retry_count: retryCount,
        critic_cost_usd:
          totalCriticCostUsd > 0 ? totalCriticCostUsd : undefined,
        producer_cost_usd: options.producerCostUsd,
        critic_critique: detail,
      });
      persistReport(report);
      return { ok: true, report };
    }

    // Re-validate the revised draft. If producer breaks schema/invariants
    // mid-loop, return the structured error instead of silently looping.
    const reparse = ReportDraftSchema.safeParse(draft);
    if (!reparse.success) {
      return {
        ok: false,
        kind: "schema",
        issues: reparse.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        ),
        draft,
      };
    }
    draft = reparse.data;
    const reInvariants = validateReportInvariants(draft);
    if (reInvariants.length > 0) {
      return { ok: false, kind: "invariants", issues: reInvariants, draft };
    }
  }

  // Retry budget exhausted. Fold critique into concerns; return as
  // 'fail_returned_anyway' (spec §4: operator sees the flag but still receives
  // the draft).
  const folded = appendConcern(draft, {
    type: "audit_failed",
    detail: lastCritique ?? "critic failed after retry budget exhausted",
  });
  const report = freezeReport(folded, {
    critic_verdict: "fail_returned_anyway",
    retry_count: retryCount,
    critic_cost_usd: totalCriticCostUsd > 0 ? totalCriticCostUsd : undefined,
    producer_cost_usd: options.producerCostUsd,
    critic_critique: lastCritique,
  });
  persistReport(report);
  return { ok: true, report };
}

interface FreezeFields {
  critic_verdict: Report["critic_verdict"];
  retry_count: number;
  critic_cost_usd?: number;
  producer_cost_usd?: number;
  critic_critique?: string;
}

/** Compose a final `Report` from a validated draft + critic outcome. */
function freezeReport(draft: ReportDraft, fields: FreezeFields): Report {
  return {
    ...draft,
    produced_at: new Date().toISOString(),
    critic_verdict: fields.critic_verdict,
    critic_critique: fields.critic_critique,
    retry_count: fields.retry_count,
    critic_cost_usd: fields.critic_cost_usd,
    producer_cost_usd: fields.producer_cost_usd,
  };
}

function appendConcern(
  draft: ReportDraft,
  concern: ReportDraft["concerns"][number],
): ReportDraft {
  return { ...draft, concerns: [...draft.concerns, concern] };
}

/**
 * Hard cap on serialized report size. 256 KB is ~2 orders of magnitude above
 * the largest realistic morning_brief blob (typically <8 KB). A larger payload
 * is almost certainly a producer bug (raw tool-output dump pasted in). Drop
 * the persist and log; the caller's contract is unchanged (report still
 * returned in-memory).
 */
const REPORT_JSON_MAX_BYTES = 256 * 1024;

/**
 * spec §6 lists FOREIGN KEY (task_id) REFERENCES tasks(id). DELIBERATELY
 * OMITTED here because mc.db's task table is named `task_history`, not
 * `tasks`, and mc.db convention is to skip cross-table FK enforcement.
 * task_id is preserved as a free-text column for join-by-app-code.
 */

const INSERT_REPORT_SQL = `INSERT INTO reports
       (report_id, surface, task_id, started_at, produced_at, report_json,
        critic_verdict, critic_retries, critic_cost_usd, producer_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(report_id) DO NOTHING`;

/**
 * S2-W6 fold (Phase 2a): prepared statements are per-Database in better-sqlite3,
 * and tests swap in `:memory:` instances under `initDatabase`. Cache by Database
 * reference so production sees one warm statement for life-of-process while
 * tests get a fresh statement on each in-memory DB. WeakMap so closed test DBs
 * GC freely.
 */
type ReportInsertStmt = Database.Statement<
  [
    string, // report_id
    string, // surface
    string | null, // task_id
    string, // started_at
    string, // produced_at
    string, // report_json
    string, // critic_verdict
    number, // critic_retries
    number | null, // critic_cost_usd
    number | null, // producer_cost_usd
  ]
>;
const insertStmtCache = new WeakMap<Database.Database, ReportInsertStmt>();

function persistReport(report: Report): void {
  const db = getDatabase();
  const reportJson = JSON.stringify(report);

  if (reportJson.length > REPORT_JSON_MAX_BYTES) {
    console.warn(
      `[submitReport] report ${report.report_id} (${report.surface}) exceeds ${REPORT_JSON_MAX_BYTES}B (${reportJson.length}B) — not persisted`,
    );
    return;
  }

  let stmt = insertStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(INSERT_REPORT_SQL) as ReportInsertStmt;
    insertStmtCache.set(db, stmt);
  }
  const result = stmt.run(
    report.report_id,
    report.surface,
    report.task_id ?? null,
    report.started_at,
    report.produced_at,
    reportJson,
    report.critic_verdict,
    report.retry_count,
    report.critic_cost_usd ?? null,
    report.producer_cost_usd ?? null,
  );

  // ON CONFLICT swallows duplicates silently. Surface a warning so a
  // producer that's re-using report_id (UUID-collision = producer bug per
  // spec §3) shows up in logs instead of as a phantom missing row.
  if (result.changes === 0) {
    console.warn(
      `[submitReport] report_id ${report.report_id} already persisted; second submission dropped (producer bug — UUIDs should be per-pass)`,
    );
  }
}
