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
import { MIN_ALIAS_CHARS, aliasChars } from "../../projects/scope-groups.js";
import {
  configSecretLiterals,
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
      const leaf = projectEntryLeaves(slug, field, top, resolved[top], resolved).find(
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
        for (const leaf of projectEntryLeaves(slug, field, k, v, obj as Record<string, unknown>)) {
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
 * never through project_update. No row uses one today (spec, verified),
 * except `stall_exempt`: the operator's documented flag (queue 3b).
 */
export const OPERATOR_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "mcp", // legacy spelling (no row uses it)
  "trusted",
  "egress",
  "deny_paths",
  // Audit R1 C1: names the README chat injects; only the record sets it.
  "kb_readme",
  // S6 WS3: what spawns, with which secrets, and how chat routes to it.
  "capabilities",
  "secrets",
  "routing",
  "inbound",
  // Queue 3b: switches off the Morning Sync stall signal for the row.
  "stall_exempt",
]);

/**
 * Queue 3b audit R1, R2-audit W1, R3-audit W1: a sent list may not be longer
 * than this, or than the stored list when the operator stored more.
 */
const MAX_LEGACY_ALIASES = 20;

/**
 * Queue 3b audit R2, R2-audit W3: control, format and default-ignorable code points
 * (Unicode classes, not a hand list). Default_Ignorable adds what Cc/Cf miss
 * (U+3164 Hangul filler, variation selectors such as U+FE0F).
 */
const INVISIBLE_ALIAS_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/**
 * The two allowed uses, removed before INVISIBLE_ALIAS_RE runs: a ZWJ between
 * two pictographs (a skin-tone modifier or U+FE0F may precede it), and the
 * tag characters of a U+1F3F4 subdivision flag.
 */
const EMOJI_ZWJ_RE = /\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?\u200D(?=\p{Extended_Pictographic})/gu;
const SUBDIVISION_FLAG_RE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
/** A U+FE0F right after a pictograph is its presentation selector, ZWJ or not. */
const EMOJI_PRESENTATION_RE = /(?<=\p{Extended_Pictographic})\uFE0F/gu;
const hasInvisible = (a: string): boolean =>
  INVISIBLE_ALIAS_RE.test(
    a.replace(EMOJI_ZWJ_RE, "").replace(SUBDIVISION_FLAG_RE, "").replace(EMOJI_PRESENTATION_RE, ""),
  );

/**
 * Queue 3b: `config.aliases` on a row without a record follows the scope
 * regex's alias rule (`MIN_ALIAS_CHARS`, measured by `aliasChars`). A record
 * row is validated by the record schema instead. null deletes, as for any key.
 * An element byte-identical to one of the row's stored aliases is exempt
 * (audit W1; exact, R2 W2): only NEW elements are judged.
 */
function legacyAliasesProblem(v: unknown, stored: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return "config.aliases debe ser una lista de textos";
  const storedList = Array.isArray(stored) ? stored : [];
  const kept = new Set(storedList.filter((a): a is string => typeof a === "string"));
  let firstNew = -1;
  for (let i = 0; i < v.length; i++) {
    const a: unknown = v[i];
    if (typeof a !== "string") return `config.aliases[${i}] no es texto`;
    if (kept.has(a)) continue;
    if (firstNew < 0) firstNew = i;
    if (hasInvisible(a)) {
      return `config.aliases[${i}] tiene un carácter de control o invisible`;
    }
    if (aliasChars(a) < MIN_ALIAS_CHARS) {
      return `config.aliases[${i}] tiene menos de ${MIN_ALIAS_CHARS} caracteres (regla de alias: al menos ${MIN_ALIAS_CHARS})`;
    }
  }
  const bound = Math.max(MAX_LEGACY_ALIASES, storedList.length);
  if (v.length > bound) {
    return `config.aliases[${firstNew >= 0 ? firstNew : bound}] haría pasar la lista del máximo de ${MAX_LEGACY_ALIASES} alias`;
  }
  return undefined;
}

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
      if (projectEntryLeaves(slug, "urls", k, v, args.urls).some((l) => l.secret)) {
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
      if (projectEntryLeaves(slug, "config", k, v, args.config).some((l) => l.secret)) {
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
          for (const leaf of projectEntryLeaves(project.slug, "credentials", k, v, project.credentials)) {
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

/** The value at `path` (object keys / list indices) of a JSON value, or undefined. */
function valueAt(v: unknown, path: readonly string[]): unknown {
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/**
 * Queue 3l ruling A: the first credential literal next to its name that the
 * payload would ADD to the stored config (merged as updateProject merges),
 * or undefined. A hit the stored config already has, same path and value,
 * is not new.
 */
function configLiteralProblem(
  stored: Record<string, unknown>,
  payload: unknown,
): { path: string[]; fragment: string } | undefined {
  if (!isPlainObject(payload)) return undefined;
  const merged = mergeProjectEntries(stored, payload);
  const key = (obj: unknown, path: string[]) => `${path.join("\0")}\0${stable(valueAt(obj, path))}`;
  const old = new Set(configSecretLiterals(stored).map((h) => key(stored, h.path)));
  return configSecretLiterals(merged).find((h) => !old.has(key(merged, h.path)));
}

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
        const keys = `config.${refused.join(", config.")}`;
        const recSlug = row?.slug ?? slug;
        const hasRecord =
          typeof recSlug === "string" &&
          PROJECT_SLUG_RE.test(recSlug) &&
          getFile(projectRecordRelPath(recSlug)) !== null;
        // Audit S2: a row without a record has no project.md to point at.
        return JSON.stringify({
          error: hasRecord
            ? `No guardé: ${keys} solo lo cambia el operador en el registro del proyecto (projects/<slug>/project.md), no project_update.`
            : `No guardé: ${keys} solo lo cambia el operador: este proyecto aún no tiene registro; el operador lo crea con scripts/project-record-export.ts y lo cambia ahí, no project_update.`,
        });
      }
      if (opOnly.length > 0) {
        const rest = Object.fromEntries(Object.entries(config).filter(([k]) => !opOnly.includes(k)));
        rawArgs = { ...rawArgs, config: Object.keys(rest).length > 0 ? rest : undefined };
      }
    }
    // Queue 3l ruling A: a credential literal next to its name never enters
    // `config` (row or record). Judged on the config as it would be stored
    // (the payload merged over the row, so a name and a literal sent in two
    // calls meet), before stored references resolve to their values. A pair
    // the row already holds with the same value is not new and passes, as an
    // operator-only echo does. Names the path and fragment only.
    const literal = configLiteralProblem(row?.config ?? {}, rawArgs.config);
    if (literal) {
      console.warn(
        `[projects] 3l write gate refused config.${literal.path.join(".")} (fragment ${literal.fragment}) for ${slug}`,
      );
      return JSON.stringify({
        error: `No guardé: config.${literal.path.join(".")} es un valor literal junto a un nombre con "${literal.fragment}" (forma de credencial); guarda el valor en credentials y usa la referencia {name, secret}, no un valor literal.`,
      });
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

    const aliasProblem = isPlainObject(args.config)
      ? legacyAliasesProblem(args.config.aliases, row?.config.aliases)
      : undefined;
    if (aliasProblem) return JSON.stringify({ error: `No guardé: ${aliasProblem}.` });

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
