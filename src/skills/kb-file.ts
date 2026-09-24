/**
 * Model-facing KB write path for versioned skills (`skills/<name>/SKILL.md`).
 *
 * The boot loader registers every SKILL.md row it finds with the critic
 * SKIPPED, and only at restart. A model write to that path therefore has to
 * go through `skillSave` (critic gate → skill_versions row → pointer) BEFORE
 * the file lands — that makes the skill usable at once and keeps the next
 * boot scan a no-op (`unchanged`). `jarvis_file_write` calls
 * `registerSkillFile`; every other jarvis_file_* writer refuses the path via
 * `skillFileGuard`, so no draft can be appended, moved or batch-written into
 * place around the critic.
 */

import { getDatabase } from "../db/index.js";
import { canonicalKbPath } from "../tools/builtin/immutable-core.js";
import { FrontmatterError, parseSkillFile } from "./frontmatter.js";
import { skillSave } from "./lifecycle.js";
import { SKILL_PATH_RE } from "./loader.js";
import { sha256 } from "./storage.js";

export const SKILL_FILE_FORMAT = `---
name: <verb-led-kebab-name, identical to the folder name, e.g. generar-slogan>
description: When the user asks to <X>, <what it does and returns> (max 1024 chars)
version: 1.0.0
output_type: text
trigger_examples:
  - "<user request 1>"
  - "<user request 2>"
  - "<user request 3>"
tools_used:
  - <tool_name>
inputs_json: '[{"name":"brief","type":"string","required":true,"description":"..."}]'
tests_json: '[{"name":"happy_path","input":{"brief":"..."},"expect":{"output_type":"text"}},{"name":"empty_brief","input":{"brief":""},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"brief"}}]'
---

# <Title>

## Steps
1. ...`;

/** Accurate guidance for a skill that has steps but no registered version. */
export function unversionedSkillNote(name: string): string {
  return (
    `"${name}" was saved with skill_save and has no versioned SKILL.md, so skill_run cannot ` +
    "execute it; skill_load returns its saved steps to follow directly. To make it a versioned skill, " +
    "write skills/<verb-led-kebab-name>/SKILL.md (lowercase and hyphens, no underscores) with jarvis_file_write " +
    "(frontmatter: verb-led name, description, version, output_type, trigger_examples ≥3, " +
    "tools_used, inputs_json, tests_json with ≥2 tests; then the steps as the body)."
  );
}

/** True when `p` names a skill definition file, in any spelling. */
export function isSkillFilePath(p: string, kbRoot: string): boolean {
  return /^skills\/[^/]+\/skill\.md$/.test(canonicalKbPath(p, kbRoot));
}

export interface SkillFileRefusal {
  error: "SKILL_FILE_PROTECTED";
  message: string;
  paths: string[];
}

/** Refusal for the jarvis_file_* writers that must not touch SKILL.md. */
export function skillFileGuard(
  paths: ReadonlyArray<unknown>,
  kbRoot: string,
): SkillFileRefusal | null {
  const hits = paths.filter(
    (p): p is string => typeof p === "string" && isSkillFilePath(p, kbRoot),
  );
  if (hits.length === 0) return null;
  return {
    error: "SKILL_FILE_PROTECTED",
    message:
      "skills/<name>/SKILL.md is a registered skill definition. Create or change it ONLY " +
      "with jarvis_file_write (the whole file: frontmatter + body) — that runs the skill " +
      "critic and registers the version so skill_load/skill_run can use it. To change a " +
      "skill, write the full file with a higher `version`. Deleting or moving the file " +
      "does not unregister the skill.",
    paths: hits,
  };
}

export interface SkillFileRegistrationInfo {
  name: string;
  version: string;
  status: "registered" | "unchanged";
  certified: boolean;
  next: string;
}

export type SkillFileRegistration =
  | { ok: true; skill: SkillFileRegistrationInfo }
  | { ok: false; error: Record<string, unknown> };

/**
 * Parse + critic-gate + register a SKILL.md before it is written to the KB.
 * `priorContent` is the file currently at `path` (null when absent). Returns
 * `ok:false` with a model-facing error whenever the file must NOT be written.
 */
