/**
 * KB Backup — syncs jarvis_files to Supabase Postgres (db.mycommit.net).
 *
 * Provides disaster recovery for Jarvis's knowledge base.
 * Push-only: SQLite → Postgres. Runs periodically or on-demand.
 */

import { listFiles, getFile } from "./jarvis-fs.js";

const COMMIT_DB_URL = "https://db.mycommit.net/rest/v1";

function getApiKey(): string | null {
  return process.env.COMMIT_DB_KEY ?? null;
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
  const files = listFiles({});
  let pushed = 0;
  let unchanged = 0;
  let errors = 0;

  // Batch upsert in chunks of 20
  const BATCH_SIZE = 20;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const rows = [];

    for (const meta of batch) {
      const file = getFile(meta.path);
      if (!file) continue;

      rows.push({
        path: meta.path,
        title: meta.title,
        content: file.content,
        tags: JSON.stringify(meta.tags),
        qualifier: meta.qualifier,
        priority: meta.priority,
        updated_at: meta.updated_at,
        synced_at: new Date().toISOString(),
      });
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
        err instanceof Error ? err.message : err,
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

  const { upsertFile } = await import("./jarvis-fs.js");

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
      err instanceof Error ? err.message : err,
    );
    return { restored: 0, errors: 1 };
  }
}
