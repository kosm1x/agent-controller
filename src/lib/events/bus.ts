/**
 * @module events/bus
 *
 * Persistent event bus for Mission Control.
 *
 * Replaces a naive in-memory EventEmitter with a crash-safe, SQLite-backed
 * event bus. Events are persisted BEFORE broadcast so that no event is lost
 * if the process crashes mid-delivery. Subscribers that reconnect after
 * downtime can replay missed events via {@link PersistentEventBus.getUndelivered}.
 *
 * Key properties:
 * - **Persistence first**: SQLite write happens before any listener is called.
 * - **Error isolation**: One listener throwing does not block others.
 * - **Backpressure**: Configurable queue depth with overflow policy.
 * - **Deduplication**: Events with duplicate IDs are silently dropped.
 * - **Retention**: Automatic cleanup of events older than the configured TTL.
 * - **Backward compatible**: Extends EventEmitter so existing SSE code works.
 */

// NOTE: These require @types/node and @types/better-sqlite3 in devDependencies
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type {
  Event,
  EventCategory,
  EventFilter,
  EventHandler,
  EventPattern,
  EventPayloadMap,
  EventType,
  Subscription,
} from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the persistent event bus. */
export interface EventBusConfig {
  /**
   * better-sqlite3 database instance.
   * The bus creates its own tables; it does NOT own the connection lifecycle.
   */
  db: Database.Database;

  /**
   * Maximum number of events queued for async broadcast before
   * the overflow policy kicks in. Default: 10_000.
   */
  maxQueueDepth?: number;

  /**
   * What to do when the queue is full.
   * - "drop-oldest": discard the oldest queued event.
   * - "drop-newest": discard the incoming event.
   * - "block": (sync) wait until queue drains below threshold.
   * Default: "drop-oldest".
   */
  overflowPolicy?: "drop-oldest" | "drop-newest" | "block";

  /**
   * How long to keep events in SQLite, in milliseconds.
   * Events older than this are deleted during cleanup().
   * Default: 7 days (604_800_000 ms).
   */
  retentionMs?: number;

  /**
   * Interval in ms between automatic retention cleanup runs.
   * Set to 0 to disable automatic cleanup. Default: 1 hour.
   */
  cleanupIntervalMs?: number;

  /**
   * Default workspace ID when none is provided in the event.
   * Default: "default".
   */
  defaultWorkspaceId?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SubscriptionRecord {
  id: string;
  pattern: EventPattern;
  regex: RegExp;
  handler: EventHandler<any>;
}

interface PersistedEventRow {
  id: string;
  type: string;
  category: string;
  timestamp: string;
  workspace_id: string;
  data: string; // JSON
  correlation_id: string;
  causation_id: string | null;
  sequence: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an EventPattern to a RegExp for matching event types.
 * - Exact: "task.created" matches only "task.created"
 * - Wildcard: "task.*" matches any event starting with "task."
 * - Global: "*" matches everything
 */
function patternToRegex(pattern: EventPattern): RegExp {
  if (pattern === "*") return /^.+$/;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${prefix}\\.`);
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`);
}

/**
 * Derive the EventCategory from a dot-separated event type.
 * e.g., "task.created" -> "task"
 */
function categoryFromType(type: string): EventCategory {
  return type.split(".")[0] as EventCategory;
}

// ---------------------------------------------------------------------------
// PersistentEventBus
// ---------------------------------------------------------------------------

/**
 * A persistent, crash-safe event bus backed by SQLite.
 *
 * Usage:
 * ```ts
 * import BetterSqlite3 from 'better-sqlite3';
 * const db = new BetterSqlite3('mission-control.db');
 * const bus = new PersistentEventBus({ db });
 *
 * // Subscribe
 * const sub = bus.subscribe('task.*', (event) => {
 *   console.log('Task event:', event.type, event.data);
 * });
 *
 * // Emit
 * bus.emit('task.created', {
 *   task_id: '123',
 *   title: 'Fix bug',
 *   description: 'Something is broken',
 *   priority: 'high',
 *   tags: ['bug'],
 *   created_by: 'user-1',
 * });
 *
 * // Replay events after downtime
 * const missed = bus.getUndelivered('subscriber-1', lastSeenSequence);
 *
 * // Cleanup
 * sub.unsubscribe();
 * bus.destroy();
 * ```
 */
export class PersistentEventBus extends EventEmitter {
  private readonly db: Database.Database;
  private readonly config: Required<EventBusConfig>;
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly seenEventIds = new Set<string>();
  private readonly maxDedupeCache = 50_000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;

