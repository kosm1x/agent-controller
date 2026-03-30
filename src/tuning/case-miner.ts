/**
 * Case Miner — Extracts test cases from scope telemetry data.
 *
 * Runs nightly (before the self-tuning loop). Reads scope_telemetry
 * for the last 24h and generates:
 *   1. Scope miss cases (tool was repaired → scope pattern too narrow)
 *   2. Scope waste cases (group activated but tools never used)
 *   3. Negative feedback cases (user said "no"/"mal" → tools were wrong)
 *
 * Mined cases are inserted into mined_test_cases table and automatically
 * picked up by getActiveTestCases() in the eval runner.
 */

import { getDatabase } from "../db/index.js";
import {
  getTelemetryWithRepairs,
  getTelemetryWithNegativeFeedback,
  getRecentTelemetry,
} from "../intelligence/scope-telemetry.js";
import {
  COMMIT_READ_TOOLS,
  COMMIT_WRITE_TOOLS,
  COMMIT_JOURNAL_TOOLS,
  COMMIT_DESTRUCTIVE_TOOLS,
  SCHEDULE_TOOLS,
  GOOGLE_TOOLS,
  CODING_TOOLS,
  WORDPRESS_TOOLS,
  BROWSER_TOOLS,
  SPECIALTY_TOOLS,
  MISC_TOOLS,
} from "../messaging/scope.js";

// ---------------------------------------------------------------------------
// Tool → Group mapping (reverse lookup)
// ---------------------------------------------------------------------------

const TOOL_TO_GROUP = new Map<string, string>();

function buildToolToGroupMap(): void {
  if (TOOL_TO_GROUP.size > 0) return;

  const groups: Array<[string, readonly string[]]> = [
    ["commit_read", COMMIT_READ_TOOLS],
    ["commit_write", COMMIT_WRITE_TOOLS],
    ["commit_journal", COMMIT_JOURNAL_TOOLS],
    ["commit_destructive", COMMIT_DESTRUCTIVE_TOOLS],
    ["schedule", SCHEDULE_TOOLS],
    ["google", GOOGLE_TOOLS],
    ["coding", CODING_TOOLS],
    ["wordpress", WORDPRESS_TOOLS],
    ["browser", BROWSER_TOOLS],
    ["specialty", SPECIALTY_TOOLS],
  ];

  for (const [group, tools] of groups) {
    for (const tool of tools) {
      TOOL_TO_GROUP.set(tool, group);
    }
  }
}

function groupForTool(toolName: string): string | undefined {
  buildToolToGroupMap();
  return TOOL_TO_GROUP.get(toolName);
}

// ---------------------------------------------------------------------------
// Case ID generation (deterministic for dedup)
// ---------------------------------------------------------------------------

