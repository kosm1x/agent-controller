/**
 * Project management tools — CRUD for the projects entity.
 *
 * Projects are the bridge between Jarvis's work and NorthStar's hierarchy.
 * Each project can link to a NorthStar goal via commit_goal_id.
 */

import type { Tool } from "../types.js";
import { toMexTime } from "../../lib/timezone.js";
import {
  listProjects,
  getProject,
  getProjectLog,
  createProject,
  updateProject,
  logProjectAction,
  projectFieldProblem,
  mergeProjectEntries,
} from "../../db/projects.js";
import { getFile } from "../../db/jarvis-fs.js";
import { upsertFromDiskWrite } from "../../db/jarvis-reindex.js";
import {
  PROJECT_SLUG_RE,
  ProjectRecordError,
  foldDescription,
  parseProjectRecord,
  projectRecordRelPath,
  replaceRecordDescription,
  replaceRecordJson,
} from "../../projects/record.js";
import {
  PROJECTOR_CONFIG_KEYS,
  applyProjectRecord,
  stable,
} from "../../projects/projector.js";
import {
  isProjectProseSecret,
  isProjectSecret,
  projectEntryLeaves,
  projectSecretDisplay,
  resolveStoredReferencesDeep,
  visibleDestinationError,
} from "../../lib/secret-refs.js";

/**
 * Audit round 5 (B2a): stored credentials written back BY NAME inside
 * `credentials` / `urls` / `config` (a leaf that is exactly a placeholder,
 * `{{SECRET_X}}` or `$SECRET_X`) are replaced by their stored value, so
 * moving or renaming an entry keeps it; each must land on a leaf that stays
 * hidden. A leaf carrying a placeholder inside other text, or an unknown
 * name, refuses the whole call. Returns the args to apply (a copy when
 * anything changed) or the `{error}` JSON.
 */
function resolveProjectRefs(
  slug: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  let out = args;
  for (const field of ["credentials", "urls", "config"] as const) {
    const obj = args[field];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const r = resolveStoredReferencesDeep(obj);
    if ("error" in r) return { error: JSON.stringify({ error: r.error }) };
    if (r.resolvedPaths.length === 0) continue;
    const resolved = r.value as Record<string, unknown>;
    for (const path of r.resolvedPaths) {
      const top = path[0]!;
      const leaf = projectEntryLeaves(slug, field, top, resolved[top]).find(
        (l) => l.path.join("\0") === path.join("\0"),
      );
      if (!leaf?.secret) {
        return {
          error: JSON.stringify({
            error: visibleDestinationError(`${field}.${path.join(".")}`),
          }),
        };
      }
    }
    out = { ...out, [field]: resolved };
  }
  return { args: out };
}

/**
 * Ruling 3c: the by-name placeholder of each credential-style entry (nested
 * values included, keyed by their dotted path) this call stored (never the value); undefined when there is none, so the
 * result of a call without credentials is unchanged.
 */
