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
import { errMsg } from "../lib/err-msg.js";

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
 * Infer the KB section from a file path.
 * Used to populate the `section` frontmatter field for Obsidian filtering.
 */
export function inferSection(path: string): string {
  const top = path.split("/")[0];
  const sectionMap: Record<string, string> = {
    projects: "projects",
    knowledge: "knowledge",
    NorthStar: "NorthStar",
    directives: "directives",
    logs: "logs",
    workspace: "workspace",
    skills: "skills",
    tuning: "tuning",
    inbox: "inbox",
    VPS: "VPS",
  };
  return sectionMap[top] ?? "root";
}

/**
 * Infer the parent path for a file — used to auto-generate a parent wikilink.
 *
 * Rules:
 * - `projects/{slug}/notes/x.md`   → `projects/{slug}/README`
 * - `projects/{slug}/x.md`         → `projects/{slug}/README`  (unless IS the README)
 * - `knowledge/{sub}/x.md`         → `knowledge/{sub}`  (virtual folder node)
 * - `NorthStar/{sub}/x.md`         → `NorthStar/{sub}`
 * - top-level or no parent logic   → null
 */
export function inferParentPath(path: string): string | null {
  const parts = path.replace(/\.md$/, "").split("/");
  if (parts.length < 2) return null;

  const [top, slug, ...rest] = parts;

  // projects/{slug}/README.md — no parent (IS the root of the project)
  if (top === "projects" && rest.length === 0 && slug === "README") return null;

  // projects/{slug}/anything → README of that project
  if (top === "projects" && slug) {
    const readmePath = `projects/${slug}/README`;
    // Don't link to self
    if (path === `projects/${slug}/README.md`) return null;
    return readmePath;
  }

  // knowledge/{sub}/x.md → knowledge/{sub}  (use folder name as virtual node)
  if (top === "knowledge" && rest.length > 0) {
    return `knowledge/${slug}`;
  }

  // NorthStar/{sub}/x.md → NorthStar/{sub}
  if (top === "NorthStar" && rest.length > 0) {
    return `NorthStar/${slug}`;
  }

  return null;
}

/**
 * Scan the file content for bare KB paths (e.g. "projects/foo/README.md") and
 * convert any that are NOT already inside a [[wikilink]] to [[wikilink]] format.
 * This makes implicit cross-references visible in the Obsidian graph.
 *
 * Only activates for paths that look like real KB paths (contain "/" and end
 * with ".md"). Avoids false positives on URLs (http/https) and existing wikilinks.
 */
export function injectContentWikilinks(content: string): string {
  // Match bare KB paths not already inside [[ ]]
  const KB_PATH_RE =
    /(?<!\[\[)((?:projects|knowledge|NorthStar|directives|logs|workspace|skills|tuning|inbox)\/[a-zA-Z0-9_\-./]+\.md)(?!\]\])/g;

  return content.replace(KB_PATH_RE, (match) => {
    const withoutExt = match.replace(/\.md$/, "");
    const display = withoutExt.split("/").pop() ?? withoutExt;
    return `[[${withoutExt}|${display}]]`;
  });
}

/**
 * Transform content into Obsidian-native markdown:
 * - Prepend YAML frontmatter (title, qualifier, priority, section, parent, tags, path, updated)
 * - Inject [[wikilinks]] for bare KB paths found in the content body
 * - Append ## Related section: inferred parent + explicit relatedTo entries
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
  const section = inferSection(path);
  const parentPath = inferParentPath(path);

  let yaml = "---\n";
  yaml += `title: "${title.replace(/"/g, '\\"')}"\n`;
  yaml += `qualifier: ${qualifier}\n`;
  yaml += `priority: ${priority}\n`;
  yaml += `section: ${section}\n`;
  if (parentPath) {
    yaml += `parent: "[[${parentPath}]]"\n`;
  }
  if (metadata?.tags?.length) {
    yaml += `tags: [${metadata.tags.join(", ")}]\n`;
  }
  if (metadata?.condition) {
    yaml += `condition: "${metadata.condition.replace(/"/g, '\\"')}"\n`;
  }
  yaml += `path: "${path}"\n`;
  yaml += `updated: ${date}\n`;
  yaml += "---\n\n";

  // --- Inject wikilinks for bare KB paths in content ---
  const enrichedContent = injectContentWikilinks(content);

  let result = yaml + enrichedContent;

  // --- Related section: inferred parent + explicit relatedTo ---
  const relatedLinks: string[] = [];

  // Inferred parent first (if not already in relatedTo)
  if (parentPath) {
    const parentMd = `${parentPath}.md`;
    const alreadyIncluded = metadata?.relatedTo?.some(
      (r) => r === parentMd || r === parentPath,
    );
    if (!alreadyIncluded) {
      const display = parentPath.split("/").pop() ?? parentPath;
      relatedLinks.push(`- [[${parentPath}|${display}]]`);
    }
  }

  // Explicit relatedTo entries
  if (metadata?.relatedTo?.length) {
    for (const p of metadata.relatedTo) {
      const withoutExt = p.replace(/\.md$/, "");
      const display = withoutExt.split("/").pop() ?? withoutExt;
      relatedLinks.push(`- [[${withoutExt}|${display}]]`);
    }
  }

  if (relatedLinks.length > 0) {
    result += `\n\n## Related\n${relatedLinks.join("\n")}\n`;
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
        errMsg(err),
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
        errMsg(err),
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
        errMsg(err),
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
        errMsg(err),
      );
      failed++;
    }
  }

  console.log(
    `[drive-sync] Reformat complete: ${updated} updated, ${skipped} no drive_id, ${failed} failed`,
  );
  return { updated, skipped, failed };
}
