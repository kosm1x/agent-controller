/**
 * KB Backup — syncs jarvis_files to Supabase Postgres (address in `COMMIT_DB_URL`).
 *
 * Provides disaster recovery for Jarvis's knowledge base.
 * Push-only: SQLite → Postgres. Runs periodically or on-demand.
 */

import {
  listFilePaths,
  getFile,
  parseTagsSafe,
  upsertFile,
} from "./jarvis-fs.js";
import { errMsg } from "../lib/err-msg.js";

const COMMIT_DB_URL = "https://db.mycommit.net/rest/v1";

function getApiKey(): string | null {
  return process.env.COMMIT_DB_KEY ?? null;
}

// PostgREST rejects strings containing U+0000 with SQLSTATE 22P05
// ("unsupported Unicode escape sequence"), failing the WHOLE batch.
// NULs in KB content come from corrupted imports / accidental binary paste
// and carry no information, so stripping is non-destructive.
const NUL_RE = /\u0000/g;
/**
 * Strip U+0000 NUL bytes and return a clean string for PostgREST.
 *
 * better-sqlite3 returns a column by its SQLite *storage class*, not the
 * declared TypeScript type: a BLOB hydrates as a `Buffer` and a numeric value
 * as a `number`. `JarvisFile.content` is typed `string`, but a row whose text
 * had a NUL pasted in is stored with storage-class BLOB and comes back as a
 * Buffer — which has no `.replace`. The old `(s ?? "").replace()` only guarded
 * null/undefined, so that one row threw `TypeError: .replace is not a function`
 * and (being outside the batch try/catch) aborted the ENTIRE nightly backup —
 * 3+ days of silent backup failure from a single row. Coerce Buffer→utf8 and
 * any other non-string via String() before stripping. Exported for regression
 * coverage of the Buffer path.
 */
export function stripNulBytes(s: unknown): string {
  if (s === null || s === undefined) return "";
  const str = Buffer.isBuffer(s)
    ? s.toString("utf8")
    : typeof s === "string"
      ? s
      : String(s);
  return str.replace(NUL_RE, "");
}

interface BackupResult {
  pushed: number;
  unchanged: number;
  errors: number;
  duration_ms: number;
}

/**
 * Sync all jarvis_files to the remote Postgres backup.
 * Upserts by path — latest updated_at wins.
 */
export async function syncKbToRemote(): Promise<BackupResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[kb-backup] COMMIT_DB_KEY not configured, skipping sync");
    return { pushed: 0, unchanged: 0, errors: 0, duration_ms: 0 };
  }

  const start = Date.now();
  // List paths only: listFiles' length(content) read every content page in one
  // synchronous call, and on a cold page cache that blocked the event loop for
  // 8-12 s (prometheus-alert-notifier timed out). Content is read per row below.
  // Order is path ASC (was priority, path); irrelevant, the remote upserts by path.
  const paths = listFilePaths();
  let pushed = 0;
  let unchanged = 0;
  let errors = 0;

  // Batch upsert in chunks of 20
  const BATCH_SIZE = 20;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const rows = [];

    for (const path of batch) {
      // Per-row guard: a single malformed row must never abort the whole
      // backup. It did for 3+ days — a BLOB-storage-class content row threw in
      // stripNulBytes, outside the (fetch-only) try/catch below, killing the
      // sync for all 621 healthy rows. Skip + count the bad row instead.
      try {
        const file = getFile(path);
        if (!file) continue;

        rows.push({
          path,
          title: stripNulBytes(file.title),
          content: stripNulBytes(file.content),
          tags: JSON.stringify(parseTagsSafe(file.tags)),
          qualifier: file.qualifier,
          priority: file.priority,
          updated_at: file.updated_at,
          synced_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          `[kb-backup] Skipping unserializable row ${path}:`,
          errMsg(err),
        );
        errors++;
      }
    }

    if (rows.length === 0) continue;

    try {
      const res = await fetch(`${COMMIT_DB_URL}/jarvis_kb_backup`, {
        method: "POST",
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        pushed += rows.length;
      } else {
        const text = await res.text().catch(() => "");
        console.warn(
          `[kb-backup] Batch upsert failed (${res.status}): ${text.slice(0, 200)}`,
        );
        errors += rows.length;
      }
    } catch (err) {
      console.warn(
        `[kb-backup] Batch error:`,
        errMsg(err),
      );
      errors += rows.length;
    }
  }

  const duration = Date.now() - start;
  console.log(
    `[kb-backup] Sync complete: ${pushed} pushed, ${unchanged} unchanged, ${errors} errors (${duration}ms)`,
  );

  return { pushed, unchanged, errors, duration_ms: duration };
}

/**
 * Delete the ONE backup row whose path equals `path` (an `eq.` filter on the
 * path column, the value URL-encoded; never a pattern or a range). The nightly
 * push never rewrites the row of a note that no longer exists locally, so this
 * is the only way such a row leaves the table. The server returns the path of
 * every row it deleted (that column only, never note text): true only when that
 * is exactly one row with exactly this path. An empty path sends nothing.
 */
export async function deleteBackupRow(path: string): Promise<boolean> {
  if (path.trim() === "") return false;
  const apiKey = getApiKey();
  if (!apiKey) return false;
  try {
    const res = await fetch(
      `${COMMIT_DB_URL}/jarvis_kb_backup?path=eq.${encodeURIComponent(path)}&select=path`,
      {
        method: "DELETE",
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          Prefer: "return=representation",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as unknown;
    return (
      Array.isArray(rows) &&
      rows.length === 1 &&
      (rows[0] as { path?: unknown } | null)?.path === path
    );
  } catch {
    return false;
  }
}

/**
 * Restore jarvis_files from remote Postgres backup.
 * Pulls all rows and upserts into local SQLite.
 * Use after a VPS rebuild or DB reset.
 */
export async function restoreKbFromRemote(): Promise<{
  restored: number;
  errors: number;
}> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { restored: 0, errors: 0 };
  }

  try {
    const res = await fetch(
      `${COMMIT_DB_URL}/jarvis_kb_backup?select=path,title,content,tags,qualifier,priority,updated_at&order=path`,
      {
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!res.ok) {
      console.error(`[kb-backup] Restore failed: ${res.status}`);
      return { restored: 0, errors: 1 };
    }

    const rows = (await res.json()) as Array<{
      path: string;
      title: string;
      content: string;
      tags: string;
      qualifier: string;
      priority: number;
    }>;

    let restored = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const tags = JSON.parse(row.tags ?? "[]");
        upsertFile(
          row.path,
          row.title,
          row.content,
          tags,
          row.qualifier,
          row.priority,
        );
        restored++;
      } catch {
        errors++;
      }
    }

    console.log(
      `[kb-backup] Restore complete: ${restored} files, ${errors} errors`,
    );
    return { restored, errors };
  } catch (err) {
    console.error(
      `[kb-backup] Restore error:`,
      errMsg(err),
    );
    return { restored: 0, errors: 1 };
  }
}
