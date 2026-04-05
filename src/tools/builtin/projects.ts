/**
 * Project management tools — CRUD for the projects entity.
 *
 * Projects are the bridge between Jarvis's work and NorthStar's hierarchy.
 * Each project can link to a NorthStar goal via commit_goal_id.
 */

import type { Tool } from "../types.js";
import {
  listProjects,
  getProject,
  getProjectLog,
  createProject,
  updateProject,
  logProjectAction,
} from "../../db/projects.js";

// ---------------------------------------------------------------------------
// project_list
// ---------------------------------------------------------------------------

export const projectListTool: Tool = {
  name: "project_list",
  definition: {
    type: "function",
    function: {
      name: "project_list",
      description: `List all projects with their status, URLs, and linked NorthStar goals.

USE WHEN:
- User asks about their projects or what's active
- You need to find a project's slug before calling project_get
- Morning/nightly briefing needs project context
- User mentions a project name and you need to verify it exists

NOTE: This returns DB project metadata (status, URLs, credentials). For project FILES and docs, also check jarvis_file_list with prefix "projects/{slug}/".`,
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "paused", "completed", "archived"],
            description: "Filter by status. Omit to show all projects.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const status = args.status as string | undefined;
    const projects = listProjects(status);

    // Pre-formatted: markdown table of projects
    if (projects.length === 0) return "📁 No projects found.";
    const lines = [`📁 **${projects.length} projects** (${status ?? "all"})`];
    lines.push("");
    lines.push("| Slug | Name | Status | URL | Credentials |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const p of projects) {
      const url = p.urls.site ?? "—";
      const creds =
        Object.keys(p.credentials).length > 0
          ? Object.keys(p.credentials).join(", ")
          : "—";
      lines.push(`| ${p.slug} | ${p.name} | ${p.status} | ${url} | ${creds} |`);
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// project_get
// ---------------------------------------------------------------------------

export const projectGetTool: Tool = {
  name: "project_get",
  definition: {
    type: "function",
    function: {
      name: "project_get",
      description: `Get full details of a project including credentials, config, and recent activity log.

USE WHEN:
- You need a project's credentials (WP password, API key, FTP host)
- You need to check project configuration or URLs
- User asks about a specific project's status or details
- You need the commit_goal_id to link project progress to NorthStar

ALWAYS call this when the user mentions a project by name — it loads the full context
(credentials, URLs, config) so you don't need to ask the user for information they've
already provided.

For project documentation and notes, also read jarvis_file_read("projects/{slug}/README.md").`,
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "Project slug or ID. Use project_list first if you don't know the slug.",
          },
        },
        required: ["slug"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const slug = args.slug as string;
    const project = getProject(slug);
    if (!project) {
      return JSON.stringify({
        error: `Project "${slug}" not found. Call project_list to see available projects.`,
      });
    }

    const recentLog = getProjectLog(project.id, 5);

    // Pre-formatted: readable project details
    const lines = [
      `📁 **${project.name}** (\`${project.slug}\`)`,
      `Status: ${project.status}`,
    ];
    if (project.description) lines.push(`${project.description}`);
    if (project.urls?.site) lines.push(`URL: ${project.urls.site}`);
    if (project.urls?.repo) lines.push(`Repo: ${project.urls.repo}`);
    if (project.commit_goal_id)
      lines.push(`NorthStar goal: ${project.commit_goal_id}`);
    const credKeys = Object.keys(project.credentials ?? {});
    if (credKeys.length > 0) {
      lines.push(`\n**Credentials:** ${credKeys.join(", ")}`);
      for (const [k, v] of Object.entries(project.credentials)) {
        lines.push(`  ${k}: ${String(v)}`);
      }
    }
    if (recentLog.length > 0) {
      lines.push(`\n**Recent activity:**`);
      for (const e of recentLog) {
        lines.push(`  ${e.created_at} — ${e.action}: ${e.details}`);
      }
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// project_update
// ---------------------------------------------------------------------------

export const projectUpdateTool: Tool = {
  name: "project_update",
  requiresConfirmation: false,
  definition: {
    type: "function",
    function: {
      name: "project_update",
      description: `Create or update a project. Updates are merged (credentials, URLs, config are merged, not replaced).

USE WHEN:
- User provides project credentials (WP password, API key, FTP host) — store them here
- User creates a new project or changes project status
- You need to link a project to a NorthStar goal
- Auto-detected credentials should be stored here

WORKFLOW for new projects:
1. Call project_update with slug + name to create
2. Add credentials, URLs, config as they become available
3. Link to NorthStar goal with commit_goal_id when appropriate

CREDENTIAL STORAGE:
- WordPress: credentials.wp_user, credentials.wp_app_password
- FTP: credentials.ftp_host, credentials.ftp_user, credentials.ftp_password
- API keys: credentials.gemini_api_key, credentials.ga4_measurement_id
- URLs: urls.site, urls.admin, urls.repo`,
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "Project slug (lowercase, no spaces). Used as identifier.",
          },
          name: {
            type: "string",
            description: "Project display name.",
          },
          description: {
            type: "string",
            description: "Brief project description.",
          },
          status: {
            type: "string",
            enum: ["active", "paused", "completed", "archived"],
            description: "Project status.",
          },
          urls: {
            type: "object",
            description:
              "Project URLs. Keys: site, admin, repo, dashboard. Merged with existing.",
          },
          credentials: {
            type: "object",
            description:
              "Project credentials. Keys: wp_user, wp_app_password, ftp_host, api_keys, etc. Merged with existing.",
          },
          config: {
            type: "object",
            description: "Arbitrary project config. Merged with existing.",
          },
          commit_goal_id: {
            type: "string",
            description:
              "Goal UUID to link this project to. Get from NorthStar/ files via jarvis_file_read.",
          },
        },
        required: ["slug"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const slug = args.slug as string;
    const existing = getProject(slug);

    if (!existing) {
      // Create new project
      const name = (args.name as string) || slug;
      const project = createProject(slug, name, {
        description: args.description as string | undefined,
        status: args.status as string | undefined,
        urls: args.urls as Record<string, string> | undefined,
        credentials: args.credentials as Record<string, string> | undefined,
        config: args.config as Record<string, unknown> | undefined,
        commit_goal_id: args.commit_goal_id as string | undefined,
      });
      return JSON.stringify({
        action: "created",
        project: {
          slug: project.slug,
          name: project.name,
          status: project.status,
          credential_keys: Object.keys(project.credentials),
        },
      });
    }

    // Update existing project
    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.status !== undefined) updates.status = args.status;
    if (args.urls !== undefined) updates.urls = args.urls;
    if (args.credentials !== undefined) updates.credentials = args.credentials;
    if (args.config !== undefined) updates.config = args.config;
    if (args.commit_goal_id !== undefined)
      updates.commit_goal_id = args.commit_goal_id;

    const updated = updateProject(slug, updates);
    if (!updated) {
      return JSON.stringify({ error: "Update failed" });
    }

    logProjectAction(
      updated.id,
      "updated",
      `Fields: ${Object.keys(updates).join(", ")}`,
    );

    return JSON.stringify({
      action: "updated",
      project: {
        slug: updated.slug,
        name: updated.name,
        status: updated.status,
        credential_keys: Object.keys(updated.credentials),
      },
    });
  },
};
