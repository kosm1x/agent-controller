/**
 * Jarvis Knowledge Base INDEX.md — auto-generated map of the file system.
 *
 * Regenerated on a debounced schedule after file writes.
 * Always-read, priority 1 — injected into every prompt.
 * Must stay compact (~800 chars) to fit within KB_CHAR_BUDGET.
 */

import { getDatabase } from "./index.js";
import { upsertFile } from "./jarvis-fs.js";

let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 5_000;

/**
 * Regenerate INDEX.md from the current jarvis_files table.
 * Groups files by top-level directory, counts files and bytes.
 */
export function regenerateIndex(): void {
  try {
    const db = getDatabase();

    // Count files by top-level directory
    const rows = db
      .prepare(
        `SELECT
           CASE
             WHEN INSTR(path, '/') > 0 THEN SUBSTR(path, 1, INSTR(path, '/') - 1)
             ELSE '(root)'
           END as dir,
           COUNT(*) as cnt,
           SUM(LENGTH(content)) as bytes
         FROM jarvis_files
         GROUP BY dir
         ORDER BY cnt DESC`,
      )
      .all() as Array<{ dir: string; cnt: number; bytes: number }>;

    // Get active projects (files under projects/)
    const projects = db
      .prepare(
        `SELECT DISTINCT
           CASE
             WHEN INSTR(SUBSTR(path, 10), '/') > 0
               THEN SUBSTR(path, 10, INSTR(SUBSTR(path, 10), '/') - 1)
             ELSE SUBSTR(path, 10)
           END as name
         FROM jarvis_files
         WHERE path LIKE 'projects/%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const totalFiles = rows.reduce((sum, r) => sum + r.cnt, 0);
    const totalKB = Math.round(
      rows.reduce((sum, r) => sum + r.bytes, 0) / 1024,
    );

    const now = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    });

    // Build compact INDEX
    const dirLines = rows
      .filter((r) => r.dir !== "(root)")
      .map((r) => `- ${r.dir}/ (${r.cnt})`)
      .join("\n");

    const projectLines =
      projects.length > 0
        ? projects.map((p) => `- ${p.name}/`).join("\n")
        : "- (ninguno)";

    const content = `# Jarvis Knowledge Base

## Estructura (${totalFiles} archivos, ${totalKB}KB)
${dirLines}

## Proyectos Activos
${projectLines}

## Cómo navegar
- jarvis_file_list con prefix="NorthStar/" para metas
- jarvis_file_list con prefix="projects/{nombre}/" para un proyecto
- jarvis_file_list con prefix="knowledge/" para conocimiento
- jarvis_file_read para leer cualquier archivo

Última actualización: ${now}`;

    upsertFile(
      "INDEX.md",
      "Jarvis Knowledge Base Index",
      content,
      ["index", "navigation"],
      "always-read",
      1,
    );
  } catch (err) {
    console.warn(
      "[jarvis-index] Failed to regenerate INDEX.md:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Mark INDEX.md as dirty — will regenerate within 5 seconds. */
export function markIndexDirty(): void {
  if (dirtyTimer) return; // already scheduled
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    regenerateIndex();
  }, DEBOUNCE_MS);
}

/** Cancel pending regeneration (for shutdown). */
export function cancelPendingRegeneration(): void {
  if (dirtyTimer) {
    clearTimeout(dirtyTimer);
    dirtyTimer = null;
  }
}