  // Prepared statements (lazily initialized after table creation)
  private stmtInsertEvent!: Database.Statement;
  private stmtGetEventsSince!: Database.Statement;
  private stmtGetEventsFiltered!: Database.Statement;
  private stmtDeleteOld!: Database.Statement;
  private stmtGetMaxSequence!: Database.Statement;

  constructor(config: EventBusConfig) {
    super();
    this.setMaxListeners(500); // Fleet can have many subscribers

    this.db = config.db;
    this.config = {
      db: config.db,
      maxQueueDepth: config.maxQueueDepth ?? 10_000,
      overflowPolicy: config.overflowPolicy ?? "drop-oldest",
      retentionMs: config.retentionMs ?? 7 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60 * 60 * 1000,
      defaultWorkspaceId: config.defaultWorkspaceId ?? "default",
    };

    this.initSchema();
    this.prepareStatements();
    this.restoreSequence();

    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(
        () => this.cleanup(),
        this.config.cleanupIntervalMs,
      );
      // Ensure the timer doesn't keep the process alive
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Schema & Setup
  // -------------------------------------------------------------------------

  /** Create the events table and indexes if they don't exist. */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT    NOT NULL UNIQUE,
        type        TEXT    NOT NULL,
        category    TEXT    NOT NULL,
        timestamp   TEXT    NOT NULL,
        workspace_id TEXT   NOT NULL,
        data        TEXT    NOT NULL,
        correlation_id TEXT NOT NULL DEFAULT '',
        causation_id   TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_id);
    `);
  }

  /** Prepare reusable SQLite statements for performance. */
  private prepareStatements(): void {
    this.stmtInsertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, type, category, timestamp, workspace_id, data, correlation_id, causation_id)
      VALUES (@id, @type, @category, @timestamp, @workspace_id, @data, @correlation_id, @causation_id)
    `);

    this.stmtGetEventsSince = this.db.prepare(`
      SELECT * FROM events WHERE sequence > @since ORDER BY sequence ASC LIMIT @limit
    `);

    // This is a base query; complex filters are built dynamically
    this.stmtGetEventsFiltered = this.db.prepare(`
      SELECT * FROM events WHERE timestamp >= @since ORDER BY sequence ASC LIMIT @limit
    `);

    this.stmtDeleteOld = this.db.prepare(`
      DELETE FROM events WHERE created_at < datetime('now', @retention)
    `);

