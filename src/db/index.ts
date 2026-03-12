/**
 * SQLite database singleton.
 *
 * Uses better-sqlite3 with WAL mode and performance pragmas.
 * Creates the data directory and runs schema.sql on first access.
 */

import { mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

let _db: Database.Database | null = null;

/**
 * Initialize the database at the given path.
 * Creates the directory if needed, enables WAL, applies schema.
 */
export function initDatabase(dbPath: string): Database.Database {
  if (_db) return _db;

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new BetterSqlite3(dbPath);

  // Performance pragmas
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -64000"); // 64MB
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  // Apply schema
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  _db.exec(schema);

  return _db;
}

/**
 * Get the database instance.
 * @throws if initDatabase() hasn't been called.
 */
export function getDatabase(): Database.Database {
  if (!_db)
    throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/**
 * Close the database connection.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
