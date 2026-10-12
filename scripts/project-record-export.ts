/**
 * S6 WS1 — operator-run exporter: a `projects` row → its project record,
 * `projects/<slug>/project.md` (spec docs/planning/s6-project-contract-spec-2026-10-11.md §2).
 *
 * Usage (operator, ONCE per project):
 *   npx tsx scripts/project-record-export.ts <slug> [--kb-readme <kb-rel-path>]
 *       [--schedule <schedule_id>]… [--parent <slug>] [--dry-run] [--force]
 *
 * Writes through the registry upsert path (`upsertFromDiskWrite`: registry
 * row + KB mirror + projection onto the row), never a bare fs write into the
 * KB. Refuses to overwrite an existing record without --force, and a parent
 * that is the project itself or closes a cycle. Prints the KB path and field
 * COUNTS only — never a config value. Operator terminal only (audit R1 C1 /
 * R2): the CLI entry exits 2 outside an operator login session with a TTY
 * (`src/lib/operator-gate.ts`).
 *
 * Mapping (spec §2 class table): `aliases`→aliases, `stall_exempt`,
 * `parent`|`parent_project`→parent, `schedule_id` (+ --schedule)→schedules[],
 * `kb_path`→kb_folder, `--parent` beats both parent spellings (a differing
 * `parent_project` stays in the notes and is reported; S6 ruling 5a), repo-class keys holding an absolute local path→repos[]
 * (role primary for the first of local/local_path/path, else other),
 * `urls.site`→links.site. A projector-owned key (PROJECTOR_CONFIG_KEYS, written
 * by a previous apply) is the record's value and wins: it is the contract
 * field, never a Legacy config duplicate; a legacy spelling with an equal
 * value is consumed, a different one stays in the notes (reported in
 * `differs`), and so does an invalid owned value (apply will overwrite it).
 * Contract values are written as the schema normalises them. So a `--force` re-export of a projected row reproduces the
 * record. Every other key is copied verbatim under the notes
 * section `## Legacy config` (urls: `## Legacy urls`), EXCEPT a value the
 * credential classifier calls a secret: it is replaced by a marker and stays
 * only in the row (credentials never enter the KB). `credentials` and
 * `commit_goal_id` are never read into the record.
 */

