/**
 * reflection_followups — self-recheck ledger (V8.2 Phase 0, spec §5 item 2).
 *
 * A forward-looking judgment ("X is at risk of slipping further") schedules a
 * future audit point instead of being fire-and-forget. V8.2 §13 writes
 * `context_ref='judgment:<id>'`; V8.3 §12 writes `context_ref='decision:<id>'`.
 * A daily sweep in the morning-surface trigger fires due rows.
 *
 * DISPATCH BY PREFIX, NOT KIND. Both V8.2 and V8.3 use
 * `checkpoint_kind='verify_resolution'`, so the consumer is distinguished by the
 * `context_ref` prefix ('judgment' / 'decision'), not the kind. Handlers are
 * registered per prefix; a row whose prefix has no registered handler is left
 * UNFIRED (idempotent — the next sweep sees it again) so a consumer added in a
 * later phase still receives rows written before it existed.
 *
 * Phase 0 ships the table + sweep wired and tested; no producer writes rows yet
 * (V8.2 §13 / V8.3 §12 are the first producers), so in production the sweep is a
 * no-op until those land.
 */

import Database from "better-sqlite3";
import { getDatabase } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("briefing:reflection-followups");

export type CheckpointKind = "verify_resolution" | "verify_prediction";

export interface ReflectionFollowupRow {
  id: number;
  fire_after: string;
  checkpoint_kind: CheckpointKind;
  context_ref: string;
  fired_at: string | null;
  created_at: string;
}

export interface NewReflectionFollowup {
  /** ISO timestamp; the sweep fires the row once `now >= fire_after`. */
  fireAfter: string;
  checkpointKind: CheckpointKind;
  /** Typed reference: 'judgment:<id>' (V8.2) or 'decision:<id>' (V8.3). */
  contextRef: string;
  /** Defaults to now. */
  createdAt?: string;
}

/** Insert a pending followup. Returns the new row id. */
export function insertReflectionFollowup(
  followup: NewReflectionFollowup,
  db: Database.Database = getDatabase(),
): number {
  const createdAt = followup.createdAt ?? new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO reflection_followups (fire_after, checkpoint_kind, context_ref, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      followup.fireAfter,
      followup.checkpointKind,
      followup.contextRef,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

/** Due = not yet fired AND `fire_after <= now`. Oldest-due first. */
export function getDueReflectionFollowups(
  nowIso: string,
  db: Database.Database = getDatabase(),
): ReflectionFollowupRow[] {
  return db
    .prepare(
      `SELECT id, fire_after, checkpoint_kind, context_ref, fired_at, created_at
         FROM reflection_followups
        WHERE fired_at IS NULL AND fire_after <= ?
        ORDER BY fire_after ASC`,
    )
    .all(nowIso) as ReflectionFollowupRow[];
}

/** Mark a row fired. Idempotent: a row already fired is never re-fired because
 *  `getDueReflectionFollowups` filters `fired_at IS NULL`. */
export function markReflectionFollowupFired(
  id: number,
  firedAtIso: string,
  db: Database.Database = getDatabase(),
): void {
  db.prepare(
    "UPDATE reflection_followups SET fired_at = ? WHERE id = ? AND fired_at IS NULL",
  ).run(firedAtIso, id);
}

// ── handler registry (keyed by context_ref prefix) ───────────────────────────
export type FollowupHandler = (
  row: ReflectionFollowupRow,
  db: Database.Database,
) => void | Promise<void>;

const handlers = new Map<string, FollowupHandler>();

/** Register the consumer for a `context_ref` prefix (e.g. 'judgment', 'decision'). */
export function registerFollowupHandler(
  prefix: string,
  handler: FollowupHandler,
): void {
  handlers.set(prefix, handler);
}

/** Test-only: drop all registered handlers. */
export function resetFollowupHandlersForTests(): void {
  handlers.clear();
}

/** The prefix of a `context_ref` ('judgment:123' → 'judgment'). */
export function contextRefPrefix(contextRef: string): string {
  const idx = contextRef.indexOf(":");
  return idx === -1 ? contextRef : contextRef.slice(0, idx);
}

export interface SweepResult {
  due: number;
  fired: number;
  /** Due rows with no registered handler for their prefix (left unfired). */
  skipped: number;
  /** Due rows whose handler threw (left unfired for the next sweep). */
  failed: number;
}

/**
 * Fire every due followup whose `context_ref` prefix has a registered handler.
 * Empty-handler-safe: with no handlers registered (Phase 0 production), every
 * due row is `skipped` and left unfired. A handled row is marked fired only on
 * handler success, so retries are automatic and re-firing is impossible.
 */
export async function sweepDueReflectionFollowups(
  nowIso: string = new Date().toISOString(),
  db: Database.Database = getDatabase(),
): Promise<SweepResult> {
  const due = getDueReflectionFollowups(nowIso, db);
  let fired = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    const handler = handlers.get(contextRefPrefix(row.context_ref));
    if (!handler) {
      skipped++;
      continue;
    }
    try {
      await handler(row, db);
      // Stamp with the sweep's own `nowIso` so the parameter is a pure clock
      // injection (a back-dated sweep stamps a back-dated fired_at, not wall time).
      markReflectionFollowupFired(row.id, nowIso, db);
      fired++;
    } catch (err) {
      failed++;
      log.error(
        { err, followupId: row.id, contextRef: row.context_ref },
        "reflection followup handler threw — left unfired for retry",
      );
    }
  }

  if (due.length > 0) {
    log.info(
      { due: due.length, fired, skipped, failed },
      "reflection followup sweep",
    );
  }
  return { due: due.length, fired, skipped, failed };
}
