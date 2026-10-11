/**
 * S6 WS1 — operator-run exporter: a `projects` row → its project record,
 * `projects/<slug>/project.md` (spec docs/planning/s6-project-contract-spec-2026-10-11.md §2).
 *
 * Usage (operator, ONCE per project):
 *   npx tsx scripts/project-record-export.ts <slug> [--kb-readme <kb-rel-path>]
 *       [--schedule <schedule_id>]… [--dry-run] [--force]
 *
 * Writes through the registry upsert path (`upsertFromDiskWrite`: registry
 * row + KB mirror + projection onto the row), never a bare fs write into the
 * KB. Refuses to overwrite an existing record without --force. Prints the KB
 * path and field COUNTS only — never a config value.
 *
 * Mapping (spec §2 class table): `aliases`→aliases, `stall_exempt`,
 * `parent`|`parent_project`→parent, `schedule_id` (+ --schedule)→schedules[],
 * `kb_path`→kb_folder, repo-class keys holding an absolute local path→repos[]
 * (role primary for the first of local/local_path/path, else other),
 * `urls.site`→links.site. Every other key is copied verbatim under the notes
 * section `## Legacy config` (urls: `## Legacy urls`), EXCEPT a value the
 * credential classifier calls a secret: it is replaced by a marker and stays
 * only in the row (credentials never enter the KB). `credentials` and
 * `commit_goal_id` are never read into the record.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../src/db/projects.js";
import { getProject } from "../src/db/projects.js";
import { getDatabase } from "../src/db/index.js";
import { getFile } from "../src/db/jarvis-fs.js";
import { upsertFromDiskWrite } from "../src/db/jarvis-reindex.js";
import { isProjectProseSecret, projectEntryLeaves } from "../src/lib/secret-refs.js";
import {
  PROJECT_SLUG_RE,
  parseProjectRecord,
  projectRecordRelPath,
  renderProjectRecord,
} from "../src/projects/record.js";

export const WITHHELD = "[withheld: credential-style value — stays in the projects row]";

/** Repo-class keys (spec §2 class table), in primary-preference order. */
const REPO_KEYS_PRIMARY_FIRST = ["local", "local_path", "path"];
const REPO_KEYS = new Set([
  ...REPO_KEYS_PRIMARY_FIRST,
  "repo",
  "repo_github",
  "journal_repo",
  "radar_repo",
  "parent_repo",
  "remote",
  "backend_path",
  "frontend_path",
  "sessions_dir",
]);

export interface ExportOptions {
  kbReadme?: string;
  schedules?: string[];
}

