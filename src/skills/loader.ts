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

import { getFile, listFiles } from "../db/jarvis-fs.js";
import { FrontmatterError, parseSkillFile } from "./frontmatter.js";
import {
  ensureSkillRow,
  pointSkillAtVersion,
  recordVersion,
} from "./storage.js";
import { errMsg } from "../lib/err-msg.js";

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
      const outcome = recordVersion({
        skillId,
        fm: parsed.frontmatter,
        body: parsed.body,
        createdBy: "boot-scan",
        criticVerdict: "skipped",
        criticCritique: null,
      });
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
      const message = errMsg(err);
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
