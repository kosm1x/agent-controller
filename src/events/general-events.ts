/**
 * General-events middle layer — Conway Pattern 1 substrate (v7.7 Spine 4).
 *
 * Between abstract knowledge (NorthStar, MEMORY.md) and episodic chunks
 * (tasks, conversations) sits the "general events" tier: ~30-50 records that
 * abstract a span of activity into one retrieval target ("Phase β sprint",
 * "Hindsight rehab arc", "v7.7 Spine 3 — S5 skills"). V8.1's morning-brief
 * proactive scan retrieves at THIS level, then descends to episodic via the
 * explicit links table.
 *
 * This module is the WRITE path only — schema, create/update/archive/
 * supersede, episodic linking. Retrieval lives in `./retrieval.ts`
 * (Bundle 2). Per the Spine 4 anti-mission: no morning-brief, no LLM
 * auto-discovery — this is the queryable layer, full stop.
 *
 * Spec: docs/planning/v8-capability-1-spec.md §5.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { embed, serializeEmbedding } from "../memory/embeddings.js";

export type GeneralEventLevel = "lifetime" | "general" | "episodic-cluster";
export type EpisodicKind =
  | "task"
  | "conversation"
  | "memory_item"
  | "recall_audit"
  | "cost_ledger"
  | "report";
export type CreatedBy = "manual" | "seed" | "auto-discovery";
export type LinkReason = "manual" | "auto-themed" | "co-occurrence";

export interface GeneralEvent {
  id: number;
  event_id: string;
  level: GeneralEventLevel;
  title: string;
  summary: string;
  goal_context_id: string | null;
  themes: string[];
  start_at: string;
  end_at: string | null;
  episodic_count: number;
  created_by: CreatedBy;
  created_at: string;
  updated_at: string;
  superseded_by: number | null;
  archived_at: string | null;
}

export interface EpisodicLink {
  id: number;
  event_id: string;
  episodic_kind: EpisodicKind;
  episodic_ref: string;
  linked_at: string;
  link_reason: LinkReason | null;
}

export interface CreateGeneralEventInput {
  event_id: string;
  level: GeneralEventLevel;
  title: string;
  summary: string;
  goal_context_id?: string | null;
  themes?: string[];
  /** ISO timestamp — when this period began. Required. */
  start_at: string;
  /** ISO timestamp — when it ended. Omit/null for an ongoing event. */
  end_at?: string | null;
  created_by?: CreatedBy;
}

export interface UpdateGeneralEventPatch {
  title?: string;
  summary?: string;
  goal_context_id?: string | null;
  themes?: string[];
  end_at?: string | null;
}

export interface ListGeneralEventsOptions {
  level?: GeneralEventLevel;
  goal_context_id?: string;
  /** Include archived rows. Default false. */
  includeArchived?: boolean;
}

/** Thrown for validation / not-found / duplicate-id conditions. */
export class GeneralEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneralEventError";
  }
}

const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

interface GeneralEventRow {
  id: number;
  event_id: string;
  level: GeneralEventLevel;
  title: string;
  summary: string;
  goal_context_id: string | null;
  themes: string;
  start_at: string;
  end_at: string | null;
  episodic_count: number;
  created_by: CreatedBy;
  created_at: string;
  updated_at: string;
  superseded_by: number | null;
  archived_at: string | null;
}

function rowToEvent(row: GeneralEventRow): GeneralEvent {
  let themes: string[];
  try {
    const parsed = JSON.parse(row.themes) as unknown;
    themes = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    themes = [];
  }
  return {
    id: row.id,
    event_id: row.event_id,
    level: row.level,
    title: row.title,
    summary: row.summary,
    goal_context_id: row.goal_context_id,
    themes,
    start_at: row.start_at,
    end_at: row.end_at,
    episodic_count: row.episodic_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    superseded_by: row.superseded_by,
    archived_at: row.archived_at,
  };
}

/**
 * Embed an event's retrieval text. Summary carries the abstracted narrative;
 * title is prepended so a terse title still steers retrieval. Returns a BLOB
 * Buffer ready for the `summary_embedding` column, or null if the embedding
 * service is unavailable (graceful degradation — the event still stores, it
 * just won't surface via vector retrieval until re-embedded).
 */
async function embedEventText(
  title: string,
  summary: string,
): Promise<Buffer | null> {
  const vec = await embed(`${title}\n\n${summary}`);
  return vec ? serializeEmbedding(vec) : null;
}

/**
 * Create a general event. Embeds `title + summary` on write.
 *
 * @throws GeneralEventError on a malformed or duplicate `event_id`, an empty
 *   title/summary, or an `end_at` earlier than `start_at`.
 */