export interface ExportCounts {
  aliases: number;
  schedules: number;
  repos: number;
  parent: boolean;
  kb_folder: boolean;
  kb_readme: boolean;
  links_site: boolean;
  stall_exempt: boolean;
  legacy_config_keys: number;
  legacy_urls_keys: number;
  withheld_values: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isKbRel = (p: unknown): p is string =>
  typeof p === "string" &&
  p.length > 0 &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !p.split("/").includes("..");

/**
 * Pure: the record markdown for a row. Throws when the result would not
 * parse (the caller reports the reason).
 */
export function buildRecordFromRow(
  row: Project,
  opts: ExportOptions = {},
): { markdown: string; counts: ExportCounts } {
  const config: Record<string, unknown> = { ...row.config };
  const urls: Record<string, unknown> = { ...row.urls };
  let withheld = 0;
  const secretIn = (field: "config" | "urls", k: string, v: unknown) =>
    projectEntryLeaves(row.slug, field, k, v).some((l) => l.secret);

  // Credentials never enter the KB (R1 W2): a credential-shaped name or
  // description stops the export; the operator cleans the row first.
  for (const field of ["name", "description"] as const) {
    if (row[field] && isProjectProseSecret(field, row[field])) {
      throw new Error(`the row's ${field} holds a credential-style value — clean it before exporting`);
    }
  }

  const json: Record<string, unknown> = {
    slug: row.slug,
    name: row.name,
    status: row.status,
  };

  if (
    Array.isArray(config.aliases) &&
    config.aliases.length > 0 &&
    config.aliases.every((a) => typeof a === "string" && a.trim().length > 0) &&
    !secretIn("config", "aliases", config.aliases)
  ) {
    json.aliases = config.aliases;
    delete config.aliases;
  }
  if (typeof config.stall_exempt === "boolean") {
    json.stall_exempt = config.stall_exempt;
    delete config.stall_exempt;
  }
  for (const k of ["parent", "parent_project"]) {
    const v = config[k];
    if (json.parent === undefined && typeof v === "string" && PROJECT_SLUG_RE.test(v)) {
      json.parent = v;
      delete config[k];
    }
  }
  if (isKbRel(config.kb_path)) {
    json.kb_folder = config.kb_path;
    delete config.kb_path;
  }
  if (opts.kbReadme !== undefined) json.kb_readme = opts.kbReadme;

  const schedules: string[] = [];
  if (typeof config.schedule_id === "string" && config.schedule_id.trim()) {
    schedules.push(config.schedule_id.trim());
    delete config.schedule_id;
  }
  for (const s of opts.schedules ?? []) if (!schedules.includes(s)) schedules.push(s);
  if (schedules.length > 0) json.schedules = schedules;

  // Local repo paths (urls first, then config), primary = first preferred key.
  const repos: Array<{ path: string; role: "primary" | "other" }> = [];
  const take = (field: "urls" | "config", src: Record<string, unknown>) => {
    const keys = Object.keys(src)
      .filter((k) => REPO_KEYS.has(k))
      .sort(
        (a, b) =>
          (REPO_KEYS_PRIMARY_FIRST.indexOf(a) + 1 || 99) -
          (REPO_KEYS_PRIMARY_FIRST.indexOf(b) + 1 || 99),
      );
    for (const k of keys) {
      const v = src[k];
      if (typeof v !== "string" || !v.startsWith("/") || secretIn(field, k, v)) continue;
      if (!repos.some((r) => r.path === v)) {
        const primary =
          REPO_KEYS_PRIMARY_FIRST.includes(k) && !repos.some((r) => r.role === "primary");
        repos.push({ path: v, role: primary ? "primary" : "other" });
      }
      delete src[k];
    }
  };
  take("urls", urls);
  take("config", config);
  if (repos.length > 0) json.repos = repos;

  if (typeof urls.site === "string" && urls.site.trim() && !secretIn("urls", "site", urls.site)) {
    json.links = { site: urls.site };
    delete urls.site;
  }

  // Legacy sections: verbatim, except credential-style leaves.
  const scrub = (field: "config" | "urls", src: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      const leaves = projectEntryLeaves(row.slug, field, k, v);
      if (!leaves.some((l) => l.secret)) {
        out[k] = v;
        continue;
      }
      if (!isPlainObject(v) && !Array.isArray(v)) {
        out[k] = WITHHELD;
        withheld++;
        continue;
      }
      const copy = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
      for (const leaf of leaves) {
        if (!leaf.secret) continue;
        let node: Record<string, unknown> = copy;
        const path = leaf.path.slice(1);
        for (const seg of path.slice(0, -1)) node = node[seg] as Record<string, unknown>;
        node[path[path.length - 1]!] = WITHHELD;
        withheld++;
      }
      out[k] = copy;
    }
    return out;
  };
  const legacyConfig = scrub("config", config);
  const legacyUrls = scrub("urls", urls);

  const description = row.description
    .trim()
    .replace(/\r?\n[^\S\r\n]*(\r?\n[^\S\r\n]*)+/g, "\n");
  const notes: string[] = [];
  if (description) notes.push(description);
  if (Object.keys(legacyConfig).length > 0) {
    notes.push(
      "## Legacy config\n\nCopied from `projects.config` by the exporter; not part of the contract.\n\n```json\n" +
        JSON.stringify(legacyConfig, null, 2) +
        "\n```",
    );
  }
  if (Object.keys(legacyUrls).length > 0) {
    notes.push(
      "## Legacy urls\n\nCopied from `projects.urls` by the exporter; not part of the contract.\n\n```json\n" +
        JSON.stringify(legacyUrls, null, 2) +
        "\n```",
    );
  }

  const markdown = renderProjectRecord(json, notes.join("\n\n"));
  parseProjectRecord(markdown, { folderSlug: row.slug }); // throws if invalid
  return {
    markdown,
    counts: {
      aliases: Array.isArray(json.aliases) ? json.aliases.length : 0,
      schedules: schedules.length,
      repos: repos.length,
      parent: json.parent !== undefined,
      kb_folder: json.kb_folder !== undefined,
      kb_readme: json.kb_readme !== undefined,
      links_site: json.links !== undefined,
      stall_exempt: json.stall_exempt !== undefined,
      legacy_config_keys: Object.keys(legacyConfig).length,
      legacy_urls_keys: Object.keys(legacyUrls).length,
      withheld_values: withheld,
    },
  };
}

