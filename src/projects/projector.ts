/**
 * S6 WS1 — the projector: a project record (`projects/<slug>/project.md`,
 * authoritative) → its `projects` row (the SQL surface kept for joins).
 * Spec docs/planning/s6-project-contract-spec-2026-10-11.md §2.
 *
 * The projector owns `name`, `description`, `status`, `urls.site` and the
 * `config` keys in PROJECTOR_CONFIG_KEYS. It never writes `id`,
 * `credentials` or `commit_goal_id`, and never touches a `config`/`urls` key
 * it does not own (the row write is a merge through `updateProject`).
 *
 * Runs when a record reaches the registry (`upsertFromDiskWrite`, the hourly
 * walk's import/refresh in `reindexJarvisKb`) and at boot
 * (`projectAllRecords`). It projects the content it is handed — never a
 * second disk read.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";
import { createProject, getProject, updateProject } from "../db/projects.js";
import { errMsg } from "../lib/err-msg.js";
import {
  parseProjectRecord,
  ProjectRecordError,
  isProjectRecordPath,
  recordSlugFromPath,
  type ProjectContract,
  type ProjectRecordErrorReason,
} from "./record.js";

/** The `projects.config` keys the record owns (spec §2 field table). */
export const PROJECTOR_CONFIG_KEYS = [
  "aliases",
  "match_priority",
  "stall_exempt",
  "kb_folder",
  "kb_readme",
  "parent",
  "repos",
  "schedules",
  "success",
  "links",
] as const;

export interface ProjectRowPatch {
  name: string;
  description: string;
  status: string;
  /** Only `site`, from `links.site`; absent when the record has none. */
  urls?: { site: string };
  /** Only PROJECTOR_CONFIG_KEYS present in the contract. */
  config: Record<string, unknown>;
}

/** The row columns a contract decides. Pure. */
export function contractToRowPatch(
  contract: ProjectContract,
  description: string,
): ProjectRowPatch {
  const config: Record<string, unknown> = {};
  for (const k of PROJECTOR_CONFIG_KEYS) {
    if (contract[k] !== undefined) config[k] = contract[k];
  }
  const patch: ProjectRowPatch = {
    name: contract.name,
    description,
    status: contract.status,
    config,
  };
  if (contract.links?.site) patch.urls = { site: contract.links.site };
  return patch;
}

export interface ProjectApplyResult {
  slug: string;
  action: "created" | "updated" | "skipped";
  /** S6 WS2: listed schedule ids whose `scheduled_tasks.project_slug` is this slug after the apply. */
  schedulesClaimed?: number;
  /** Listed schedule ids another record already claims (left with it). */
  schedulesConflict?: number;
  error?: {
    reason: ProjectRecordErrorReason | "not_a_record_path" | "apply_failed";
    message: string;
  };
}

/** JSON with object keys sorted, so equal values compare equal. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

/**
 * S6 WS2: `scheduled_tasks.project_slug` follows the record's `schedules`.
 * A listed id is claimed when unclaimed (never taken from another record);
 * an id this slug holds that the record no longer lists is released. Ids
 * with no `scheduled_tasks` row are ignored. Pure DB, one transaction.
 */
function syncScheduleClaims(
  slug: string,
  ids: readonly string[],
): { schedulesClaimed: number; schedulesConflict: number } {
  const db = getDatabase();
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'",
    )
    .get();
  // Created lazily by the dynamic scheduler; nothing to claim before it exists.
  if (!table) return { schedulesClaimed: 0, schedulesConflict: 0 };
  const listed = [...new Set(ids)];
  const marks = listed.map(() => "?").join(", ");
  return db.transaction(() => {
    db.prepare(
      listed.length === 0
        ? "UPDATE scheduled_tasks SET project_slug = NULL WHERE project_slug = ?"
        : `UPDATE scheduled_tasks SET project_slug = NULL WHERE project_slug = ? AND schedule_id NOT IN (${marks})`,
    ).run(slug, ...listed);
    if (listed.length === 0) return { schedulesClaimed: 0, schedulesConflict: 0 };
    db.prepare(
      `UPDATE scheduled_tasks SET project_slug = ? WHERE schedule_id IN (${marks}) AND project_slug IS NULL`,
    ).run(slug, ...listed);
    const rows = db
      .prepare(
        `SELECT schedule_id, project_slug FROM scheduled_tasks WHERE schedule_id IN (${marks})`,
      )
      .all(...listed) as Array<{ schedule_id: string; project_slug: string | null }>;
    const conflict = rows.filter((r) => r.project_slug !== slug).map((r) => r.schedule_id);
    if (conflict.length > 0) {
      console.warn(
        `[projector] ${slug}: schedule(s) already claimed by another record, left as is: ${conflict.join(", ")}`,
      );
    }
    return {
      schedulesClaimed: rows.length - conflict.length,
      schedulesConflict: conflict.length,
    };
  })();
}

