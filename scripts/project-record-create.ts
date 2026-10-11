/**
 * S6 ruling 5a — operator-run creation of a project record for a project
 * with NO `projects` row: flags → `projects/<slug>/project.md` → the row is
 * created from the record by the projector (spec
 * docs/planning/s6-project-contract-spec-2026-10-11.md §2, §5).
 *
 * Usage (operator, ONCE per project):
 *   npx tsx scripts/project-record-create.ts <slug> --name <text>
 *       --repo <abs-path>[:primary|other] [--repo …]… [--alias <a>]…
 *       [--parent <slug>] [--status active|paused] [--description <text>]
 *       [--kb-readme <kb-rel-path>] [--dry-run]
 *
 * The first --repo without a role is primary, the rest other; each must be
 * an existing directory (no `..` segment). Refuses when a record or a row
 * already exists for the slug (use the exporter for a row), a
 * credential-style name or description, an alias another project already
 * answers to, and a parent that is the project itself or closes a cycle.
 * Operator terminal only (audit R1 C1 / R2): the CLI entry exits 2 outside an
 * operator login session with a TTY (`src/lib/operator-gate.ts`), so a
 * task's `shell_exec` cannot run it. Validates by parsing the
 * rendered record (the exporter's renderer and normalisation), writes
 * through the registry upsert path (`upsertFromDiskWrite`: registry row + KB
 * mirror + projection), never a bare fs write into the KB. Prints the KB
 * path and field COUNTS only.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProject } from "../src/db/projects.js";
import { getDatabase } from "../src/db/index.js";
import { getFile, getJarvisKbRoot } from "../src/db/jarvis-fs.js";
import { MIN_ALIAS_LEN } from "../src/detection/stalled-projects.js";
import { parentChainError } from "../src/projects/projector.js";
import { upsertFromDiskWrite } from "../src/db/jarvis-reindex.js";
import { requireOperatorTerminal } from "../src/lib/operator-gate.js";
import { isProjectProseSecret } from "../src/lib/secret-refs.js";
import {
  KB_README_RE,
  PROJECT_SLUG_RE,
  foldDescription,
  normaliseRecordJson,
  projectRecordRelPath,
  renderProjectRecord,
} from "../src/projects/record.js";

export interface CreateOptions {
  name: string;
  repos: Array<{ path: string; role?: "primary" | "other" }>;
  aliases?: string[];
  parent?: string;
  status?: "active" | "paused";
  description?: string;
  kbReadme?: string;
}

export interface CreateCounts {
  aliases: number;
  repos: number;
  parent: boolean;
  kb_readme: boolean;
  description: boolean;
}

export type CreateResult =
  | { ok: true; rel: string; written: boolean; counts: CreateCounts; projection?: string }
  | { ok: false; error: string };

/** Pure: the record markdown for the flags. Throws when it would not parse. */
export function buildRecordFromFlags(
  slug: string,
  opts: CreateOptions,
): { markdown: string; counts: CreateCounts } {
  const hasPrimary = opts.repos.some((r) => r.role === "primary");
  const repos = opts.repos.map((r, i) => ({
    path: r.path,
    role: r.role ?? (i === 0 && !hasPrimary ? "primary" : "other"),
  }));
  const json: Record<string, unknown> = { slug, name: opts.name, status: opts.status ?? "active" };
  if (opts.aliases && opts.aliases.length > 0) json.aliases = opts.aliases;
  if (opts.parent !== undefined) json.parent = opts.parent;
  if (opts.kbReadme !== undefined) json.kb_readme = opts.kbReadme;
  if (repos.length > 0) json.repos = repos;
  const description = foldDescription(opts.description ?? "");
  return {
    markdown: renderProjectRecord(normaliseRecordJson(json), description),
    counts: {
      aliases: opts.aliases?.length ?? 0,
      repos: repos.length,
      parent: opts.parent !== undefined,
      kb_readme: opts.kbReadme !== undefined,
      description: description.length > 0,
    },
  };
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The project (another row) an alias collides with, by slug only: its slug,
 * name or slug-with-spaces (any status), an alias or a single hyphen-word of
 * the slug of an active/paused row (audit R1 W2 / R2 W1).
 */
function aliasOwner(alias: string): string | null {
  const a = alias.trim().toLowerCase();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT p.slug FROM projects p
        WHERE lower(p.slug) = ? OR lower(trim(p.name)) = ? OR replace(lower(p.slug), '-', ' ') = ?
       UNION
       SELECT p.slug FROM projects p, json_each(p.config, '$.aliases') j
        WHERE json_valid(p.config) AND json_type(p.config, '$.aliases') = 'array'
          AND p.status IN ('active', 'paused') AND lower(trim(j.value)) = ?
       LIMIT 1`,
    )
    .get(a, a, a, a) as { slug: string } | undefined;
  if (row) return row.slug;
  const live = db
    .prepare("SELECT slug FROM projects WHERE status IN ('active', 'paused') ORDER BY slug")
    .all() as Array<{ slug: string }>;
  return live.find((r) => r.slug.toLowerCase().split("-").includes(a))?.slug ?? null;
}

/** Refusals first, then build, then write through the registry path. */
export function createProjectRecord(
  slug: string,
  opts: CreateOptions & { dryRun?: boolean },
): CreateResult {
  if (!PROJECT_SLUG_RE.test(slug)) return { ok: false, error: `invalid slug "${slug}"` };
  const rel = projectRecordRelPath(slug);
  if (getFile(rel)) return { ok: false, error: `${rel} already exists` };
  if (existsSync(join(getJarvisKbRoot(), rel))) {
    return { ok: false, error: `${rel} exists on disk but not in the registry — run the reindex first` };
  }
  if (getProject(slug)?.slug === slug) {
    return { ok: false, error: `a projects row for "${slug}" already exists — use project-record-export.ts` };
  }
  if (opts.parent !== undefined && !PROJECT_SLUG_RE.test(opts.parent)) {
    return { ok: false, error: "--parent must be a project slug" };
  }
  if (opts.parent !== undefined) {
    const why = parentChainError(slug, opts.parent);
    if (why) return { ok: false, error: `--parent refused: ${why}` };
  }
  // Repos: trailing `/` stripped; no `..` segment; an existing directory
  // (dry run included). Errors name the rule, never the path (audit R1 W1).
  const repos = opts.repos.map((r) => ({ ...r, path: r.path.replace(/\/+$/, "") }));
  for (const r of repos) {
    if (!r.path.startsWith("/")) return { ok: false, error: "--repo must be an absolute path" };
    if (r.path.split("/").includes("..")) return { ok: false, error: "--repo must not contain a .. segment" };
    if (!isDir(r.path)) return { ok: false, error: "--repo must be an existing directory" };
  }
  // Aliases are routing cues: distinctive, plain, not a credential, and not
  // another project's name or alias (audit R1 W2).
  for (const a of opts.aliases ?? []) {
    const t = a.trim();
    if (t.length < MIN_ALIAS_LEN) return { ok: false, error: `--alias must be at least ${MIN_ALIAS_LEN} characters` };
    if (!/^[a-z0-9][a-z0-9 -]*$/.test(t.toLowerCase())) {
      return { ok: false, error: "--alias may hold only letters, digits, spaces and -" };
    }
    if (isProjectProseSecret("name", t)) return { ok: false, error: "--alias holds a credential-style value" };
    const owner = aliasOwner(t);
    if (owner) return { ok: false, error: `--alias "${t}" collides with project ${owner}` };
  }
  if (opts.kbReadme !== undefined && !KB_README_RE.test(opts.kbReadme)) {
    return { ok: false, error: "--kb-readme must be projects/<folder>/<file>.md" };
  }
  for (const field of ["name", "description"] as const) {
    const v = opts[field];
    if (v && isProjectProseSecret(field, v)) {
      return { ok: false, error: `--${field} holds a credential-style value` };
    }
  }
  let built: ReturnType<typeof buildRecordFromFlags>;
  try {
    built = buildRecordFromFlags(slug, { ...opts, repos });
  } catch (err) {
    // ProjectRecordError messages name schema paths only, never values.
    return { ok: false, error: `the record would not parse (${(err as Error).message})` };
  }
  if (opts.dryRun) return { ok: true, rel, written: false, counts: built.counts };
  const projected = upsertFromDiskWrite(rel, built.markdown);
  if (projected?.action !== "created") {
    // Audit R1 W5: the record is written; a re-run would only say "already exists".
    return {
      ok: false,
      error: `${rel} was written but the row was not created (projection: ${projected?.error ? `error ${projected.error.reason}` : projected?.action ?? "none"}). The record exists in the KB: fix it there; the boot pass (projectAllRecords) re-projects it, or project-record-export.ts ${slug} --force once a row exists. Do not re-run project-create.`,
    };
  }
  return {
    ok: true,
    rel,
    written: true,
    counts: built.counts,
    projection: projected.action,
  };
}

export function parseArgs(
  argv: string[],
): ({ slug: string; dryRun: boolean } & CreateOptions) | { error: string } {
  const out: { slug: string; dryRun: boolean } & CreateOptions = { slug: "", name: "", repos: [], aliases: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (!a.startsWith("--")) {
      if (out.slug) return { error: `unexpected argument ${a}` };
      out.slug = a;
      continue;
    }
    if (!["--name", "--repo", "--alias", "--parent", "--status", "--description", "--kb-readme"].includes(a)) {
      return { error: `unknown flag ${a}` };
    }
    const v = argv[++i];
    if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
    if (a === "--name") out.name = v;
    else if (a === "--alias") out.aliases!.push(v);
    else if (a === "--parent") out.parent = v;
    else if (a === "--description") out.description = v;
    else if (a === "--kb-readme") out.kbReadme = v;
    else if (a === "--status") {
      if (v !== "active" && v !== "paused") return { error: "--status must be active|paused" };
      out.status = v;
    } else {
      const m = /^(.*):(primary|other)$/.exec(v);
      const path = m ? m[1]! : v;
      if (!path.startsWith("/")) return { error: "--repo must be an absolute path" };
      out.repos.push(m ? { path, role: m[2] as "primary" | "other" } : { path });
    }
  }
  if (!out.slug || !out.name || out.repos.length === 0) {
    return {
      error:
        "usage: project-record-create.ts <slug> --name <text> --repo <abs-path>[:primary|other] [--repo …]… [--alias <a>]… [--parent <slug>] [--status active|paused] [--description <text>] [--kb-readme <kb-rel-path>] [--dry-run]",
    };
  }
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
    const r = createProjectRecord(args.slug, args);
    if (!r.ok) {
      console.error(`[project-record-create] ${r.error}`);
      return 1;
    }
    const c = r.counts;
    console.log(`[project-record-create] ${r.rel} ${r.written ? "written" : "(dry run — nothing written)"}`);
    console.log(
      `  contract: aliases=${c.aliases} repos=${c.repos} parent=${c.parent ? "yes" : "no"} kb_readme=${c.kb_readme ? "yes" : "no"} description=${c.description ? "yes" : "no"}`,
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
  requireOperatorTerminal("project-record-create");
  main().then((code) => process.exit(code));
}
