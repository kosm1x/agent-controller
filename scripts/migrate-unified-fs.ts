#!/usr/bin/env npx tsx
/**
 * Migration script: Unified File System for Jarvis Knowledge Base.
 *
 * Moves existing jarvis_files to the new hierarchy. Single transaction.
 * Run: npx tsx scripts/migrate-unified-fs.ts
 */

import BetterSqlite3 from "better-sqlite3";
import { resolve } from "path";
import { rmSync, mkdirSync } from "fs";

const DB_PATH = resolve(process.cwd(), "data", "mc.db");
const MIRROR_DIR = resolve(process.cwd(), "data", "jarvis");

console.log(`[migrate] Opening DB at ${DB_PATH}`);
const db = new BetterSqlite3(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Path mappings: [oldPath, newPath, newQualifier?]
// If newQualifier is undefined, keep existing qualifier.
// ---------------------------------------------------------------------------

const MOVES: Array<[string, string, string?]> = [
  // Directives
  ["DIRECTIVES.md", "directives/core.md"],
  ["sop/context-management.md", "directives/context-management.md"],
  ["sop/repo-authorization.md", "directives/repo-authorization.md"],

  // Knowledge — procedures (demote from enforce to reference)
  [
    "sop/sync-protocol.md",
    "knowledge/procedures/sync-protocol.md",
    "reference",
  ],
  [
    "sop/northstar-sync-protocol.md",
    "knowledge/procedures/northstar-sync-protocol.md",
    "reference",
  ],
  [
    "sop/telegram-logging-hook.md",
    "knowledge/procedures/telegram-logging-hook.md",
  ],
  [
    "context/obsidian-sync-protocol.md",
    "knowledge/procedures/obsidian-sync-protocol.md",
    "reference",
  ],

  // Knowledge — people
  ["context/user-summary.md", "knowledge/people/fede-summary.md"],

  // Knowledge — domain
  ["schedules/active.md", "knowledge/domain/active-schedules.md", "reference"],

  // Projects
  ["context/proyecto-cmll.md", "projects/cmll-gira-estrellas/README.md"],
  ["VPS/ASSESSMENT.md", "projects/agent-controller/vps-assessment.md"],
  ["VPS/ROADMAP.md", "projects/agent-controller/vps-roadmap.md"],
  [
    "docs/metricas-alfa-a-beta.md",
    "projects/agent-controller/metricas-alfa-a-beta.md",
  ],
  [
    "projects/agent-controller-v5-status.md",
    "projects/agent-controller/v5-status.md",
  ],

  // Logs — day logs
  ["memory/day-logs/2026-04-02.md", "logs/day-logs/2026-04-02.md"],
  ["memory/day-logs/2026-04-03.md", "logs/day-logs/2026-04-03.md"],
  ["memory/day-logs/2026-04-04.md", "logs/day-logs/2026-04-04.md"],
];

// Deletes: redundant files replaced by INDEX.md or no longer needed
const DELETES = [
  "MEMORY.md",
  "STRUCTURE.md",
  "context/projects.md",
  "context/user-profile.md", // 94KB redundant dump of user_facts
];

// Qualifier demotions (no path change)
const QUALIFIER_CHANGES: Array<[string, string]> = [
  ["NorthStar/INDEX.md", "reference"], // was always-read, Jarvis reads on demand
];

// ---------------------------------------------------------------------------
// Dynamic mappings: auto-persist/*, logs/raw/*, daily/*, workspace/*
// ---------------------------------------------------------------------------

function getDynamicMoves(): Array<[string, string, string?]> {
  const moves: Array<[string, string, string?]> = [];

  // auto-persist/* → logs/sessions/*
  const autoPersist = db
    .prepare("SELECT path FROM jarvis_files WHERE path LIKE 'auto-persist/%'")
    .all() as Array<{ path: string }>;
  for (const { path } of autoPersist) {
    const filename = path.replace("auto-persist/", "");
    moves.push([path, `logs/sessions/${filename}`]);
  }

  // logs/raw/* → logs/sessions/*
  const logsRaw = db
    .prepare("SELECT path FROM jarvis_files WHERE path LIKE 'logs/raw/%'")
    .all() as Array<{ path: string }>;
  for (const { path } of logsRaw) {
    const filename = path.replace("logs/raw/", "");
    moves.push([path, `logs/sessions/${filename}`]);
  }

  // daily/* → logs/sessions/*
  const daily = db
    .prepare("SELECT path FROM jarvis_files WHERE path LIKE 'daily/%'")
    .all() as Array<{ path: string }>;
  for (const { path } of daily) {
    const filename = path.replace("daily/", "");
    moves.push([path, `logs/sessions/${filename}`]);
  }

  // workspace/* → inbox/*
  const workspace = db
    .prepare("SELECT path FROM jarvis_files WHERE path LIKE 'workspace/%'")
    .all() as Array<{ path: string }>;
  for (const { path } of workspace) {
    const filename = path.replace("workspace/", "");
    moves.push([path, `inbox/${filename}`]);
  }

  // research/* → projects/cuatro-flor/research/*
  const research = db
    .prepare("SELECT path FROM jarvis_files WHERE path LIKE 'research/%'")
    .all() as Array<{ path: string }>;
  for (const { path } of research) {
    moves.push([path, `projects/cuatro-flor/${path}`]);
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Execute migration
// ---------------------------------------------------------------------------

const allMoves = [...MOVES, ...getDynamicMoves()];

console.log(
  `[migrate] ${allMoves.length} moves, ${DELETES.length} deletes, ${QUALIFIER_CHANGES.length} qualifier changes`,
);

const moveStmt = db.prepare(
  "UPDATE jarvis_files SET path = ?, id = ? WHERE path = ?",
);
const qualifierStmt = db.prepare(
  "UPDATE jarvis_files SET qualifier = ? WHERE path = ?",
);
const deleteStmt = db.prepare("DELETE FROM jarvis_files WHERE path = ?");

let moved = 0;
let deleted = 0;
let qualChanged = 0;
let skipped = 0;

db.transaction(() => {
  // Moves
  for (const [oldPath, newPath, newQualifier] of allMoves) {
    const sourceExists = db
      .prepare("SELECT 1 FROM jarvis_files WHERE path = ?")
      .get(oldPath);
    if (!sourceExists) {
      skipped++;
      continue;
    }
    // If target already exists, delete the source (target wins — it's newer)
    const targetExists = db
      .prepare("SELECT 1 FROM jarvis_files WHERE path = ?")
      .get(newPath);
    if (targetExists) {
      deleteStmt.run(oldPath);
      if (newQualifier) {
        qualifierStmt.run(newQualifier, newPath);
      }
      moved++;
      continue;
    }
    moveStmt.run(newPath, newPath, oldPath);
    if (newQualifier) {
      qualifierStmt.run(newQualifier, newPath);
    }
    moved++;
  }

  // Deletes
  for (const path of DELETES) {
    const result = deleteStmt.run(path);
    if (result.changes > 0) deleted++;
  }

  // Qualifier changes (no path change)
  for (const [path, newQualifier] of QUALIFIER_CHANGES) {
    const result = qualifierStmt.run(newQualifier, path);
    if (result.changes > 0) qualChanged++;
  }

  // Clean up signal digest bloat from user_facts
  const factResult = db
    .prepare(
      `DELETE FROM user_facts WHERE
        key LIKE '%signal_digest%' OR
        key LIKE '%signal_scored%' OR
        key LIKE '%signal_intelligence%' OR
        key LIKE '%signals_digest%' OR
        key LIKE '%top_signals%' OR
        key LIKE '%structured_json_digest%' OR
        key LIKE '%email_body_spanish%'`,
    )
    .run();
  console.log(
    `[migrate] Cleaned ${factResult.changes} signal digest entries from user_facts`,
  );
})();

console.log(
  `[migrate] Done: ${moved} moved, ${deleted} deleted, ${qualChanged} qualifier changes, ${skipped} skipped (not found)`,
);

// Rebuild disk mirror
console.log("[migrate] Rebuilding disk mirror...");
try {
  rmSync(MIRROR_DIR, { recursive: true, force: true });
} catch {
  /* may not exist */
}

const allFiles = db
  .prepare("SELECT path, content FROM jarvis_files")
  .all() as Array<{ path: string; content: string }>;

for (const { path, content } of allFiles) {
  const fullPath = resolve(MIRROR_DIR, path);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  const { writeFileSync } = await import("fs");
  writeFileSync(fullPath, content, "utf-8");
}

console.log(`[migrate] Mirrored ${allFiles.length} files to ${MIRROR_DIR}`);

// Validate
const oldPaths = db
  .prepare(
    `SELECT path FROM jarvis_files WHERE
      path LIKE 'auto-persist/%' OR
      path LIKE 'context/%' OR
      path LIKE 'memory/%' OR
      path LIKE 'sop/%' OR
      path LIKE 'workspace/%' OR
      path LIKE 'daily/%' OR
      path LIKE 'docs/%' OR
      path LIKE 'VPS/%'`,
  )
  .all() as Array<{ path: string }>;

if (oldPaths.length > 0) {
  console.error(
    `[migrate] WARNING: ${oldPaths.length} files still at old paths:`,
    oldPaths.map((r) => r.path),
  );
} else {
  console.log("[migrate] ✓ All old paths migrated successfully");
}

db.close();