/**
 * Parse a record and create or update its row. A parse or db failure never
 * throws: it is returned and logged once with its reason (never content).
 * An unchanged row is `skipped` (no write, no project_log line).
 */
export function applyProjectRecord(rel: string, content: string): ProjectApplyResult {
  const slug = recordSlugFromPath(rel);
  if (!slug) {
    return {
      slug: "",
      action: "skipped",
      error: { reason: "not_a_record_path", message: "not projects/<slug>/project.md" },
    };
  }
  try {
    const record = parseProjectRecord(content, { folderSlug: slug });
    const patch = contractToRowPatch(record.contract, record.description);
    const found = getProject(slug);
    const existing = found && found.slug === slug ? found : null;
    if (!existing) {
      createProject(slug, patch.name, {
        description: patch.description,
        status: patch.status,
        urls: patch.urls,
        config: patch.config,
      });
      return { slug, action: "created", ...syncScheduleClaims(slug, record.contract.schedules ?? []) };
    }
    // An unchanged row still syncs its claims: a schedule created after the
    // record, or the column's first boot, is claimed on the next apply.
    const claims = syncScheduleClaims(slug, record.contract.schedules ?? []);

    // Owned keys the record no longer has are removed from the row (null
    // deletes in the merge); keys the record does not own are left alone.
    const configPatch: Record<string, unknown> = { ...patch.config };
    let configChanged = false;
    for (const k of PROJECTOR_CONFIG_KEYS) {
      if (k in patch.config) {
        if (stable(existing.config[k]) !== stable(patch.config[k])) configChanged = true;
      } else if (k in existing.config) {
        configPatch[k] = null;
        configChanged = true;
      }
    }
    const site = patch.urls?.site;
    const siteChanged = (existing.urls.site ?? undefined) !== site;
    if (
      existing.name === patch.name &&
      existing.description === patch.description &&
      existing.status === patch.status &&
      !siteChanged &&
      !configChanged
    ) {
      return { slug, action: "skipped", ...claims };
    }
    updateProject(slug, {
      name: patch.name,
      description: patch.description,
      status: patch.status,
      ...(siteChanged
        ? { urls: { site: site ?? null } as unknown as Record<string, string> }
        : {}),
      ...(configChanged ? { config: configPatch } : {}),
    });
    return { slug, action: "updated", ...claims };
  } catch (err) {
    const error =
      err instanceof ProjectRecordError
        ? { reason: err.reason, message: err.message }
        : { reason: "apply_failed" as const, message: errMsg(err) };
    console.warn(`[projector] ${rel} not applied (${error.reason}): ${error.message}`);
    return { slug, action: "skipped", error };
  }
}

export interface ProjectAllRecordsResult {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  /** Records on disk with no registry row (the hourly walk imports and projects them). */
  unregistered: number;
}

/**
 * Boot pass: project every record the registry holds (`jarvis_files` is the
 * authority), then count the `projects/*\/project.md` files on disk under
 * `kbRoot` that the registry does not have yet.
 */
export function projectAllRecords(kbRoot: string): ProjectAllRecordsResult {
  const out: ProjectAllRecordsResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    unregistered: 0,
  };
  const rows = getDatabase()
    .prepare(
      "SELECT path, content FROM jarvis_files WHERE path LIKE 'projects/%/project.md'",
    )
    .all() as Array<{ path: string; content: string }>;
  const registered = new Set<string>();
  for (const row of rows) {
    if (!isProjectRecordPath(row.path)) continue;
    registered.add(row.path);
    const r = applyProjectRecord(row.path, String(row.content ?? ""));
    if (r.error) out.errors++;
    else out[r.action]++;
  }
  let folders: string[] = [];
  try {
    folders = readdirSync(join(kbRoot, "projects"));
  } catch {
    return out;
  }
  for (const f of folders) {
    const rel = `projects/${f}/project.md`;
    if (!isProjectRecordPath(rel) || registered.has(rel)) continue;
    try {
      if (statSync(join(kbRoot, rel)).isFile()) out.unregistered++;
    } catch {
      // no record in this folder
    }
  }
  return out;
}
