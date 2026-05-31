/**
 * V8.2 Phase 0 — substrate reconciliation constants (spec §5/§6/§7).
 *
 * R1 of the V8.2 spec composed against the *designed* substrate; ~30 days of
 * shipping moved the ground. This module is the single home for the reconciled
 * enums so every later V8.2 phase builds on values that resolve to reality:
 *
 *  - `EVIDENCE_KINDS` — R1 could not cite V8.1's own substrate; this adds
 *    `general_event` / `recurring_blocker` / `cohort_member` (the three live
 *    detection tables) alongside the base kinds. (§6)
 *  - `TOOL_GUIDANCE` — R1's enum (`tasks_query` / `northstar_read` / …) was
 *    entirely fictional. These six are grep-verified against the live registry
 *    on 2026-05-31 (`crm_query`, `intel_query`, `memory_search`,
 *    `memory_kg_query`, `jarvis_file_search`, `northstar_sync`). (§7)
 *  - `POSTURES` — the canonical V8.2 posture vocabulary. NOTE the divergence
 *    from V8.1 `JudgmentSchema.posture` ('has_momentum'): the V8.2 value is
 *    'momentum'. The Phase 2 judgment pass that maps a V8.1 signal into a
 *    `judgments` row MUST normalize 'has_momentum' → 'momentum'.
 *
 * Phase 1 (`src/lib/v8-2/types.ts`) re-exports these into the full
 * `StrategicJudgment` type set; Phase 0 keeps only the reconciliation surface.
 */

import { z } from "zod";
import Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";

// ── evidence_kind (§6) ───────────────────────────────────────────────────────
export const EVIDENCE_KINDS = [
  "task",
  "kb_entry",
  "conversation",
  "metric",
  "northstar",
  "general_event",
  "recurring_blocker",
  "cohort_member",
  "operator_message",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

/**
 * The evidence kinds that resolve to a live V8.1 detection table end-to-end.
 * `fetchEvidenceExcerpt` covers exactly these (the base kinds resolve through
 * their own existing stores in later phases). (§5 item 3 done-when)
 */
export const V81_SUBSTRATE_EVIDENCE_KINDS = [
  "general_event",
  "recurring_blocker",
  "cohort_member",
] as const;
export type V81SubstrateEvidenceKind =
  (typeof V81_SUBSTRATE_EVIDENCE_KINDS)[number];

// ── tool_guidance (§7) ───────────────────────────────────────────────────────
export const TOOL_GUIDANCE = [
  "crm_query",
  "intel_query",
  "memory_search",
  "memory_kg_query",
  "jarvis_file_search",
  "northstar_sync",
] as const;
export type ToolGuidance = (typeof TOOL_GUIDANCE)[number];
export const ToolGuidanceSchema = z.enum(TOOL_GUIDANCE);

// ── posture / concession (§6) ────────────────────────────────────────────────
export const POSTURES = [
  "at_risk",
  "momentum",
  "highest_leverage",
  "noted",
] as const;
export type Posture = (typeof POSTURES)[number];
export const PostureSchema = z.enum(POSTURES);

export const CONCESSION_KINDS = [
  "held_position",
  "updated_with_evidence",
  "conceded_without_evidence",
] as const;
export type ConcessionKind = (typeof CONCESSION_KINDS)[number];
export const ConcessionKindSchema = z.enum(CONCESSION_KINDS);

// ── tool_guidance registry validation (§5 item 4 done-when) ──────────────────
export interface ToolGuidanceValidation {
  ok: boolean;
  /** Names in TOOL_GUIDANCE that do NOT resolve to a registered tool. */
  missing: ToolGuidance[];
}

/**
 * Assert every `tool_guidance` value resolves to a registered tool. Pure: pass
 * the registry's tool names (Set or any iterable) so a unit test need not boot
 * the full tool registry. The phase that actually dispatches retrieval by
 * `tool_guidance` (Phase 2) should call this once at startup with the real
 * `toolRegistry` names and log a warning on any miss.
 */
export function validateToolGuidance(
  registeredToolNames: Iterable<string>,
): ToolGuidanceValidation {
  const names =
    registeredToolNames instanceof Set
      ? registeredToolNames
      : new Set(registeredToolNames);
  const missing = TOOL_GUIDANCE.filter((t) => !names.has(t));
  return { ok: missing.length === 0, missing };
}

// ── evidence resolution end-to-end (§5 item 3 done-when) ─────────────────────
export interface ResolvedEvidence {
  kind: V81SubstrateEvidenceKind;
  id: string;
  excerpt: string;
  retrieved_at: string;
}

/**
 * Resolve a citation to a V8.1 substrate row end-to-end, returning a populated
 * excerpt + retrieval timestamp — or `null` when the id does not resolve (the
 * §9 citation resolver will mark such claims `unresolved`/dropped). This proves
 * the reconciled `evidence_kind` enum is wired to a real table; the full
 * `[N]`-marker resolver lands in Phase 4.
 *
 * The id is the stable TEXT key of each table, NOT the integer PK:
 *   general_event    → general_events.event_id
 *   recurring_blocker→ recurring_blockers.blocker_signature
 *   cohort_member    → self_defining_cohort.member_id
 */
export function fetchEvidenceExcerpt(
  kind: V81SubstrateEvidenceKind,
  id: string,
  opts: { db?: Database.Database; nowIso?: string } = {},
): ResolvedEvidence | null {
  const db = opts.db ?? getDatabase();
  const retrieved_at = opts.nowIso ?? new Date().toISOString();

  switch (kind) {
    case "general_event": {
      const row = db
        .prepare(
          "SELECT title, summary, end_at, start_at FROM general_events WHERE event_id = ?",
        )
        .get(id) as
        | {
            title: string;
            summary: string;
            end_at: string | null;
            start_at: string;
          }
        | undefined;
      if (!row) return null;
      // Temporal context for the judge ([[detection-signal-temporal-context]]).
      const lastSeen = row.end_at ?? row.start_at;
      return {
        kind,
        id,
        excerpt: `${row.title} — ${row.summary} [last_seen=${lastSeen}]`,
        retrieved_at,
      };
    }
    case "recurring_blocker": {
      const row = db
        .prepare(
          "SELECT blocker_signature, last_seen_at, task_count FROM recurring_blockers WHERE blocker_signature = ?",
        )
        .get(id) as
        | {
            blocker_signature: string;
            last_seen_at: string;
            task_count: number;
          }
        | undefined;
      if (!row) return null;
      return {
        kind,
        id,
        excerpt: `${row.blocker_signature} (seen ${row.task_count}×, last_seen=${row.last_seen_at})`,
        retrieved_at,
      };
    }
    case "cohort_member": {
      const row = db
        .prepare(
          "SELECT label, member_kind, salience FROM self_defining_cohort WHERE member_id = ?",
        )
        .get(id) as
        | { label: string; member_kind: string; salience: number }
        | undefined;
      if (!row) return null;
      return {
        kind,
        id,
        excerpt: `${row.member_kind}: ${row.label} (salience=${row.salience})`,
        retrieved_at,
      };
    }
  }
}