import { requireOperatorTerminal } from "../src/lib/operator-gate.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../src/db/projects.js";
import { getProject } from "../src/db/projects.js";
import { getDatabase } from "../src/db/index.js";
import { getFile } from "../src/db/jarvis-fs.js";
import { upsertFromDiskWrite } from "../src/db/jarvis-reindex.js";
import { isProjectProseSecret, projectEntryLeaves } from "../src/lib/secret-refs.js";
import { PROJECTOR_CONFIG_KEYS, parentChainError } from "../src/projects/projector.js";
import {
  KB_README_RE,
  PROJECT_SLUG_RE,
  normaliseRecordJson,
  parseProjectRecord,
  projectContractSchema,
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
  /** Overrides the legacy `parent_project`/`parent` mapping (S6 ruling 5a). */
  parent?: string;
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
): { markdown: string; counts: ExportCounts; differs: string[] } {
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
  // The owned keys are validated TOGETHER, never one at a time: a key's
  // validity can depend on another (a `capabilities.mcp[].env` `{name, secret}`
  // must name an entry of `secrets`, src/projects/record.ts:157), so a key
  // probed alone is judged wrongly (incident 2026-10-12: eurekams lost its
  // `capabilities`). Pass 1: every present owned key. On failure, the keys an
  // issue names (`path[0]`) are invalid and the rest are re-probed together
  // (pass 2); if that fails too, per key.
  type OwnedKey = (typeof PROJECTOR_CONFIG_KEYS)[number];
  const ownedValid = new Map<OwnedKey, unknown>();
  {
    const probe = (keys: readonly OwnedKey[]) =>
      projectContractSchema.safeParse({
        slug: "probe",
        name: "probe",
        status: "active",
        ...Object.fromEntries(keys.map((k) => [k, config[k]])),
      });
    const keys = PROJECTOR_CONFIG_KEYS.filter((k) => k in config && !secretIn("config", k, config[k]));
    const p1 = probe(keys);
    if (p1.success) {
      for (const k of keys) ownedValid.set(k, p1.data[k]);
    } else {
      const bad = new Set(p1.error.issues.map((i) => i.path[0]));
      const rest = keys.filter((k) => !bad.has(k));
      const p2 = rest.length > 0 && rest.length < keys.length ? probe(rest) : undefined;
      if (p2?.success) {
        for (const k of rest) ownedValid.set(k, p2.data[k]);
      } else {
        for (const k of rest) {
          const p = probe([k]);
          if (p.success) ownedValid.set(k, p.data[k]);
        }
      }
    }
  }
  /** The record's own (projected) value of an owned key, parsed; undefined when absent or invalid. */
  const projected = (k: OwnedKey): unknown => (k in config ? ownedValid.get(k) : undefined);
  /** Warnings: a legacy key that differs from the record's value, or an invalid owned value; both kept in the notes. */
  const differs: string[] = [];
  const legacyDiffers = (k: string) => differs.push(`legacy ${k}: differs from record, kept in notes`);

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
  if (opts.parent !== undefined) {
    // The flag is the record's parent. An equal spelling is consumed; the
    // owned `parent` is replaced by the apply; a differing `parent_project`
    // is never dropped silently: it stays in the notes (on every re-export).
    json.parent = opts.parent;
    if (config.parent_project === opts.parent) delete config.parent_project;
    else if (config.parent_project !== undefined) differs.push("parent: overridden (legacy value kept in notes)");
    if (typeof config.parent === "string" && PROJECT_SLUG_RE.test(config.parent)) {
      if (config.parent !== opts.parent) {
        differs.push(`parent: overridden (the row's previous parent ${config.parent} is replaced by ${opts.parent} on apply)`);
      }
      delete config.parent;
    }
  }
  for (const k of opts.parent !== undefined ? [] : ["parent", "parent_project"]) {
    const v = config[k];
    if (
      (json.parent === undefined || json.parent === v) &&
      typeof v === "string" &&
      PROJECT_SLUG_RE.test(v)
    ) {
      json.parent = v;
      delete config[k];
    } else if (k === "parent_project" && json.parent !== undefined && typeof v === "string" && PROJECT_SLUG_RE.test(v)) {
      legacyDiffers(k);
    }
  }
  const ownedFolder = projected("kb_folder");
  if (ownedFolder !== undefined) {
    json.kb_folder = ownedFolder;
    delete config.kb_folder;
    if (config.kb_path === ownedFolder) delete config.kb_path;
    else if (isKbRel(config.kb_path)) legacyDiffers("kb_path");
  } else if (isKbRel(config.kb_path)) {
    json.kb_folder = config.kb_path;
    delete config.kb_path;
  }
  if (opts.kbReadme !== undefined) json.kb_readme = opts.kbReadme;

  const schedules: string[] = [];
  const ownedSchedules = projected("schedules") as string[] | undefined;
  const legacyId = typeof config.schedule_id === "string" ? config.schedule_id.trim() : "";
  if (ownedSchedules !== undefined) {
    schedules.push(...ownedSchedules);
    delete config.schedules;
    if (legacyId && schedules.includes(legacyId)) delete config.schedule_id;
    else if (legacyId) legacyDiffers("schedule_id");
  } else if (legacyId) {
    schedules.push(legacyId);
    delete config.schedule_id;
  }
  for (const s of opts.schedules ?? []) if (!schedules.includes(s)) schedules.push(s);
  if (schedules.length > 0) json.schedules = schedules;

  // Local repo paths (urls first, then config), primary = first preferred key.
  // With the record's own `repos`, a legacy path in it is consumed, another kept.
  const ownedRepos = projected("repos") as Array<{ path: string; role: "primary" | "other" }> | undefined;
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
      if (ownedRepos !== undefined) {
        if (ownedRepos.some((r) => r.path === v)) delete src[k];
        else legacyDiffers(k);
        continue;
      }
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
  if (ownedRepos !== undefined) {
    delete config.repos;
    if (ownedRepos.length > 0) json.repos = ownedRepos;
  } else if (repos.length > 0) json.repos = repos;

  const ownedLinks = projected("links") as { site: string } | undefined;
  if (ownedLinks !== undefined) {
    json.links = ownedLinks;
    delete config.links;
    if (urls.site === ownedLinks.site) delete urls.site;
    else if (urls.site !== undefined) legacyDiffers("urls.site");
  } else if (typeof urls.site === "string" && urls.site.trim() && !secretIn("urls", "site", urls.site)) {
    json.links = { site: urls.site };
    delete urls.site;
  }

  // The other owned keys (match_priority, success, kb_readme without the
  // flag): a valid value is the contract field, or a duplicate of the flag's
  // (dropped). aliases/stall_exempt/parent were decided above (same key).
  for (const k of PROJECTOR_CONFIG_KEYS) {
    if (!(k in config) || k === "aliases" || k === "stall_exempt" || k === "parent") continue;
    const v = projected(k);
    if (v === undefined) continue;
    if (json[k] === undefined) json[k] = v;
    delete config[k];
  }
  // An owned key still here is invalid: never lost silently (audit R1 W1).
  for (const k of PROJECTOR_CONFIG_KEYS) {
    if (k in config) differs.push(`owned ${k}: invalid, kept in notes, apply will overwrite the row`);
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

  const markdown = renderProjectRecord(normaliseRecordJson(json), notes.join("\n\n"));
  return {
    markdown,
    differs,
    counts: {
      aliases: Array.isArray(json.aliases) ? json.aliases.length : 0,
      schedules: schedules.length,
      repos: Array.isArray(json.repos) ? json.repos.length : 0,
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
  if (opts.kbReadme !== undefined && !(isKbRel(opts.kbReadme) && KB_README_RE.test(opts.kbReadme))) {
    return { ok: false, error: "--kb-readme must be projects/<folder>/<file>.md" };
  }
  if (opts.parent !== undefined && !PROJECT_SLUG_RE.test(opts.parent)) {
    return { ok: false, error: "--parent must be a project slug" };
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
  // Audit R1 W3: the record's parent (flag or legacy) is not itself and closes no cycle.
  const parent = parseProjectRecord(built.markdown, { folderSlug: slug }).contract.parent;
  const why = parent === undefined ? null : parentChainError(slug, parent);
  if (why) return { ok: false, error: `parent refused: ${why}` };
  const warnings = [
    ...unknownSchedules(opts.schedules ?? []).map(
      (id) => `--schedule ${id} is not in scheduled_tasks (check ./mc-ctl schedules)`,
    ),
    ...built.differs,
  ];
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
  | { slug: string; kbReadme?: string; parent?: string; schedules: string[]; dryRun: boolean; force: boolean }
  | { error: string } {
  const out = { slug: "", kbReadme: undefined as string | undefined, parent: undefined as string | undefined, schedules: [] as string[], dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--kb-readme" || a === "--schedule" || a === "--parent") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--kb-readme") out.kbReadme = v;
      else if (a === "--parent") out.parent = v;
      else out.schedules.push(v);
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (!out.slug) out.slug = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!out.slug) return { error: "usage: project-record-export.ts <slug> [--kb-readme <kb-rel-path>] [--schedule <id>]… [--parent <slug>] [--dry-run] [--force]" };
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
  // Audit R1 C1 / R2: an operator login session with a terminal, no override.
  requireOperatorTerminal("project-record-export");
  main().then((code) => process.exit(code));
}