function savedSecrets(
  slug: string,
  args: Record<string, unknown>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const field of ["credentials", "urls", "config"] as const) {
    const obj = args[field];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    for (const [k, v] of Object.entries(obj)) {
      // Nested values carry their own names (audit R3 S4).
      if (v && typeof v === "object") {
        for (const leaf of projectEntryLeaves(slug, field, k, v)) {
          if (leaf.secret) out[`${field}.${leaf.path.join(".")}`] = leaf.display;
        }
        continue;
      }
      if (typeof v !== "string" && typeof v !== "number") continue;
      if (v === "" || !isProjectSecret(k, String(v))) continue;
      out[`${field}.${k}`] = projectSecretDisplay(slug, field, k, v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// S6 WS1 — project_update routes to the project record
// ---------------------------------------------------------------------------

/**
 * `config` keys that decide what code runs or what it may reach (spec §2,
 * "Write paths"): changed only through an operator upsert of the record,
 * never through project_update. No row uses one today (spec, verified).
 */
export const OPERATOR_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "mcp",
  "trusted",
  "egress",
  "deny_paths",
  // Audit R1 C1: names the README chat injects; only the record sets it.
  "kb_readme",
]);

const OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set(PROJECTOR_CONFIG_KEYS);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Record present: name / description / status / urls.site and the config
 * keys the record owns are written into `projects/<slug>/project.md` through
 * the registry upsert path (which re-projects the row); credentials,
 * commit_goal_id and every key the record does not own go straight to the
 * row, as before. The new record is validated BEFORE anything is written.
 */
function updateThroughRecord(
  slug: string,
  args: Record<string, unknown>,
  recordContent: string,
): string {
  const rel = projectRecordRelPath(slug);
  let parsed;
  try {
    parsed = parseProjectRecord(recordContent, { folderSlug: slug });
  } catch (err) {
    const reason = err instanceof ProjectRecordError ? err.reason : "error";
    return JSON.stringify({
      error: `No guardé: el registro ${rel} no es válido (${reason}); el operador debe corregirlo antes de cambiar el proyecto.`,
    });
  }

  // Credentials never enter the KB (R1 W2): name and description are free
  // text, judged by token shape only (R2 W3); urls.site and the owned config
  // keys below get the full check.
  for (const field of ["name", "description"] as const) {
    const v = args[field];
    if (typeof v === "string" && v !== "" && isProjectProseSecret(field, v)) {
      return JSON.stringify({
        error: `No guardé: ${field} parece contener una credencial; las credenciales no entran al registro del proyecto — guárdala en credentials.`,
      });
    }
  }

  const json: Record<string, unknown> = { ...parsed.json };
  const rowUrls: Record<string, unknown> = {};
  const rowConfig: Record<string, unknown> = {};

  if (args.name !== undefined) json.name = args.name;
  if (args.status !== undefined) json.status = args.status;
  if (isPlainObject(args.urls)) {
    for (const [k, v] of Object.entries(args.urls)) {
      if (k !== "site") {
        rowUrls[k] = v;
        continue;
      }
      if (projectEntryLeaves(slug, "urls", k, v).some((l) => l.secret)) {
        return JSON.stringify({
          error:
            "No guardé: urls.site parece una credencial; las credenciales no entran al registro del proyecto — guárdala en credentials.",
        });
      }
      const links = isPlainObject(json.links) ? { ...json.links } : {};
      if (v === null) delete links.site;
      else links.site = v;
      if (Object.keys(links).length > 0) json.links = links;
      else delete json.links;
    }
  }
  if (isPlainObject(args.config)) {
    for (const [k, v] of Object.entries(args.config)) {
      if (!OWNED_CONFIG_KEYS.has(k)) {
        rowConfig[k] = v;
        continue;
      }
      if (projectEntryLeaves(slug, "config", k, v).some((l) => l.secret)) {
        return JSON.stringify({
          error: `No guardé: config.${k} parece una credencial; las credenciales no entran al registro del proyecto — guárdala en credentials.`,
        });
      }
      if (v === null) delete json[k];
      else if (isPlainObject(v) && isPlainObject(json[k]))
        json[k] = mergeProjectEntries(json[k] as Record<string, unknown>, v);
      else json[k] = v;
    }
  }

  let next = replaceRecordJson(recordContent, json);
  const wanted =
    args.description !== undefined ? foldDescription(String(args.description ?? "")) : undefined;
  // R2b W2: a fence line in the description reads back today but cuts it
  // short once the notes gain a fence of their own — refused before the write.
  if (wanted !== undefined && /^[^\S\r\n]{0,3}(?:```|~~~)/m.test(wanted)) {
    return JSON.stringify({
      error:
        "No guardé: la descripción tiene una línea que abre un bloque (``` o ~~~); escríbela como un solo párrafo de texto, sin bloques.",
    });
  }
  if (wanted !== undefined) next = replaceRecordDescription(next, wanted);
  try {
    const reparsed = parseProjectRecord(next, { folderSlug: slug });
    // R2 W2: the record must read back the description it was given — a
    // line starting with `#`, a `## ` heading or a fence would cut it short
    // or plant a section in the record.
    if (wanted === "" && reparsed.description !== "") {
      // R2b W3: removing the first paragraph promotes the next one.
      return JSON.stringify({
        error:
          "No guardé: al borrar la descripción, el siguiente párrafo del registro pasaría a ser la descripción; el operador debe editar el registro.",
      });
    }
    if (wanted !== undefined && reparsed.description !== wanted) {
      return JSON.stringify({
        error:
          "No guardé: la descripción no se puede guardar tal cual en el registro (una línea que empieza con '#', un encabezado '## ' o un bloque ``` la cortan); escríbela como un solo párrafo de texto.",
      });
    }
  } catch (err) {
    const where =
      err instanceof ProjectRecordError && err.issues.length > 0
        ? err.issues.map((i) => i.path.join(".") || "(raíz)").join(", ")
        : err instanceof ProjectRecordError
          ? err.reason
          : "error";
    return JSON.stringify({
      error: `No guardé: el cambio deja el registro ${rel} inválido (${where}).`,
    });
  }

  // A changed record goes through the registry upsert path (which projects
  // it); an unchanged one is projected only when its row is missing.
  const projected =
    next !== recordContent
      ? upsertFromDiskWrite(rel, next)
      : getProject(slug)
        ? undefined
        : applyProjectRecord(rel, next);
  if (projected?.error) {
    return JSON.stringify({
      error: `El registro ${rel} no se pudo proyectar a la fila (${projected.error.reason}).`,
    });
  }

  const direct: Record<string, unknown> = {};
  if (Object.keys(rowUrls).length > 0) direct.urls = rowUrls;
  if (Object.keys(rowConfig).length > 0) direct.config = rowConfig;
  if (args.credentials !== undefined) direct.credentials = args.credentials;
  if (args.commit_goal_id !== undefined) direct.commit_goal_id = args.commit_goal_id;
  if (Object.keys(direct).length > 0) updateProject(slug, direct);

  const updated = getProject(slug);
  if (!updated) {
    return JSON.stringify({ error: "Update failed" });
  }
  return JSON.stringify({
    action: projected?.action === "created" ? "created" : "updated",
    project: {
      slug: updated.slug,
      name: updated.name,
      status: updated.status,
      credential_keys: Object.keys(updated.credentials),
    },
    record: rel,
    saved_secrets: savedSecrets(updated.slug, args),
  });
}

