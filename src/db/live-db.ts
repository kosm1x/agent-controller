/**
 * The live-database predicate shared by every writer that targets a resource
 * belonging to exactly one database: the disk KB mirror (jarvis-fs.ts, after
 * the 2026-10-04 incident) and the Google Drive copy (drive-sync.ts, queue
 * 4a). Its own module because jarvis-fs.ts imports drive-sync.ts.
 */

import { realpathSync } from "node:fs";
import { getDatabase } from "./index.js";

/** The one database that owns the default KB mirror and the Drive copy. */
export const LIVE_DB_PATH = "/root/claude/mission-control/data/mc.db";

/** True only when `dbFile` and `liveDbPath` realpath to the same file. */
export function isLiveDatabaseFile(dbFile: string, liveDbPath: string): boolean {
  if (!dbFile) return false; // "" = :memory: / temp db
  try {
    return realpathSync.native(dbFile) === realpathSync.native(liveDbPath);
  } catch {
    return false; // either side missing
  }
}

/** Absolute file of the open main db as SQLite resolved it; "" if none. */
export function openDbFile(): string {
  try {
    const rows = getDatabase().pragma("database_list") as Array<{
      name: string;
      file: string;
    }>;
    return rows.find((r) => r.name === "main")?.file ?? "";
  } catch {
    return ""; // no db open → not the live db
  }
}
