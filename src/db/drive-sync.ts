/**
 * Google Drive sync — mirrors jarvis_files to a Drive folder for Obsidian.
 *
 * Maintains a mapping (SQLite table: drive_file_map) of jarvis_files paths
 * to Drive file IDs. On upsert: creates or updates the Drive file.
 * On delete: trashes the Drive file.
 *
 * All operations are fire-and-forget — failures never block the SQLite write.
 * Drive folder structure mirrors jarvis_files paths (subfolders created on demand).
 */

import { googleFetch } from "../google/client.js";
import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Root folder ID — "Jarvis Knowledge Base" in peter.blades@gmail.com Drive. */
const ROOT_FOLDER_ID = process.env.DRIVE_KB_FOLDER_ID ?? "";

// ---------------------------------------------------------------------------
// Obsidian-native content transformation
// ---------------------------------------------------------------------------

/** Metadata passed from jarvis-fs to enrich Drive copies for Obsidian. */
export interface DriveMetadata {
  tags?: string[];
  qualifier?: string;
  priority?: number;
  condition?: string | null;
  relatedTo?: string[];
}

/**
 * Transform content into Obsidian-native markdown:
 * - Prepend YAML frontmatter (title, tags, qualifier, priority, date)
 * - Append [[wikilinks]] section from related_to references
 *
 * Exported for testing. Only applied to Drive copies — SQLite content is untouched.
 */
export function toObsidianContent(
  path: string,
  title: string,
  content: string,
  metadata?: DriveMetadata,
): string {
  // --- YAML frontmatter ---
  const qualifier = metadata?.qualifier ?? "reference";
  const priority = metadata?.priority ?? 50;
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Mexico_City",
  });

  let yaml = "---\n";
  yaml += `title: "${title.replace(/"/g, '\\"')}"\n`;
  yaml += `qualifier: ${qualifier}\n`;
  yaml += `priority: ${priority}\n`;
  if (metadata?.tags?.length) {
    yaml += `tags: [${metadata.tags.join(", ")}]\n`;
  }
  if (metadata?.condition) {
    yaml += `condition: "${metadata.condition.replace(/"/g, '\\"')}"\n`;
  }
  yaml += `path: ${path}\n`;
  yaml += `updated: ${date}\n`;
  yaml += "---\n\n";

  let result = yaml + content;

  // --- Wikilinks from related_to ---
  if (metadata?.relatedTo?.length) {
    const links = metadata.relatedTo
      .map((p) => {
        const display = p.replace(/\.md$/, "").split("/").pop() ?? p;
        return `- [[${p.replace(/\.md$/, "")}|${display}]]`;
      })
      .join("\n");
    result += `\n\n## Related\n${links}\n`;
  }

  return result;
}

/** Cache of path-prefix → Drive folder ID (avoids repeated lookups). */
const folderCache = new Map<string, string>();

export function isDriveSyncEnabled(): boolean {
  return !!ROOT_FOLDER_ID;
}

// ---------------------------------------------------------------------------
// Drive file map (SQLite)
// ---------------------------------------------------------------------------

function ensureMapTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_file_map (
      path TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function getDriveId(path: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT drive_id FROM drive_file_map WHERE path = ?")
    .get(path) as { drive_id: string } | undefined;
  return row?.drive_id ?? null;
}

function setDriveId(path: string, driveId: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO drive_file_map (path, drive_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET drive_id = excluded.drive_id, updated_at = datetime('now')`,
  ).run(path, driveId);
}

function removeDriveId(path: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM drive_file_map WHERE path = ?").run(path);
}

// ---------------------------------------------------------------------------
// Folder management — create Drive folders matching path hierarchy
// ---------------------------------------------------------------------------

/**
 * Ensure a folder exists in Drive for the given directory path.
 * Creates intermediate folders as needed. Returns the folder's Drive ID.
 */
async function ensureFolder(dirPath: string): Promise<string> {
  if (!dirPath || dirPath === ".") return ROOT_FOLDER_ID;

  // Check cache first
  const cached = folderCache.get(dirPath);
  if (cached) return cached;

  // Split into segments and create each level
  const segments = dirPath.split("/").filter(Boolean);
  let parentId = ROOT_FOLDER_ID;

  for (let i = 0; i < segments.length; i++) {
    const partialPath = segments.slice(0, i + 1).join("/");
    const cachedPartial = folderCache.get(partialPath);
    if (cachedPartial) {
      parentId = cachedPartial;
      continue;
    }

    // Search for existing folder
    const query = `name='${segments[i]}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`;

    const search = await googleFetch<{ files: Array<{ id: string }> }>(
      searchUrl,
    );

    if (search.files.length > 0) {
      parentId = search.files[0].id;
    } else {
      // Create folder
      const created = await googleFetch<{ id: string }>(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          body: {
            name: segments[i],
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentId],
          },
        },
      );
      parentId = created.id;
    }

    folderCache.set(partialPath, parentId);
  }

  return parentId;
}

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

