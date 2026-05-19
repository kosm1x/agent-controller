/**
 * v7.7 Spine 3 — S5 substrate Phase 1.
 *
 * Boot-time loader: walks `jarvis_files` for `skills/<name>/SKILL.md`
 * paths, parses each via parseSkillFile(), registers a row in
 * `skill_versions`, and upserts the parent `skills` row's metadata.
 *
 * Anti-mission: REGISTERS what the operator wrote, does NOT author skills.
 * If the namespace is empty (current state at Phase 1 ship), the loader
 * is a no-op and returns `loaded: 0`.
 *
 * Idempotency: skill_versions is keyed UNIQUE(skill_id, version). Running
 * the loader twice on unchanged content is a no-op. When a SKILL.md is
 * edited without bumping `version`, the loader detects body_sha256 drift
 * against the existing skill_versions row, logs a warning, and leaves the
 * row untouched. The operator must bump version to register the new body.
 */

import { createHash, randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import { getFile, listFiles } from "../db/jarvis-fs.js";
import {
  FrontmatterError,
  ParsedSkill,
  parseSkillFile,
} from "./frontmatter.js";

export interface LoaderError {
  path: string;
  kind: "parse" | "drift" | "db";
  message: string;
}

export interface LoaderResult {
  loaded: number;
  skipped: number;
  drift: number;
  errors: LoaderError[];
}

const SKILL_PATH_RE = /^skills\/([a-z0-9][a-z0-9-]{0,62}[a-z0-9])\/SKILL\.md$/;

/**
 * Compute body_sha256 the same way the schema column stores it: SHA-256
 * over the raw body bytes (no normalization, no trimming). Authoring
 * tools downstream must match this when re-emitting.
 */
function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Find or create a `skills` row for the given frontmatter name. Returns
 * the skill_id (existing or freshly minted). Idempotent: re-running with
 * the same name returns the existing row's skill_id, no mutation.
 *
 * SELECT-then-INSERT race: single-process boot is the invariant. If two
 * processes ever start simultaneously, the second writer hits the UNIQUE
 * constraint on `skills.name`, throws, and the loader surfaces a
 * `db`-kind LoaderError. The same race applies to `recordVersion`'s
 * `(skill_id, version)` UNIQUE.
 */
function ensureSkillRow(fm: ParsedSkill, bodyPath: string): string {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT skill_id FROM skills WHERE name = ?")
    .get(fm.name) as { skill_id: string } | undefined;

  if (existing) return existing.skill_id;

  // Phase 1: insert a registration-only row. `steps`/`tools` JSON arrays
  // stay empty — Phase 2's critic will produce step bodies from the
  // markdown body when needed. `trigger_text` mirrors the first trigger
  // example so the legacy keyword path still works during the transition.
  const skillId = randomUUID();
  const firstTrigger = fm.trigger_examples[0] ?? "";
  db.prepare(
    `INSERT INTO skills (
       skill_id, name, description, trigger_text, steps, tools, source,
       version, inputs_json, output_type, trigger_examples_json,
       tests_json, body_path
     ) VALUES (?, ?, ?, ?, '[]', '[]', 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(
    skillId,
    fm.name,
    fm.description,
    firstTrigger,
    fm.version,
    fm.inputs_json,
    fm.output_type,
    JSON.stringify(fm.trigger_examples),
    fm.tests_json,
    bodyPath,
  );
  return skillId;
}

/**
 * Insert a row into skill_versions for this content. Returns:
 *   - { kind: 'inserted', versionId } on a new (skill_id, version) pair
 *   - { kind: 'unchanged' }            when an existing row matches sha256
 *   - { kind: 'drift', existingSha }   when (skill_id, version) exists with
 *                                       different body_sha256 → loader
 *                                       reports this as a hygiene warning
 *                                       and does NOT overwrite.
 */
function recordVersion(
  skillId: string,
  fm: ParsedSkill,
  body: string,
):
  | { kind: "inserted"; versionId: number }
  | { kind: "unchanged" }
  | { kind: "drift"; existingSha: string } {
  const db = getDatabase();
  const bodySha = sha256(body);

  const existing = db
    .prepare(
      "SELECT id, body_sha256 FROM skill_versions WHERE skill_id = ? AND version = ?",
    )
    .get(skillId, fm.version) as
    | { id: number; body_sha256: string }
    | undefined;

  if (existing) {
    if (existing.body_sha256 === bodySha) return { kind: "unchanged" };
    return { kind: "drift", existingSha: existing.body_sha256 };
  }

  const result = db
    .prepare(
      `INSERT INTO skill_versions (
         skill_id, version, body, body_sha256, inputs_json, tests_json,
         tools_used_json, created_by, critic_verdict
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'boot-scan', 'skipped')`,
    )
    .run(
      skillId,
      fm.version,
      body,
      bodySha,
      fm.inputs_json,
      fm.tests_json,
      JSON.stringify(fm.tools_used),
    );
  return { kind: "inserted", versionId: Number(result.lastInsertRowid) };
}

/**
 * Update the parent `skills` row to point at the new version_id and
 * refresh the metadata fields the loader sources from frontmatter.
 * Only called when recordVersion() returns 'inserted'.
 */
function pointSkillAtVersion(
  skillId: string,
  fm: ParsedSkill,
  versionId: number,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skills SET
       description = ?,
       version = ?,
       inputs_json = ?,
       output_type = ?,
       trigger_examples_json = ?,
       tests_json = ?,
       current_version_id = ?,
       updated_at = datetime('now')
     WHERE skill_id = ?`,
  ).run(
    fm.description,
    fm.version,
    fm.inputs_json,
    fm.output_type,
    JSON.stringify(fm.trigger_examples),
    fm.tests_json,
    versionId,
    skillId,
  );
}

export interface LoaderLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Walk `jarvis_files` for skills/<name>/SKILL.md paths and register
 * each. Safe to call on every boot. Pass a structured logger to capture
 * per-file outcomes.
 */
export function loadSkillsFromJarvisFiles(log: LoaderLog): LoaderResult {
  const result: LoaderResult = { loaded: 0, skipped: 0, drift: 0, errors: [] };

  const candidates = listFiles({ prefix: "skills/" });
  for (const entry of candidates) {
    if (!SKILL_PATH_RE.test(entry.path)) continue; // ignore REFERENCE.md, scripts/, etc.

    const file = getFile(entry.path);
    if (!file) {
      // Race or stale list; skip rather than fail boot.
      log.warn("[skills:loader] file disappeared", { path: entry.path });
      continue;
    }

    let parsed;
    try {
      parsed = parseSkillFile(file.content);
    } catch (err) {
      if (err instanceof FrontmatterError) {
        const issue: LoaderError = {
          path: entry.path,
          kind: "parse",
          message: `${err.kind}: ${err.message}`,
        };
        result.errors.push(issue);
        log.warn("[skills:loader] parse failed", { ...issue });
        continue;
      }
      throw err;
    }

    try {
      const skillId = ensureSkillRow(parsed.frontmatter, entry.path);
      const outcome = recordVersion(skillId, parsed.frontmatter, parsed.body);
      if (outcome.kind === "inserted") {
        pointSkillAtVersion(skillId, parsed.frontmatter, outcome.versionId);
        result.loaded++;
        log.info("[skills:loader] registered", {
          name: parsed.frontmatter.name,
          version: parsed.frontmatter.version,
          version_id: outcome.versionId,
        });
      } else if (outcome.kind === "unchanged") {
        result.skipped++;
      } else {
        // drift: existing version pinned to a different body. Operator
        // must bump frontmatter `version` to register the new content.
        result.drift++;
        const issue: LoaderError = {
          path: entry.path,
          kind: "drift",
          message: `body_sha256 drift on version ${parsed.frontmatter.version} (existing ${outcome.existingSha.slice(0, 8)}…); bump version to register new body`,
        };
        result.errors.push(issue);
        log.warn("[skills:loader] body drift on pinned version", {
          path: entry.path,
          name: parsed.frontmatter.name,
          version: parsed.frontmatter.version,
          existing_sha_prefix: outcome.existingSha.slice(0, 8),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const issue: LoaderError = {
        path: entry.path,
        kind: "db",
        message,
      };
      result.errors.push(issue);
      log.error("[skills:loader] db write failed", { ...issue });
    }
  }

  log.info("[skills:loader] complete", {
    loaded: result.loaded,
    skipped: result.skipped,
    drift: result.drift,
    errors: result.errors.length,
  });
  return result;
}
