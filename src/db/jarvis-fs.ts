/**
 * Jarvis File System — Layer 0 infrastructure.
 *
 * Persistent, tagged, priority-ordered knowledge base backed by SQLite.
 * This is the foundation layer — memory modules write here, intelligence
 * modules read from here, tools expose it to the LLM.
 *
 * All files are Markdown (.md). SQLite is source of truth; filesystem
 * mirror at data/jarvis/ for human inspection.
 */

import { getDatabase } from "./index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const MIRROR_DIR = join(process.cwd(), "data", "jarvis");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JarvisFile {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string;
  qualifier: string;
  condition: string | null;
  priority: number;
  related_to: string;
  created_at: string;
  updated_at: string;
}

export interface JarvisFileSummary {
  path: string;
  title: string;
  content: string;
  qualifier: string;
  condition: string | null;
  priority: number;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/** Mirror a file to the filesystem for human inspection. Non-fatal. */
export function mirrorToDisk(path: string, content: string): void {
  try {
    const fullPath = join(MIRROR_DIR, path);
    if (!fullPath.startsWith(MIRROR_DIR)) return;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  } catch {
    // Non-fatal — SQLite is source of truth
  }
}

/** Upsert a file. SQLite write + filesystem mirror. */
export function upsertFile(
  path: string,
  title: string,
  content: string,
  tags: string[] = [],
  qualifier = "reference",
  priority = 50,
  condition: string | null = null,
  relatedTo: string[] = [],
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, condition, priority, related_to, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, title = excluded.title, content = excluded.content,
       tags = excluded.tags, qualifier = excluded.qualifier, condition = excluded.condition,
       priority = excluded.priority, related_to = excluded.related_to, updated_at = datetime('now')`,
  ).run(
    path,
    path,
    title,
    content,
    JSON.stringify(tags),
    qualifier,
    condition,
    priority,
    JSON.stringify(relatedTo),
  );
  mirrorToDisk(path, content);
}

/** Get a file by path. Returns null if not found. */
export function getFile(path: string): JarvisFile | null {
  const db = getDatabase();
  return (
    (db.prepare("SELECT * FROM jarvis_files WHERE path = ?").get(path) as
      | JarvisFile
      | undefined) ?? null
  );
}

/** Get files by qualifier, ordered by priority. Used by auto-injection. */
export function getFilesByQualifier(
  ...qualifiers: string[]
): JarvisFileSummary[] {
  const db = getDatabase();
  const placeholders = qualifiers.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT path, title, content, qualifier, condition, priority
       FROM jarvis_files
       WHERE qualifier IN (${placeholders})
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(...qualifiers) as JarvisFileSummary[];
}

/** Append content to a file. Returns false if file not found. */
export function appendToFile(path: string, content: string): boolean {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT content FROM jarvis_files WHERE path = ?")
    .get(path) as { content: string } | undefined;
  if (!existing) return false;

  const newContent = `${existing.content}\n\n${content}`;
  db.prepare(
    "UPDATE jarvis_files SET content = ?, updated_at = datetime('now') WHERE path = ?",
  ).run(newContent, path);
  mirrorToDisk(path, newContent);
  return true;
}

/** Delete a file. Returns false if not found. */
export function deleteFile(path: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("DELETE FROM jarvis_files WHERE path = ?")
    .run(path);
  return result.changes > 0;
}

/** List all files, optionally filtered. */
export function listFiles(filters?: {
  prefix?: string;
  qualifier?: string;
  tags?: string[];
}): Array<{
  path: string;
  title: string;
  tags: string[];
  qualifier: string;
  priority: number;
  size: number;
  updated_at: string;
}> {
  const db = getDatabase();
  let sql =
    "SELECT path, title, tags, qualifier, priority, length(content) as size, updated_at FROM jarvis_files";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.prefix) {
    conditions.push("path LIKE ?");
    const escaped = filters.prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
    params.push(`${escaped}%`);
  }
  if (filters?.qualifier) {
    conditions.push("qualifier = ?");
    params.push(filters.qualifier);
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY priority ASC, path ASC";

  let results = db.prepare(sql).all(...params) as Array<{
    path: string;
    title: string;
    tags: string;
    qualifier: string;
    priority: number;
    size: number;
    updated_at: string;
  }>;

  if (filters?.tags && filters.tags.length > 0) {
    const searchTags = filters.tags;
    results = results.filter((f) => {
      try {
        const fileTags = JSON.parse(f.tags) as string[];
        return searchTags.some((t) => fileTags.includes(t));
      } catch {
        return false;
      }
    });
  }

  return results.map((r) => ({
    ...r,
    tags: JSON.parse(r.tags) as string[],
  }));
}

// ---------------------------------------------------------------------------
// Seed — called from initDatabase() on first boot
// ---------------------------------------------------------------------------

/** Create DIRECTIVES.md if it doesn't exist. Idempotent. */
export function seedDirectives(): void {
  try {
    const db = getDatabase();
    const exists = db
      .prepare("SELECT 1 FROM jarvis_files WHERE path = 'DIRECTIVES.md'")
      .get();
    if (exists) return;

    upsertFile(
      "DIRECTIVES.md",
      "Jarvis Core Directives",
      `# Jarvis Core Directives

## Persona
Eres Jarvis, el asistente estratégico personal de Fede (Federico). Habla en español mexicano, conciso y orientado a la acción.

## SOPs
1. **Verifica antes de afirmar.** Usa task_history para verificar qué hiciste, no inventes.
2. **No alucines acciones.** Si no llamaste un tool, no digas que lo hiciste.
3. **Usa tu sistema de archivos.** Lee DIRECTIVES.md y archivos relevantes antes de actuar.
4. **Reporta limitaciones.** Si algo falló, dilo. No encubras errores.
5. **Actualiza tu conocimiento.** Cuando aprendas algo nuevo, guárdalo con jarvis_file_write.`,
      ["directive", "persona", "sop"],
      "enforce",
      0,
    );
  } catch {
    // DB may not have the table yet on very first init
  }
}