/**
 * Sync a jarvis_files upsert to Google Drive (fire-and-forget).
 * Creates the file if new, updates content if existing.
 * Applies Obsidian-native transformation (frontmatter + wikilinks).
 */
export function syncToDrive(
  path: string,
  title: string,
  content: string,
  driveMetadata?: DriveMetadata,
): void {
  if (!isDriveSyncEnabled()) return;

  (async () => {
    try {
      ensureMapTable();
      const obsidianContent = toObsidianContent(
        path,
        title,
        content,
        driveMetadata,
      );
      const existingDriveId = getDriveId(path);

      if (existingDriveId) {
        // UPDATE existing file
        await googleFetch(
          `https://www.googleapis.com/upload/drive/v3/files/${existingDriveId}?uploadType=media`,
          {
            method: "PATCH",
            rawBody: obsidianContent,
            contentType: "text/markdown",
          },
        );
      } else {
        // CREATE new file — ensure parent folder exists
        const dirPath = path.includes("/")
          ? path.slice(0, path.lastIndexOf("/"))
          : "";
        const parentId = await ensureFolder(dirPath);
        const fileName = path.includes("/")
          ? path.slice(path.lastIndexOf("/") + 1)
          : path;

        const boundary = "jarvis_drive_sync";
        const fileMeta = JSON.stringify({
          name: fileName,
          mimeType: "text/markdown",
          parents: [parentId],
        });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${fileMeta}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: text/markdown\r\n\r\n` +
          `${obsidianContent}\r\n` +
          `--${boundary}--`;

        const result = await googleFetch<{ id: string }>(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
          {
            method: "POST",
            rawBody: body,
            contentType: `multipart/related; boundary=${boundary}`,
          },
        );
        setDriveId(path, result.id);
      }
    } catch (err) {
      console.warn(
        `[drive-sync] Failed for ${path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/**
 * Sync a jarvis_files delete to Google Drive (fire-and-forget).
 * Moves the Drive file to trash.
 */
export function syncDeleteToDrive(path: string): void {
  if (!isDriveSyncEnabled()) return;

  (async () => {
    try {
      ensureMapTable();
      const driveId = getDriveId(path);
      if (!driveId) return;

      await googleFetch(
        `https://www.googleapis.com/drive/v3/files/${driveId}`,
        { method: "PATCH", body: { trashed: true } },
      );
      removeDriveId(path);
    } catch (err) {
      console.warn(
        `[drive-sync] Delete failed for ${path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Backfill — one-time upload of all existing files
// ---------------------------------------------------------------------------

/**
 * Upload all jarvis_files to Drive. Skips files that already have a drive_id.
 * Call once to initialize, then syncToDrive handles ongoing changes.
 */
export async function backfillToDrive(): Promise<{
  uploaded: number;
  skipped: number;
  failed: number;
}> {
  if (!isDriveSyncEnabled()) {
    console.warn("[drive-sync] DRIVE_KB_FOLDER_ID not set, skipping backfill");
    return { uploaded: 0, skipped: 0, failed: 0 };
  }

  ensureMapTable();
  const db = getDatabase();
  const files = db
    .prepare(
      "SELECT id, path, title, content, tags, qualifier, priority, condition, related_to FROM jarvis_files ORDER BY path",
    )
    .all() as Array<{
    id: string;
    path: string;
    title: string;
    content: string;
    tags: string;
    qualifier: string;
    priority: number;
    condition: string | null;
    related_to: string;
  }>;

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const existingDriveId = getDriveId(file.path);
    if (existingDriveId) {
      skipped++;
      continue;
    }

    try {
      const dirPath = file.path.includes("/")
        ? file.path.slice(0, file.path.lastIndexOf("/"))
        : "";
      const parentId = await ensureFolder(dirPath);
      const fileName = file.path.includes("/")
        ? file.path.slice(file.path.lastIndexOf("/") + 1)
        : file.path;

      const obsidianContent = toObsidianContent(
        file.path,
        file.title,
        file.content,
        {
          tags: JSON.parse(file.tags || "[]"),
          qualifier: file.qualifier,
          priority: file.priority,
          condition: file.condition,
          relatedTo: JSON.parse(file.related_to || "[]"),
        },
      );

      const boundary = "jarvis_backfill";
      const fileMeta = JSON.stringify({
        name: fileName,
        mimeType: "text/markdown",
        parents: [parentId],
      });
      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${fileMeta}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/markdown\r\n\r\n` +
        `${obsidianContent}\r\n` +
        `--${boundary}--`;

      const result = await googleFetch<{ id: string }>(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
        {
          method: "POST",
          rawBody: body,
          contentType: `multipart/related; boundary=${boundary}`,
          timeout: 30_000,
        },
      );
      setDriveId(file.path, result.id);
      uploaded++;

      // Rate limiting — avoid Drive API quota (300 req/min)
      if (uploaded % 50 === 0) {
        console.log(
          `[drive-sync] Backfill progress: ${uploaded}/${files.length}`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.warn(
        `[drive-sync] Backfill failed for ${file.path}:`,
        err instanceof Error ? err.message : err,
      );
      failed++;
    }
  }

  console.log(
    `[drive-sync] Backfill complete: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`,
  );
  return { uploaded, skipped, failed };
}

/**
 * Reformat all existing Drive files with Obsidian-native content.
 * Updates files that already have a drive_id with current frontmatter + wikilinks.
 * Use after changing the toObsidianContent format.
 */
export async function reformatDriveFiles(): Promise<{
  updated: number;
  skipped: number;
  failed: number;
}> {
  if (!isDriveSyncEnabled()) {
    console.warn("[drive-sync] DRIVE_KB_FOLDER_ID not set, skipping reformat");
    return { updated: 0, skipped: 0, failed: 0 };
  }

  ensureMapTable();
  const db = getDatabase();
  const files = db
    .prepare(
      "SELECT id, path, title, content, tags, qualifier, priority, condition, related_to FROM jarvis_files ORDER BY path",
    )
    .all() as Array<{
    id: string;
    path: string;
    title: string;
    content: string;
    tags: string;
    qualifier: string;
    priority: number;
    condition: string | null;
    related_to: string;
  }>;

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const driveId = getDriveId(file.path);
    if (!driveId) {
      skipped++;
      continue;
    }

    try {
      const obsidianContent = toObsidianContent(
        file.path,
        file.title,
        file.content,
        {
          tags: JSON.parse(file.tags || "[]"),
          qualifier: file.qualifier,
          priority: file.priority,
          condition: file.condition,
          relatedTo: JSON.parse(file.related_to || "[]"),
        },
      );

      await googleFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${driveId}?uploadType=media`,
        {
          method: "PATCH",
          rawBody: obsidianContent,
          contentType: "text/markdown",
          timeout: 30_000,
        },
      );
      updated++;

      // Rate limiting — avoid Drive API quota (300 req/min)
      if (updated % 50 === 0) {
        console.log(
          `[drive-sync] Reformat progress: ${updated}/${files.length}`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.warn(
        `[drive-sync] Reformat failed for ${file.path}:`,
        err instanceof Error ? err.message : err,
      );
      failed++;
    }
  }

  console.log(
    `[drive-sync] Reformat complete: ${updated} updated, ${skipped} no drive_id, ${failed} failed`,
  );
  return { updated, skipped, failed };
}
