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
  /** When the briefing was delivered to the operator (Phase 8), or null. */
  deliveredAt: string | null;
  briefing: Briefing;
}

interface RawRow {
  briefing_id: string;
  surface: string;
  generated_at: string;
  status: string;
  expires_at: string;
  s2_report_id: string | null;
  delivered_at: string | null;
  briefing_json: string;
}

/** The column list every briefing SELECT shares. */
const ROW_COLS =
  "briefing_id, surface, generated_at, status, expires_at, s2_report_id, delivered_at, briefing_json";

function rowToRecord(r: RawRow): ProposedBriefingRow {
  return {
    briefingId: r.briefing_id,
    surface: r.surface,
    generatedAt: r.generated_at,
    status: r.status,
    expiresAt: r.expires_at,
    s2ReportId: r.s2_report_id,
    deliveredAt: r.delivered_at,
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
    .prepare(`SELECT ${ROW_COLS} FROM proposed_briefings WHERE briefing_id = ?`)
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
            `SELECT ${ROW_COLS} FROM proposed_briefings
              WHERE status = 'pending' AND surface = ?
              ORDER BY generated_at DESC`,
          )
          .all(surface)
      : db
          .prepare(
            `SELECT ${ROW_COLS} FROM proposed_briefings
              WHERE status = 'pending'
              ORDER BY generated_at DESC`,
          )
          .all()
  ) as RawRow[];
  return rows.map(rowToRecord);
}

/**
 * Mark a briefing delivered to the operator (Phase 8). Idempotent: a row that
 * already has `delivered_at` keeps its original timestamp.
 */
export function markBriefingDelivered(briefingId: string): void {
  writeWithRetry(() => {
    getDatabase()
      .prepare(
        `UPDATE proposed_briefings SET delivered_at = datetime('now')
          WHERE briefing_id = ? AND delivered_at IS NULL`,
      )
      .run(briefingId);
  });
}

/**
 * The briefing eligible for promote/discard on the operator's next reply: the
 * most-recently-delivered row still `pending`. A briefing that was generated
 * but never delivered (delivery flag off) is excluded — `delivered_at IS NOT
 * NULL` is the gate. Returns null when nothing is awaiting interaction.
 */
export function getResolvablePendingBriefing(): ProposedBriefingRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT ${ROW_COLS} FROM proposed_briefings
        WHERE status = 'pending' AND delivered_at IS NOT NULL
        ORDER BY delivered_at DESC LIMIT 1`,
    )
    .get() as RawRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** Transition a still-`pending` briefing to a terminal status. The
 *  `status='pending'` guard makes a double-resolve a no-op. Returns true when
 *  this call performed the transition. */
export function transitionBriefing(
  briefingId: string,
  to: "promoted" | "discarded" | "expired",
): boolean {
  let changed = false;
  writeWithRetry(() => {
    const stampCol =
      to === "promoted"
        ? "promoted_at"
        : to === "discarded"
          ? "discarded_at"
          : null;
    const sql = stampCol
      ? `UPDATE proposed_briefings
            SET status = ?, ${stampCol} = datetime('now')
          WHERE briefing_id = ? AND status = 'pending'`
      : `UPDATE proposed_briefings SET status = ?
          WHERE briefing_id = ? AND status = 'pending'`;
    const info = getDatabase().prepare(sql).run(to, briefingId);
    changed = info.changes > 0;
  });
  return changed;
}

/**
 * Expire delivered-but-unresolved briefings whose `expires_at` has passed
 * (spec §14 Q6 — a brief the operator never engaged with within the window
 * EXPIRES). `promote.ts` also expires lazily on the next operator reply; this
 * sweep covers the never-replied case so `status='expired'` is not undercounted
 * in the §13 metrics. Returns the number expired.
 *
 * `expires_at` is an ISO-8601 UTC string (`...Z`); `strftime` here produces the
 * same fixed-width ISO shape, so the `<` is a correct chronological compare
 * (lexicographic == chronological for fixed-width ISO).
 */
export function expireStalePendingBriefings(): number {
  let count = 0;
  writeWithRetry(() => {
    const info = getDatabase()
      .prepare(
        `UPDATE proposed_briefings SET status = 'expired'
          WHERE status = 'pending'
            AND delivered_at IS NOT NULL
            AND expires_at < strftime('%Y-%m-%dT%H:%M:%S.000Z','now')`,
      )
      .run();
    count = info.changes;
  });
  return count;
}

/**
 * Subjects of judgments from briefings the operator DISCARDED in the last
 * `withinDays` days — fed to the §10 judgment prompt so the reflector does not
 * re-surface a signal the operator already rejected (Phase 6 wired this as
 * `[]`; Phase 8 supplies the real data).
 */
export function getRecentlyDiscardedSubjects(withinDays = 7): string[] {
  const rows = getDatabase()
    .prepare(
      `SELECT briefing_json FROM proposed_briefings
        WHERE status = 'discarded'
          AND discarded_at > datetime('now', ?)`,
    )
    .all(`-${withinDays} days`) as { briefing_json: string }[];
  const subjects = new Set<string>();
  for (const r of rows) {
    try {
      const parsed = BriefingSchema.parse(JSON.parse(r.briefing_json));
      for (const j of parsed.judgments) subjects.add(j.subject);
    } catch {
      // A corrupt discarded row must not break briefing construction.
    }
  }
  return [...subjects];
}