function hashMessage(msg: string): string {
  let hash = 0;
  for (let i = 0; i < msg.length; i++) {
    hash = ((hash << 5) - hash + msg.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Mine scope misses
// ---------------------------------------------------------------------------

interface MinedCase {
  case_id: string;
  category: string;
  input: { message: string };
  expected: Record<string, unknown>;
  mined_from: string;
}

function mineScopeMisses(hours: number = 24): MinedCase[] {
  const rows = getTelemetryWithRepairs(hours);
  const cases: MinedCase[] = [];

  for (const row of rows) {
    const repairs: Array<{ original: string; repaired: string }> = JSON.parse(
      row.tools_repaired,
    );
    const activeGroups: string[] = JSON.parse(row.active_groups);

    for (const repair of repairs) {
      const neededGroup = groupForTool(repair.repaired);
      if (!neededGroup) continue;
      if (activeGroups.includes(neededGroup)) continue; // Group was active, just name was wrong

      cases.push({
        case_id: `mined-scope-miss-${hashMessage(row.message)}-${neededGroup}`,
        category: "scope_accuracy",
        input: { message: row.message },
        expected: { scope_groups: [neededGroup] },
        mined_from: `scope_miss:${repair.original}→${repair.repaired}`,
      });
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Mine scope waste (groups activated but tools never called)
// ---------------------------------------------------------------------------

function mineScopeWaste(hours: number = 24): MinedCase[] {
  const rows = getRecentTelemetry(hours);
  if (rows.length < 5) return [];

  // Count group activations and tool usage
  const groupActivations = new Map<string, number>();
  const groupToolUsage = new Map<string, Set<string>>();

  for (const row of rows) {
    const groups: string[] = JSON.parse(row.active_groups);
    const called: string[] = JSON.parse(row.tools_called);

    for (const group of groups) {
      groupActivations.set(group, (groupActivations.get(group) ?? 0) + 1);
      if (!groupToolUsage.has(group)) groupToolUsage.set(group, new Set());
    }

    for (const tool of called) {
      const group = groupForTool(tool);
      if (group && groupToolUsage.has(group)) {
        groupToolUsage.get(group)!.add(tool);
      }
    }
  }

  const cases: MinedCase[] = [];

  for (const [group, count] of groupActivations) {
    if (count < 5) continue;
    const usage = groupToolUsage.get(group);
    if (usage && usage.size > 0) continue; // Group's tools were used at least once

    // Find a representative message that activated this group
    const representative = rows.find((r) => {
      const groups: string[] = JSON.parse(r.active_groups);
      return groups.includes(group);
    });

    if (representative) {
      cases.push({
        case_id: `mined-scope-waste-${group}-${hashMessage(representative.message)}`,
        category: "scope_accuracy",
        input: { message: representative.message },
        expected: { not_scope_groups: [group] },
        mined_from: `scope_waste:${group}(${count}x activated, 0 tools used)`,
      });
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Mine negative feedback cases
// ---------------------------------------------------------------------------

function mineNegativeFeedback(days: number = 7): MinedCase[] {
  const rows = getTelemetryWithNegativeFeedback(days);
  const cases: MinedCase[] = [];

  for (const row of rows) {
    const toolsCalled: string[] = JSON.parse(row.tools_called);
    if (toolsCalled.length === 0) continue;

    cases.push({
      case_id: `mined-feedback-neg-${hashMessage(row.message)}`,
      category: "tool_selection",
      input: { message: row.message },
      expected: { not_tools: toolsCalled },
      mined_from: `negative_feedback:${row.task_id}`,
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function mineTestCases(): {
  inserted: number;
  skipped: number;
  errors: number;
} {
  const db = getDatabase();
  const stats = { inserted: 0, skipped: 0, errors: 0 };

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS mined_test_cases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     TEXT UNIQUE NOT NULL,
      category    TEXT NOT NULL,
      input       TEXT NOT NULL,
      expected    TEXT NOT NULL,
      weight      REAL DEFAULT 0.8,
      source      TEXT DEFAULT 'mined',
      active      INTEGER DEFAULT 1,
      mined_from  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mined_cases_category
      ON mined_test_cases(category);
  `);

  const allCases = [
    ...mineScopeMisses(),
    ...mineScopeWaste(),
    ...mineNegativeFeedback(),
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO mined_test_cases
      (case_id, category, input, expected, source, mined_from)
    VALUES (?, ?, ?, ?, 'mined', ?)
  `);

  for (const c of allCases) {
    try {
      const result = insertStmt.run(
        c.case_id,
        c.category,
        JSON.stringify(c.input),
        JSON.stringify(c.expected),
        c.mined_from,
      );
      if (result.changes > 0) {
        stats.inserted++;
      } else {
        stats.skipped++; // Already existed (dedup via UNIQUE case_id)
      }
    } catch {
      stats.errors++;
    }
  }

  // Prune old mined cases (>90 days) to prevent unbounded growth
  db.exec(
    `DELETE FROM mined_test_cases WHERE created_at < datetime('now', '-90 days')`,
  );

  console.log(
    `[case-miner] Mined ${allCases.length} candidates → ${stats.inserted} new, ${stats.skipped} dedup, ${stats.errors} errors`,
  );

  return stats;
}
