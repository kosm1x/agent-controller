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
import { seedDirectives } from "./jarvis-fs.js";
import { ensureTuningTables } from "../tuning/schema.js";
import { ensureIntelTables } from "./intel-schema.js";
import { ensureVideoTables } from "./video-schema.js";
import { activateBestVariant } from "../tuning/activation.js";

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
  _db.pragma("busy_timeout = 1000"); // Short: surface contention fast, retry at app level
  _db.pragma("foreign_keys = ON");

  // Apply schema
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  _db.exec(schema);

  // Additive migrations (safe to re-run)
  const skillCols = _db.prepare("PRAGMA table_info(skills)").all() as Array<{
    name: string;
  }>;
  if (!skillCols.some((c) => c.name === "last_used")) {
    _db.exec("ALTER TABLE skills ADD COLUMN last_used TEXT");
  }

  // Cost ledger for budget enforcement (v2.21)
  _db.exec(`CREATE TABLE IF NOT EXISTS cost_ledger (
    id                INTEGER PRIMARY KEY,
    run_id            TEXT NOT NULL,
    task_id           TEXT NOT NULL,
    agent_type        TEXT NOT NULL,
    model             TEXT NOT NULL DEFAULT 'unknown',
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0.0,
    created_at        TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cost_ledger_created ON cost_ledger(created_at)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cost_ledger_task ON cost_ledger(task_id)",
  );
  // C1 fix (queue #7 audit): partial UNIQUE on run_id for hindsight rows so
  // the cost-pull ritual can use INSERT OR IGNORE atomically. Scoping to
  // agent_type='hindsight' avoids any conflict with existing dispatcher-
  // written rows whose run_id uniqueness has not been historically enforced.
  _db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_ledger_hindsight_run_id ON cost_ledger(run_id) WHERE agent_type = 'hindsight'",
  );

  // v8 S4: cache breakdown for cache-hit ratio observability
  const ledgerCols = _db
    .prepare("PRAGMA table_info(cost_ledger)")
    .all() as Array<{ name: string }>;
  if (!ledgerCols.some((c) => c.name === "cache_read_tokens")) {
    _db.exec(
      "ALTER TABLE cost_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!ledgerCols.some((c) => c.name === "cache_creation_tokens")) {
    _db.exec(
      "ALTER TABLE cost_ledger ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0",
    );
  }

  // v8 S4 follow-up: recall utility audit (was_used instrumentation)
  // Logs every recall call with snippets; matcher fills was_used/task_id at
  // turn end so we can answer "is recall actually useful?" with data.
  _db.exec(`CREATE TABLE IF NOT EXISTS recall_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    bank              TEXT NOT NULL,
    query             TEXT NOT NULL,
    source            TEXT NOT NULL,
    result_count      INTEGER NOT NULL DEFAULT 0,
    result_snippets   TEXT NOT NULL DEFAULT '[]',
    latency_ms        INTEGER,
    was_used          INTEGER,
    used_count        INTEGER,
    task_id           TEXT,
    checked_at        TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_recall_audit_created ON recall_audit(created_at DESC)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_recall_audit_unmatched ON recall_audit(was_used, created_at) WHERE was_used IS NULL",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_recall_audit_task ON recall_audit(task_id)",
  );

  // 2026-04-29 Session 117: recall-side outcome filter introduces post-recall
  // drops. result_count = kept count (what the agent saw). excluded_count
  // captures filter activity for utility-rate audits. Additive migration.
  // 2026-04-30 Ship B: dual-signal was_used matching (verbatim OR token-
  // overlap). match_type ∈ {verbatim, token-overlap, none}. overlap_score
  // ∈ [0,1] = best overlap fraction across snippets (1.0 for verbatim).
  const recallAuditCols = _db
    .prepare("PRAGMA table_info(recall_audit)")
    .all() as Array<{ name: string }>;
  if (!recallAuditCols.some((c) => c.name === "excluded_count")) {
    _db.exec(
      "ALTER TABLE recall_audit ADD COLUMN excluded_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!recallAuditCols.some((c) => c.name === "match_type")) {
    _db.exec("ALTER TABLE recall_audit ADD COLUMN match_type TEXT");
  }
  if (!recallAuditCols.some((c) => c.name === "overlap_score")) {
    _db.exec("ALTER TABLE recall_audit ADD COLUMN overlap_score REAL");
  }
  // 2026-05-07 queue #7 part 2: per-recall distribution of outcome tags
  // (success / concerns / failed / unknown counts) persisted as JSON so
  // ratio queries don't have to re-parse snippets. Additive — null on old rows.
  if (!recallAuditCols.some((c) => c.name === "outcome_breakdown")) {
    _db.exec("ALTER TABLE recall_audit ADD COLUMN outcome_breakdown TEXT");
  }
  // 2026-05-07 queue #8: top_k_ids — stable Hindsight memory IDs returned by
  // the recall call. JSON array. Lets per-memory utility analysis cross-
  // reference recall_audit rows against retain history without snippet
  // matching. Populated on the hindsight path; null on sqlite paths (no
  // stable per-row IDs upstream of FTS5).
  if (!recallAuditCols.some((c) => c.name === "top_k_ids")) {
    _db.exec("ALTER TABLE recall_audit ADD COLUMN top_k_ids TEXT");
  }

  // v4.0 S1: composite indexes for query performance
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conversations_bank_created ON conversations(bank, created_at DESC)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_outcomes_task_id ON task_outcomes(task_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_outcomes_runner_success ON task_outcomes(ran_on, success)",
  );

  // S5: Add model_tier column to task_outcomes (additive migration)
  try {
    _db.exec(
      "ALTER TABLE task_outcomes ADD COLUMN model_tier TEXT DEFAULT NULL",
    );
  } catch {
    /* column already exists */
  }
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_outcomes_feedback ON task_outcomes(created_at, feedback_signal, ran_on, model_tier)",
  );

  // v4.0 S3: FTS5 full-text search + embedding vectors
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
      content, content='conversations', content_rowid='id'
    )
  `);
  // Triggers for FTS5 sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  // Incremental FTS5 backfill — only rows not yet indexed (avoids full table scan on every startup)
  _db.exec(`
    INSERT OR IGNORE INTO conversations_fts(rowid, content)
    SELECT id, content FROM conversations
    WHERE id > COALESCE((SELECT MAX(rowid) FROM conversations_fts), 0)
  `);
  // Embedding vectors table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
      embedding       BLOB NOT NULL
    )
  `);

  // Self-tuning tables (v2.27)
  // v5.0: Jarvis internal file system — persistent knowledge base
  _db.exec(`CREATE TABLE IF NOT EXISTS jarvis_files (
    id          TEXT PRIMARY KEY,
    path        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    tags        TEXT DEFAULT '[]',
    qualifier   TEXT DEFAULT 'reference' CHECK(qualifier IN ('always-read','enforce','conditional','reference','workspace')),
    condition   TEXT,
    priority    INTEGER DEFAULT 50,
    related_to  TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jarvis_files_qualifier ON jarvis_files(qualifier)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jarvis_files_priority ON jarvis_files(priority)",
  );
  // user_edit_time — distinct from updated_at which is bumped by any write (including sync).
  // Only real user edits (file_write/file_edit/jarvis_file_update) bump this.
  try {
    _db.exec("ALTER TABLE jarvis_files ADD COLUMN user_edit_time TEXT");
  } catch {
    /* column already exists */
  }

  // 2026-05-07: FTS5 index on jarvis_files. Before this, searchFiles() used
  // a `LIKE %query%` substring match — failed on multi-word queries because
  // it required the literal phrase ("uncharted OOH" missed because the title
  // is "México Uncharted — OOH Intelligence" with an em-dash). FTS5 with
  // tokenizer='unicode61 remove_diacritics 2' tokenizes properly and supports
  // AND-of-tokens via MATCH. External-content table avoids data duplication.
  //
  // VACUUM caveat (audit Critical 1): jarvis_files uses a TEXT primary key,
  // so SQLite assigns an implicit integer rowid. VACUUM may reassign rowids
  // and silently desync this external-content FTS index. If VACUUM is ever
  // run, follow it with:
  //   INSERT INTO jarvis_files_fts(jarvis_files_fts) VALUES('rebuild')
  // We don't VACUUM anywhere in this codebase today, but the constraint is
  // here for whoever adds it later.
  _db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS jarvis_files_fts USING fts5(
    title,
    content,
    path UNINDEXED,
    content='jarvis_files',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  )`);
  _db.exec(`CREATE TRIGGER IF NOT EXISTS jarvis_files_ai AFTER INSERT ON jarvis_files BEGIN
    INSERT INTO jarvis_files_fts(rowid, title, content, path) VALUES (new.rowid, new.title, new.content, new.path);
  END`);
  _db.exec(`CREATE TRIGGER IF NOT EXISTS jarvis_files_ad AFTER DELETE ON jarvis_files BEGIN
    INSERT INTO jarvis_files_fts(jarvis_files_fts, rowid, title, content, path) VALUES('delete', old.rowid, old.title, old.content, old.path);
  END`);
  _db.exec(`CREATE TRIGGER IF NOT EXISTS jarvis_files_au AFTER UPDATE ON jarvis_files BEGIN
    INSERT INTO jarvis_files_fts(jarvis_files_fts, rowid, title, content, path) VALUES('delete', old.rowid, old.title, old.content, old.path);
    INSERT INTO jarvis_files_fts(rowid, title, content, path) VALUES (new.rowid, new.title, new.content, new.path);
  END`);
  // Backfill: rebuild the FTS index when it doesn't match the source table.
  // The naive "rebuild if empty" check fails on the first boot after this
  // migration ships, because seedDirectives() (called below) had already
  // populated the FTS via triggers — making the index look "non-empty" but
  // out of sync with the 1000+ rows that were upserted before the triggers
  // existed. Triggering on count mismatch is the correct invariant.
  const ftsCount =
    (
      _db.prepare("SELECT COUNT(*) AS n FROM jarvis_files_fts").get() as
        | { n: number }
        | undefined
    )?.n ?? 0;
  const filesCount =
    (
      _db.prepare("SELECT COUNT(*) AS n FROM jarvis_files").get() as
        | { n: number }
        | undefined
    )?.n ?? 0;
  if (ftsCount !== filesCount) {
    _db.exec(
      "INSERT INTO jarvis_files_fts(jarvis_files_fts) VALUES('rebuild')",
    );
  }

  // v7.3 Phase 2: SEO telemetry snapshots (PSI + GSC time-series)
  _db.exec(`CREATE TABLE IF NOT EXISTS seo_telemetry_snapshots (
    id                 INTEGER PRIMARY KEY,
    url                TEXT NOT NULL,
    captured_at        TEXT DEFAULT (datetime('now')),
    psi_lcp_ms         INTEGER,
    psi_inp_ms         INTEGER,
    psi_cls            REAL,
    psi_perf_score     INTEGER,
    psi_seo_score      INTEGER,
    gsc_clicks_28d     INTEGER,
    gsc_impressions_28d INTEGER,
    gsc_ctr_28d        REAL,
    gsc_top_queries    TEXT,
    raw                TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_seo_telemetry_url ON seo_telemetry_snapshots(url, captured_at DESC)",
  );

  // v7.3 Phase 3: AI-overview presence tracking (time-series per query)
  _db.exec(`CREATE TABLE IF NOT EXISTS ai_overview_tracking (
    id           INTEGER PRIMARY KEY,
    query        TEXT NOT NULL,
    captured_at  TEXT DEFAULT (datetime('now')),
    present      INTEGER NOT NULL CHECK(present IN (0,1)),
    sources      TEXT,
    serp_top     TEXT,
    fetch_status TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_aio_query ON ai_overview_tracking(query, captured_at DESC)",
  );

  // NorthStar ↔ COMMIT sync journal — lets LWW distinguish "never existed" from "was deleted".
  _db.exec(`CREATE TABLE IF NOT EXISTS northstar_sync_state (
    commit_id              TEXT PRIMARY KEY,
    kind                   TEXT NOT NULL CHECK(kind IN ('vision','goal','objective','task')),
    local_path             TEXT NOT NULL,
    last_commit_edited_at  TEXT,
    last_local_edit_time   TEXT,
    last_sync_at           TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_nss_kind ON northstar_sync_state(kind)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_nss_path ON northstar_sync_state(local_path)",
  );

  // SG4: Safeguard state — generic key-value for safeguard enforcement
  _db.exec(`CREATE TABLE IF NOT EXISTS safeguard_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // v5.0 S5b: Knowledge maps for Prometheus
  _db.exec(`CREATE TABLE IF NOT EXISTS knowledge_maps (
    id          TEXT PRIMARY KEY,
    topic       TEXT NOT NULL,
    node_count  INTEGER DEFAULT 0,
    max_depth   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(`CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id          TEXT PRIMARY KEY,
    map_id      TEXT NOT NULL REFERENCES knowledge_maps(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('concept','pattern','gotcha')),
    summary     TEXT NOT NULL,
    depth       INTEGER NOT NULL DEFAULT 0,
    parent_id   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec("CREATE INDEX IF NOT EXISTS idx_kn_map ON knowledge_nodes(map_id)");
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_kn_parent ON knowledge_nodes(parent_id)",
  );

  // v5.0 S5c: Research provenance tracking for Prometheus
  _db.exec(`CREATE TABLE IF NOT EXISTS task_provenance (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      TEXT NOT NULL,
    goal_id      TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    url          TEXT,
    query        TEXT,
    status       TEXT NOT NULL DEFAULT 'unverified'
                 CHECK(status IN ('verified','inferred','unverified')),
    content_hash TEXT,
    snippet      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_provenance_task ON task_provenance(task_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_provenance_goal ON task_provenance(goal_id)",
  );

  // Prometheus snapshot/resume
  _db.exec(`CREATE TABLE IF NOT EXISTS prometheus_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          TEXT NOT NULL,
    goal_graph       TEXT NOT NULL,
    goal_results     TEXT NOT NULL,
    execution_state  TEXT NOT NULL,
    task_description TEXT NOT NULL,
    tool_names       TEXT,
    config           TEXT,
    exit_reason      TEXT NOT NULL,
    created_at       TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_prom_snap_task ON prometheus_snapshots(task_id, created_at DESC)",
  );

  // v6.5 M1: Temporal knowledge graph — entity-relationship triples with validity windows
  _db.exec(`CREATE TABLE IF NOT EXISTS knowledge_triples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject     TEXT NOT NULL,
    predicate   TEXT NOT NULL,
    object      TEXT NOT NULL,
    confidence  REAL DEFAULT 1.0,
    valid_from  TEXT DEFAULT (datetime('now')),
    valid_to    TEXT,
    source      TEXT DEFAULT 'agent',
    task_id     TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_kt_subject ON knowledge_triples(subject)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_kt_pred ON knowledge_triples(predicate)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_kt_valid ON knowledge_triples(valid_from, valid_to)",
  );

  // v7.7 Spine 1 (S2 substrate): self-audit before reporting.
  // Every report tool output that flows through submitReport() is persisted
  // here with its critic verdict + cost breakdown for the V8-VISION §3-S2
  // activation gate (zero "Audited?" cycles).
  _db.exec(`CREATE TABLE IF NOT EXISTS reports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id         TEXT UNIQUE NOT NULL,
    surface           TEXT NOT NULL,
    task_id           TEXT,
    started_at        TEXT NOT NULL,
    produced_at       TEXT NOT NULL,
    report_json       TEXT NOT NULL,
    critic_verdict    TEXT NOT NULL CHECK (critic_verdict IN ('pass','fail_returned_anyway','skipped_allowlist')),
    critic_retries    INTEGER NOT NULL DEFAULT 0,
    critic_cost_usd   REAL,
    producer_cost_usd REAL
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reports_surface ON reports(surface)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reports_critic_verdict ON reports(critic_verdict)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reports_produced ON reports(produced_at DESC)",
  );

  // v7.7 Spine 2 (S3 substrate): out-of-band drift detector.
  // Three tables: drift_signals (registry), drift_alerts (history),
  // baseline_history (audit trail of baseline evolution). See
  // docs/planning/v8-substrate-s3-spec.md §5/§6/§8 for schemas.
  _db.exec(`CREATE TABLE IF NOT EXISTS drift_signals (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_name                TEXT NOT NULL UNIQUE,
    signal_kind                TEXT NOT NULL,
    source_substrate           TEXT NOT NULL,
    baseline_query             TEXT NOT NULL,
    baseline_value_json        TEXT NOT NULL,
    tolerance_json             TEXT NOT NULL,
    cadence                    TEXT NOT NULL CHECK (cadence IN ('hourly','every_4h','nightly','weekly','on_event')),
    alert_priority             TEXT NOT NULL CHECK (alert_priority IN ('P0','P1','P2')),
    enabled                    INTEGER NOT NULL DEFAULT 1,
    established_at             TEXT NOT NULL,
    established_by             TEXT NOT NULL,
    notes                      TEXT,
    last_evaluated_at          TEXT,
    last_observed_value_json   TEXT,
    last_alert_id              INTEGER
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drift_signals_cadence ON drift_signals(cadence) WHERE enabled = 1",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drift_signals_priority ON drift_signals(alert_priority) WHERE enabled = 1",
  );

  // NOTE for next maintainer (R1-I4 fold, Spine 2 Bundle 2):
  //   - delivery_status: Bundle 2 does NOT mutate this. Alerts surface in
  //     every morning brief while resolution_at IS NULL. delivery_status
  //     stays 'pending' until Bundle 3's suppressAlert API lands. So
  //     `pending` ≠ undelivered (it just means: not yet resolved or
  //     suppressed). The active-alerts query filters on resolution_at, not
  //     delivery_status.
  //   - signal_id: deliberately no `REFERENCES drift_signals(id)` clause —
  //     orphaned alerts (signal deleted) are rendered with a placeholder
  //     name by delivery.ts's LEFT JOIN + COALESCE (R1-W3 fold). Adding the
  //     FK is a Bundle 3+ option; see `S3-W3-fk-and-cascade` in queue.
  _db.exec(`CREATE TABLE IF NOT EXISTS drift_alerts (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id                  INTEGER NOT NULL,
    triggered_at               TEXT NOT NULL,
    observed_value_json        TEXT NOT NULL,
    baseline_value_json        TEXT NOT NULL,
    deviation_kind             TEXT NOT NULL CHECK (deviation_kind IN ('above','below','absent','changed','query_failure','correlated_burst')),
    severity                   TEXT NOT NULL CHECK (severity IN ('P0','P1','P2')),
    delivery_status            TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','delivered','suppressed','expired')),
    delivered_in_brief_id      INTEGER,
    acknowledged_at            TEXT,
    acknowledged_by            TEXT,
    resolution_kind            TEXT CHECK (resolution_kind IN ('auto_resolved','operator_acknowledged','escalated','false_positive','superseded')),
    resolution_at              TEXT,
    resolution_notes           TEXT,
    bundle_id                  INTEGER
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drift_alerts_active ON drift_alerts(triggered_at) WHERE resolution_at IS NULL",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drift_alerts_signal ON drift_alerts(signal_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drift_alerts_bundle ON drift_alerts(bundle_id) WHERE bundle_id IS NOT NULL",
  );

  _db.exec(`CREATE TABLE IF NOT EXISTS baseline_history (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_name                TEXT NOT NULL,
    baseline_value_json        TEXT NOT NULL,
    established_at             TEXT NOT NULL,
    established_by             TEXT NOT NULL,
    retired_at                 TEXT,
    retired_reason             TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_baseline_history_signal ON baseline_history(signal_name)",
  );

  // Seed Jarvis file system on first boot
  seedDirectives();

  ensureTuningTables();
  ensureIntelTables(_db);
  ensureVideoTables(_db);

  // Activate best variant from archive (v2.28 — HyperAgents pattern)
  activateBestVariant();

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
 * Dim-4 R3 fix: reconcile tasks orphaned by a non-graceful shutdown.
 *
 * Graceful SIGTERM/SIGINT already marks running/pending/queued as failed
 * (see src/index.ts shutdown handler). SIGKILL / OOM / hard reboot skips
 * that path entirely — rows stay stuck forever. reactions/manager catches
 * 'running' tasks after 15 minutes, but 'pending'/'queued' rows never had
 * started_at set and slip past that check.
 *
 * Returns the list of reconciled task IDs so the caller can emit
 * `task.failed` events once the event bus + reaction manager + messaging
 * router are ready. Idempotent — safe to call on every startup. The error
 * message preserves the original status string so forensic review can
 * distinguish mid-run deaths from queued-when-killed cases.
 *
 * Dim-4 round-2 C-RES-6 fix: previously this returned only a count, which
 * meant orphaned interactive user tasks were silently flipped to failed
 * with no retry, no reaction, and no user-visible notification. Returning
 * the IDs lets the caller fire `task.failed` through the event bus so the
 * normal reaction-engine / user-notification pipeline runs.
 */
export function reconcileOrphanedTasks(
  db: Database.Database = getDatabase(),
): string[] {
  // Read-then-update, not UPDATE-returning because better-sqlite3's RETURNING
  // support is inconsistent across versions. Single transaction keeps the
  // id-list and the status-flip atomic so a concurrent write can't sneak a
  // row in between.
  const reconciled = db.transaction((): string[] => {
    const rows = db
      .prepare(
        `SELECT task_id FROM tasks WHERE status IN ('running','pending','queued')`,
      )
      .all() as Array<{ task_id: string }>;
    if (rows.length === 0) return [];
    db.prepare(
      `UPDATE tasks SET status = 'failed',
         error = 'Orphaned across non-graceful restart — task was ' || status || ' when service died',
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE status IN ('running','pending','queued')`,
    ).run();
    return rows.map((r) => r.task_id);
  })();
  return reconciled;
}

/**
 * Close the database connection with a final WAL checkpoint.
 */
export function closeDatabase(): void {
  if (_db) {
    try {
      _db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Best-effort — non-fatal
    }
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Write retry with jitter (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

const WRITE_MAX_RETRIES = 10;
const WRITE_RETRY_MIN_MS = 20;
const WRITE_RETRY_MAX_MS = 150;
const CHECKPOINT_EVERY_N = 100;

let _writeCount = 0;

/**
 * Execute a synchronous DB write with jitter retry on SQLITE_BUSY.
 *
 * better-sqlite3's built-in busy_timeout uses deterministic sleep which
 * causes convoy effects under concurrent writes. This wrapper:
 * - Catches SQLITE_BUSY / "database is locked" errors
 * - Retries with random jitter (20-150ms) to break convoy patterns
 * - Periodic PASSIVE WAL checkpoint every 100 writes
 *
 * Use for high-contention callers (event bus, outcome tracker, memory).
 * Sequential callers (task creation, rituals) can use bare .run().
 */
export function writeWithRetry<T>(fn: () => T): T {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
    try {
      const result = fn();
      _writeCount++;
      if (_writeCount % CHECKPOINT_EVERY_N === 0) {
        try {
          _db?.pragma("wal_checkpoint(PASSIVE)");
        } catch {
          // Best-effort checkpoint — non-fatal
        }
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
        lastErr = err instanceof Error ? err : new Error(msg);
        if (attempt < WRITE_MAX_RETRIES - 1) {
          // Random jitter breaks convoy pattern
          const jitter = Math.round(
            WRITE_RETRY_MIN_MS +
              Math.random() * (WRITE_RETRY_MAX_MS - WRITE_RETRY_MIN_MS),
          );
          // Atomics.wait on a SharedArrayBuffer: non-busy synchronous sleep
          // that doesn't block the event loop like a spin-wait does
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, jitter);
        }
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("database is locked after max retries");
}
