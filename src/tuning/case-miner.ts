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
  SCHEDULE_TOOLS,
  GOOGLE_TOOLS,
  CODING_TOOLS,
  WORDPRESS_TOOLS,
  BROWSER_TOOLS,
  SPECIALTY_TOOLS,
  RESEARCH_TOOLS,
} from "../messaging/scope.js";

// ---------------------------------------------------------------------------
// Tool → Group mapping (reverse lookup)
// ---------------------------------------------------------------------------

const TOOL_TO_GROUP = new Map<string, string>();

function buildToolToGroupMap(): void {
  if (TOOL_TO_GROUP.size > 0) return;

  const groups: Array<[string, readonly string[]]> = [
    ["schedule", SCHEDULE_TOOLS],
    ["google", GOOGLE_TOOLS],
    ["coding", CODING_TOOLS],
    ["wordpress", WORDPRESS_TOOLS],
    ["browser", BROWSER_TOOLS],
    ["specialty", SPECIALTY_TOOLS],
    ["research", RESEARCH_TOOLS],
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
  /** Score weight — defaults to the table default (0.8) when unset.
   *  Positive-mined selection cases use 0.6: they encode "what a clean run
   *  did", weaker ground truth than a human-authored expectation. */
  weight?: number;
  /** Case provenance — 'mined' (nightly miner, 90d retention) or
   *  'flywheel' (operator-pinned regression, retention-exempt). */
  source?: "mined" | "flywheel";
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
// Mine tier mismatches (S5: model tier + negative feedback correlation)
// ---------------------------------------------------------------------------

function mineTierMismatches(days: number = 14): MinedCase[] {
  const db = getDatabase();
  const cases: MinedCase[] = [];

  try {
    // Find tasks where flash tier got negative feedback → should have been standard+
    const rows = db
      .prepare(
        `SELECT t.title, o.model_tier, o.feedback_signal
         FROM task_outcomes o
         JOIN tasks t ON t.task_id = o.task_id
         WHERE o.created_at >= datetime('now', '-' || ? || ' days')
           AND o.model_tier = 'flash'
           AND o.feedback_signal IN ('negative', 'rephrase', 'implicit_rephrase')
         LIMIT 20`,
      )
      .all(days) as Array<{
      title: string;
      model_tier: string;
      feedback_signal: string;
    }>;

    for (const row of rows) {
      // Extract user message from "Chat: <message>"
      const msg = row.title.replace(/^Chat:\s*/, "");
      if (msg.length < 5) continue;

      cases.push({
        case_id: `mined-tier-mismatch-${hashMessage(msg)}`,
        category: "classification",
        input: { message: msg },
        expected: { agent_type: "fast" }, // runner is correct, tier is wrong
        mined_from: `tier_mismatch:flash+${row.feedback_signal}`,
      });
    }
  } catch {
    // model_tier column may not exist yet — non-fatal
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Mine positive tool selections (V8.5 Phase 4.3 — corpus growth)
// ---------------------------------------------------------------------------

/**
 * Mine tool_selection cases from CLEAN production runs: tool calls happened,
 * nothing failed, no negative/rephrase feedback. Expected = the tools the run
 * actually used — status-quo ground truth, so these carry weight 0.6 (vs 1.0
 * manual seeds) and exist for BREADTH: the 55-case corpus made the 50%-weight
 * gate axis flap within run-to-run noise (epsilon 2.0 vs ±2.2 observed);
 * eval-gate.ts documents ≥150 cases as the precondition for tightening.
 *
 * Filters, in order:
 *  - focused runs only (1-3 distinct tools) — a 10-tool run has ambiguous
 *    ground truth for "which tool should this message select";
 *  - message ≥5 words — flash-tier one-liners select on thread context the
 *    eval can't reproduce;
 *  - dedup by message hash across the window AND against already-stored
 *    case_ids (INSERT OR IGNORE backstops this).
 */
/**
 * Ceiling on ACTIVE positive-mined cases (audit W2, 2026-07-12): every
 * tool_selection case is one real LLM call per eval:gate run, so the
 * cost-bearing axis needs a hard bound, not just the per-run cap + 90d
 * prune (worst case without this: ~120/night × 90d ≈ 10.8k cases). 140
 * positive + 39 seed + negatives + flywheel keeps the corpus in the
 * 150-200 band the gate design targets.
 */
const POSITIVE_CASE_CEILING = 140;

/** @internal exported for tests */
export function minePositiveSelections(
  days: number = 30,
  cap: number = 120,
): MinedCase[] {
  const db = getDatabase();
  const cases: MinedCase[] = [];
  const seen = new Set<string>();

  // Remaining room under the ceiling — counts previously-stored actives.
  let existing = 0;
  try {
    existing = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM mined_test_cases
           WHERE case_id LIKE 'mined-positive-%' AND active = 1`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    // Table may not exist yet (first run) — full room available.
  }
  const room = Math.min(cap, Math.max(0, POSITIVE_CASE_CEILING - existing));
  if (room === 0) return [];

  const rows = db
    .prepare(
      `SELECT message, tools_called
       FROM scope_telemetry
       WHERE created_at >= datetime('now', '-' || ? || ' days')
         AND tools_called != '[]'
         AND tools_failed = '[]'
         AND feedback_signal NOT IN ('negative', 'rephrase', 'implicit_rephrase')
       ORDER BY created_at DESC`,
    )
    .all(days) as Array<{ message: string; tools_called: string }>;

  for (const row of rows) {
    if (cases.length >= room) break;

    let tools: string[];
    try {
      tools = [...new Set(JSON.parse(row.tools_called) as string[])];
    } catch {
      continue;
    }
    if (tools.length < 1 || tools.length > 3) continue;

    const msg = row.message.trim();
    if (msg.split(/\s+/).length < 5) continue;

    const h = hashMessage(msg);
    if (seen.has(h)) continue;
    seen.add(h);

    cases.push({
      case_id: `mined-positive-${h}`,
      category: "tool_selection",
      input: { message: msg },
      expected: { tools },
      mined_from: `positive_selection:${tools.join(",")}`,
      weight: 0.6,
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
    ...mineTierMismatches(),
    // V8.5 Phase 4.3: breadth for the 50%-weight tool_selection axis
    // (corpus ≥150 is eval-gate.ts's named precondition for tightening
    // epsilon). Weight 0.6 per case — see minePositiveSelections.
    ...minePositiveSelections(),
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO mined_test_cases
      (case_id, category, input, expected, weight, source, mined_from)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of allCases) {
    try {
      const result = insertStmt.run(
        c.case_id,
        c.category,
        JSON.stringify(c.input),
        JSON.stringify(c.expected),
        c.weight ?? 0.8,
        c.source ?? "mined",
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

  // Prune old mined cases (>90 days) to prevent unbounded growth.
  // Flywheel cases are operator-pinned regressions — retention-EXEMPT:
  // the 90d decay silently shrinking the corpus is the eval-silence-floor
  // failure class (2026-07-10); a pinned production bug must stay pinned.
  db.exec(
    `DELETE FROM mined_test_cases
     WHERE created_at < datetime('now', '-90 days')
       AND source != 'flywheel'`,
  );

  console.log(
    `[case-miner] Mined ${allCases.length} candidates → ${stats.inserted} new, ${stats.skipped} dedup, ${stats.errors} errors`,
  );

  return stats;
}
