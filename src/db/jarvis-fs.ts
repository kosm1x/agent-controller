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
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { syncToPgvector, syncDeleteToPgvector } from "./pgvector-sync.js";
import type { DriveMetadata } from "./drive-sync.js";
import { syncToDrive, syncDeleteToDrive } from "./drive-sync.js";

// Mirror to /root/claude/jarvis-kb/ — outside mission-control, in Jarvis's dominium.
// This is readable/writable by Jarvis's file_read/file_write tools.
// Env-overridable so tests can redirect to a temp dir; before this override
// existed, the northstar-sync test suite was leaving 200+ stale `*--new.md`
// fixtures in the live KB, polluting Jarvis's view of his own files.
const DEFAULT_MIRROR_DIR = "/root/claude/jarvis-kb";
function getMirrorDir(): string {
  return process.env.JARVIS_KB_MIRROR_DIR ?? DEFAULT_MIRROR_DIR;
}

/**
 * Public helper for tools that need the Jarvis KB root path. Picks up
 * JARVIS_KB_MIRROR_DIR overrides at call time (not module load) so tests
 * setting the env in beforeEach take effect. Queue #11, 2026-05-07.
 */
export function getJarvisKbRoot(): string {
  return getMirrorDir();
}

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
  user_edit_time: string | null;
}

export interface UpsertFileOptions {
  /** When true, do not bump user_edit_time (use for sync-driven writes). */
  skipUserEdit?: boolean;
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

/**
 * Best-effort delete on the FS mirror. Symmetric companion to mirrorToDisk
 * so that deleteFile() in SQLite also clears the FS-side representation.
 *
 * Before this existed, `deleteFile()` propagated to pgvector + Drive but
 * NOT to /root/claude/jarvis-kb/. The hourly kb-reindex ritual walks that
 * FS mirror and upserts anything missing back into jarvis_files, which
 * resurrected every operator-triggered NorthStar wipe within the hour
 * (2026-05-12 incident). Symmetric deletes close that loop.
 *
 * Path-traversal guarded: resolved absolute path must remain under the
 * mirror root, else the operation is a silent no-op.
 */
export function syncDeleteFromKbMirror(path: string): void {
  try {
    // Reject empty / dot / absolute / parent-only paths up-front. Without
    // this, `resolve(mirrorDir, "")` and `resolve(mirrorDir, ".")` both
    // collapse to `mirrorDir` itself and `rmSync(mirrorDir)` would wipe the
    // entire KB mirror. Caught by qa-auditor C1, 2026-05-12.
    if (!path || path === "." || path === "/" || path.startsWith("/")) return;
    const mirrorDir = getMirrorDir();
    const mirrorAbs = resolve(mirrorDir);
    const fullPath = resolve(mirrorAbs, path);
    // Strict containment: fullPath must be a STRICT child of mirrorAbs.
    // `=== mirrorAbs` is rejected (that's the mirror root itself).
    if (fullPath === mirrorAbs) return;
    if (!fullPath.startsWith(mirrorAbs + "/")) return;
    if (!existsSync(fullPath)) return;
    rmSync(fullPath, { force: true });
  } catch (err) {
    // Non-fatal. Same rationale as mirrorToDisk: SQLite is source of truth.
    console.warn(
      `[jarvis-fs] syncDeleteFromKbMirror failed for ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Mirror a file to the filesystem for human inspection. Non-fatal. */
export function mirrorToDisk(path: string, content: string): void {
  try {
    const mirrorDir = getMirrorDir();
    const fullPath = join(mirrorDir, path);
    if (!fullPath.startsWith(mirrorDir)) return;
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  } catch (err) {
    // Non-fatal — SQLite is source of truth — but log so divergence is
    // observable (audit Standards 7, 2026-05-07). The hourly KB reindexer
    // recovers the FS→DB direction, not DB→FS, so silent mirror failures
    // would let DB and FS drift indefinitely without any operator signal.
    console.warn(
      `[jarvis-fs] mirrorToDisk failed for ${path}: ${err instanceof Error ? err.message : err}`,
    );
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
  opts: UpsertFileOptions = {},
): void {
  const db = getDatabase();
  // Sync-driven writes (skipUserEdit=true) must not bump user_edit_time.
  // Real user edits (default) bump both updated_at and user_edit_time.
  if (opts.skipUserEdit) {
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
  } else {
    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, condition, priority, related_to, updated_at, user_edit_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         id = excluded.id, title = excluded.title, content = excluded.content,
         tags = excluded.tags, qualifier = excluded.qualifier, condition = excluded.condition,
         priority = excluded.priority, related_to = excluded.related_to,
         updated_at = datetime('now'), user_edit_time = datetime('now')`,
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
  }
  mirrorToDisk(path, content);

  // Dual-write to pgvector (fire-and-forget, async, non-blocking)
  syncToPgvector(path, title, content, tags, qualifier, priority, condition);

  // Sync to Google Drive for Obsidian (fire-and-forget, async, non-blocking)
  const driveMeta: DriveMetadata = {
    tags,
    qualifier,
    priority,
    condition,
    relatedTo,
  };
  syncToDrive(path, title, content, driveMeta);

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

  // Sync appended content to pgvector (re-embeds the full content)
  const meta = db
    .prepare(
      "SELECT title, qualifier, priority FROM jarvis_files WHERE path = ?",
    )
    .get(path) as
    | { title: string; qualifier: string; priority: number }
    | undefined;
  if (meta) {
    syncToPgvector(
      path,
      meta.title,
      newContent,
      [],
      meta.qualifier,
      meta.priority,
    );
  }

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
  if (result.changes > 0) {
    syncDeleteToPgvector(path);
    syncDeleteToDrive(path);
    syncDeleteFromKbMirror(path);
  }
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

  // Sync move to pgvector: delete old path, upsert new path
  syncDeleteToPgvector(oldPath);
  syncToPgvector(
    newPath,
    existing.title,
    existing.content,
    parseTagsSafe(existing.tags),
    existing.qualifier,
    existing.priority,
  );

  if (newPath !== "INDEX.md") {
    import("./jarvis-index.js").then((m) => m.markIndexDirty()).catch(() => {});
  }
  return true;
}

/** List all files, optionally filtered. */
/**
 * Parse a stored `tags` JSON value, degrading to [] on null/corrupt input.
 *
 * `tags` is written as JSON.stringify(string[]), but a row corrupted by an
 * accidental binary/NUL paste — the same class that produced a BLOB-content row
 * and broke the nightly kb-backup for 3+ days — can hold non-JSON. An unguarded
 * `JSON.parse` threw and aborted EVERY listFiles caller (kb-backup included) on
 * a single bad row, so treat unparseable tags as empty rather than fatal.
 */
function parseTagsSafe(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

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
      const fileTags = parseTagsSafe(f.tags);
      return searchTags.some((t) => fileTags.includes(t));
    });
  }

  return results.map((r) => ({
    ...r,
    tags: parseTagsSafe(r.tags),
  }));
}