export async function createGeneralEvent(
  input: CreateGeneralEventInput,
): Promise<GeneralEvent> {
  const eventId = input.event_id.trim();
  if (!EVENT_ID_RE.test(eventId)) {
    throw new GeneralEventError(
      `invalid event_id "${input.event_id}" — expected kebab-case slug (3-64 chars, a-z0-9-)`,
    );
  }
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title) throw new GeneralEventError("title is required");
  if (!summary) throw new GeneralEventError("summary is required");
  if (!input.start_at) throw new GeneralEventError("start_at is required");
  if (input.end_at && input.end_at < input.start_at) {
    throw new GeneralEventError(
      `end_at (${input.end_at}) is earlier than start_at (${input.start_at})`,
    );
  }

  const db = getDatabase();
  if (
    db.prepare("SELECT 1 FROM general_events WHERE event_id = ?").get(eventId)
  ) {
    throw new GeneralEventError(`event_id "${eventId}" already exists`);
  }

  // Embed BEFORE the write transaction — embed() is a network call and must
  // not hold a write lock. A null embedding is tolerated (degraded retrieval).
  const embedding = await embedEventText(title, summary);
  const themes = JSON.stringify(input.themes ?? []);

  try {
    writeWithRetry(() => {
      db.prepare(
        `INSERT INTO general_events (
         event_id, level, title, summary, goal_context_id, themes,
         start_at, end_at, summary_embedding, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        input.level,
        title,
        summary,
        input.goal_context_id ?? null,
        themes,
        input.start_at,
        input.end_at ?? null,
        embedding,
        input.created_by ?? "manual",
      );
    });
  } catch (err) {
    // The SELECT pre-check above is a TOCTOU window: a concurrent insert of
    // the same event_id between SELECT and INSERT trips the UNIQUE constraint.
    // Re-surface it as a GeneralEventError so the friendly-error guarantee
    // holds on the race path too (R1-I2 fold).
    if (
      err instanceof Error &&
      "code" in err &&
      typeof err.code === "string" &&
      err.code.startsWith("SQLITE_CONSTRAINT")
    ) {
      throw new GeneralEventError(`event_id "${eventId}" already exists`);
    }
    throw err;
  }

  return getGeneralEvent(eventId)!;
}

/** Fetch one event by `event_id`, or null if absent. */
export function getGeneralEvent(eventId: string): GeneralEvent | null {
  const row = getDatabase()
    .prepare("SELECT * FROM general_events WHERE event_id = ?")
    .get(eventId) as GeneralEventRow | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * List events, newest-started first. Archived rows excluded unless
 * `includeArchived` is set.
 */
export function listGeneralEvents(
  options: ListGeneralEventsOptions = {},
): GeneralEvent[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  if (options.level) {
    clauses.push("level = ?");
    params.push(options.level);
  }
  if (options.goal_context_id) {
    clauses.push("goal_context_id = ?");
    params.push(options.goal_context_id);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(`SELECT * FROM general_events ${where} ORDER BY start_at DESC`)
    .all(...params) as GeneralEventRow[];
  return rows.map(rowToEvent);
}

/**
 * Patch an event in place. Re-embeds only when `title` or `summary` changes.
 * Always bumps `updated_at`.
 *
 * @throws GeneralEventError if the event does not exist, or the resulting
 *   end_at would precede start_at.
 */
export async function updateGeneralEvent(
  eventId: string,
  patch: UpdateGeneralEventPatch,
): Promise<GeneralEvent> {
  const existing = getGeneralEvent(eventId);
  if (!existing) {
    throw new GeneralEventError(`event_id "${eventId}" not found`);
  }

  const nextTitle = patch.title?.trim() ?? existing.title;
  const nextSummary = patch.summary?.trim() ?? existing.summary;
  if (!nextTitle) throw new GeneralEventError("title cannot be emptied");
  if (!nextSummary) throw new GeneralEventError("summary cannot be emptied");
  const nextEndAt = patch.end_at !== undefined ? patch.end_at : existing.end_at;
  if (nextEndAt && nextEndAt < existing.start_at) {
    throw new GeneralEventError(
      `end_at (${nextEndAt}) is earlier than start_at (${existing.start_at})`,
    );
  }

  const textChanged =
    nextTitle !== existing.title || nextSummary !== existing.summary;
  // Re-embed outside the write transaction (network call).
  const embedding = textChanged
    ? await embedEventText(nextTitle, nextSummary)
    : undefined;

  const db = getDatabase();
  writeWithRetry(() => {
    const sets: string[] = [
      "title = ?",
      "summary = ?",
      "goal_context_id = ?",
      "themes = ?",
      "end_at = ?",
      "updated_at = datetime('now')",
    ];
    const params: unknown[] = [
      nextTitle,
      nextSummary,
      patch.goal_context_id !== undefined
        ? patch.goal_context_id
        : existing.goal_context_id,
      JSON.stringify(patch.themes ?? existing.themes),
      nextEndAt,
    ];
    if (embedding !== undefined) {
      sets.push("summary_embedding = ?");
      params.push(embedding);
    }
    params.push(eventId);
    db.prepare(
      `UPDATE general_events SET ${sets.join(", ")} WHERE event_id = ?`,
    ).run(...params);
  });

  return getGeneralEvent(eventId)!;
}

/**
 * Archive an event — sets `archived_at`, dropping it from default retrieval.
 * Idempotent: archiving an already-archived event is a no-op (the original
 * `archived_at` is preserved). The `reason` is appended to `themes` as an
 * `archived:<reason>` tag so the audit trail survives without a new column.
 *
 * @throws GeneralEventError if the event does not exist.
 */
export function archiveGeneralEvent(eventId: string, reason?: string): void {
  const existing = getGeneralEvent(eventId);
  if (!existing) {
    throw new GeneralEventError(`event_id "${eventId}" not found`);
  }
  if (existing.archived_at) return; // already archived — no-op

  const themes = reason
    ? JSON.stringify([...existing.themes, `archived:${reason}`])
    : JSON.stringify(existing.themes);

  const db = getDatabase();
  writeWithRetry(() => {
    db.prepare(
      `UPDATE general_events
         SET archived_at = datetime('now'), themes = ?, updated_at = datetime('now')
       WHERE event_id = ?`,
    ).run(themes, eventId);
  });
}

/**
 * Supersede `oldEventId` with `newEventId`: point the old event's
 * `superseded_by` at the new event's row id and archive the old event in one
 * transaction. Use when a general event is re-abstracted (e.g. a sprint
 * post-mortem replaces a coarser arc-level event).
 *
 * @throws GeneralEventError if either event is missing, or they are the same.
 */
export function supersedeGeneralEvent(
  oldEventId: string,
  newEventId: string,
): void {
  if (oldEventId === newEventId) {
    throw new GeneralEventError("an event cannot supersede itself");
  }
  const oldEvent = getGeneralEvent(oldEventId);
  if (!oldEvent) {
    throw new GeneralEventError(`event_id "${oldEventId}" not found`);
  }
  const newEvent = getGeneralEvent(newEventId);
  if (!newEvent) {
    throw new GeneralEventError(`event_id "${newEventId}" not found`);
  }

  const db = getDatabase();
  writeWithRetry(() => {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE general_events
           SET superseded_by = ?, archived_at = COALESCE(archived_at, datetime('now')),
               updated_at = datetime('now')
         WHERE event_id = ?`,
      ).run(newEvent.id, oldEventId);
    });
    tx();
  });
}