export async function registerSkillFile(
  path: string,
  content: string,
  priorContent: string | null,
): Promise<SkillFileRegistration> {
  const fail = (error: Record<string, unknown>): SkillFileRegistration => ({
    ok: false,
    error: { ...error, saved: false },
  });

  const match = SKILL_PATH_RE.exec(path);
  if (!match) {
    return fail({
      error: "SKILL_PATH_INVALID",
      message: `Skill files live at exactly skills/<kebab-name>/SKILL.md (folder: lowercase letters, digits, hyphens; file name SKILL.md). Got "${path}".`,
    });
  }

  let parsed;
  try {
    parsed = parseSkillFile(content);
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    return fail({
      error: "SKILL_FRONTMATTER_INVALID",
      message: err.message,
      format: SKILL_FILE_FORMAT,
    });
  }

  const { name, version } = parsed.frontmatter;
  if (name !== match[1]) {
    return fail({
      error: "SKILL_NAME_MISMATCH",
      message: `frontmatter name "${name}" must equal the folder name "${match[1]}".`,
    });
  }

  const ok = (status: "registered" | "unchanged"): SkillFileRegistration => {
    // Retrieval (automatic suggestion) serves certified skills only, and the
    // test sweep re-tests only certified ones — certification is operator-run.
    const certified =
      (
        getDatabase()
          .prepare("SELECT is_certified FROM skills WHERE name = ?")
          .get(name) as { is_certified: number } | undefined
      )?.is_certified === 1;
    return {
      ok: true,
      skill: {
        name,
        version,
        status,
        certified,
        next:
          `Usable now by name: skill_load("${name}") to read it, skill_run("${name}", {...inputs}) to execute it.` +
          (certified
            ? ""
            : ` Not certified yet, so it is not suggested automatically; the operator certifies it with: mc-ctl skills certify ${name}`),
      },
    };
  };

  // The body of this version is already registered. Writing different
  // frontmatter under the same version would leave the file and the
  // registered row disagreeing, so only an identical (or missing) file is
  // accepted.
  const unchanged = (): SkillFileRegistration =>
    priorContent === null || priorContent === content
      ? ok("unchanged")
      : fail({
          error: "SKILL_VERSION_EXISTS",
          message: `version ${version} of "${name}" is already registered with this body. Raise \`version\` to change the skill.`,
        });

  // Settle an already-registered version BEFORE the critic: an identical
  // rewrite or a same-version change must not cost (or be failed by) an LLM
  // call. recordVersion keys on (skill, version) and hashes the body only.
  const registered = getDatabase()
    .prepare(
      `SELECT v.id, v.body_sha256, s.current_version_id FROM skill_versions v
       JOIN skills s ON s.skill_id = v.skill_id
       WHERE s.name = ? AND v.version = ?`,
    )
    .get(name, version) as
    | { id: number; body_sha256: string; current_version_id: number | null }
    | undefined;
  if (registered) {
    if (registered.current_version_id !== registered.id) {
      return fail({
        error: "SKILL_VERSION_EXISTS",
        message: `version ${version} of "${name}" is registered but is not the current version. Write the skill with a version higher than the current one.`,
      });
    }
    if (registered.body_sha256 !== sha256(parsed.body)) {
      return fail({
        error: "SKILL_VERSION_EXISTS",
        message: `version ${version} of "${name}" is already registered with a different body. Raise \`version\` to change the skill.`,
      });
    }
    return unchanged();
  }

  const result = await skillSave(parsed, { createdBy: "refiner", bodyPath: path });
  if (result.ok) {
    // A new body has passed no test yet: a certified skill loses its
    // certification (retrieval serves certified skills only) until the
    // operator re-certifies it.
    getDatabase()
      .prepare("UPDATE skills SET is_certified = 0 WHERE skill_id = ?")
      .run(result.skillId);
    return ok("registered");
  }

  switch (result.kind) {
    case "unchanged": // a concurrent writer registered it first
      return unchanged();
    case "drift":
      return fail({ error: "SKILL_VERSION_EXISTS", message: result.critique });
    case "critic_failed":
      return fail({
        error: "SKILL_CRITIC_FAILED",
        critique: result.critique,
        message: "The skill critic rejected this file. Revise it per the critique and write it again.",
      });
    case "critic_error":
      return fail({
        error: "SKILL_CRITIC_UNAVAILABLE",
        message: `The skill critic could not run (${result.critique}). Retry the write later.`,
      });
  }
}
