/**
 * V8.3 — Autonomous Execution Gates: schema (Phase 0 + Phase 1).
 *
 * `ensureV83Tables(db)` is called from `initDatabase()` AFTER the V8.2 tables
 * (`judgments`, `reflection_followups`, `attributed_claims`) are created inline
 * there. The Phase-0 dependency check (`assertV82Dependencies`) is exported
 * separately and run ONCE from the real boot path (`src/index.ts`), not from
 * `ensureV83Tables` — V8.3 is hard-gated on V8.2's consent substrate (§12), and a
 * boot where those tables are missing is a real misconfiguration we surface loud.
 * Keeping the assertion out of the DDL leaves the schema path a pure
 * `CREATE … IF NOT EXISTS` that never reads, so a stubbed DB driver in a unit test
 * can't trip it.
 *
 * All DDL is additive (`CREATE TABLE/INDEX/VIEW IF NOT EXISTS`) — boot-safe on the
 * existing mc.db, no reset (CLAUDE.md additive rule). FKs are declared per spec §5
 * and ARE enforced (the app connection sets `PRAGMA foreign_keys = ON`), so tables
 * are created parent-first: capability_autonomy → capability_trust_signals →
 * decisions → decision_events → view.
 *
 * DORMANCY: this increment ships the substrate only. No code writes a `decisions`
 * or `decision_events` row, and nothing reads `capability_autonomy` to gate an
 * action — the decision pipeline (Phase 2+) lands behind `V83_ENABLED`. The tables
 * are inert by construction, exactly as the V8.2 Phase-0 tables shipped ungated.
 */

import type Database from "better-sqlite3";

/** V8.2 tables V8.3 depends on (§12 hard table dependency). */
const V82_DEPENDENCY_TABLES = ["judgments", "reflection_followups"] as const;

/**
 * Phase-0 gate: assert the V8.2 consent substrate exists before any V8.3 table.
 * Throws (fail loud) if a dependency is missing — V8.3 cannot legitimately exist
 * without the consent layer that precedes it.
 */
export function assertV82Dependencies(db: Database.Database): void {
  const present = new Set(
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${V82_DEPENDENCY_TABLES.map(
          () => "?",
        ).join(",")})`,
      )
      .all(...V82_DEPENDENCY_TABLES)
      .map((r) => (r as { name: string }).name),
  );
  const missing = V82_DEPENDENCY_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `V8.3 Phase-0 gate failed: required V8.2 tables absent (${missing.join(
        ", ",
      )}). V8.3 is hard-gated on V8.2 — ensure the V8.2 schema applies first.`,
    );
  }
}

export function ensureV83Tables(db: Database.Database): void {
  // NB: the V8.2 dependency assertion is NOT run here — it's a boot precondition
  // (`assertV82Dependencies`, called once from src/index.ts against the real DB),
  // deliberately decoupled from this idempotent DDL so the schema path stays a
  // pure `CREATE … IF NOT EXISTS` (SQLite permits FK refs to tables created later
  // in the same init, and unit tests that stub the DB driver don't trip a read).

  // Parent: per-capability autonomy state. No outgoing FK — created first.
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_autonomy (
      capability               TEXT PRIMARY KEY,
      level                    INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
      odd_predicate_json       TEXT NOT NULL,
      gate_config_json         TEXT NOT NULL,
      ux_confirm_flag          INTEGER NOT NULL DEFAULT 0,
      blast_radius             TEXT NOT NULL CHECK (blast_radius IN ('self','session','persistent')),
      reversible_default       INTEGER NOT NULL,
      override_window_start_at TEXT NOT NULL,
      override_count           INTEGER NOT NULL DEFAULT 0,
      total_executions         INTEGER NOT NULL DEFAULT 0,
      override_integral        REAL NOT NULL DEFAULT 0.0,
      last_pi_evaluation_at    TEXT,
      promoted_at              TEXT,
      demoted_at               TEXT,
      description              TEXT NOT NULL
    );
  `);

  // Lee & See 3-D trust signals (v2; rows recomputed nightly once L≥3 traffic exists).
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_trust_signals (
      capability                   TEXT PRIMARY KEY
                                     REFERENCES capability_autonomy(capability) ON DELETE CASCADE,
      override_rate                REAL NOT NULL DEFAULT 0.0,
      pull_to_push_ratio           REAL NOT NULL DEFAULT 0.0,
      weeks_at_current_level       INTEGER NOT NULL DEFAULT 0,
      median_time_to_promote_weeks REAL,
      last_computed_at             TEXT NOT NULL
    );
  `);

  // Central decision row — one per autonomous-or-confirmed write (none in v1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      capability             TEXT NOT NULL REFERENCES capability_autonomy(capability),
      judgment_id            INTEGER REFERENCES judgments(id),
      autonomy_level         INTEGER NOT NULL CHECK (autonomy_level BETWEEN 0 AND 5),
      status                 TEXT NOT NULL CHECK (status IN
                               ('pending','committed','reverted','vetoed','interrupted')),
      capability_token_json  TEXT NOT NULL,
      payload_json           TEXT NOT NULL,
      pre_state_json         TEXT,
      reversal_op_json       TEXT,
      pheropath_signal       TEXT CHECK (pheropath_signal IN ('DANGER','TODO','SAFE','INSIGHT')),
      proposed_at            TEXT NOT NULL,
      decided_at             TEXT,
      reverted_at            TEXT,
      superseded_by          INTEGER REFERENCES decisions(id),
      supersedes             INTEGER REFERENCES decisions(id),
      operator_override_kind TEXT CHECK (operator_override_kind IN
                               ('vetoed','accepted_with_modification','accepted','none')),
      thread_id              TEXT NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_decisions_capability_status ON decisions(capability, status)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_decisions_judgment ON decisions(judgment_id) WHERE judgment_id IS NOT NULL`,
  );

  // Append-only event-source.
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id      INTEGER NOT NULL REFERENCES decisions(id),
      sequence_no      INTEGER NOT NULL,
      event_kind       TEXT NOT NULL CHECK (event_kind IN
                         ('proposed','approved','executed','reverted','superseded',
                          'operator_override','autonomy_demoted','autonomy_promoted','interrupted')),
      payload_json     TEXT,
      occurred_at      TEXT NOT NULL,
      parent_event_seq INTEGER,
      UNIQUE (decision_id, sequence_no)
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_decision_events_kind ON decision_events(event_kind, occurred_at)`,
  );

  // Operator-facing audit surface (§11).
  db.exec(`
    CREATE VIEW IF NOT EXISTS audit_decisions AS
    SELECT d.id, d.capability, d.autonomy_level, d.status, d.proposed_at, d.decided_at,
           d.operator_override_kind, d.pheropath_signal,
           cts.override_rate, cts.weeks_at_current_level, ca.level AS current_capability_level
    FROM decisions d
    JOIN capability_autonomy ca ON ca.capability = d.capability
    LEFT JOIN capability_trust_signals cts ON cts.capability = d.capability
    ORDER BY d.proposed_at DESC;
  `);
}
