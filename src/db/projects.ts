/**
 * Projects CRUD — first-class project entity with credentials,
 * config, and NorthStar goal linking.
 *
 * Projects persist across sessions and are injected into every Jarvis
 * prompt so the LLM always has project context available.
 */

import { getDatabase } from "./index.js";

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  urls: Record<string, string>;
  credentials: Record<string, string>;
  config: Record<string, unknown>;
  commit_goal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectLogEntry {
  id: number;
  project_id: string;
  action: string;
  details: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function generateId(): string {
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseJSON(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    status: (row.status as string) ?? "active",
    urls: parseJSON(row.urls as string) as Record<string, string>,
    credentials: parseJSON(row.credentials as string) as Record<string, string>,
    config: parseJSON(row.config as string),
    commit_goal_id: (row.commit_goal_id as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** Get all projects, optionally filtered by status. */
export function listProjects(status?: string): Project[] {
  const db = getDatabase();
  const rows = status
    ? (db
        .prepare("SELECT * FROM projects WHERE status = ? ORDER BY name")
        .all(status) as Record<string, unknown>[])
    : (db.prepare("SELECT * FROM projects ORDER BY name").all() as Record<
        string,
        unknown
      >[]);
  return rows.map(rowToProject);
}

/** Get a single project by slug or ID. */
export function getProject(slugOrId: string): Project | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM projects WHERE slug = ? OR id = ?")
    .get(slugOrId, slugOrId) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

/** Get project by NorthStar goal ID (commit_goal_id column — legacy name preserved). */
export function getProjectByGoalId(goalId: string): Project | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM projects WHERE commit_goal_id = ?")
    .get(goalId) as Record<string, unknown> | undefined;
  return row ? rowToProject(row) : null;
}

/** Create a new project. */
export function createProject(
  slug: string,
  name: string,
  fields?: Partial<
    Pick<
      Project,
      | "description"
      | "status"
      | "urls"
      | "credentials"
      | "config"
      | "commit_goal_id"
    >
  >,
): Project {
  const db = getDatabase();
  const id = generateId();
  db.prepare(
    `INSERT INTO projects (id, slug, name, description, status, urls, credentials, config, commit_goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    name,
    fields?.description ?? "",
    fields?.status ?? "active",
    JSON.stringify(fields?.urls ?? {}),
    JSON.stringify(fields?.credentials ?? {}),
    JSON.stringify(fields?.config ?? {}),
    fields?.commit_goal_id ?? null,
  );

  logProjectAction(id, "created", `Project "${name}" created`);
  return getProject(id)!;
}

/** Update a project (partial update). */
export function updateProject(
  slugOrId: string,
  updates: Partial<
    Pick<
      Project,
      | "name"
      | "description"
      | "status"
      | "urls"
      | "credentials"
      | "config"
      | "commit_goal_id"
    >
  >,
): Project | null {
  const project = getProject(slugOrId);
  if (!project) return null;

  const db = getDatabase();
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.urls !== undefined) {
    // Merge with existing URLs
    const merged = { ...project.urls, ...updates.urls };
    fields.push("urls = ?");
    values.push(JSON.stringify(merged));
  }
  if (updates.credentials !== undefined) {
    // Merge with existing credentials
    const merged = { ...project.credentials, ...updates.credentials };
    fields.push("credentials = ?");
    values.push(JSON.stringify(merged));
  }
  if (updates.config !== undefined) {
    // Merge with existing config
    const merged = { ...project.config, ...updates.config };
    fields.push("config = ?");
    values.push(JSON.stringify(merged));
  }
  if (updates.commit_goal_id !== undefined) {
    fields.push("commit_goal_id = ?");
    values.push(updates.commit_goal_id || null);
  }

  values.push(project.id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  const changedFields = Object.keys(updates).join(", ");
  logProjectAction(project.id, "updated", `Fields: ${changedFields}`);

  return getProject(project.id);
}

/** Delete a project. */
export function deleteProject(slugOrId: string): boolean {
  const project = getProject(slugOrId);
  if (!project) return false;

  const db = getDatabase();
  db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return true;
}

// ---------------------------------------------------------------------------
// Project log
// ---------------------------------------------------------------------------

/** Log an action on a project. */
export function logProjectAction(
  projectId: string,
  action: string,
  details?: string,
): void {
  try {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO project_log (project_id, action, details) VALUES (?, ?, ?)",
    ).run(projectId, action, details ?? null);
  } catch {
    // Non-fatal — logging should never block
  }
}

/** Get recent log entries for a project. */
export function getProjectLog(
  projectId: string,
  limit = 10,
): ProjectLogEntry[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM project_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(projectId, limit) as ProjectLogEntry[];
}

// ---------------------------------------------------------------------------
// Credential resolution — used by wp_* and gemini_image tools
// ---------------------------------------------------------------------------

/** Find a credential value across all projects. */
export function findCredential(key: string): string | null {
  const projects = listProjects("active");
  for (const project of projects) {
    if (project.credentials[key]) {
      return project.credentials[key];
    }
  }
  return null;
}

/** Find a project by site URL (for WordPress credential resolution). */
export function findProjectBySiteUrl(url: string): Project | null {
  const projects = listProjects();
  const normalized = url.replace(/\/+$/, "").toLowerCase();
  for (const project of projects) {
    const siteUrl = (project.urls.site ?? "").replace(/\/+$/, "").toLowerCase();
    if (siteUrl && normalized.includes(siteUrl)) {
      return project;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt injection — formats all projects for LLM context
// ---------------------------------------------------------------------------

/**
 * Format all active projects as a prompt block for injection.
 * Returns empty string if no projects exist.
 */
export function formatProjectsBlock(): string {
  const projects = listProjects("active");
  if (projects.length === 0) return "";

  const lines = projects.map((p) => {
    const parts = [`- **${p.name}** (${p.slug}): ${p.status}`];
    if (p.urls.site) parts.push(`  URL: ${p.urls.site}`);
    if (p.commit_goal_id)
      parts.push(`  Linked NorthStar goal: ${p.commit_goal_id}`);
    if (p.description) parts.push(`  ${p.description.slice(0, 100)}`);
    // Show credential keys (not values) so LLM knows what's available
    const credKeys = Object.keys(p.credentials);
    if (credKeys.length > 0) {
      parts.push(`  Credentials: ${credKeys.join(", ")}`);
    }
    return parts.join("\n");
  });

  return (
    "\n\n## Proyectos activos\n" +
    "Datos de proyecto confirmados. Usa project_get para ver detalles completos.\n\n" +
    lines.join("\n\n")
  );
}

// ---------------------------------------------------------------------------
// Migration: import user_facts (category=projects) into projects table
// ---------------------------------------------------------------------------

/**
 * One-time migration: if user_facts has category="projects" entries and
 * no projects exist yet, create a catch-all project from those facts.
 * Called on startup.
 */
export function migrateUserFactsToProjects(): void {
  const projects = listProjects();
  if (projects.length > 0) return; // Already have projects

  try {
    const db = getDatabase();
    const facts = db
      .prepare("SELECT key, value FROM user_facts WHERE category = 'projects'")
      .all() as Array<{ key: string; value: string }>;

    if (facts.length === 0) return;

    // Group by project prefix (e.g. "livingjoyfully_wp_user" → "livingjoyfully")
    const grouped = new Map<string, Record<string, string>>();
    for (const fact of facts) {
      const parts = fact.key.split("_");
      // Keys without underscores or generic keys go to "general"
      const prefix =
        parts.length > 1 && !["api", "google", "gemini"].includes(parts[0])
          ? parts[0]
          : "general";
      if (!grouped.has(prefix)) grouped.set(prefix, {});
      grouped.get(prefix)![fact.key] = fact.value;
    }

    for (const [prefix, data] of grouped) {
      const slug = prefix === "general" ? "general-credentials" : prefix;
      const name =
        prefix === "general"
          ? "General Credentials"
          : prefix.charAt(0).toUpperCase() + prefix.slice(1);

      const urls: Record<string, string> = {};
      const credentials: Record<string, string> = {};

      for (const [key, value] of Object.entries(data)) {
        // Classify: URLs go to urls, everything else to credentials
        if (
          key.includes("url") ||
          key.includes("host") ||
          key.includes("port")
        ) {
          urls[key.replace(`${prefix}_`, "")] = value;
        } else {
          credentials[key.replace(`${prefix}_`, "")] = value;
        }
      }

      createProject(slug, name, {
        urls,
        credentials,
        description: `Auto-migrated from user_facts`,
      });
      console.log(
        `[projects] Migrated user_facts → project "${name}" (${Object.keys(data).length} entries)`,
      );
    }
  } catch (err) {
    console.warn("[projects] Migration from user_facts failed:", err);
  }
}
