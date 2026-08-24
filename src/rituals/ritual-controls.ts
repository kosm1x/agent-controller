/**
 * Ritual controls — usability plan Phase 5.5/5.6.
 *
 *   ritual_controls  — per-ritual `paused` (code rituals; DB schedules use
 *                      scheduled_tasks.active) and `muted_until`; the row
 *                      id `*` is the global "silencio hasta <hora>".
 *   ritual_deferrals — pushes the delivery seam did NOT send (reading budget
 *                      hit, or muted) — folded into the next Morning Sync
 *                      prompt by `takeDeferredBlock`, then marked consumed.
 */

import { getDatabase } from "../db/index.js";
import { getSyncSurfaceScheduleId } from "../lib/v8-2/flags.js";

export const GLOBAL_MUTE_ID = "*";

/**
 * The Morning Sync is the deferral consumer and the exempt morning anchor.
 * Identity (R1 audit C3): the schedule ID the V8.2 sync-surfacing already
 * keys on (`V82_SYNC_SCHEDULE_ID`) when set; the name only as a fallback so
 * an unset env does not silently drop the exemption. Pinned by tests.
 */
export const MORNING_SYNC_NAME_RE = /morning sync/i;

export function isMorningSync(schedule: { schedule_id: string; name: string }): boolean {
  const id = getSyncSurfaceScheduleId();
  if (id) return schedule.schedule_id === id;
  return MORNING_SYNC_NAME_RE.test(schedule.name);
}

export function ensureRitualControlTables(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS ritual_controls (
      ritual_id   TEXT PRIMARY KEY,
      paused      INTEGER NOT NULL DEFAULT 0,
      muted_until TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ritual_deferrals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ritual_id   TEXT NOT NULL,
      task_id     TEXT,
      title       TEXT NOT NULL,
      text        TEXT NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT
    );
  `);
}

interface ControlRow {
  paused: number;
  muted_until: string | null;
}

function getControl(ritualId: string): ControlRow | undefined {
  return getDatabase()
    .prepare("SELECT paused, muted_until FROM ritual_controls WHERE ritual_id = ?")
    .get(ritualId) as ControlRow | undefined;
}

export function isRitualPaused(ritualId: string): boolean {
  try {
    ensureRitualControlTables();
    return (getControl(ritualId)?.paused ?? 0) === 1;
  } catch {
    return false; // a broken controls table must not stop rituals
  }
}

export function setRitualPaused(ritualId: string, paused: boolean): void {
  ensureRitualControlTables();
  getDatabase()
    .prepare(
      `INSERT INTO ritual_controls (ritual_id, paused, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(ritual_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
    )
    .run(ritualId, paused ? 1 : 0);
}

/** `until` is an ISO instant; null clears the mute. */
export function setMutedUntil(ritualId: string, until: Date | null): void {
  ensureRitualControlTables();
  getDatabase()
    .prepare(
      `INSERT INTO ritual_controls (ritual_id, muted_until, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(ritual_id) DO UPDATE SET muted_until = excluded.muted_until, updated_at = excluded.updated_at`,
    )
    .run(ritualId, until ? until.toISOString() : null);
}

/**
 * The active mute for a ritual (its own or the global one), as an ISO
 * instant, or null when not muted. Expired stamps count as not muted.
 */
export function activeMuteUntil(ritualId: string, now = new Date()): string | null {
  ensureRitualControlTables();
  const candidates = [getControl(ritualId)?.muted_until, getControl(GLOBAL_MUTE_ID)?.muted_until];
  let best: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (Date.parse(c) <= now.getTime()) continue;
    if (best === null || Date.parse(c) > Date.parse(best)) best = c;
  }
  return best;
}

/**
 * Store a push the seam did not send whole. `reason` "budget" | "muted" =
 * deferred (folded into the next delivered Morning Sync); "capped" = the
 * full text behind a truncated push (already consumed — never folded). The
 * row id is the phone handle: `/rituales completo <id>`.
 */