/**
 * Link an episodic source row to a general event (a descent edge). Idempotent
 * — re-linking the same `(event_id, kind, ref)` triple is a no-op via the
 * UNIQUE index. `episodic_count` is recomputed from the links table after
 * every link/unlink so it can never drift from reality.
 *
 * @throws GeneralEventError if the event does not exist.
 */
export function linkEpisodic(
  eventId: string,
  kind: EpisodicKind,
  ref: string,
  reason: LinkReason = "manual",
): void {
  if (!getGeneralEvent(eventId)) {
    throw new GeneralEventError(`event_id "${eventId}" not found`);
  }
  if (!ref.trim()) {
    throw new GeneralEventError("episodic_ref is required");
  }

  const db = getDatabase();
  writeWithRetry(() => {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO general_event_episodic_links
           (event_id, episodic_kind, episodic_ref, link_reason)
         VALUES (?, ?, ?, ?)`,
      ).run(eventId, kind, ref.trim(), reason);
      recomputeEpisodicCount(eventId);
    });
    tx();
  });
}

/**
 * Remove a descent edge. No-op if the *link* does not exist. Recomputes
 * `episodic_count`. Validates the event itself, mirroring `linkEpisodic` —
 * an unknown `eventId` throws rather than silently no-op'ing (R1-W1 fold).
 *
 * @throws GeneralEventError if the event does not exist, or `ref` is empty.
 */
export function unlinkEpisodic(
  eventId: string,
  kind: EpisodicKind,
  ref: string,
): void {
  if (!getGeneralEvent(eventId)) {
    throw new GeneralEventError(`event_id "${eventId}" not found`);
  }
  if (!ref.trim()) {
    throw new GeneralEventError("episodic_ref is required");
  }
  const db = getDatabase();
  writeWithRetry(() => {
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM general_event_episodic_links
         WHERE event_id = ? AND episodic_kind = ? AND episodic_ref = ?`,
      ).run(eventId, kind, ref.trim());
      recomputeEpisodicCount(eventId);
    });
    tx();
  });
}

/**
 * Recompute `episodic_count` from the links table. Caller holds the tx.
 *
 * `episodic_count` is a denormalized cache with exactly ONE maintainer:
 * link/unlink in this module. Any future writer to
 * `general_event_episodic_links` (an auto-discovery cron, a raw `mc-ctl db`
 * insert) MUST call this, or the stored count drifts with no reconciliation
 * path. Bundle 2 retrieval should treat `episodic_count` as advisory and, if
 * exactness matters, derive the count live from the links table (R1-W4 fold).
 */
function recomputeEpisodicCount(eventId: string): void {
  getDatabase()
    .prepare(
      `UPDATE general_events
         SET episodic_count = (
           SELECT COUNT(*) FROM general_event_episodic_links WHERE event_id = ?
         )
       WHERE event_id = ?`,
    )
    .run(eventId, eventId);
}

/** All descent edges for an event, oldest link first. */
export function getEpisodicLinks(eventId: string): EpisodicLink[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM general_event_episodic_links
       WHERE event_id = ? ORDER BY linked_at ASC, id ASC`,
    )
    .all(eventId) as EpisodicLink[];
}
