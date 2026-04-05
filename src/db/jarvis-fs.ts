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

// Mirror to /root/claude/jarvis-kb/ — outside mission-control, in Jarvis's dominium.
// This is readable/writable by Jarvis's file_read/file_write tools.
const MIRROR_DIR = "/root/claude/jarvis-kb";

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
     ON CONFLICT(path) DO UPDATE SET
       id = excluded.id, title = excluded.title, content = excluded.content,
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

  // Debounced INDEX.md regeneration (skip if we're writing INDEX.md itself)
  if (path !== "INDEX.md") {
    import("./jarvis-index.js").then((m) => m.markIndexDirty()).catch(() => {});
  }
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

  if (path !== "INDEX.md") {
    import("./jarvis-index.js").then((m) => m.markIndexDirty()).catch(() => {});
  }
  return true;
}

/** Update file metadata (tags, qualifier, priority) without touching content. */
export function updateMetadata(
  path: string,
  updates: { tags?: string[]; qualifier?: string; priority?: number },
): boolean {
  const db = getDatabase();
  const existing = db
    .prepare(
      "SELECT tags, qualifier, priority FROM jarvis_files WHERE path = ?",
    )
    .get(path) as
    | { tags: string; qualifier: string; priority: number }
    | undefined;
  if (!existing) return false;

  const newTags = updates.tags ? JSON.stringify(updates.tags) : existing.tags;
  const newQualifier = updates.qualifier ?? existing.qualifier;
  const newPriority = updates.priority ?? existing.priority;

  db.prepare(
    "UPDATE jarvis_files SET tags = ?, qualifier = ?, priority = ?, updated_at = datetime('now') WHERE path = ?",
  ).run(newTags, newQualifier, newPriority, path);
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

/**
 * Move/rename a file atomically. Content never passes through the LLM.
 * Returns true if successful, false if source doesn't exist.
 */
export function moveFile(oldPath: string, newPath: string): boolean {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT * FROM jarvis_files WHERE path = ?")
    .get(oldPath) as JarvisFile | undefined;
  if (!existing) return false;

  // Check target doesn't already exist
  const targetExists = db
    .prepare("SELECT 1 FROM jarvis_files WHERE path = ?")
    .get(newPath);
  if (targetExists) {
    // Delete target first (overwrite)
    db.prepare("DELETE FROM jarvis_files WHERE path = ?").run(newPath);
  }

  db.prepare("UPDATE jarvis_files SET path = ?, id = ? WHERE path = ?").run(
    newPath,
    newPath,
    oldPath,
  );
  mirrorToDisk(newPath, existing.content);

  if (newPath !== "INDEX.md") {
    import("./jarvis-index.js").then((m) => m.markIndexDirty()).catch(() => {});
  }
  return true;
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

/**
 * Search files by content keyword. Returns paths + matching snippet.
 * Does NOT return full content — keeps LLM context light.
 */
export function searchFiles(
  query: string,
  limit: number = 20,
): Array<{ path: string; title: string; snippet: string; size: number }> {
  const db = getDatabase();
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT path, title, content, LENGTH(content) as size
       FROM jarvis_files
       WHERE content LIKE ? OR title LIKE ? OR path LIKE ?
       ORDER BY
         CASE WHEN path LIKE ? THEN 0
              WHEN title LIKE ? THEN 1
              ELSE 2 END,
         path ASC
       LIMIT ?`,
    )
    .all(
      `%${escaped}%`,
      `%${escaped}%`,
      `%${escaped}%`,
      `%${escaped}%`,
      `%${escaped}%`,
      limit,
    ) as Array<{ path: string; title: string; content: string; size: number }>;

  return rows.map((r) => {
    // Extract a snippet around the first match
    const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, idx - 50);
    const end = Math.min(r.content.length, idx + query.length + 50);
    const snippet =
      idx >= 0
        ? (start > 0 ? "..." : "") +
          r.content.slice(start, end).replace(/\n/g, " ") +
          (end < r.content.length ? "..." : "")
        : r.title;

    return { path: r.path, title: r.title, snippet, size: r.size };
  });
}

// ---------------------------------------------------------------------------
// Seed — called from initDatabase() on first boot
// ---------------------------------------------------------------------------

/** Create seed files if they don't exist. Idempotent. */
export function seedDirectives(): void {
  try {
    const db = getDatabase();

    // directives/core.md — core persona and SOPs (Unified FS)
    const directivesExist = db
      .prepare(
        "SELECT 1 FROM jarvis_files WHERE path = 'directives/core.md' OR path = 'DIRECTIVES.md'",
      )
      .get();
    if (!directivesExist) {
      upsertFile(
        "directives/core.md",
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
    }

    // directives/context-management.md — context pressure awareness (Unified FS)
    const ctxExists = db
      .prepare(
        "SELECT 1 FROM jarvis_files WHERE path = 'directives/context-management.md' OR path = 'sop/context-management.md'",
      )
      .get();
    if (!ctxExists) {
      upsertFile(
        "directives/context-management.md",
        "Context Management SOP",
        `# Gestión de Contexto

## Presión de Contexto
El sistema monitorea automáticamente el uso de tu ventana de contexto. Cuando recibes un aviso \`[CONTEXT ADVISORY]\`, significa que la conversación está usando >70% de la capacidad disponible.

## Qué hacer cuando recibes el aviso
1. **Sé más conciso.** Respuestas cortas y directas.
2. **En modo chat**, informa al usuario: "La conversación se está alargando. Para solicitudes complejas, te recomiendo enviar un nuevo mensaje."
3. **Prioriza la acción sobre la explicación.** Ejecuta tools en vez de describir lo que harías.
4. **No repitas información** que ya dijiste en turnos anteriores.

## Compactación automática
Si la presión sube a ~85%, el sistema compactará automáticamente:
- L0: Trunca resultados viejos de herramientas
- L1: Elimina pares antiguos de tool calls
- L2: Resumen LLM de la conversación media
- L3 (emergencia): Truncación determinista

Después de una compactación, el contexto anterior se resume. Los datos clave se preservan pero los detalles se pierden. Trabaja con lo disponible.

## Buenas prácticas
- Si una tarea requiere muchos rounds, usa \`jarvis_file_write\` para persistir hallazgos intermedios antes de que se compacten.
- Guarda conclusiones, no datos crudos. Los datos se pueden recuperar; las conclusiones no.`,
        ["directive", "sop", "context"],
        "always-read",
        5,
      );
    }

    // Generate INDEX.md on boot
    import("./jarvis-index.js")
      .then((m) => m.regenerateIndex())
      .catch(() => {});
  } catch {
    // DB may not have the table yet on very first init
  }
}
