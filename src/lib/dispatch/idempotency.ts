/**
 * @module dispatch/idempotency
 *
 * Idempotent task dispatch via content-addressable deduplication.
 *
 * When Mission Control dispatches a task, it generates a deterministic key
 * from the task content (NOT timestamps or random IDs). If the same logical
 * task is dispatched again within the TTL window, the cached result is
 * returned instead of re-dispatching.
 *
 * This prevents duplicate work when:
 * - A client retries after a timeout (but the first dispatch succeeded).
 * - Multiple triggers fire for the same underlying event.
 * - An agent reconnects and re-requests its current assignment.
 *
 * Storage: SQLite table `dispatch_idempotency`.
 * Key generation: SHA-256 of (taskId + prompt content).
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cached dispatch result. */
export interface IdempotencyRecord {
  /** The idempotency key (SHA-256 hex digest). */
  key: string;
  /** The cached result (JSON-serializable). */
  result: unknown;
  /** When this record was created (ISO 8601). */
  created_at: string;
  /** When this record expires (ISO 8601). */
  expires_at: string;
}

/** Options for the IdempotencyStore. */
export interface IdempotencyStoreConfig {
  /**
   * better-sqlite3 database instance.
   * The store creates its own table; it does NOT own the connection lifecycle.
   */
  db: Database.Database;

  /**
   * Default time-to-live for cached results, in milliseconds.
   * After this period, the same key can trigger a fresh dispatch.
   * Default: 3_600_000 (1 hour).
   */
  defaultTtlMs?: number;

  /**
   * Interval in ms between automatic cleanup runs.
   * Set to 0 to disable. Default: 300_000 (5 minutes).
   */
  cleanupIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// IdempotencyStore
// ---------------------------------------------------------------------------

/**
 * Content-addressable idempotency cache for task dispatch.
 *
 * Usage:
 * ```ts
 * import BetterSqlite3 from 'better-sqlite3';
 * const db = new BetterSqlite3('mission-control.db');
 * const store = new IdempotencyStore({ db });
 *
 * const key = store.generateKey(taskId, prompt);
 * const cached = store.check(key);
 * if (cached) {
 *   return cached.result; // Already dispatched
 * }
 *
 * // ... perform dispatch ...
 *
 * store.store(key, dispatchResult);
 * ```
 */
export class IdempotencyStore {
  private readonly db: Database.Database;
  private readonly defaultTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Prepared statements
  private stmtInsert!: Database.Statement;
  private stmtCheck!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtCleanup!: Database.Statement;
  private stmtCount!: Database.Statement;

  constructor(config: IdempotencyStoreConfig) {
    this.db = config.db;
    this.defaultTtlMs = config.defaultTtlMs ?? 3_600_000;

    this.initSchema();
    this.prepareStatements();

    const cleanupInterval = config.cleanupIntervalMs ?? 300_000;
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  /** Create the idempotency table if it doesn't exist. */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_idempotency (
        key         TEXT PRIMARY KEY,
        result      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_expires
        ON dispatch_idempotency(expires_at);
    `);
  }

  /** Prepare reusable SQLite statements. */
  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT OR REPLACE INTO dispatch_idempotency (key, result, created_at, expires_at)
      VALUES (@key, @result, @created_at, @expires_at)
    `);

    this.stmtCheck = this.db.prepare(`
      SELECT key, result, created_at, expires_at
      FROM dispatch_idempotency
      WHERE key = @key AND expires_at > datetime('now')
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM dispatch_idempotency WHERE key = @key
    `);

    this.stmtCleanup = this.db.prepare(`
      DELETE FROM dispatch_idempotency WHERE expires_at <= datetime('now')
    `);

    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM dispatch_idempotency
      WHERE expires_at > datetime('now')
    `);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate a deterministic idempotency key from task content.
   *
   * The key is a SHA-256 hash of the task ID concatenated with the prompt.
   * This means the same task with the same prompt always produces the same
   * key, regardless of when or how many times it's dispatched.
   *
   * @param taskId - The task identifier.
   * @param prompt - The task prompt / description content.
   * @returns A 64-character hex string (SHA-256 digest).
   */
  generateKey(taskId: string, prompt: string): string {
    const hash = createHash("sha256");
    hash.update(taskId);
    hash.update("\0"); // Null byte separator to prevent ambiguous concatenation
    hash.update(prompt);
    return hash.digest("hex");
  }

  /**
   * Check if a result is already cached for the given key.
   *
   * Only returns a result if:
   * 1. The key exists in the store.
   * 2. The entry has not expired.
   *
   * @param key - The idempotency key (from generateKey).
   * @returns The cached record, or null if no valid cache entry exists.
   */
  check(key: string): IdempotencyRecord | null {
    const row = this.stmtCheck.get({ key }) as
      | { key: string; result: string; created_at: string; expires_at: string }
      | undefined;

    if (!row) return null;

    try {
      return {
        key: row.key,
        result: JSON.parse(row.result),
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    } catch {
      // Corrupted JSON — evict the entry
      this.stmtDelete.run({ key });
      return null;
    }
  }

  /**
   * Store a dispatch result for future deduplication.
   *
   * If an entry with the same key already exists, it is overwritten
   * (INSERT OR REPLACE). This is intentional: re-storing with a fresh TTL
   * extends the deduplication window.
   *
   * @param key - The idempotency key (from generateKey).
   * @param result - The dispatch result to cache (must be JSON-serializable).
   * @param ttlMs - Optional TTL override in milliseconds. Defaults to the store's defaultTtlMs.
   */
  store(key: string, result: unknown, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);

    this.stmtInsert.run({
      key,
      result: JSON.stringify(result),
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  }

  /**
   * Remove expired entries from the store.
   * Called automatically if cleanupIntervalMs > 0.
   *
   * @returns Number of entries deleted.
   */
  cleanup(): number {
    const result = this.stmtCleanup.run();
    return result.changes;
  }

  /**
   * Manually invalidate a specific key.
   * Useful when a task is explicitly cancelled or modified.
   *
   * @param key - The idempotency key to remove.
   * @returns true if an entry was removed, false if the key wasn't found.
   */
  invalidate(key: string): boolean {
    const result = this.stmtDelete.run({ key });
    return result.changes > 0;
  }

  /**
   * Get the number of active (non-expired) entries.
   * Useful for monitoring cache size.
   */
  get activeCount(): number {
    const row = this.stmtCount.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Shut down the store. Clears the cleanup timer.
   * Does NOT close the database connection (the caller owns it).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
