/**
 * Migration: split code-generation-sop.md into evergreen + project-evaluation journal.
 *
 * Applied live on 2026-04-26 (Session 109 follow-on, Prong B from the
 * KB-bloat audit). The original SOP (30.6 KB) was 88% project-evaluation
 * history (Williams Radar Phases 1–3, xpoz Phases 1–5). Even after
 * scope-conditional gating to `coding`, every coding task ate 30 KB of
 * stale evaluations.
 *
 * Split:
 *   - knowledge/procedures/code-generation-sop.md
 *     UPDATE content → evergreen-only (~4.9 KB): Pre-Code Protocol,
 *     Patrones, Checklist, Métricas, REGLA Post-Tarea
 *   - knowledge/journal/code-evaluations-2026.md (NEW)
 *     INSERT qualifier='reference' (NOT auto-injected): all per-project
 *     learnings + Evaluaciones #1–#11
 *
 * Source-of-truth fixtures live alongside this script:
 *   scripts/seed/code-generation-sop.evergreen.md
 *   scripts/seed/code-evaluations-2026.md
 *
 * Idempotent: INSERT uses WHERE NOT EXISTS via a SELECT guard; UPDATE
 * always replaces the SOP content. Safe to re-run on the same DB.
 *
 * Run: `npx tsx scripts/migrate-split-code-sop.ts`
 */

import { initDatabase, getDatabase } from "../src/db/index.js";
import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { join, resolve } from "path";

const DB_PATH = resolve(process.env.MC_DB_PATH ?? "./data/mc.db");
if (!existsSync(DB_PATH)) {
  console.error(
    `[migrate] FAIL: DB not found at ${DB_PATH}. Set MC_DB_PATH or run from mission-control project root.`,
  );
  process.exit(1);
}
initDatabase(DB_PATH);

const SEED_DIR = join(import.meta.dirname ?? __dirname, "seed");
const EVERGREEN = readFileSync(
  join(SEED_DIR, "code-generation-sop.evergreen.md"),
  "utf-8",
);
const JOURNAL = readFileSync(join(SEED_DIR, "code-evaluations.md"), "utf-8");

const JOURNAL_PATH = "knowledge/journal/code-evaluations.md";
const SOP_PATH = "knowledge/procedures/code-generation-sop.md";

function main(): void {
  const db = getDatabase();

  // INSERT OR IGNORE — race-free against the UNIQUE constraint on path.
  const insertResult = db
    .prepare(
      `INSERT OR IGNORE INTO jarvis_files
         (id, path, title, content, tags, qualifier, condition, priority, related_to, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'reference', NULL, 50, '[]', datetime('now'))`,
    )
    .run(
      randomUUID().replace(/-/g, "").slice(0, 16),
      JOURNAL_PATH,
      "Code Evaluations Journal",
      JOURNAL,
    );
  console.log(
    insertResult.changes === 1
      ? `[migrate] Inserted journal (${JOURNAL.length} chars)`
      : "[migrate] Journal already present — skipping insert",
  );

  const updateResult = db
    .prepare(
      `UPDATE jarvis_files
         SET content = ?, updated_at = datetime('now')
       WHERE path = ?`,
    )
    .run(EVERGREEN, SOP_PATH);

  if (updateResult.changes === 0) {
    console.error(
      `[migrate] FAIL: SOP row missing at ${SOP_PATH} — UPDATE matched 0 rows. ` +
        "The SOP must already exist in jarvis_files; this script edits content, it does not seed.",
    );
    process.exit(1);
  }
  console.log(
    `[migrate] SOP content replaced (${updateResult.changes} row, ${EVERGREEN.length} chars)`,
  );
}

main();