export type ExportResult =
  | {
      ok: true;
      rel: string;
      written: boolean;
      counts: ExportCounts;
      projection?: string;
      /** e.g. a --schedule id not in scheduled_tasks; printed to stderr, exit stays 0. */
      warnings: string[];
    }
  | { ok: false; error: string };

/** The ids not present in `scheduled_tasks` (a missing table counts as none present). */
function unknownSchedules(ids: string[]): string[] {
  if (ids.length === 0) return [];
  try {
    const stmt = getDatabase().prepare("SELECT 1 FROM scheduled_tasks WHERE schedule_id = ?");
    return ids.filter((id) => !stmt.get(id));
  } catch {
    return ids;
  }
}

/** Read the row, build the record, write it through the registry path. */
export function exportProjectRecord(
  slug: string,
  opts: ExportOptions & { dryRun?: boolean; force?: boolean } = {},
): ExportResult {
  if (!PROJECT_SLUG_RE.test(slug)) return { ok: false, error: `invalid slug "${slug}"` };
  if (opts.kbReadme !== undefined && !isKbRel(opts.kbReadme)) {
    return { ok: false, error: "--kb-readme must be a KB-relative .md path" };
  }
  const row = getProject(slug);
  if (!row || row.slug !== slug) return { ok: false, error: `no projects row for "${slug}"` };
  const rel = projectRecordRelPath(slug);
  if (getFile(rel) && !opts.force) {
    return { ok: false, error: `${rel} already exists — pass --force to overwrite` };
  }
  let built: ReturnType<typeof buildRecordFromRow>;
  try {
    built = buildRecordFromRow(row, opts);
  } catch (err) {
    const reason = (err as { reason?: string }).reason;
    return {
      ok: false,
      error: reason
        ? `the exported record would not parse (${reason})`
        : (err as Error).message,
    };
  }
  const warnings = unknownSchedules(opts.schedules ?? []).map(
    (id) => `--schedule ${id} is not in scheduled_tasks (check ./mc-ctl schedules)`,
  );
  if (opts.dryRun) return { ok: true, rel, written: false, counts: built.counts, warnings };
  const projected = upsertFromDiskWrite(rel, built.markdown);
  return {
    ok: true,
    warnings,
    rel,
    written: true,
    counts: built.counts,
    projection: projected?.error ? `error (${projected.error.reason})` : projected?.action,
  };
}

export function parseArgs(argv: string[]):
  | { slug: string; kbReadme?: string; schedules: string[]; dryRun: boolean; force: boolean }
  | { error: string } {
  const out = { slug: "", kbReadme: undefined as string | undefined, schedules: [] as string[], dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--kb-readme" || a === "--schedule") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--kb-readme") out.kbReadme = v;
      else out.schedules.push(v);
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (!out.slug) out.slug = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!out.slug) return { error: "usage: project-record-export.ts <slug> [--kb-readme <kb-rel-path>] [--schedule <id>]… [--dry-run] [--force]" };
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    return 1;
  }
  const { initDatabase, closeDatabase } = await import("../src/db/index.js");
  initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  try {
    const r = exportProjectRecord(args.slug, args);
    if (!r.ok) {
      console.error(`[project-record-export] ${r.error}`);
      return 1;
    }
    for (const w of r.warnings) console.error(`[project-record-export] warning: ${w}`);
    const c = r.counts;
    console.log(`[project-record-export] ${r.rel} ${r.written ? "written" : "(dry run — nothing written)"}`);
    console.log(
      `  contract: aliases=${c.aliases} schedules=${c.schedules} repos=${c.repos} parent=${c.parent ? "yes" : "no"} kb_folder=${c.kb_folder ? "yes" : "no"} kb_readme=${c.kb_readme ? "yes" : "no"} links.site=${c.links_site ? "yes" : "no"} stall_exempt=${c.stall_exempt ? "yes" : "no"}`,
    );
    console.log(
      `  notes: legacy config keys=${c.legacy_config_keys} legacy urls keys=${c.legacy_urls_keys} withheld credential-style values=${c.withheld_values}`,
    );
    if (r.projection) console.log(`  projection: ${r.projection}`);
    return 0;
  } finally {
    closeDatabase();
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (process.argv[1] !== undefined && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  main().then((code) => process.exit(code));
}