// ---------------------------------------------------------------------------
// project_list
// ---------------------------------------------------------------------------

export const projectListTool: Tool = {
  name: "project_list",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
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
      const url = p.urls.site
        ? projectSecretDisplay(p.slug, "urls", "site", p.urls.site)
        : "—";
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
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "project_get",
      description: `Get full details of a project including credential names (secret values hidden), config, and recent activity log.

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
    if (project.urls?.site)
      lines.push(
        `URL: ${projectSecretDisplay(project.slug, "urls", "site", project.urls.site)}`,
      );
    if (project.urls?.repo)
      lines.push(
        `Repo: ${projectSecretDisplay(project.slug, "urls", "repo", project.urls.repo)}`,
      );
    // Surface additional repos (multi-repo projects store them as repo_* keys).
    for (const [k, v] of Object.entries(project.urls ?? {})) {
      if (k === "repo" || k === "site" || !v || !/repo/i.test(k)) continue;
      lines.push(
        `Repo (${k.replace(/_?repo_?/i, "") || k}): ${projectSecretDisplay(project.slug, "urls", k, v)}`,
      );
    }
    if (project.commit_goal_id)
      lines.push(`NorthStar goal: ${project.commit_goal_id}`);
    const credKeys = Object.keys(project.credentials ?? {});
    if (credKeys.length > 0) {
      lines.push(`\n**Credentials:** ${credKeys.join(", ")}`);
      for (const [k, v] of Object.entries(project.credentials)) {
        // A nested entry shows each value under its own name (audit R3 S4).
        if (v && typeof v === "object") {
          for (const leaf of projectEntryLeaves(project.slug, "credentials", k, v)) {
            lines.push(`  ${leaf.path.join(".")}: ${leaf.display}`);
          }
          continue;
        }
        lines.push(
          `  ${k}: ${projectSecretDisplay(project.slug, "credentials", k, v)}`,
        );
      }
    }
    if (recentLog.length > 0) {
      lines.push(`\n**Recent activity:**`);
      for (const e of recentLog) {
        lines.push(`  ${toMexTime(e.created_at)} — ${e.action}: ${e.details}`);
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
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  requiresConfirmation: false,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "project_update",
      description: `Create or update a project. Updates are merged (credentials, URLs, config are merged key by key, nested objects too, not replaced; a null value deletes that key).

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

  async execute(rawArgs: Record<string, unknown>): Promise<string> {
    const slug = rawArgs.slug as string;
    const row = typeof slug === "string" ? getProject(slug) : null;
    // Audit R6 should-fix 4: a non-object field, or a prototype key, is
    // refused — never silently dropped or stored as {"0":"h",...}.
    for (const field of ["credentials", "urls", "config"] as const) {
      if (rawArgs[field] === undefined) continue;
      const problem = projectFieldProblem(field, rawArgs[field]);
      if (problem) {
        return JSON.stringify({ error: `No guardé: ${problem}.` });
      }
    }
    if (isPlainObject(rawArgs.config)) {
      // Audit R2 W1: refused only when the value CHANGES; an echo of the
      // row's own value (get → update) passes and is not written.
      const config = rawArgs.config;
      const opOnly = Object.keys(config).filter((k) => OPERATOR_ONLY_CONFIG_KEYS.has(k));
      const refused = opOnly.filter((k) => stable(config[k]) !== stable(row?.config[k]));
      if (refused.length > 0) {
        return JSON.stringify({
          error: `No guardé: config.${refused.join(", config.")} solo lo cambia el operador en el registro del proyecto (projects/<slug>/project.md), no project_update.`,
        });
      }
      if (opOnly.length > 0) {
        const rest = Object.fromEntries(Object.entries(config).filter(([k]) => !opOnly.includes(k)));
        rawArgs = { ...rawArgs, config: Object.keys(rest).length > 0 ? rest : undefined };
      }
    }
    const refs = resolveProjectRefs(slug, rawArgs);
    if ("error" in refs) return refs.error;
    const args = refs.args;

    // S6 WS1: a project with a record changes through its record. The row
    // may be named by its id (getProject accepts both), so the record is
    // looked up by the row's slug (R1 W3).
    const recordSlug =
      typeof slug === "string" ? (getProject(slug)?.slug ?? slug) : undefined;
    if (recordSlug !== undefined && PROJECT_SLUG_RE.test(recordSlug)) {
      const record = getFile(projectRecordRelPath(recordSlug));
      if (record) return updateThroughRecord(recordSlug, args, String(record.content));
    }

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
        saved_secrets: savedSecrets(project.slug, args),
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
      saved_secrets: savedSecrets(updated.slug, args),
    });
  },
};