/**
 * Build an FTS5 MATCH expression from a free-form user query.
 * Strategy: tokenize on whitespace + punctuation, drop empties, double-quote
 * each token to escape FTS5 syntax characters (parens/AND/OR/NEAR), and
 * join with implicit AND. Tokens shorter than 2 chars are dropped to avoid
 * unhelpful matches. Returns null if no usable tokens remain.
 */
function buildFtsMatch(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[\s,;:!?¡¿"'`()[\]{}<>—–\-]+/)
    .map((t) => t.replace(/[^a-z0-9_áéíóúüñ]/gi, ""))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  // Quote each token so FTS5 treats it as a literal (no operator parsing).
  // Append `*` to enable prefix matching ("uncharted" matches "uncharted_v2").
  return tokens.map((t) => `"${t}"*`).join(" ");
}

/**
 * Search files by tokenized full-text. Returns paths + matching snippet.
 * Does NOT return full content — keeps LLM context light.
 *
 * 2026-05-07: rewritten to use FTS5 (jarvis_files_fts). Previous LIKE-based
 * implementation required the literal phrase to appear verbatim, so
 * "uncharted OOH" missed "México Uncharted — OOH Intelligence" because of
 * the em-dash. FTS5 with the unicode61 tokenizer handles tokenization,
 * diacritics, and ranks by relevance via bm25(). Falls back to LIKE on
 * empty token set or FTS5 error to preserve the previous contract for
 * single-character / punctuation-only queries.
 */
export function searchFiles(
  query: string,
  limit: number = 20,
): Array<{ path: string; title: string; snippet: string; size: number }> {
  const db = getDatabase();
  const match = buildFtsMatch(query);

  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT f.path, f.title, f.content, LENGTH(f.content) AS size,
                  snippet(jarvis_files_fts, 1, '«', '»', '…', 16) AS snip
             FROM jarvis_files_fts
             JOIN jarvis_files f ON f.rowid = jarvis_files_fts.rowid
            WHERE jarvis_files_fts MATCH ?
            ORDER BY bm25(jarvis_files_fts), f.path ASC
            LIMIT ?`,
        )
        .all(match, limit) as Array<{
        path: string;
        title: string;
        content: string;
        size: number;
        snip: string;
      }>;
      if (rows.length > 0) {
        return rows.map((r) => ({
          path: r.path,
          title: r.title,
          snippet: r.snip || r.title,
          size: r.size,
        }));
      }
    } catch {
      // FTS5 may reject tokens that look like operators after sanitization;
      // fall through to LIKE so the caller still gets results.
    }
  }

  // Fallback: LIKE substring (preserves previous behavior for short/punct
  // queries and unblocks any FTS5 edge case).
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT path, title, content, LENGTH(content) AS size
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
