/**
 * Scope Telemetry — Records scope decisions and tool execution outcomes.
 *
 * Every Jarvis message produces a telemetry record:
 *   1. Scope decision: which groups activated, which tools in scope
 *   2. Tool execution: which tools were actually called, repairs, failures
 *   3. Feedback linkage: user feedback propagated from outcome tracker
 *
 * The nightly case miner (src/tuning/case-miner.ts) reads this data to
 * auto-generate test cases for the self-tuning eval harness.
 */

import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Table creation (idempotent — called at startup)
// ---------------------------------------------------------------------------

export function ensureScopeTelemetryTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_telemetry (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT,
      message         TEXT NOT NULL,
      active_groups   TEXT DEFAULT '[]',
      tools_in_scope  TEXT DEFAULT '[]',
      tools_called    TEXT DEFAULT '[]',
      tools_repaired  TEXT DEFAULT '[]',
      tools_failed    TEXT DEFAULT '[]',
      tool_chain      TEXT DEFAULT '',
      feedback_signal TEXT DEFAULT 'none',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scope_tel_task ON scope_telemetry(task_id);
    CREATE INDEX IF NOT EXISTS idx_scope_tel_created ON scope_telemetry(created_at DESC);
  `);
  // Additive migration: add tool_chain column if missing (existing DBs)
  try {
    db.exec(
      `ALTER TABLE scope_telemetry ADD COLUMN tool_chain TEXT DEFAULT ''`,
    );
  } catch {
    // Column already exists — ignore
  }
}

let _initialized = false;

function ensureTable(): void {
  if (_initialized) return;
  ensureScopeTelemetryTable();
  _initialized = true;
}

// ---------------------------------------------------------------------------
// Record scope decision (called from router.ts after scopeToolsForMessage)
// ---------------------------------------------------------------------------

export function recordScopeDecision(
  message: string,
  activeGroups: string[],
  toolsInScope: string[],
): number {
  ensureTable();
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO scope_telemetry (message, active_groups, tools_in_scope)
       VALUES (?, ?, ?)`,
    )
    .run(
      message.slice(0, 500),
      JSON.stringify(activeGroups),
      JSON.stringify(toolsInScope),
    );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Link scope record to a task (called after task submission)
// ---------------------------------------------------------------------------

export function linkScopeToTask(scopeRowId: number, taskId: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE scope_telemetry SET task_id = ? WHERE id = ?`).run(
    taskId,
    scopeRowId,
  );
}

// ---------------------------------------------------------------------------
// Record tool repairs (called from fast-runner after inferWithTools)
// ---------------------------------------------------------------------------

export function recordToolRepairs(
  taskId: string,
  repairs: Array<{ original: string; repaired: string }>,
): void {
  if (repairs.length === 0) return;
  const db = getDatabase();
  db.prepare(
    `UPDATE scope_telemetry SET tools_repaired = ? WHERE task_id = ?`,
  ).run(JSON.stringify(repairs), taskId);
}

// ---------------------------------------------------------------------------
// Record tool execution results (called from fast-runner)
// ---------------------------------------------------------------------------

export function recordToolExecution(
  taskId: string,
  toolsCalled: string[],
  toolsFailed: string[],
): void {
  const db = getDatabase();
  // Build tool_chain: ordered, deduplicated sequence of tools called
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const t of toolsCalled) {
    if (!seen.has(t)) {
      seen.add(t);
      chain.push(t);
    }
  }
  const toolChain = chain.join("→");
  db.prepare(
    `UPDATE scope_telemetry SET tools_called = ?, tools_failed = ?, tool_chain = ? WHERE task_id = ?`,
  ).run(
    JSON.stringify(toolsCalled),
    JSON.stringify(toolsFailed),
    toolChain,
    taskId,
  );
}

// ---------------------------------------------------------------------------
// Link feedback signal (called when user feedback is recorded)
// ---------------------------------------------------------------------------

export function linkFeedbackToScope(
  taskId: string,
  signal: import("./feedback.js").AnyFeedbackSignal | string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE scope_telemetry SET feedback_signal = ? WHERE task_id = ?`,
  ).run(signal, taskId);
}

// ---------------------------------------------------------------------------
// Query recent telemetry (used by case miner)
// ---------------------------------------------------------------------------

export interface ScopeTelemetryRow {
  id: number;
  task_id: string | null;
  message: string;
  active_groups: string;
  tools_in_scope: string;
  tools_called: string;
  tools_repaired: string;
  tools_failed: string;
  tool_chain: string;
  feedback_signal: string;
  created_at: string;
}

export function getRecentTelemetry(hours: number = 24): ScopeTelemetryRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM scope_telemetry
       WHERE created_at > datetime('now', ? || ' hours')
       ORDER BY created_at DESC
       LIMIT 500`,
    )
    .all(`-${hours}`) as ScopeTelemetryRow[];
}

export function getTelemetryWithRepairs(
  hours: number = 24,
): ScopeTelemetryRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM scope_telemetry
       WHERE tools_repaired != '[]'
         AND created_at > datetime('now', ? || ' hours')
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .all(`-${hours}`) as ScopeTelemetryRow[];
}

/** Get tool chain success rates for the mc-ctl dashboard. */
export function getToolChainStats(days: number = 7): Array<{
  tool_chain: string;
  total: number;
  positive: number;
  negative: number;
  neutral: number;
}> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT
         tool_chain,
         COUNT(*) as total,
         SUM(CASE WHEN feedback_signal IN ('positive', 'implicit_positive') THEN 1 ELSE 0 END) as positive,
         SUM(CASE WHEN feedback_signal IN ('negative', 'rephrase', 'implicit_rephrase') THEN 1 ELSE 0 END) as negative,
         SUM(CASE WHEN feedback_signal IN ('none', 'neutral') THEN 1 ELSE 0 END) as neutral
       FROM scope_telemetry
       WHERE tool_chain != ''
         AND created_at > datetime('now', ? || ' days')
       GROUP BY tool_chain
       ORDER BY total DESC
       LIMIT 20`,
    )
    .all(`-${days}`) as Array<{
    tool_chain: string;
    total: number;
    positive: number;
    negative: number;
    neutral: number;
  }>;
}

export function getTelemetryWithNegativeFeedback(
  days: number = 7,
): ScopeTelemetryRow[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM scope_telemetry
       WHERE feedback_signal = 'negative'
         AND created_at > datetime('now', ? || ' days')
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .all(`-${days}`) as ScopeTelemetryRow[];
}
