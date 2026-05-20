/**
 * proposed_briefings persistence — V8.1 Phase 6 (spec §9).
 *
 * Phase 6 writes 'pending' briefings and supersedes prior pending rows on the
 * same surface (no stack of unread morning briefs). Promote/discard
 * transitions are Phase 8 (operator interaction) — not implemented here.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { BriefingSchema, type Briefing } from "./schema.js";

const MS_PER_DAY = 86_400_000;

export interface ProposedBriefingRow {
  briefingId: string;
  surface: string;
  generatedAt: string;
  status: string;
  expiresAt: string;
  s2ReportId: string | null;
  briefing: Briefing;
}

interface RawRow {
  briefing_id: string;
  surface: string;
  generated_at: string;
  status: string;
  expires_at: string;
  s2_report_id: string | null;
  briefing_json: string;
}

function rowToRecord(r: RawRow): ProposedBriefingRow {
  return {
    briefingId: r.briefing_id,
    surface: r.surface,
    generatedAt: r.generated_at,
    status: r.status,
    expiresAt: r.expires_at,
    s2ReportId: r.s2_report_id,
    // Parsed back through the schema so a corrupt row fails loudly here, not
    // deep in a consumer.
    briefing: BriefingSchema.parse(JSON.parse(r.briefing_json)),
  };
}

export interface InsertProposedBriefingOptions {
  /** S2 critic report id, when the briefing went through `submitReport`. */
  s2ReportId?: string | null;
  /** ISO expiry; defaults to `generated_at` + 24h. */
  expiresAt?: string;
}

/**
 * Persist a briefing as a 'pending' row. Any prior 'pending' row on the SAME
 * surface is marked 'superseded' and pointed at the new briefing — the
 * operator only ever has one live brief per surface (spec §9). Atomic.
 */
export function insertProposedBriefing(
  briefing: Briefing,
  options: InsertProposedBriefingOptions = {},
): void {
  const expiresAt =
    options.expiresAt ??
    new Date(
      new Date(briefing.generated_at).getTime() + MS_PER_DAY,
    ).toISOString();
  const db = getDatabase();

  writeWithRetry(() => {
    const tx = db.transaction(() => {
      // Insert the new briefing FIRST: `superseded_by_briefing_id` is a FK to
      // proposed_briefings(briefing_id), so the target row must exist before
      // any prior row can point at it.
      db.prepare(
        `INSERT INTO proposed_briefings
           (briefing_id, surface, generated_at, briefing_json, expires_at, s2_report_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        briefing.briefing_id,
        briefing.surface,
        briefing.generated_at,
        JSON.stringify(briefing),
        expiresAt,
        options.s2ReportId ?? null,
      );

      // Then supersede prior pending rows on this surface — excluding the row
      // just inserted (it is itself 'pending').
      db.prepare(
        `UPDATE proposed_briefings
            SET status = 'superseded', superseded_by_briefing_id = ?
          WHERE surface = ? AND status = 'pending' AND briefing_id != ?`,
      ).run(briefing.briefing_id, briefing.surface, briefing.briefing_id);
    });
    tx();
  });
}

/** Fetch one briefing by id, or null. */
export function getProposedBriefing(
  briefingId: string,
): ProposedBriefingRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT briefing_id, surface, generated_at, status, expires_at,
              s2_report_id, briefing_json
         FROM proposed_briefings WHERE briefing_id = ?`,
    )
    .get(briefingId) as RawRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * List 'pending' briefings, newest first. Optionally filtered to one surface.
 */
export function listPendingBriefings(
  surface?: Briefing["surface"],
): ProposedBriefingRow[] {
  const db = getDatabase();
  const rows = (
    surface
      ? db
          .prepare(
            `SELECT briefing_id, surface, generated_at, status, expires_at,
                    s2_report_id, briefing_json
               FROM proposed_briefings
              WHERE status = 'pending' AND surface = ?
              ORDER BY generated_at DESC`,
          )
          .all(surface)
      : db
          .prepare(
            `SELECT briefing_id, surface, generated_at, status, expires_at,
                    s2_report_id, briefing_json
               FROM proposed_briefings
              WHERE status = 'pending'
              ORDER BY generated_at DESC`,
          )
          .all()
  ) as RawRow[];
  return rows.map(rowToRecord);
}
