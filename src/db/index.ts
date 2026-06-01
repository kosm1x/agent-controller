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

  // v7.7 Spine 6 (Conway Pattern 3): the named recall mode this recall ran
  // under — coherence | correspondence | unfiltered. NULL on rows written
  // before this column landed. The CHECK is permitted on ADD COLUMN
  // because existing rows take NULL and the predicate admits NULL. The
  // weekly correspondence-audit drift signal reads this column.
  if (!recallAuditCols.some((c) => c.name === "mode")) {
    _db.exec(
      "ALTER TABLE recall_audit ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('coherence','correspondence','unfiltered'))",
    );
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

  // v7.7 Spine 3 (S5 substrate): skills as stored procedures.
  // Phase 1 — additive migrations on `skills` + 3 new tables (versions /
  // test_runs / failures). See docs/planning/v8-substrate-s5-spec.md §5 for
  // the canonical schema. Anti-mission: Phase 1 REGISTERS skills, does NOT
  // author. The 57 existing rows continue to work via DEFAULT values; backfill
  // of frontmatter bodies is a separate later task.
  const skillColsExt = _db.prepare("PRAGMA table_info(skills)").all() as Array<{
    name: string;
  }>;
  const skillColNames = new Set(skillColsExt.map((c) => c.name));
  if (!skillColNames.has("version")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN version TEXT NOT NULL DEFAULT '1.0.0'",
    );
  }
  if (!skillColNames.has("inputs_json")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (!skillColNames.has("output_type")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN output_type TEXT NOT NULL DEFAULT 'text'",
    );
  }
  if (!skillColNames.has("trigger_examples_json")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN trigger_examples_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (!skillColNames.has("tests_json")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN tests_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (!skillColNames.has("body_path")) {
    _db.exec("ALTER TABLE skills ADD COLUMN body_path TEXT");
  }
  if (!skillColNames.has("consecutive_failures")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!skillColNames.has("last_failure_at")) {
    _db.exec("ALTER TABLE skills ADD COLUMN last_failure_at TEXT");
  }
  if (!skillColNames.has("is_certified")) {
    _db.exec(
      "ALTER TABLE skills ADD COLUMN is_certified INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!skillColNames.has("current_version_id")) {
    _db.exec("ALTER TABLE skills ADD COLUMN current_version_id INTEGER");
  }
  if (!skillColNames.has("registry_sha")) {
    _db.exec("ALTER TABLE skills ADD COLUMN registry_sha TEXT");
  }
  // v7.7 Spine 3 Phase 3: vector retrieval. Per spec §6, description +
  // trigger_examples concatenated and embedded into the skills row's
  // BLOB column. JS-based cosine over BLOBs for Phase 3 — sqlite-vec
  // virtual table deferred (additive future; current scale is 67 rows).
  // Dim matches `src/memory/embeddings.ts:EMBED_DIMS` (Gemini 1536d
  // by default). Backfill is operator-triggered via `mc-ctl skills
  // backfill-embeddings`.
  if (!skillColNames.has("description_embedding")) {
    _db.exec("ALTER TABLE skills ADD COLUMN description_embedding BLOB");
  }

  // skill_versions — write-only history. Natural key (skill_id, version).
  // INSERT OR IGNORE on (skill_id, version) collision; body drift on the
  // same version is detected via body_sha256 mismatch and logged by the
  // loader (Phase 1 does NOT auto-bump versions; that's an authoring duty).
  _db.exec(`CREATE TABLE IF NOT EXISTS skill_versions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id          TEXT NOT NULL,
    version           TEXT NOT NULL,
    body              TEXT NOT NULL,
    body_sha256       TEXT NOT NULL,
    inputs_json       TEXT NOT NULL,
    tests_json        TEXT NOT NULL,
    tools_used_json   TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    created_by        TEXT NOT NULL CHECK (created_by IN ('operator','discovery','refiner','critic-revised','boot-scan')),
    supersedes_id     INTEGER,
    critic_verdict    TEXT NOT NULL DEFAULT 'skipped' CHECK (critic_verdict IN ('pass','fail_returned_anyway','skipped')),
    critic_critique   TEXT,
    UNIQUE(skill_id, version)
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id)",
  );

  // skill_test_runs — every test execution. Activation invariant: a skill is
  // is_certified=1 iff every test in tests_json has a 'pass' row for the
  // current version_id within the last 7 days. The activation gate query
  // becomes a single GROUP BY. Phase 1 ships the table; Phase 2 ships the
  // harness that writes to it.
  _db.exec(`CREATE TABLE IF NOT EXISTS skill_test_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id             TEXT NOT NULL,
    version_id           INTEGER NOT NULL,
    test_name            TEXT NOT NULL,
    ran_at               TEXT NOT NULL DEFAULT (datetime('now')),
    result               TEXT NOT NULL CHECK (result IN ('pass','fail','error','timeout')),
    actual_output_json   TEXT,
    expected_output_json TEXT,
    diff_summary         TEXT,
    duration_ms          INTEGER,
    task_id              TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_skill_test_runs_skill ON skill_test_runs(skill_id, ran_at DESC)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_skill_test_runs_recent ON skill_test_runs(ran_at DESC)",
  );

  // skill_failures — Voyager anti-list. Active rows (resolved_at IS NULL)
  // become a negative filter for the planner: "skills that have failed
  // recently are deprioritized." Phase 1 ships the table; Phase 4 wires
  // skill_run to write entries on failure.
  _db.exec(`CREATE TABLE IF NOT EXISTS skill_failures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id      TEXT NOT NULL,
    task_id       TEXT,
    failed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    input_json    TEXT,
    error_class   TEXT NOT NULL CHECK (error_class IN ('wrong_output','tool_unavailable','timeout','critic_runtime_fail','other')),
    error_detail  TEXT,
    resolved_at   TEXT,
    resolution    TEXT CHECK (resolution IS NULL OR resolution IN ('reverted_version','fixed_in_new_version','archived'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_skill_failures_active ON skill_failures(skill_id, resolved_at) WHERE resolved_at IS NULL",
  );

  // v7.7 Spine 4 (Conway Pattern 1 substrate): general-events middle layer.
  // Two tables: general_events (the middle-layer records) +
  // general_event_episodic_links (descent edges to episodic sources).
  // See docs/planning/v8-capability-1-spec.md §5 for the canonical schema.
  // DEVIATION FROM SPEC §5 (documented in v7.7-spine-4-impl.md):
  //   - summary_embedding stored as a BLOB column, NOT a `vec0` virtual
  //     table. The codebase uses BLOB + in-memory cosine everywhere
  //     (conversation_embeddings, skills.description_embedding); sqlite-vec
  //     is "a future option when scale > 1000" (src/skills/embedding.ts)
  //     and general_events is a ~30-50 row cohort. Build-once-use-twice.
  //   - details_embedding deferred: descent runs through the explicit
  //     links table, not a second vector probe. Re-addable as an additive
  //     ALTER TABLE if a later spine wants MIRIX-style 1-row/2-probe.
  _db.exec(`CREATE TABLE IF NOT EXISTS general_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id          TEXT NOT NULL UNIQUE,
    level             TEXT NOT NULL CHECK (level IN ('lifetime','general','episodic-cluster')),
    title             TEXT NOT NULL,
    summary           TEXT NOT NULL,
    goal_context_id   TEXT,
    themes            TEXT NOT NULL DEFAULT '[]',
    start_at          TEXT NOT NULL,
    end_at            TEXT,
    episodic_count    INTEGER NOT NULL DEFAULT 0,
    summary_embedding BLOB,
    created_by        TEXT NOT NULL DEFAULT 'manual' CHECK (created_by IN ('manual','seed','auto-discovery')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by     INTEGER REFERENCES general_events(id),
    archived_at       TEXT
  )`);
  // Partial index on the non-archived cohort. Bundle 2 retrieval walks it
  // for the `archived_at IS NULL` filter; note its `end_at` key gives no
  // seek benefit to the window predicate (the `OR end_at IS NULL` disjunct
  // defeats range use) and `ORDER BY start_at DESC` is a temp B-tree sort.
  // Both are fine at the ~30-50 row cohort scale; if the cohort grows, a
  // `(start_at)` partial index would remove the sort (R1-W1, Bundle 2).
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_general_events_active ON general_events(end_at) WHERE archived_at IS NULL",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_general_events_goal ON general_events(goal_context_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_general_events_level ON general_events(level) WHERE archived_at IS NULL",
  );

  _db.exec(`CREATE TABLE IF NOT EXISTS general_event_episodic_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL REFERENCES general_events(event_id),
    episodic_kind TEXT NOT NULL CHECK (episodic_kind IN ('task','conversation','memory_item','recall_audit','cost_ledger','report')),
    episodic_ref  TEXT NOT NULL,
    linked_at     TEXT NOT NULL DEFAULT (datetime('now')),
    link_reason   TEXT CHECK (link_reason IS NULL OR link_reason IN ('manual','auto-themed','co-occurrence'))
  )`);
  // UNIQUE prevents duplicate descent edges; linkEpisodic relies on it for
  // INSERT OR IGNORE idempotency.
  _db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_geel_unique ON general_event_episodic_links(event_id, episodic_kind, episodic_ref)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_geel_event ON general_event_episodic_links(event_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_geel_ref ON general_event_episodic_links(episodic_kind, episodic_ref)",
  );

  // v7.7 Spine 5 (Conway Pattern 2 substrate): self-defining cohort + the
  // operator-profile skeleton (Q3 carve-out). See
  // docs/planning/v7.7-spine-5-impl.md for the canonical record.
  //
  // self_defining_cohort — the ranked subset of projects / objectives /
  // threads that constitute the operator's identity cohort. Populated ONLY
  // by the deterministic roll-up (src/cohort/self-defining.ts) — no LLM.
  // member_id is a globally-unique prefixed id (`<kind>:<raw-id>`).
  // member_kind CHECK admits 'thread' as documented forward-compat headroom;
  // the v7.7 roll-up populates only 'project' + 'objective' (conversation
  // banks are too coarse a thread signal — see impl-delta §3).
  _db.exec(`CREATE TABLE IF NOT EXISTS self_defining_cohort (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id      TEXT NOT NULL UNIQUE,
    member_kind    TEXT NOT NULL CHECK (member_kind IN ('project','objective','thread')),
    label          TEXT NOT NULL,
    source_ref     TEXT NOT NULL,
    salience       REAL NOT NULL DEFAULT 0,
    signal_json    TEXT NOT NULL DEFAULT '{}',
    first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_rolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    active         INTEGER NOT NULL DEFAULT 1
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cohort_active ON self_defining_cohort(salience DESC) WHERE active = 1",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cohort_kind ON self_defining_cohort(member_kind)",
  );

  // operator_profile — the Q3 carve-out SKELETON. Schema only: an opaque
  // key/value attribute bag keyed by cohort member. The `written_by` CHECK
  // admits ONLY 'cohort-rollup' — this is the structural enforcement of the
  // Q3 contract that nothing but the Conway-Pattern-2 roll-up may populate
  // it (no inference, no LLM-derived fields). V8.2 owns the semantic layer;
  // because attribute_key/attribute_value are opaque TEXT, V8.2 can redefine
  // value-side semantics with zero data migration (anti-mission test).
  // The FK to self_defining_cohort(member_id) ON DELETE CASCADE keeps the
  // skeleton from orphaning if a cohort row is ever deleted (R1-W4 fold).
  _db.exec(`CREATE TABLE IF NOT EXISTS operator_profile (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cohort_member_id TEXT NOT NULL,
    attribute_key    TEXT NOT NULL,
    attribute_value  TEXT NOT NULL,
    written_at       TEXT NOT NULL DEFAULT (datetime('now')),
    written_by       TEXT NOT NULL DEFAULT 'cohort-rollup' CHECK (written_by IN ('cohort-rollup')),
    UNIQUE(cohort_member_id, attribute_key),
    FOREIGN KEY(cohort_member_id) REFERENCES self_defining_cohort(member_id) ON DELETE CASCADE
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_operator_profile_member ON operator_profile(cohort_member_id)",
  );

  // V8.1 Phase 4 (Proactive Context Engine — reflection runner). Bounded-diff
  // cursors: each reflection pass reads only events after its cursor, never
  // "all memory" (Letta pattern). `last_event_id` anchors on `tasks.id`
  // (INTEGER PK). See docs/planning/v8-capability-1-spec.md §7. The named
  // cursor rows are seeded idempotently by `seedReflectionCursors()`
  // (src/reflection/cursors.ts), called at startup.
  _db.exec(`CREATE TABLE IF NOT EXISTS reflection_cursors (
    cursor_name   TEXT PRIMARY KEY,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // V8.1 Phase 5 (detection algorithms — recurring blocker). The clustered
  // record of a blocker class seen across ≥3 distinct task runs. See
  // docs/planning/v8-capability-1-spec.md §8.
  // RECONCILIATION vs spec §8: no separate `task_errors` table — the detector
  // clusters over the existing `tasks.error` column (§12 item 2 conditionalises
  // it). `signature_embedding` is kept for the §14-Q3 semantic-clustering
  // follow-up; Phase 5 clusters by exact `blocker_signature` only.
  // `blocker_signature` is UNIQUE so the detection pass upserts one row per
  // signature (the UNIQUE index also serves signature lookups).
  _db.exec(`CREATE TABLE IF NOT EXISTS recurring_blockers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_signature   TEXT NOT NULL UNIQUE,
    signature_embedding BLOB,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    task_count          INTEGER NOT NULL,
    task_ids_json       TEXT NOT NULL,
    named_at            TEXT,
    named_by_briefing_id TEXT,
    resolved_at         TEXT,
    resolution_signal   TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_rb_active ON recurring_blockers(resolved_at) WHERE resolved_at IS NULL",
  );

  // V8.1 Phase 6 (briefing schema + judgment). A constructed morning/alert
  // briefing, held pending the operator's first interaction. See
  // docs/planning/v8-capability-1-spec.md §9. The full typed Briefing is
  // stored as JSON in `briefing_json` (validated by Zod at the boundary);
  // `s2_report_id` links the S2 critic report. Promote/discard transitions
  // are driven by Phase 8 (surface delivery); Phase 6 writes 'pending' rows
  // and supersedes prior pending rows on the same surface.
  _db.exec(`CREATE TABLE IF NOT EXISTS proposed_briefings (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    briefing_id               TEXT UNIQUE NOT NULL,
    surface                   TEXT NOT NULL CHECK (surface IN ('morning','idle_alert','pattern_alert','weekly')),
    generated_at              TEXT NOT NULL,
    briefing_json             TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','discarded','superseded','expired')),
    promoted_at               TEXT,
    promoted_by_message_id    INTEGER,
    discarded_at              TEXT,
    superseded_by_briefing_id TEXT REFERENCES proposed_briefings(briefing_id),
    expires_at                TEXT NOT NULL,
    s2_report_id              TEXT,
    delivered_at              TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pb_surface_status ON proposed_briefings(surface, status)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pb_pending_expires ON proposed_briefings(status, expires_at) WHERE status='pending'",
  );
  // V8.1 Phase 8: `delivered_at` records when a briefing reached the operator.
  // The promote-on-reply hook resolves ONLY briefings with a non-null
  // `delivered_at` — so the Phase 7 morning-surface (which persists 'pending'
  // rows without delivering, while delivery is flag-gated off) cannot have its
  // un-delivered briefings spuriously promoted by an unrelated operator reply.
  // Additive ALTER for DBs created before Phase 8 (the CREATE above carries it
  // for fresh DBs).
  {
    const pbCols = _db
      .prepare("PRAGMA table_info(proposed_briefings)")
      .all() as Array<{ name: string }>;
    if (!pbCols.some((c) => c.name === "delivered_at")) {
      _db.exec("ALTER TABLE proposed_briefings ADD COLUMN delivered_at TEXT");
    }
  }

  // V8.1 Phase 8 (triage policy — spec §9, LangChain-ambient port). The
  // surface-vs-silent decision is a LEARNED policy, not a static threshold.
  // Phase 8 ships the table + promote/discard counters; the LLM policy-text
  // rewrite loop is a deferred follow-up, so `policy_text` defaults to '' (no
  // policy learned yet — honest).
  _db.exec(`CREATE TABLE IF NOT EXISTS triage_policies (
    surface       TEXT PRIMARY KEY CHECK (surface IN ('morning','idle_alert','pattern_alert','weekly')),
    policy_text   TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    promote_count INTEGER NOT NULL DEFAULT 0,
    discard_count INTEGER NOT NULL DEFAULT 0,
    last_outcome  TEXT
  )`);

  // V8.1 Phase 7 (triggers — N-turn / cron / idle). Restart-safe ledger of
  // every trigger fire. Two invariants depend on it: per-surface throttling
  // (idle-detect: ≤1 fire / 12h) and the §14-Q4 cost ceiling (≤10 reflection
  // runs / 24h across n-turn + idle-detect). The N-turn *counter* itself is
  // in-memory (an approximate cadence); only the cost/throttle state — which
  // must survive a deploy restart — is persisted here. `outcome` is 'fired'
  // for a real run, 'skipped'/'failed' for observability. See
  // docs/planning/v8-capability-1-spec.md §6 + §14 Q4.
  // `outcome` is constrained (not just nullable TEXT): the §14-Q4 ceiling and
  // the idle throttle both gate on `outcome='fired'`, so a typo'd value would
  // silently never count. The CHECK mirrors the discipline on `trigger_kind`.
  _db.exec(`CREATE TABLE IF NOT EXISTS trigger_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('n_turn','cron_morning','idle_detect')),
    fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
    outcome      TEXT NOT NULL CHECK (outcome IN ('fired','skipped','failed')),
    detail       TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trigger_runs_kind ON trigger_runs(trigger_kind, fired_at)",
  );

  // ── V8.2 Phase 0 — substrate reconciliation (spec §5) ──────────────────────
  // V8.2 (Strategic Initiative Layer) makes briefs opinionated, cited, and
  // multi-option. R1 assumed an `ALTER TABLE judgments`, but V8.1 shipped
  // `proposed_briefings` with judgment content INSIDE the briefing JSON — there
  // was no `judgments` base table. Phase 0 creates it as a normalized child of
  // `proposed_briefings` (ON DELETE CASCADE), additive and forward-only:
  // `constructBriefing` keeps writing its briefing JSON unchanged (legacy render
  // path); the V8.2 pipeline ADDITIONALLY writes one row per judgment here.
  // The V8.2 additive columns (evidence_refs/options/concession/etc.) are created
  // inline — no separate ALTER. See docs/planning/v8-capability-2-spec.md §5/§6.
  //
  // NOTE (posture enum divergence — flagged for Phase 2): the spec's canonical
  // V8.2 posture vocabulary is 'momentum' (not V8.1 JudgmentSchema's
  // 'has_momentum'). The Phase 2 judgment pass that maps a V8.1 signal into a
  // `judgments` row MUST normalize 'has_momentum' → 'momentum' or the CHECK
  // below rejects the insert. Kept per spec to avoid silently widening the enum.
  _db.exec(`CREATE TABLE IF NOT EXISTS judgments (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    briefing_id                   TEXT NOT NULL REFERENCES proposed_briefings(briefing_id) ON DELETE CASCADE,
    subject                       TEXT NOT NULL,
    posture                       TEXT NOT NULL CHECK (posture IN ('at_risk','momentum','highest_leverage','noted')),
    prose                         TEXT NOT NULL,
    confidence                    TEXT CHECK (confidence IN ('green','yellow','red')),
    signal_kind                   TEXT,
    signal_last_seen_at           TEXT,
    created_at                    TEXT NOT NULL,
    evidence_refs_json            TEXT,
    proposed_options_json         TEXT,
    strategic_voice_principle_id  TEXT,
    concession_kind               TEXT CHECK (concession_kind IN
      ('held_position','updated_with_evidence','conceded_without_evidence') OR concession_kind IS NULL),
    triggering_evidence_text      TEXT,
    confidence_basis_json         TEXT,
    critic_trail_json             TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_judgments_briefing ON judgments(briefing_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_judgments_created ON judgments(created_at)",
  );

  // `reflection_followups` — the self-recheck ledger V8.1 deferred (V8.1 §10.5)
  // and both V8.2 §13 (concession self-recheck) and V8.3 §12 depend on. A sweep
  // in the morning-surface trigger fires due rows; `context_ref` carries a typed
  // prefix ('judgment:<id>' for V8.2, 'decision:<id>' for V8.3) so the sweep can
  // dispatch by producer. The partial index supports the due-row query
  // (`WHERE fired_at IS NULL`). No producer writes rows yet in Phase 0 — the
  // table + sweep are wired and tested ahead of the consumers.
  _db.exec(`CREATE TABLE IF NOT EXISTS reflection_followups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fire_after      TEXT NOT NULL,
    checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN ('verify_resolution','verify_prediction')),
    context_ref     TEXT NOT NULL,
    fired_at        TEXT,
    created_at      TEXT NOT NULL
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_reflection_followups_due ON reflection_followups(fire_after) WHERE fired_at IS NULL",
  );

  // ── V8.2 Phase 1 — schema + types (spec §6) ────────────────────────────────
  // `attributed_claims` — the normalized citation ledger. R1 overloaded
  // `marker_index` to mean BOTH prose-marker-position AND evidence-ledger-slot
  // and duplicated `claim_text` per evidence row. R2 separates the two: a
  // `claim_id` (a per-judgment counter) groups the 1+ evidence rows of ONE
  // sentence, so a multi-source `[1][3]` becomes two rows sharing a claim_id and
  // two sentences both citing `[1]` are distinguishable. The §9 resolver (Phase
  // 4) walks the prose, writes these rows with resolver_status='resolved', and
  // the §11 CRITIC (Phase 6) flips contradicted claims to 'contradicted'.
  // evidence_kind CHECK is kept in lockstep with EVIDENCE_KINDS
  // (src/lib/v8-2/reconciliation.ts) — a drift guard test asserts the two match.
  // No producer writes rows yet in Phase 1 — table + types ship ahead of cite.ts.
  _db.exec(`CREATE TABLE IF NOT EXISTS attributed_claims (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    judgment_id      INTEGER NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,
    claim_id         INTEGER NOT NULL,
    claim_text       TEXT NOT NULL,
    prose_offset     INTEGER,
    evidence_kind    TEXT NOT NULL CHECK (evidence_kind IN
      ('task','kb_entry','conversation','metric','northstar',
       'general_event','recurring_blocker','cohort_member','operator_message')),
    evidence_id      TEXT NOT NULL,
    evidence_excerpt TEXT NOT NULL,
    retrieved_at     TEXT NOT NULL,
    resolver_status  TEXT NOT NULL DEFAULT 'unresolved' CHECK (resolver_status IN
      ('unresolved','resolved','stale','contradicted'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_attributed_claims_judgment ON attributed_claims(judgment_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_attributed_claims_claim ON attributed_claims(judgment_id, claim_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_attributed_claims_status ON attributed_claims(resolver_status) WHERE resolver_status != 'resolved'",
  );

  // `sycophancy_probes` — the nightly probe ledger (spec §6/§8 Phase 8). R2
  // samples ALL judgment colors (green/yellow/red, not just confident ones); a
  // probe re-states a rotating challenge literal and classifies whether the
  // model held, updated-with-evidence, or conceded-without-evidence. The §17
  // gate reads concede-without-evidence rate over a 30d window across all colors.
  // `judgment_color` is free TEXT per spec (no CHECK — the column is descriptive,
  // not constrained). No producer writes rows yet in Phase 1.
  _db.exec(`CREATE TABLE IF NOT EXISTS sycophancy_probes (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    probed_at                TEXT NOT NULL,
    judgment_id              INTEGER REFERENCES judgments(id),
    probe_string             TEXT NOT NULL,
    judgment_color           TEXT NOT NULL,
    initial_position_summary TEXT,
    final_position_summary   TEXT,
    concession_kind          TEXT NOT NULL CHECK (concession_kind IN
      ('held_position','updated_with_evidence','conceded_without_evidence')),
    triggering_evidence_text TEXT
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sycophancy_probes_at ON sycophancy_probes(probed_at)",
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
