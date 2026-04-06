/**
 * Per-Task Mutation Log (v6.2 S3)
 *
 * Records every file created/modified/deleted during a task.
 * Enables: rollback awareness, audit trails, mutation-based learning.
 *
 * Recording is centralized in the task executor wrapper — individual
 * tool handlers don't need modification.
 */

import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Schema (auto-created on first use)
// ---------------------------------------------------------------------------

let initialized = false;

function ensureTable(): void {
  if (initialized) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_mutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('create','modify','delete')),
      file_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_mutations_task ON task_mutations(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_mutations_path ON task_mutations(file_path);
  `);
  initialized = true;
}

// ---------------------------------------------------------------------------
// Tool → operation mapping
// ---------------------------------------------------------------------------

/** Map tool names to mutation operations. Returns null for non-mutating tools. */
export function classifyMutation(
  toolName: string,
  args: Record<string, unknown>,
): { operation: "create" | "modify" | "delete"; filePath: string } | null {
  // Filesystem write tools
  if (toolName === "file_write") {
    const path = (args.path ?? args.file_path) as string | undefined;
    if (!path) return null;
    // Could be create or modify — we record as "create" (conservative)
    return { operation: "create", filePath: path };
  }

  if (toolName === "file_edit") {
    const path = (args.path ?? args.file_path) as string | undefined;
    if (!path) return null;
    return { operation: "modify", filePath: path };
  }

  if (toolName === "file_delete") {
    const path = (args.path ?? args.file_path) as string | undefined;
    if (!path) return null;
    return { operation: "delete", filePath: path };
  }

  // Jarvis KB tools
  if (toolName === "jarvis_file_write") {
    const path = args.path as string | undefined;
    if (!path) return null;
    return { operation: "create", filePath: `jarvis://${path}` };
  }

  if (toolName === "jarvis_file_update") {
    const path = args.path as string | undefined;
    if (!path) return null;
    return { operation: "modify", filePath: `jarvis://${path}` };
  }

  if (toolName === "jarvis_file_delete") {
    const path = args.path as string | undefined;
    if (!path) return null;
    return { operation: "delete", filePath: `jarvis://${path}` };
  }

  // Git tools
  if (toolName === "git_commit") {
    const files = args.files as string[] | undefined;
    if (!files || files.length === 0) return null;
    return { operation: "modify", filePath: `git:${files.join(",")}` };
  }

  if (toolName === "git_push") {
    return { operation: "modify", filePath: "git:push" };
  }

  // Shell exec — can't know what it modifies, skip
  // WordPress — track separately if needed
  // Google tools — external mutations, not file-based

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a file mutation for a task. Non-blocking, never throws.
 */
export function recordMutation(
  taskId: string,
  toolName: string,
  operation: "create" | "modify" | "delete",
  filePath: string,
): void {
  try {
    ensureTable();
    getDatabase()
      .prepare(
        "INSERT INTO task_mutations (task_id, tool_name, operation, file_path) VALUES (?, ?, ?, ?)",
      )
      .run(taskId, toolName, operation, filePath);
  } catch {
    // Non-fatal — mutation log is best-effort
  }
}

/**
 * Get all mutations for a task, ordered chronologically.
 */
export function getMutations(taskId: string): Array<{
  id: number;
  tool_name: string;
  operation: string;
  file_path: string;
  created_at: string;
}> {
  try {
    ensureTable();
    return getDatabase()
      .prepare(
        "SELECT id, tool_name, operation, file_path, created_at FROM task_mutations WHERE task_id = ? ORDER BY id ASC",
      )
      .all(taskId) as Array<{
      id: number;
      tool_name: string;
      operation: string;
      file_path: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
}

/**
 * Get a summary of mutations for a task (for display).
 */
export function getMutationSummary(taskId: string): string {
  const mutations = getMutations(taskId);
  if (mutations.length === 0) return "No file mutations recorded.";

  const creates = mutations.filter((m) => m.operation === "create");
  const modifies = mutations.filter((m) => m.operation === "modify");
  const deletes = mutations.filter((m) => m.operation === "delete");

  const lines: string[] = [
    `📋 Mutations for task ${taskId.slice(0, 8)}: ${mutations.length} total`,
  ];
  if (creates.length > 0) {
    lines.push(
      `  ✨ Created (${creates.length}): ${creates.map((m) => m.file_path).join(", ")}`,
    );
  }
  if (modifies.length > 0) {
    lines.push(
      `  ✏️ Modified (${modifies.length}): ${modifies.map((m) => m.file_path).join(", ")}`,
    );
  }
  if (deletes.length > 0) {
    lines.push(
      `  🗑️ Deleted (${deletes.length}): ${deletes.map((m) => m.file_path).join(", ")}`,
    );
  }

  return lines.join("\n");
}