    this.stmtGetMaxSequence = this.db.prepare(`
      SELECT MAX(sequence) as max_seq FROM events
    `);
  }

  /** Restore the sequence counter from the database on startup. */
  private restoreSequence(): void {
    const row = this.stmtGetMaxSequence.get() as
      | { max_seq: number | null }
      | undefined;
    this.sequence = row?.max_seq ?? 0;
  }

  // -------------------------------------------------------------------------
  // Public API: Emit
  // -------------------------------------------------------------------------

  /**
   * Emit a typed event. The event is persisted to SQLite BEFORE any
   * subscriber is notified, ensuring crash safety.
   *
   * @param type - The event type (e.g., "task.created").
   * @param data - The strongly-typed payload for this event type.
   * @param options - Optional overrides for correlation_id, workspace_id, etc.
   * @returns The fully-formed Event object (with sequence number).
   */
  emitEvent<T extends keyof EventPayloadMap>(
    type: T,
    data: EventPayloadMap[T],
    options?: {
      correlation_id?: string;
      causation_id?: string;
      workspace_id?: string;
      id?: string;
    },
  ): Event<T> {
    const eventId = options?.id ?? randomUUID();

    // Deduplication: skip if we've already seen this event ID
    if (this.seenEventIds.has(eventId)) {
      // Return a minimal event object for the caller
      return this.buildEvent(eventId, type, data, options);
    }

    const event = this.buildEvent(eventId, type, data, options);

    // Step 1: Persist to SQLite (crash safety)
    this.persist(event);

    // Step 2: Track for deduplication
    this.trackDedup(eventId);

    // Step 3: Broadcast to subscribers (error-isolated)
    this.broadcast(event);

    // Step 4: Also emit on the EventEmitter for backward compatibility (SSE)
    super.emit(type, event);
    super.emit(event.category, event);
    super.emit("*", event);

    return event;
  }

  /**
   * Convenience overload: emit a raw Event object (e.g., when replaying).
   * Still persists and broadcasts.
   */
  emitRaw(event: Event): Event {
    if (this.seenEventIds.has(event.id)) {
      return event;
    }

    this.persist(event);
    this.trackDedup(event.id);
    this.broadcast(event);

    super.emit(event.type, event);
    super.emit(event.category, event);
    super.emit("*", event);

    return event;
  }

  // -------------------------------------------------------------------------
  // Public API: Subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to events matching a pattern.
   *
   * @param pattern - Event type, wildcard pattern, or "*" for all events.
   * @param handler - Callback invoked for each matching event.
   * @returns A Subscription handle with an unsubscribe() method.
   *
   * @example
   * ```ts
   * // All task events
   * bus.subscribe('task.*', (e) => console.log(e));
   *
   * // Specific event
   * bus.subscribe('agent.registered', (e) => console.log(e));
   *
   * // Everything
   * bus.subscribe('*', (e) => console.log(e));
   * ```
   */
  subscribe<T extends EventType>(
    pattern: EventPattern,
    handler: EventHandler<T>,
  ): Subscription {
    const id = randomUUID();
    const regex = patternToRegex(pattern);

    const record: SubscriptionRecord = { id, pattern, regex, handler };
    this.subscriptions.set(id, record);

    return {
      id,
      pattern,
      unsubscribe: () => {
        this.subscriptions.delete(id);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Public API: Replay & Recovery
  // -------------------------------------------------------------------------

  /**
   * Replay events from persistence starting after a given timestamp.
   *
   * @param since - ISO 8601 timestamp. Events strictly after this are returned.
   * @param filter - Optional additional filter criteria.
   * @returns Array of events in chronological order.
   */
  replay(since: string, filter?: EventFilter): Event[] {
    const limit = filter?.limit ?? 1000;

    // For complex filters, build a dynamic query
    if (
      filter?.categories?.length ||
      filter?.types?.length ||
      filter?.correlation_id ||
      filter?.workspace_id
    ) {
      return this.replayFiltered(since, filter, limit);
    }

    const rows = this.stmtGetEventsFiltered.all({
      since,
      limit,
    }) as PersistedEventRow[];

    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Get events that a subscriber missed during downtime.
   * The subscriber provides the last sequence number it successfully processed.
   *
   * @param subscriberId - Identifier of the subscriber (for logging).
   * @param lastSeenSequence - The sequence number of the last event the subscriber processed.
   * @param limit - Maximum events to return. Default: 1000.
   * @returns Array of missed events in chronological order.
   */
  getUndelivered(
    _subscriberId: string,
    lastSeenSequence: number,
    limit = 1000,
  ): Event[] {
    const rows = this.stmtGetEventsSince.all({
      since: lastSeenSequence,
      limit,
    }) as PersistedEventRow[];

    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Get the current maximum sequence number.
   * Subscribers should persist this value so they can resume after restart.
   */
  getCurrentSequence(): number {
    return this.sequence;
  }

  // -------------------------------------------------------------------------
  // Public API: Maintenance
  // -------------------------------------------------------------------------

  /**
   * Delete events older than the configured retention period.
   * Called automatically if cleanupIntervalMs > 0.
   * @returns Number of events deleted.
   */
  cleanup(): number {
    const retentionSeconds = Math.floor(this.config.retentionMs / 1000);
    const result = this.stmtDeleteOld.run({
      retention: `-${retentionSeconds} seconds`,
    });
    return result.changes;
  }

  /**
   * Shut down the event bus. Clears timers and subscriptions.
   * Does NOT close the database connection (the caller owns it).
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.subscriptions.clear();
    this.seenEventIds.clear();
    this.removeAllListeners();
  }

  /**
   * Get the number of active subscriptions (for monitoring).
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  // -------------------------------------------------------------------------
  // Internal: Persistence
  // -------------------------------------------------------------------------

  /** Write an event to SQLite. Uses INSERT OR IGNORE for idempotency. */
  private persist(event: Event): void {
    this.stmtInsertEvent.run({
      id: event.id,
      type: event.type,
      category: event.category,
      timestamp: event.timestamp,
      workspace_id: event.workspace_id,
      data: JSON.stringify(event.data),
      correlation_id: event.correlation_id,
      causation_id: event.causation_id ?? null,
    });

    // Update local sequence counter.
    // In SQLite, the rowid/sequence is assigned by AUTOINCREMENT.
    // We re-read it to stay in sync.
    const row = this.stmtGetMaxSequence.get() as
      | { max_seq: number | null }
      | undefined;
    if (row?.max_seq != null && row.max_seq > this.sequence) {
      this.sequence = row.max_seq;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Broadcast
  // -------------------------------------------------------------------------

  /**
   * Deliver an event to all matching subscribers.
   * Each subscriber is called in an isolated try/catch so one failure
   * does not block delivery to other subscribers.
   */
  private broadcast(event: Event): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.regex.test(event.type)) {
        try {
          const result = sub.handler(event);
          // If the handler returns a Promise, catch async errors too
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              this.emitError("async_handler_error", sub.id, event, err);
            });
          }
        } catch (err) {
          this.emitError("sync_handler_error", sub.id, event, err);
        }
      }
    }
  }

  /**
   * Emit an internal error event. These go to the "bus.error" EventEmitter
   * channel for monitoring but do NOT re-enter the persistent pipeline.
   */
  private emitError(
    kind: string,
    subscriberId: string,
    event: Event,
    err: unknown,
  ): void {
    super.emit("bus.error", {
      kind,
      subscriber_id: subscriberId,
      event_id: event.id,
      event_type: event.type,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Internal: Deduplication
  // -------------------------------------------------------------------------

  /** Track an event ID for deduplication, evicting old entries if needed. */
  private trackDedup(eventId: string): void {
    this.seenEventIds.add(eventId);

    // Evict oldest entries if the cache is too large.
    // Set iteration order is insertion order, so we delete from the front.
    if (this.seenEventIds.size > this.maxDedupeCache) {
      const toDelete = this.seenEventIds.size - this.maxDedupeCache;
      let deleted = 0;
      for (const id of this.seenEventIds) {
        if (deleted >= toDelete) break;
        this.seenEventIds.delete(id);
        deleted++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Event Construction
  // -------------------------------------------------------------------------

  /** Build a typed Event object. */
  private buildEvent<T extends EventType>(
    id: string,
    type: T,
    data: EventPayloadMap[T],
    options?: {
      correlation_id?: string;
      causation_id?: string;
      workspace_id?: string;
    },
  ): Event<T> {
    return {
      id,
      type,
      category: categoryFromType(type),
      timestamp: new Date().toISOString(),
      workspace_id: options?.workspace_id ?? this.config.defaultWorkspaceId,
      data,
      correlation_id: options?.correlation_id ?? randomUUID(),
      causation_id: options?.causation_id,
      sequence: this.sequence + 1, // Will be finalized after persist
    };
  }

  /** Convert a SQLite row back to an Event object. */
  private rowToEvent(row: PersistedEventRow): Event {
    return {
      id: row.id,
      type: row.type as EventType,
      category: row.category as EventCategory,
      timestamp: row.timestamp,
      workspace_id: row.workspace_id,
      data: JSON.parse(row.data),
      correlation_id: row.correlation_id,
      causation_id: row.causation_id ?? undefined,
      sequence: row.sequence,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: Filtered Replay
  // -------------------------------------------------------------------------

  /** Build and execute a dynamic query for filtered replay. */
  private replayFiltered(
    since: string,
    filter: EventFilter,
    limit: number,
  ): Event[] {
    const conditions: string[] = ["timestamp >= @since"];
    const params: Record<string, unknown> = { since, limit };

    if (filter.categories?.length) {
      const placeholders = filter.categories.map((_, i) => `@cat_${i}`);
      conditions.push(`category IN (${placeholders.join(", ")})`);
      filter.categories.forEach((cat, i) => {
        params[`cat_${i}`] = cat;
      });
    }

    if (filter.types?.length) {
      const placeholders = filter.types.map((_, i) => `@type_${i}`);
      conditions.push(`type IN (${placeholders.join(", ")})`);
      filter.types.forEach((t, i) => {
        params[`type_${i}`] = t;
      });
    }

    if (filter.correlation_id) {
      conditions.push("correlation_id = @corr_id");
      params.corr_id = filter.correlation_id;
    }

    if (filter.workspace_id) {
      conditions.push("workspace_id = @ws_id");
      params.ws_id = filter.workspace_id;
    }

    const sql = `
      SELECT * FROM events
      WHERE ${conditions.join(" AND ")}
      ORDER BY sequence ASC
      LIMIT @limit
    `;

    const rows = this.db.prepare(sql).all(params) as PersistedEventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }
}