export function enqueueDeferral(
  ritualId: string,
  taskId: string | null,
  title: string,
  text: string,
  reason: "budget" | "muted" | "capped",
): number {
  ensureRitualControlTables();
  const r = getDatabase()
    .prepare(
      "INSERT INTO ritual_deferrals (ritual_id, task_id, title, text, reason, consumed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(ritualId, taskId, title, text, reason, reason === "capped" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null);
  return Number(r.lastInsertRowid);
}

export function getDeferral(id: number): DeferralRow | undefined {
  ensureRitualControlTables();
  return getDatabase()
    .prepare("SELECT id, ritual_id, task_id, title, text, reason, created_at FROM ritual_deferrals WHERE id = ?")
    .get(id) as DeferralRow | undefined;
}

export interface DeferralRow {
  id: number;
  ritual_id: string;
  task_id: string | null;
  title: string;
  text: string;
  reason: string;
  created_at: string;
}

/** Every unconsumed deferral, oldest first — nothing expires (R1 audit C3). */
export function pendingDeferrals(): DeferralRow[] {
  ensureRitualControlTables();
  return getDatabase()
    .prepare(
      `SELECT id, ritual_id, task_id, title, text, reason, created_at FROM ritual_deferrals
       WHERE consumed_at IS NULL ORDER BY id ASC`,
    )
    .all() as DeferralRow[];
}

export const HANDLE_RE = /\/rituales completo (\d+)/g;

/** Deferral ids whose handle appears in a delivered text. */
export function handlesIn(text: string): number[] {
  return [...new Set([...text.matchAll(HANDLE_RE)].map((m) => Number(m[1])))];
}

/**
 * Mark the deferrals whose handles the DELIVERED Morning Sync actually
 * carried as consumed (R3 audit W2: the sync's own prompt forbids names not
 * in the day-log, so a fold can be dropped by the model — consuming on
 * `sent > 0` alone would silently lose those). Unfolded rows re-list next
 * day and stay on `/rituales`.
 */
export function consumeDeferralIds(ids: number[]): number {
  if (ids.length === 0) return 0;
  ensureRitualControlTables();
  return getDatabase()
    .prepare(
      `UPDATE ritual_deferrals SET consumed_at = datetime('now') WHERE consumed_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .run(...ids).changes;
}

const DEFERRAL_TEXT_CAP = 1500;
const STALE_AFTER_HOURS = 36;
/** Oldest-first; the rest fold the next day (R3 audit W1: 35 rows / 40 KB after a 14-day sync outage). */
export const DEFERRED_BLOCK_MAX = 8;

export interface DeferredBlock {
  block: string;
  /** Ids included in the block. */
  ids: number[];
}

/**
 * Prompt block for the Morning Sync: the oldest DEFERRED_BLOCK_MAX
 * unconsumed deferrals. Nothing is marked here — consumption follows the
 * sync's DELIVERY and the handles it echoed. Rows older than 36 h are
 * labelled with their age, never dropped.
 */
export function deferredBlock(now = new Date()): DeferredBlock {
  const all = pendingDeferrals();
  if (all.length === 0) return { block: "", ids: [] };
  const rows = all.slice(0, DEFERRED_BLOCK_MAX);
  const more = all.length - rows.length;
  const body = rows
    .map((r) => {
      const text =
        r.text.length > DEFERRAL_TEXT_CAP
          ? `${r.text.slice(0, DEFERRAL_TEXT_CAP).trimEnd()}…`
          : r.text;
      const ageH = (now.getTime() - Date.parse(r.created_at + "Z")) / 3_600_000;
      const age = ageH > STALE_AFTER_HOURS ? ` — de hace ${Math.round(ageH / 24)} días` : "";
      return `### ${r.title} (${r.reason === "muted" ? "silenciado" : "presupuesto de lectura"}${age}) — completo: /rituales completo ${r.id}\n${text}`;
    })
    .join("\n\n");
  return {
    ids: rows.map((r) => r.id),
    block:
      `\n\nPASO EXTRA — DIFERIDOS (${rows.length}${more > 0 ? ` de ${all.length}` : ""}): estos mensajes no se enviaron por el presupuesto de lectura o un silencio. ` +
      `Este bloque es FUENTE AUTORIZADA igual que el day-log: sus nombres, proyectos y cifras existen — cítalos. ` +
      `Cierra con una sección "Diferido de ayer": UNA línea por cada uno (título + el dato clave) terminando con su comando "/rituales completo <id>" tal cual. ` +
      `Estas ${rows.length} líneas quedan FUERA del límite de longitud del briefing.` +
      (more > 0 ? ` (Hay ${more} más pendientes; se incluirán mañana o con /rituales.)` : "") +
      `\n\n` +
      body,
  };
}
